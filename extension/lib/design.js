// ============================================================
//  Конструктор: модель изменений интерфейса.
//
//  mooncore-design.json:
//    rules:    { "<селектор>": { label, props: { fontSize: 12, hide: true, ... }, ts, fp? } }
//    settings: { "<ключ настройки>": { value, prev, hadPrev, label, ts } }
//
//  fp — отпечаток элемента, по которому правило создано (запасные селекторы, aria-label, классы,
//  запись каталога). Если после обновления VS Code селектор перестал что-либо находить, окно
//  ищет элемент по отпечатку и предлагает замену (операция renameRule).
//
//  Каждое свойство и каждая настройка — отдельный пункт в списке изменений, который можно
//  отменить. CSS собирается из rules (значения строго проверены — в CSS не попадёт чужой код).
//  Настройки VS Code меняет хост (lib/host.js), здесь только учёт «было / стало».
//  Модуль без vscode.
// ============================================================
"use strict";

const fs = require("fs");
const { writeAtomic } = require("./storage");
const { validateSetting, SETTINGS } = require("./catalog");

// Свойства, которые конструктор умеет менять. Этот же список (без регэкспов) уходит в окно.
const PROPS = {
    hide:       { css: "display", type: "flag", value: "none", label: "Скрыть", group: "view" },
    opacity:    { css: "opacity", type: "number", min: 0, max: 1, step: 0.05, label: "Прозрачность", group: "view" },
    zoom:       { css: "zoom", type: "number", unit: "%", min: 30, max: 300, step: 5, label: "Масштаб", group: "size" },
    fontSize:   { css: "font-size", type: "number", unit: "px", min: 6, max: 48, step: 1, label: "Размер шрифта", group: "text" },
    fontWeight: { css: "font-weight", type: "enum", options: ["300", "400", "500", "600", "700"], label: "Жирность", group: "text" },
    fontFamily: { css: "font-family", type: "text", label: "Шрифт", group: "text" },
    color:      { css: "color", type: "color", label: "Цвет текста", group: "text" },
    background: { css: "background-color", type: "color", label: "Фон", group: "view" },
    radius:     { css: "border-radius", type: "number", unit: "px", min: 0, max: 40, step: 1, label: "Скругление", group: "view" },
    padding:    { css: "padding", type: "number", unit: "px", min: 0, max: 40, step: 1, label: "Внутренний отступ", group: "size" },
    width:      { css: "width", type: "number", unit: "px", min: 0, max: 2000, step: 1, label: "Ширина", group: "risky" },
    height:     { css: "height", type: "number", unit: "px", min: 0, max: 2000, step: 1, label: "Высота", group: "risky" },
    // Плавающий элемент: откреплён от раскладки и лежит поверх окна там, куда его поставили.
    float:      { css: "position", type: "flag", value: "fixed", label: "Плавающее окно", group: "float",
                  extra: "z-index: 40 !important; box-shadow: 0 12px 40px rgba(0,0,0,.45) !important; border-radius: 8px !important; overflow: auto !important" },
    floatX:     { css: "left", type: "number", unit: "px", min: 0, max: 8000, step: 1, label: "Слева", group: "float" },
    floatY:     { css: "top", type: "number", unit: "px", min: 0, max: 8000, step: 1, label: "Сверху", group: "float" },
    floatW:     { css: "width", type: "number", unit: "px", min: 40, max: 8000, step: 1, label: "Ширина окна", group: "float" },
    floatH:     { css: "height", type: "number", unit: "px", min: 30, max: 8000, step: 1, label: "Высота окна", group: "float" },
    // Порядок среди соседей (flex): ставится перетаскиванием в конструкторе, отдельной строкой не показывается.
    order:      { css: "order", type: "number", min: -99, max: 99, step: 1, label: "Порядок", group: "layout" },
};

const COLOR_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const FONT_RE = /^[\w\s,'".-]{1,120}$/;
const MAX_RULES = 500;
const SELECTOR_MAX = 600;

function emptyDesign() { return { v: 1, rules: {}, settings: {}, colors: {}, buttons: [], fx: {} }; }

// ---------------------------------------------------------------------------
//  Кроме CSS-правил и настроек из каталога, вид — это ещё:
//    colors  — цвета темы: { "wb:<id цвета>" | "tk:<группа кода>": { value, prev, hadPrev, label, ts } }.
//              Пишутся в штатные workbench.colorCustomizations / editor.tokenColorCustomizations,
//              поэтому переживают обновления VS Code; prev — что было до Moon Core (для отмены).
//    buttons — свои кнопки с командами VS Code: [{ id, zone, command, args, icon, label, tooltip, order }].
//    fx      — эффекты редактора (след курсора, искры при наборе, свечение строки).
// ---------------------------------------------------------------------------
const COLOR_ID_RE = /^[A-Za-z][\w.-]{0,80}$/;
const TOKEN_GROUPS = ["comments", "strings", "keywords", "numbers", "types", "functions", "variables"];
const COLOR_CONF = { wb: "workbench.colorCustomizations", tk: "editor.tokenColorCustomizations" };
const BUTTON_ZONES = ["statusbar-left", "statusbar-right", "titlebar", "editor"];
const BUTTON_ID_RE = /^b[0-9a-z]{3,15}$/;
const EXT_BUTTON_ID_RE = /^x[0-9a-z]{3,15}$/;   // кнопки других расширений (API ui.button)
const COMMAND_RE = /^[A-Za-z][\w.-]{0,127}$/;
const ICON_RE = /^[a-z0-9-]{1,40}$/;
const MAX_BUTTONS = 40;
const FX_SPEC = {
    cursorTrail:     { type: "bool", label: "След за курсором" },
    typingParticles: { type: "bool", label: "Искры при наборе" },
    lineGlow:        { type: "bool", label: "Свечение текущей строки" },
    cursorGlow:      { type: "bool", label: "Свечение курсора" },
    color:           { type: "color", label: "Цвет эффектов" },
    intensity:       { type: "number", min: 1, max: 10, step: 1, label: "Сила" },
};

/** "wb:statusBar.background" / "tk:comments" — ключ цвета; "" если недопустим. */
function cleanColorKey(k) {
    const s = String(k == null ? "" : k);
    if (s.startsWith("wb:") && COLOR_ID_RE.test(s.slice(3))) return s;
    if (s.startsWith("tk:") && TOKEN_GROUPS.indexOf(s.slice(3)) !== -1) return s;
    return "";
}
function cleanColor(v) { return typeof v === "string" && COLOR_RE.test(v) ? v.toLowerCase() : undefined; }
/** Где в настройках VS Code живёт цвет: { conf: ключ настройки, id: ключ внутри объекта }. */
function colorTarget(key) { const k = cleanColorKey(key); return k ? { conf: COLOR_CONF[k.slice(0, 2)], id: k.slice(3) } : null; }

/**
 * Проверенная кнопка или null. Свои кнопки (конструктор): id «b...», команда обязательна.
 * opts.ext — кнопка другого расширения (API ui.button): id «x...», команда необязательна
 * (клик уходит его обработчику onClick), но тогда нужен значок или подпись.
 */
function cleanButton(b, opts) {
    const o = opts || {};
    if (!b || typeof b !== "object") return null;
    const hasCmd = typeof b.command === "string" && COMMAND_RE.test(b.command);
    if (!(o.ext ? EXT_BUTTON_ID_RE : BUTTON_ID_RE).test(String(b.id)) || BUTTON_ZONES.indexOf(b.zone) === -1) return null;
    if (!hasCmd && !(o.ext && b.command == null)) return null;
    const out = { id: b.id, zone: b.zone, command: hasCmd ? b.command : "", icon: "", label: "", tooltip: "", order: 0 };
    if (typeof b.icon === "string" && ICON_RE.test(b.icon)) out.icon = b.icon;
    out.label = cleanLabel(b.label).slice(0, 40).trim();
    out.tooltip = cleanLabel(b.tooltip).slice(0, 120).trim();
    if (!out.icon && !out.label) {
        if (!hasCmd) return null;
        out.label = b.command.split(".").pop().slice(0, 40);
    }
    if (typeof b.order === "number" && isFinite(b.order)) out.order = Math.max(-999, Math.min(999, Math.round(b.order)));
    if (Array.isArray(b.args)) {
        let text = "";
        try { text = JSON.stringify(b.args); } catch (e) { text = ""; }
        if (text && text.length <= 2048) out.args = JSON.parse(text);
    }
    return out;
}
function cleanButtons(list) {
    const seen = new Set();
    return (Array.isArray(list) ? list : []).map(cleanButton).filter((b) => b && !seen.has(b.id) && seen.add(b.id)).slice(0, MAX_BUTTONS);
}
function cleanFxValue(k, v) {
    const f = Object.prototype.hasOwnProperty.call(FX_SPEC, k) ? FX_SPEC[k] : null;
    if (!f) return undefined;
    if (f.type === "bool") return v === true ? true : undefined;
    if (f.type === "color") return cleanColor(v);
    if (f.type === "number") return typeof v === "number" && isFinite(v) && v >= f.min && v <= f.max ? Math.round(v) : undefined;
    return undefined;
}
function cleanFx(fx) {
    const out = {};
    if (fx && typeof fx === "object" && !Array.isArray(fx)) Object.keys(fx).forEach((k) => { const v = cleanFxValue(k, fx[k]); if (v !== undefined) out[k] = v; });
    return out;
}
/** Цвета как значения (для профилей и пакетов): { key: "#rrggbb" }. */
function cleanColorValues(c) {
    const out = {};
    if (c && typeof c === "object" && !Array.isArray(c)) Object.keys(c).slice(0, 300).forEach((k) => {
        const key = cleanColorKey(k), raw = c[k] && typeof c[k] === "object" ? c[k].value : c[k];
        const v = cleanColor(raw);
        if (key && v) out[key] = v;
    });
    return out;
}

/** Селектор, безопасный для вставки в CSS: без фигурных скобок, ;, комментариев и переводов строк. */
// Имена свойств самого объекта: правила лежат в обычном {}, и rules["constructor"] вернул бы
// функцию Object (правка падала), а rules["__proto__"] = ... подменил бы прототип всех правил.
const PROTO_KEYS = ["__proto__", "constructor", "prototype", "hasOwnProperty", "toString", "valueOf"];
function protoKey(k) { return PROTO_KEYS.indexOf(String(k)) !== -1; }

function cleanSelector(sel) {
    const s = String(sel == null ? "" : sel).trim();
    if (!s || s.length > SELECTOR_MAX || protoKey(s)) return "";
    if (/[{};<\\\n\r]|\/\*|\*\/|@/.test(s.replace(/\\[0-9a-fA-F.:#\[\]()"' -]/g, ""))) return "";
    return balanced(s) ? s : "";
}

/**
 * Скобки [ ] ( ) и кавычки закрыты. Незакрытая «(» в селекторе проглатывает в CSS всё до конца
 * стиля — одно такое правило молча выключило бы все правила после него.
 */
function balanced(s) {
    const stack = [];
    let quote = "";
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === "\\") { i++; continue; }
        if (quote) { if (ch === quote) quote = ""; continue; }
        if (ch === "\"" || ch === "'") quote = ch;
        else if (ch === "[" || ch === "(") stack.push(ch === "[" ? "]" : ")");
        else if (ch === "]" || ch === ")") { if (stack.pop() !== ch) return false; }
    }
    return !quote && !stack.length;
}

const FP_TAG_RE = /^[a-z][a-z0-9-]{0,30}$/;
const FP_CLS_RE = /^[\w-]{1,40}$/;
const FP_CAT_RE = /^[A-Za-z]\w{0,31}$/;
const fpText = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001F]/g, " ").slice(0, n);

/** Проверенный отпечаток элемента или null. Селекторы проходят ту же проверку, что и правила. */
function cleanFp(fp) {
    if (!fp || typeof fp !== "object" || Array.isArray(fp)) return null;
    const out = {};
    const alts = Array.isArray(fp.alts) ? fp.alts.map(cleanSelector).filter(Boolean) : [];
    if (alts.length) out.alts = Array.from(new Set(alts)).slice(0, 4);
    if (typeof fp.tag === "string" && FP_TAG_RE.test(fp.tag)) out.tag = fp.tag;
    ["id", "aria", "title", "role", "text"].forEach((k) => {
        const lim = k === "role" ? 30 : k === "text" ? 60 : 120;
        if (typeof fp[k] === "string" && fp[k].trim()) out[k] = fpText(fp[k].trim(), lim);
    });
    ["cls", "pcls"].forEach((k) => {
        const v = Array.isArray(fp[k]) ? fp[k].filter((c) => typeof c === "string" && FP_CLS_RE.test(c)).slice(0, k === "cls" ? 6 : 4) : [];
        if (v.length) out[k] = v;
    });
    if (typeof fp.cat === "string" && FP_CAT_RE.test(fp.cat)) out.cat = fp.cat;
    if (fp.whole === true) out.whole = true;
    if (fp.one === true) out.one = true;
    return Object.keys(out).length ? out : null;
}

function cleanLabel(s) { return String(s == null ? "" : s).replace(/[\u0000-\u001F]/g, " ").replace(/\*\//g, "").slice(0, 80); }

/** Проверить значение свойства. undefined — недопустимо. */
function cleanValue(prop, value) {
    const p = Object.prototype.hasOwnProperty.call(PROPS, prop) ? PROPS[prop] : null;
    if (!p) return undefined;
    if (p.type === "flag") return value === true ? true : undefined;
    if (p.type === "number") {
        if (typeof value !== "number" || !isFinite(value) || value < p.min || value > p.max) return undefined;
        return Math.round(value * 100) / 100;
    }
    if (p.type === "enum") return p.options.indexOf(String(value)) !== -1 ? String(value) : undefined;
    if (p.type === "color") return typeof value === "string" && COLOR_RE.test(value) ? value.toLowerCase() : undefined;
    if (p.type === "text") return typeof value === "string" && FONT_RE.test(value.trim()) && balanced(value.trim()) ? value.trim() : undefined;
    return undefined;
}

function readDesign(file) {
    let o;
    try { o = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return emptyDesign(); }
    const d = emptyDesign();
    if (o && o.rules && typeof o.rules === "object") {
        Object.keys(o.rules).slice(0, MAX_RULES).forEach((sel) => {
            const s = cleanSelector(sel), r = o.rules[sel];
            // props: null (файл правили руками или он недописан) раньше ронял Object.keys — а с ним
            // и весь хост при загрузке правок.
            if (!s || !r || !r.props || typeof r.props !== "object" || Array.isArray(r.props)) return;
            const props = {};
            Object.keys(r.props).forEach((k) => { const v = cleanValue(k, r.props[k]); if (v !== undefined) props[k] = v; });
            if (!Object.keys(props).length) return;
            d.rules[s] = { label: cleanLabel(r.label), props: props, ts: Number(r.ts) || 0 };
            const fp = cleanFp(r.fp);
            if (fp) d.rules[s].fp = fp;
        });
    }
    if (o && o.settings && typeof o.settings === "object") {
        Object.keys(o.settings).forEach((k) => {
            const r = o.settings[k];
            if (!SETTINGS[k] || !r || validateSetting(k, r.value) === undefined) return;
            d.settings[k] = { value: r.value, prev: r.prev, hadPrev: !!r.hadPrev, label: cleanLabel(r.label), ts: Number(r.ts) || 0 };
        });
    }
    if (o && o.colors && typeof o.colors === "object") {
        Object.keys(o.colors).slice(0, 300).forEach((k) => {
            const key = cleanColorKey(k), r = o.colors[k];
            const v = r && cleanColor(r.value);
            if (!key || !v) return;
            const prev = cleanColor(r.prev);
            d.colors[key] = { value: v, prev: prev, hadPrev: !!r.hadPrev && prev !== undefined, label: cleanLabel(r.label), ts: Number(r.ts) || 0 };
        });
    }
    if (o) { d.buttons = cleanButtons(o.buttons); d.fx = cleanFx(o.fx); }
    return d;
}

function writeDesign(file, d) { writeAtomic(file, JSON.stringify(d, null, 2)); }

/**
 * Применить операции CSS-части к дизайну (мутирует d). Возвращает число реальных изменений.
 *   {op:"set", selector, prop, value, label}   value === null — убрать свойство
 *   {op:"resetRule", selector}
 *   {op:"clearRules"}
 *   {op:"renameRule", from, to, fp?}          селектор перестал работать — правило переезжает на новый
 *   {op:"fingerprint", selector, fp}          запомнить отпечаток элемента у существующего правила
 * У set можно передать fp: он запоминается, если у правила отпечатка ещё нет.
 * Операции с настройками (setting/undoSetting) выполняет хост — ему нужен vscode.
 */
function applyCssOps(d, ops) {
    let changed = 0;
    (Array.isArray(ops) ? ops.slice(0, 200) : []).forEach((o) => {
        if (!o || typeof o !== "object") return;
        if (o.op === "clearRules") { if (Object.keys(d.rules).length) { d.rules = {}; changed++; } return; }
        if (o.op === "renameRule") { changed += renameRule(d.rules, o.from, o.to, o.fp); return; }
        const sel = cleanSelector(o.selector);
        if (o.op === "fingerprint") {
            const fp = sel && d.rules[sel] ? cleanFp(o.fp) : null;
            if (fp && JSON.stringify(fp) !== JSON.stringify(d.rules[sel].fp || null)) { d.rules[sel].fp = fp; changed++; }
            return;
        }
        if (!sel) return;
        if (o.op === "resetRule") { if (d.rules[sel]) { delete d.rules[sel]; changed++; } return; }
        if (o.op !== "set" || !Object.prototype.hasOwnProperty.call(PROPS, o.prop)) return;
        const rule = d.rules[sel];
        if (o.value === null || o.value === undefined || o.value === false && PROPS[o.prop].type === "flag") {
            if (rule && rule.props[o.prop] !== undefined) {
                delete rule.props[o.prop];
                if (!Object.keys(rule.props).length) delete d.rules[sel];
                changed++;
            }
            return;
        }
        const v = cleanValue(o.prop, o.value);
        if (v === undefined) return;
        if (!rule) {
            if (Object.keys(d.rules).length >= MAX_RULES) return;
            d.rules[sel] = { label: cleanLabel(o.label), props: {}, ts: Date.now() };
        } else if (o.label && !rule.label) rule.label = cleanLabel(o.label);
        if (!d.rules[sel].fp && o.fp) { const fp = cleanFp(o.fp); if (fp) d.rules[sel].fp = fp; }
        if (d.rules[sel].props[o.prop] !== v) { d.rules[sel].props[o.prop] = v; d.rules[sel].ts = Date.now(); changed++; }
    });
    return changed;
}

/**
 * Перенести правило со старого селектора на новый (в объекте rules — правках или профиле).
 * Если на новом селекторе уже есть правило, свойства сливаются: перенесённые важнее.
 * Возвращает 1, если что-то изменилось.
 */
function renameRule(rules, fromSel, toSel, fp) {
    const from = cleanSelector(fromSel), to = cleanSelector(toSel);
    if (!from || !to || from === to || !rules[from]) return 0;
    const r = rules[from];
    delete rules[from];
    const cur = rules[to];
    const next = cur ? Object.assign({}, cur, { props: Object.assign({}, cur.props, r.props), label: cur.label || r.label }) : r;
    const nfp = cleanFp(fp) || r.fp || (cur && cur.fp);
    if (nfp) next.fp = nfp; else delete next.fp;
    rules[to] = next;
    return 1;
}

/** Учесть смену настройки: первое изменение запоминает исходное значение, возврат к нему — убирает пункт. */
function recordSetting(d, key, value, prev, hadPrev, label) {
    const rec = d.settings[key];
    if (!rec) {
        if (hadPrev && JSON.stringify(prev) === JSON.stringify(value)) return false;
        d.settings[key] = { value: value, prev: prev, hadPrev: !!hadPrev, label: cleanLabel(label), ts: Date.now() };
        return true;
    }
    if (rec.hadPrev && JSON.stringify(rec.prev) === JSON.stringify(value)) { delete d.settings[key]; return true; }
    rec.value = value; rec.ts = Date.now();
    return true;
}

function cssValue(prop, v) {
    const p = PROPS[prop];
    if (p.type === "flag") return p.value;
    if (p.type === "number") return v + (p.unit || "");
    return String(v);
}

/** CSS из правил дизайна. Порядок — по времени создания, всё с !important (перебивает тему). */
function buildCss(d) {
    const sels = Object.keys(d.rules).sort((a, b) => (d.rules[a].ts - d.rules[b].ts) || a.localeCompare(b));
    return sels.map((sel) => {
        const r = d.rules[sel];
        const decl = Object.keys(r.props).filter((k) => PROPS[k]).map((k) => "  " + PROPS[k].css + ": " + cssValue(k, r.props[k]) + " !important;" + (PROPS[k].extra ? "\n  " + PROPS[k].extra + ";" : ""));
        return "/* " + (r.label || "элемент") + " */\n" + sel + " {\n" + decl.join("\n") + "\n}";
    }).join("\n\n") + (sels.length ? "\n" : "");
}

/** Описание свойств для окна (без функций и регэкспов). */
function propsSpec() { return JSON.parse(JSON.stringify(PROPS)); }

module.exports = {
    FX_SPEC, TOKEN_GROUPS, BUTTON_ZONES, COLOR_CONF, cleanColorKey, cleanColor, colorTarget, cleanButton, cleanButtons, cleanFx, cleanFxValue, cleanColorValues,
    PROPS, emptyDesign, cleanSelector, balanced, protoKey, cleanValue, cleanFp, readDesign, writeDesign, applyCssOps, renameRule, recordSetting, buildCss, propsSpec };
