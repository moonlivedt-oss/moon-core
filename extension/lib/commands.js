// ============================================================
//  Команды VS Code из окна — решение «можно ли», без vscode (его гоняют тесты).
//
//  JS-сниппет может вызвать любую команду VS Code (mc.command), в том числе опасную: отправить
//  текст в терминал, открыть файл, поставить расширение. Поэтому каждая НОВАЯ команда требует
//  согласия: «Разрешить всегда» запоминается, «Запретить» — до конца сессии (не спрашиваем снова
//  на каждый вызов из цикла). Список заранее разрешённых можно задать в moonCore.allowedCommands.
// ============================================================
"use strict";

const CMD_RE = /^[\w.$-]{1,120}$/;

// Опасные команды: выполняют произвольный код или необратимо меняют файлы и систему (текст в
// терминал, новый терминал с любой оболочкой, установка расширений, git clean/push, удаление
// файлов, внутренние команды «_…»). Для них «Разрешить всегда» из диалога не запоминается и
// прежние «всегда» не действуют: каждый вызов — модальное подтверждение. Заранее разрешить можно
// только явно — настройкой moonCore.allowedCommands (она machine: проект её не задаст).
const DANGEROUS = [
    /^_/,
    /^workbench\.action\.terminal\.(sendSequence|runSelectedText|runActiveFile|runRecentCommand|new\w*|split\w*|createTerminalEditor\w*)$/i,
    /^workbench\.extensions\.(install|uninstall)/i,
    /^workbench\.extensions\.action\.(install|uninstall)/i,
    /^git\.(clean|push|commit|reset|stash|delete|rebase|merge|pull|checkout|revert|undoCommit|publish|sync)/i,
    /^(deleteFile|moveFileToTrash|renameFile|filesExplorer\.paste)$/i,
    /^vscode\.(open|openFolder|openWith|executeCommand)$/i,
    /^workbench\.action\.(openWorkspace|files\.openFolder|configureRuntimeArguments|url\.openUrl)$/i,
    /^moonCore\.(inject|remove|revokeAll|deep|syncImport|importBundle)$/i,
];
function isDangerous(id) { return typeof id === "string" && DANGEROUS.some((re) => re.test(id)); }

function validCommand(id) { return typeof id === "string" && CMD_RE.test(id); }

/** Список id из настройки/хранилища: только корректные строки, без дублей. */
function cleanList(v) {
    const arr = Array.isArray(v) ? v : (v && typeof v === "object" ? Object.keys(v).filter((k) => v[k] === true) : []);
    return Array.from(new Set(arr.filter(validCommand))).slice(0, 500);
}

/**
 * Решение по команде: "allow" | "ask" | "confirm" (опасная — спросить модально, без «всегда») | "deny".
 * state: { enabled (moonCore.allowCommands), setting (moonCore.allowedCommands), stored (разрешено «всегда»), denied (Set за сессию) }
 */
function decide(cmd, state) {
    const s = state || {};
    if (s.enabled === false) return "deny";
    if (!validCommand(cmd)) return "deny";
    if (s.denied && s.denied.has(cmd)) return "deny";
    if (cleanList(s.setting).indexOf(cmd) !== -1) return "allow";
    if (isDangerous(cmd)) return "confirm";
    if (cleanList(s.stored).indexOf(cmd) !== -1) return "allow";
    return "ask";
}

module.exports = { validCommand, cleanList, decide, isDangerous };
