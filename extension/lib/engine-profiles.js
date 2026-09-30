// ============================================================
//  Движок конструктора: операции с профилями сверх «сохранить / применить / удалить».
//    renameProfile { from, to }            — переименовать свой профиль;
//    applyProfile { name, only: [части] }  — взять из профиля только часть (цвета, настройки,
//                                            элементы, эффекты, кнопки) поверх текущего вида.
//  Частичное применение ничего не сбрасывает и активный профиль не меняет: это «добавить к
//  тому, что есть», а не «переключиться».
//  Без vscode; движок передаётся аргументом (lib/engine.js).
// ============================================================
"use strict";

const D = require("./design");
const C = require("./catalog");

const PARTS = ["rules", "settings", "colors", "fx", "buttons"];
const MAX_BUTTONS = 40;

/** Это операция отсюда? */
function handles(o) { return !!o && (o.op === "renameProfile" || (o.op === "applyProfile" && Array.isArray(o.only))); }

/** Выполнить операцию. Возвращает { changed, profiles } — что сохранить. */
async function run(engine, o, errors) {
    const { cleanName } = require("./engine");
    if (o.op === "renameProfile") {
        const from = cleanName(o.from), to = cleanName(o.to);
        const list = engine.profiles.list;
        if (!from || !list[from]) { errors.push("нет своего профиля «" + String(o.from).slice(0, 40) + "»"); return { changed: 0, profiles: false }; }
        if (!to) { errors.push("имя профиля: буквы, цифры, пробел, _ . - ( ), до 40 символов"); return { changed: 0, profiles: false }; }
        if (to === from) return { changed: 0, profiles: false };
        if (C.PRESETS[to] || list[to]) { errors.push("профиль «" + to + "» уже есть"); return { changed: 0, profiles: false }; }
        list[to] = list[from];
        delete list[from];
        if (engine.profiles.active === from) engine.profiles.active = to;
        return { changed: 0, profiles: true };
    }
    const name = cleanName(o.name);
    const p = name ? engine.profileByName(name) : null;
    if (!p) { errors.push("нет профиля «" + String(o.name).slice(0, 40) + "»"); return { changed: 0, profiles: false }; }
    const only = o.only.filter((x) => PARTS.indexOf(x) !== -1);
    if (!only.length) { errors.push("не выбрано, что взять из профиля"); return { changed: 0, profiles: false }; }
    const d = engine.design;
    const has = (part) => only.indexOf(part) !== -1;
    if (has("settings")) {
        for (const k of Object.keys(p.settings)) {
            try { await engine.setSetting(k, p.settings[k], null); } catch (e) { errors.push(k + ": " + e.message); }
        }
    }
    if (has("colors")) {
        for (const k of Object.keys(p.colors || {})) {
            try { await engine.setColor(k, p.colors[k], ""); } catch (e) { errors.push(k + ": " + e.message); }
        }
    }
    if (has("rules")) {
        const now = Date.now();
        Object.keys(p.rules).forEach((sel, i) => {
            const cur = d.rules[sel];
            d.rules[sel] = { label: p.rules[sel].label || (cur && cur.label) || "", props: Object.assign({}, cur ? cur.props : {}, p.rules[sel].props), ts: cur ? cur.ts : now + i };
            const fp = p.rules[sel].fp || (cur && cur.fp);
            if (fp) d.rules[sel].fp = fp;
        });
    }
    if (has("fx")) d.fx = D.cleanFx(Object.assign({}, d.fx, p.fx));
    if (has("buttons")) {
        const ids = new Set(d.buttons.map((b) => b.id));
        D.cleanButtons(p.buttons).forEach((b) => { if (!ids.has(b.id) && d.buttons.length < MAX_BUTTONS) d.buttons.push(b); });
    }
    return { changed: 1, profiles: false };
}

module.exports = { handles, run, PARTS };
