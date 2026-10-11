// Смоук-тесты Moon Core: проверка оболочки перед записью, галерея, сеть в стилях пакета,
// безопасный режим и пульс окон (часть хоста), Доктор: новые проблемы и «Починить всё».
"use strict";
const { test, assert, fs, path, EXT, TMP, W, S, P, D, C, BASE_HTML, CSP, withVscode } = require("./harness");
const GL = require(path.join(EXT, "lib", "gallery"));
const DM = require(path.join(EXT, "lib", "doctor-model"));
const KEYS = require(path.join(EXT, "lib", "keys"));

test("оболочка: проверка перед записью пропускает обычное внедрение и ловит порчу", () => {
    const html = BASE_HTML.replace("<meta charset=\"utf-8\" />", "<meta charset=\"utf-8\" />\n" + CSP);
    const block = W.buildBlock({ a: 1 }, "rt()", { nonce: "abcDEF12", version: "1" });
    const next = W.armCsp(W.applyBlock(html, block), "abcDEF12", "");
    assert.strictEqual(W.shellProblem(html, next), "");
    // Повторное внедрение поверх своего блока — тоже чисто.
    const again = W.armCsp(W.applyBlock(next, W.buildBlock({}, "rt2()", { nonce: "abcDEF34", version: "2" })), "abcDEF34", "abcDEF12");
    assert.strictEqual(W.shellProblem(next, again), "");
    assert.ok(W.shellProblem(html, next + block), "два блока");
    assert.ok(W.shellProblem(html, next.replace("/*cppdocs*/", "/*x*/")), "задет чужой блок");
    assert.ok(W.shellProblem(html, next.replace("<body></body>", "<body><script>1</script></body>")), "изменено тело");
    assert.ok(W.shellProblem(html, html.replace("</html>", block + "</html>")), "блок вне <head>");
    assert.ok(W.shellProblem(html, html), "блока нет вовсе");
});

test("галерея: стили проходят проверку, включаются и снимаются файлами, правки человека не затираются", () => {
    const ids = new Set();
    GL.STYLES.forEach((s) => {
        assert.ok(/^[a-z][a-z0-9-]{2,40}$/.test(s.id) && !ids.has(s.id), s.id); ids.add(s.id);
        assert.ok(S.validId(GL.fileId(s.id)), "имя файла сниппета: " + GL.fileId(s.id));
        assert.ok(s.title && s.note && s.css.length < 4000);
        assert.deepStrictEqual(S.cssNetworkHosts(s.css), [], s.id + ": без сети");
        assert.ok(!/@import|expression\(|javascript:/i.test(s.css), s.id);
        // Скобки сходятся — стиль не «проглотит» следующие сниппеты.
        assert.strictEqual(s.css.split("{").length, s.css.split("}").length, s.id + ": фигурные скобки");
        assert.ok(!/(^|[\s,])(body|html)\s*\{/.test(s.css), s.id + ": не красит корень");
    });
    const dir = fs.mkdtempSync(path.join(TMP, "gal-"));
    let r = GL.apply(dir, ["glass-widgets", "soft-shadows", "nope"]);
    assert.deepStrictEqual(r, { added: ["glass-widgets", "soft-shadows"], removed: [] });
    assert.deepStrictEqual(Array.from(GL.installed(dir)).sort(), ["glass-widgets", "soft-shadows"]);
    fs.writeFileSync(path.join(dir, GL.fileId("soft-shadows")), "/* моё */", "utf8");
    r = GL.apply(dir, ["soft-shadows"]);
    assert.deepStrictEqual(r, { added: [], removed: ["glass-widgets"] });
    assert.strictEqual(fs.readFileSync(path.join(dir, GL.fileId("soft-shadows")), "utf8"), "/* моё */", "лежащий файл не перезаписан");
    const list = S.listSnippets(dir, { disabled: [] });
    assert.deepStrictEqual(list.map((s) => s.id), ["gallery-soft-shadows.css"]);
});

test("стили пакета: адреса в сети находятся", () => {
    assert.deepStrictEqual(S.cssNetworkHosts(".a { background: url(https://Evil.example/p.png) } @import \"//cdn.x.io/a.css\"; .b { background: url('data:image/png;base64,AAA') }"), ["evil.example", "cdn.x.io"]);
    assert.deepStrictEqual(S.cssNetworkHosts(".a { background: url(vscode-file://vscode-app/x.png); color: red }"), []);
    assert.deepStrictEqual(S.cssNetworkHosts(""), []);
});

test("доктор: безопасный режим, окна со старым рантаймом, медленный модуль; план «Починить всё»", () => {
    const base = { shells: [{ file: "C:/x/workbench.html", injected: true, current: true, checksum: true, blockOk: true }], bridge: { running: true, streams: 1 }, modules: {}, snippets: {}, design: {} };
    const s = Object.assign({}, base, { safe: true, windows: [{ version: "0.1.0", stale: true }, { version: "0.2.0", stale: false }], timing: { runtime: 12, modules: { mlbg: 2300, cppdocs: 40 }, skipped: [], failed: [] } });
    const list = DM.problems(s);
    assert.ok(list.some((p) => p.fix === "safe"));
    assert.ok(list.some((p) => /старым рантаймом: 1/.test(p.title) && p.fix === "reload"));
    assert.ok(list.some((p) => /mlbg \(2300 мс\)/.test(p.title)) && !list.some((p) => /cppdocs \(/.test(p.title)));
    assert.ok(list.every((p) => !p.fix || DM.ACTIONS.includes(p.fix)));
    assert.deepStrictEqual(DM.problems(Object.assign({}, base, { windows: [{ version: "1", stale: false }], timing: { runtime: 30, modules: { a: 20 } } })), []);
    const plan = DM.autoPlan([{ fix: "reload" }, { fix: "jsReview" }, { fix: "inject" }, { fix: "log" }, { fix: "inject" }]);
    assert.deepStrictEqual(plan, { fixes: ["inject", "jsReview"], reload: true });
    assert.deepStrictEqual(DM.autoPlan([]), { fixes: [], reload: false });
});

test("хост: безопасный режим чистит состояние окна, пульс окон, облегчённая рассылка", () => withVscode(() => {
    const { Part, STATIC_FIELDS } = require(path.join(EXT, "lib", "host-safety"));
    const store = {};
    const host = Object.create(Part.prototype);
    host.context = { globalState: { get: (k) => store[k], update: async (k, v) => { store[k] = v; } }, extension: { packageJSON: { version: "0.2.0" } } };
    assert.strictEqual(host.safeMode(), false);
    store[KEYS.SAFE_MODE] = true;
    assert.strictEqual(host.safeMode(), true);
    const extra = host.safeExtra({ design: { rules: { ".a": { props: { hide: true } } }, settings: { "editor.fontSize": { value: 14 } }, colors: {}, buttons: [{ id: "b123" }], fx: { lineGlow: true }, css: ".a{}" }, uiButtons: [{ id: "x123" }], catalog: [1] });
    assert.strictEqual(extra.safe, true);
    assert.deepStrictEqual(extra.design.rules, {});
    assert.deepStrictEqual(extra.design.fx, {});
    assert.deepStrictEqual(extra.design.buttons, []);
    assert.deepStrictEqual(extra.uiButtons, []);
    assert.ok(extra.design.settings["editor.fontSize"], "настройки VS Code остаются: их видно во вкладке «Правки»");
    assert.deepStrictEqual(extra.catalog, [1]);

    assert.strictEqual(host.onHello({ win: "../x", version: "1" }).ok, false);
    assert.deepStrictEqual(host.onHello({ win: "a1b2c3d4e5f60718", version: "0.1.0", rev: "r" }), { ok: true, version: "0.2.0" });
    host.onHello({ win: "ffffffffffffffff", version: "0.2.0", perf: { freezes: 3, freezeMs: 900, freezeMax: -5, heapMb: "много", up: 60 } });
    assert.deepStrictEqual(host.windowsInfo(), [
        { win: "a1b2c3d4e5f60718", version: "0.1.0", stale: true, perf: null },
        { win: "ffffffffffffffff", version: "0.2.0", stale: false, perf: { freezes: 3, freezeMs: 900, freezeMax: 0, heapMb: 0, up: 60 } },
    ]);
    host.windows.get("a1b2c3d4e5f60718").at = Date.now() - 10 * 60000;
    assert.strictEqual(host.windowsInfo().length, 1, "замолчавшее окно забыто");
    for (let i = 0; i < 80; i++) host.onHello({ win: ("0000000000000000" + i.toString(16)).slice(-16), version: "0.2.0" });
    assert.ok(host.windows.size <= 64, "окон не больше лимита");

    const slim = host.slimState({ v: 1, rev: "r", snippets: [], design: {}, catalog: [1], zones: [2], props: {}, fxSpec: {}, tokenGroups: [], profiles: {} });
    STATIC_FIELDS.forEach((k) => assert.ok(!(k in slim), k));
    assert.deepStrictEqual(Object.keys(slim).sort(), ["design", "profiles", "rev", "snippets", "v"]);
    assert.ok(P.METHODS.includes("hello"));
}));

test("подсказки в сниппете: селектор находится в тексте и с другими пробелами", () => withVscode(() => {
    const X = require(path.join(EXT, "lib", "ext", "extras"));
    const text = "/* x */\n.part.sidebar   >  .title {\n  color: red;\n}\n.a.b { }";
    assert.deepStrictEqual(X.findSelector(text, ".a.b"), [text.indexOf(".a.b"), text.indexOf(".a.b") + 4]);
    const hit = X.findSelector(text, ".part.sidebar > .title");
    assert.strictEqual(text.slice(hit[0], hit[1]), ".part.sidebar   >  .title");
    assert.strictEqual(X.findSelector(text, ".nope[aria-label=\"(x\"]"), null);
}));
