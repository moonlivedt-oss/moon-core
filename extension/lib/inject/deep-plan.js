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
const { log } = require("../log");
const { statKey } = require("../fsx");

function deepFiles() {
    const appRoot = vscode.env && vscode.env.appRoot;
    if (!appRoot) return null;
    const out = path.join(appRoot, "out");
    return { out: out, bundle: path.join(out, "vs", "workbench", "workbench.desktop.main.js"), main: path.join(out, "main.js"), mjs: path.join(out, DP.MAIN_FILE) };
}

function deepWanted() {
    const c = vscode.workspace.getConfiguration("moonCore");
    return { di: c.get("deepHooks", false) === true, main: c.get("mainProcess", false) === true };
}

let deepCache = { key: "", v: null };
function resetDeepCache() { deepCache = { key: "", v: null }; }

/** {di, main, diSupported, want, ok}: что стоит сейчас и совпадает ли это с настройками. Бандл большой — кэш по размеру и времени. */
function deepState() {
    const f = deepFiles(); if (!f) return null;
    const want = deepWanted();
    const key = statKey([f.bundle, f.main, f.mjs]) + "|" + want.di + want.main;
    if (deepCache.key === key) return deepCache.v;
    let di = false, main = false, diSupported = true;
    try {
        const t = fs.readFileSync(f.bundle, "utf8");
        di = DP.hasDi(t);
        if (!di) diSupported = DP.patchBundle(t).ok;
    } catch (e) { diSupported = false; }
    try { main = DP.hasMain(fs.readFileSync(f.main, "utf8")) && fs.existsSync(f.mjs); } catch (e) {}
    const ok = (want.di ? (di || !diSupported) : !di) && want.main === main;
    deepCache = { key: key, v: { di: di, main: main, diSupported: diSupported, want: want, ok: ok } };
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
    resetDeepCache();
}

module.exports = { deepFiles, deepWanted, deepState, planDeep, planRemoveDeep, resetDeepCache };
