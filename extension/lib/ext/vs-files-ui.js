// ============================================================
//  Файлы VS Code в интерфейсе расширения:
//    - сводка целостности для Доктора (lib/vs-files.js), с коротким кэшем — она хэширует
//      десятки мегабайт, а страница Доктора обновляется раз в 5 секунд;
//    - команда «Стили внутри webview»: сниппет webview.css и настройка moonCore.webviewStyles;
//    - обновление основы webview, когда сниппет webview*.css изменился.
// ============================================================
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const VF = require("../vs-files");
const inject = require("../inject");
const { log } = require("../log");

const TTL_MS = 30000;
let cache = { at: 0, value: null };

/** Сводка целостности установки VS Code (или null, если каталог установки неизвестен). */
function filesSummary(force) {
    const app = vscode.env && vscode.env.appRoot;
    if (!app) return null;
    if (!force && cache.value && Date.now() - cache.at < TTL_MS) return cache.value;
    try { cache = { at: Date.now(), value: VF.integritySummary(app) }; } catch (e) { log("целостность файлов VS Code", e); cache = { at: Date.now(), value: null }; }
    return cache.value;
}
function resetFilesSummary() { cache = { at: 0, value: null }; }

const WEBVIEW_TEMPLATE = [
    "/* Стили внутри webview VS Code: страницы расширений, превью Markdown, страницы настроек",
    "   расширений. Файл webview*.css применяется не к окну, а внутри таких страниц.",
    "   После сохранения Moon Core обновляет основу webview; уже открытые вкладки нужно",
    "   переоткрыть. Нельзя: обратную кавычку, обратный слэш и сочетание доллар-фигурная скобка. */",
    "",
    "/* Пример: скруглённые полосы прокрутки */",
    "::-webkit-scrollbar-thumb { border-radius: 6px; }",
    "",
].join("\n");

/** Команда «Стили внутри webview». */
async function webviewStylesCommand(context, host) {
    const conf = vscode.workspace.getConfiguration("moonCore");
    const sum = filesSummary(true);
    if (sum && sum.webview === "foreign") {
        vscode.window.showWarningMessage("Moon Core: файл-основа webview в этой установке VS Code уже изменён другой программой (обычно это Custom UI Style): " +
            "его хэш не сходится. Moon Core такой файл не трогает — иначе страницы расширений могут перестать открываться. Подробности — в Докторе.", "Доктор")
            .then((p) => { if (p) vscode.commands.executeCommand("moonCore.doctor"); });
        return false;
    }
    const file = path.join(host.dir, "webview.css");
    if (conf.get("webviewStyles", false) !== true) {
        const ok = await vscode.window.showInformationMessage("Включить стили внутри webview?", {
            modal: true,
            detail: "CSS из сниппетов с именем webview*.css будет дописываться в файл VS Code, из которого собираются все webview " +
                "(страницы расширений, превью Markdown). Бэкап файла кладётся рядом, «Убрать из VS Code» возвращает его байт в байт, " +
                "в контрольные суммы VS Code этот файл не входит.",
        }, "Включить");
        if (ok !== "Включить") return false;
        if (!fs.existsSync(file)) fs.writeFileSync(file, WEBVIEW_TEMPLATE, "utf8");
        host.rebuild();
        await conf.update("webviewStyles", true, vscode.ConfigurationTarget.Global);    // смена настройки сама перезапишет оболочку
    } else if (!fs.existsSync(file)) { fs.writeFileSync(file, WEBVIEW_TEMPLATE, "utf8"); host.rebuild(); }
    await host.open("webview.css");
    return true;
}

/** Сниппет webview*.css изменился — обновить основу webview (без вопросов: окно перезагружать не нужно). */
function watchWebviewCss(context, host) {
    host.onWebviewCss = async () => {
        if (vscode.workspace.getConfiguration("moonCore").get("webviewStyles", false) !== true) return;
        if (!inject.status(context).some((s) => s.injected)) return;
        const r = await inject.injectShared(context);
        resetFilesSummary();
        log("стили webview обновлены: " + JSON.stringify({ ok: r.ok, reason: r.reason || null }));
        if (r.ok) vscode.window.setStatusBarMessage("Moon Core: стили webview обновлены — переоткрой вкладки с webview", 6000);
        else vscode.window.showWarningMessage("Moon Core: стили webview не записаны (" + (r.error || r.reason || "нет прав") + "). Команда «Внедрить в VS Code» попросит права.");
    };
}

module.exports = { filesSummary, resetFilesSummary, webviewStylesCommand, watchWebviewCss, WEBVIEW_TEMPLATE };
