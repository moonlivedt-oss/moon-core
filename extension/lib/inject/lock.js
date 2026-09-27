// ============================================================
//  Внедрение: межпроцессная блокировка записи оболочки.
//
//  Окна VS Code — отдельные хосты расширений с общим globalStorage. После обновления VS Code
//  они активируются почти одновременно, и каждое видит «блока нет / устарел». Без блокировки
//  записи двух окон перемешиваются: хэш в product.json считается по оболочке одного окна, а на
//  диске остаётся оболочка другого (баннер «повреждено»), бэкап может снять уже патченный файл.
//
//  Блокировка — файл mooncore-inject.lock, созданный с флагом wx (атомарно: создаёт ровно один).
//  Внутри pid и время. Брошенная блокировка (процесс умер или она старше STALE_MS) снимается
//  переименованием: из двух окон, решивших её снять, файл переименует только одно.
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { pidAlive } = require("../bridge");
const { sleepSync } = require("../fsx");

const LOCK_NAME = "mooncore-inject.lock";
const STALE_MS = 5 * 60 * 1000;   // запрос прав администратора может ждать ответа пару минут

function lockPath(dir) { return path.join(dir, LOCK_NAME); }

function readLock(file) {
    try { const o = JSON.parse(fs.readFileSync(file, "utf8")); return o && typeof o === "object" ? o : null; }
    catch (e) { return null; }
}

/** Блокировка брошена: владелец умер, записи не разобрать или она слишком старая. */
function isStale(o, now) {
    return !o || !pidAlive(o.pid) || (now || Date.now()) - (Number(o.at) || 0) > STALE_MS;
}
/**
 * Брошен ли файл блокировки. Пустой/нечитаемый файл моложе двух секунд — не брошен: его
 * владелец только что создал файл и ещё дописывает pid.
 */
function fileStale(file) {
    const o = readLock(file);
    if (o) return isStale(o);
    try { return Date.now() - fs.statSync(file).mtimeMs > 2000; } catch (e) { return true; }
}

/**
 * Взять блокировку. Возвращает функцию снятия или null (занято живым процессом).
 * Повторный вход из того же процесса — занято (внедрение внутри внедрения — ошибка логики).
 */
function acquire(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (let i = 0; i < 6; i++) {
        try {
            fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" });
            return () => release(file);
        } catch (e) {
            // Windows: файл, который другой процесс как раз удаляет, создать нельзя (EPERM) —
            // это «занято на миг», а не нехватка прав.
            if (e && (e.code === "EPERM" || e.code === "EBUSY")) { sleepSync(10 * (i + 1)); continue; }
            if (!e || e.code !== "EEXIST") throw e;
        }
        if (!fileStale(file)) return null;
        // Снять брошенную: переименовать (атомарно — удастся одному окну), проверить, что
        // переименовали именно брошенную, и только тогда удалить.
        const aside = file + "." + process.pid + ".stale";
        try { fs.renameSync(file, aside); } catch (e) { continue; }
        if (fileStale(aside)) { try { fs.unlinkSync(aside); } catch (e) {} continue; }
        try { fs.renameSync(aside, file); } catch (e) {}      // успела появиться живая — вернуть
        return null;
    }
    return null;
}

/** Снять свою блокировку (чужую не трогаем). */
function release(file) {
    const o = readLock(file);
    if (o && o.pid === process.pid) { try { fs.unlinkSync(file); } catch (e) {} }
}

/** Выполнить fn под блокировкой: результат fn или { busy: true }. file = null — без блокировки. */
function withLock(file, fn) {
    if (!file) return fn();
    const off = acquire(file);
    if (!off) return { busy: true };
    try { return fn(); } finally { off(); }
}

/** То же для асинхронного fn (запись с правами администратора ждёт UAC). */
async function withLockAsync(file, fn) {
    if (!file) return fn();
    const off = acquire(file);
    if (!off) return { busy: true };
    try { return await fn(); } finally { off(); }
}

/** Дождаться, пока блокировку снимут (или она окажется брошенной). true — свободно. */
function waitFree(file, timeoutMs) {
    const until = Date.now() + (timeoutMs || 15000);
    return new Promise((resolve) => {
        (function poll() {
            if (!fs.existsSync(file) || fileStale(file)) { resolve(true); return; }
            if (Date.now() > until) { resolve(false); return; }
            setTimeout(poll, 150);
        })();
    });
}

module.exports = { LOCK_NAME, STALE_MS, lockPath, readLock, isStale, fileStale, acquire, release, withLock, withLockAsync, waitFree };
