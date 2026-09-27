// ============================================================
//  Команды «Глубокая интеграция» и «Вид окна» и настройки окна для главного процесса.
//  moonCore.window -> <globalStorage>/mooncore-main.json (его читает mooncore-main.mjs).
// ============================================================
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const DP = require("../deep");
const { log } = require("../log");

/** Настройки окна для главного процесса: moonCore.window -> <globalStorage>/mooncore-main.json. */
function writeMainConf(context) {
    try {
        const conf = DP.cleanWindowConf(vscode.workspace.getConfiguration("moonCore").get("window", {}));
        const dir = context.globalStorageUri.fsPath;
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, DP.MAIN_CONF), text = JSON.stringify(conf);
        let cur = "";
        try { cur = fs.readFileSync(file, "utf8"); } catch (e) {}
        if (cur !== text) fs.writeFileSync(file, text, "utf8");
    } catch (e) { log("настройки окна", e); }
}

/** Что сообщил скрипт главного процесса (mooncore-main-status.json) или null. */
function mainStatus(context) {
    try { return JSON.parse(fs.readFileSync(path.join(context.globalStorageUri.fsPath, DP.MAIN_STATUS), "utf8")); } catch (e) { return null; }
}

/** Команда «Глубокая интеграция»: сервисы окна и главный процесс — что включить. */
async function deepCommand() {
    const c = vscode.workspace.getConfiguration("moonCore");
    const items = [
        { label: "$(plug) Сервисы окна", key: "deepHooks", picked: c.get("deepHooks", false) === true,
          detail: "Модули и Moon Core получают настоящие сервисы окна VS Code (статусбар, редакторы, команды). Правит бандл воркбенча; бэкап и хэш — как у оболочки." },
        { label: "$(window) Главный процесс", key: "mainProcess", picked: c.get("mainProcess", false) === true,
          detail: "Прозрачность окна, «поверх всех окон», акрил/слюда Windows 11 и vibrancy macOS. Правит out/main.js (не входит в контрольные суммы)." },
    ];
    const picks = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: "Глубокая интеграция: отметь, что включить (после — перезапуск VS Code). Снять всё — «Убрать из VS Code»" });
    if (!picks) return;
    const on = new Set(picks.map((p) => p.key));
    for (const it of items) {
        if ((c.get(it.key, false) === true) !== on.has(it.key)) await c.update(it.key, on.has(it.key), vscode.ConfigurationTarget.Global);
    }
    if (on.has("mainProcess")) {
        const go = await vscode.window.showInformationMessage("Moon Core: главный процесс включится после полного перезапуска VS Code (закрыть все окна). Настроить вид окна сейчас?", "Вид окна");
        if (go) await windowLookCommand();
    }
}

/** Команда «Вид окна»: прозрачность, материал, поверх всех — пишется в moonCore.window. */
async function windowLookCommand() {
    const c = vscode.workspace.getConfiguration("moonCore");
    const cur = DP.cleanWindowConf(c.get("window", {}));
    if (c.get("mainProcess", false) !== true) {
        const pick = await vscode.window.showWarningMessage("Moon Core: вид окна работает через главный процесс — он выключен. Включить?", "Включить");
        if (pick) await c.update("mainProcess", true, vscode.ConfigurationTarget.Global); else return;
    }
    const op = await vscode.window.showQuickPick([100, 97, 95, 92, 90, 85, 80, 70].map((n) => ({ label: n + "%", description: Math.round(cur.opacity * 100) === n ? "сейчас" : "", n: n })), { placeHolder: "Непрозрачность окна" });
    if (!op) return;
    const mat = await vscode.window.showQuickPick([
        { label: "Без материала", v: "none" }, { label: "Акрил", v: "acrylic", description: "Windows 11: размытие того, что под окном" },
        { label: "Слюда (Mica)", v: "mica", description: "Windows 11: мягкий оттенок обоев" }, { label: "Слюда вкладок", v: "tabbed", description: "Windows 11" },
    ].map((x) => Object.assign(x, { description: (x.description || "") + (cur.material === x.v ? " — сейчас" : "") })), { placeHolder: "Материал фона окна (виден там, где интерфейс прозрачный, например с MoonLight BG)" });
    if (!mat) return;
    const top = await vscode.window.showQuickPick([{ label: "Обычное окно", v: false }, { label: "Поверх всех окон", v: true }], { placeHolder: "Поверх всех окон?" });
    if (!top) return;
    await c.update("window", { opacity: op.n / 100, material: mat.v, alwaysOnTop: top.v }, vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage("Moon Core: вид окна — " + op.label + ", " + mat.label + (top.v ? ", поверх всех" : ""), 5000);
}

module.exports = { writeMainConf, mainStatus, deepCommand, windowLookCommand };
