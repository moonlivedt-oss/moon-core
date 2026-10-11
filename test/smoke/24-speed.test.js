// Смоук-тесты Moon Core: «Скорость VS Code» (метки, история, замедление, советы, тяжёлые папки,
// страница, Доктор) и накладные расходы самого Moon Core (поиск модулей, кэш бандла).
"use strict";
const { test, withVscode, assert, fs, path, EXT, TMP, M } = require("./harness");
const PM = require(path.join(EXT, "lib", "perf-model"));
const PA = require(path.join(EXT, "lib", "perf-advice"));
const PS = require(path.join(EXT, "lib", "perf-scan"));
const SP = require(path.join(EXT, "lib", "speed-page"));
const DM = require(path.join(EXT, "lib", "doctor-model"));
const { PerfStore } = require(path.join(EXT, "lib", "perf-store"));
const { cleanPerf } = PM;

/** Свой модуль vscode на время fn (заглушка из harness отвечает на всё одним и тем же). */
function withStub(api, fn) {
    const Module = require("module");
    const orig = Module._resolveFilename;
    Module._resolveFilename = function (req) { return req === "vscode" ? "vscode" : orig.apply(this, arguments); };
    require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: api };
    const fresh = (rel) => { const f = require.resolve(path.join(EXT, "lib", rel)); delete require.cache[f]; return require(f); };
    try { return fn(fresh); } finally { Module._resolveFilename = orig; delete require.cache.vscode; }
}

// Метки процесса расширений — как их пишет VS Code 1.139 (абсолютное время, мс).
const T = 1e12;
const EXT_MARKS = [
    { name: "code/timeOrigin", startTime: T },
    { name: "code/extHost/willLoadExtensionCode/ms-python.python", startTime: T + 1000 },
    { name: "code/extHost/didLoadExtensionCode/ms-python.python", startTime: T + 1400 },
    { name: "code/extHost/willActivateExtension/ms-python.python", startTime: T + 1450 },
    { name: "code/extHost/didActivateExtension/ms-python.python", startTime: T + 2650 },
    { name: "code/extHost/willActivateExtension/ms-python.python", startTime: T + 9000 },   // повтор — не в счёт
    { name: "code/extHost/willLoadExtensionCode/a.slow", startTime: T + 1100 },            // ещё не активировалось
    { name: "code/extHost/didLoadExtensionCode/a.slow", startTime: T + 1150 },
    { name: "code/extHost/willActivateExtension/vscode.git", startTime: T + 1200 },
    { name: "code/extHost/didActivateExtension/vscode.git", startTime: T + 1290 },
    { name: "code/extHost/didActivateExtension/../evil", startTime: T + 1 },               // не id расширения
    { name: "чужая", startTime: T },
];

test("скорость: активация расширений из меток процесса расширений — загрузка, activate(), начало, готовность", () => {
    const t = PM.extTable(EXT_MARKS);
    assert.deepStrictEqual(t.map((r) => r.id), ["ms-python.python", "vscode.git", "a.slow"]);
    assert.deepStrictEqual(t[0], { id: "ms-python.python", load: 400, activate: 1200, total: 1600, at: 1000, done: true });
    assert.strictEqual(t[2].done, false, "без didActivate — не готово");
    assert.strictEqual(t[1].load, null, "без меток кода — загрузка неизвестна");
    assert.deepStrictEqual(PM.extTable(null), []);
    assert.strictEqual(PM.activationKind(["onLanguage:python", "*"]), "star");
    assert.strictEqual(PM.activationKind(["onStartupFinished"]), "startup");
    assert.strictEqual(PM.activationKind(["workspaceContains:**/*.csproj"]), "workspace");
    assert.strictEqual(PM.activationKind(["onLanguage:go"]), "language");
    assert.strictEqual(PM.activationKind(["onCommand:x"]), "event");
    assert.strictEqual(PM.activationKind(undefined), "implicit");
});

test("скорость: этапы старта окна; мусорные метки из окна не принимаются", () => {
    const vs = { "code/willStartWorkbench": 900, "code/didStartWorkbench": 1500, "code/willRestoreEditors": 1600, "code/didRestoreEditors": 3700,
        "code/willLoadExtensions": 1700, "code/didLoadExtensions": 4000, "mooncore:state": 30, "<script>": 1, "code/x": -5, "code/y": "1", "code/z": 1e12 };
    const m = PM.cleanMarks(vs);
    assert.deepStrictEqual(Object.keys(m).sort(), ["code/didLoadExtensions", "code/didRestoreEditors", "code/didStartWorkbench", "code/willLoadExtensions", "code/willRestoreEditors", "code/willStartWorkbench", "mooncore:state"]);
    const tl = PM.windowTimeline(vs);
    assert.strictEqual(tl.ready, 1500);
    assert.strictEqual(tl.extensions, 4000);
    assert.deepStrictEqual(tl.phases.map((p) => [p.key, p.ms]), [["workbench", 600], ["editors", 2100], ["extensions", 2300]]);
    assert.deepStrictEqual(PM.windowTimeline([1, 2]).phases, []);
});

test("скорость: история — запись окна обновляется, лимит, порча файла; замедление только по фактам", () => {
    const h = PM.emptyHistory();
    for (let i = 0; i < 6; i++) PM.addStart(h, { win: "a".repeat(15) + i, ready: 1500 + i * 10, extensions: 3000 + i * 20, phases: { editors: 400 } });
    assert.strictEqual(PM.regression(h), null, "обычные запуски");
    PM.addStart(h, { win: "b".repeat(16), ready: 1600, extensions: 3100 });
    PM.addStart(h, { win: "b".repeat(16), extensions: 6500 });                    // вторая, полная отправка того же окна
    assert.strictEqual(h.starts.length, 7, "то же окно — та же запись");
    assert.strictEqual(h.starts[6].ready, 1600, "поля из первой отправки сохранились");
    assert.deepStrictEqual(PM.regression(h), { metric: "extensions", last: 6500, median: 3050 });
    PM.addStart(h, { win: "c".repeat(16), ready: 1700, extensions: 3900 });
    assert.strictEqual(PM.regression(h), null, "в 1,3 раза — шум, а не замедление");
    const few = PM.emptyHistory();
    for (let i = 0; i < 3; i++) PM.addStart(few, { win: String(i).repeat(16), extensions: 1000 });
    PM.addStart(few, { win: "d".repeat(16), extensions: 9000 });
    assert.strictEqual(PM.regression(few), null, "мало запусков — не судим");
    for (let i = 0; i < 100; i++) PM.addStart(h, { win: "", ready: 1 });
    assert.strictEqual(h.starts.length, PM.STARTS_MAX);
    const junk = PM.cleanHistory({ starts: [null, { at: "x" }, { at: 1, win: "../..", phases: { "a b": 1, editors: 5 }, ready: "1" }], ext: { "bad id": { n: 1 }, "a.b": { n: 2, sum: 10, kind: "<x>" } } });
    assert.deepStrictEqual(junk.starts, [{ at: 1, win: "", vs: "", ready: null, extensions: null, runtime: null, phases: { editors: 5 } }]);
    assert.deepStrictEqual(Object.keys(junk.ext), ["a.b"]);
    assert.strictEqual(junk.ext["a.b"].kind, "implicit");
    assert.deepStrictEqual(PM.cleanHistory("мусор"), PM.emptyHistory());
});

test("скорость: средняя стоимость расширений и выгрузка для внешних программ (схема moon-core/perf@1)", () => {
    const h = PM.emptyHistory();
    PM.addExt(h, PM.extTable(EXT_MARKS), { "ms-python.python": "star" }, 1);
    PM.addExt(h, [{ id: "ms-python.python", total: 2400, done: true }], {}, 2);
    const st = PM.extStats(h);
    assert.deepStrictEqual(st[0], { id: "ms-python.python", n: 2, avg: 2000, max: 2400, last: 2400, kind: "star" });
    assert.ok(!st.some((e) => e.id === "a.slow"), "неготовое не записывается");
    const ex = PA.exportData(h, { now: 0, vscode: "1.139.1" });
    assert.strictEqual(ex.schema, "moon-core/perf@1");
    assert.strictEqual(ex.vscode, "1.139.1");
    assert.deepStrictEqual(ex.extensions[0], { id: "ms-python.python", samples: 2, avgMs: 2000, maxMs: 2400, lastMs: 2400, activation: "star", eager: true });
});

/** Настройки как их видит VS Code: key -> { value, global, workspace }; нет ключа — настройки нет в этой версии. */
function settings(map) { return (k) => (k in map ? Object.assign({ exists: true }, map[k]) : { exists: false }); }

test("скорость: советы — только по фактам и только для существующих настроек; прежнее значение не меняется", () => {
    const heavy = [{ name: "node_modules", rel: "node_modules", pattern: "**/node_modules/**", files: 5000 }, { name: ".venv", rel: ".venv", pattern: "**/.venv/**", files: 150 }];
    const ws = { "**/dist/**": true };
    const ctx = {
        get: settings({
            "files.watcherExclude": { value: { ".git/objects/**": true, "**/dist/**": true }, workspace: ws },
            "search.followSymlinks": { value: true }, "editor.largeFileOptimizations": { value: false },
            "workbench.editor.limit.enabled": { value: false }, "extensions.experimental.affinity": { value: {}, global: undefined },
        }),
        hasWorkspace: true, heavy: heavy, editorsMs: 2500,
        slowExt: [{ id: "ms-python.python", avg: 2000, n: 3 }, { id: "vscode.git", avg: 3000, n: 5, builtin: true }, { id: "once.only", avg: 5000, n: 1 }],
    };
    const a = PA.advise(ctx);
    const by = {};
    a.forEach((x) => { by[x.id] = x; });
    assert.deepStrictEqual(Object.keys(by).sort(), ["affinity", "editorLimit", "largeFiles", "symlinks", "watcher"]);
    assert.strictEqual(by.watcher.target, "workspace");
    assert.deepStrictEqual(by.watcher.value, { "**/dist/**": true, "**/node_modules/**": true }, ".venv в 150 файлов — не повод");
    assert.deepStrictEqual(ws, { "**/dist/**": true }, "исходный объект настройки не тронут");
    assert.deepStrictEqual(by.watcher.current, { "**/dist/**": true });
    assert.deepStrictEqual(by.affinity.value, { "ms-python.python": 1 }, "встроенные и разовые замеры — нет");

    const quiet = PA.advise({ get: settings({ "files.watcherExclude": { value: { "**/node_modules/**": true } }, "search.followSymlinks": { value: false } }), hasWorkspace: false, heavy: heavy, editorsMs: 300, slowExt: [] });
    assert.deepStrictEqual(quiet, [], "всё уже настроено, а остальных настроек в этой версии нет");
    assert.ok(PA.covered({ "frontend/node_modules/**": true }, "node_modules", "frontend/node_modules"));
    assert.ok(!PA.covered({ "**/node_modules/**": false }, "node_modules", "node_modules"), "false — не исключение");
});

test("скорость: тяжёлые папки — зависимости и кэши; build и venv только с признаками; .git и ссылки не обходятся", async () => {
    const root = fs.mkdtempSync(path.join(TMP, "heavy-"));
    const mk = (rel, n) => { const d = path.join(root, rel); fs.mkdirSync(d, { recursive: true }); for (let i = 0; i < (n || 0); i++) fs.writeFileSync(path.join(d, "f" + i), ""); return d; };
    mk("node_modules/pkg/lib", 30); mk("node_modules/other", 5);
    mk("app/build", 12);                                       // без CMakeLists.txt — это просто папка app/build
    mk("native/build", 7); fs.writeFileSync(path.join(root, "native", "CMakeLists.txt"), "");
    mk("venv", 3);                                             // без pyvenv.cfg — не окружение
    mk("py/venv", 2); fs.writeFileSync(path.join(root, "py", "venv", "pyvenv.cfg"), "");
    mk(".git/node_modules", 50);
    mk("deep/a/b/c/d/node_modules", 9);                        // глубже maxDepth
    const r = await PS.scanHeavy([root], { maxDepth: 4 });
    const rels = r.map((x) => x.rel).sort();
    assert.deepStrictEqual(rels, ["native/build", "node_modules", "py/venv"]);
    const nm = r.find((x) => x.rel === "node_modules");
    assert.strictEqual(nm.files, 35);
    assert.strictEqual(nm.pattern, "**/node_modules/**");
    assert.strictEqual(await PS.countFiles(path.join(root, "node_modules"), 10), 10, "счёт останавливается на потолке");
    const lim = await PS.scanHeavy([root], { budget: 1 });
    assert.ok(lim.length <= 3, "бюджет каталогов соблюдается");
});

test("скорость: файл истории общий для окон — запись поверх чужих, с выгрузкой export", () => {
    const f = path.join(fs.mkdtempSync(path.join(TMP, "perf-")), "mooncore-perf.json");
    const a = new PerfStore(f), b = new PerfStore(f);
    a.update((h) => PM.addStart(h, { win: "1".repeat(16), ready: 1000 }));
    b.update((h) => PM.addStart(h, { win: "2".repeat(16), ready: 2000 }));
    const saved = JSON.parse(fs.readFileSync(f, "utf8"));
    assert.strictEqual(saved.starts.length, 2, "второе окно не затёрло первое");
    assert.strictEqual(saved.export.schema, "moon-core/perf@1");
    fs.writeFileSync(f, "{не json");
    assert.deepStrictEqual(a.load(), PM.emptyHistory());
});

test("скорость: страница экранирует данные расширений, все кнопки — из списка действий", () => {
    const model = {
        last: { ready: 1500, extensions: 4000, phasesList: [{ key: "editors", label: "Редакторы", ms: 2100 }] }, stats: { n: 8, readyMedian: 1400, extensionsMedian: 3000 },
        regression: { metric: "extensions", last: 6500, median: 3050 }, history: [{ at: 1, ready: 1, extensions: 2 }, { at: 2, ready: 1, extensions: 3 }],
        windows: [{ win: "a".repeat(16), own: true, perf: { freezes: 12, freezeMs: 5000, freezeMax: 1300, heapMb: 400, up: 600 } }],
        exts: [{ id: "x.y", name: "<img src=x onerror=alert(1)>", load: 10, activate: 1200, total: 1210, kind: "star", builtin: false, avg: 900, n: 3 }],
        advice: [{ id: "watcher", key: "files.watcherExclude", target: "workspace", title: "Не следить за <b>", why: "почему" }],
        applied: [{ id: "symlinks", key: "search.followSymlinks", title: "Поиск" }], self: { activate: 40, runtime: 30 }, perfFile: "C:\\x\\mooncore-perf.json",
    };
    const html = SP.render(model, "NONCE");
    assert.ok(html.indexOf("<img src=x") === -1 && html.indexOf("&lt;img src=x") !== -1, "имя расширения экранировано");
    assert.ok(html.indexOf("Не следить за &lt;b&gt;") !== -1);
    assert.ok(/default-src 'none'/.test(html) && html.indexOf("nonce-NONCE") !== -1);
    const cmds = Array.from(html.matchAll(/data-cmd=['"]?([\w]+)/g)).map((m) => m[1]);
    assert.ok(cmds.length >= 8);
    cmds.forEach((c) => assert.ok(SP.ACTIONS.indexOf(c) !== -1, "кнопка без обработчика: " + c));
    assert.ok(html.indexOf("6,5 с") !== -1 && html.indexOf("3,1 с") !== -1, "замедление в шапке");
    assert.strictEqual(SP.sec(950), "950 мс");
    assert.ok(SP.render({}, "N").indexOf("Замеров ещё нет") !== -1, "пустая модель не падает");
});

test("Доктор: замедление, дорогие расширения, подвисания и дубли модулей — с кнопками", () => {
    const list = DM.problems({ shells: [{ file: "a/b/workbench.html", injected: true, current: true }], bridge: { running: true, streams: 1 },
        modules: { dups: [{ id: "mlbg", used: "папка D:/mlbg", skipped: "расширение moonlivedt.mlbg" }] },
        speed: { regression: { metric: "extensions", last: 6500, median: 3050 }, slowExt: [{ id: "ms-python.python", avg: 2000 }], freezes: 1 } });
    const t = list.map((p) => p.title).join(" | ");
    assert.ok(/медленнее обычного: 6,5 с вместо 3,1 с/.test(t), t);
    assert.ok(/ms-python\.python \(2 с\)/.test(t), t);
    assert.ok(/Окна подвисали: 1/.test(t), t);
    assert.ok(/«mlbg» найден дважды/.test(t), t);
    list.filter((p) => p.fix).forEach((p) => assert.ok(DM.ACTIONS.indexOf(p.fix) !== -1, "действие " + p.fix));
    assert.strictEqual(DM.verdict(list), "warn");
    assert.strictEqual(DM.problems({ shells: [], bridge: { running: true } }).some((p) => /подвисали|медленнее/.test(p.title)), false, "без замеров — молчит");
});

test("время окна: хост чистит метки и сводку подвисаний и отдаёт их «Скорости»; плохой id окна — пусто", () => withVscode(() => {
    const GatePart = require(path.join(EXT, "lib", "host-gate")).Part;
    let got = null;
    const self = { onPerfTiming: (x) => { got = x; } };
    GatePart.prototype.onWindowTiming.call(self, { runtime: 31, win: "0123456789abcdef", final: true, vs: { "code/didStartWorkbench": 1500, "<x>": 1 }, perf: { freezes: 2, heapMb: 1e9 } });
    assert.deepStrictEqual(got.vs, { "code/didStartWorkbench": 1500 });
    assert.strictEqual(got.win, "0123456789abcdef");
    assert.strictEqual(got.final, true);
    assert.strictEqual(got.perf.heapMb, 0, "невозможная память — ноль");
    assert.strictEqual(self.lastTiming.win, "0123456789abcdef");
    GatePart.prototype.onWindowTiming.call(self, { win: "../../x" });
    assert.strictEqual(got.win, "");
    assert.strictEqual(cleanPerf("x"), null);
}));

test("модули: поиск кэшируется, ошибка пишется в журнал один раз, дубль — с источниками", () => {
    const dir = fs.mkdtempSync(path.join(TMP, "disc-"));
    const manifest = { id: "dupmod", name: "Дубль", version: "1", script: "runtime.js" };
    fs.writeFileSync(path.join(dir, M.MODULE_FILE), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, "runtime.js"), "1");
    const extDir = fs.mkdtempSync(path.join(TMP, "disc-ext-"));
    fs.writeFileSync(path.join(extDir, "runtime.js"), "1");
    const api = {
        workspace: { getConfiguration: () => ({ get: (k, d) => (k === "modules" ? [dir] : d) }) },
        extensions: { all: [{ id: "pub.dupext", extensionPath: extDir, packageJSON: { version: "1", moonCore: { modules: [manifest] } } }] },
        window: { createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }) },
    };
    withStub(api, (fresh) => {
        const LOG = require(path.join(EXT, "lib", "log"));
        const before = LOG.recentLog(300).filter((l) => /dupmod: такой id/.test(l)).length;
        const D = fresh("module-discover");
        let reads = 0;
        const orig = fs.readFileSync;
        fs.readFileSync = function (f) { if (String(f).indexOf(M.MODULE_FILE) !== -1) reads++; return orig.apply(this, arguments); };
        try {
            for (let i = 0; i < 20; i++) D.discover();
            assert.strictEqual(reads, 1, "манифест прочитан один раз за 20 вызовов");
            assert.deepStrictEqual(D.discover().map((m) => m.source), ["dir:" + dir]);
            const dups = D.discoverDups();
            assert.strictEqual(dups.length, 1);
            assert.deepStrictEqual([dups[0].id, dups[0].used, dups[0].skipped], ["dupmod", "dir:" + dir, "ext:pub.dupext"]);
            const after = LOG.recentLog(300).filter((l) => /dupmod: такой id/.test(l)).length;
            assert.strictEqual(after - before, 1, "в журнале — одна запись");
            const mf = path.join(dir, M.MODULE_FILE);
            fs.writeFileSync(mf, JSON.stringify(Object.assign({}, manifest, { version: "22" })));
            fs.utimesSync(mf, new Date(), new Date(Date.now() + 5000));
            D.discover();
            assert.strictEqual(reads, 2, "манифест изменился — прочитан снова");
        } finally { fs.readFileSync = orig; }
    });
});

test("глубокие патчи: факты о бандле воркбенча запоминаются — второй раз 20 МБ не читаются", () => {
    const appRoot = fs.mkdtempSync(path.join(TMP, "app-"));
    const bundle = path.join(appRoot, "out", "vs", "workbench", "workbench.desktop.main.js");
    fs.mkdirSync(path.dirname(bundle), { recursive: true });
    fs.writeFileSync(bundle, "var x = 1;");
    fs.writeFileSync(path.join(appRoot, "out", "main.js"), "");
    const store = {};
    const context = { globalState: { get: (k) => store[k], update: async (k, v) => { store[k] = v; } } };
    const api = {
        env: { appRoot: appRoot },
        workspace: { getConfiguration: () => ({ get: (k, d) => d }) },
        window: { createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }) },
    };
    withStub(api, (fresh) => {
        const DPL = fresh("inject/deep-plan");
        let reads = 0;
        const orig = fs.readFileSync;
        fs.readFileSync = function (f) { if (String(f) === bundle) reads++; return orig.apply(this, arguments); };
        try {
            const a = DPL.deepState(context);
            assert.strictEqual(reads, 1);
            assert.ok(store["mooncore.deepBundle"] && store["mooncore.deepBundle"].di === false, "запомнено");
            DPL.resetDeepCache();                                         // новое окно: памяти процесса нет
            const b = DPL.deepState(context);
            assert.strictEqual(reads, 1, "второе окно бандл не читало");
            assert.strictEqual(a.di, b.di);
            assert.strictEqual(a.diSupported, b.diSupported);
            fs.writeFileSync(bundle, "var x = 22;");
            fs.utimesSync(bundle, new Date(), new Date(Date.now() + 5000));
            DPL.resetDeepCache();
            DPL.deepState(context);
            assert.strictEqual(reads, 2, "VS Code обновился — прочитан заново");
        } finally { fs.readFileSync = orig; }
    });
});

test("«Скорость VS Code»: запись запуска, совет применяется и возвращается как было, замедление — одно уведомление", async () => {
    const dir = fs.mkdtempSync(path.join(TMP, "speed-"));
    const user = { "search.followSymlinks": undefined }, wsv = {};
    const defaults = { "search.followSymlinks": true, "files.watcherExclude": {}, "editor.largeFileOptimizations": true };
    const store = {}, shown = [];
    const cfg = {
        get: (k, d) => (k === "speedNotify" ? d : k in wsv ? wsv[k] : user[k] !== undefined ? user[k] : k in defaults ? defaults[k] : d),
        inspect: (k) => (k in defaults ? { defaultValue: defaults[k], globalValue: user[k], workspaceValue: wsv[k] } : undefined),
        update: async (k, v, target) => { const t = target === 2 ? wsv : user; if (v === undefined) delete t[k]; else t[k] = v; },
    };
    const api = {
        version: "1.139.1", env: { appRoot: dir },
        ConfigurationTarget: { Global: 1, Workspace: 2 },
        workspace: { getConfiguration: () => cfg, workspaceFolders: [{ uri: { scheme: "file", fsPath: dir, toString: () => "file:///w" } }] },
        extensions: { all: [] },
        window: { state: { focused: true }, createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }), showInformationMessage: async (m) => { shown.push(m); return undefined; } },
        commands: { executeCommand: async () => {} },
    };
    await withStub(api, async (fresh) => {
        const { Speed } = require(path.join(EXT, "lib", "ext", "speed"));
        const context = { globalStorageUri: { fsPath: dir }, subscriptions: [], globalState: { get: (k) => store[k], update: async (k, v) => { store[k] = v; } } };
        const host = { windowsInfo: () => [] };
        const sp = new Speed(context, host);
        context.subscriptions.forEach((d) => d.dispose());
        for (let i = 0; i < 6; i++) sp.onTiming({ win: String(i).repeat(16), final: true, vs: { "code/willLoadExtensions": 100, "code/didLoadExtensions": 3000 + i * 10 }, runtime: 30 });
        sp.onTiming({ win: "f".repeat(16), final: false, vs: { "code/didStartWorkbench": 1500 } });
        sp.onTiming({ win: "f".repeat(16), final: true, vs: { "code/willLoadExtensions": 100, "code/didLoadExtensions": 9000 } });
        await new Promise((r) => setTimeout(r, 20));
        const h = sp.store.load();
        assert.strictEqual(h.starts.length, 7);
        assert.strictEqual(h.starts[6].ready, 1500, "первая отправка не потеряна");
        assert.strictEqual(shown.length, 1, "сказали о замедлении");
        sp.onTiming({ win: "e".repeat(16), final: true, vs: { "code/willLoadExtensions": 100, "code/didLoadExtensions": 9500 } });
        await new Promise((r) => setTimeout(r, 20));
        assert.strictEqual(shown.length, 1, "второй раз за сутки — молчим");

        sp.heavy = [{ name: "node_modules", rel: "node_modules", pattern: "**/node_modules/**", files: 900 }];
        const m = sp.model();
        assert.deepStrictEqual(m.advice.map((a) => a.id).sort(), ["symlinks", "watcher"]);
        await sp.apply("symlinks");
        assert.strictEqual(wsv["search.followSymlinks"], false, "записано в настройки папки");
        assert.ok(!sp.model().advice.some((a) => a.id === "symlinks"), "применённый совет не предлагается снова");
        assert.deepStrictEqual(sp.model().applied.map((a) => a.id), ["symlinks"]);
        await sp.revert("symlinks");
        assert.ok(!("search.followSymlinks" in wsv), "вернули как было: настройки в папке не было");
        await sp.apply("nope");                                          // чужой id — ничего
        assert.deepStrictEqual(Object.keys(store["mooncore.speed.applied"] || {}), []);
        const sum = sp.summary();
        assert.ok(sum.regression && sum.regression.metric === "extensions");
        assert.strictEqual(sum.freezes, 0);
    });
});
