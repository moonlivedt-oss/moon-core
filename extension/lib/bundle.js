// ============================================================
//  Перенос вида между машинами — чистая часть без vscode (её гоняют тесты).
//
//  Всё, что человек настроил в Moon Core, лежит в globalStorage этой машины: правки
//  конструктора, профили вида, сниппеты. В Settings Sync это не попадает. «Пакет» — один
//  JSON-объект со всем этим: его можно выгрузить в файл, загрузить на другой машине или держать
//  в настройке moonCore.syncData, которую Settings Sync переносит сам.
//
//  Всё входящее проверяется теми же правилами, что и правки из окна: селекторы и значения CSS
//  (design.js), настройки VS Code только из каталога и в допустимых значениях (catalog.js),
//  имена сниппетов и профилей, лимиты объёма. Чужой пакет не протащит в стиль свой код.
// ============================================================
"use strict";

const D = require("./design");
const C = require("./catalog");
const S = require("./snippets");
const P = require("./protocol");
const { cleanProfile, cleanName, MAX_PROFILES } = require("./engine");

const FORMAT = "moon-core-bundle";
const VERSION = 1;
const MAX_BUNDLE = 2 * 1024 * 1024;     // байт JSON в файле
const MAX_SYNC = 512 * 1024;            // байт JSON в настройке (settings.json не резиновый)

/**
 * Собрать пакет.
 * src: { design: {rules, settings}, profiles: {active, list}, snippets: [{id, code, enabled, error?}] }
 * opts.snippets === false — без сниппетов.
 */
function makeBundle(src, opts) {
    const o = opts || {};
    const rules = {};
    Object.keys((src.design && src.design.rules) || {}).forEach((sel) => {
        const r = src.design.rules[sel];
        rules[sel] = { label: r.label || "", props: Object.assign({}, r.props) };
        if (r.fp) rules[sel].fp = r.fp;
    });
    const settings = {};
    Object.keys((src.design && src.design.settings) || {}).forEach((k) => { settings[k] = src.design.settings[k].value; });
    const list = {};
    Object.keys((src.profiles && src.profiles.list) || {}).forEach((n) => { list[n] = src.profiles.list[n]; });
    const out = {
        format: FORMAT, v: VERSION, t: Date.now(),
        design: { rules: rules, settings: settings, colors: D.cleanColorValues(src.design && src.design.colors), buttons: D.cleanButtons(src.design && src.design.buttons), fx: D.cleanFx(src.design && src.design.fx) },
        profiles: { active: (src.profiles && src.profiles.active) || "", list: list },
    };
    if (o.snippets !== false) {
        out.snippets = (src.snippets || []).filter((s) => !s.error).map((s) => ({ id: s.id, code: s.code, enabled: s.enabled !== false }));
    }
    return out;
}

/** Содержимое пакета без метки времени — чтобы сравнивать «то же самое или нет». */
function contentKey(b) {
    if (!b) return "";
    return JSON.stringify({ design: b.design, profiles: b.profiles, snippets: b.snippets || null });
}

/**
 * Проверить пакет. Возвращает { ok, bundle?, error?, dropped }.
 * bundle: { design: {rules, settings}, profiles: {active, list}, snippets: [...] | null }
 * dropped — сколько записей отброшено проверкой (пусть человек знает, что не всё приехало).
 */
function parseBundle(raw) {
    let o = raw;
    if (typeof raw === "string") {
        if (raw.length > MAX_BUNDLE) return { ok: false, error: "файл больше " + (MAX_BUNDLE >> 20) + " МБ" };
        try { o = JSON.parse(raw); } catch (e) { return { ok: false, error: "это не JSON" }; }
    }
    if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: false, error: "пакет не объект" };
    if (o.format !== FORMAT) return { ok: false, error: "это не пакет Moon Core" };
    if (Number(o.v) > VERSION) return { ok: false, error: "пакет новее этой версии Moon Core" };
    let dropped = 0;

    // Правила — через те же операции, что и правки из окна.
    const tmp = D.emptyDesign();
    const rules = (o.design && o.design.rules && typeof o.design.rules === "object") ? o.design.rules : {};
    Object.keys(rules).forEach((sel) => {
        const r = rules[sel] || {};
        const props = r.props && typeof r.props === "object" ? r.props : {};
        Object.keys(props).forEach((k) => {
            const n = D.applyCssOps(tmp, [{ op: "set", selector: sel, prop: k, value: props[k], label: r.label, fp: r.fp }]);
            if (!n) dropped++;
        });
    });
    const settings = {};
    const srcSet = (o.design && o.design.settings && typeof o.design.settings === "object") ? o.design.settings : {};
    Object.keys(srcSet).forEach((k) => {
        const v = C.validateSetting(k, srcSet[k]);
        if (v === undefined) dropped++; else settings[k] = v;
    });

    const list = {};
    const srcProf = (o.profiles && o.profiles.list && typeof o.profiles.list === "object") ? o.profiles.list : {};
    Object.keys(srcProf).slice(0, MAX_PROFILES).forEach((n) => {
        const name = cleanName(n);
        if (!name || C.PRESETS[name]) { dropped++; return; }
        list[name] = cleanProfile(srcProf[n]);
    });
    const act = cleanName(o.profiles && o.profiles.active);

    let snippets = null;
    if (Array.isArray(o.snippets)) {
        snippets = [];
        const seen = new Set();
        o.snippets.slice(0, P.MAX_SNIPPETS).forEach((s) => {
            if (!s || !S.validId(String(s.id)) || typeof s.code !== "string" || s.code.length > P.MAX_SNIPPET || seen.has(s.id)) { dropped++; return; }
            seen.add(s.id);
            snippets.push({ id: s.id, code: s.code, enabled: s.enabled !== false });
        });
    }

    const srcColors = (o.design && o.design.colors && typeof o.design.colors === "object") ? o.design.colors : {};
    const colors = D.cleanColorValues(srcColors);
    dropped += Object.keys(srcColors).length - Object.keys(colors).length;
    const srcButtons = (o.design && Array.isArray(o.design.buttons)) ? o.design.buttons : [];
    const buttons = D.cleanButtons(srcButtons);
    dropped += srcButtons.length - buttons.length;
    const design = { rules: {}, settings: settings, colors: colors, buttons: buttons, fx: D.cleanFx(o.design && o.design.fx) };
    Object.keys(tmp.rules).forEach((sel) => {
        design.rules[sel] = { label: tmp.rules[sel].label, props: tmp.rules[sel].props };
        if (tmp.rules[sel].fp) design.rules[sel].fp = tmp.rules[sel].fp;
    });
    return {
        ok: true,
        dropped: dropped,
        bundle: {
            design: design,
            profiles: { active: act && (list[act] || C.PRESETS[act]) ? act : "", list: list },
            snippets: snippets,
        },
    };
}

/** Операции движка, которые приводят конструктор к пакету: сброс, правила, настройки. */
function designOps(bundle) {
    const ops = [{ op: "clearAll" }];
    Object.keys(bundle.design.rules).forEach((sel) => {
        const r = bundle.design.rules[sel];
        Object.keys(r.props).forEach((k) => ops.push({ op: "set", selector: sel, prop: k, value: r.props[k], label: r.label, fp: r.fp }));
    });
    Object.keys(bundle.design.settings).forEach((k) => ops.push({ op: "setting", key: k, value: bundle.design.settings[k] }));
    Object.keys(bundle.design.colors || {}).forEach((k) => ops.push({ op: "color", key: k, value: bundle.design.colors[k] }));
    (bundle.design.buttons || []).forEach((b) => ops.push({ op: "button", button: b }));
    Object.keys(bundle.design.fx || {}).forEach((k) => ops.push({ op: "fx", key: k, value: bundle.design.fx[k] }));
    return ops;
}

/** Пусто ли на этой машине (нечего терять — можно молча взять пакет из синхронизации). */
function isEmptyLocal(src) {
    const d = src.design || {};
    return !Object.keys(d.rules || {}).length && !Object.keys(d.settings || {}).length && !Object.keys(d.colors || {}).length && !(d.buttons || []).length &&
        !Object.keys((src.profiles && src.profiles.list) || {}).length && !(src.snippets || []).length;
}

/** Короткое описание пакета для подтверждения. */
function describe(bundle) {
    const parts = [];
    parts.push("правок конструктора: " + Object.keys(bundle.design.rules).length);
    parts.push("настроек VS Code: " + Object.keys(bundle.design.settings).length);
    if (Object.keys(bundle.design.colors || {}).length) parts.push("цветов темы: " + Object.keys(bundle.design.colors).length);
    if ((bundle.design.buttons || []).length) parts.push("кнопок: " + bundle.design.buttons.length);
    parts.push("профилей: " + Object.keys(bundle.profiles.list).length);
    if (bundle.snippets) parts.push("сниппетов: " + bundle.snippets.length);
    return parts.join(", ");
}

module.exports = { FORMAT, VERSION, MAX_BUNDLE, MAX_SYNC, makeBundle, parseBundle, contentKey, designOps, isEmptyLocal, describe };
