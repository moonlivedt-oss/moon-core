// ============================================================
//  Хост: VS Code для модулей — события редактора в окно, подсказки языкового сервера, подсветка
//  кода, части окна, вкладки и команды модулей (палитра и контекстное меню редактора).
//
//  События идут только туда, где на них подписались: окно шлёт vsSubscribe { id, kinds } и
//  подтверждает подписку раз в минуту; без подтверждения за SUB_TTL_MS она гаснет. Событие
//  "vs" { kind, data, full, readers }: data — базовая часть, full — то, что требует права
//  (editor.read), readers — модули с этим правом (окно отдаёт full только им).
//  Методы подмешиваются в класс Host (lib/host.js), this — хост.
// ============================================================
"use strict";

const vscode = require("vscode");
const path = require("path");
const VM = require("./vs-model");
const MF = require("./module-manifest");
const MH = require("./module-host");
const { log } = require("./log");

const MOD_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

class VsPart {
    /** Права модуля id: объявлены в манифесте и одобрены. */
    modCaps(id) {
        const m = this.modules.known.get(id);
        return m ? MH.capsOf(this.context, m) : [];
    }
    hasCap(id, cap) { return this.modCaps(id).indexOf(cap) !== -1; }

    // ---------------- подписки ----------------

    /** Окно: модуль id хочет события kinds. Отвечает, что подписано, и сразу шлёт текущее. */
    vsSubscribe(body) {
        const id = String(body && body.id || "");
        if (!MOD_ID_RE.test(id) || !this.modules.has(id)) return { ok: false, error: "unknown module" };
        const kinds = VM.cleanKinds(body.kinds);
        if (!this.vsSubs) this.vsSubs = new Map();
        const until = Date.now() + VM.SUB_TTL_MS;
        const fresh = [];
        kinds.forEach((k) => {
            let m = this.vsSubs.get(k);
            if (!m) { m = new Map(); this.vsSubs.set(k, m); }
            if (!(m.get(id) > Date.now())) fresh.push(k);
            m.set(id, until);
        });
        // Новая подписка — сразу текущее значение (окно могло подключиться посреди работы).
        fresh.forEach((k) => { this.vsLast && this.vsLast.delete(k); this.vsEmit(k); });
        return { ok: true, kinds: kinds, full: kinds.filter((k) => !VM.KINDS[k].cap || this.hasCap(id, VM.KINDS[k].cap)) };
    }
    /** Живые подписчики события kind (id модулей). */
    vsSubscribers(kind) {
        const m = this.vsSubs && this.vsSubs.get(kind);
        if (!m) return [];
        const t = Date.now();
        return Array.from(m.entries()).filter((e) => e[1] > t && this.modules.has(e[0])).map((e) => e[0]);
    }

    /** Разослать событие kind, если на него подписаны и оно изменилось. */
    vsEmit(kind) {
        if (this.disposed) return;
        const subs = this.vsSubscribers(kind);
        if (!subs.length) return;
        const cap = VM.KINDS[kind].cap || "editor.read";
        const readers = subs.filter((id) => this.hasCap(id, cap));
        let snap;
        try { snap = this.vsSnapshot(kind, readers.length > 0); } catch (e) { log("события VS Code: " + kind, e); return; }
        if (!snap) return;
        const key = JSON.stringify(snap);
        if (!this.vsLast) this.vsLast = new Map();
        if (kind !== "save" && this.vsLast.get(kind) === key) return;
        this.vsLast.set(kind, key);
        this.bridge.broadcast("vs", { kind: kind, data: snap.data, full: readers.length ? snap.full : null, readers: readers });
    }
    vsSoon(kind, ms) {
        if (!this.vsTimers) this.vsTimers = new Map();
        clearTimeout(this.vsTimers.get(kind));
        this.vsTimers.set(kind, setTimeout(() => this.vsEmit(kind), ms));
    }

    /** Снимок события: { data, full }. full считается, только если есть читатель с правом. */
    vsSnapshot(kind, withFull) {
        const ed = vscode.window.activeTextEditor;
        const doc = ed && ed.document;
        const fileOf = (d) => (d ? { file: path.basename(d.fileName || d.uri.path || ""), lang: d.languageId, scheme: d.uri.scheme } : null);
        if (kind === "editor") {
            const ext = doc ? path.extname(doc.fileName || doc.uri.path || "").replace(".", "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 16) : "";
            return { data: doc ? Object.assign(fileOf(doc), { ext: ext, dirty: doc.isDirty, lines: doc.lineCount }) : null, full: withFull && doc ? { path: doc.uri.scheme === "file" ? doc.uri.fsPath : doc.uri.toString() } : null };
        }
        if (kind === "save") return this.vsSaved ? { data: fileOf(this.vsSaved), full: withFull ? { path: this.vsSaved.uri.fsPath } : null } : null;
        if (kind === "cursor") {
            if (!ed) return { data: null, full: null };
            const sel = ed.selection, pos = sel.active;
            const data = { line: pos.line, col: pos.character, selections: ed.selections.length, empty: sel.isEmpty };
            if (!withFull) return { data: data, full: null };
            const wr = doc.getWordRangeAtPosition(pos);
            return { data: data, full: { word: wr ? doc.getText(wr).slice(0, 200) : "", selection: sel.isEmpty ? "" : doc.getText(sel).slice(0, VM.MAX_SELECTION), lineText: doc.lineAt(pos.line).text.slice(0, 500) } };
        }
        if (kind === "diagnostics") {
            const list = doc ? vscode.languages.getDiagnostics(doc.uri) : [];
            const S = vscode.DiagnosticSeverity;
            const count = (s) => list.filter((d) => d.severity === s).length;
            // Итог по всему проекту (как счётчик в статусбаре VS Code): ошибки в других файлах тоже.
            let totalErrors = 0, totalWarnings = 0;
            try {
                vscode.languages.getDiagnostics().forEach((pair) => (pair[1] || []).forEach((d) => {
                    if (d.severity === S.Error) totalErrors++;
                    else if (d.severity === S.Warning) totalWarnings++;
                }));
            } catch (e) {}
            return {
                data: { errors: count(S.Error), warnings: count(S.Warning), infos: count(S.Information) + count(S.Hint), totalErrors: totalErrors, totalWarnings: totalWarnings },
                full: withFull ? { items: list.slice(0, 50).map((d) => ({ line: d.range.start.line, col: d.range.start.character, severity: d.severity, message: String(d.message).slice(0, 300), source: String(d.source || "").slice(0, 60) })) } : null,
            };
        }
        if (kind === "debug") {
            const s = vscode.debug.activeDebugSession;
            return { data: { active: !!s, name: s ? String(s.name).slice(0, 80) : "", type: s ? String(s.type).slice(0, 40) : "" }, full: null };
        }
        if (kind === "terminal") {
            const t = vscode.window.activeTerminal;
            return { data: { count: vscode.window.terminals.length, active: t ? String(t.name).slice(0, 80) : "" }, full: null };
        }
        if (kind === "task") {
            return { data: { running: vscode.tasks.taskExecutions.map((e) => String(e.task.name).slice(0, 80)).slice(0, 20) }, full: null };
        }
        if (kind === "git") {
            const c = this.contextNow();
            let changes = 0, remote = "";
            try {
                const ext = vscode.extensions.getExtension("vscode.git");
                const api = ext && ext.isActive ? ext.exports.getAPI(1) : null;
                // Репозиторий активного файла (как ветка в contextNow), иначе первый.
                const repo = api && ((doc && doc.uri.scheme === "file" && api.getRepository(doc.uri)) || api.repositories[0]);
                if (repo) {
                    changes = repo.state.workingTreeChanges.length + repo.state.indexChanges.length;
                    remote = VM.remoteShort(repo.state.remotes);
                }
            } catch (e) {}
            const folder = (vscode.workspace.workspaceFolders || [])[0];
            return { data: { branch: c.branch, changes: changes, remote: remote, folder: folder ? String(folder.name).slice(0, 120) : "" }, full: null };
        }
        if (kind === "theme") {
            return { data: { kind: this.contextNow().theme, name: String(vscode.workspace.getConfiguration("workbench").get("colorTheme") || "").slice(0, 80) }, full: null };
        }
        return null;
    }

    /** Слушать VS Code (один раз при активации). Дёшево: события считаются, только если есть подписчики. */
    watchVs() {
        const subs = this.context.subscriptions;
        const on = (ev, fn) => { try { if (ev) subs.push(ev(fn)); } catch (e) { log("события VS Code", e); } };
        on(vscode.window.onDidChangeActiveTextEditor, () => { this.vsEmit("editor"); this.vsSoon("cursor", 50); this.vsSoon("diagnostics", 50); this.updateCommandContext(); });
        on(vscode.window.onDidChangeTextEditorSelection, () => this.vsSoon("cursor", 120));
        on(vscode.workspace.onDidChangeTextDocument, (e) => { const d = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document; if (d && e.document === d) this.vsSoon("editor", 300); });
        on(vscode.workspace.onDidSaveTextDocument, (d) => { this.vsSaved = d; this.vsEmit("save"); this.vsSoon("editor", 50); });
        on(vscode.languages.onDidChangeDiagnostics, () => this.vsSoon("diagnostics", 300));
        on(vscode.debug.onDidStartDebugSession, () => this.vsEmit("debug"));
        on(vscode.debug.onDidTerminateDebugSession, () => this.vsSoon("debug", 50));
        on(vscode.debug.onDidChangeActiveDebugSession, () => this.vsEmit("debug"));
        on(vscode.window.onDidOpenTerminal, () => this.vsEmit("terminal"));
        on(vscode.window.onDidCloseTerminal, () => this.vsSoon("terminal", 50));
        on(vscode.window.onDidChangeActiveTerminal, () => this.vsEmit("terminal"));
        on(vscode.tasks.onDidStartTask, () => this.vsEmit("task"));
        on(vscode.tasks.onDidEndTask, () => this.vsSoon("task", 50));
        on(vscode.window.onDidChangeActiveColorTheme, () => this.vsSoon("theme", 100));
        // git: контекст окна уже следит за репозиторием (host-context) — там же дёргаем и это.
        this.gitChanged = () => this.vsSoon("git", 300);
        subs.push({ dispose: () => { if (this.vsTimers) this.vsTimers.forEach((t) => clearTimeout(t)); } });
        this.updateCommandContext();
    }

    // ---------------- шлюз: код, подсветка, части окна, вкладки ----------------

    /** Операции шлюза сверх базовых (host-ui onNative): null — не наша операция. */
    async onNativeVs(id, name, op, body) {
        if (op === "symbol") {
            if (!this.hasCap(id, "editor.read")) return { ok: false, error: "нет права editor.read" };
            const ed = vscode.window.activeTextEditor;
            if (!ed) return { ok: true, result: null };
            const doc = ed.document, pos = ed.selection.active;
            const what = String(body.what || "word");
            if (what === "word") { const r = doc.getWordRangeAtPosition(pos); return { ok: true, result: r ? doc.getText(r) : "" }; }
            if (what === "hover") return { ok: true, result: VM.hoverText(await vscode.commands.executeCommand("vscode.executeHoverProvider", doc.uri, pos)) };
            if (what === "definition") {
                const defs = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", doc.uri, pos) || [];
                return { ok: true, result: defs.slice(0, 20).map((d) => { const uri = d.targetUri || d.uri, r = d.targetRange || d.range; return { path: uri && uri.fsPath, line: r ? r.start.line : 0, col: r ? r.start.character : 0 }; }) };
            }
            if (what === "symbols") return { ok: true, result: VM.flatSymbols(await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", doc.uri)) };
            return { ok: false, error: "what: word | hover | definition | symbols" };
        }
        if (op === "decorate" || op === "undecorate") {
            if (!this.hasCap(id, "decorations")) return { ok: false, error: "нет права decorations" };
            return this.decorate(id, op, body);
        }
        if (op === "layout") {
            if (!this.hasCap(id, "layout")) return { ok: false, error: "нет права layout" };
            const cmd = Object.prototype.hasOwnProperty.call(VM.LAYOUT, body.part) ? VM.LAYOUT[body.part] : "";
            if (!cmd) return { ok: false, error: "part: " + Object.keys(VM.LAYOUT).join(" | ") };
            await vscode.commands.executeCommand(cmd);
            return { ok: true };
        }
        if (op === "tabs") {
            const full = this.hasCap(id, "editor.read");
            const groups = (vscode.window.tabGroups && vscode.window.tabGroups.all) || [];
            return { ok: true, result: groups.map((g) => ({ column: g.viewColumn, active: g.isActive, tabs: g.tabs.slice(0, 200).map((t) => {
                const uri = t.input && t.input.uri;
                const rec = { label: String(t.label).slice(0, 120), active: t.isActive, dirty: t.isDirty, pinned: t.isPinned };
                if (full && uri) rec.path = uri.scheme === "file" ? uri.fsPath : uri.toString();
                return rec;
            }) })) };
        }
        return null;
    }

    /** Подсветка кода настоящим API: тип подсветки на (модуль, key), диапазоны — в активном редакторе. */
    decorate(id, op, body) {
        const key = String(body.key || "");
        if (!/^[\w.-]{1,40}$/.test(key)) return { ok: false, error: "bad key" };
        if (!this.decoTypes) this.decoTypes = new Map();
        const k = id + "/" + key;
        let rec = this.decoTypes.get(k);
        if (op === "undecorate") { if (rec) { rec.type.dispose(); this.decoTypes.delete(k); } return { ok: true }; }
        const style = VM.cleanStyle(body.style);
        const sig = JSON.stringify(style);
        if (rec && rec.sig !== sig) { rec.type.dispose(); rec = null; }
        if (!rec) {
            if (Array.from(this.decoTypes.keys()).filter((x) => x.indexOf(id + "/") === 0).length >= VM.MAX_DECO_TYPES) return { ok: false, error: "не больше " + VM.MAX_DECO_TYPES + " видов подсветки" };
            const opts = Object.assign({}, style);
            if (opts.overviewRulerLane) opts.overviewRulerLane = vscode.OverviewRulerLane[opts.overviewRulerLane[0].toUpperCase() + opts.overviewRulerLane.slice(1)];
            rec = { type: vscode.window.createTextEditorDecorationType(opts), sig: sig };
            this.decoTypes.set(k, rec);
        }
        const ed = vscode.window.activeTextEditor;
        if (!ed) return { ok: true, applied: 0 };
        const doc = ed.document;
        const ranges = VM.cleanRanges(body.ranges).filter((r) => r.line < doc.lineCount).map((r) => {
            const lineLen = doc.lineAt(r.line).text.length;
            const range = new vscode.Range(r.line, Math.min(r.start, lineLen), r.line, Math.min(r.end == null ? lineLen : r.end, lineLen));
            // Подсказка при наведении — простым текстом: MarkdownString без isTrusted (ссылки-команды не сработают).
            return r.hover ? { range: range, hoverMessage: new vscode.MarkdownString().appendText(r.hover) } : { range: range };
        });
        ed.setDecorations(rec.type, ranges);
        return { ok: true, applied: ranges.length };
    }
    /** Модули выключили — снять их подсветку и подписки. */
    disposeVs(ids) {
        const set = new Set(ids);
        if (this.decoTypes) for (const [k, rec] of this.decoTypes) { if (set.has(k.split("/")[0])) { try { rec.type.dispose(); } catch (e) {} this.decoTypes.delete(k); } }
        if (this.vsSubs) this.vsSubs.forEach((m) => ids.forEach((id) => m.delete(id)));
        if (this.modCmdWin) ids.forEach((id) => this.modCmdWin.delete(id));
        this.updateCommandContext();
    }

    // ---------------- команды модулей ----------------

    /** Окно объявило команды модуля (сверх манифеста): { id, commands: [...] }. */
    modCommandsFromWindow(body) {
        const id = String(body && body.id || "");
        if (!MOD_ID_RE.test(id) || !this.modules.has(id)) return { ok: false, error: "unknown module" };
        if (!this.modCmdWin) this.modCmdWin = new Map();
        this.modCmdWin.set(id, MF.cleanCommands(body.commands));
        this.updateCommandContext();
        return { ok: true, count: this.modCmdWin.get(id).length };
    }
    /** Все команды модулей: [{ mod, name, id, title, langs, context }]. */
    moduleCommands() {
        const out = [];
        this.modules.known.forEach((m) => {
            const seen = new Set();
            (m.commands || []).concat((this.modCmdWin && this.modCmdWin.get(m.id)) || []).forEach((c) => {
                if (seen.has(c.id)) return;
                seen.add(c.id);
                out.push(Object.assign({ mod: m.id, name: m.name }, c));
            });
        });
        return out;
    }
    /** Ключи контекста для меню: есть ли команды и для каких языков (when в package.json). */
    updateCommandContext() {
        const list = this.moduleCommands ? this.moduleCommands() : [];
        const langs = Array.from(new Set([].concat.apply([], list.filter((c) => c.context).map((c) => c.langs))));
        const key = JSON.stringify([list.length > 0, list.some((c) => c.context && !c.langs.length), langs]);
        if (key === this.cmdCtxKey) return;
        this.cmdCtxKey = key;
        const set = (k, v) => Promise.resolve(vscode.commands.executeCommand("setContext", k, v)).catch(() => {});
        set("moonCore.hasModuleCommands", list.length > 0);
        set("moonCore.moduleCommandAnyLang", list.some((c) => c.context && !c.langs.length));
        set("moonCore.moduleCommandLangs", langs);
    }

    /** «Moon Core: Команды модулей» — выбор из команд, подходящих к активному файлу. fromMenu — из контекстного меню. */
    async pickModuleCommand(fromMenu) {
        const ed = vscode.window.activeTextEditor;
        const lang = ed ? ed.document.languageId : "";
        const list = this.moduleCommands().filter((c) => MF.commandFits(c, lang) && (!fromMenu || c.context));
        if (!list.length) { vscode.window.showInformationMessage("Moon Core: у модулей нет команд" + (lang ? " для " + lang : "") + "."); return; }
        const pick = list.length === 1 && fromMenu ? list[0] : await vscode.window.showQuickPick(list.map((c) => ({ label: c.title, description: c.name, cmd: c })), { placeHolder: "Команда модуля" }).then((p) => p && p.cmd);
        if (pick) await this.invokeModuleCommand(pick.mod, pick.id);
    }

    /** Отдать команду модулю в окно (разовое событие "command"; ленивый модуль окно сначала загрузит). */
    async invokeModuleCommand(modId, cmdId) {
        const ed = vscode.window.activeTextEditor;
        const ctx = { lang: ed ? ed.document.languageId : "", line: ed ? ed.selection.active.line : -1 };
        if (ed && this.hasCap(modId, "editor.read")) {
            const doc = ed.document, wr = doc.getWordRangeAtPosition(ed.selection.active);
            ctx.word = wr ? doc.getText(wr).slice(0, 200) : "";
            ctx.selection = ed.selection.isEmpty ? "" : doc.getText(ed.selection).slice(0, VM.MAX_SELECTION);
            ctx.path = doc.uri.scheme === "file" ? doc.uri.fsPath : "";
        }
        try { this.modules.publish(modId, "command", { id: cmdId, ctx: ctx }, { scope: "window", cache: false }); }
        catch (e) { log("команда модуля " + modId + "/" + cmdId, e); }
    }
}

module.exports = { Part: VsPart };
