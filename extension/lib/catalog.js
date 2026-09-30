// ============================================================
//  Каталог элементов интерфейса VS Code для конструктора.
//
//  У элемента: понятное имя, зона, устойчивый селектор (сверен с workbench.desktop.main.css
//  VS Code 1.121) и, где есть, настройки VS Code. Настройка надёжнее CSS: её не ломают
//  обновления, поэтому конструктор предлагает её первой.
//
//  vis — чем управляется видимость на карте интерфейса:
//    { key, on, off } — настройкой VS Code (надёжно), "css" — правилом «скрыть», нет — переключателя нет
//    (крупные зоны вроде боковой панели VS Code прячет сам, их CSS-скрытие ломает раскладку).
//  list: true — на карте показывается список элементов этого типа поштучно (пункты статусбара).
//  many: true — запись описывает ОДИН из многих однотипных элементов (вкладка, пункт статусбара).
//  Тогда клик выбирает конкретный элемент, а «все такие» — отдельной кнопкой.
//
//  Окно может менять ТОЛЬКО настройки из этого каталога и только допустимыми значениями
//  (validateSetting) — через мост нельзя подсунуть произвольную настройку.
//  Модуль без vscode.
// ============================================================
"use strict";

const ZONES = [
    { id: "window", label: "Окно" },
    { id: "titlebar", label: "Титлбар" },
    { id: "activitybar", label: "Панель активности" },
    { id: "sidebar", label: "Боковая панель" },
    { id: "editor", label: "Редактор" },
    { id: "panel", label: "Нижняя панель" },
    { id: "statusbar", label: "Статусбар" },
];

const bool = (key, label, extra) => Object.assign({ key: key, label: label, type: "bool" }, extra || {});
const en = (key, label, options, extra) => Object.assign({ key: key, label: label, type: "enum", options: options }, extra || {});
const num = (key, label, min, max, step, extra) => Object.assign({ key: key, label: label, type: "number", min: min, max: max, step: step }, extra || {});
// Шрифт: строка вида «Fira Code, Consolas, monospace» (проверяется validateSetting).
const font = (key, label, extra) => Object.assign({ key: key, label: label, type: "font" }, extra || {});

// Порядок важен: при клике выбирается запись с самым близким совпавшим предком.
const CATALOG = [
    // ---- окно
    { id: "zoom", zone: "window", label: "Масштаб окна", selector: "", settings: [num("window.zoomLevel", "Масштаб интерфейса", -3, 5, 0.5)] },
    { id: "banner", vis: "css", zone: "window", label: "Баннер", selector: ".part.banner", settings: [] },
    { id: "toasts", vis: "css", zone: "window", label: "Всплывающие уведомления", selector: ".notifications-toasts", settings: [] },
    { id: "notifyCenter", zone: "window", label: "Центр уведомлений", selector: ".notifications-center", settings: [] },
    { id: "quickInput", zone: "window", label: "Палитра команд и списки выбора", selector: ".quick-input-widget", settings: [] },
    { id: "menu", zone: "window", label: "Контекстное меню", selector: ".monaco-menu", settings: [] },
    { id: "sash", zone: "window", label: "Разделитель панелей", many: true, selector: ".monaco-sash", settings: [
        num("workbench.sash.size", "Ширина зоны захвата, px", 1, 20, 1),
        num("workbench.sash.hoverDelay", "Задержка подсветки, мс", 0, 2000, 50),
    ] },
    { id: "motion", zone: "window", label: "Анимации интерфейса", selector: "", settings: [
        en("workbench.reduceMotion", "Меньше анимаций", ["auto", "on", "off"]),
    ] },
    { id: "zen", zone: "window", label: "Режим «Дзен» (что он прячет)", selector: "", settings: [
        bool("zenMode.fullScreen", "На весь экран"),
        bool("zenMode.centerLayout", "Код по центру"),
        bool("zenMode.hideLineNumbers", "Прятать номера строк"),
    ] },

    // ---- титлбар
    { id: "titlebar", zone: "titlebar", label: "Титлбар", selector: ".part.titlebar", settings: [] },
    { id: "appIcon", vis: "css", zone: "titlebar", label: "Иконка приложения", selector: ".part.titlebar .window-appicon", settings: [] },
    { id: "menubar", vis: { key: "window.menuBarVisibility", on: "classic", off: "toggle" }, zone: "titlebar", label: "Меню", selector: ".part.titlebar .menubar", settings: [
        en("window.menuBarVisibility", "Показ меню", ["classic", "visible", "toggle", "hidden", "compact"], { hint: "toggle — меню по Alt" }),
    ] },
    { id: "commandCenter", vis: { key: "window.commandCenter", on: true, off: false }, zone: "titlebar", label: "Центр команд (поиск)", selector: ".part.titlebar .command-center", settings: [
        bool("window.commandCenter", "Показывать центр команд"),
        bool("workbench.navigationControl.enabled", "Стрелки назад / вперёд"),
    ] },
    { id: "layoutControls", vis: { key: "workbench.layoutControl.enabled", on: true, off: false }, zone: "titlebar", label: "Кнопки раскладки", selector: ".part.titlebar .titlebar-right .action-toolbar-container", settings: [
        bool("workbench.layoutControl.enabled", "Показывать кнопки раскладки"),
    ] },

    // ---- панель активности
    { id: "activitybar", vis: { key: "workbench.activityBar.location", on: "default", off: "hidden" }, zone: "activitybar", label: "Панель активности", selector: ".part.activitybar", settings: [
        en("workbench.activityBar.location", "Где показывать", ["default", "top", "bottom", "hidden"]),
        bool("workbench.activity.showAccounts", "Кнопка аккаунтов"),
    ] },
    { id: "activityIcons", list: true, zone: "activitybar", label: "Иконка панели активности", many: true, selector: ".part.activitybar .monaco-action-bar .action-label", settings: [] },

    // ---- боковая панель
    { id: "sidebar", zone: "sidebar", label: "Боковая панель", selector: ".part.sidebar", settings: [
        en("workbench.sideBar.location", "Сторона", ["left", "right"]),
    ] },
    { id: "sidebarTitle", vis: "css", zone: "sidebar", label: "Заголовок боковой панели", selector: ".part.sidebar > .composite.title", settings: [] },
    { id: "paneHeader", zone: "sidebar", label: "Заголовок секции", many: true, selector: ".part.sidebar .pane-header", settings: [] },
    { id: "openEditors", vis: { key: "explorer.openEditors.visible", on: 9, off: 0 }, zone: "sidebar", label: "Открытые редакторы", selector: ".part.sidebar .open-editors", settings: [
        num("explorer.openEditors.visible", "Строк (0 — скрыть секцию)", 0, 20, 1),
    ] },
    { id: "tree", zone: "sidebar", label: "Дерево", selector: ".part.sidebar .monaco-list", settings: [
        num("workbench.tree.indent", "Отступ уровня, px", 4, 40, 1),
        en("workbench.tree.renderIndentGuides", "Направляющие", ["none", "onHover", "always"]),
        bool("explorer.compactFolders", "Сжимать вложенные папки"),
        bool("workbench.tree.enableStickyScroll", "Липкие папки при прокрутке"),
    ] },
    { id: "explorer", zone: "sidebar", label: "Проводник", selector: ".explorer-folders-view", settings: [
        bool("explorer.decorations.colors", "Цвета состояния файлов (git, ошибки)"),
        bool("explorer.decorations.badges", "Значки состояния файлов"),
    ] },
    { id: "scm", zone: "sidebar", label: "Система контроля версий", selector: ".scm-view", settings: [] },
    { id: "search", zone: "sidebar", label: "Поиск", selector: ".search-view", settings: [] },
    { id: "extensions", zone: "sidebar", label: "Расширения", selector: ".extensions-viewlet", settings: [] },
    { id: "listRow", zone: "sidebar", label: "Выбранная строка списка", many: true, selector: ".monaco-list-row.selected", settings: [] },
    { id: "auxbar", zone: "sidebar", label: "Вторая боковая панель (чат)", selector: ".part.auxiliarybar", settings: [] },

    // ---- редактор
    { id: "tabs", vis: { key: "workbench.editor.showTabs", on: "multiple", off: "none" }, zone: "editor", label: "Полоса вкладок", selector: ".part.editor .tabs-container", settings: [
        en("workbench.editor.showTabs", "Вкладки", ["multiple", "single", "none"]),
        en("window.density.editorTabHeight", "Высота вкладок", ["default", "compact"]),
        bool("workbench.editor.wrapTabs", "Переносить вкладки в несколько рядов"),
    ] },
    { id: "tab", zone: "editor", label: "Вкладка", many: true, selector: ".part.editor .tabs-container .tab", settings: [
        en("workbench.editor.tabSizing", "Ширина вкладок", ["fit", "shrink", "fixed"]),
        bool("workbench.editor.tabActionCloseVisibility", "Крестик закрытия"),
    ] },
    { id: "tabActive", zone: "editor", label: "Активная вкладка", many: true, selector: ".part.editor .tabs-container .tab.active", settings: [
        bool("workbench.editor.highlightModifiedTabs", "Полоса у несохранённых вкладок"),
    ] },
    { id: "editorActions", vis: { key: "workbench.editor.editorActionsLocation", on: "default", off: "hidden" }, zone: "editor", label: "Кнопки над редактором", selector: ".part.editor .editor-group-container > .title .editor-actions", settings: [
        en("workbench.editor.editorActionsLocation", "Где показывать", ["default", "titleBar", "hidden"]),
    ] },
    { id: "breadcrumbs", vis: { key: "breadcrumbs.enabled", on: true, off: false }, zone: "editor", label: "Хлебные крошки", selector: ".part.editor .breadcrumbs-control", settings: [
        bool("breadcrumbs.enabled", "Показывать"),
    ] },
    { id: "watermark", vis: "css", zone: "editor", label: "Фон пустого редактора", selector: ".part.editor .editor-group-watermark", settings: [] },
    { id: "minimap", vis: { key: "editor.minimap.enabled", on: true, off: false }, zone: "editor", label: "Миникарта", selector: ".monaco-editor .minimap", settings: [
        bool("editor.minimap.enabled", "Показывать"),
        bool("editor.minimap.renderCharacters", "Рисовать символы"),
        num("editor.minimap.maxColumn", "Ширина, символов", 20, 200, 10),
    ] },
    { id: "stickyScroll", vis: { key: "editor.stickyScroll.enabled", on: true, off: false }, zone: "editor", label: "Липкие заголовки", selector: ".monaco-editor .sticky-widget", settings: [
        bool("editor.stickyScroll.enabled", "Показывать"),
    ] },
    { id: "lineNumbers", vis: { key: "editor.lineNumbers", on: "on", off: "off" }, zone: "editor", label: "Номера строк", selector: ".monaco-editor .margin .line-numbers", settings: [
        en("editor.lineNumbers", "Номера строк", ["on", "off", "relative", "interval"]),
    ] },
    { id: "gutter", zone: "editor", label: "Поле слева от кода", selector: ".monaco-editor .margin", settings: [
        bool("editor.glyphMargin", "Поле значков (точки останова)"),
        bool("editor.folding", "Сворачивание блоков"),
    ] },
    { id: "code", zone: "editor", label: "Текст кода", selector: ".monaco-editor .view-lines", settings: [
        num("editor.fontSize", "Размер шрифта", 8, 40, 1),
        num("editor.lineHeight", "Высота строки (0 — авто)", 0, 60, 1),
        num("editor.letterSpacing", "Межбуквенный интервал", -2, 5, 0.1),
        en("editor.cursorSmoothCaretAnimation", "Плавный курсор", ["off", "explicit", "on"]),
        en("editor.cursorBlinking", "Мигание курсора", ["blink", "smooth", "phase", "expand", "solid"]),
        en("editor.cursorStyle", "Форма курсора", ["line", "block", "underline", "line-thin", "block-outline", "underline-thin"]),
        bool("editor.smoothScrolling", "Плавная прокрутка кода"),
        bool("editor.fontLigatures", "Лигатуры шрифта"),
        bool("workbench.list.smoothScrolling", "Плавная прокрутка списков"),
        font("editor.fontFamily", "Шрифт кода", { hint: "несколько через запятую: берётся первый установленный" }),
    ] },
    { id: "lineHighlight", zone: "editor", label: "Текущая строка", selector: ".monaco-editor .view-overlays .current-line", settings: [
        en("editor.renderLineHighlight", "Подсветка текущей строки", ["none", "gutter", "line", "all"]),
        en("editor.renderWhitespace", "Показывать пробелы", ["none", "boundary", "selection", "trailing", "all"]),
        bool("editor.guides.indentation", "Линии отступов"),
        bool("editor.bracketPairColorization.enabled", "Цветные скобки"),
        bool("editor.codeLens", "Строки CodeLens над кодом"),
    ] },
    { id: "suggest", zone: "editor", label: "Список подсказок", selector: ".monaco-editor .suggest-widget", settings: [
        num("editor.suggestFontSize", "Размер шрифта (0 — как в коде)", 0, 30, 1),
        num("editor.suggestLineHeight", "Высота строки (0 — авто)", 0, 40, 1),
    ] },
    { id: "hover", zone: "editor", label: "Всплывающая подсказка", selector: ".monaco-hover", settings: [
        num("editor.hover.delay", "Задержка появления, мс", 0, 2000, 50),
    ] },
    { id: "findWidget", zone: "editor", label: "Окно поиска в файле", selector: ".monaco-editor .find-widget", settings: [] },
    { id: "scrollbar", zone: "editor", label: "Полоса прокрутки", selector: ".monaco-editor .scrollbar", settings: [
        num("editor.scrollbar.verticalScrollbarSize", "Толщина вертикальной", 4, 30, 1),
        num("editor.scrollbar.horizontalScrollbarSize", "Толщина горизонтальной", 4, 30, 1),
    ] },

    // ---- нижняя панель
    { id: "panel", zone: "panel", label: "Нижняя панель", selector: ".part.panel", settings: [] },
    { id: "panelTitle", vis: "css", zone: "panel", label: "Заголовок панели", selector: ".part.panel > .title", settings: [] },
    { id: "terminal", zone: "panel", label: "Терминал", selector: ".part.panel .terminal-wrapper", settings: [
        num("terminal.integrated.fontSize", "Размер шрифта", 6, 40, 1),
        num("terminal.integrated.lineHeight", "Высота строки", 1, 2, 0.1),
        font("terminal.integrated.fontFamily", "Шрифт терминала"),
        en("terminal.integrated.cursorStyle", "Форма курсора", ["block", "line", "underline"]),
        bool("terminal.integrated.cursorBlinking", "Мигание курсора"),
    ] },
    { id: "debugToolbar", vis: { key: "debug.toolBarLocation", on: "floating", off: "hidden" }, zone: "panel", label: "Панель отладки", selector: ".debug-toolbar", settings: [
        en("debug.toolBarLocation", "Где показывать", ["floating", "docked", "commandCenter", "hidden"]),
    ] },

    // ---- статусбар
    { id: "statusbar", vis: { key: "workbench.statusBar.visible", on: true, off: false }, zone: "statusbar", label: "Статусбар", selector: ".part.statusbar", settings: [
        bool("workbench.statusBar.visible", "Показывать"),
    ] },
    { id: "statusItem", list: true, zone: "statusbar", label: "Пункт статусбара", many: true, selector: ".part.statusbar .statusbar-item", settings: [] },
];

// Встроенные профили вида (только чтение; можно применить и сохранить копию под своим именем).
const PRESETS = {
    "Минимал": {
        note: "Убраны второстепенные кнопки и панели, код и файлы на месте",
        settings: {
            "window.commandCenter": false,
            "workbench.layoutControl.enabled": false,
            "workbench.activity.showAccounts": false,
            "editor.minimap.enabled": false,
            "breadcrumbs.enabled": false,
            "editor.stickyScroll.enabled": false,
            "explorer.openEditors.visible": 0,
            "window.density.editorTabHeight": "compact",
        },
        rules: { ".part.editor .editor-group-watermark": { label: "Фон пустого редактора", props: { hide: true } } },
    },
    "Только код": {
        note: "Минимал + без панели активности, статусбара и полей слева",
        settings: {
            "window.commandCenter": false,
            "workbench.layoutControl.enabled": false,
            "workbench.activity.showAccounts": false,
            "editor.minimap.enabled": false,
            "breadcrumbs.enabled": false,
            "editor.stickyScroll.enabled": false,
            "explorer.openEditors.visible": 0,
            "window.density.editorTabHeight": "compact",
            "workbench.activityBar.location": "hidden",
            "workbench.statusBar.visible": false,
            "editor.glyphMargin": false,
            "editor.folding": false,
        },
        rules: { ".part.editor .editor-group-watermark": { label: "Фон пустого редактора", props: { hide: true } } },
    },
    "Дзен": {
        note: "Только код: без панелей и статусбара, вкладка одна, плавный курсор",
        settings: {
            "window.commandCenter": false,
            "workbench.layoutControl.enabled": false,
            "workbench.activityBar.location": "hidden",
            "workbench.statusBar.visible": false,
            "workbench.editor.showTabs": "single",
            "editor.minimap.enabled": false,
            "breadcrumbs.enabled": false,
            "editor.stickyScroll.enabled": false,
            "editor.glyphMargin": false,
            "editor.renderLineHighlight": "none",
            "editor.cursorSmoothCaretAnimation": "on",
            "editor.smoothScrolling": true,
        },
        rules: { ".part.editor .editor-group-watermark": { label: "Фон пустого редактора", props: { hide: true } } },
    },
    "Презентация": {
        note: "Для показа экрана: крупный код и интерфейс, ничего лишнего",
        settings: {
            "window.zoomLevel": 1.5, "editor.fontSize": 20, "terminal.integrated.fontSize": 18,
            "editor.minimap.enabled": false, "explorer.openEditors.visible": 0, "workbench.activity.showAccounts": false,
            "editor.renderWhitespace": "none", "editor.codeLens": false,
        },
        rules: {},
    },
    "Компактный": {
        note: "Больше кода на экране: низкие вкладки, узкие отступы, панель активности сверху",
        settings: {
            "window.density.editorTabHeight": "compact", "workbench.activityBar.location": "top", "window.commandCenter": false,
            "workbench.tree.indent": 8, "editor.scrollbar.verticalScrollbarSize": 8, "editor.scrollbar.horizontalScrollbarSize": 8,
            "breadcrumbs.enabled": false,
        },
        rules: {},
    },
    "Крупный": {
        note: "Всё крупнее: для большого экрана или чтобы глаза отдыхали",
        settings: { "window.zoomLevel": 1, "editor.fontSize": 16, "terminal.integrated.fontSize": 15 },
        rules: {},
    },
};

const FONT_RE = /^[A-Za-z0-9 _,'".-]{1,160}$/;
const SETTINGS = {};
CATALOG.forEach((e) => e.settings.forEach((s) => { SETTINGS[s.key] = s; }));

/** Проверить значение настройки по каталогу. Вернёт нормализованное значение или undefined. */
function validateSetting(key, value) {
    const s = Object.prototype.hasOwnProperty.call(SETTINGS, key) ? SETTINGS[key] : null;
    if (!s) return undefined;
    if (s.type === "bool") return typeof value === "boolean" ? value : undefined;
    if (s.type === "enum") return s.options.indexOf(value) !== -1 ? value : undefined;
    if (s.type === "font") {
        const v = typeof value === "string" ? value.trim() : "";
        // Только имена шрифтов: без скобок, точек с запятой и url() — значение попадает в CSS VS Code.
        if (!v || !FONT_RE.test(v) || v.split("'").length % 2 === 0 || v.split("\"").length % 2 === 0) return undefined;
        return v;
    }
    if (s.type === "number") {
        if (typeof value !== "number" || !isFinite(value)) return undefined;
        if (value < s.min || value > s.max) return undefined;
        return Math.round(value * 100) / 100;
    }
    return undefined;
}

module.exports = { ZONES, CATALOG, SETTINGS, PRESETS, validateSetting };
