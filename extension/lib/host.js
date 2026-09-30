// ============================================================
//  Хост Moon Core: связывает мост, сниппеты, пипетку, конструктор и проверку селекторов.
//
//  Класс собран из частей (методы подмешиваются в Host.prototype):
//    host-snippets.js — сниппеты CSS/JS, одобрение JS, живой предпросмотр;
//    host-gate.js     — команды VS Code из окна (согласие), журнал и время запуска окна;
//    host-transfer.js — экспорт/импорт вида и Settings Sync;
//    host-context.js  — профили по контексту и профиль проекта;
//    host-check.js    — проверка селекторов и самолечение правок;
//    host-ui.js       — кнопки, контекст окна, шлюз к API VS Code для модулей, кнопки расширений;
//    host-vs.js       — события VS Code для модулей, код, подсветка, части окна, команды модулей;
//    host-safety.js   — безопасный режим, резервные копии, отмена правок, пульс окон.
// ============================================================
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const S = require("./snippets");
const { createBridge } = require("./bridge");
const { log } = require("./log");
const C = require("./catalog");
const D = require("./design");
const { DesignEngine } = require("./engine");
const { ModuleHub } = require("./modules");
const { backupsDir, modulesDataDir, storageDir, ensureDir, bridgeFile, stateFile, snippetsDir, metaFile, designFile, profilesFile } = require("./storage");
const { safeWatch, statKey } = require("./fsx");

const PICKED_ID = "picked.css";

const clip = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000B-\u001F]/g, " ").slice(0, n);
const SELECTOR_MAX = 600;

class Host {
    constructor(context) {
        this.context = context;
        this.dir = ensureDir(snippetsDir(context));
        ensureDir(storageDir(context));
        this.list = [];
        this.state = S.buildState([]);
        this.engine = new DesignEngine({
            designFile: designFile(context),
            profilesFile: profilesFile(context),
            backupDir: backupsDir(context),
            historyFile: path.join(storageDir(context), "mooncore-history.json"),
            log: log,
            config: {
                globalValue: (k) => { const i = vscode.workspace.getConfiguration().inspect(k); return i ? i.globalValue : undefined; },
                update: (k, v) => vscode.workspace.getConfiguration().update(k, v, vscode.ConfigurationTarget.Global),
            },
        });
        this.designQueue = Promise.resolve();   // правки конструктора выполняются строго по очереди
        this.pending = new Map();         // reqId -> resolve (ответы окна на проверку)
        this.previewTimers = new Map();
        this.errorsShown = new Set();
        this._onChange = new vscode.EventEmitter();
        this.onChange = this._onChange.event;
        this.rebuildTimer = null;
        this.bridge = createBridge({
            file: bridgeFile(context),
            dispatch: (m, b) => this.dispatch(m, b),
            hello: () => [{ event: "state", data: this.state }, { event: "focus", data: this.focusInfo() }, { event: "ctx", data: this.ctxInfo() }, { event: "moduleSet", data: this.moduleSetInfo() }].concat(this.modules.hello()),
            isFocused: () => !!(vscode.window.state && vscode.window.state.focused),
        });
        this.modules = new ModuleHub({ broadcast: (e, d) => this.bridge.broadcast(e, d), log: log, dataDir: modulesDataDir(context) });
        this.modules.onRemoved = (ids) => { this.disposeNative(ids); this.disposeVs(ids); };
        this.bridge.ready.then(() => log("мост поднят на 127.0.0.1:" + this.bridge.port)).catch((e) => log("мост не поднялся", e));
        this.rebuild();
        this.watch();
        context.subscriptions.push(this, this._onChange);
    }

    // ---------------- сниппеты ----------------

    rebuild() {
        if (this.disposed) return;
        this.lastFilesKey = this.filesKey();
        const meta = S.readMeta(metaFile(this.context));
        this.list = S.listSnippets(this.dir, meta);
        this.engine.load();
        const extra = Object.assign(this.engine.stateExtra(this.settingsNow()), { uiButtons: this.uiList() });
        // Безопасный режим: одобрение JS всё равно считается (runnable), но в окно ничего не уходит.
        // Сниппеты webview*.css — не для окна: их CSS вписывается в основу webview при внедрении.
        const run = this.runnable(this.list).filter((s) => !S.isWebview(s.id)), safe = this.safeMode();
        const wvKey = this.list.filter((s) => S.isWebview(s.id)).map((s) => s.id + ":" + s.enabled + ":" + s.size + ":" + s.code.length).join("|");
        if (this.webviewKey !== undefined && this.webviewKey !== wvKey && typeof this.onWebviewCss === "function") {
            clearTimeout(this.webviewTimer);
            this.webviewTimer = setTimeout(() => { try { this.onWebviewCss(); } catch (e) { log("стили webview", e); } }, 800);
        }
        this.webviewKey = wvKey;
        const next = S.buildState(safe ? [] : run, safe ? this.safeExtra(extra) : extra);
        try { S.writeState(stateFile(this.context), next); } catch (e) { log("запись состояния", e); }
        const changed = next.rev !== this.state.rev;
        this.state = next;
        if (changed) this.bridge.broadcast("state", this.slimState(next));
        this._onChange.fire();
        this.scheduleSyncOut();
    }

    get design() { return this.engine.design; }

    settingsNow() {
        const conf = vscode.workspace.getConfiguration();
        const out = {};
        Object.keys(C.SETTINGS).forEach((k) => { try { const v = conf.get(k); if (v !== undefined) out[k] = v; } catch (e) {} });
        // Цвета темы: окну нужны заданные значения (что уже перекрашено), а не вся тема.
        Object.keys(D.COLOR_CONF).forEach((p) => {
            const k = D.COLOR_CONF[p];
            try { const i = conf.inspect(k); const v = i && i.globalValue; if (v && typeof v === "object") out[k] = v; } catch (e) {}
        });
        return out;
    }

    scheduleRebuild() {
        if (this.disposed) return;
        clearTimeout(this.rebuildTimer);
        this.rebuildTimer = setTimeout(() => this.rebuild(), 150);
    }

    /**
     * Отпечаток файлов, из которых собирается состояние: имена, время изменения и размер
     * сниппетов плюс файлы конструктора. Опрос раз в 15 с пересобирает состояние только если
     * он изменился — иначе каждые 15 с перечитывались бы все сниппеты и профили.
     */
    filesKey() {
        let names = [];
        try { names = fs.readdirSync(this.dir).filter((n) => S.validId(n)).sort(); } catch (e) {}
        return names.join(",") + "#" + statKey(names.map((n) => path.join(this.dir, n))) + "#" +
            statKey([metaFile(this.context), designFile(this.context), profilesFile(this.context)]);
    }

    watch() {
        const onEvent = (name) => { if (!name || S.validId(String(name)) || name === path.basename(metaFile(this.context))) this.scheduleRebuild(); };
        try { this.dirWatcher = safeWatch(this.dir, (ev, name) => onEvent(name), (e) => log("слежение за папкой сниппетов", e)); } catch (e) { log("слежение за папкой сниппетов", e); }
        try {
            const watched = [path.basename(metaFile(this.context)), path.basename(designFile(this.context)), path.basename(profilesFile(this.context))];
            this.metaWatcher = safeWatch(storageDir(this.context), (ev, name) => { if (watched.indexOf(String(name)) !== -1) this.scheduleRebuild(); }, (e) => log("слежение за хранилищем", e));
        } catch (e) { log("слежение за хранилищем", e); }
        // Страховка: fs.watch на некоторых дисках теряет события. Дёшево: только stat.
        this.pollTimer = setInterval(() => { if (this.filesKey() !== this.lastFilesKey) this.rebuild(); }, 15000);

        const subs = this.context.subscriptions;
        // Окно этого хоста получило фокус — сообщаем всем окнам: то, что сейчас в фокусе,
        // запомнит этот хост как «свой» (для событий модулей с scope "window").
        subs.push(vscode.window.onDidChangeWindowState((s) => { if (s.focused) this.bridge.broadcast("focus", this.focusInfo()); }));
        subs.push(vscode.workspace.onDidChangeTextDocument((e) => this.onDocChange(e.document)));
        // Настройку из каталога поменяли где угодно (settings.json, UI) — панель конструктора должна это видеть.
        subs.push(vscode.workspace.onDidChangeConfiguration((e) => {
            if (Object.keys(C.SETTINGS).concat(Object.values(D.COLOR_CONF)).some((k) => e.affectsConfiguration(k))) this.scheduleRebuild();
            if (e.affectsConfiguration("moonCore.sync") && this.syncEnabled()) this.scheduleSyncOut();
            // Settings Sync принёс вид с другой машины: наша же запись сюда не попадёт (совпадёт с локальным).
            if (e.affectsConfiguration("moonCore.syncData") && this.syncEnabled() && !this.syncImporting) this.notifySyncChanged();
        }));
        subs.push(vscode.workspace.onDidCloseTextDocument((d) => { if (this.snippetIdOf(d)) this.sendPreview(this.snippetIdOf(d), null); }));
        // Сохранили — превью больше не нужно: сразу новое состояние и отмена превью.
        subs.push(vscode.workspace.onDidSaveTextDocument(async (d) => {
            const id = this.snippetIdOf(d);
            if (!id) return;
            if (S.kindOf(id) === "js") await this.approveJs(id, d.getText()); // код видели в редакторе
            this.rebuild();
            this.sendPreview(id, null);
        }));
    }

    // ---------------- запросы окна ----------------

    /**
     * Запрос окна -> обработчик. Таблица (а не цепочка if): метод из протокола без обработчика
     * виден сразу (тест сверяет её с P.METHODS), порядок проверок не важен.
     */
    rpcTable() {
        if (this._rpc) return this._rpc;
        this._rpc = {
            module: (b) => this.modules.dispatch(b),
            moduleData: (b) => this.modules.saveFromWindow(b),
            focus: () => Object.assign({ ok: true }, this.focusInfo()),
            log: (b) => this.onWindowLog(b),
            timing: (b) => this.onWindowTiming(b),
            pickCommand: () => this.pickCommandForButton(),
            native: (b) => this.onNative(b),
            uiClick: (b) => this.onUiClick(b),
            vsSubscribe: (b) => this.vsSubscribe(b),
            modCommands: (b) => this.modCommandsFromWindow(b),
            hello: (b) => this.onHello(b),
            context: () => Object.assign({ ok: true }, this.ctxInfo()),
            uiFailed: (b) => typeof this.onUiFailed === "function" ? this.onUiFailed(b) : { ok: false, error: "нет обработчика" },
            // Код модуля отдаётся только в режиме разработки (его включает пользователь командой).
            // Ленивый модуль: файл рядом с оболочкой пропал или изменился (модуль обновило другое
            // окно) — окно берёт одобренный код у хоста. Только разрешённый модуль с одобренным кодом.
            moduleCode: (b) => {
                const id = String(b && b.id || "");
                let code = typeof this.devModuleCode === "function" ? this.devModuleCode(id) : null;
                if (typeof code !== "string" && b && b.lazy === true && this.modules.has(id) && typeof this.moduleCodeFor === "function") code = this.moduleCodeFor(id);
                return typeof code === "string" ? { ok: true, code: code } : { ok: false, error: "модуль " + id.slice(0, 40) + " не в режиме разработки" };
            },
            command: (b) => this.onCommand(b),
            picked: (b) => this.onPicked(b),
            design: (b) => this.onDesign(b),
            report: (b) => {
                const res = this.pending.get(String(b.reqId || ""));
                if (res) res(b);
                return { ok: true };
            },
        };
        return this._rpc;
    }

    async dispatch(method, body) {
        const fn = Object.prototype.hasOwnProperty.call(this.rpcTable(), method) ? this.rpcTable()[method] : null;
        return fn ? fn(body) : { ok: false, error: "unknown method" };
    }

    async onPicked(body) {
        const sel = clip(body.selector, SELECTOR_MAX).trim();
        if (!sel || /[{}]/.test(sel) || /\/\*|\*\//.test(sel)) return { ok: false, error: "bad selector" };
        const info = body.info && typeof body.info === "object" ? body.info : {};
        const label = clip(info.label, 80).replace(/\*\//g, "");
        const action = String(body.action || "");
        if (action === "copy") {
            await vscode.env.clipboard.writeText(sel);
            vscode.window.setStatusBarMessage("Moon Core: селектор скопирован", 3000);
            return { ok: true };
        }
        if (action === "hide") {
            const r = await this.onDesign({ ops: [{ op: "set", selector: sel, prop: "hide", value: true, label: label, fp: body.fp }] });
            if (r.ok) vscode.window.setStatusBarMessage("Moon Core: скрыто. Вернуть — в конструкторе, вкладка «Правки»", 5000);
            return r;
        }
        if (action === "style") {
            const hint = clip(info.style, 400).replace(/\*\//g, "");
            const active = vscode.window.activeTextEditor;
            const activeId = active ? this.snippetIdOf(active.document) : "";
            const target = activeId && S.kindOf(activeId) === "css" ? activeId : PICKED_ID;
            const text = "/* " + (label || "элемент") + " */\n" + sel + " {\n" + (hint ? "  /* сейчас: " + hint + " */\n" : "") + "  \n}\n";
            await this.appendViaEditor(target, text, { reveal: true, cursorFromEnd: 2 });
            return { ok: true };
        }
        return { ok: false, error: "unknown action" };
    }

    // ---------------- конструктор ----------------

    /** Правки конструктора: CSS-свойства элементов и настройки VS Code из каталога. */
    onDesign(body) {
        // «Вид целиком» (restore) окну не положен: его шлёт только сам хост (резервные копии).
        return this.designInternal((Array.isArray(body && body.ops) ? body.ops.slice(0, 200) : []).filter((o) => !o || o.op !== "restore"));
    }
    designInternal(ops) {
        const run = () => this.applyDesign(ops);
        this.designQueue = this.designQueue.then(run, run);
        return this.designQueue;
    }

    async applyDesign(ops) {
        const r = await this.engine.apply(ops);
        this.rebuild();
        // Профиль несёт состояние модулей (фон vscode-bg и т.п.) — отдаём его окнам: каждый
        // модуль применит свою часть сам (помощник mc.profile в рантайме).
        (r.applied || []).forEach((a) => { if (Object.keys(a.modules).length) this.bridge.broadcast("profile", a); });
        return { ok: r.ok, error: r.error, design: this.state.design, settingsNow: this.state.settingsNow, profiles: this.state.profiles, history: this.state.history, rev: this.state.rev };
    }

    /** Быстрое переключение профиля вида (QuickPick). */
    async pickProfile() {
        const sum = this.engine.summary();
        const items = sum.list.map((p) => ({
            label: (p.name === sum.active ? "$(check) " : "") + p.name,
            description: (p.builtin ? "встроенный" : "свой") + (p.name === sum.active && sum.dirty ? ", изменён" : ""),
            detail: p.note || ("элементов: " + p.rules + ", настроек: " + p.settings),
            name: p.name,
        }));
        items.push({ label: "$(discard) Исходный вид VS Code", description: "сбросить всё", name: "" });
        const pick = await vscode.window.showQuickPick(items, { placeHolder: "Профиль вида — текущие правки заменятся" + (sum.dirty ? " (активный профиль изменён: сохрани его в конструкторе, если нужен)" : "") });
        if (!pick) return;
        const r = await this.onDesign({ ops: [pick.name ? { op: "applyProfile", name: pick.name } : { op: "clearAll" }] });
        if (!r.ok) vscode.window.showWarningMessage("Moon Core: " + r.error);
        else vscode.window.setStatusBarMessage("Moon Core: " + (pick.name ? "профиль «" + pick.name + "»" : "исходный вид"), 4000);
    }

    toggleDesign() {
        if (this.safeMode()) {
            vscode.window.showWarningMessage("Moon Core: включён безопасный режим — правки конструктора сейчас не применяются.", "Выйти из безопасного режима").then((p) => { if (p) this.safeModeCommand(); });
            return;
        }
        if (!this.bridge.status().streams) {
            vscode.window.showWarningMessage("Moon Core: окно не подключено к мосту. Проверь, что рантайм внедрён (Moon Core: Диагностика).");
            return;
        }
        this.bridge.broadcast("design", { toggle: true, host: this.hostRef() });
    }

    async resetDesign() {
        const n = this.engine.editCount();
        if (!n) { vscode.window.showInformationMessage("Moon Core: изменений конструктора нет."); return; }
        const pick = await vscode.window.showWarningMessage("Сбросить все изменения конструктора (" + n + ")? Настройки VS Code вернутся к исходным значениям.", { modal: true }, "Сбросить");
        if (pick === "Сбросить") await this.onDesign({ ops: [{ op: "clearAll" }] });
    }

    // ---------------- команды хоста ----------------

    hostRef() { return { port: this.bridge.port, token: this.bridge.token }; }

    /** Какие модули разрешены сейчас: окно выключает остальные и включает вернувшиеся без перезагрузки. */
    moduleSetInfo() { return { ids: this.safeMode() ? [] : Array.from(this.modules.known.keys()) }; }
    broadcastModuleSet() { this.bridge.broadcast("moduleSet", this.moduleSetInfo()); if (this.updateCommandContext) this.updateCommandContext(); }

    focusInfo() { return { focused: !!(vscode.window.state && vscode.window.state.focused) }; }

    pick() {
        if (!this.bridge.status().streams) {
            vscode.window.showWarningMessage("Moon Core: окно не подключено к мосту. Проверь, что рантайм внедрён (Moon Core: Диагностика).");
            return;
        }
        this.bridge.broadcast("pick", { on: true, host: this.hostRef() });
    }

    reloadAll() { this.rebuild(); this.bridge.broadcast("reload", { rev: this.state.rev }); }

    dispose() {
        this.disposed = true;
        // Все отложенные дела частей хоста: после выгрузки они не должны трогать API VS Code.
        ["rebuildTimer", "ctxTimer", "autoTimer", "syncTimer", "syncNotifyTimer", "webviewTimer"].forEach((k) => clearTimeout(this[k]));
        ["pollTimer", "timeTimer"].forEach((k) => clearInterval(this[k]));
        for (const res of this.pending.values()) { try { res(null); } catch (e) {} }
        this.pending.clear();
        for (const t of this.previewTimers.values()) clearTimeout(t);
        try { this.dirWatcher && this.dirWatcher.close(); } catch (e) {}
        try { this.metaWatcher && this.metaWatcher.close(); } catch (e) {}
        this.bridge.dispose();
    }
}

/** Подмешать методы части в класс (геттеры и async-методы переносятся как есть). */
function mixin(target, part) {
    Object.getOwnPropertyNames(part.prototype).forEach((k) => {
        if (k === "constructor") return;
        if (Object.prototype.hasOwnProperty.call(target.prototype, k)) throw new Error("host: метод " + k + " объявлен дважды");
        Object.defineProperty(target.prototype, k, Object.getOwnPropertyDescriptor(part.prototype, k));
    });
}
[require("./host-snippets"), require("./host-gate"), require("./host-transfer"), require("./host-context"), require("./host-check"), require("./host-ui"), require("./host-vs"), require("./host-safety")].forEach((m) => mixin(Host, m.Part));

module.exports = { Host, PICKED_ID };
