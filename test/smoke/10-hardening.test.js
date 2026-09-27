// Смоук-тесты Moon Core: надёжность — атомарная запись, CSP, откат плана, мост, журнал, кнопки расширений.
"use strict";
const { test, withVscode, assert, fs, path, EXT, TMP, W, D, P, createBridge, BASE_HTML, request } = require("./harness");

const X = require(path.join(EXT, "lib", "fsx"));

test("файлы: атомарная запись, повтор rename, отпечаток по времени и размеру", () => {
    const dir = fs.mkdtempSync(path.join(TMP, "fsx-"));
    const f = path.join(dir, "a.json");
    X.writeAtomic(f, "{\"a\":1}");
    assert.strictEqual(fs.readFileSync(f, "utf8"), "{\"a\":1}");
    X.writeAtomic(f, Buffer.from("xyz"), ".t");
    assert.strictEqual(fs.readFileSync(f, "utf8"), "xyz");
    assert.deepStrictEqual(fs.readdirSync(dir), ["a.json"], "временных файлов не осталось");
    const k1 = X.statKey([f, path.join(dir, "нет")]);
    assert.ok(/\|-$/.test(k1), "нет файла — «-»");
    fs.writeFileSync(f, "longer text");
    assert.notStrictEqual(X.statKey([f]), k1.split("|")[0]);
    assert.throws(() => X.renameRetry(path.join(dir, "нет"), f), /ENOENT/);
    const t0 = Date.now(); X.sleepSync(20); assert.ok(Date.now() - t0 >= 15);
});

test("файлы: слежение через папку переживает атомарное сохранение и не роняет процесс", async () => {
    const dir = fs.mkdtempSync(path.join(TMP, "watch-"));
    const f = path.join(dir, "mod.js");
    fs.writeFileSync(f, "1");
    let hits = 0;
    const w = X.watchFile(f, () => { hits++; });
    assert.ok(w.listenerCount("error") > 0, "у watcher есть обработчик ошибок");
    const save = (text) => { fs.writeFileSync(f + ".tmp", text); fs.renameSync(f + ".tmp", f); };
    save("2");
    await new Promise((r) => setTimeout(r, 150));
    const first = hits;
    save("3");
    await new Promise((r) => setTimeout(r, 150));
    w.close();
    assert.ok(first > 0 && hits > first, "события идут и после сохранения через rename (" + first + ", " + hits + ")");
});

test("CSP: nonce не ломает 'unsafe-inline' VS Code, а где его нет — добавляется", () => {
    const withCsp = (content) => BASE_HTML.replace("<meta charset=\"utf-8\" />", "<meta http-equiv=\"Content-Security-Policy\" content=\"" + content + "\">");
    const a = W.armCsp(withCsp("default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'"), "N0NCE001", "");
    assert.ok(/script-src 'self' 'nonce-N0NCE001'/.test(a), "скрипту нужен nonce");
    assert.ok(/style-src 'self' 'unsafe-inline';/.test(a), "в style-src с 'unsafe-inline' nonce не добавлен (иначе он выключил бы инлайн-стили VS Code)");
    const b = W.armCsp(withCsp("script-src 'self' 'unsafe-inline'; style-src 'self'"), "N0NCE002", "");
    assert.ok(/script-src 'self' 'unsafe-inline'"?;/.test(b) && !/script-src[^;]*nonce/.test(b));
    assert.ok(/style-src 'self' 'nonce-N0NCE002'/.test(b));
    assert.strictEqual(W.stripBlock(W.applyBlock(b, W.buildBlock({}, "1", { nonce: "N0NCE002", version: "1" }))).includes("N0NCE002"), false, "снятие убирает свой nonce");
    // script-src нет: новая директива копирует default-src (иначе скрипты VS Code отрезаны),
    // после снятия не остаётся пустой «script-src;», которая запретила бы все скрипты.
    const c = W.armCsp(withCsp("default-src 'self' vscode-file:; style-src 'self' 'unsafe-inline'"), "N0NCE003", "");
    assert.ok(/script-src 'self' vscode-file: 'nonce-N0NCE003'; default-src/.test(c), c);
    const cOff = W.stripBlock(W.applyBlock(c, W.buildBlock({}, "1", { nonce: "N0NCE003", version: "1" })));
    assert.ok(!/script-src\s*;/.test(cOff) && /script-src 'self' vscode-file:;/.test(cOff), cOff);
    const e = W.armCsp(withCsp("style-src 'self'"), "N0NCE004", "");
    assert.ok(!/script-src/.test(e), "без default-src и script-src скрипты не ограничены — директиву не придумываем");
});

test("план записи: ошибка посреди плана откатывает уже записанное", () => withVscode(() => {
    const PL = require(path.join(EXT, "lib", "inject", "plan"));
    const dir = fs.mkdtempSync(path.join(TMP, "plan-"));
    const a = path.join(dir, "workbench.html"), gone = path.join(dir, "old-mod.js"), fresh = path.join(dir, "new.js");
    fs.writeFileSync(a, "ORIGINAL");
    fs.writeFileSync(gone, "OLD MODULE");
    const ops = [
        { file: a, data: "PATCHED", atomic: true },
        { file: fresh, data: "NEW" },
        { file: gone, remove: true },
        { file: path.join(dir, "нет-папки", "x.js"), data: "boom" },   // ENOENT
    ];
    assert.throws(() => PL.execPlan(ops), /ENOENT/);
    assert.strictEqual(fs.readFileSync(a, "utf8"), "ORIGINAL", "оболочка вернулась");
    assert.strictEqual(fs.existsSync(fresh), false, "новый файл убран");
    assert.strictEqual(fs.readFileSync(gone, "utf8"), "OLD MODULE", "удалённый файл восстановлен");
    PL.execPlan(ops.slice(0, 3));
    assert.strictEqual(fs.readFileSync(a, "utf8"), "PATCHED");
    assert.ok(fs.existsSync(fresh) && !fs.existsSync(gone));
}));

test("мост: только JSON, оборванный запрос не роняет хост", async () => {
    const b = createBridge({ file: path.join(TMP, "bridge-json.json"), dispatch: async () => ({ ok: true }), hello: () => [] });
    await b.ready;
    const base = { method: "POST", path: "/rpc/" + b.token + "/log", headers: { "Origin": "vscode-file://vscode-app" } };
    assert.strictEqual((await request(b.port, Object.assign({}, base, { headers: Object.assign({ "Content-Type": "text/plain" }, base.headers) }), "{}")).status, 415);
    assert.strictEqual((await request(b.port, Object.assign({}, base, { headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, base.headers) }), "{}")).status, 200);
    await new Promise((resolve) => {
        const req = require("http").request({ host: "127.0.0.1", port: b.port, agent: false, method: "POST", path: base.path, headers: Object.assign({ "Content-Type": "application/json", "Content-Length": 100 }, base.headers) });
        req.on("error", () => resolve());
        req.write("{\"a\":");
        setTimeout(() => { req.destroy(); resolve(); }, 50);
    });
    assert.strictEqual((await request(b.port, { path: "/ping/" + b.token })).status, 200, "мост жив");
    b.dispose();
});

test("журнал: токены моста вырезаются, последние строки доступны для отчёта", () => {
    const L = require(path.join(EXT, "lib", "log"));
    const tok = "ab".repeat(24);
    assert.strictEqual(L.redact("GET /events/" + tok + " ok"), "GET /events/<токен> ok");
    L.log("строка для отчёта " + tok);
    const tail = L.recentLog(5);
    assert.ok(tail.length >= 1 && tail[tail.length - 1].includes("строка для отчёта <токен>"));
});

test("кнопки расширений: свой id, onClick без команды, разные владельцы не сталкиваются", () => withVscode(() => {
    assert.strictEqual(D.cleanButton({ id: "xabc123", zone: "editor", command: "a.b", icon: "play" }), null, "в конструкторе id только «b...»");
    assert.ok(D.cleanButton({ id: "xabc123", zone: "editor", command: "a.b", icon: "play" }, { ext: true }));
    assert.ok(D.cleanButton({ id: "xabc123", zone: "editor", command: null, label: "Go" }, { ext: true }), "без команды — если есть подпись");
    assert.strictEqual(D.cleanButton({ id: "xabc123", zone: "editor", command: null }, { ext: true }), null, "без команды и без подписи — нельзя");
    assert.strictEqual(D.cleanButton({ id: "babc123", zone: "editor", command: null, label: "Go" }), null, "своей кнопке команда обязательна");
    const { Part } = require(path.join(EXT, "lib", "host-ui"));
    let rebuilds = 0;
    const fake = { scheduleRebuild: () => { rebuilds++; } };
    const one = Part.prototype.uiApi.call(fake, "Расширение А").button({ id: "run", zone: "statusbar-left", icon: "play", onClick: () => {} });
    const two = Part.prototype.uiApi.call(fake, "Расширение Б").button({ id: "run", zone: "statusbar-left", command: "b.run", label: "Run" });
    const again = Part.prototype.uiApi.call(fake, "Расширение А").button({ id: "run", zone: "statusbar-left", icon: "play", onClick: () => {} });
    assert.ok(/^x[0-9a-f]{12}$/.test(one.id) && one.id !== two.id && one.id === again.id);
    assert.strictEqual(fake.uiButtons.size, 2);
    assert.strictEqual(Part.prototype.uiList.call(fake).find((b) => b.id === one.id).command, "");
    assert.throws(() => Part.prototype.uiApi.call(fake, "В").button({ id: "z", zone: "editor", label: "без действия" }), /command или onClick/);
    one.dispose();
    assert.strictEqual(fake.uiButtons.size, 1);
    assert.ok(rebuilds >= 4);
    return Part.prototype.onUiClick.call(fake, { id: "x000000000000" }).then((r) => assert.strictEqual(r.retry, true, "чужую кнопку — следующему хосту"));
}));

test("сниппеты: команды не выпускают путь за папку сниппетов", () => withVscode(() => {
    const { Part } = require(path.join(EXT, "lib", "host-snippets"));
    const fake = { dir: path.join(TMP, "snips") };
    ["../../evil.css", "..\\x.js", "a/b.css", "", null, "ok.css"].forEach((v) => {
        const id = Part.prototype.snippetId.call(fake, v);
        assert.strictEqual(id, v === "ok.css" ? "ok.css" : "", String(v));
    });
    assert.throws(() => Part.prototype.fileOf.call(fake, "../x.css"), /недопустимое имя/);
}));

test("Доктор: страница без изменений рендерится одинаково (не мигает), есть кнопка отчёта", () => withVscode(() => {
    const doc = require(path.join(EXT, "lib", "doctor"));
    const DM = require(path.join(EXT, "lib", "doctor-model"));
    const s = { vscode: "1.0", ext: "0.1.0", shells: [], bridge: { running: true, streams: 1, port: 47300, requests: 1 }, timing: null,
        modules: { found: [], pending: [] }, design: { rules: 0, settings: 0, active: "", dirty: false, profiles: 0 },
        snippets: { total: 0, on: 0, errors: [], jsPending: [] }, check: null, recovery: "r.cmd" };
    const a = doc.render(s, DM.problems(s), "MARK", false), b = doc.render(s, DM.problems(s), "MARK", false);
    assert.strictEqual(a, b);
    assert.ok(a.includes("data-cmd=report") && DM.ACTIONS.includes("report"));
    assert.strictEqual(typeof doc.reportText, "function");
}));

test("главный процесс: папка данных — id расширения в нижнем регистре", () => {
    const DP = require(path.join(EXT, "lib", "deep"));
    assert.ok(DP.mainScript("MoonLiveDT.Moon-Core").includes("\"moonlivedt.moon-core\""));
});

test("протокол: окно проверяет версию в состоянии хоста", () => {
    const rt = fs.readFileSync(path.join(EXT, "runtime", "mooncore-runtime.js"), "utf8");
    assert.ok(/function checkProto\(d\)/.test(rt) && rt.includes("checkProto(d)"));
    assert.strictEqual(typeof P.VERSION, "number");
});
