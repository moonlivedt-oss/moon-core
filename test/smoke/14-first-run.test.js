// Смоук-тесты Moon Core: первый запуск после установки — самовнедрение без вопросов и настройки.
"use strict";
const { test, assert, fs, path, EXT, TMP, W } = require("./harness");

const Module = require("module");
const SHELL = "<!DOCTYPE html><html><head>\n<meta charset=\"utf-8\" />\n</head><body></body></html>\n";

/** Поддельная установка VS Code (appRoot/out/.../workbench.html) и заглушка vscode с настройками conf. */
function fakeVscode(name, conf) {
    const appRoot = path.join(TMP, name, "app");
    const wbDir = path.join(appRoot, "out", "vs", "code", "electron-browser", "workbench");
    fs.mkdirSync(wbDir, { recursive: true });
    fs.writeFileSync(path.join(wbDir, "workbench.html"), SHELL, "utf8");
    const shown = [];
    const answer = () => Promise.resolve(undefined);   // на вопросы (перезагрузить и т.п.) — молчим
    const vs = {
        version: "1.200.0",
        env: { appRoot: appRoot },
        ConfigurationTarget: { Global: 1 },
        Uri: { file: (p) => ({ fsPath: p }) },
        extensions: { all: [], getExtension: () => undefined },
        commands: { executeCommand: () => Promise.resolve() },
        window: {
            showInformationMessage: (t) => { shown.push(["info", t]); return answer(); },
            showWarningMessage: (t) => { shown.push(["warn", t]); return answer(); },
            showErrorMessage: (t) => { shown.push(["error", t]); return answer(); },
            showTextDocument: () => Promise.resolve(),
        },
        workspace: {
            getConfiguration: () => ({
                get: (k, d) => (Object.prototype.hasOwnProperty.call(conf, k) ? conf[k] : d),
                inspect: () => undefined,
                update: () => Promise.resolve(),
            }),
        },
    };
    const store = {};
    const context = {
        extensionPath: EXT,
        extension: { id: "moonlivedt.moon-core", packageJSON: { version: "9.9.9" } },
        globalStorageUri: { fsPath: path.join(TMP, name, "storage") },
        globalState: { get: (k) => store[k], update: (k, v) => { store[k] = v; return Promise.resolve(); }, keys: () => Object.keys(store) },
    };
    return { vs, context, store, shown, file: path.join(wbDir, "workbench.html") };
}

/** Загрузить lib/inject заново поверх заглушки vscode (кэш других тестов держит прежнюю). */
async function withFlows(vs, fn) {
    const libDir = path.join(EXT, "lib") + path.sep;
    const drop = () => Object.keys(require.cache).forEach((k) => { if (k.indexOf(libDir) === 0) delete require.cache[k]; });
    const orig = Module._resolveFilename;
    Module._resolveFilename = function (req) { return req === "vscode" ? "vscode" : orig.apply(this, arguments); };
    require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: vs };
    drop();
    try { return await fn(require(path.join(EXT, "lib", "inject", "flows"))); }
    finally { Module._resolveFilename = orig; delete require.cache.vscode; drop(); }
}

test("первый запуск: Moon Core встраивается сам, без вопроса «Внедрить?»", async () => {
    const f = fakeVscode("first", {});
    await withFlows(f.vs, (FL) => FL.checkOnActivate(f.context));
    assert.ok(W.isInjected(fs.readFileSync(f.file, "utf8")), "блок в оболочке");
    assert.strictEqual(f.store["mooncore.wantInjected"], true);
    assert.ok(!f.shown.some((s) => /Внедрить\?/.test(s[1])), "не спрашивали");
    assert.ok(f.shown.some((s) => /установлен и встроен/.test(s[1])), "предложили перезагрузку");
    // Повторный запуск ничего не переписывает.
    const before = fs.readFileSync(f.file, "utf8");
    await withFlows(f.vs, (FL) => FL.checkOnActivate(f.context));
    assert.strictEqual(fs.readFileSync(f.file, "utf8"), before);
});

test("первый запуск: autoInject выключен или Moon Core убирали сами — только вопрос", async () => {
    const off = fakeVscode("off", { autoInject: false });
    await withFlows(off.vs, (FL) => FL.checkOnActivate(off.context));
    assert.ok(!W.isInjected(fs.readFileSync(off.file, "utf8")));
    assert.ok(off.shown.some((s) => /Внедрить\?/.test(s[1])));
    const removed = fakeVscode("removed", {});
    removed.store["mooncore.wantInjected"] = false;
    await withFlows(removed.vs, (FL) => FL.checkOnActivate(removed.context));
    assert.ok(!W.isInjected(fs.readFileSync(removed.file, "utf8")), "«Убрать» уважается");
});

test("свои модули (расширения moonlivedt.*) разрешаются сами, чужие — только по согласию", async () => {
    const mk = (id) => {
        const dir = path.join(TMP, "own-" + id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "rt.js"), "void 0;\n", "utf8");
        return dir;
    };
    const ext = (extId, modId) => ({ id: extId, extensionPath: mk(modId), packageJSON: { moonCore: { modules: [{ id: modId, name: modId, script: "rt.js", assets: "." }] } } });
    const f = fakeVscode("own", {});
    f.vs.extensions.all = [ext("moonlivedt.moonlight-custom-bg", "mlbg"), ext("stranger.thing", "alien"), ext("moonlivedt.cpp-docs-panel", "cppdocs")];
    f.context.extension.packageJSON.publisher = "moonlivedt";
    f.store["mooncore.modules.denied"] = { cppdocs: "ext:moonlivedt.cpp-docs-panel" };   // человек запретил сам
    await withFlows(f.vs, async () => {
        const MH = require(path.join(EXT, "lib", "module-host"));
        assert.strictEqual(await MH.autoAllowOwn(f.context), true);
        assert.deepStrictEqual(MH.allowed(f.context).map((m) => m.id), ["mlbg"], "своё — да, чужое и запрещённое — нет");
        // Код своего модуля обновился вместе с расширением — встраивается без вопроса.
        const m = MH.allowed(f.context)[0];
        MH.vetScripts(f.context, [m], [{ id: "mlbg", code: "a", sha: "1" }]);
        const v = MH.vetScripts(f.context, [m], [{ id: "mlbg", code: "b", sha: require("crypto").createHash("sha256").update("b").digest("hex") }]);
        assert.strictEqual(v.pending.length, 0);
        assert.strictEqual(v.scripts[0].code, "b");
    });
    assert.ok(!f.shown.length, "никаких вопросов");
});
