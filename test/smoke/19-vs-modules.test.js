// Смоук-тесты Moon Core: VS Code для модулей — манифест (права, ленивость, команды), одобрение
// прав, события редактора с правами, подсказки, подсветка, части окна, вкладки, команды модулей,
// ленивые модули в блоке оболочки.
"use strict";
const { test, assert, fs, path, EXT, TMP, W, M, makeModuleDir } = require("./harness");

const Module = require("module");
const MF = require(path.join(EXT, "lib", "module-manifest"));
const VM = require(path.join(EXT, "lib", "vs-model"));
const KEYS = require(path.join(EXT, "lib", "keys"));

function store(init) {
    const s = Object.assign({}, init || {});
    return { data: s, get: (k) => s[k], update: (k, v) => { if (v === undefined) delete s[k]; else s[k] = v; return Promise.resolve(); } };
}

/** Заглушка vscode с активным редактором, диагностикой, вкладками и записью команд. */
function fakeVs(opts) {
    const o = opts || {};
    const shown = [], executed = [], decos = [];
    let answers = (o.answers || []).slice();
    const lines = o.lines || ["int main() {", "  std::vector<int> v;", "}"];
    const doc = {
        uri: { scheme: "file", fsPath: path.join(TMP, "proj", "main.cpp"), path: "/proj/main.cpp", toString: () => "file:///proj/main.cpp" },
        fileName: path.join(TMP, "proj", "main.cpp"), languageId: "cpp", isDirty: false, lineCount: lines.length,
        lineAt: (i) => ({ text: lines[i] }),
        getWordRangeAtPosition: () => ({ w: "vector" }),
        getText: (r) => (r && r.w) || (r ? "std::vector<int>" : lines.join("\n")),
    };
    const sel = { active: { line: 1, character: 8 }, isEmpty: false };
    const editor = { document: doc, selection: sel, selections: [sel], setDecorations: (t, r) => decos.push({ type: t, ranges: r }) };
    class Range { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } }
    class MarkdownString { constructor() { this.value = ""; } appendText(t) { this.value += t; return this; } }
    const vs = {
        version: "1.200.0", Range, MarkdownString,
        OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
        DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
        Uri: { file: (p) => ({ fsPath: p, scheme: "file" }) },
        commands: {
            executeCommand: (id, ...args) => {
                executed.push([id].concat(args));
                if (id === "vscode.executeHoverProvider") return Promise.resolve([{ contents: [{ value: "**std::vector**" }, "template class"] }]);
                if (id === "vscode.executeDocumentSymbolProvider") return Promise.resolve([{ name: "main", kind: 11, range: { start: { line: 0 } }, children: [{ name: "v", kind: 12, range: { start: { line: 1 } } }] }]);
                if (id === "vscode.executeDefinitionProvider") return Promise.resolve([{ uri: { fsPath: "/usr/include/vector" }, range: { start: { line: 10, character: 2 } } }]);
                return Promise.resolve();
            },
        },
        window: {
            activeTextEditor: o.noEditor ? undefined : editor,
            terminals: [{ name: "pwsh" }], activeTerminal: { name: "pwsh" },
            tabGroups: { all: [{ viewColumn: 1, isActive: true, tabs: [{ label: "main.cpp", isActive: true, isDirty: false, isPinned: false, input: { uri: doc.uri } }] }] },
            createTextEditorDecorationType: (opts) => ({ opts: opts, disposed: false, dispose() { this.disposed = true; } }),
            showWarningMessage: (...a) => { shown.push(a); return Promise.resolve(answers.shift()); },
            showInformationMessage: (...a) => { shown.push(a); return Promise.resolve(answers.shift()); },
            showQuickPick: (items) => { shown.push(["pick", items]); return Promise.resolve(o.pick ? o.pick(items) : undefined); },
        },
        languages: { getDiagnostics: () => [{ severity: 0, message: "ошибка тут", source: "clangd", range: { start: { line: 1, character: 2 } } }, { severity: 1, message: "w", range: { start: { line: 0, character: 0 } } }] },
        debug: { activeDebugSession: null },
        tasks: { taskExecutions: [] },
        extensions: { getExtension: () => undefined, all: [] },
        workspace: { getConfiguration: () => ({ get: (k, d) => (k === "colorTheme" ? "Moon" : d) }) },
    };
    return { vs, shown, executed, decos, editor };
}

async function withLib(vs, fn) {
    const libDir = path.join(EXT, "lib") + path.sep;
    const drop = () => Object.keys(require.cache).forEach((k) => { if (k.indexOf(libDir) === 0 && !/[\\/](log|keys|audit)\.js$/.test(k)) delete require.cache[k]; });
    const orig = Module._resolveFilename;
    Module._resolveFilename = function (req) { return req === "vscode" ? "vscode" : orig.apply(this, arguments); };
    require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: vs };
    drop();
    try { return await fn((name) => require(path.join(EXT, "lib", name))); }
    finally { Module._resolveFilename = orig; delete require.cache.vscode; drop(); }
}

/** Хост из части host-vs с модулями mods ({ id: { caps } }) и одобренными правами. */
function vsHost(req, mods, gs) {
    const { Part } = req("host-vs");
    const MH = req("module-host");
    const sent = [];
    const known = new Map(Object.keys(mods).map((id) => [id, Object.assign({ id: id, name: id, source: "dir:/" + id, caps: [], commands: [] }, mods[id])]));
    const h = Object.assign(Object.create(Part.prototype), {
        context: { globalState: gs, subscriptions: [] },
        bridge: { broadcast: (e, d) => sent.push([e, d]) },
        modules: { known: known, has: (id) => known.has(id), publish: (id, ev, data, o) => sent.push(["module", { id: id, event: ev, data: data, opts: o }]) },
        contextNow: () => ({ branch: "main", theme: "dark" }),
    });
    return { h, sent, MH, known };
}

test("манифест модуля: права, ленивость, команды — только допустимое", () => {
    const dir = makeModuleDir("mf", null, { "rt.js": "1" });
    const r = M.normalize({ id: "cpd", script: "rt.js", capabilities: ["editor.read", "root", "layout", "layout"], lazy: { delay: 99999999 },
        commands: [{ id: "open", title: "Открыть", langs: ["cpp", "bad lang!"], context: true }, { id: "open", title: "дубль" }, { id: "x y", title: "плохой id" }, { id: "t" }] }, dir, "dir:" + dir);
    assert.ok(r.ok, r.error);
    assert.deepStrictEqual(r.module.caps, ["editor.read", "layout"]);
    assert.deepStrictEqual(r.module.lazy, { delay: 600000 });
    assert.deepStrictEqual(r.module.commands, [{ id: "open", title: "Открыть", langs: ["cpp"], context: true }]);
    assert.deepStrictEqual(MF.cleanLazy(true), { delay: 0 });
    assert.strictEqual(MF.cleanLazy("yes"), null);
    assert.ok(MF.commandFits({ langs: [] }, "") && MF.commandFits({ langs: ["cpp"] }, "cpp") && !MF.commandFits({ langs: ["cpp"] }, "python"));
    const boot = M.bootInfo([r.module], (p) => "file:///" + p);
    assert.deepStrictEqual(boot[0].lazy, { delay: 600000 });
    assert.deepStrictEqual(boot[0].commands, ["open"]);
});

test("блок оболочки: ленивый модуль с файлом не грузится на старте, ленивость меняет отпечаток", () => {
    const mods = [{ id: "aa", code: "A", file: "mooncore-mod-aa.js" }, { id: "bb", code: "B", lazy: true, file: "mooncore-mod-bb.js" }];
    const block = W.buildBlock({ modules: [] }, "rt", { nonce: "n1", modules: mods });
    assert.ok(/src="mooncore-mod-aa\.js"/.test(block) && !/mooncore-mod-bb\.js/.test(block), "bb — без <script>");
    assert.ok(/data-mooncore-modules="aa,bb"/.test(block), "но в списке модулей блока есть");
    assert.notStrictEqual(W.blockSha("rt", [{ id: "bb", code: "B" }]), W.blockSha("rt", [{ id: "bb", code: "B", lazy: true }]));
    assert.strictEqual(W.blockSha("rt", [{ id: "aa", code: "A" }]), W.blockSha("rt", [{ id: "aa", code: "A", lazy: false }]), "обычные модули — прежний отпечаток");
    const inline = W.buildBlock({ modules: [] }, "rt", { nonce: "n1", modules: [{ id: "bb", code: "B-code", lazy: true }] });
    assert.ok(/B-code/.test(inline), "без файла ленивость не действует — модуль встроен");
});

test("разовые события модуля (клик, команда) не кэшируются для новых окон", () => {
    const sent = [];
    const hub = new M.ModuleHub({ broadcast: (e, d) => sent.push(d) });
    hub.setModules([{ id: "aa" }]);
    hub.publish("aa", "command", { id: "x" }, { scope: "window", cache: false });
    hub.publish("aa", "theme", { k: 1 });
    assert.strictEqual(sent[0].once, true);
    assert.deepStrictEqual(hub.hello().map((h) => h.data.event), ["theme"]);
});

test("права модулей: свои — сразу, чужие — с вопросом; отказ помнится; права = манифест ∩ одобренные", async () => {
    const f = fakeVs({ answers: ["Дать", "Не давать"] });
    await withLib(f.vs, async (req) => {
        const MH = req("module-host");
        const gs = store({ [KEYS.MODULES_ALLOWED]: { own: "ext:moonlivedt.docs", ext: "dir:/x", no: "dir:/n" } });
        const ctx = { globalState: gs, extension: { packageJSON: { publisher: "moonlivedt" } } };
        const own = { id: "own", name: "Own", source: "ext:moonlivedt.docs", caps: ["editor.read"] };
        const ext = { id: "ext", name: "Ext", source: "dir:/x", caps: ["decorations", "layout"] };
        const no = { id: "no", name: "No", source: "dir:/n", caps: ["editor.read"] };
        assert.ok(await MH.reviewCaps(ctx, [own, ext, no]));
        assert.deepStrictEqual(MH.capsOf(ctx, own), ["editor.read"], "свой — без вопроса");
        assert.deepStrictEqual(MH.capsOf(ctx, ext), ["decorations", "layout"]);
        assert.deepStrictEqual(MH.capsOf(ctx, no), []);
        assert.strictEqual(f.shown.length, 2, "спросили двух чужих");
        await MH.reviewCaps(ctx, [no]);
        assert.strictEqual(f.shown.length, 2, "отказ не переспрашивается");
        assert.deepStrictEqual(MH.capsOf(ctx, Object.assign({}, ext, { caps: ["layout"] })), ["layout"], "убрал из манифеста — право не действует");
        assert.deepStrictEqual(MH.capsOf(ctx, Object.assign({}, ext, { source: "dir:/other" })), [], "другой источник — заново");
    });
});

test("события VS Code: только подписанным, full — при праве, повтор не шлётся, подписка гаснет", async () => {
    const f = fakeVs();
    await withLib(f.vs, async (req) => {
        const gs = store({ [KEYS.MODULES_CAPS]: { rd: { source: "dir:/rd", caps: ["editor.read"] } } });
        const { h, sent } = vsHost(req, { bg: {}, rd: { caps: ["editor.read"] } }, gs);
        h.vsEmit("cursor");
        assert.strictEqual(sent.length, 0, "без подписчиков — ничего");
        assert.deepStrictEqual(h.vsSubscribe({ id: "bg", kinds: ["cursor", "nope"] }).full, []);
        assert.deepStrictEqual(sent.pop(), ["vs", { kind: "cursor", data: { line: 1, col: 8, selections: 1, empty: false }, full: null, readers: [] }], "без права — только базовая часть");
        assert.deepStrictEqual(h.vsSubscribe({ id: "rd", kinds: ["cursor", "diagnostics"] }).full, ["cursor", "diagnostics"]);
        const cur = sent.find((s) => s[1].kind === "cursor");
        assert.deepStrictEqual(cur[1].full, { word: "vector", selection: "std::vector<int>", lineText: "  std::vector<int> v;" });
        assert.deepStrictEqual(cur[1].readers, ["rd"]);
        const diag = sent.find((s) => s[1].kind === "diagnostics")[1];
        assert.deepStrictEqual(diag.data, { errors: 1, warnings: 1, infos: 0 });
        assert.strictEqual(diag.full.items[0].message, "ошибка тут");
        const n = sent.length;
        h.vsEmit("cursor");
        assert.strictEqual(sent.length, n, "то же значение не шлётся повторно");
        assert.ok(!h.vsSubscribe({ id: "zz", kinds: ["cursor"] }).ok, "неизвестный модуль");
        h.vsSubs.get("cursor").forEach((v, k, m) => m.set(k, Date.now() - 1));
        assert.deepStrictEqual(h.vsSubscribers("cursor"), [], "без подтверждения подписка гаснет");
        ["editor", "terminal", "theme", "git", "debug", "task"].forEach((k) => assert.ok(h.vsSnapshot(k, true), k));
        assert.deepStrictEqual(h.vsSnapshot("editor", false).data, { file: "main.cpp", lang: "cpp", scheme: "file", dirty: false, lines: 3 });
        assert.strictEqual(h.vsSnapshot("editor", false).full, null, "путь — только с правом");
    });
});

test("шлюз: подсказки — с правом editor.read; подсветка — проверенный стиль, лимиты; части окна — командой", async () => {
    const f = fakeVs();
    await withLib(f.vs, async (req) => {
        const gs = store({ [KEYS.MODULES_CAPS]: { rd: { source: "dir:/rd", caps: ["editor.read", "decorations", "layout"] } } });
        const { h } = vsHost(req, { bg: {}, rd: { caps: ["editor.read", "decorations", "layout"] } }, gs);
        assert.ok(!(await h.onNativeVs("bg", "bg", "symbol", { what: "hover" })).ok, "без права — отказ");
        assert.strictEqual((await h.onNativeVs("rd", "rd", "symbol", { what: "word" })).result, "vector");
        assert.strictEqual((await h.onNativeVs("rd", "rd", "symbol", { what: "hover" })).result, "**std::vector**\n\ntemplate class");
        assert.deepStrictEqual((await h.onNativeVs("rd", "rd", "symbol", { what: "symbols" })).result.map((s) => [s.name, s.depth, s.line]), [["main", 0, 0], ["v", 1, 1]]);
        assert.deepStrictEqual((await h.onNativeVs("rd", "rd", "symbol", { what: "definition" })).result, [{ path: "/usr/include/vector", line: 10, col: 2 }]);
        assert.ok(!(await h.onNativeVs("bg", "bg", "decorate", { key: "k" })).ok);
        const r = await h.onNativeVs("rd", "rd", "decorate", { key: "err", style: { backgroundColor: "#ff000033", color: "red;}", after: { contentText: "  ← тут", color: "#888" }, overviewRulerColor: "#f00" }, ranges: [{ line: 1, start: 2, end: 999, hover: "подсказка" }, { line: 99 }, { line: -1 }] });
        assert.strictEqual(r.applied, 1);
        const d = f.decos.pop();
        assert.deepStrictEqual(d.type.opts.backgroundColor, "#ff000033");
        assert.strictEqual(d.type.opts.color, undefined, "цвет не #hex — отброшен");
        assert.strictEqual(d.type.opts.overviewRulerLane, 4);
        assert.deepStrictEqual([d.ranges[0].range.start.character, d.ranges[0].range.end.character], [2, 21], "конец по длине строки");
        assert.strictEqual(d.ranges[0].hoverMessage.value, "подсказка");
        const t1 = d.type;
        await h.onNativeVs("rd", "rd", "decorate", { key: "err", style: { backgroundColor: "#00ff0033" }, ranges: [] });
        assert.ok(t1.disposed, "новый стиль — старый тип убран");
        for (let i = 0; i < VM.MAX_DECO_TYPES + 2; i++) await h.onNativeVs("rd", "rd", "decorate", { key: "k" + i, style: {}, ranges: [] });
        assert.strictEqual(h.decoTypes.size, VM.MAX_DECO_TYPES);
        h.disposeVs(["rd"]);
        assert.strictEqual(h.decoTypes.size, 0, "выключили модуль — подсветка снята");
        assert.ok((await h.onNativeVs("rd", "rd", "layout", { part: "sidebar" })).ok);
        assert.ok(f.executed.some((e) => e[0] === "workbench.action.toggleSidebarVisibility"));
        assert.ok(!(await h.onNativeVs("rd", "rd", "layout", { part: "evil" })).ok);
        assert.ok(!(await h.onNativeVs("bg", "bg", "layout", { part: "sidebar" })).ok, "без права layout");
        const tabsBg = (await h.onNativeVs("bg", "bg", "tabs", {})).result[0].tabs[0];
        const tabsRd = (await h.onNativeVs("rd", "rd", "tabs", {})).result[0].tabs[0];
        assert.ok(!tabsBg.path && tabsRd.path && tabsBg.label === "main.cpp");
        assert.strictEqual(await h.onNativeVs("rd", "rd", "unknown", {}), null);
    });
});

test("команды модулей: манифест + окно, меню по языку, нажатие — разовое событие с контекстом по праву", async () => {
    const f = fakeVs({ pick: (items) => items[0] });
    await withLib(f.vs, async (req) => {
        const gs = store({ [KEYS.MODULES_CAPS]: { cpd: { source: "dir:/cpd", caps: ["editor.read"] } } });
        const { h, sent } = vsHost(req, { cpd: { caps: ["editor.read"], commands: [{ id: "open", title: "Документация", langs: ["cpp"], context: true }] }, bg: {} }, gs);
        assert.ok(h.modCommandsFromWindow({ id: "bg", commands: [{ id: "next", title: "Следующий фон" }, { id: "open", title: "дубль" }] }).ok);
        assert.deepStrictEqual(h.moduleCommands().map((c) => c.mod + "/" + c.id), ["cpd/open", "bg/next", "bg/open"]);
        const ctx = f.executed.filter((e) => e[0] === "setContext");
        assert.deepStrictEqual(ctx.slice(-3).map((e) => [e[1], e[2]]), [["moonCore.hasModuleCommands", true], ["moonCore.moduleCommandAnyLang", false], ["moonCore.moduleCommandLangs", ["cpp"]]]);
        await h.pickModuleCommand(true);
        const ev = sent.find((s) => s[0] === "module")[1];
        assert.deepStrictEqual([ev.id, ev.event, ev.data.id, ev.opts.cache], ["cpd", "command", "open", false]);
        assert.strictEqual(ev.data.ctx.word, "vector", "с правом — слово под курсором");
        await h.invokeModuleCommand("bg", "next");
        const ev2 = sent.filter((s) => s[0] === "module").pop()[1];
        assert.strictEqual(ev2.data.ctx.word, undefined, "без права — без слова");
        assert.strictEqual(ev2.data.ctx.lang, "cpp");
    });
});

test("стиль и диапазоны подсветки: мусор отбрасывается", () => {
    assert.deepStrictEqual(VM.cleanStyle({ backgroundColor: "url(x)", borderWidth: 9, fontWeight: "900", textDecoration: "underline wavy", isWholeLine: "yes", opacity: 0.5 }), { textDecoration: "underline wavy", opacity: "0.5" });
    assert.deepStrictEqual(VM.cleanStyle({ borderColor: "#abc", borderWidth: 1 }), { borderColor: "#abc", borderWidth: "1px", borderStyle: "solid" });
    assert.deepStrictEqual(VM.cleanRanges([{ line: 2, start: 5, end: 1 }, { line: "3" }, null, { line: 1.7 }]), [{ line: 2, start: 5, end: 5 }, { line: 1, start: 0, end: null }]);
    assert.strictEqual(VM.cleanRanges(new Array(3000).fill({ line: 0 })).length, 2000);
    assert.deepStrictEqual(VM.cleanKinds(["cursor", "x", "git"]), ["cursor", "git"]);
});
