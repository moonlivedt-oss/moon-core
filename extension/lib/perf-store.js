// ============================================================
//  «Скорость VS Code»: история замеров в файле mooncore-perf.json — без vscode.
//
//  Файл общий для всех окон (globalStorage): каждое окно дописывает свои запуски и активации
//  расширений. Перед записью история перечитывается — два окна не затирают записи друг друга
//  (последнее слово остаётся за тем, кто пишет позже, но уже поверх чужих записей). Тот же
//  файл — выгрузка для внешних программ (VS Code Launcher читает поле export).
// ============================================================
"use strict";

const fs = require("fs");
const PM = require("./perf-model");
const PA = require("./perf-advice");
const { writeAtomic } = require("./fsx");

class PerfStore {
    constructor(file, log) {
        this.file = file;
        this.log = log || (() => {});
    }

    load() {
        try { return PM.cleanHistory(JSON.parse(fs.readFileSync(this.file, "utf8"))); }
        catch (e) { return PM.emptyHistory(); }
    }

    /** Изменить историю функцией fn(h) и записать (вместе с выгрузкой для внешних программ). */
    update(fn, info) {
        const h = this.load();
        try { fn(h); } catch (e) { this.log("скорость: история", e); return h; }
        const out = Object.assign({}, h, { export: PA.exportData(h, info) });
        try { writeAtomic(this.file, JSON.stringify(out, null, 1)); } catch (e) { this.log("скорость: запись истории", e); }
        return h;
    }
}

module.exports = { PerfStore };
