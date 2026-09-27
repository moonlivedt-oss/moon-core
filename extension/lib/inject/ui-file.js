// ============================================================
//  Внедрение: какой рантайм встраивать и файл интерфейса окна для ленивой загрузки.
//
//  По умолчанию в оболочку идёт ядро (runtime/mooncore-core.js), а конструктор и пипетка
//  (runtime/mooncore-ui.js) лежат файлом в globalStorage: окно читает его при первом открытии
//  конструктора (runtime/src/65-ui-loader.js). Имя файла содержит его SHA-256, а в оболочку
//  вписывается тот же SHA — окно не выполнит файл другой версии.
//
//  Ленивая загрузка выключается настройкой moonCore.lazyUi или сама — для версии VS Code, где
//  окно сообщило, что не может вычислить чанк (CSP запретил eval): тогда в оболочку идёт
//  полный рантайм, как раньше.
// ============================================================
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const W = require("../wb-patch");
const { statKey, writeAtomic } = require("../fsx");
const { storageDir, fileUrl } = require("../storage");

const UI_INLINE_KEY = "mooncore.uiInlineFor";   // версия VS Code, где ленивая загрузка не сработала
const UI_PREFIX = "mooncore-ui-";

function rtFile(context, name) { return path.join(context.extensionPath, "runtime", name); }

/** Грузить интерфейс лениво (иначе — полный рантайм в оболочке). */
function lazyOn(context) {
    return vscode.workspace.getConfiguration("moonCore").get("lazyUi", true) !== false &&
        context.globalState.get(UI_INLINE_KEY) !== vscode.version;
}

let chunkCache = { key: "", v: null };
/** Чанк интерфейса из расширения: { code, sha, name }. Кэш по времени изменения файла. */
function uiChunk(context) {
    const f = rtFile(context, "mooncore-ui.js");
    const key = f + "|" + statKey([f]);
    if (chunkCache.key === key && chunkCache.v) return chunkCache.v;
    const code = fs.readFileSync(f, "utf8");
    const sha = W.sha256(code);
    chunkCache = { key: key, v: { code: code, sha: sha, name: UI_PREFIX + sha.slice(0, 16) + ".js" } };
    return chunkCache.v;
}

/**
 * Рантайм для блока: { code, ui }. code — текст для оболочки; ui — { name, sha } или null
 * (интерфейс внутри code). В ленивом режиме в code дописан SHA чанка: новый интерфейс —
 * новый отпечаток блока, и внедрение считается устаревшим.
 */
function runtimeFor(context, opts) {
    const lazy = !(opts && opts.inline) && lazyOn(context);
    if (!lazy) return { code: fs.readFileSync(rtFile(context, "mooncore-runtime.js"), "utf8"), ui: null };
    const c = uiChunk(context);
    const core = fs.readFileSync(rtFile(context, "mooncore-core.js"), "utf8");
    return { code: core + "// mooncore-ui " + c.sha + "\n", ui: { name: c.name, sha: c.sha } };
}

/**
 * Положить чанк интерфейса в globalStorage (если его там нет или он другой) и убрать файлы
 * прежних версий. Возвращает { url, sha } для boot. Бросает ошибку записи.
 */
function ensureUiFile(context) {
    const c = uiChunk(context);
    const dir = storageDir(context);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, c.name);
    let cur = null;
    try { cur = fs.readFileSync(file, "utf8"); } catch (e) {}
    if (cur !== c.code) writeAtomic(file, c.code);
    try {
        fs.readdirSync(dir).filter((n) => n.indexOf(UI_PREFIX) === 0 && n !== c.name).forEach((n) => { try { fs.unlinkSync(path.join(dir, n)); } catch (e) {} });
    } catch (e) {}
    return { url: fileUrl(file), sha: c.sha };
}

/** Окно не смогло вычислить чанк (eval запрещён) — дальше в этой версии VS Code встраивать целиком. */
function markInline(context) { return context.globalState.update(UI_INLINE_KEY, vscode.version); }

module.exports = { UI_INLINE_KEY, UI_PREFIX, lazyOn, uiChunk, runtimeFor, ensureUiFile, markInline };
