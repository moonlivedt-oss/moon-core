// ============================================================
//  Хост: страховки.
//    - безопасный режим: окно работает без сниппетов, правил конструктора, эффектов и модулей
//      (настройки VS Code не трогаются) — чтобы выйти из любой поломки вида, ничего не удаляя;
//    - резервные копии вида и восстановление из них (lib/backups.js);
//    - «Отменить» / «Вернуть» правку конструктора командами;
//    - пульс окон: какие окна на связи и какая версия рантайма в каждом (метод моста "hello");
//    - облегчённое состояние для рассылки: каталог и описания свойств окно уже получило.
//  Методы подмешиваются в класс Host (lib/host.js), this — хост.
// ============================================================
"use strict";

const vscode = require("vscode");
const BK = require("./backups");
const KEYS = require("./keys");
const { log } = require("./log");
const { backupsDir } = require("./storage");
const fs = require("fs");
const path = require("path");
const S = require("./snippets");
const { cleanPerf } = require("./perf-model");

const WIN_ID_RE = /^[0-9a-f]{8,32}$/;
const WINDOW_TTL_MS = 150000;        // окно шлёт пульс раз в минуту; молчит дольше — считаем закрытым
// Поля состояния, которые не меняются между правками: уходят в файл состояния и в приветствие
// потока, а в рассылку после каждой правки — нет (это десятки КБ на каждое движение ползунка).
const STATIC_FIELDS = ["catalog", "zones", "props", "fxSpec", "tokenGroups"];

const clip = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001F]/g, " ").slice(0, n);

class SafetyPart {
    // ---------------- безопасный режим ----------------

    safeMode() { return this.context.globalState.get(KEYS.SAFE_MODE) === true; }

    /** Состояние для окна в безопасном режиме: без сниппетов, правил, кнопок и эффектов. */
    safeExtra(extra) {
        const d = extra.design || {};
        return Object.assign({}, extra, { safe: true, uiButtons: [], design: { rules: {}, settings: d.settings || {}, colors: d.colors || {}, buttons: [], fx: {}, css: "" } });
    }

    async setSafeMode(on) {
        await this.context.globalState.update(KEYS.SAFE_MODE, on ? true : undefined);
        log("безопасный режим: " + (on ? "включён" : "выключен"));
        this.rebuild();
        this.broadcastModuleSet();
    }

    /** Команда «Безопасный режим». */
    async safeModeCommand() {
        if (this.safeMode()) {
            await this.setSafeMode(false);
            const pick = await vscode.window.showInformationMessage("Moon Core: безопасный режим выключен — сниппеты, правки и модули снова работают. Если что-то не вернулось, перезагрузи окно.", "Перезагрузить окно");
            if (pick) await vscode.commands.executeCommand("workbench.action.reloadWindow");
            return;
        }
        const pick = await vscode.window.showWarningMessage("Включить безопасный режим Moon Core?", {
            modal: true,
            detail: "Во всех окнах VS Code отключатся сниппеты, правки конструктора, эффекты и модули. Ничего не удаляется: " +
                "выключишь режим — всё вернётся. Настройки VS Code, которые менял конструктор, остаются как есть.\n\n" +
                "Пригодится, если после правки интерфейс стал непригодным: войди в режим, открой «Профили вида» или резервные копии и верни рабочий вид.",
        }, "Включить");
        if (pick === "Включить") await this.setSafeMode(true);
    }

    // ---------------- резервные копии и история ----------------

    /** Команда «Восстановить вид из резервной копии». */
    async restoreBackupCommand() {
        const list = BK.list(backupsDir(this.context));
        if (!list.length) {
            vscode.window.showInformationMessage("Moon Core: резервных копий вида пока нет. Они появляются сами — перед применением профиля, сбросом и загрузкой вида из файла.");
            return false;
        }
        const p = (n) => String(n).padStart(2, "0");
        const when = (t) => { const d = new Date(t); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()); };
        const items = list.map((b) => ({
            label: "$(history) " + when(b.at), description: b.title,
            detail: "правок: " + b.edits + " (элементов " + Object.keys(b.design.rules).length + ", настроек " + Object.keys(b.design.settings).length + ", цветов " + Object.keys(b.design.colors).length + ")",
            backup: b,
        }));
        const pick = await vscode.window.showQuickPick(items, { placeHolder: "Вернуть вид из копии — текущий вид тоже уйдёт в копию, его можно будет вернуть", matchOnDescription: true });
        if (!pick) return false;
        const r = await this.designInternal([{ op: "restore", design: pick.backup.design }]);
        if (r.ok) vscode.window.setStatusBarMessage("Moon Core: вид восстановлен из копии от " + when(pick.backup.at), 5000);
        else vscode.window.showWarningMessage("Moon Core: вид восстановлен с ошибками: " + r.error);
        return true;
    }

    /** Команда «Восстановить сниппеты из копии»: наборы, отложенные перед перезаписью при загрузке вида. */
    async restoreSnippetsCommand() {
        const sets = BK.snippetSets(backupsDir(this.context));
        if (!sets.length) { vscode.window.showInformationMessage("Moon Core: копий сниппетов пока нет. Они появляются, когда загрузка вида перезаписывает сниппеты с теми же именами."); return false; }
        const p = (n) => String(n).padStart(2, "0");
        const when = (t) => { const d = new Date(t); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()); };
        const set = await vscode.window.showQuickPick(sets.map((s) => ({ label: "$(history) " + when(s.at), description: "файлов: " + s.files.length, detail: s.files.join(", ").slice(0, 200), set: s })),
            { placeHolder: "Копии сниппетов — какой набор вернуть" });
        if (!set) return false;
        const picks = await vscode.window.showQuickPick(set.set.files.map((f) => ({ label: f, picked: true })), { canPickMany: true, placeHolder: "Какие сниппеты вернуть (нынешние версии тоже уйдут в копию)" });
        if (!picks || !picks.length) return false;
        const ids = picks.map((x) => x.label).filter((id) => S.validId(id));
        try { BK.saveSnippets(backupsDir(this.context), ids.map((id) => path.join(this.dir, id))); } catch (e) { log("копия сниппетов", e); }
        ids.forEach((id) => { try { fs.copyFileSync(path.join(set.set.dir, id), path.join(this.dir, id)); } catch (e) { log("восстановление сниппета " + id, e); } });
        this.rebuild();          // JS из копии не одобрен: Moon Core спросит, прежде чем запускать
        vscode.window.setStatusBarMessage("Moon Core: сниппетов восстановлено: " + ids.length, 5000);
        return true;
    }

    /** Команды «Отменить правку» / «Вернуть правку» (то же, что кнопки в конструкторе). */
    async historyCommand(dir) {
        const r = await this.onDesign({ ops: [{ op: dir === "redo" ? "redo" : "undo" }] });
        if (r.ok) vscode.window.setStatusBarMessage("Moon Core: " + (dir === "redo" ? "правка возвращена" : "правка отменена"), 3000);
        else vscode.window.setStatusBarMessage("Moon Core: " + r.error, 4000);
        return r.ok;
    }

    // ---------------- пульс окон ----------------

    /** Окно сообщает о себе: { win, version, rev, safe }. Ответ — версия расширения. */
    onHello(body) {
        const win = String(body && body.win || "");
        if (!WIN_ID_RE.test(win)) return { ok: false, error: "bad window id" };
        if (!this.windows) this.windows = new Map();
        if (!this.windows.has(win) && this.windows.size >= 64) return { ok: false, error: "too many windows" };
        this.windows.set(win, { version: clip(body.version, 40), rev: clip(body.rev, 40), at: Date.now(), perf: cleanPerf(body.perf) });
        return { ok: true, version: this.extVersion() };
    }

    extVersion() { try { return String(this.context.extension.packageJSON.version || ""); } catch (e) { return ""; } }

    /** Окна на связи: [{ win, version, stale, perf }] (stale — рантайм окна не той версии, что расширение; perf — подвисания и память). */
    windowsInfo() {
        const now = Date.now(), ver = this.extVersion(), out = [];
        (this.windows || new Map()).forEach((w, id) => {
            if (now - w.at > WINDOW_TTL_MS) { this.windows.delete(id); return; }
            out.push({ win: id, version: w.version, stale: !!ver && !!w.version && w.version !== ver, perf: w.perf || null });
        });
        return out;
    }

    // ---------------- облегчённое состояние ----------------

    slimState(state) {
        const out = Object.assign({}, state);
        STATIC_FIELDS.forEach((k) => { delete out[k]; });
        return out;
    }
}

module.exports = { Part: SafetyPart, STATIC_FIELDS, WINDOW_TTL_MS };
