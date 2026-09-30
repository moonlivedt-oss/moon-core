// ============================================================
//  Страж конструктора: правки, после которых окном нельзя пользоваться, не принимаются.
//
//  «Скрыть» или нулевая прозрачность на корне окна (html, body, .monaco-workbench, сетка частей)
//  прячет весь VS Code — вместе с конструктором, которым это можно было бы вернуть. То же с
//  интерфейсом самого Moon Core (data-mooncore-ui). Такие правки отбрасываются везде, где
//  правила проверяются: из окна, из файла правок, из профиля, из загруженного пакета.
//  Модуль без зависимостей.
// ============================================================
"use strict";

// Последнее звено селектора, которое считается корнем окна (в нижнем регистре, без пробелов).
const ROOTS = new Set(["html", "body", ":root", "*", "div", ".monaco-workbench", ".monaco-grid-view", ".monaco-shell",
    ".split-view-view", ".split-view-container", ".monaco-split-view2", ".part", ".monaco-scrollable-element"]);
// Только «скрыть»: без редактора окно формально живо, но работать в нём нельзя.
const HIDE_ROOTS = new Set([".part.editor", ".editor-group-container", ".monaco-editor", ".editor-instance", ".overflow-guard"]);

/** Селектор без содержимого [..], (..) и кавычек — чтобы пробел внутри них не считался комбинатором. */
function bare(sel) {
    let out = "", depth = 0, quote = "";
    for (let i = 0; i < sel.length; i++) {
        const ch = sel[i];
        if (ch === "\\") { i++; continue; }
        if (quote) { if (ch === quote) quote = ""; continue; }
        if (ch === "\"" || ch === "'") { quote = ch; continue; }
        if (ch === "[" || ch === "(") { depth++; continue; }
        if (ch === "]" || ch === ")") { depth = Math.max(0, depth - 1); continue; }
        if (!depth) out += ch;
    }
    return out;
}

/** Последние звенья селектора (по одному на каждую часть через запятую), в нижнем регистре. */
function lastCompounds(sel) {
    return bare(String(sel || "")).split(",").map((part) => {
        const chain = part.trim().split(/[\s>+~]+/).filter(Boolean);
        const last = (chain[chain.length - 1] || "").toLowerCase();
        // Состояние (:hover, :focus-within, :not...) корень не меняет: «body:hover» — всё тот же body.
        return last === ":root" ? last : (last.replace(/::?[\w-]+/g, "") || "*");
    });
}

/** Значение свойства делает элемент невидимым или неуправляемым. */
function destructive(prop, value) {
    if (prop === "hide" || prop === "float") return value === true;
    if (prop === "opacity") return typeof value === "number" && value < 0.2;
    if (prop === "zoom") return typeof value === "number" && value < 50;
    if (prop === "width" || prop === "height") return typeof value === "number" && value < 60;
    if (prop === "grayscale" || prop === "blur") return false;
    return false;
}

/**
 * Почему правку нельзя принять ("" — можно). selector — уже проверенный cleanSelector,
 * value — уже проверенное cleanValue.
 */
function risky(selector, prop, value) {
    const sel = String(selector || "");
    if (/data-mooncore-ui/i.test(sel) && (prop === "hide" || destructive(prop, value))) return "интерфейс Moon Core скрыть нельзя";
    if (!destructive(prop, value)) return "";
    const last = lastCompounds(sel);
    if (last.some((c) => ROOTS.has(c))) return "это корень окна VS Code: такая правка спрятала бы весь интерфейс";
    if (prop === "hide" && last.some((c) => HIDE_ROOTS.has(c))) return "без области редактора в окне нельзя работать — скрой вкладки или панели по отдельности";
    return "";
}

module.exports = { risky, destructive, lastCompounds, ROOTS, HIDE_ROOTS };
