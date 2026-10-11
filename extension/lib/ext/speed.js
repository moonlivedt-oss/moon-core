// ============================================================
//  «Скорость VS Code»: замеры, история, советы и страница.
//
//  Moon Core живёт в двух местах сразу — в процессе расширений и в окне, — поэтому видит то,
//  чего не видит внешний лаунчер: сколько стоила активация каждого расширения в этом запуске
//  (метки процесса расширений) и этапы старта окна (метки окна присылает рантайм). История
//  копится в mooncore-perf.json; по ней — замедление после обновлений и средняя стоимость
//  расширений. Модель — lib/perf-model.js и lib/perf-advice.js, вёрстка — lib/speed-page.js.
// ============================================================
"use strict";

const vscode = require("vscode");
const crypto = require("crypto");
const path = require("path");
const PM = require("../perf-model");
const PA = require("../perf-advice");
const PS = require("../perf-scan");
const SP = require("../speed-page");
const { PerfStore } = require("../perf-store");
const { storageDir } = require("../storage");
const KEYS = require("../keys");
const { log } = require("../log");

const SELF = "moonlivedt.moon-core";
// Через сколько после активации записать активации расширений этого окна в историю: к этому
// времени расширения, которые просятся на старт, уже поднялись.
const EXT_SNAPSHOT_MS = 90000;
const NOTIFY_EVERY_MS = 24 * 3600000;

/** Метки процесса расширений (тот же процесс, что у Moon Core). */
function hostMarks() {
    try { const pm = globalThis.MonacoPerformanceMarks; return pm && typeof pm.getMarks === "function" ? pm.getMarks() : []; }
    catch (e) { return []; }
}

/** Установленные расширения: id в нижнем регистре -> { id, name, builtin, kind }. */
function extInfo() {
    const out = {};
    let builtinDir = "";
    try { builtinDir = path.join(vscode.env.appRoot, "extensions").toLowerCase(); } catch (e) {}
    (vscode.extensions.all || []).forEach((e) => {
        const p = e.packageJSON || {};
        const name = typeof p.displayName === "string" && p.displayName && p.displayName[0] !== "%" ? p.displayName : String(p.name || e.id);
        const builtin = !!builtinDir && String(e.extensionPath || "").toLowerCase().indexOf(builtinDir) === 0;
        out[String(e.id).toLowerCase()] = { id: e.id, name: name, builtin: builtin, kind: PM.activationKind(p.activationEvents) };
    });
    return out;
}

class Speed {
    constructor(context, host) {
        this.context = context;
        this.host = host;
        this.store = new PerfStore(path.join(storageDir(context), "mooncore-perf.json"), log);
        this.heavy = [];
        this.scanning = false;
        this.panel = null;
        host.onPerfTiming = (t) => this.onTiming(t);
        const t = setTimeout(() => this.snapshotExt(), EXT_SNAPSHOT_MS);
        if (t.unref) t.unref();
        context.subscriptions.push({ dispose: () => clearTimeout(t) });
    }

    /** Активации расширений этого окна сейчас (с именами и тем, когда они просятся включаться). */
    liveTable() {
        const info = extInfo();
        return PM.extTable(hostMarks()).map((r) => Object.assign(r, info[r.id.toLowerCase()] || { name: r.id, builtin: false, kind: "implicit" }));
    }

    snapshotExt() {
        const table = this.liveTable().filter((r) => r.done);
        if (!table.length) return;
        const kinds = {};
        table.forEach((r) => { kinds[r.id] = r.kind; });
        this.store.update((h) => PM.addExt(h, table, kinds, Date.now()), { vscode: vscode.version });
    }

    /** Время запуска окна (из host-gate.onWindowTiming): запись в историю, при полной — проверка замедления. */
    onTiming(t) {
        if (!t || !t.win) return;
        const tl = PM.windowTimeline(t.vs);
        const phases = {};
        tl.phases.forEach((p) => { phases[p.key] = p.ms; });
        const h = this.store.update((x) => PM.addStart(x, { win: t.win, vs: vscode.version, ready: tl.ready, extensions: tl.extensions, runtime: t.runtime, phases: phases }), { vscode: vscode.version });
        if (t.final) this.checkRegression(h).catch((e) => log("скорость: замедление", e));
        if (this.panel) this.show();
    }

    /** Последний запуск заметно медленнее обычного — сказать один раз в сутки и только в окне в фокусе. */
    async checkRegression(h) {
        const r = PM.regression(h);
        if (!r || vscode.workspace.getConfiguration("moonCore").get("speedNotify", true) === false) return;
        if (vscode.window.state && vscode.window.state.focused === false) return;
        const gs = this.context.globalState;
        if (Date.now() - (gs.get(KEYS.SPEED_NOTIFIED) || 0) < NOTIFY_EVERY_MS) return;
        await gs.update(KEYS.SPEED_NOTIFIED, Date.now());
        const what = r.metric === "extensions" ? "расширения поднялись за " : "окно открылось за ";
        log("скорость: замедление — " + what + r.last + " мс (обычно " + r.median + ")");
        const pick = await vscode.window.showInformationMessage("Moon Core: VS Code запускался медленнее обычного — " + what + SP.sec(r.last) + " (обычно " + SP.sec(r.median) + ").", "Что тормозит", "Не напоминать");
        if (pick === "Что тормозит") await this.open();
        else if (pick === "Не напоминать") await vscode.workspace.getConfiguration("moonCore").update("speedNotify", false, vscode.ConfigurationTarget.Global);
    }

    /** Для Доктора: { regression, slowExt: [{ id, avg }], freezes: число окон с подвисаниями }. */
    summary() {
        const h = this.store.load();
        const info = extInfo();
        const slowExt = PM.extStats(h).filter((e) => e.n >= 2 && e.avg >= 1500 && !(info[e.id.toLowerCase()] || {}).builtin && e.id !== SELF).slice(0, 3);
        const wins = typeof this.host.windowsInfo === "function" ? this.host.windowsInfo() : [];
        return { regression: PM.regression(h), slowExt: slowExt.map((e) => ({ id: e.id, avg: e.avg })), freezes: wins.filter((w) => PM.freezeBad(w.perf)).length };
    }

    settingGet(key) {
        const i = vscode.workspace.getConfiguration().inspect(key);
        if (!i) return { exists: false };
        return { exists: true, value: vscode.workspace.getConfiguration().get(key), global: i.globalValue, workspace: i.workspaceValue };
    }

    model() {
        const h = this.store.load();
        const info = extInfo();
        const avg = {};
        PM.extStats(h).forEach((e) => { avg[e.id.toLowerCase()] = e; });
        const exts = this.liveTable().map((r) => { const a = avg[r.id.toLowerCase()]; return Object.assign(r, a ? { avg: a.avg, n: a.n } : { avg: 0, n: 0 }); });
        const stats = PM.startStats(h);
        const last = stats.last ? Object.assign({}, stats.last, { phasesList: PM.PHASES.filter((p) => stats.last.phases[p[0]] != null).map((p) => ({ key: p[0], label: p[1], ms: stats.last.phases[p[0]] })) }) : null;
        const ownWin = this.host.lastTiming && this.host.lastTiming.win;
        const slowExt = PM.extStats(h).map((e) => Object.assign(e, { builtin: !!(info[e.id.toLowerCase()] || {}).builtin }));
        this.advice = PA.advise({
            get: (k) => this.settingGet(k),
            hasWorkspace: !!(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length),
            heavy: this.heavy,
            editorsMs: PM.median(h.starts.slice(-10).map((s) => s.phases.editors)),
            slowExt: slowExt,
        });
        const undo = this.undoMap();
        this.advice = this.advice.filter((a) => !undo[a.id]);
        const self = exts.find((e) => e.id.toLowerCase() === SELF) || {};
        const lt = this.host.lastTiming || {};
        return {
            vscode: vscode.version, last: last, stats: stats, regression: PM.regression(h),
            history: h.starts.map((s) => ({ at: s.at, ready: s.ready, extensions: s.extensions })),
            windows: (typeof this.host.windowsInfo === "function" ? this.host.windowsInfo() : []).map((w) => Object.assign({}, w, { own: !!ownWin && w.win === ownWin })),
            exts: exts, advice: this.advice,
            applied: Object.keys(undo).map((id) => ({ id: id, key: undo[id].key, title: undo[id].title })),
            self: { activate: self.total || null, runtime: lt.runtime != null ? lt.runtime : null, modules: Object.keys(lt.modules || {}).reduce((n, k) => n + lt.modules[k], 0) || null },
            scanning: this.scanning, perfFile: this.store.file,
        };
    }

    undoMap() { const v = this.context.globalState.get(KEYS.SPEED_UNDO); return v && typeof v === "object" ? Object.assign({}, v) : {}; }

    async apply(id) {
        const a = (this.advice || []).find((x) => x.id === id);
        if (!a) return;
        const target = a.target === "workspace" ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        const ins = vscode.workspace.getConfiguration().inspect(a.key) || {};
        const prev = a.target === "workspace" ? ins.workspaceValue : ins.globalValue;
        const folder = a.target === "workspace" && vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.toString() : "";
        const undo = this.undoMap();
        undo[id] = { key: a.key, target: a.target, title: a.title, had: prev !== undefined, prev: prev === undefined ? null : prev, folder: folder, at: Date.now() };
        await this.context.globalState.update(KEYS.SPEED_UNDO, undo);
        await vscode.workspace.getConfiguration().update(a.key, a.value, target);
        log("скорость: применён совет " + id + " (" + a.key + ")");
        if (id === "affinity") {
            const pick = await vscode.window.showInformationMessage("Moon Core: отдельный процесс для расширений включится после перезагрузки окна.", "Перезагрузить окно");
            if (pick) await vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
    }

    async revert(id) {
        const undo = this.undoMap(), u = undo[id];
        if (!u) return;
        const here = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.toString() : "";
        if (u.target === "workspace" && u.folder && u.folder !== here) {
            vscode.window.showWarningMessage("Moon Core: этот совет применён в другой папке — открой её, чтобы вернуть настройку.");
            return;
        }
        const target = u.target === "workspace" ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        await vscode.workspace.getConfiguration().update(u.key, u.had ? u.prev : undefined, target);
        delete undo[id];
        await this.context.globalState.update(KEYS.SPEED_UNDO, undo);
        log("скорость: возвращено как было — " + u.key);
    }

    async scan() {
        const roots = (vscode.workspace.workspaceFolders || []).filter((f) => f.uri.scheme === "file").map((f) => f.uri.fsPath);
        if (!roots.length || this.scanning) return;
        this.scanning = true; this.show();
        try { this.heavy = await PS.scanHeavy(roots); } catch (e) { log("скорость: поиск тяжёлых папок", e); }
        this.scanning = false; this.show();
    }

    async exportFile() {
        const h = this.store.load();
        const uri = await vscode.window.showSaveDialog({ filters: { JSON: ["json"] }, defaultUri: vscode.Uri.file(path.join(require("os").homedir(), "moon-core-perf.json")), saveLabel: "Сохранить замеры" });
        if (!uri) return;
        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(PA.exportData(h, { vscode: vscode.version }), null, 2), "utf8"));
        vscode.window.setStatusBarMessage("Moon Core: замеры сохранены", 5000);
    }

    show() {
        if (!this.panel) return;
        const nonce = crypto.randomBytes(16).toString("base64").replace(/[^A-Za-z0-9]/g, "");
        try { this.panel.webview.html = SP.render(this.model(), nonce); } catch (e) { log("скорость: страница", e); }
    }

    async onMessage(msg) {
        const cmd = msg && SP.ACTIONS.indexOf(msg.cmd) !== -1 ? msg.cmd : "";
        const arg = String(msg && msg.arg || "").slice(0, 200);
        try {
            if (cmd === "apply") await this.apply(arg);
            else if (cmd === "revert") await this.revert(arg);
            else if (cmd === "ext" && PM.EXT_ID_RE.test(arg) && extInfo()[arg.toLowerCase()]) await vscode.commands.executeCommand("extension.open", arg);
            else if (cmd === "export") await this.exportFile();
            else if (cmd === "reveal") await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(this.store.file));
            else if (cmd === "runtime") await vscode.commands.executeCommand("workbench.action.showRuntimeExtensions");
            else if (cmd === "process") await vscode.commands.executeCommand("workbench.action.openProcessExplorer");
            else if (cmd === "startup") await vscode.commands.executeCommand("perfview.show");
            else if (cmd === "reload") await vscode.commands.executeCommand("workbench.action.reloadWindow");
            else if (cmd === "scan") await this.scan();
        } catch (e) { log("скорость: " + cmd, e); }
        this.show();
    }

    async open() {
        if (this.panel) { this.panel.reveal(); this.show(); return; }
        this.panel = vscode.window.createWebviewPanel("moonCore.speed", "Moon Core: Скорость VS Code", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: false });
        this.panel.onDidDispose(() => { this.panel = null; }, null, this.context.subscriptions);
        this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
        this.show();
        if (!this.heavy.length) this.scan().catch((e) => log("скорость: поиск тяжёлых папок", e));
    }
}

/** Подключить «Скорость VS Code»: замеры с первого же запуска, страница — по команде. */
function createSpeed(context, host) {
    const sp = new Speed(context, host);
    host.speed = sp;
    return sp;
}

module.exports = { createSpeed, Speed, extInfo, hostMarks, SELF };
