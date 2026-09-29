// ============================================================
//  Манифест модуля: права, ленивая загрузка и команды — чистая часть без vscode.
//
//    "capabilities": ["editor.read", "decorations", "layout"]
//        Что модуль может получить через шлюз к VS Code сверх базового:
//          editor.read  — путь файла, слово и выделение под курсором, тексты ошибок, подсказки
//                         языкового сервера (hover, определение, символы файла);
//          decorations  — подсветка строк и диапазонов в редакторе настоящим API VS Code;
//          layout       — показать/скрыть части окна (боковая панель, нижняя панель...).
//        Права одобряет человек (вместе с модулем); новые права в обновлении — отдельный вопрос.
//        Это ограничение ШЛЮЗА: код модуля в окне и так видит вёрстку, права делают явным, что
//        модуль берёт у VS Code, и не дают ему больше, чем он объявил.
//    "lazy": true | { "delay": 5000 }
//        Файл модуля не грузится при старте окна: только по его команде, по просьбе другого
//        модуля (__MOONCORE__.loadModule) или через delay мс после загрузки окна.
//    "commands": [{ "id": "open", "title": "Открыть окно", "langs": ["cpp"], "context": true }]
//        Команды модуля: в «Moon Core: Команды модулей» (палитра) и, если context, в контекстном
//        меню редактора (для langs — только в файлах этих языков). Клик приходит модулю событием
//        "command"; ленивый модуль сначала загружается.
// ============================================================
"use strict";

const CAPS = ["editor.read", "decorations", "layout"];
const CAP_TITLES = {
    "editor.read": "читать файл под курсором (слово, выделение, ошибки, подсказки)",
    "decorations": "подсвечивать код в редакторе",
    "layout": "показывать и скрывать части окна",
};
const CMD_ID_RE = /^[a-z][\w.-]{0,39}$/i;
const LANG_RE = /^[\w.+-]{1,40}$/;
const MAX_COMMANDS = 20;

const clip = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001F]/g, " ").trim().slice(0, n);

/** Права из манифеста: только известные, без повторов. */
function cleanCaps(v) {
    return Array.isArray(v) ? CAPS.filter((c) => v.indexOf(c) !== -1) : [];
}

/** Ленивая загрузка: null (грузить сразу) или { delay } (0 — только по требованию). */
function cleanLazy(v) {
    if (v === true) return { delay: 0 };
    if (v && typeof v === "object" && !Array.isArray(v)) {
        const d = typeof v.delay === "number" && isFinite(v.delay) ? Math.max(0, Math.min(600000, Math.round(v.delay))) : 0;
        return { delay: d };
    }
    return null;
}

/** Одна команда модуля или null. */
function cleanCommand(c) {
    if (!c || typeof c !== "object" || !CMD_ID_RE.test(String(c.id))) return null;
    const title = clip(c.title, 80);
    if (!title) return null;
    const langs = Array.isArray(c.langs) ? Array.from(new Set(c.langs.filter((l) => typeof l === "string" && LANG_RE.test(l)))).slice(0, 20) : [];
    return { id: String(c.id), title: title, langs: langs, context: c.context === true };
}
function cleanCommands(v) {
    const seen = new Set();
    return (Array.isArray(v) ? v : []).map(cleanCommand).filter((c) => c && !seen.has(c.id) && seen.add(c.id)).slice(0, MAX_COMMANDS);
}

/** Команда подходит к файлу языка lang (без langs — к любому, без файла — только без langs). */
function commandFits(cmd, lang) { return !cmd.langs.length || (!!lang && cmd.langs.indexOf(lang) !== -1); }

/** Права модуля, которые ещё не одобрены. */
function newCaps(want, approved) { return (want || []).filter((c) => (approved || []).indexOf(c) === -1); }

function capsText(caps) { return (caps || []).map((c) => CAP_TITLES[c] || c).join("; "); }

module.exports = { CAPS, CAP_TITLES, MAX_COMMANDS, cleanCaps, cleanLazy, cleanCommand, cleanCommands, commandFits, newCaps, capsText };
