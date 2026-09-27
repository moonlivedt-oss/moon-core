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
function redact(s) { return redactPaths(s).replace(TOKEN_RE, "<токен>"); }

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
    // Прогон в настоящем VS Code (test/e2e) читает журнал из файла: окно Output ему не видно.
    if (process.env.MOONCORE_LOG_FILE) { try { require("fs").appendFileSync(process.env.MOONCORE_LOG_FILE, safe + "\n", "utf8"); } catch (e) {} }
}

function showLog() { channel().show(true); }
function disposeLog() { if (_channel) { try { _channel.dispose(); } catch (e) {} _channel = null; } }

module.exports = { log, showLog, disposeLog, redact, recentLog };
