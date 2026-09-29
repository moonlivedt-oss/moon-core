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
        if (size + text.length > LOG_MAX) { try { fs.renameSync(logFile, logFile + ".1"); } catch (e) {} }
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

/** log("текст") или log("где", ошибка). */
function log(msg, err) {
    let line = "[" + stamp() + "] " + msg;
    if (err) line += ": " + (err && err.stack ? err.stack : String(err));
    const safe = redact(line);
    channel().appendLine(safe);
    ring.push(safe);
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
    if (logFile) {
        pendingLines.push(new Date().toISOString().slice(0, 10) + " " + safe);
        if (pendingLines.length > 500) pendingLines.splice(0, pendingLines.length - 500);
        if (!flushTimer) { flushTimer = setTimeout(flushFile, 500); if (flushTimer.unref) flushTimer.unref(); }
    }
    // Прогон в настоящем VS Code (test/e2e) читает журнал из файла: окно Output ему не видно.
    if (process.env.MOONCORE_LOG_FILE) { try { require("fs").appendFileSync(process.env.MOONCORE_LOG_FILE, safe + "\n", "utf8"); } catch (e) {} }
}

function showLog() { channel().show(true); }
function disposeLog() { clearTimeout(flushTimer); flushFile(); if (_channel) { try { _channel.dispose(); } catch (e) {} _channel = null; } }

module.exports = { log, showLog, disposeLog, redact, redactSecrets, recentLog, setLogFile, logFilePath, flushFile };
