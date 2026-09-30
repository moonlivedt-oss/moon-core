// ============================================================
//  Подсказки в редакторе CSS-сниппета: классы и цвета темы прямо из файлов этой установки
//  VS Code (lib/vs-files.js cssNames). После точки — имена классов воркбенча, после «--» —
//  переменные темы (--vscode-...). Работает только в файлах папки сниппетов Moon Core.
// ============================================================
"use strict";

const vscode = require("vscode");
const VF = require("../vs-files");
const { log } = require("../log");

function createSnippetCompletion(context, host) {
    const names = () => {
        try { return VF.cssNames(vscode.env.appRoot) || { classes: [], vars: [] }; }
        catch (e) { log("подсказки классов VS Code", e); return { classes: [], vars: [] }; }
    };
    const provider = {
        provideCompletionItems(doc, pos) {
            if (!host.snippetIdOf(doc)) return undefined;
            const before = doc.lineAt(pos.line).text.slice(0, pos.character);
            const v = /--[\w-]*$/.exec(before);
            if (v) {
                const range = new vscode.Range(pos.line, pos.character - v[0].length, pos.line, pos.character);
                return names().vars.map((n) => {
                    const it = new vscode.CompletionItem(n, vscode.CompletionItemKind.Color);
                    it.range = range;
                    it.detail = "цвет темы VS Code";
                    return it;
                });
            }
            const c = /(^|[\s,>+~(:\w\])])\.([\w-]*)$/.exec(before);
            // Внутри объявления (после двоеточия без закрывающей скобки) точка — это число, а не класс.
            if (!c || /:[^{};]*$/.test(before.replace(/:(hover|focus|active|not|has|is|where|before|after|first-child|last-child|focus-within|focus-visible|nth-child)\b/g, ""))) return undefined;
            const range = new vscode.Range(pos.line, pos.character - c[2].length, pos.line, pos.character);
            return names().classes.map((n) => {
                const it = new vscode.CompletionItem(n, vscode.CompletionItemKind.Class);
                it.range = range;
                it.detail = "класс VS Code";
                return it;
            });
        },
    };
    context.subscriptions.push(vscode.languages.registerCompletionItemProvider({ scheme: "file", language: "css" }, provider, ".", "-"));
}

module.exports = { createSnippetCompletion };
