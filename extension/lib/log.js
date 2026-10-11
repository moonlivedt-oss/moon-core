// Журнал расширения: OutputChannel «Moon Core». Без vscode (тесты, хук удаления) — в консоль.
"use strict";

let _channel = null;

function channel() {
    if (_channel) return _channel;
    try {
        const vscode = require("vscode");
        _channel = vscode.window.createOutputChannel("Moon Core");
    } catch (e) {
        _channel = { appendLine: (s) => { if (process.env.MOONCORE_LOG) console.log(s); }, show() {}, dispose() {} };
    }
    return _channel;
}

function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

// Журнал прикладывают к issue — в нём не должно быть имени пользователя. Домашняя папка
// (C:\Users\<имя>, /home/<имя>) заменяется на «~» во всех написаниях (слэши, file:///, регистр).
const os = require("os");
function redactor() {
    let home = "";
    try { home = os.homedir(); } catch (e) {}
    if (!home || home.length < 4) return (s) => s;
    const variants = new Set([home, home.replace(/\\/g, "/"), home.replace(/\//g, "\\")]);
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(Array.from(variants).map(esc).join("|"), "gi");
    let user = "";
    try { user = os.userInfo().username || ""; } catch (e) {}
    const reUser = user.length >= 3 ? new RegExp("([\\\\/]Users[\\\\/])" + esc(user) + "(?=[\\\\/]|$)", "gi") : null;
    return (s) => { let t = String(s).replace(re, "~"); if (reUser) t = t.replace(reUser, "$1~"); return t; };
}
const redactPaths = redactor();
// Токены моста (48 hex) попадают в журнал с адресами запросов — в отчёт они не должны уйти.
const TOKEN_RE = /\b[0-9a-f]{48}\b/g;
// Секреты, которые могут прийти в журнал из ошибок окна, модулей и команд: ключи API, токены
// GitHub/Slack/AWS, JWT, Bearer, пароль в URL и пары «password=...». Значение заменяется, имя
// ключа остаётся — по отчёту видно, что там было, но не само значение.
const SECRET_RES = [
    [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/g, "<секрет>"],
    [/\bsk-[A-Za-z0-9_-]{16,}/g, "<секрет>"],
    [/\bxox[abprs]-[\w-]{10,}/g, "<секрет>"],
    [/\bAKIA[0-9A-Z]{16}\b/g, "<секрет>"],
    [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "<секрет>"],
    [/(\bBearer\s+)[\w.~+/-]{16,}=*/gi, "$1<секрет>"],
    [/(:\/\/)[^\s/:@]+:[^\s/@]+@/g, "$1<скрыто>@"],
    [/(\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\b["']?\s*[=:]\s*["']?)[^\s"',;&]{4,}/gi, "$1<секрет>"],
];
function redactSecrets(s) { return SECRET_RES.reduce((t, r) => t.replace(r[0], r[1]), String(s)); }
function redact(s) { return redactSecrets(redactPaths(s).replace(TOKEN_RE, "<токен>")); }

// ------------------------------------------------------------------ файл журнала
// Output «Moon Core» живёт до закрытия окна; файл в globalStorage переживает перезапуск (нужен,
// когда VS Code не открылся после обновления). Ротация: больше LOG_MAX — старый уходит в .1.
const LOG_MAX = 1024 * 1024;
let logFile = "", pendingLines = [], flushTimer = null;
function flushFile() {
    flushTimer = null;
    if (!logFile || !pendingLines.length) return;
    const fs = require("fs");
    const text = pendingLines.join("\n") + "\n";
    pendingLines = [];
    try {
        let size = 0;
        try { size = fs.statSync(logFile).size; } catch (e) {}
        // Размер — в байтах: строки журнала по-русски, символ кириллицы в UTF-8 — два байта.
        if (size + Buffer.byteLength(text, "utf8") > LOG_MAX) { try { fs.renameSync(logFile, logFile + ".1"); } catch (e) {} }
        fs.appendFileSync(logFile, text, "utf8");
    } catch (e) { /* журнал не должен ронять расширение */ }
}
/** Писать журнал ещё и в файл (путь в globalStorage). "" — выключить. */
function setLogFile(file) {
    flushFile();
    logFile = String(file || "");
}
function logFilePath() { return logFile; }

// Последние строки журнала в памяти: Доктор кладёт их в отчёт «Скопировать отчёт».
const RING_MAX = 300;
const ring = [];
function recentLog(n) { return ring.slice(-Math.max(1, Math.min(RING_MAX, n || RING_MAX))); }

// Уровень журнала (moonCore.logLevel): "all" — всё; "errors" — только записи с ошибкой;
// "off" — ничего. Последние строки в памяти (для отчёта Доктора) ведутся при любом уровне.
const LEVELS = ["all", "errors", "off"];
let level = "all";
function setLogLevel(v) { level = LEVELS.indexOf(v) !== -1 ? v : "all"; return level; }

// Повторы подряд: одна и та же запись (опрос раз в несколько секунд, цикл ошибок окна) не
// плодит тысячи строк — пишется первая, остальные считаются и сводятся в одну строку
// «повторилось ещё N раз», когда придёт другая запись или пройдёт REPEAT_FLUSH_MS.
const REPEAT_FLUSH_MS = 10 * 60000;
let lastBody = "", repeats = 0, repeatSince = 0;

function emit(safe, quiet) {
    ring.push(safe);
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
    if (quiet) return;
    channel().appendLine(safe);
    if (logFile) {
        pendingLines.push(new Date().toISOString().slice(0, 10) + " " + safe);
        if (pendingLines.length > 500) pendingLines.splice(0, pendingLines.length - 500);
        if (!flushTimer) { flushTimer = setTimeout(flushFile, 500); if (flushTimer.unref) flushTimer.unref(); }
    }
}
function flushRepeats(quiet) {
    if (!repeats) return;
    emit("[" + stamp() + "] (предыдущая запись повторилась ещё " + repeats + " раз)", quiet);
    repeats = 0;
}

/** log("текст") или log("где", ошибка). */
function log(msg, err) {
    let body = String(msg);
    if (err) body += ": " + (err && err.stack ? err.stack : String(err));
    const quiet = level === "off" || (level === "errors" && !err);
    // Прогон в настоящем VS Code (test/e2e) читает журнал из файла: окно Output ему не видно.
    if (process.env.MOONCORE_LOG_FILE) { try { require("fs").appendFileSync(process.env.MOONCORE_LOG_FILE, redact("[" + stamp() + "] " + body) + "\n", "utf8"); } catch (e) {} }
    const now = Date.now();
    if (body === lastBody && now - repeatSince < REPEAT_FLUSH_MS) { repeats++; return; }
    flushRepeats(quiet);
    lastBody = body; repeatSince = now;
    emit(redact("[" + stamp() + "] " + body), quiet);
}

function showLog() { channel().show(true); }
function disposeLog() { flushRepeats(level === "off"); clearTimeout(flushTimer); flushFile(); if (_channel) { try { _channel.dispose(); } catch (e) {} _channel = null; } }

module.exports = { setLogLevel, LEVELS, log, showLog, disposeLog, redact, redactSecrets, recentLog, setLogFile, logFilePath, flushFile };
