// ============================================================
//  Внедрение: что сейчас в оболочке VS Code — файлы, модули, статус, доверие, контрольные суммы.
//
//  status() зовётся статусбаром каждые 5 с и Доктором: результат по каждой оболочке кэшируется
//  по времени изменения и размеру файлов (оболочка ~200 КБ, product.json, бэкап) — пока ничего
//  не менялось, файлы не перечитываются и хэши не пересчитываются.
// ============================================================
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const W = require("../wb-patch");
const P = require("../protocol");
const M = require("../modules");
const MH = require("../module-host");
const { log } = require("../log");
const { statKey } = require("../fsx");
const { fileUrl, bridgeFile, stateFile, modulesDataDir } = require("../storage");
const { deepState } = require("./deep-plan");
const UF = require("./ui-file");

// globalState: доверие к оболочке и отпечаток своего блока.
// Хэш в product.json — единственный встроенный в VS Code сигнал «файлы редактора изменены».
// Пересчитывать его можно, только если в оболочке нет ничего, кроме Moon Core (без нашего
// блока файл совпадает с исходным хэшем), или если чужие вставки ты сам одобрил (их sha
// запоминается; изменились — спросим снова). Иначе баннер остаётся: он предупреждает.
const SHELL_OK_KEY = "mooncore.shellTrusted";   // файл оболочки -> sha256 оболочки без нашего блока
const SHELL_ASKED_KEY = "mooncore.shellAsked";  // файл -> sha, про который уже спрашивали
const BLOCK_KEY = "mooncore.blockWritten";      // файл -> sha256 блока, который записал Moon Core
const WANT_KEY = "mooncore.wantInjected";       // пользователь хочет, чтобы Moon Core был в оболочке
const SRI_OFF_KEY = "mooncore.sriUnsupportedFor"; // версия VS Code, где integrity для модулей не работает

function readMap(context, key) {
    const v = context.globalState.get(key);
    return v && typeof v === "object" && !Array.isArray(v) ? Object.assign({}, v) : {};
}

function conf() { return vscode.workspace.getConfiguration("moonCore"); }
function fixChecksumOn() { return conf().get("fixChecksum", true); }

function appRoot() { return vscode.env && vscode.env.appRoot; }

/** Оболочки для внедрения. Окно агентских сессий (sessions.html) — только по moonCore.injectSessions. */
function workbenchFiles() {
    const root = appRoot();
    return root ? W.findWorkbenchIn(path.join(root, "out"), 6, conf().get("injectSessions", false)) : [];
}
/** Все оболочки, в том числе окно сессий при выключенной настройке (для снятия). */
function allShellFiles() {
    const root = appRoot();
    return root ? W.findWorkbenchIn(path.join(root, "out"), 6, true) : [];
}

function extVersion(context) {
    try { return String(context.extension.packageJSON.version || "0"); } catch (e) { return "0"; }
}

// ------------------------------------------------------------------ модули
/**
 * Разрешённые модули с прочитанными рантаймами: { list, scripts, pending }.
 * Рантайм модуля бывает под мегабайт, поэтому перечитываем только когда у скриптов
 * поменялись время изменения или размер (или одобренный код).
 */
let modCache = { key: "", value: null };
function moduleSet(context) {
    const list = MH.allowed(context);
    const key = list.map((m) => m.id + "|" + m.script + "|" + statKey([m.script])).join("\n") +
        "|" + JSON.stringify(context.globalState.get("mooncore.modules.approvedCode") || {});
    if (modCache.value && modCache.key === key) return modCache.value;
    const r = M.loadScripts(list);
    r.errors.forEach((e) => log("модули: " + e));
    // Код каждого модуля — только одобренный (изменённый на диске ждёт подтверждения).
    const v = MH.vetScripts(context, list, r.scripts);
    const ok = new Set(v.scripts.map((s) => s.id));
    const value = { list: list.filter((m) => ok.has(m.id)), scripts: v.scripts, pending: v.pending };
    modCache = { key: key, value: value };
    return value;
}
function resetModuleCache() { modCache = { key: "", value: null }; }

/** Данные для окна. ui — { url, sha } файла интерфейса (ленивая загрузка) или null. */
function bootData(context, mods, ui) {
    return {
        ui: ui || null,
        v: P.VERSION,
        version: extVersion(context),
        stateUrl: fileUrl(stateFile(context)),
        bridgeUrl: fileUrl(bridgeFile(context)),
        proto: P.PROTOCOL,
        modules: M.bootInfo(mods ? mods.list : [], fileUrl, modulesDataDir(context)),
    };
}

// ------------------------------------------------------------------ контрольная сумма
/** .../resources/app/out/vs/code/electron-browser/workbench/workbench.html -> { out, app } */
function appRootOf(file) {
    let d = path.dirname(file);
    for (let i = 0; i < 8 && d && path.basename(d) !== "out"; i++) d = path.dirname(d);
    return path.basename(d) === "out" ? { out: d, app: path.dirname(d) } : null;
}
function productOf(file) { const r = appRootOf(file); return r ? path.join(r.app, W.PRODUCT) : null; }

/** Сходится ли хэш оболочки в product.json: true / false / null (сборка его не проверяет). */
function checksumState(file, html) {
    const r = appRootOf(file); if (!r) return null;
    try {
        const text = fs.readFileSync(path.join(r.app, W.PRODUCT), "utf8");
        return W.checksumMatches(text, W.checksumKey(r.out, file), W.productChecksum(Buffer.from(html, "utf8")));
    } catch (e) { return null; }
}

/** Исходный хэш файла из product.json: из бэкапа, если он есть (текущий уже мог быть нашим). */
function originalChecksum(file) {
    const r = appRootOf(file); if (!r) return null;
    const prod = path.join(r.app, W.PRODUCT), key = W.checksumKey(r.out, file);
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(prod, "utf8")); } catch (e) {}
    for (const j of [W.productBackup(prod), cur]) {
        const v = j && j.checksums && j.checksums[key];
        if (typeof v === "string") return v;
    }
    return null;
}

/** Добавить в план новый хэш файла file (по его будущему содержимому data). products: prod -> {orig, text}. */
function planChecksum(products, file, data) {
    const r = appRootOf(file); if (!r) return;
    const prod = path.join(r.app, W.PRODUCT);
    if (!products[prod]) {
        try { const t = fs.readFileSync(prod, "utf8"); products[prod] = { orig: t, text: t }; } catch (e) { return; }
    }
    const next = W.setChecksumText(products[prod].text, W.checksumKey(r.out, file), W.productChecksum(Buffer.from(data, "utf8")));
    if (next != null) products[prod].text = next;
}

/** Вернуть в план исходный хэш файла file (из бэкапа product.json). products: prod -> {orig, text}. */
function planChecksumRestore(products, file) {
    const r = appRootOf(file); if (!r) return;
    const prod = path.join(r.app, W.PRODUCT);
    try {
        const bak = W.productBackup(prod);
        const orig = bak && bak.checksums && bak.checksums[W.checksumKey(r.out, file)];
        if (typeof orig !== "string") return;
        if (!products[prod]) { const t = fs.readFileSync(prod, "utf8"); products[prod] = { orig: t, text: t }; }
        const next = W.setChecksumText(products[prod].text, W.checksumKey(r.out, file), orig);
        if (next != null) products[prod].text = next;
    } catch (e) { /* бэкапа нет — хэш не трогали */ }
}

/** Операции записи product.json из накопленных products (с бэкапом исходного, если его ещё нет). */
function productOps(products, withBackup) {
    const ops = [];
    Object.keys(products).forEach((prod) => {
        const p = products[prod];
        if (p.text === p.orig) return;
        // Бэкапа нет или он от прошлой сборки VS Code — исходным считаем то, что лежит сейчас.
        if (withBackup && !W.productBackup(prod)) ops.push({ file: prod + W.BAK_EXT, data: p.orig });
        ops.push({ file: prod, data: p.text, atomic: true });
    });
    return ops;
}

// ------------------------------------------------------------------ доверие к оболочке
/** {trusted, pristine, blocks, sha} для оболочки file с содержимым html (с нашим блоком или без). */
function shellTrust(context, file, html) {
    const bare = W.stripBlock(html);
    const sha = W.sha256(bare);
    const orig = originalChecksum(file);
    const pristine = orig != null && W.productChecksum(Buffer.from(bare, "utf8")) === orig;
    return { pristine: pristine, trusted: pristine || readMap(context, SHELL_OK_KEY)[file] === sha, blocks: W.foreignBlocks(bare), sha: sha };
}

/** Запомнить отпечаток своего блока в каждой записанной оболочке (так видно правку снаружи). */
async function rememberBlocks(context, ops) {
    const map = readMap(context, BLOCK_KEY);
    ops.filter((o) => o.data != null && (W.isRealWorkbench(o.file) || W.isSessionsShell(o.file)))
        .forEach((o) => { map[o.file] = W.sha256(W.findBlock(o.data)); });
    await context.globalState.update(BLOCK_KEY, map);
}

// ------------------------------------------------------------------ статус
let statusCache = new Map();   // файл -> { key, value }

function shellStatus(context, f, sha) {
    const prod = productOf(f);
    const trustKey = JSON.stringify([readMap(context, SHELL_OK_KEY)[f] || "", readMap(context, BLOCK_KEY)[f] || ""]);
    const key = statKey(prod ? [f, prod, prod + W.BAK_EXT] : [f]) + "|" + sha + "|" + trustKey;
    const hit = statusCache.get(f);
    if (hit && hit.key === key) return Object.assign({}, hit.value);
    let html = "";
    try { html = fs.readFileSync(f, "utf8"); } catch (e) { return { file: f, injected: false, current: false, error: e.code || e.message }; }
    const info = W.blockInfo(html);
    const tr = shellTrust(context, f, html);
    const written = readMap(context, BLOCK_KEY)[f];
    const value = {
        file: f, injected: !!info, current: !!info && info.sha === sha, version: info ? info.version : "",
        modules: info ? info.modules : [], checksum: checksumState(f, html), legacy: W.hasLegacyLeftovers(html),
        trusted: tr.trusted, foreign: tr.blocks, shellSha: tr.sha,
        // Блок в оболочке — ровно тот, что записал Moon Core? false — его правили снаружи.
        blockOk: !info || !written || written === W.sha256(W.findBlock(html)),
    };
    statusCache.set(f, { key: key, value: value });
    return Object.assign({}, value);
}

/** Что сейчас в оболочке: [{file, injected, current, version, checksum, ...}]. current — рантайм совпадает с нашим. */
function status(context) {
    let sha = "";
    try { sha = W.blockSha(UF.runtimeFor(context).code, moduleSet(context).scripts); } catch (e) {}
    // Глубокие патчи (сервисы окна, главный процесс) — часть «актуальности»: включил или
    // выключил их в настройках, или VS Code обновился и стёр их — блок устарел.
    const d = deepState();
    return workbenchFiles().map((f) => {
        const s = shellStatus(context, f, sha);
        if (!d || !W.isRealWorkbench(s.file)) return s;
        s.deep = d;
        if (s.injected && !d.ok) s.current = false;
        return s;
    });
}
function resetStatusCache() { statusCache = new Map(); }

module.exports = {
    SHELL_OK_KEY, SHELL_ASKED_KEY, BLOCK_KEY, WANT_KEY, SRI_OFF_KEY,
    readMap, conf, fixChecksumOn, workbenchFiles, allShellFiles, extVersion,
    moduleSet, resetModuleCache, bootData,
    appRootOf, checksumState, originalChecksum, planChecksum, planChecksumRestore, productOps,
    shellTrust, rememberBlocks, status, resetStatusCache,
};
