// ============================================================
//  VS Code для модулей — чистая часть без vscode: виды событий, проверка стилей подсветки и
//  диапазонов, карта частей окна, разбор подсказок языкового сервера.
//  Часть с vscode — lib/host-vs.js.
// ============================================================
"use strict";

/**
 * События VS Code, на которые модуль подписывается в окне (mc.vscode.on). cap — право, без
 * которого модуль получает только базовую часть события (full-поля ему не приходят).
 */
const KINDS = {
    editor:      { cap: "",            title: "активный файл: имя, язык, изменён ли" },
    cursor:      { cap: "editor.read", title: "курсор: строка, столбец, слово, выделение" },
    save:        { cap: "",            title: "файл сохранён" },
    diagnostics: { cap: "",            title: "ошибки и предупреждения в активном файле (тексты — с editor.read)" },
    debug:       { cap: "",            title: "отладка: запущена, остановлена" },
    terminal:    { cap: "",            title: "терминалы: сколько открыто, какой активен" },
    task:        { cap: "",            title: "задачи: какие идут" },
    git:         { cap: "",            title: "git: ветка и число изменений" },
    theme:       { cap: "",            title: "тема: вид и имя" },
};
const KIND_LIST = Object.keys(KINDS);
const SUB_TTL_MS = 150000;             // подписка живёт, пока окно её подтверждает (раз в минуту)
const MAX_SELECTION = 2000;            // символов выделения в событии cursor
const MAX_HOVER = 8000;

function cleanKinds(v) { return Array.isArray(v) ? KIND_LIST.filter((k) => v.indexOf(k) !== -1) : []; }

// ------------------------------------------------------------------ подсветка кода
const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
const ENUMS = {
    fontWeight: ["normal", "bold", "300", "400", "500", "600", "700"],
    fontStyle: ["normal", "italic"],
    textDecoration: ["none", "underline", "line-through", "underline dotted", "underline wavy", "underline dashed"],
    borderStyle: ["solid", "dashed", "dotted"],
    rulerLane: ["left", "center", "right", "full"],
};
const MAX_DECO_TYPES = 32;             // типов подсветки на модуль
const MAX_RANGES = 2000;

const color = (v) => (typeof v === "string" && HEX_RE.test(v) ? v : undefined);
const text = (v, n) => (typeof v === "string" ? v.replace(/[\u0000-\u001F]/g, " ").slice(0, n) : undefined);

/**
 * Стиль подсветки из окна -> опции createTextEditorDecorationType. Только цвета #hex, числа в
 * пределах и значения из списков: в CSS редактора не попадёт ничего чужого.
 */
function cleanStyle(s) {
    const o = s && typeof s === "object" ? s : {};
    const out = {};
    ["backgroundColor", "color", "borderColor", "outlineColor"].forEach((k) => { const c = color(o[k]); if (c) out[k] = c; });
    if (typeof o.borderWidth === "number" && o.borderWidth >= 0 && o.borderWidth <= 4) out.borderWidth = Math.round(o.borderWidth) + "px";
    if (out.borderColor || out.borderWidth) out.borderStyle = ENUMS.borderStyle.indexOf(o.borderStyle) !== -1 ? o.borderStyle : "solid";
    if (typeof o.borderRadius === "number" && o.borderRadius >= 0 && o.borderRadius <= 12) out.borderRadius = Math.round(o.borderRadius) + "px";
    ["fontWeight", "fontStyle", "textDecoration"].forEach((k) => { if (ENUMS[k].indexOf(o[k]) !== -1) out[k] = o[k]; });
    if (typeof o.opacity === "number" && o.opacity >= 0.1 && o.opacity <= 1) out.opacity = String(Math.round(o.opacity * 100) / 100);
    if (o.isWholeLine === true) out.isWholeLine = true;
    const ruler = color(o.overviewRulerColor);
    if (ruler) { out.overviewRulerColor = ruler; out.overviewRulerLane = ENUMS.rulerLane.indexOf(o.overviewRulerLane) !== -1 ? o.overviewRulerLane : "right"; }
    // Надпись после текста (как inlay hint): только текст и цвет.
    if (o.after && typeof o.after === "object") {
        const t = text(o.after.contentText, 100);
        if (t) out.after = { contentText: t, color: color(o.after.color), fontStyle: ENUMS.fontStyle.indexOf(o.after.fontStyle) !== -1 ? o.after.fontStyle : undefined, margin: "0 0 0 1em" };
    }
    return out;
}

/** Диапазоны: [{ line, start?, end?, hover? }] (строки и столбцы с 0). Лишнее и кривое — отброшено. */
function cleanRanges(list) {
    const int = (v, max) => (typeof v === "number" && isFinite(v) && v >= 0 && v <= max ? Math.floor(v) : null);
    const out = [];
    (Array.isArray(list) ? list : []).slice(0, MAX_RANGES).forEach((r) => {
        if (!r || typeof r !== "object") return;
        const line = int(r.line, 10000000);
        if (line == null) return;
        const start = int(r.start, 100000), end = int(r.end, 100000);
        const rec = { line: line, start: start == null ? 0 : start, end: end == null ? null : end };
        if (rec.end != null && rec.end < rec.start) rec.end = rec.start;
        const h = text(r.hover, 500);
        if (h) rec.hover = h;
        out.push(rec);
    });
    return out;
}

// ------------------------------------------------------------------ части окна
/** Часть окна -> команда VS Code, которая её переключает (публичные, стабильные между версиями). */
const LAYOUT = {
    sidebar: "workbench.action.toggleSidebarVisibility",
    panel: "workbench.action.togglePanel",
    auxiliarybar: "workbench.action.toggleAuxiliaryBar",
    activitybar: "workbench.action.toggleActivityBarVisibility",
    statusbar: "workbench.action.toggleStatusbarVisibility",
    minimap: "editor.action.toggleMinimap",
    zen: "workbench.action.toggleZenMode",
    maximizedPanel: "workbench.action.toggleMaximizedPanel",
};

/** Короткое имя удалённого репозитория «владелец/репо» (origin или первый), без адреса и логина. */
function remoteShort(remotes) {
    const list = Array.isArray(remotes) ? remotes : [];
    const r = list.filter((x) => x && x.name === "origin")[0] || list[0];
    const url = r && (r.fetchUrl || r.pushUrl);
    if (!url) return "";
    const m = String(url).replace(/\.git$/, "").match(/[/:]([^/:@]+\/[^/:@]+)$/);
    return m ? m[1].slice(0, 120) : "";
}

// ------------------------------------------------------------------ подсказки языкового сервера
/** Содержимое hover (MarkdownString | MarkedString | string | {value}) -> простой текст. */
function hoverText(hovers) {
    const parts = [];
    (Array.isArray(hovers) ? hovers : []).forEach((h) => {
        (h && Array.isArray(h.contents) ? h.contents : []).forEach((c) => {
            const v = typeof c === "string" ? c : c && typeof c.value === "string" ? c.value : "";
            if (v.trim()) parts.push(v.trim());
        });
    });
    return parts.join("\n\n").slice(0, MAX_HOVER);
}

/** Символы файла (DocumentSymbol с детьми или SymbolInformation) -> плоский список. */
function flatSymbols(list, depth, out) {
    const res = out || [];
    const d = depth || 0;
    (Array.isArray(list) ? list : []).forEach((s) => {
        if (!s || res.length >= 500 || d > 8) return;
        const range = s.range || (s.location && s.location.range);
        res.push({ name: String(s.name || "").slice(0, 200), kind: typeof s.kind === "number" ? s.kind : -1, detail: String(s.detail || s.containerName || "").slice(0, 200), line: range && range.start ? range.start.line : -1, depth: d });
        if (Array.isArray(s.children)) flatSymbols(s.children, d + 1, res);
    });
    return res;
}

module.exports = { KINDS, KIND_LIST, SUB_TTL_MS, MAX_SELECTION, MAX_DECO_TYPES, cleanKinds, cleanStyle, cleanRanges, LAYOUT, hoverText, flatSymbols, remoteShort };
