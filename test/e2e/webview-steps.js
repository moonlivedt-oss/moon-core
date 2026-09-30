// Шаги прогона в настоящем VS Code для стилей внутри webview (lib/webview-patch.js):
// основа webview правится при внедрении, настоящая webview открывается и видит наш CSS,
// снятие возвращает файл байт в байт. Зовёт test/e2e/suite.js.
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const SNIPPET = "webview-e2e.css";
const CSS = "body { --mooncore-e2e: 7; }";

/** До внедрения: сниппет webview*.css в папку сниппетов (настройка moonCore.webviewStyles — в run.js). */
function prepare(host) {
    host.onWebviewCss = null;                       // внедряет сама фаза, а не слежение за сниппетом
    fs.writeFileSync(path.join(host.dir, SNIPPET), CSS, "utf8");
    host.rebuild();
}

function afterInject(step, ext, inject, context) {
    const WV = require(path.join(ext.extensionPath, "lib", "webview-patch"));
    const df = inject.deepFiles();
    const t = fs.readFileSync(df.webview, "utf8");
    step("webview: CSS сниппета вписан в основу, хэш скрипта сходится", WV.hasPatch(t) && WV.hashOk(t) && WV.patchCss(t).indexOf("--mooncore-e2e") !== -1, { patch: WV.hasPatch(t), hash: WV.hashOk(t) });
    step("webview: бэкап основы — исходный файл", fs.existsSync(df.webview + ".mooncore-backup") && WV.hashOk(fs.readFileSync(df.webview + ".mooncore-backup", "utf8")) && fs.readFileSync(df.webview + ".mooncore-backup", "utf8") === WV.strip(t));
    const d = inject.deepState(context);
    step("webview: состояние совпадает с настройками", !!d && d.webview === true && d.ok === true, d);
    step("webview: сниппет не ушёл в окно", !fs.readFileSync(path.join(context.globalStorageUri.fsPath, "mooncore-state.json"), "utf8").includes("mooncore-e2e"));
}

/** Настоящая webview на правленой основе: её скрипт выполняется и видит переменную из нашего CSS. */
async function inWindow(step) {
    const panel = vscode.window.createWebviewPanel("moonCore.e2e", "e2e webview", vscode.ViewColumn.Active, { enableScripts: true });
    const got = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 20000);
        panel.webview.onDidReceiveMessage((m) => { clearTimeout(timer); resolve(m); });
    });
    panel.webview.html = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body><script>" +
        "const vs = acquireVsCodeApi(); setTimeout(() => vs.postMessage({ v: getComputedStyle(document.body).getPropertyValue('--mooncore-e2e').trim(), styles: !!document.getElementById('_defaultStyles') }), 300);" +
        "</script></body></html>";
    const m = await got;
    step("webview: страница открылась на правленой основе и видит CSS сниппета", !!m && m.v === "7" && m.styles === true, m);
    try { panel.dispose(); } catch (e) {}
}

function beforeRemove(inject) {
    const df = inject.deepFiles();
    return fs.existsSync(df.webview + ".mooncore-backup") ? fs.readFileSync(df.webview + ".mooncore-backup", "utf8") : null;
}
function afterRemove(step, ext, inject, bak) {
    const WV = require(path.join(ext.extensionPath, "lib", "webview-patch"));
    const t = fs.readFileSync(inject.deepFiles().webview, "utf8");
    step("webview: основа совпадает с исходной, хэш сходится", bak != null && t === bak && !WV.hasPatch(t) && WV.hashOk(t));
}

module.exports = { prepare, afterInject, inWindow, beforeRemove, afterRemove };
