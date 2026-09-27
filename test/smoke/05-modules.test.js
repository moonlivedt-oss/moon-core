// Смоук-тесты Moon Core: Модули: манифест, блок, хаб, данные.
"use strict";
const { test, assert, fs, os, path, http, EXT, TMP, W, S, P, createBridge, readHosts, D, C, DesignEngine, M, K, CMD, B, AP, D2, E2,
    BASE_HTML, CSP, request, makeEngine, makeModuleDir } = require("./harness");

// ------------------------------------------------------------------ модули

test("модули: манифест из папки и из package.json, проверка путей и id", () => {
    const dir = makeModuleDir("ok", { id: "mlbg", name: "BG", version: "20.0.0", script: "dist/bg.js", assets: "assets" },
        { "dist/bg.js": "window.x = 1;", "assets/a.jpg": "img", "readme.txt": "x" });
    const r = M.fromFolder(dir);
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.module.id, "mlbg");
    assert.strictEqual(r.module.script, fs.realpathSync(path.join(dir, "dist", "bg.js")));
    assert.strictEqual(r.module.assets, fs.realpathSync(path.join(dir, "assets")));
    assert.strictEqual(r.module.source, "dir:" + dir);

    const bad = (raw) => M.normalize(raw, dir, "t");
    assert.ok(!bad({ id: "Mlbg", script: "dist/bg.js" }).ok, "заглавные в id");
    assert.ok(!bad({ id: "x", script: "dist/bg.js" }).ok, "id короче 2");
    assert.ok(!bad({ id: "mlbg", script: path.join(dir, "dist", "bg.js") }).ok, "абсолютный путь");
    assert.ok(!bad({ id: "mlbg", script: "readme.txt" }).ok, "не .js");
    assert.ok(!bad({ id: "mlbg", script: "nope.js" }).ok, "нет файла");
    assert.ok(!bad({ id: "mlbg", script: "dist/bg.js", assets: ".." }).ok, "assets вне модуля");
    assert.ok(!bad({ id: "mlbg", script: "dist" }).ok, "папка вместо файла");
    assert.ok(!bad(null).ok && !bad([1]).ok);
    assert.ok(!M.fromFolder(path.join(TMP, "нет-такой")).ok);

    // Выход наружу через ..: скрипт соседнего модуля.
    const other = makeModuleDir("other", null, { "x.js": "1" });
    assert.ok(!M.normalize({ id: "mlbg", script: "../" + path.basename(other) + "/x.js" }, dir, "t").ok);

    const pkg = { moonCore: { modules: [{ id: "mlbg", script: "dist/bg.js" }, { id: "BAD", script: "dist/bg.js" }] } };
    const fromPkg = M.fromPackage(pkg, dir, "moonlivedt.bg");
    assert.strictEqual(fromPkg.length, 2);
    assert.ok(fromPkg[0].ok && fromPkg[0].module.source === "ext:moonlivedt.bg");
    assert.ok(!fromPkg[1].ok);
    assert.deepStrictEqual(M.fromPackage({}, dir, "x"), []);
});

test("модули: симлинк наружу не пропускается", () => {
    const dir = makeModuleDir("link", null, {});
    const outside = makeModuleDir("outside", null, { "evil.js": "1" });
    try { fs.symlinkSync(path.join(outside, "evil.js"), path.join(dir, "evil.js"), "file"); }
    catch (e) { return; }   // без прав на симлинки (Windows) проверять нечего
    assert.ok(!M.normalize({ id: "evil", script: "evil.js" }, dir, "t").ok);
});

test("модули: сведение (дубли id, порядок), чтение скриптов, отпечаток", () => {
    const a = makeModuleDir("a", { id: "aa", script: "a.js" }, { "a.js": "A()" });
    const b = makeModuleDir("b", { id: "aa", script: "b.js" }, { "b.js": "B()" });
    const c = makeModuleDir("c", { id: "cc", script: "c.js" }, { "c.js": "C()" });
    const r = M.collect([M.fromFolder(a), M.fromFolder(b), { ok: false, error: "сломан" }, M.fromFolder(c)]);
    assert.deepStrictEqual(r.modules.map((m) => m.id), ["aa", "cc"]);
    assert.strictEqual(r.modules[0].root, fs.realpathSync(a));
    assert.strictEqual(r.errors.length, 2);
    const s = M.loadScripts(r.modules);
    assert.deepStrictEqual(s.scripts.map((x) => x.code), ["A()", "C()"]);
    const fp1 = M.fingerprint(s.scripts);
    fs.writeFileSync(path.join(c, "c.js"), "C2()", "utf8");
    assert.notStrictEqual(M.fingerprint(M.loadScripts(r.modules).scripts), fp1);
    const info = M.bootInfo(r.modules, (p) => "file:///" + p.replace(/\\/g, "/"));
    assert.ok(info[0].base.endsWith("/") && info[0].id === "aa");
});

test("модули: блок в оболочке — модули после рантайма, sha меняется, снятие чистое", () => {
    const mods = [{ id: "mlbg", code: "bg(); var s = '</script><!--';" }, { id: "cc", code: "cc()" }];
    const plain = W.buildBlock({}, "rt()", { nonce: "abcDEF12", version: "1" });
    const block = W.buildBlock({ modules: [] }, "rt()", { nonce: "abcDEF12", version: "1", modules: mods });
    const html = W.applyBlock(BASE_HTML, block);
    const iRt = html.indexOf("rt()"), iBg = html.indexOf("bg()"), iCc = html.indexOf("cc()");
    assert.ok(iRt > 0 && iRt < iBg && iBg < iCc, "порядок: рантайм, затем модули по списку");
    assert.strictEqual(html.split('data-mooncore-module="').length - 1, 2);
    assert.strictEqual(html.split('nonce="abcDEF12"').length - 1, 8, "nonce у всех скриптов (boot, рантайм, 2 модуля и по 2 метки на модуль)");
    assert.ok(!/<\/script><!--';/.test(html), "</script> внутри модуля экранирован");
    const info = W.blockInfo(html);
    assert.deepStrictEqual(info.modules, ["mlbg", "cc"]);
    assert.strictEqual(info.sha, W.blockSha("rt()", mods));
    assert.notStrictEqual(info.sha, W.blockInfo(W.applyBlock(BASE_HTML, plain)).sha);
    assert.strictEqual(W.blockSha("rt()", []), W.sha256("rt()"), "без модулей — как раньше");
    assert.notStrictEqual(W.blockSha("rt()", mods), W.blockSha("rt()", [mods[0], { id: "cc", code: "cc2()" }]));
    assert.deepStrictEqual(W.blockInfo(W.applyBlock(BASE_HTML, plain)).modules, []);
    assert.strictEqual(W.stripBlock(html), BASE_HTML);
});

test("модули файлами: тег src рядом с оболочкой, защита запуска первой строкой, метки вокруг", () => {
    const mods = [{ id: "mlbg", code: "bg()", file: W.moduleFileName("mlbg") }];
    const html = W.applyBlock(BASE_HTML, W.buildBlock({}, "rt()", { nonce: "abcDEF12", version: "1", modules: mods }));
    assert.ok(html.indexOf('src="mooncore-mod-mlbg.js" data-mooncore-module="mlbg"') !== -1, "модуль подключён по src");
    assert.strictEqual(html.indexOf("bg()"), -1, "кода модуля в оболочке нет");
    assert.ok(html.indexOf("_modStart(\"mlbg\")") < html.indexOf("mooncore-mod-mlbg.js") && html.indexOf("mooncore-mod-mlbg.js") < html.indexOf("_modDone(\"mlbg\")"));
    const file = W.moduleFileContent("mlbg", "bg()");
    assert.ok(/^if \(window\.__MOONCORE__ && window\.__MOONCORE__\._skip && window\.__MOONCORE__\._skip\("mlbg"\)\) throw/.test(file));
    assert.ok(file.indexOf("\nbg()\n") !== -1);
    assert.strictEqual(W.stripBlock(html), BASE_HTML);
    // Лишние файлы модулей находятся и удаляются, свои — остаются.
    const d = fs.mkdtempSync(path.join(TMP, "mods-"));
    fs.writeFileSync(path.join(d, "mooncore-mod-old.js"), "x"); fs.writeFileSync(path.join(d, "mooncore-mod-mlbg.js"), "x"); fs.writeFileSync(path.join(d, "external.js"), "x");
    assert.deepStrictEqual(W.moduleFilesIn(d, ["mooncore-mod-mlbg.js"]).map((f) => path.basename(f)), ["mooncore-mod-old.js"]);
    W.removeModuleFiles(d, []);
    assert.deepStrictEqual(fs.readdirSync(d), ["external.js"], "чужие файлы (custom-ui-style) не трогаем");
});

test("модули: хаб — события, кэш для новых окон, запросы, лимиты", async () => {
    const sent = [];
    const hub = new M.ModuleHub({ broadcast: (e, d) => sent.push([e, d]) });
    hub.setModules([{ id: "mlbg" }]);
    const api = hub.api("mlbg");
    assert.strictEqual(api.active, true);
    assert.strictEqual(hub.api("other").active, false);
    assert.throws(() => hub.api("BAD"));

    api.publish("live", { branch: "main" }, { scope: "window" });
    api.publish("live", { branch: "dev" }, { scope: "window" });
    api.publish("theme", "dark");
    assert.deepStrictEqual(sent[0], ["module", { id: "mlbg", event: "live", scope: "window", data: { branch: "main" } }]);
    assert.deepStrictEqual(hub.hello().map((h) => [h.data.event, h.data.data]), [["live", { branch: "dev" }], ["theme", "dark"]]);
    assert.throws(() => api.publish("bad event!", 1));
    assert.throws(() => api.publish("big", "x".repeat(M.LIMITS.MAX_DATA + 1)));
    const circ = {}; circ.self = circ;
    assert.throws(() => api.publish("circ", circ));
    for (let i = 0; i < M.LIMITS.MAX_CACHED + 5; i++) api.publish("e" + i, i);
    assert.strictEqual(hub.hello().length, M.LIMITS.MAX_CACHED);

    assert.deepStrictEqual(await hub.dispatch({ id: "nope", method: "x" }), { ok: false, error: "unknown module" });
    assert.deepStrictEqual(await hub.dispatch({ id: "mlbg", method: "x" }), { ok: false, error: "no handler" });
    const sub = api.onRequest(async (method, body) => {
        if (method === "fail") throw new Error("боль");
        return { method: method, body: body, fn: () => 1 };
    });
    assert.deepStrictEqual(await hub.dispatch({ id: "mlbg", method: "sum", body: { a: 1 } }), { ok: true, result: { method: "sum", body: { a: 1 } } });
    assert.deepStrictEqual(await hub.dispatch({ id: "mlbg", method: "fail" }), { ok: false, error: "боль" });
    assert.deepStrictEqual(await hub.dispatch({ id: "mlbg", method: "bad method!" }), { ok: false, error: "bad method" });
    sub.dispose();
    assert.deepStrictEqual(await hub.dispatch({ id: "mlbg", method: "sum" }), { ok: false, error: "no handler" });
});

test("модули: файл данных — запись окна и расширения, чтение, лимиты", () => {
    const dir = path.join(TMP, "moddata");
    const hub = new M.ModuleHub({ broadcast: () => {}, dataDir: dir });
    hub.setModules([{ id: "mlbg" }]);
    const api = hub.api("mlbg");
    assert.strictEqual(api.readData(), null, "файла ещё нет");
    assert.deepStrictEqual(hub.saveFromWindow({ id: "mlbg", data: { v: 1, cfg: { a: 1 } } }), { ok: true });
    assert.deepStrictEqual(api.readData(), { v: 1, cfg: { a: 1 } });
    assert.strictEqual(M.dataFile(dir, "mlbg"), path.join(dir, "mlbg.json"));
    api.writeData({ v: 2 });
    assert.deepStrictEqual(hub.readData("mlbg"), { v: 2 });
    assert.deepStrictEqual(hub.saveFromWindow({ id: "nope", data: {} }), { ok: false, error: "unknown module" });
    assert.ok(!hub.saveFromWindow({ id: "mlbg", data: [1] }).ok, "массив не принимается");
    assert.ok(!hub.saveFromWindow({ id: "mlbg", data: "x" }).ok, "строка не принимается");
    assert.ok(!hub.saveFromWindow({ id: "mlbg", data: { big: "x".repeat(M.LIMITS.MAX_MODULE_DATA) } }).ok, "лимит объёма");
    assert.deepStrictEqual(hub.readData("mlbg"), { v: 2 }, "неудачная запись не портит файл");
    fs.writeFileSync(M.dataFile(dir, "mlbg"), "{битый", "utf8");
    assert.strictEqual(hub.readData("mlbg"), null, "битый файл — null");
    assert.throws(() => hub.writeData("../x", {}));
    const info = M.bootInfo([{ id: "mlbg", name: "BG", version: "1", assets: dir }], (p) => "file:///" + p.replace(/\\/g, "/"), dir);
    assert.ok(info[0].dataUrl.endsWith("/mlbg.json"));
    assert.strictEqual(M.bootInfo([{ id: "mlbg", assets: dir }], (p) => p)[0].dataUrl, "", "без папки данных — пустой адрес");
});
