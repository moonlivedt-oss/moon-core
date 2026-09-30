// ============================================================
//  История правок конструктора: «Отменить» и «Вернуть».
//
//  Шаг истории — полный снимок вида (правила, настройки VS Code с исходными значениями, цвета
//  темы, кнопки, эффекты) до правки. Отмена возвращает снимок целиком: настройки и цвета
//  записываются обратно в VS Code, правила и кнопки — в файл правок.
//
//  История живёт в памяти хоста окна. Окон VS Code может быть несколько, и у каждого свой хост,
//  поэтому у шага есть отпечаток состояния «после»: если текущий вид ему не равен (правили в
//  другом окне, загрузили пакет), шаг применять нельзя — история сбрасывается.
//  Подряд идущие правки одного свойства (ползунок) сливаются в один шаг.
//  Модуль без vscode.
// ============================================================
"use strict";

const fs = require("fs");
const D = require("./design");
const { writeAtomic } = require("./fsx");

const MAX_STEPS = 40;
const MERGE_MS = 1500;
// В файл уходят последние шаги «Отменить» (без «Вернуть»): история переживает перезагрузку окна.
const FILE_STEPS = 15, FILE_MAX = 1024 * 1024;

const copy = (o) => JSON.parse(JSON.stringify(o));

class History {
    /** keyOf(design) -> строка-отпечаток содержимого вида (без времени и служебных полей). */
    constructor(keyOf) {
        this.keyOf = keyOf;
        this.undo = [];      // [{ snap, after }] — снимок «до» и отпечаток «после»
        this.redo = [];
        this.lastOp = "";
        this.lastAt = 0;
    }

    clear() { this.undo = []; this.redo = []; this.lastOp = ""; }

    /** Запомнить шаг: before — вид до правки, afterKey — отпечаток после, opKey — что правили (для слияния). */
    record(before, afterKey, opKey) {
        const now = Date.now();
        const top = this.undo[this.undo.length - 1];
        if (top && opKey && opKey === this.lastOp && now - this.lastAt < MERGE_MS) top.after = afterKey;
        else {
            this.undo.push({ snap: copy(before), after: afterKey });
            if (this.undo.length > MAX_STEPS) this.undo.shift();
        }
        this.redo = [];
        this.lastOp = opKey || "";
        this.lastAt = now;
    }

    /**
     * Шаг назад ("undo") или вперёд ("redo") от текущего вида current.
     * null — шагов нет; { stale: true } — вид изменили мимо истории (она сброшена);
     * { snap } — вид, к которому надо вернуться.
     */
    step(dir, current) {
        const from = dir === "redo" ? this.redo : this.undo, to = dir === "redo" ? this.undo : this.redo;
        const e = from[from.length - 1];
        if (!e) return null;
        if (e.after !== this.keyOf(current)) { this.clear(); return { stale: true }; }
        from.pop();
        to.push({ snap: copy(current), after: this.keyOf(e.snap) });
        this.lastOp = "";
        return { snap: e.snap };
    }

    summary() { return { undo: this.undo.length, redo: this.redo.length }; }

    /** Сохранить шаги отмены в файл (молча: история — удобство, а не данные). */
    save(file) {
        if (!file) return;
        try {
            const text = JSON.stringify({ v: 1, undo: this.undo.slice(-FILE_STEPS) });
            if (text.length <= FILE_MAX) writeAtomic(file, text); else { try { fs.unlinkSync(file); } catch (e) {} }
        } catch (e) { /* не записалось — история останется в памяти */ }
    }
    /** Поднять шаги из файла. Снимки проверяются как файл правок; шаг с чужим отпечатком отсеется при отмене. */
    load(file) {
        if (!file) return;
        try {
            const o = JSON.parse(fs.readFileSync(file, "utf8"));
            if (!o || !Array.isArray(o.undo)) return;
            this.undo = o.undo.slice(-FILE_STEPS).filter((e) => e && e.snap && typeof e.snap === "object" && typeof e.after === "string" && e.after.length < 2 * FILE_MAX)
                .map((e) => ({ snap: D.cleanDesign(e.snap), after: e.after }));
            this.redo = [];
        } catch (e) { /* файла нет или он битый — начинаем с пустой истории */ }
    }
}

/**
 * Привести вид движка к снимку target: настройки и цвета — через VS Code (что изменилось),
 * правила, кнопки и эффекты — как в снимке. Ошибки записи настроек копятся в errors.
 */
async function restoreDesign(engine, target, errors) {
    const cfg = engine.opts.config, d = engine.design;
    const t = { rules: target.rules || {}, settings: target.settings || {}, colors: target.colors || {}, buttons: target.buttons, fx: target.fx };
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    for (const k of Object.keys(d.settings)) {
        if (t.settings[k]) continue;
        try { await engine.undoSetting(k); } catch (e) { errors.push(k + ": " + e.message); delete d.settings[k]; }
    }
    for (const k of Object.keys(t.settings)) {
        const rec = t.settings[k];
        try {
            if (!d.settings[k] || !same(d.settings[k].value, rec.value)) await cfg.update(k, rec.value);
            d.settings[k] = copy(rec);
        } catch (e) { errors.push(k + ": " + e.message); }
    }
    for (const k of Object.keys(d.colors)) {
        if (t.colors[k]) continue;
        try { await engine.setColor(k, null); } catch (e) { errors.push(k + ": " + e.message); delete d.colors[k]; }
    }
    for (const k of Object.keys(t.colors)) {
        const rec = t.colors[k];
        try {
            if (!d.colors[k] || d.colors[k].value !== rec.value) await engine.setColor(k, rec.value, rec.label);
            d.colors[k] = copy(rec);
        } catch (e) { errors.push(k + ": " + e.message); }
    }
    d.rules = copy(t.rules);
    d.buttons = D.cleanButtons(t.buttons);
    d.fx = D.cleanFx(t.fx);
}

module.exports = { History, restoreDesign, MAX_STEPS, MERGE_MS };
