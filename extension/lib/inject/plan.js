// ============================================================
//  Внедрение: план записи и его выполнение.
//
//  Внедрение сначала собирает план — какие файлы записать/удалить, — а потом выполняет его.
//  Так план можно выполнить и напрямую, и (если VS Code стоит в Program Files и прав нет)
//  одним запросом прав администратора, не пересобирая его заново (elevated.js).
//
//  Выполнение — «всё или ничего»: перед каждой записью запоминается прежнее содержимое файла,
//  и если посреди плана запись упала (файл занят, кончилось место), уже записанное
//  откатывается. Иначе оболочка могла бы остаться со ссылками на файлы модулей, которых нет.
// ============================================================
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const W = require("../wb-patch");
const { log } = require("../log");
const { writeAtomic } = require("../fsx");
const SH = require("./shell");
const DPL = require("./deep-plan");
const LK = require("./lock");
const UF = require("./ui-file");
const { storageDir } = require("../storage");

/** Текст файла или null (нет файла). */
function readOr(file) { try { return fs.readFileSync(file, "utf8"); } catch (e) { return null; } }

/** Файл блокировки записи оболочки (в общем для всех окон globalStorage). null — без блокировки. */
function lockFileOf(context) { return context ? LK.lockPath(storageDir(context)) : null; }

/** План внедрения: { ok, ops: [{file, data?|remove?, atomic?}], files, reason?, error? }. */
function planInject(context) {
    const files = SH.workbenchFiles();
    if (!files.length) return { ok: false, reason: "no-workbench" };
    let rt, ui = null;
    try { rt = UF.runtimeFor(context); } catch (e) { return { ok: false, reason: "no-runtime", error: e.message }; }
    if (rt.ui) {
        // Файл интерфейса — в globalStorage (прав администратора не нужно). Не записался —
        // встроить интерфейс целиком, чтобы конструктор работал.
        try { ui = UF.ensureUiFile(context); }
        catch (e) { log("файл интерфейса окна не записан — встраиваю целиком", e); rt = UF.runtimeFor(context, { inline: true }); }
    }
    const runtime = rt.code;
    const mods = SH.moduleSet(context);
    const ttNames = SH.moduleTrustedTypeNames(mods);
    const boot = SH.bootData(context, mods, ui);
    const conf = SH.conf();
    const external = conf.get("moduleFiles", true);
    const fixSum = SH.fixChecksumOn();
    // Проверка целостности файлов модулей (integrity). Если эта сборка VS Code её не
    // поддерживает для vscode-file, рантайм сообщит, и она выключится для этой версии.
    const sri = external && conf.get("moduleIntegrity", true) && context.globalState.get(SH.SRI_OFF_KEY) !== vscode.version;
    const ops = [], products = {};
    for (const f of files) {
        const html = fs.readFileSync(f, "utf8");
        const dir = path.dirname(f);
        const old = W.blockInfo(html);
        const nonce = W.makeNonce();
        // Политики Trusted Types модулей, которых нет в чистой оболочке: без них модуль не создаст
        // свою политику в VS Code с CSP (окно документации C++ не появлялось).
        const tt = W.moduleTrustedTypes(html, ttNames);
        // Модули — отдельными файлами рядом с оболочкой (или инлайном, если так настроено).
        const list = mods.scripts.map((m) => external
            ? { id: m.id, code: m.code, lazy: !!m.lazy, file: W.moduleFileName(m.id), integrity: sri ? W.sriHash(W.moduleFileContent(m.id, m.code)) : "" }
            : Object.assign({}, m, { lazy: false }));
        // Файл и integrity каждого модуля — в boot: по ним рантайм грузит ленивый модуль и снова
        // включает выключенный без перезагрузки окна. Встроенным инлайном модулям файла нет.
        boot.modules.forEach((b) => {
            const m = list.find((x) => x.id === b.id);
            b.file = m && m.file ? { src: m.file, integrity: m.integrity || "" } : null;
            if (!(m && m.file)) b.lazy = null;
        });
        if (external) list.forEach((m) => ops.push({ file: path.join(dir, m.file), data: W.moduleFileContent(m.id, m.code) }));
        W.moduleFilesIn(dir, external ? list.map((m) => m.file) : []).forEach((x) => ops.push({ file: x, remove: true }));
        const block = W.buildBlock(boot, runtime, { nonce: nonce, version: boot.version, modules: list, trustedTypes: tt });
        let next = W.applyBlock(html, block);
        if (next == null) return { ok: false, reason: "error", error: "в оболочке нет </head>: " + f };
        next = W.armCsp(next, nonce, old && old.nonce, tt, old && old.tt);
        const bad = W.shellProblem(html, next);
        if (bad) return { ok: false, reason: "error", error: "оболочка не записана — проверка перед записью: " + bad + " (" + path.basename(f) + ")" };
        // Бэкап — только чистого (без нашего блока) файла. После обновления VS Code в старом
        // бэкапе лежит оболочка прошлой сборки — заменяем её нынешней.
        if (!old && readOr(f + W.BAK_EXT) !== html) ops.push({ file: f + W.BAK_EXT, data: html });
        // Первый бэкап мог быть снят с уже изменённого файла (в оболочке были чужие правки). Как только
        // оболочка без нашего блока снова равна заводской (по исходному хэшу) — бэкап заменяется ею.
        if (old) {
            const bare = W.stripBlock(html), orig = SH.originalChecksum(f);
            if (orig != null && W.productChecksum(Buffer.from(bare, "utf8")) === orig && readOr(f + W.BAK_EXT) !== bare) ops.push({ file: f + W.BAK_EXT, data: bare });
        }
        if (next !== html) ops.push({ file: f, data: next, atomic: true });
        if (fixSum) {
            if (SH.shellTrust(context, f, next).trusted) SH.planChecksum(products, f, next);
            else log("хэш оболочки не трогаю: в ней чужие вставки без одобрения (" + (W.foreignBlocks(W.stripBlock(next)).join(", ") || "?") + ")");
        }
    }
    DPL.planDeep(context, ops, products, { planChecksum: SH.planChecksum, originalChecksum: SH.originalChecksum, fixChecksum: fixSum });
    ops.push(...SH.productOps(products, true));
    // Окно сессий выключили в настройках — снять блок, если он там остался.
    SH.allShellFiles().filter((f) => files.indexOf(f) === -1).forEach((f) => {
        try {
            const h = fs.readFileSync(f, "utf8");
            if (W.isInjected(h)) ops.push({ file: f, data: W.stripBlock(h), atomic: true });
            W.moduleFilesIn(path.dirname(f), []).forEach((x) => ops.push({ file: x, remove: true }));
        } catch (e) {}
    });
    return { ok: true, ops: ops, files: files };
}

/** План снятия: убрать блок, файлы модулей, глубокие патчи и вернуть исходные хэши. */
function planRemove() {
    const ops = [], products = {};
    for (const f of SH.allShellFiles()) {                 // и окно сессий, даже если настройку выключили
        const html = fs.readFileSync(f, "utf8");
        W.moduleFilesIn(path.dirname(f), []).forEach((x) => ops.push({ file: x, remove: true }));
        if (!W.isInjected(html)) continue;
        ops.push({ file: f, data: W.stripBlock(html), atomic: true });
        SH.planChecksumRestore(products, f);              // исходный хэш из бэкапа product.json
    }
    DPL.planRemoveDeep(ops, products, SH.planChecksumRestore);
    ops.push(...SH.productOps(products, false));
    return ops;
}

/**
 * Выполнить план напрямую, всё или ничего. Бросает ошибку записи (EACCES/EPERM — нет прав),
 * успев откатить уже записанное.
 */
function execPlan(ops) {
    const done = [];   // { file, prev: Buffer | null } — прежнее содержимое для отката
    try {
        for (const op of ops) {
            let prev = null;
            try { prev = fs.readFileSync(op.file); } catch (e) { prev = null; }
            if (op.remove) {
                try { fs.unlinkSync(op.file); } catch (e) { if (e.code !== "ENOENT") throw e; }
            } else if (op.atomic) W.writeWorkbenchAtomic(op.file, op.data);
            else fs.writeFileSync(op.file, op.data, "utf8");
            done.push({ file: op.file, prev: prev });
        }
        // Сверка после записи (как после записи с правами администратора): антивирус или другой
        // загрузчик мог подменить файл между rename и чтением окном. Не совпало — откат целиком.
        const bad = ops.filter((op) => {
            try { return op.remove ? fs.existsSync(op.file) : fs.readFileSync(op.file, "utf8") !== op.data; }
            catch (e) { return !op.remove; }
        });
        if (bad.length) {
            const err = new Error("после записи не совпали файлы: " + bad.map((o) => path.basename(o.file)).join(", "));
            err.code = "EVERIFY";
            throw err;
        }
    } catch (e) {
        rollback(done);
        throw e;
    } finally {
        SH.resetStatusCache();
    }
}

function rollback(done) {
    for (let i = done.length - 1; i >= 0; i--) {
        const d = done[i];
        try {
            if (d.prev == null) fs.unlinkSync(d.file);
            else writeAtomic(d.file, d.prev, W.TMP_EXT);
        } catch (e) { log("откат записи: " + d.file, e); }
    }
    if (done.length) log("запись оболочки не удалась — откатено файлов: " + done.length);
}

const deniedErr = (e) => !!(e && (e.code === "EACCES" || e.code === "EPERM"));

/**
 * Впечатать блок во все найденные оболочки. {ok, done, reason, error, plan?}
 * План собирается и выполняется под блокировкой: другое окно в это время не пишет оболочку.
 * reason "busy" — оболочку прямо сейчас пишет другое окно VS Code.
 */
function inject(context, afterWrite) {
    const r = LK.withLock(lockFileOf(context), () => {
        let plan;
        try { plan = planInject(context); } catch (e) { log("внедрение: план", e); return { ok: false, done: 0, reason: "error", error: e.message }; }
        if (!plan.ok) return Object.assign({ done: 0 }, plan);
        try { execPlan(plan.ops); }
        catch (e) {
            log("внедрение", e);
            return { ok: false, done: 0, reason: deniedErr(e) ? "denied" : "error", error: e.message, plan: plan };
        }
        SH.rememberBlocks(context, plan.ops).catch((er) => log("отпечаток блока", er));
        if (afterWrite) { try { afterWrite(); } catch (e) { log("после внедрения", e); } }
        return { ok: true, done: plan.files.length };
    });
    return r.busy ? { ok: false, done: 0, reason: "busy" } : r;
}

/** Снять блок, модули и глубокие патчи. context — для блокировки (без него — без неё, как в хуке удаления). */
function remove(context) {
    const r = LK.withLock(lockFileOf(context), () => {
        let ops;
        try { ops = planRemove(); } catch (e) { return { ok: false, done: 0, error: e.message }; }
        const done = ops.filter((o) => o.atomic && !/product\.json$/i.test(o.file)).length;
        try { execPlan(ops); } catch (e) { log("снятие", e); return { ok: false, done: 0, error: e.message, denied: deniedErr(e), ops: ops }; }
        return { ok: true, done: done };
    });
    return r.busy ? { ok: false, done: 0, busy: true, error: "оболочку сейчас пишет другое окно VS Code" } : r;
}

/** Хэш оболочки разошёлся (её переписал другой загрузчик после нас) — тихо поправить. */
function healChecksum(st, context) {
    if (!SH.fixChecksumOn()) return;
    const r = LK.withLock(lockFileOf(context), () => healChecksumNow(st));
    if (r && r.busy) log("контрольная сумма: оболочку пишет другое окно — поправит оно");
}
function healChecksumNow(st) {
    st.filter((s) => s.injected && s.checksum === false && s.trusted).forEach((s) => {
        try {
            const products = {};
            SH.planChecksum(products, s.file, fs.readFileSync(s.file, "utf8"));
            execPlan(SH.productOps(products, true));
            log("контрольная сумма оболочки обновлена: " + s.file);
        } catch (e) { log("контрольная сумма", e); }
    });
}

/** Убрать пустые следы be5invis custom-css из оболочек st (с пересчётом хэша). */
function cleanLegacy(st, context) {
    const r = LK.withLock(lockFileOf(context), () => { cleanLegacyNow(st); return {}; });
    if (r.busy) throw new Error("оболочку сейчас пишет другое окно VS Code — попробуй ещё раз");
}
function cleanLegacyNow(st) {
    const ops = [], products = {};
    st.filter((s) => s.legacy).forEach((s) => {
        const next = W.stripLegacyLeftovers(fs.readFileSync(s.file, "utf8"));
        ops.push({ file: s.file, data: next, atomic: true });
        if (SH.fixChecksumOn()) SH.planChecksum(products, s.file, next);
    });
    execPlan(ops.concat(SH.productOps(products, false)));
}

module.exports = { planInject, planRemove, execPlan, inject, remove, healChecksum, cleanLegacy, deniedErr, lockFileOf };
