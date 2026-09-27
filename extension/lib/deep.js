// ============================================================
//  Глубокая интеграция — чистая часть без vscode (её гоняют тесты).
//
//  1. Сервисы окна (moonCore.deepHooks). В бандле воркбенча (workbench.desktop.main.js) в
//     конструктор InstantiationService вписывается одна строка: экземпляр кладётся в
//     globalThis.__MOONCORE_DI__. Через него рантайм достаёт настоящие сервисы окна по имени
//     (statusbarService, codeEditorService, commandService...). Место находится по устойчивому
//     фрагменту кода; не нашлось (VS Code переписал класс) — патч не ставится, всё остальное работает.
//
//  2. Главный процесс (moonCore.mainProcess). В конец out/main.js дописывается импорт
//     mooncore-main.mjs: он слушает создание окон Electron и применяет настройки окна из файла
//     mooncore-main.json (прозрачность, «поверх всех», акрил/слюда Windows 11, vibrancy macOS).
//     Файл main.js в контрольные суммы product.json не входит — баннера «повреждена» не будет.
//
//  Оба патча обрамлены метками и снимаются ровно тем же текстом; бэкап исходных файлов — рядом.
// ============================================================
"use strict";

const DI_START = "/*MOONCORE-DI*/", DI_END = "/*MOONCORE-DI-END*/";
const DI_RE = /this\._services\.set\(([\w$]+),this\),this\._globalGraph=/;
const MAIN_START = "\n/*MOONCORE-MAIN*/", MAIN_END = "/*MOONCORE-MAIN-END*/\n";
const MAIN_FILE = "mooncore-main.mjs";
const MAIN_CONF = "mooncore-main.json";
const MAIN_STATUS = "mooncore-main-status.json";
const MATERIALS = ["none", "acrylic", "mica", "tabbed"];

function diHook(ident) {
    return DI_START + "(globalThis.__MOONCORE_DI__||(globalThis.__MOONCORE_DI__=[])).length<64&&globalThis.__MOONCORE_DI__.push(this)," + DI_END;
}
function hasDi(text) { return String(text).indexOf(DI_START) !== -1; }
/** Убрать наш крючок из бандла (ровно вписанный текст). */
function stripBundle(text) {
    const s = String(text);
    const a = s.indexOf(DI_START);
    if (a === -1) return s;
    const b = s.indexOf(DI_END, a);
    return b === -1 ? s : s.slice(0, a) + s.slice(b + DI_END.length);
}
/** Вписать крючок в чистый бандл. { ok, text, error? } */
function patchBundle(text) {
    const bare = stripBundle(text);
    const m = DI_RE.exec(bare);
    if (!m) return { ok: false, text: bare, error: "место для крючка не найдено (эта версия VS Code устроена иначе)" };
    if (DI_RE.exec(bare.slice(m.index + m[0].length))) return { ok: false, text: bare, error: "место для крючка не однозначно" };
    const at = m.index + m[0].length - "this._globalGraph=".length;
    return { ok: true, text: bare.slice(0, at) + diHook(m[1]) + bare.slice(at) };
}

function hasMain(text) { return String(text).indexOf(MAIN_START.trim()) !== -1; }
function stripMain(text) {
    const s = String(text);
    const a = s.indexOf(MAIN_START);
    if (a === -1) return s;
    const b = s.indexOf(MAIN_END, a);
    return b === -1 ? s : s.slice(0, a) + s.slice(b + MAIN_END.length);
}
function patchMain(text) {
    const bare = stripMain(text);
    return bare + MAIN_START + "import(\"./" + MAIN_FILE + "\").catch(function(){});" + MAIN_END;
}

/** Настройки окна для главного процесса (moonCore.window) — проверенные. */
function cleanWindowConf(o) {
    const c = o && typeof o === "object" ? o : {};
    const out = { opacity: 1, alwaysOnTop: false, material: "none" };
    if (typeof c.opacity === "number" && isFinite(c.opacity)) out.opacity = Math.round(Math.min(1, Math.max(0.3, c.opacity)) * 100) / 100;
    if (c.alwaysOnTop === true) out.alwaysOnTop = true;
    if (MATERIALS.indexOf(c.material) !== -1) out.material = c.material;
    return out;
}

/**
 * Скрипт главного процесса. Ничего не бросает наружу: любая ошибка пишется в файл статуса,
 * а VS Code продолжает запускаться как обычно. Настройки перечитываются при изменении файла.
 */
/** extId — id расширения; папка globalStorage у VS Code — это id в нижнем регистре. */
function mainScript(extId) {
    return `// Moon Core: главный процесс VS Code (создан расширением ${extId}; снимается командой «Убрать из VS Code»).
import { app, BrowserWindow } from "electron";
import fs from "fs";
import path from "path";
const DIR = path.join(app.getPath("userData"), "User", "globalStorage", ${JSON.stringify(String(extId).toLowerCase())});
const CONF = path.join(DIR, ${JSON.stringify(MAIN_CONF)}), STATUS = path.join(DIR, ${JSON.stringify(MAIN_STATUS)});
const MATERIALS = ${JSON.stringify(MATERIALS)};
let conf = { opacity: 1, alwaysOnTop: false, material: "none" };
const status = { ok: true, at: 0, windows: 0, errors: [], platform: process.platform, conf: conf };
function read() {
    try {
        const c = JSON.parse(fs.readFileSync(CONF, "utf8")) || {};
        conf = {
            opacity: typeof c.opacity === "number" ? Math.min(1, Math.max(0.3, c.opacity)) : 1,
            alwaysOnTop: c.alwaysOnTop === true,
            material: MATERIALS.includes(c.material) ? c.material : "none",
        };
    } catch (e) { conf = { opacity: 1, alwaysOnTop: false, material: "none" }; }
}
function writeStatus() {
    status.at = Date.now(); status.conf = conf; status.errors = status.errors.slice(-10);
    try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(STATUS, JSON.stringify(status)); } catch (e) {}
}
function applyTo(win) {
    if (!win || win.isDestroyed()) return;
    try {
        win.setOpacity(conf.opacity);
        win.setAlwaysOnTop(conf.alwaysOnTop);
        const on = conf.material !== "none";
        if (process.platform === "win32" && typeof win.setBackgroundMaterial === "function") {
            win.setBackgroundMaterial(on ? conf.material : "none");
            if (on) win.setBackgroundColor("#00000000");
        }
        if (process.platform === "darwin" && typeof win.setVibrancy === "function") win.setVibrancy(on ? "under-window" : null);
    } catch (e) { status.ok = false; status.errors.push(String(e && e.message || e)); }
}
function applyAll() {
    let n = 0;
    try {
        BrowserWindow.getAllWindows().forEach((w) => { applyTo(w); n++; });
    } catch (e) { status.errors.push(String(e && e.message || e)); }
    status.windows = n;
    writeStatus();
}
try {
    read();
    app.on("browser-window-created", (e, win) => {
        applyTo(win);
        win.once("ready-to-show", () => applyTo(win));
        setTimeout(applyAll, 500);
    });
    fs.watchFile(CONF, { interval: 1000 }, () => { read(); applyAll(); });
    app.whenReady().then(() => setTimeout(applyAll, 1500));
} catch (e) { status.ok = false; status.errors.push(String(e && e.stack || e)); writeStatus(); }
`;
}

module.exports = {
    DI_START, DI_END, MAIN_FILE, MAIN_CONF, MAIN_STATUS, MATERIALS,
    hasDi, stripBundle, patchBundle, hasMain, stripMain, patchMain, cleanWindowConf, mainScript,
};
