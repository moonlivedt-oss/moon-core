// ============================================================
//  Галерея готовых стилей: небольшие CSS-сниппеты, которые включаются галочкой — для тех, кто
//  не пишет CSS сам. Каждый стиль — обычный файл gallery-<id>.css в папке сниппетов: его видно в
//  дереве «Сниппеты», можно открыть, поправить под себя или выключить.
//
//  Селекторы сверены с workbench.desktop.main.css VS Code 1.139; цвета берутся из переменных
//  темы, поэтому стили подходят к любой теме. Только CSS — никакого JS.
//  Модуль без vscode.
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { writeAtomic } = require("./fsx");

const PREFIX = "gallery-";
// Имя, под которым стиль показывается в окне до включения (рантайм: PREVIEW_ONLY).
const PREVIEW_ID = "gallery-preview.css";
const W = ".monaco-workbench ";

const STYLES = [
    { id: "focus-code", title: "Фокус на коде", note: "пока курсор в редакторе, боковые панели и статусбар приглушены",
        css: W + ".part.sidebar, " + W + ".part.auxiliarybar, " + W + ".part.panel, " + W + ".part.statusbar, " + W + ".part.activitybar { transition: opacity .25s ease; }\n" +
            ".monaco-workbench:has(.part.editor .monaco-editor.focused) .part.sidebar,\n.monaco-workbench:has(.part.editor .monaco-editor.focused) .part.auxiliarybar,\n" +
            ".monaco-workbench:has(.part.editor .monaco-editor.focused) .part.statusbar,\n.monaco-workbench:has(.part.editor .monaco-editor.focused) .part.activitybar { opacity: .5; }\n" +
            W + ".part.sidebar:hover, " + W + ".part.auxiliarybar:hover, " + W + ".part.statusbar:hover, " + W + ".part.activitybar:hover { opacity: 1 !important; }" },
    { id: "glass-widgets", title: "Стеклянные окна", note: "палитра команд, меню, подсказки — полупрозрачные с размытием",
        css: W + ".quick-input-widget, .monaco-menu, " + W + ".suggest-widget, " + W + ".monaco-hover, " + W + ".notification-toast {\n" +
            "  backdrop-filter: blur(12px) saturate(1.2);\n  background-color: color-mix(in srgb, var(--vscode-editorWidget-background) 76%, transparent) !important;\n}" },
    { id: "soft-shadows", title: "Мягкие тени", note: "глубокая мягкая тень у всплывающих окон",
        css: W + ".quick-input-widget, .monaco-menu, " + W + ".suggest-widget, " + W + ".monaco-hover, " + W + ".notification-toast, " + W + ".find-widget {\n" +
            "  box-shadow: 0 14px 44px rgba(0, 0, 0, .42), 0 2px 8px rgba(0, 0, 0, .25) !important;\n}" },
    { id: "bold-active-tab", title: "Заметная активная вкладка", note: "имя активной вкладки жирное, остальные приглушены",
        css: W + ".part.editor .tabs-container .tab.active .label-name { font-weight: 600; }\n" +
            W + ".part.editor .tabs-container .tab:not(.active) { opacity: .62; transition: opacity .15s ease; }\n" +
            W + ".part.editor .tabs-container .tab:not(.active):hover { opacity: 1; }" },
    { id: "quiet-actions", title: "Кнопки по наведению", note: "кнопки над редактором и в заголовках панелей видны только под мышью",
        css: W + ".part.editor .editor-actions, " + W + ".pane-header .actions { opacity: 0; transition: opacity .15s ease; }\n" +
            W + ".part.editor .title:hover .editor-actions, " + W + ".pane-header:hover .actions, " + W + ".pane-header:focus-within .actions { opacity: 1; }" },
    { id: "accent-line-number", title: "Номер текущей строки", note: "номер строки с курсором — цветом акцента и жирный",
        css: ".monaco-editor .line-numbers.active-line-number { color: var(--vscode-focusBorder) !important; font-weight: 600; }" },
    { id: "round-scrollbars", title: "Круглые полосы прокрутки", note: "ползунки прокрутки со скруглением, без тени у края",
        css: W + ".monaco-scrollable-element > .scrollbar > .slider { border-radius: 6px; }\n" + W + ".monaco-scrollable-element > .shadow { display: none; }" },
    { id: "quiet-breadcrumbs", title: "Тихие хлебные крошки", note: "путь над кодом бледный, под мышью — обычный",
        css: W + ".part.editor .monaco-breadcrumbs { opacity: .5; transition: opacity .15s ease; }\n" + W + ".part.editor .monaco-breadcrumbs:hover { opacity: 1; }" },
    { id: "quiet-statusbar", title: "Тихий статусбар", note: "статусбар бледный, пока на него не навели",
        css: W + ".part.statusbar { opacity: .6; transition: opacity .2s ease; }\n" + W + ".part.statusbar:hover { opacity: 1; }" },
    { id: "no-activity-badges", title: "Без счётчиков на иконках", note: "числа на иконках панели активности скрыты",
        css: W + ".part.activitybar .badge { display: none !important; }" },
    { id: "dirty-tab-accent", title: "Несохранённые вкладки", note: "имя несохранённого файла — курсивом и цветом предупреждения",
        css: W + ".part.editor .tabs-container .tab.dirty .label-name { font-style: italic; color: var(--vscode-editorWarning-foreground) !important; }" },
    { id: "airy-tabs", title: "Воздушные вкладки", note: "вкладки с отступами и скруглением, как плитки",
        css: W + ".part.editor .tabs-container .tab { margin: 4px 2px 0; border-radius: 7px 7px 0 0; border: none !important; }" },
    { id: "centered-tabs", title: "Вкладки по центру", note: "вкладки редактора собраны посередине",
        css: W + ".part.editor .tabs-container { justify-content: center; }" },
    { id: "tabs-no-icons", title: "Вкладки без значков", note: "только имена файлов, без иконок типа",
        css: W + ".part.editor .tabs-container .tab .monaco-icon-label::before { display: none !important; }" },
    { id: "plain-pane-headers", title: "Спокойные заголовки секций", note: "заголовки секций боковой панели — обычным регистром",
        css: W + ".pane-header h3.title { text-transform: none !important; font-weight: 600; letter-spacing: 0; }" },
];

const ids = () => STYLES.map((s) => s.id);
const fileId = (id) => PREFIX + id + ".css";

function content(s) {
    return "/* Moon Core, галерея: " + s.title + " — " + s.note + ".\n   Файл можно править под себя; выключается галочкой в дереве «Сниппеты» или в галерее. */\n" + s.css + "\n";
}

/** Какие стили галереи сейчас лежат в папке сниппетов: Set(id). */
function installed(dir) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return new Set(); }
    const known = new Set(ids());
    return new Set(names.filter((n) => n.indexOf(PREFIX) === 0 && /\.css$/.test(n)).map((n) => n.slice(PREFIX.length, -4)).filter((id) => known.has(id)));
}

/**
 * Привести папку сниппетов к выбору want (список id): недостающие файлы создать, снятые —
 * удалить. Уже лежащий файл не перезаписывается (в нём могут быть правки человека).
 * Возвращает { added: [id], removed: [id] }.
 */
function apply(dir, want) {
    const pick = new Set((Array.isArray(want) ? want : []).filter((id) => ids().indexOf(id) !== -1));
    const have = installed(dir);
    const added = [], removed = [];
    STYLES.forEach((s) => {
        const file = path.join(dir, fileId(s.id));
        if (pick.has(s.id) && !have.has(s.id)) { writeAtomic(file, content(s)); added.push(s.id); }
        else if (!pick.has(s.id) && have.has(s.id)) { try { fs.unlinkSync(file); removed.push(s.id); } catch (e) {} }
    });
    return { added: added, removed: removed };
}

module.exports = { STYLES, PREFIX, PREVIEW_ID, fileId, content, installed, apply };
