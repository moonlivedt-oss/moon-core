// Смоук-тесты Moon Core: безопасность — опасные команды, шлюз модулей, журнал разрешений,
// секреты в журнале, повышение прав без run.cmd, профиль проекта в недоверенной папке.
"use strict";
const { test, assert, fs, path, EXT, TMP, CMD, D } = require("./harness");

const Module = require("module");
const cp = require("child_process");
const AU = require(path.join(EXT, "lib", "audit"));
const KEYS = require(path.join(EXT, "lib", "keys"));
const NP = require(path.join(EXT, "lib", "native-policy"));
const E = require(path.join(EXT, "lib", "elevate"));
const { redact } = require(path.join(EXT, "lib", "log"));

/** Хранилище globalState для тестов. */
function store(init) {
    const s = Object.assign({}, init || {});
    return { data: s, get: (k) => s[k], update: (k, v) => { if (v === undefined) delete s[k]; else s[k] = v; return Promise.resolve(); } };
}

/**
 * Заглушка vscode: answers — очередь ответов на диалоги (или функция), shown — что показано.
 * Части хоста загружаются заново поверх неё, объект this собирается из прототипа части.
 */
function fakeVs(opts) {
    const o = opts || {};
    const shown = [], executed = [];
    let answerQ = (o.answers || []).slice();
    const answer = (kind, args) => {
        shown.push({ kind: kind, text: args[0], args: args });
        const a = typeof o.answer === "function" ? o.answer(kind, args) : answerQ.shift();
        return new Promise((r) => setTimeout(() => r(a), o.delay || 0));
    };
    return {
        shown, executed,
        vs: {
            version: "1.200.0",
            ConfigurationTarget: { Global: 1 },
            StatusBarAlignment: { Left: 1, Right: 2 },
            Uri: { file: (p) => ({ fsPath: p, scheme: "file" }) },
            commands: { executeCommand: (id, ...args) => { executed.push([id].concat(args)); return Promise.resolve("done:" + id); } },
            window: {
                showInformationMessage: (...a) => answer("info", a),
                showWarningMessage: (...a) => answer("warn", a),
                showErrorMessage: (...a) => answer("error", a),
                showQuickPick: (...a) => answer("pick", a),
                showInputBox: (...a) => answer("input", a),
                showTextDocument: (uri) => { shown.push({ kind: "open", text: uri.fsPath }); return Promise.resolve(); },
                setStatusBarMessage: () => {},
            },
            workspace: {
                isTrusted: o.trusted !== false,
                workspaceFolders: o.folders || [],
                getConfiguration: () => ({ get: (k, d) => (o.conf && Object.prototype.hasOwnProperty.call(o.conf, k) ? o.conf[k] : d), inspect: () => undefined }),
            },
        },
    };
}

/** Загрузить часть хоста (lib/<name>.js) поверх заглушки vscode и собрать объект this. */
async function withPart(vs, name, self, fn) {
    const libDir = path.join(EXT, "lib") + path.sep;
    const drop = () => Object.keys(require.cache).forEach((k) => { if (k.indexOf(libDir) === 0 && !/[\\/](log|keys|audit)\.js$/.test(k)) delete require.cache[k]; });
    const orig = Module._resolveFilename;
    Module._resolveFilename = function (req) { return req === "vscode" ? "vscode" : orig.apply(this, arguments); };
    require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: vs };
    drop();
    try {
        const mod = require(path.join(EXT, "lib", name));
        const obj = Object.assign(Object.create(mod.Part.prototype), self);
        return await fn(obj, mod);
    } finally { Module._resolveFilename = orig; delete require.cache.vscode; drop(); }
}

test("команды: опасные — только модально и каждый раз; «всегда» для них не действует, настройка — действует", () => {
    ["workbench.action.terminal.sendSequence", "workbench.action.terminal.newWithProfile", "workbench.extensions.installExtension", "git.push", "git.cleanAll", "_workbench.downloadResource", "deleteFile", "vscode.open", "moonCore.revokeAll"]
        .forEach((id) => assert.ok(CMD.isDangerous(id), id));
    ["workbench.action.terminal.toggleTerminal", "editor.action.formatDocument", "workbench.action.tasks.runTask", "moonCore.design", "git.refresh"]
        .forEach((id) => assert.ok(!CMD.isDangerous(id), id));
    assert.strictEqual(CMD.decide("git.push", { stored: ["git.push"] }), "confirm");
    assert.strictEqual(CMD.decide("git.push", { setting: ["git.push"] }), "allow");
    assert.strictEqual(CMD.decide("git.push", { denied: new Set(["git.push"]) }), "deny");
    assert.strictEqual(CMD.decide("editor.action.formatDocument", { stored: ["editor.action.formatDocument"] }), "allow");
});

test("команды: пока вопрос открыт, повторные вызовы той же команды ждут его, а не открывают новые", async () => {
    const f = fakeVs({ answers: ["Один раз"], delay: 20 });
    const gs = store();
    await withPart(f.vs, "host-gate", { context: { globalState: gs } }, async (h) => {
        const calls = [1, 2, 3, 4, 5].map(() => h.onCommand({ id: "editor.action.formatDocument", args: [], from: "a.js" }));
        const res = await Promise.all(calls);
        assert.ok(res.every((r) => r.ok), JSON.stringify(res));
        assert.strictEqual(f.shown.filter((s) => s.kind === "warn").length, 1, "один диалог на пять вызовов");
        assert.strictEqual(f.executed.length, 5);
    });
    assert.ok(AU.read(gs).some((r) => r.kind === "command" && r.verdict === "once"), "решение записано в журнал");
});

test("команды: опасная команда — модальный вопрос на каждый вызов, «всегда» из хранилища не пропускает", async () => {
    const f = fakeVs({ answers: ["Выполнить", undefined] });
    const gs = store({ [KEYS.ALLOWED_COMMANDS]: ["workbench.action.terminal.sendSequence"] });
    await withPart(f.vs, "host-gate", { context: { globalState: gs } }, async (h) => {
        const r1 = await h.onCommand({ id: "workbench.action.terminal.sendSequence", args: [{ text: "rm -rf /\n" }] });
        const r2 = await h.onCommand({ id: "workbench.action.terminal.sendSequence", args: [{ text: "x" }] });
        assert.ok(r1.ok && !r2.ok, JSON.stringify([r1, r2]));
        const asks = f.shown.filter((s) => s.kind === "warn");
        assert.strictEqual(asks.length, 2, "спросили оба раза");
        assert.ok(asks.every((a) => a.args[1] && a.args[1].modal === true), "модально");
        assert.ok(!asks.some((a) => a.args.indexOf("Разрешить всегда") !== -1), "без «всегда»");
    });
});

test("шлюз модулей: секреты в настройках не отдаются, открытие вне проекта — с вопросом, всё подписано", async () => {
    assert.ok(NP.secretKey("github.token") && NP.secretKey("http.proxy") && NP.secretKey("my.apiKey") && NP.secretKey("x.password"));
    assert.ok(!NP.secretKey("editor.tokenColorCustomizations") && !NP.secretKey("editor.fontSize") && !NP.secretKey("workbench.colorTheme"));
    assert.deepStrictEqual(NP.stripSecrets({ token: "t", fontSize: 12, nested: { apiKey: "k", ok: 1 } }, "ext"), { fontSize: 12, nested: { ok: 1 } });
    const ws = path.join(TMP, "gw-proj"), modRoot = path.join(TMP, "gw-mod");
    assert.ok(NP.insideAny(path.join(ws, "a", "b.txt"), [ws]) && !NP.insideAny(path.join(ws, "..", "secret.txt"), [ws]) && !NP.insideAny("relative.txt", [ws]));

    const f = fakeVs({ answers: [undefined], folders: [{ uri: { fsPath: ws, scheme: "file" } }], conf: { "github.token": "SECRET", "editor.fontSize": 14 } });
    f.vs.workspace.getConfiguration = () => ({ get: (k) => ({ "github.token": "SECRET", "editor.fontSize": 14, github: { token: "SECRET", gitAuthentication: true, branch: "x" } })[k] });
    const known = new Map([["mlbg", { id: "mlbg", name: "MoonLight BG", root: modRoot, assets: modRoot }]]);
    const self = { context: { globalState: store(), globalStorageUri: { fsPath: path.join(TMP, "gw-store") } }, modules: { known: known, has: (id) => known.has(id) } };
    await withPart(f.vs, "host-ui", self, async (h) => {
        assert.ok(!(await h.onNative({ id: "mlbg", op: "config", key: "github.token" })).ok);
        assert.strictEqual((await h.onNative({ id: "mlbg", op: "config", key: "editor.fontSize" })).result, 14);
        assert.deepStrictEqual((await h.onNative({ id: "mlbg", op: "config", key: "github" })).result, { gitAuthentication: true, branch: "x" }, "раздел без секретов (флаг — не секрет)");
        assert.ok((await h.onNative({ id: "mlbg", op: "open", path: path.join(ws, "readme.md") })).ok, "в проекте — без вопроса");
        assert.strictEqual(f.shown.filter((s) => s.kind === "warn").length, 0);
        const out = await h.onNative({ id: "mlbg", op: "open", path: path.join(TMP, "elsewhere", "id_rsa") });
        assert.ok(!out.ok, "вне проекта: отказ без согласия");
        const ask = f.shown.find((s) => s.kind === "warn");
        assert.ok(ask && ask.args[1] && ask.args[1].modal && /^\[MoonLight BG\]/.test(ask.text), "модальный вопрос с именем модуля");
        await h.onNative({ id: "mlbg", op: "notify", text: "Привет" });
        assert.ok(f.shown.some((s) => s.kind === "info" && s.text === "[MoonLight BG] Привет"), "уведомление подписано модулем");
        for (let i = 0; i < 12; i++) await h.onNative({ id: "mlbg", op: "notify", text: "n" + i });
        assert.strictEqual(f.shown.filter((s) => s.kind === "info").length, NP.NOTIFY_PER_MIN, "не больше " + NP.NOTIFY_PER_MIN + " уведомлений в минуту");
    });
});

test("шлюз модулей: у модуля один вопрос за раз; ввод секрета подписан и попадает в журнал", async () => {
    const f = fakeVs({ answer: (kind) => (kind === "input" ? "пароль" : "a"), delay: 20 });
    const gs = store();
    const known = new Map([["mlbg", { id: "mlbg", name: "BG" }]]);
    await withPart(f.vs, "host-ui", { context: { globalState: gs }, modules: { known: known, has: (id) => known.has(id) } }, async (h) => {
        const [a, b] = await Promise.all([h.onNative({ id: "mlbg", op: "quickPick", items: ["a", "b"] }), h.onNative({ id: "mlbg", op: "quickPick", items: ["a"] })]);
        assert.ok(a.ok && !b.ok && b.busy, JSON.stringify([a, b]));
        const r = await h.onNative({ id: "mlbg", op: "input", prompt: "Пароль", password: true });
        assert.strictEqual(r.result, "пароль");
        const box = f.shown.find((s) => s.kind === "input").args[0];
        assert.ok(/^\[BG\].*не VS Code/.test(box.title) && box.password === true, JSON.stringify(box));
    });
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(AU.read(gs).some((x) => x.kind === "native" && /секрет/.test(x.what)));
});

test("журнал разрешений: запись, предел, «Отозвать все» сбрасывает разрешения и пишет отзыв", async () => {
    const gs = store({ [KEYS.ALLOWED_COMMANDS]: ["a.b"], [KEYS.JS_APPROVED]: { "x.js": "1" }, [KEYS.MODULES_ALLOWED]: { m: "ext:x" }, [KEYS.CHECKED_VERSION]: "1.2" });
    for (let i = 0; i < AU.MAX + 20; i++) await AU.record(gs, "command", "c" + i, "once");
    await AU.record(gs, "нет-такого", "x", "allow");
    assert.strictEqual(AU.read(gs).length, AU.MAX, "не больше MAX записей");
    assert.strictEqual(AU.read(gs)[AU.MAX - 1].what, "c" + (AU.MAX + 19), "новые в конце");
    const n = await AU.revokeAll(gs);
    assert.strictEqual(n, 3);
    assert.strictEqual(gs.get(KEYS.ALLOWED_COMMANDS), undefined);
    assert.deepStrictEqual(gs.get(KEYS.JS_APPROVED), {}, "JS — пустая карта, а не «первый запуск»");
    assert.strictEqual(gs.get(KEYS.CHECKED_VERSION), "1.2", "служебные отметки не тронуты");
    assert.ok(/^\d{4}-\d\d-\d\d \d\d:\d\d  отзыв: все разрешения \(3\)/.test(AU.lines(gs)[0]), AU.lines(gs)[0]);
});

test("ключи globalState: все строки ключей — только в lib/keys.js", () => {
    const files = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.js$/.test(e.name)) files.push(p); });
    walk(path.join(EXT, "lib"));
    files.push(path.join(EXT, "extension.js"));
    const values = Object.keys(KEYS).filter((k) => typeof KEYS[k] === "string").map((k) => KEYS[k]);
    files.filter((f) => !/[\\/]keys\.js$/.test(f)).forEach((f) => {
        const text = fs.readFileSync(f, "utf8");
        values.forEach((v) => assert.ok(text.indexOf("\"" + v + "\"") === -1, path.basename(f) + ": строка ключа " + v + " — бери из lib/keys.js"));
    });
    KEYS.GRANTS.forEach((k) => assert.ok(values.indexOf(k) !== -1, k));
});

test("журнал: секреты (токены, ключи API, пароли, Bearer, логин в URL) вырезаются", () => {
    const line = redact("ghp_" + "a".repeat(36) + " sk-ant-" + "b".repeat(30) + " Authorization: Bearer abcdefghijklmnopqrstu password=hunter22 https://user:pw@example.com/x api_key: \"zzzzzzzz\" AKIA" + "ABCDEFGHIJKLMNOP");
    ["hunter22", "abcdefghijklmnopqrstu", "user:pw", "zzzzzzzz", "a".repeat(36), "b".repeat(30), "AKIAABCDEFGHIJKLMNOP"].forEach((s) => assert.ok(line.indexOf(s) === -1, s + " в: " + line));
    assert.ok(/password=<секрет>/.test(line) && /Bearer <секрет>/.test(line) && /:\/\/<скрыто>@example\.com/.test(line), line);
    assert.strictEqual(redact("font-size: 12px; tokens: 5"), "font-size: 12px; tokens: 5", "обычный текст не трогаем");
});

test("права администратора: повышенно запускается системный cmd.exe, а не run.cmd из папки пользователя", () => {
    const base = path.join(TMP, "Пользователь el");
    const dst = path.join(base, "target");
    fs.mkdirSync(dst, { recursive: true });
    const job = E.prepareJob([{ file: path.join(dst, "workbench.html"), data: "НОВОЕ" }], base, process.execPath);
    const c = E.elevatedCommand(job, { SystemRoot: "C:\\Windows" });
    assert.strictEqual(c.shell, "C:\\Windows\\System32\\cmd.exe");
    assert.ok(c.args.indexOf("run.cmd") === -1 && c.args.indexOf(job.applySha) !== -1 && c.args.indexOf(job.jobSha) !== -1, c.args);
    assert.strictEqual(E.elevatedCommand(job, { SystemRoot: "C:\\evil\" & calc" }).shell, "C:\\Windows\\System32\\cmd.exe", "странный SystemRoot не берём");
    assert.ok(/Environment\("PROCESS"\)/.test(E.RUNAS_JS) && /MOONCORE_SHELL/.test(E.RUNAS_JS), "wscript берёт команду из окружения");
    if (process.platform !== "win32") return;
    // Настоящий cmd.exe с этой строкой (без повышения): пишет то же, что и run.cmd, — путь с кириллицей и пробелом.
    const real = E.elevatedCommand(job);
    const r = cp.spawnSync(real.shell, [real.args], { windowsVerbatimArguments: true, encoding: "utf8" });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(fs.readFileSync(path.join(dst, "workbench.html"), "utf8"), "НОВОЕ");
    // Подменённый apply.js не исполняется: хэш в командной строке.
    const j2 = E.prepareJob([{ file: path.join(dst, "workbench.html"), data: "ВТОРОЕ" }], base, process.execPath);
    fs.appendFileSync(j2.apply, "\nrequire('fs').writeFileSync(" + JSON.stringify(path.join(dst, "pwned")) + ", '1');");
    const c2 = E.elevatedCommand(j2);
    const r2 = cp.spawnSync(c2.shell, [c2.args], { windowsVerbatimArguments: true, encoding: "utf8" });
    assert.strictEqual(r2.status, 90);
    assert.ok(!fs.existsSync(path.join(dst, "pwned")));
});

test("профиль проекта: в недоверенной папке даже не предлагается; ответов не больше MAX_PROJECTS", async () => {
    const proj = path.join(TMP, "untrusted-proj");
    fs.mkdirSync(path.join(proj, ".vscode"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".vscode", "mooncore.json"), JSON.stringify({ mooncore: 1, use: "Минимал" }));
    const f = fakeVs({ trusted: false, answers: ["Включать"], folders: [{ name: "p", uri: { fsPath: proj, scheme: "file" } }] });
    const gs = store();
    await withPart(f.vs, "host-context", { context: { globalState: gs } }, async (h, mod) => {
        assert.strictEqual(await h.projectTarget(), "");
        assert.strictEqual(f.shown.length, 0, "вопроса нет");
        f.vs.workspace.isTrusted = true;
        assert.strictEqual(await h.projectTarget(), "Минимал", "доверие дали — спросили и включили");
        const map = {};
        for (let i = 0; i < mod.MAX_PROJECTS + 30; i++) map["p" + i] = { sha: "x", ok: true, at: i };
        const capped = mod.capProjects(map);
        assert.strictEqual(Object.keys(capped).length, mod.MAX_PROJECTS);
        assert.ok(capped["p" + (mod.MAX_PROJECTS + 29)] && !capped.p0, "уходят самые старые");
    });
});

test("JS-сниппеты: при первом запуске уже лежащий JS не одобряется молча", async () => {
    const f = fakeVs({ answers: [] });
    const gs = store();
    await withPart(f.vs, "host-snippets", { context: { globalState: gs } }, async (h) => {
        h.askJsPending = () => {};
        const list = [{ id: "evil.js", kind: "js", enabled: true, code: "alert(1)" }, { id: "a.css", kind: "css", enabled: true, code: "" }];
        const run = h.runnable(list);
        assert.deepStrictEqual(run.map((s) => s.id), ["a.css"], "JS ждёт одобрения");
        assert.deepStrictEqual(gs.get(KEYS.JS_APPROVED), {});
    });
});

test("селекторы: незакрытые скобки и кавычки не проходят (иначе глушат все правила после себя)", () => {
    [".a:not(.b)", "a[title=\"x]\"]", "div > .x[data-a=\"(\"]", ".a\\(b"].forEach((s) => assert.strictEqual(D.cleanSelector(s), s, s));
    [".a:is(", "a[x=\"y", ".a)(", "a[x]]", "a:not([x)]"].forEach((s) => assert.strictEqual(D.cleanSelector(s), "", s));
    assert.strictEqual(D.cleanValue("fontFamily", "\"Fira Code\", monospace"), "\"Fira Code\", monospace");
    assert.strictEqual(D.cleanValue("fontFamily", "\"Fira"), undefined);
    const d = D.emptyDesign();
    D.applyCssOps(d, [{ op: "set", selector: ".a:is(", prop: "hide", value: true }, { op: "set", selector: ".b", prop: "hide", value: true }]);
    assert.deepStrictEqual(Object.keys(d.rules), [".b"]);
});
