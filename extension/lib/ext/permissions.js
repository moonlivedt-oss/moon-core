// ============================================================
//  Команды «Разрешения» и «Отозвать все разрешения».
//
//  «Разрешения» — журнал решений (lib/audit.js): какие команды, JS-сниппеты, модули, профили
//  проектов и чужие вставки в оболочке разрешены или запрещены и когда. «Отозвать все» сбрасывает
//  сами разрешения (lib/keys.js GRANTS): дальше Moon Core спросит заново о каждом.
// ============================================================
"use strict";

const vscode = require("vscode");
const AU = require("../audit");
const CMD = require("../commands");
const KEYS = require("../keys");
const { log } = require("../log");

/** Коротко о том, что разрешено сейчас (для заголовка списка). */
function summary(context) {
    const gs = context.globalState;
    const count = (k) => { const v = gs.get(k); return Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0; };
    return "команд «всегда»: " + CMD.cleanList(gs.get(KEYS.ALLOWED_COMMANDS)).length + ", модулей: " + count(KEYS.MODULES_ALLOWED) +
        ", JS-сниппетов: " + count(KEYS.JS_APPROVED) + ", проектов: " + count(KEYS.PROJECT_PROFILES);
}

async function revokeAll(context, host) {
    const pick = await vscode.window.showWarningMessage(
        "Отозвать все разрешения Moon Core? Команды из окна, JS-сниппеты, модули, профили проектов и доверие к чужим вставкам в оболочке " +
        "снова потребуют согласия. Свои модули (того же издателя) разрешатся сами.", { modal: true }, "Отозвать");
    if (pick !== "Отозвать") return false;
    const n = await AU.revokeAll(context.globalState);
    if (host && host.deniedCommands) host.deniedCommands.clear();
    log("разрешения отозваны: " + n + " групп");
    if (host) host.rebuild();                      // JS-сниппеты без одобрения сразу перестают работать
    const r = await vscode.window.showInformationMessage("Moon Core: разрешения отозваны. Модули уйдут из окна после перевнедрения и перезагрузки.", "Перевнедрить");
    if (r) await vscode.commands.executeCommand("moonCore.inject");
    return true;
}

async function showPermissions(context, host) {
    const lines = AU.lines(context.globalState);
    const items = [{ label: "$(shield) Отозвать все разрешения", description: summary(context), action: "revoke" }]
        .concat(lines.length ? lines.map((l) => ({ label: l })) : [{ label: "Журнал пуст: ещё ничего не разрешали и не запрещали" }]);
    const pick = await vscode.window.showQuickPick(items, { placeHolder: "Разрешения Moon Core — последние решения сверху", matchOnDescription: true });
    if (pick && pick.action === "revoke") await revokeAll(context, host);
}

module.exports = { showPermissions, revokeAll, summary };
