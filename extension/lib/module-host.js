// ============================================================
//  Модули Moon Core — часть с vscode: поиск, согласие пользователя, команда «Модули».
//
//  Модуль исполняется в оболочке VS Code с теми же правами, что и сам Moon Core, поэтому
//  ни один модуль не впечатывается молча: при первой встрече спрашиваем. Разрешение
//  привязано к id + источнику (расширение или папка): модуль с тем же id из другого места
//  спросит заново.
// ============================================================
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const M = require("./modules");
const { log } = require("./log");

const ALLOWED_KEY = "mooncore.modules.allowed";   // id -> source
const DENIED_KEY = "mooncore.modules.denied";     // id -> source
// Одобренный КОД модуля. Разрешение модуля (id + источник) не значит «любой код из этой папки
// навсегда»: если скрипт на диске изменился, в оболочку идёт последняя одобренная версия (её
// копия лежит в globalStorage), а новая — только после «Встроить». Для папки, где модуль
// разрабатывают, можно один раз сказать «доверять обновлениям».
const CODE_KEY = "mooncore.modules.approvedCode";  // id -> { sha, source }
const TRUST_KEY = "mooncore.modules.trustUpdates"; // id -> source

/**
 * Все найденные модули: из папок настройки moonCore.modules и из расширений
 * (package.json -> moonCore.modules). Папки идут первыми и при совпадении id побеждают:
 * так при разработке берётся свежая сборка из репозитория, а не копия в установленном расширении.
 */
function discover() {
    const results = [];
    const dirs = vscode.workspace.getConfiguration("moonCore").get("modules", []);
    (Array.isArray(dirs) ? dirs : []).slice(0, M.LIMITS.MAX_MODULES).forEach((d) => {
        if (typeof d === "string" && d.trim()) results.push(M.fromFolder(d.trim()));
    });
    vscode.extensions.all.forEach((ext) => {
        const pkg = ext.packageJSON;
        if (pkg && pkg.moonCore) results.push(...M.fromPackage(pkg, ext.extensionPath, ext.id));
    });
    const r = M.collect(results);
    r.errors.forEach((e) => log("модули: " + e));
    return r.modules;
}

function readMap(context, key) {
    const v = context.globalState.get(key);
    return v && typeof v === "object" && !Array.isArray(v) ? Object.assign({}, v) : {};
}

function isAllowed(context, m) { return readMap(context, ALLOWED_KEY)[m.id] === m.source; }

/** Разрешённые модули (в порядке обнаружения). */
function allowed(context, found) {
    const map = readMap(context, ALLOWED_KEY);
    return (found || discover()).filter((m) => map[m.id] === m.source);
}

async function setAllowed(context, m, on) {
    const a = readMap(context, ALLOWED_KEY), d = readMap(context, DENIED_KEY);
    if (on) { a[m.id] = m.source; delete d[m.id]; }
    else { delete a[m.id]; d[m.id] = m.source; }
    await context.globalState.update(ALLOWED_KEY, a);
    await context.globalState.update(DENIED_KEY, d);
}

function sourceTitle(m) {
    if (m.source.startsWith("ext:")) return "расширение " + m.source.slice(4);
    if (m.source.startsWith("dir:")) return "папка " + m.source.slice(4);
    return m.source;
}

/** Спросить про новые модули (ни разрешённые, ни запрещённые из этого источника). true — если что-то разрешили. */
async function reviewNew(context, found) {
    const denied = readMap(context, DENIED_KEY);
    let changed = false;
    for (const m of found || discover()) {
        if (isAllowed(context, m) || denied[m.id] === m.source) continue;
        const pick = await vscode.window.showInformationMessage(
            "Moon Core: модуль «" + m.name + "» (" + sourceTitle(m) + ") хочет встроиться в оболочку VS Code. " +
            "Он получит такой же доступ к интерфейсу, как сам Moon Core. Разрешить?",
            "Разрешить", "Запретить");
        if (!pick) continue;                       // закрыли уведомление — спросим в следующий раз
        await setAllowed(context, m, pick === "Разрешить");
        log("модуль " + m.id + " (" + m.source + "): " + (pick === "Разрешить" ? "разрешён" : "запрещён"));
        if (pick === "Разрешить") changed = true;
    }
    return changed;
}

/** Команда «Модули»: отметить, какие модули впечатывать. true — если состав поменялся. */
async function pickCommand(context) {
    const found = discover();
    if (!found.length) {
        vscode.window.showInformationMessage("Moon Core: модулей не найдено. Модуль объявляется в package.json расширения (moonCore.modules) или папкой в настройке moonCore.modules.");
        return false;
    }
    const items = found.map((m) => ({
        label: m.name, description: m.id + (m.version ? " " + m.version : ""), detail: sourceTitle(m),
        picked: isAllowed(context, m), module: m,
    }));
    const picks = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: "Какие модули встраивать в VS Code" });
    if (!picks) return false;
    const on = new Set(picks.map((p) => p.module.id));
    let changed = false;
    for (const m of found) {
        const want = on.has(m.id);
        if (want !== isAllowed(context, m)) { await setAllowed(context, m, want); changed = true; }
    }
    return changed;
}

function copyFile(context, id) { return path.join(context.globalStorageUri.fsPath, "modules-approved", id + ".js"); }
function saveApproved(context, m, code) {
    const map = readMap(context, CODE_KEY);
    map[m.id] = { sha: M.sha256(code), source: m.source };
    try {
        fs.mkdirSync(path.dirname(copyFile(context, m.id)), { recursive: true });
        fs.writeFileSync(copyFile(context, m.id), code, "utf8");
    } catch (e) { log("модуль " + m.id + ": копия одобренного кода", e); }
    return context.globalState.update(CODE_KEY, map);
}
function isTrusted(context, m) { return readMap(context, TRUST_KEY)[m.id] === m.source; }

// ------------------------------------------------------------------ режим разработки
// Включается командой на сеанс (до перезапуска VS Code): изменённый код модуля встраивается без
// вопроса и сразу перезапускается в окне (горячая перезагрузка, событие moduleReload). Согласие
// дано явно командой, поэтому его хватает до конца сеанса, но не дольше.
const devSession = new Map();   // id -> source
function isDev(m) { return !!m && devSession.get(m.id) === m.source; }
function devIds() { return Array.from(devSession.keys()); }

/** Код модуля в режиме разработки (для окна) или null. Отдаётся только разрешённому модулю. */
function devCode(context, id) {
    const m = allowed(context).find((x) => x.id === id);
    if (!isDev(m)) return null;
    try {
        const code = fs.readFileSync(m.script, "utf8");
        if (Buffer.byteLength(code, "utf8") > M.LIMITS.MAX_SCRIPT) return null;
        saveApproved(context, m, code);
        return code;
    } catch (e) { log("модуль " + id + ": чтение кода", e); return null; }
}

/** Команда «Режим разработки модуля»: отметить модули из папок. Возвращает включённые. */
async function pickDev(context) {
    const list = allowed(context).filter((m) => m.source.startsWith("dir:"));
    if (!list.length) {
        vscode.window.showInformationMessage("Moon Core: нет разрешённых модулей из папок. Режим разработки — для модуля, который ты пишешь сам (папка в настройке moonCore.modules). Новый — «Moon Core: Создать модуль».");
        return null;
    }
    const picks = await vscode.window.showQuickPick(list.map((m) => ({
        label: m.name, description: m.id, detail: sourceTitle(m), picked: isDev(m), module: m,
    })), { canPickMany: true, placeHolder: "Режим разработки до перезапуска VS Code: правка кода модуля сразу перезапускает его в окне, без вопроса и перезагрузки" });
    if (!picks) return null;
    const on = new Set(picks.map((p) => p.module.id));
    list.forEach((m) => { if (on.has(m.id)) devSession.set(m.id, m.source); else devSession.delete(m.id); });
    log("режим разработки модулей: " + (devIds().join(", ") || "выключен"));
    return list.filter((m) => on.has(m.id));
}

// ------------------------------------------------------------------ шаблон модуля
function templateRuntime(id, name) {
    return [
        "// @ts-check",
        "/// <reference path=\"./mooncore.d.ts\" />",
        "// Модуль Moon Core «" + name + "». Выполняется в окне VS Code сразу после рантайма Moon Core.",
        "// Подсказки по помощнику mc — в mooncore.d.ts рядом. Режим разработки («Moon Core: Режим",
        "// разработки модуля») перезапускает модуль при каждом сохранении этого файла.",
        "(function () {",
        "    \"use strict\";",
        "    const mc = window.__MOONCORE__ && window.__MOONCORE__.module(" + JSON.stringify(id) + ");",
        "    if (!mc) return;                                  // модуль не впечатан (не разрешён или выключен)",
        "",
        "    // Пример: полоска акцентного цвета над статусбаром.",
        "    const style = document.createElement(\"style\");",
        "    style.textContent = \".part.statusbar { box-shadow: inset 0 2px 0 var(--vscode-focusBorder); }\";",
        "    document.head.appendChild(style);",
        "",
        "    // Всё, что модуль создал, убирается перед перезапуском — иначе останутся дубли.",
        "    mc.onDispose(() => style.remove());",
        "",
        "    // Файл данных модуля переживает перезапуски и очистку localStorage.",
        "    const data = mc.data() || { starts: 0 };",
        "    data.starts = (data.starts || 0) + 1;",
        "    mc.saveData(data);",
        "",
        "    // События и запросы к своему расширению (если оно есть):",
        "    //   mc.on(\"theme\", (d) => { ... });      — хост: api.module(id).publish(\"theme\", {...})",
        "    //   mc.rpc(\"ping\", { n: 1 });            — хост: api.module(id).onRequest((method, body) => ...)",
        "    console.log(\"[" + id + "] запуск №\" + data.starts + (mc.hot ? \", перезагрузка \" + mc.hot : \"\"));",
        "})();",
        "",
    ].join("\n");
}

/**
 * Команда «Создать модуль»: папка с манифестом, рантаймом-заготовкой, типами и jsconfig.
 * Папка сразу добавляется в moonCore.modules. Возвращает созданный модуль (или null).
 */
async function createModule(context) {
    const where = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Создать модуль в этой папке" });
    if (!where || !where[0]) return null;
    const id = await vscode.window.showInputBox({
        prompt: "id модуля: латиница в нижнем регистре, цифры и дефис (станет и именем папки)", value: "my-module",
        validateInput: (v) => M.ID_RE.test(v) ? (fs.existsSync(path.join(where[0].fsPath, v)) ? "папка " + v + " уже есть" : null) : "от 2 до 32 символов: a-z, 0-9, -; начинается с буквы",
    });
    if (!id) return null;
    const name = await vscode.window.showInputBox({ prompt: "Название модуля (для людей)", value: id, validateInput: (v) => v.trim() && v.length <= 60 ? null : "от 1 до 60 символов" });
    if (!name) return null;
    const dir = path.join(where[0].fsPath, id);
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    const manifest = { id: id, name: name.trim(), version: "0.1.0", script: "runtime.js", assets: "assets" };
    fs.writeFileSync(path.join(dir, M.MODULE_FILE), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    fs.writeFileSync(path.join(dir, "runtime.js"), templateRuntime(id, name.trim()), "utf8");
    fs.writeFileSync(path.join(dir, "assets", ".keep"), "", "utf8");
    fs.copyFileSync(path.join(context.extensionPath, "types", "mooncore.d.ts"), path.join(dir, "mooncore.d.ts"));
    fs.writeFileSync(path.join(dir, "jsconfig.json"), JSON.stringify({ compilerOptions: { checkJs: true, target: "es2020", lib: ["es2020", "dom"] }, include: ["*.js", "mooncore.d.ts"] }, null, 2) + "\n", "utf8");
    fs.writeFileSync(path.join(dir, "README.md"), [
        "# " + name.trim(), "",
        "Модуль Moon Core (`" + id + "`): код в `runtime.js` выполняется в окне VS Code.", "",
        "- `mooncore-module.json` — манифест (id, скрипт, папка ресурсов `assets`).",
        "- `mooncore.d.ts` — типы помощника `mc` (подсказки в VS Code).",
        "- Режим разработки: «Moon Core: Режим разработки модуля» — правка `runtime.js` сразу перезапускает модуль.",
        "- Картинки и шрифты — в `assets`, адрес папки в окне: `mc.base`.", "",
    ].join("\n"), "utf8");
    const conf = vscode.workspace.getConfiguration("moonCore");
    const dirs = conf.get("modules", []);
    const list = (Array.isArray(dirs) ? dirs : []).filter((d) => typeof d === "string");
    if (!list.some((d) => path.resolve(d).toLowerCase() === dir.toLowerCase())) {
        await conf.update("modules", list.concat([dir]), vscode.ConfigurationTarget.Global);
    }
    log("модуль создан: " + dir);
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(dir, "runtime.js")), { preview: false });
    return { id: id, dir: dir };
}

/**
 * Проверить код модулей перед встраиванием. list — разрешённые модули, scripts — их прочитанный
 * код ({id, code, sha}). Возвращает { scripts, pending }: scripts — что встраивать (новый код
 * или последняя одобренная копия), pending — изменения, о которых нужно спросить.
 */
function vetScripts(context, list, scripts) {
    const byId = {}; list.forEach((m) => { byId[m.id] = m; });
    const codeMap = readMap(context, CODE_KEY);
    const out = [], pending = [];
    scripts.forEach((s) => {
        const m = byId[s.id]; if (!m) return;
        const a = codeMap[s.id];
        if (!a || a.source !== m.source) {
            // Модуль уже разрешён, а код ещё не запоминали (первый запуск этой версии или новый
            // модуль, только что разрешённый) — одобряем то, что есть.
            saveApproved(context, m, s.code); out.push(s); return;
        }
        if (a.sha === s.sha) { out.push(s); return; }
        if (isTrusted(context, m) || isDev(m)) { saveApproved(context, m, s.code); out.push(s); return; }
        pending.push({ module: m, script: s, oldSha: a.sha });
        let old = null;
        try { old = fs.readFileSync(copyFile(context, s.id), "utf8"); } catch (e) {}
        if (old != null && M.sha256(old) === a.sha) out.push({ id: s.id, code: old, sha: a.sha });
        else log("модуль " + s.id + ": код изменился, одобренной копии нет — модуль не встроен до подтверждения");
    });
    return { scripts: out, pending: pending };
}

/** Спросить про изменённый код модулей. true — если что-то одобрили. */
async function reviewChanged(context, pending) {
    let changed = false;
    for (const p of pending || []) {
        const m = p.module, kb = (n) => Math.round(n / 1024) + " КБ";
        let oldLen = 0;
        try { oldLen = fs.statSync(copyFile(context, m.id)).size; } catch (e) {}
        const pick = await vscode.window.showWarningMessage(
            "Moon Core: код модуля «" + m.name + "» изменился на диске (" + sourceTitle(m) + ", " + kb(oldLen) + " → " + kb(p.script.code.length) + "). " +
            "Модуль работает в окне VS Code с полным доступом. Встроить новую версию?",
            "Встроить", "Всегда доверять этой папке", "Не сейчас");
        if (pick === "Встроить" || pick === "Всегда доверять этой папке") {
            if (pick !== "Встроить") {
                const t = readMap(context, TRUST_KEY); t[m.id] = m.source; await context.globalState.update(TRUST_KEY, t);
            }
            await saveApproved(context, m, p.script.code);
            log("модуль " + m.id + ": новый код одобрен" + (pick === "Встроить" ? "" : " (обновления из этого источника — без вопроса)"));
            changed = true;
        }
    }
    return changed;
}

module.exports = { discover, allowed, reviewNew, pickCommand, sourceTitle, vetScripts, reviewChanged, isDev, devIds, devCode, pickDev, createModule, templateRuntime };
