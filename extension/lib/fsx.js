// ============================================================
//  Файловые помощники без vscode: атомарная запись с повторами и слежение, которое не роняет хост.
//
//  На Windows rename поверх файла падает с EPERM/EBUSY, пока файл кто-то читает (другое окно
//  VS Code читает mooncore-state.json по vscode-file://, антивирус сканирует оболочку). Пара
//  коротких повторов почти всегда это переживает. Пауза — Atomics.wait, а не пустой цикл.
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const RETRY_CODES = new Set(["EBUSY", "EPERM"]);
const _sleepBuf = typeof SharedArrayBuffer === "function" ? new Int32Array(new SharedArrayBuffer(4)) : null;

/** Синхронная пауза без загрузки процессора. */
function sleepSync(ms) {
    if (_sleepBuf) { try { Atomics.wait(_sleepBuf, 0, 0, ms); return; } catch (e) { /* нет Atomics.wait — ниже */ } }
    const until = Date.now() + ms;
    while (Date.now() < until) { /* запасной путь */ }
}

/** rename с повторами на EBUSY/EPERM (файл занят читателем). Прочие ошибки — сразу наружу. */
function renameRetry(from, to, tries) {
    const n = tries || 4;
    let lastErr = null;
    for (let i = 0; i < n; i++) {
        try { fs.renameSync(from, to); return; }
        catch (e) {
            lastErr = e;
            if (!(e && RETRY_CODES.has(e.code))) break;
            sleepSync(30 * (i + 1));
        }
    }
    throw lastErr;
}

/**
 * Атомарная запись: временный файл рядом + rename с повторами. Читатель никогда не увидит
 * недописанный файл. suffix — окончание временного файла (по умолчанию .<pid>.tmp).
 */
function writeAtomic(file, data, suffix) {
    const tmp = file + (suffix || "." + process.pid + ".tmp");
    fs.writeFileSync(tmp, data, typeof data === "string" ? "utf8" : undefined);
    try { renameRetry(tmp, file); }
    catch (e) { try { fs.unlinkSync(tmp); } catch (e2) { /* хвоста нет */ } throw e; }
}

/**
 * fs.watch, который не роняет хост расширений: у «голого» watcher без обработчика 'error'
 * исключение уходит наружу (папку удалили, диск отключили). onError получает ошибку.
 */
function safeWatch(target, listener, onError) {
    const w = fs.watch(target, listener);
    w.on("error", (e) => { try { w.close(); } catch (e2) {} if (onError) onError(e); });
    return w;
}

/**
 * Следить за файлом через его папку: редакторы сохраняют «атомарно» (пишут рядом и
 * переименовывают), после этого watch на самом файле замолкает навсегда.
 */
function watchFile(file, listener, onError) {
    const base = path.basename(file);
    const cmp = process.platform === "win32" ? (a) => String(a).toLowerCase() === base.toLowerCase() : (a) => String(a) === base;
    return safeWatch(path.dirname(file), (ev, name) => { if (!name || cmp(name)) listener(ev, base); }, onError);
}

/** Отпечаток файлов для дешёвой проверки «что-то изменилось»: время изменения и размер. */
function statKey(files) {
    return files.map((f) => {
        try { const s = fs.statSync(f); return s.mtimeMs + ":" + s.size; } catch (e) { return "-"; }
    }).join("|");
}

module.exports = { sleepSync, renameRetry, writeAtomic, safeWatch, watchFile, statKey };
