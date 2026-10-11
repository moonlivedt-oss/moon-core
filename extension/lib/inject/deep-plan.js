// ============================================================
//  Внедрение: глубокая интеграция в плане записи — крючок сервисов окна в бандле воркбенча и
//  импорт скрипта главного процесса в out/main.js (сами патчи — lib/deep.js, без vscode).
// ============================================================
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const W = require("../wb-patch");
const DP = require("../deep");
const WV = require("../webview-patch");
const S = require("../snippets");
const { snippetsDir, metaFile } = require("../storage");
const { log } = require("../log");
const { statKey } = require("../fsx");
const KEYS = require("../keys");

function deepFiles() {
    const appRoot = vscode.env && vscode.env.appRoot;
    if (!appRoot) return null;
    const out = path.join(appRoot, "out");
    return { out: out, bundle: path.join(out, "vs", "workbench", "workbench.desktop.main.js"), main: path.join(out, "main.js"), mjs: path.join(out, DP.MAIN_FILE), webview: WV.fileIn(out) };
}

function deepWanted() {
    const c = vscode.workspace.getConfiguration("moonCore");
    return { di: c.get("deepHooks", false) === true, main: c.get("mainProcess", false) === true, webview: c.get("webviewStyles", false) === true };
}

/** CSS для webview из сниппетов webview*.css ("" — настройка выключена, сниппетов нет или CSS недопустим). */
let wvCache = { key: "", css: "" };
function webviewCss(context) {
    if (!context || !deepWanted().webview) return "";
    try {
        const dir = snippetsDir(context), meta = metaFile(context);
        let names = [];
        try { names = fs.readdirSync(dir).filter((n) => S.isWebview(n)).sort(); } catch (e) { return ""; }
        const key = names.join(",") + "#" + statKey(names.map((n) => path.join(dir, n)).concat([meta]));
        if (wvCache.key !== key) wvCache = { key: key, css: WV.cleanCss(S.webviewCss(dir, S.readMeta(meta))) };
        return wvCache.css;
    } catch (e) { return ""; }
}

let deepCache = { key: "", v: null };

/**
 * Есть ли в бандле воркбенча крючок сервисов и можно ли его поставить. Бандл — около 20 МБ:
 * его чтение и разбор стоили каждому окну ~50 мс и ~40 МБ памяти при активации. Ответ зависит
 * только от файла, поэтому он запоминается в globalState по размеру и времени изменения —
 * окна и сеансы после первого бандл не читают, пока VS Code его не обновит.
 */
function bundleFacts(context, file) {
    const key = statKey([file]);
    const gs = context && context.globalState;
    const saved = gs ? gs.get(KEYS.DEEP_BUNDLE) : null;
    if (saved && saved.key === key && key !== "-") return { di: saved.di === true, diSupported: saved.diSupported !== false };
    let di = false, diSupported = true;
    try {
        const t = fs.readFileSync(file, "utf8");
        di = DP.hasDi(t);
        if (!di) diSupported = DP.patchBundle(t).ok;
    } catch (e) { diSupported = false; }
    if (gs && key !== "-") Promise.resolve(gs.update(KEYS.DEEP_BUNDLE, { key: key, di: di, diSupported: diSupported })).catch(() => {});
    return { di: di, diSupported: diSupported };
}
function resetDeepCache() { deepCache = { key: "", v: null }; }

/** {di, main, diSupported, want, ok}: что стоит сейчас и совпадает ли это с настройками. Бандл большой — кэш по размеру и времени. */
function deepState(context) {
    const f = deepFiles(); if (!f) return null;
    const want = deepWanted();
    const css = webviewCss(context);
    const key = statKey([f.bundle, f.main, f.mjs, f.webview]) + "|" + want.di + want.main + want.webview + "|" + W.sha256(css).slice(0, 16);
    if (deepCache.key === key) return deepCache.v;
    const b = bundleFacts(context, f.bundle);
    const di = b.di, diSupported = b.diSupported;
    let main = false;
    try { main = DP.hasMain(fs.readFileSync(f.main, "utf8")) && fs.existsSync(f.mjs); } catch (e) {}
    // Стили webview: в файле ровно нынешний CSS сниппетов (или ничего, если выключено). Файл,
    // который править нельзя (изменён другой программой), «не совпадает» не считается.
    let webview = false, webviewOk = true, webviewSupported = true;
    try {
        const t = fs.readFileSync(f.webview, "utf8");
        webview = WV.hasPatch(t);
        if (css) { webviewSupported = WV.patch(t, css).ok; webviewOk = !webviewSupported || WV.patchCss(t) === css; }
        else webviewOk = !webview;
    } catch (e) { webviewSupported = false; }
    const ok = (want.di ? (di || !diSupported) : !di) && want.main === main && webviewOk;
    deepCache = { key: key, v: { di: di, main: main, diSupported: diSupported, webview: webview, webviewSupported: webviewSupported, want: want, ok: ok } };
    return deepCache.v;
}

/** Бэкапа нет или он от прошлой сборки VS Code (не совпадает с нынешним файлом без наших правок). */
function bakStale(file, bare) {
    try {
        const b = file + W.BAK_EXT;
        return fs.statSync(b).size !== Buffer.byteLength(bare, "utf8") || fs.readFileSync(b, "utf8") !== bare;
    } catch (e) { return true; }
}

/**
 * Добавить в план глубокие патчи (или их снятие) по настройкам.
 * hooks: { planChecksum(products, file, data), originalChecksum(file), fixChecksum: bool } — из shell.js
 * (передаются, а не требуются, чтобы не было круговой зависимости).
 */
function planDeep(context, ops, products, hooks) {
    const f = deepFiles(); if (!f) return;
    const want = deepWanted();
    let text = null;
    try { text = fs.readFileSync(f.bundle, "utf8"); } catch (e) {}
    if (text != null) {
        const bare = DP.stripBundle(text);
        let next = bare;
        if (want.di) { const r = DP.patchBundle(bare); if (r.ok) next = r.text; else log("сервисы окна: " + r.error); }
        if (next !== text) {
            if (bakStale(f.bundle, bare)) ops.push({ file: f.bundle + W.BAK_EXT, data: bare });
            ops.push({ file: f.bundle, data: next, atomic: true });
            // Хэш — только если без нашего крючка бандл исходный: чужие правки не узакониваем.
            const orig = hooks.originalChecksum(f.bundle);
            if (hooks.fixChecksum && orig != null && W.productChecksum(Buffer.from(bare, "utf8")) === orig) hooks.planChecksum(products, f.bundle, next);
            else if (hooks.fixChecksum) log("хэш бандла воркбенча не трогаю: он был изменён не Moon Core");
        }
    }
    let mt = null;
    try { mt = fs.readFileSync(f.main, "utf8"); } catch (e) {}
    if (mt != null) {
        const bare = DP.stripMain(mt);
        const next = want.main ? DP.patchMain(bare) : bare;
        if (next !== mt) {
            if (bakStale(f.main, bare)) ops.push({ file: f.main + W.BAK_EXT, data: bare });
            ops.push({ file: f.main, data: next, atomic: true });
        }
        const script = DP.mainScript(context.extension.id);
        let cur = null;
        try { cur = fs.readFileSync(f.mjs, "utf8"); } catch (e) {}
        if (want.main && cur !== script) ops.push({ file: f.mjs, data: script });
        else if (!want.main && cur != null) ops.push({ file: f.mjs, remove: true });
    }
    // Стили webview: CSS сниппетов webview*.css — в основу webview (lib/webview-patch.js).
    let wt = null;
    try { wt = fs.readFileSync(f.webview, "utf8"); } catch (e) {}
    if (wt != null) {
        const css = webviewCss(context);
        const bare = WV.strip(wt);
        let next = bare;
        if (css) { const r = WV.patch(bare, css); if (r.ok) next = r.text; else { next = wt === bare ? wt : bare; log("стили webview: " + r.error); } }
        if (next !== wt) {
            if (bakStale(f.webview, bare)) ops.push({ file: f.webview + W.BAK_EXT, data: bare });
            ops.push({ file: f.webview, data: next, atomic: true });
        }
    }
    resetDeepCache();
}

/** Добавить в план снятие глубоких патчей: бандл без крючка (и его исходный хэш), main.js без импорта, скрипт — прочь. */
function planRemoveDeep(ops, products, planChecksumRestore) {
    const df = deepFiles();
    if (!df) return;
    try {
        const t = fs.readFileSync(df.bundle, "utf8");
        if (DP.hasDi(t)) { ops.push({ file: df.bundle, data: DP.stripBundle(t), atomic: true }); planChecksumRestore(products, df.bundle); }
    } catch (e) {}
    try { const t = fs.readFileSync(df.main, "utf8"); if (DP.hasMain(t)) ops.push({ file: df.main, data: DP.stripMain(t), atomic: true }); } catch (e) {}
    if (fs.existsSync(df.mjs)) ops.push({ file: df.mjs, remove: true });
    try { const t = fs.readFileSync(df.webview, "utf8"); if (WV.hasPatch(t)) ops.push({ file: df.webview, data: WV.strip(t), atomic: true }); } catch (e) {}
    resetDeepCache();
}

module.exports = { webviewCss, deepFiles, deepWanted, deepState, planDeep, planRemoveDeep, resetDeepCache };
