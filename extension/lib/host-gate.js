// ============================================================
//  Хост: запросы окна, которые доходят до VS Code.
//    - команды VS Code (mc.command, кнопки): согласие, опасные команды — каждый раз;
//    - ошибки окна -> журнал (и счётчики ошибок по сниппетам и модулям для Доктора);
//    - время запуска окна по этапам и модулям.
//  Методы подмешиваются в класс Host (lib/host.js), this — хост.
// ============================================================
"use strict";

const vscode = require("vscode");
const P = require("./protocol");
const S = require("./snippets");
const CMD = require("./commands");
const KEYS = require("./keys");
const AU = require("./audit");
const PM = require("./perf-model");
const { log, showLog } = require("./log");

const clip = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000B-\u001F]/g, " ").slice(0, n);

class GatePart {
    /** Время запуска окна: рантайм и каждый модуль (мс), пропущенные защитой запуска. */
    onWindowTiming(body) {
        const num = (v) => (typeof v === "number" && isFinite(v) && v >= 0 && v < 600000) ? v : null;
        const mods = {};
        if (body && body.modules && typeof body.modules === "object") {
            Object.keys(body.modules).slice(0, 32).forEach((k) => { const v = num(body.modules[k]); if (/^[a-z][a-z0-9-]{1,31}$/.test(k) && v != null) mods[k] = v; });
        }
        const skipped = Array.isArray(body && body.skipped) ? body.skipped.filter((k) => /^[a-z][a-z0-9-]{1,31}$/.test(String(k))).slice(0, 32) : [];
        const failed = Array.isArray(body && body.failed) ? body.failed.filter((k) => /^[a-z][a-z0-9-]{1,31}$/.test(String(k))).slice(0, 32) : [];
        // Этапы старта окна (performance.mark в рантайме): имя -> мс от начала рантайма.
        const stages = {};
        if (body && body.stages && typeof body.stages === "object" && !Array.isArray(body.stages)) {
            Object.keys(body.stages).slice(0, 16).forEach((k) => { const v = num(body.stages[k]); if (/^[a-z][\w-]{0,31}$/i.test(k) && v != null) stages[k] = v; });
        }
        this.lastTiming = { at: Date.now(), runtime: num(body && body.runtime), modules: mods, skipped: skipped, failed: failed, stages: stages };
        // Скорость VS Code: метки старта окна и подвисания (lib/ext/speed.js ведёт по ним историю).
        const win = /^[0-9a-f]{16}$/.test(String(body && body.win)) ? String(body.win) : "";
        const perf = PM.cleanPerf(body && body.perf);
        this.lastTiming.win = win;
        if (typeof this.onPerfTiming === "function") {
            try { this.onPerfTiming({ win: win, final: !!(body && body.final), vs: PM.cleanMarks(body && body.vs), perf: perf, runtime: this.lastTiming.runtime }); }
            catch (e) { log("скорость: время окна", e); }
        }
        // Вторая, полная отправка (final) несёт те же модули — чинить их второй раз не нужно.
        if (failed.length && !(body && body.final) && typeof this.onModulesFailed === "function") {
            Promise.resolve().then(() => this.onModulesFailed(failed)).catch((e) => log("модули не загрузились", e));
        }
        return { ok: true };
    }

    /**
     * Счётчик ошибок окна по источнику: сниппет, модуль или часть рантайма. Доктор показывает,
     * что падает чаще всего. Источников не больше 64 — незнакомые сверх лимита не заводятся.
     */
    countError(source) {
        if (!this.errorCounts) this.errorCounts = new Map();
        const key = clip(source, 60) || "окно";
        const rec = this.errorCounts.get(key);
        if (rec) { rec.n++; rec.last = Date.now(); return; }
        if (this.errorCounts.size >= 64) return;
        this.errorCounts.set(key, { n: 1, last: Date.now() });
    }
    /** Топ источников ошибок: [{ source, n, last }] по убыванию. */
    errorTop(n) {
        return Array.from((this.errorCounts || new Map()).entries()).map(([source, r]) => ({ source: source, n: r.n, last: r.last }))
            .sort((a, b) => b.n - a.n || b.last - a.last).slice(0, n || 10);
    }

    onWindowLog(body) {
        const where = clip(body.where, 80);
        const msg = clip(body.msg, P.MAX_LOG);
        log("окно" + (where ? " [" + where + "]" : "") + ": " + msg + (body.stack ? "\n" + clip(body.stack, P.MAX_LOG) : ""));
        const id = clip(body.snippet, 80);
        const mod = /^модуль ([a-z][a-z0-9-]{1,31})(?![a-z0-9-])/.exec(where);
        this.countError(id && S.validId(id) ? "сниппет " + id : mod ? "модуль " + mod[1] : where.split(":")[0]);
        if (id && S.validId(id)) {
            const key = id + ":" + this.state.rev;
            // Ключи — по ревизии состояния: без предела набор рос бы с каждой правкой сниппетов.
            if (this.errorsShown.size > 500) this.errorsShown.clear();
            if (!this.errorsShown.has(key)) {
                this.errorsShown.add(key);
                vscode.window.showWarningMessage("Moon Core: ошибка в сниппете " + id + ": " + clip(msg, 200), "Открыть", "Журнал").then((pick) => {
                    if (pick === "Открыть") this.open(id);
                    if (pick === "Журнал") showLog();
                });
            }
        }
        return { ok: true };
    }

    async onCommand(body) {
        const conf = vscode.workspace.getConfiguration("moonCore");
        if (!conf.get("allowCommands", true)) return { ok: false, error: "команды из окна выключены (moonCore.allowCommands)" };
        const id = String(body.id || "");
        if (!CMD.validCommand(id)) return { ok: false, error: "bad command id" };
        const from = S.validId(String(body.from || "")) ? String(body.from) : "";
        const STORE = KEYS.ALLOWED_COMMANDS;
        if (!this.deniedCommands) this.deniedCommands = new Set();
        const verdict = CMD.decide(id, { enabled: true, setting: conf.get("allowedCommands", []), stored: this.context.globalState.get(STORE), denied: this.deniedCommands });
        if (verdict === "deny") return { ok: false, error: "команда «" + id + "» запрещена" };
        if (verdict === "ask" || verdict === "confirm") {
            // Один вопрос на команду: вызовы той же команды, пришедшие, пока вопрос открыт
            // (mc.every, цикл, двойной клик), ждут тот же ответ, а не плодят диалоги.
            if (!this.commandAsks) this.commandAsks = new Map();
            const askKey = verdict + ":" + id;
            let ask = this.commandAsks.get(askKey);
            if (!ask) {
                ask = this.askCommand(id, from, verdict === "confirm").finally(() => this.commandAsks.delete(askKey));
                this.commandAsks.set(askKey, ask);
            }
            const allowed = await ask;
            if (!allowed) return { ok: false, error: "команда «" + id + "» не разрешена" };
        }
        const args = Array.isArray(body.args) ? body.args.slice(0, 10) : [];
        try {
            const result = await vscode.commands.executeCommand(id, ...args);
            let safe = null;
            try { safe = result === undefined ? null : JSON.parse(JSON.stringify(result)); } catch (e) { safe = null; }
            return { ok: true, result: safe };
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    }

    /**
     * Спросить про команду. Обычная: «всегда» — в хранилище, «запретить» — до конца сессии.
     * Опасная (commands.isDangerous): модально и только «один раз» — такое не запоминается.
     */
    async askCommand(id, from, dangerous) {
        const who = from ? "сниппет «" + from + "»" : "окно";
        if (dangerous) {
            const pick = await vscode.window.showWarningMessage(
                "Moon Core: " + who + " хочет выполнить ОПАСНУЮ команду VS Code «" + id + "» (терминал, установка расширений, git, файлы). " +
                "Такие команды не запоминаются — подтверждение каждый раз. Выполнить?", { modal: true }, "Выполнить");
            AU.record(this.context.globalState, "command", id + " (опасная, " + who + ")", pick === "Выполнить" ? "once" : "deny").catch(() => {});
            return pick === "Выполнить";
        }
        const pick = await vscode.window.showWarningMessage(
            "Moon Core: " + who + " хочет выполнить команду VS Code «" + id + "». Разрешить?",
            "Разрешить всегда", "Один раз", "Запретить");
        AU.record(this.context.globalState, "command", id + " (" + who + ")", pick === "Разрешить всегда" ? "always" : pick === "Один раз" ? "once" : "deny").catch(() => {});
        if (pick === "Разрешить всегда") {
            const list = CMD.cleanList(this.context.globalState.get(KEYS.ALLOWED_COMMANDS)).concat([id]);
            await this.context.globalState.update(KEYS.ALLOWED_COMMANDS, list);
            log("команда разрешена навсегда: " + id);
            return true;
        }
        if (pick === "Один раз") return true;
        this.deniedCommands.add(id);
        return false;
    }
}

module.exports = { Part: GatePart };
