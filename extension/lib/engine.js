// ============================================================
//  Движок конструктора: правки элементов, настройки VS Code и профили вида.
//
//  Без vscode: настройки меняются через адаптер config
//    { get(key), globalValue(key), update(key, value|undefined) -> Promise }.
//  Хост даёт адаптер поверх vscode.workspace.getConfiguration, тестовый стенд и тесты — свой.
//
//  Файлы:
//    mooncore-design.json   — текущие правки (lib/design.js);
//    mooncore-profiles.json — сохранённые профили и активный профиль.
//  Профиль = снимок правил + ЗНАЧЕНИЯ настроек. Применение профиля: всё текущее откатывается к
//  исходному VS Code, затем применяется профиль — поэтому «Сбросить всё» после любого профиля
//  возвращает VS Code ровно к тому, что было до Moon Core.
// ============================================================
"use strict";

const fs = require("fs");
const D = require("./design");
const C = require("./catalog");
const { writeAtomic } = require("./storage");

const NAME_RE = /^[\p{L}\p{N} _.()-]{1,40}$/u;
const MAX_PROFILES = 30;
const MODULE_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const MAX_MODULE_PART = 64 * 1024;   // байт JSON на состояние одного модуля в профиле

/**
 * Состояние модулей в профиле: { <id модуля>: <объект> }. Moon Core его не понимает и не
 * применяет сам — только хранит и отдаёт модулю при применении профиля (событие "profile").
 * Поэтому здесь лишь форма и объём.
 */
function cleanModules(m) {
    const out = {};
    if (!m || typeof m !== "object" || Array.isArray(m)) return out;
    Object.keys(m).slice(0, 16).forEach((id) => {
        const v = m[id];
        if (!MODULE_ID_RE.test(id) || !v || typeof v !== "object" || Array.isArray(v)) return;
        let text;
        try { text = JSON.stringify(v); } catch (e) { return; }
        if (text.length <= MAX_MODULE_PART) out[id] = JSON.parse(text);
    });
    return out;
}

function cleanName(n) { const s = String(n == null ? "" : n).trim(); return NAME_RE.test(s) ? s : ""; }

/** Снимок для профиля: правила (без времени) + значения настроек. */
function snapshot(d) {
    const rules = {};
    Object.keys(d.rules).forEach((sel) => {
        rules[sel] = { label: d.rules[sel].label, props: Object.assign({}, d.rules[sel].props) };
        if (d.rules[sel].fp) rules[sel].fp = d.rules[sel].fp;
    });
    const settings = {};
    Object.keys(d.settings).forEach((k) => { settings[k] = d.settings[k].value; });
    return { rules: rules, settings: settings, colors: D.cleanColorValues(d.colors), buttons: D.cleanButtons(d.buttons), fx: D.cleanFx(d.fx) };
}

/** Проверенный профиль из произвольного объекта (файл, встроенный). */
function cleanProfile(p) {
    const out = { rules: {}, settings: {}, colors: {}, buttons: [], fx: {}, modules: {}, note: "", ts: 0 };
    if (!p || typeof p !== "object") return out;
    const tmp = D.emptyDesign();
    D.applyCssOps(tmp, Object.keys(p.rules || {}).reduce((ops, sel) => {
        const r = p.rules[sel] || {};
        Object.keys(r.props || {}).forEach((k) => ops.push({ op: "set", selector: sel, prop: k, value: r.props[k], label: r.label, fp: r.fp }));
        return ops;
    }, []));
    Object.keys(tmp.rules).forEach((sel) => {
        out.rules[sel] = { label: tmp.rules[sel].label, props: tmp.rules[sel].props };
        if (tmp.rules[sel].fp) out.rules[sel].fp = tmp.rules[sel].fp;
    });
    Object.keys(p.settings || {}).forEach((k) => { const v = C.validateSetting(k, p.settings[k]); if (v !== undefined) out.settings[k] = v; });
    out.colors = D.cleanColorValues(p.colors);
    out.buttons = D.cleanButtons(p.buttons);
    out.fx = D.cleanFx(p.fx);
    out.modules = cleanModules(p.modules);
    out.note = String(p.note || "").slice(0, 120);
    out.ts = Number(p.ts) || 0;
    return out;
}

function sameSnapshot(a, b) {
    const norm = (s) => JSON.stringify({
        rules: Object.keys(s.rules).sort().map((k) => [k, Object.keys(s.rules[k].props).sort().map((p) => [p, s.rules[k].props[p]])]),
        settings: Object.keys(s.settings).sort().map((k) => [k, s.settings[k]]),
        colors: Object.keys(s.colors || {}).sort().map((k) => [k, s.colors[k]]),
        buttons: (s.buttons || []).map((b) => JSON.stringify(b)).sort(),
        fx: Object.keys(s.fx || {}).sort().map((k) => [k, s.fx[k]]),
    });
    return norm(a) === norm(b);
}

class DesignEngine {
    /** opts: { designFile, profilesFile, config, log } */
    constructor(opts) {
        this.opts = opts;
        this.log = opts.log || (() => {});
        this.design = D.emptyDesign();
        this.profiles = { active: "", list: {} };
        this.load();
    }

    load() {
        this.design = D.readDesign(this.opts.designFile);
        let o = null;
        try { o = JSON.parse(fs.readFileSync(this.opts.profilesFile, "utf8")); } catch (e) {}
        const list = {};
        if (o && o.list && typeof o.list === "object") {
            Object.keys(o.list).slice(0, MAX_PROFILES).forEach((n) => {
                const name = cleanName(n);
                if (name && !C.PRESETS[name]) list[name] = cleanProfile(o.list[n]);
            });
        }
        const active = cleanName(o && o.active);
        this.profiles = { active: active && (list[active] || C.PRESETS[active]) ? active : "", list: list };
    }

    saveProfiles() { writeAtomic(this.opts.profilesFile, JSON.stringify(this.profiles, null, 2)); }
    saveDesign() { D.writeDesign(this.opts.designFile, this.design); }

    profileByName(name) {
        if (C.PRESETS[name]) return cleanProfile(C.PRESETS[name]);
        return this.profiles.list[name] || null;
    }

    /** Для окна: список профилей, активный и изменён ли он с момента применения. */
    summary() {
        const item = (name, p, builtin) => ({ name: name, builtin: builtin, note: p.note || "", rules: Object.keys(p.rules).length, settings: Object.keys(p.settings).length,
            colors: Object.keys(p.colors || {}).length, buttons: (p.buttons || []).length, modules: Object.keys(p.modules || {}) });
        const list = Object.keys(C.PRESETS).map((n) => item(n, cleanProfile(C.PRESETS[n]), true))
            .concat(Object.keys(this.profiles.list).sort((a, b) => a.localeCompare(b)).map((n) => item(n, this.profiles.list[n], false)));
        const act = this.profiles.active ? this.profileByName(this.profiles.active) : null;
        return { list: list, active: this.profiles.active, dirty: !!act && !sameSnapshot(snapshot(this.design), act) };
    }

    /** Сколько всего правок: правила, настройки, цвета темы, кнопки, эффекты. */
    editCount() {
        const d = this.design;
        return Object.keys(d.rules).length + Object.keys(d.settings).length + Object.keys(d.colors || {}).length +
            (d.buttons || []).length + Object.keys(d.fx || {}).length;
    }

    // ---- настройки
    async setSetting(key, value, label) {
        const v = C.validateSetting(key, value);
        if (v === undefined) throw new Error("недопустимое значение " + key);
        const cfg = this.opts.config;
        const rec = this.design.settings[key];
        const gv = cfg.globalValue(key);
        const prev = rec ? rec.prev : gv;
        const hadPrev = rec ? rec.hadPrev : gv !== undefined;
        await cfg.update(key, v);
        return D.recordSetting(this.design, key, v, prev, hadPrev, label || C.SETTINGS[key].label);
    }
    async undoSetting(key) {
        const rec = this.design.settings[key];
        if (!rec) return false;
        await this.opts.config.update(key, rec.hadPrev ? rec.prev : undefined);
        delete this.design.settings[key];
        return true;
    }
    async clearAll(errors) {
        for (const key of Object.keys(this.design.settings)) {
            try { await this.undoSetting(key); } catch (e) { errors.push(key + ": " + e.message); delete this.design.settings[key]; }
        }
        for (const key of Object.keys(this.design.colors)) {
            try { await this.setColor(key, null); } catch (e) { errors.push(key + ": " + e.message); delete this.design.colors[key]; }
        }
        this.design.rules = {};
        this.design.buttons = [];
        this.design.fx = {};
    }

    /**
     * Цвет темы: пишется в штатную настройку (workbench.colorCustomizations или
     * editor.tokenColorCustomizations), остальные ключи этой настройки не трогаются.
     * Первое изменение запоминает, что было до Moon Core; value === null — вернуть как было.
     */
    async setColor(key, value, label) {
        const t = D.colorTarget(key);
        if (!t) throw new Error("недопустимый цвет " + String(key).slice(0, 60));
        const v = value === null || value === undefined ? null : D.cleanColor(value);
        if (value != null && v === undefined) throw new Error("цвет должен быть #rrggbb");
        const cfg = this.opts.config;
        const cur = cfg.globalValue(t.conf);
        const next = cur && typeof cur === "object" && !Array.isArray(cur) ? Object.assign({}, cur) : {};
        const rec = this.design.colors[key];
        if (v === null) {
            if (!rec) return false;
            if (rec.hadPrev) next[t.id] = rec.prev; else delete next[t.id];
            delete this.design.colors[key];
        } else {
            const prev = rec ? rec.prev : D.cleanColor(next[t.id]);
            const hadPrev = rec ? rec.hadPrev : prev !== undefined;
            next[t.id] = v;
            if (hadPrev && prev === v) delete this.design.colors[key];
            else this.design.colors[key] = { value: v, prev: prev, hadPrev: hadPrev, label: String(label || (rec && rec.label) || "").slice(0, 80), ts: Date.now() };
        }
        await cfg.update(t.conf, Object.keys(next).length ? next : undefined);
        return true;
    }

    /** Кнопка: добавить или заменить по id. */
    putButton(b) {
        const btn = D.cleanButton(b);
        if (!btn) throw new Error("недопустимая кнопка");
        const list = this.design.buttons.filter((x) => x.id !== btn.id);
        if (list.length >= 40) throw new Error("не больше 40 кнопок");
        list.push(btn);
        this.design.buttons = list;
        return true;
    }

    /**
     * Выполнить операции по очереди. Возвращает { ok, error, changed }.
     *   set / resetRule / clearRules            — CSS-правила (design.js)
     *   setting {key, value, label} / undoSetting {key} / clearAll
     *   saveProfile {name} / applyProfile {name} / deleteProfile {name} / putProfile {name, profile}
     *   renameRule {from, to, fp} / fingerprint {selector, fp}
     */
    async apply(ops) {
        this.load();                        // другое окно могло поменять файлы
        const errors = [];
        const applied = [];                 // применённые профили — хост передаст модулям их часть
        let changed = 0, profilesChanged = false;
        for (const o of (Array.isArray(ops) ? ops.slice(0, 200) : [])) {
            if (!o || typeof o !== "object") continue;
            try {
                if (o.op === "set" || o.op === "resetRule" || o.op === "clearRules" || o.op === "fingerprint") changed += D.applyCssOps(this.design, [o]);
                else if (o.op === "renameRule") {
                    // Селектор сломался после обновления VS Code: правило переезжает и в правках,
                    // и во всех своих профилях, где оно есть (иначе профиль вернёт сломанное).
                    const n = D.applyCssOps(this.design, [o]);
                    Object.keys(this.profiles.list).forEach((name) => {
                        if (D.renameRule(this.profiles.list[name].rules, o.from, o.to, o.fp)) profilesChanged = true;
                    });
                    changed += n;
                }
                else if (o.op === "setting") { if (await this.setSetting(String(o.key || ""), o.value, o.label)) changed++; }
                else if (o.op === "undoSetting") { if (await this.undoSetting(String(o.key || ""))) changed++; }
                else if (o.op === "color") { if (await this.setColor(String(o.key || ""), o.value, o.label)) changed++; }
                else if (o.op === "button") { if (this.putButton(o.button)) changed++; }
                else if (o.op === "removeButton") {
                    const n = this.design.buttons.length;
                    this.design.buttons = this.design.buttons.filter((b) => b.id !== o.id);
                    if (this.design.buttons.length !== n) changed++;
                } else if (o.op === "fx") {
                    const k = String(o.key || "");
                    if (!Object.prototype.hasOwnProperty.call(D.FX_SPEC, k)) { errors.push("неизвестный эффект " + k.slice(0, 40)); continue; }
                    const v = o.value === null ? undefined : D.cleanFxValue(k, o.value);
                    if (o.value !== null && o.value !== false && v === undefined) { errors.push("недопустимое значение " + k); continue; }
                    if (v === undefined) delete this.design.fx[k]; else this.design.fx[k] = v;
                    changed++;
                }
                else if (o.op === "clearAll") { await this.clearAll(errors); this.profiles.active = ""; profilesChanged = true; changed++; }
                else if (o.op === "saveProfile") {
                    const name = cleanName(o.name);
                    if (!name) { errors.push("имя профиля: буквы, цифры, пробел, _ . - ( ), до 40 символов"); continue; }
                    if (C.PRESETS[name]) { errors.push("«" + name + "» — встроенный профиль, выбери другое имя"); continue; }
                    if (!this.profiles.list[name] && Object.keys(this.profiles.list).length >= MAX_PROFILES) { errors.push("не больше " + MAX_PROFILES + " профилей"); continue; }
                    // Состояние модулей присылает окно (помощник модуля mc.profile). Не прислало —
                    // сохраняем прежнее: «Обновить» профиль из QuickPick не должен его терять.
                    const prevMods = this.profiles.list[name] ? this.profiles.list[name].modules : {};
                    const mods = o.modules !== undefined ? cleanModules(o.modules) : (prevMods || {});
                    this.profiles.list[name] = Object.assign(snapshot(this.design), { modules: mods, note: "", ts: Date.now() });
                    this.profiles.active = name;
                    profilesChanged = true;
                } else if (o.op === "applyProfile") {
                    const name = cleanName(o.name);
                    const p = name ? this.profileByName(name) : null;
                    if (!p) { errors.push("нет профиля «" + String(o.name).slice(0, 40) + "»"); continue; }
                    await this.clearAll(errors);
                    for (const k of Object.keys(p.settings)) {
                        try { await this.setSetting(k, p.settings[k], null); } catch (e) { errors.push(k + ": " + e.message); }
                    }
                    for (const k of Object.keys(p.colors || {})) {
                        try { await this.setColor(k, p.colors[k], ""); } catch (e) { errors.push(k + ": " + e.message); }
                    }
                    this.design.buttons = D.cleanButtons(p.buttons);
                    this.design.fx = D.cleanFx(p.fx);
                    const now = Date.now();
                    Object.keys(p.rules).forEach((sel, i) => {
                        this.design.rules[sel] = { label: p.rules[sel].label, props: Object.assign({}, p.rules[sel].props), ts: now + i };
                        if (p.rules[sel].fp) this.design.rules[sel].fp = p.rules[sel].fp;
                    });
                    this.profiles.active = name;
                    profilesChanged = true;
                    changed++;
                    applied.push({ name: name, modules: p.modules || {} });
                } else if (o.op === "putProfile") {
                    // Профиль целиком снаружи (профиль проекта из .vscode/mooncore.json): проверяется
                    // как любой профиль, модули не берутся, активный профиль не меняется.
                    const name = cleanName(o.name);
                    if (!name || C.PRESETS[name]) { errors.push("недопустимое имя профиля"); continue; }
                    if (!this.profiles.list[name] && Object.keys(this.profiles.list).length >= MAX_PROFILES) { errors.push("не больше " + MAX_PROFILES + " профилей"); continue; }
                    const p = cleanProfile(o.profile);
                    this.profiles.list[name] = Object.assign(p, { modules: {}, ts: Date.now() });
                    profilesChanged = true;
                } else if (o.op === "deleteProfile") {
                    const name = cleanName(o.name);
                    if (name && this.profiles.list[name]) {
                        delete this.profiles.list[name];
                        if (this.profiles.active === name) this.profiles.active = "";
                        profilesChanged = true;
                    }
                }
            } catch (e) { errors.push(String(e && e.message || e)); this.log("конструктор: " + o.op, e); }
        }
        if (changed) this.saveDesign();
        if (profilesChanged) this.saveProfiles();
        return { ok: !errors.length, error: errors.join("; "), changed: changed + (profilesChanged ? 1 : 0), applied: applied };
    }

    /** Поля состояния для окна. settingsNow — текущие значения настроек каталога. */
    stateExtra(settingsNow) {
        return {
            design: { rules: this.design.rules, settings: this.design.settings, colors: this.design.colors, buttons: this.design.buttons, fx: this.design.fx, css: D.buildCss(this.design) },
            fxSpec: D.FX_SPEC,
            tokenGroups: D.TOKEN_GROUPS,
            catalog: C.CATALOG,
            zones: C.ZONES,
            props: D.propsSpec(),
            settingsNow: settingsNow,
            profiles: this.summary(),
        };
    }
}

module.exports = { DesignEngine, snapshot, cleanProfile, sameSnapshot, cleanName, cleanModules, MAX_PROFILES };
