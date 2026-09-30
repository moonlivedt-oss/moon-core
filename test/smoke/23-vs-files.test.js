// Смоук-тесты Moon Core: файлы установки VS Code — стили внутри webview, целостность, классы,
// история правок в файле, копии сниппетов. Установка VS Code — поддельная, во временной папке.
"use strict";
const { test, assert, fs, path, EXT, TMP, W, S, D, DesignEngine, BASE_HTML } = require("./harness");
const crypto = require("crypto");
const WV = require(path.join(EXT, "lib", "webview-patch"));
const VF = require(path.join(EXT, "lib", "vs-files"));
const DP = require(path.join(EXT, "lib", "deep"));
const BK = require(path.join(EXT, "lib", "backups"));
const DM = require(path.join(EXT, "lib", "doctor-model"));
const { History } = require(path.join(EXT, "lib", "history"));

const SCRIPT = "\n\t\tconst defaultStyles = document.createElement('style');\n\t\tdefaultStyles.textContent = `\n\t\t@layer vscode-default {\n\t\t\thtml { color: red; }\n\t\t}`;\n\t\tconst other = `x`;\n\t";
function webviewHtml(eol) {
    const hash = crypto.createHash("sha256").update(SCRIPT, "utf8").digest("base64");
    const html = "<!DOCTYPE html>\n<html>\n<head>\n<meta http-equiv=\"Content-Security-Policy\"\n\tcontent=\"default-src 'none'; script-src 'sha256-" + hash + "' 'self'; style-src 'unsafe-inline';\">\n</head>\n<body>\n\t<script async type=\"module\">" + SCRIPT + "</script>\n</body>\n</html>\n";
    return eol === "\r\n" ? html.replace(/\n/g, "\r\n") : html;
}

test("webview: CSS вписывается в стили по умолчанию, хэш скрипта пересчитан, снятие — байт в байт (LF и CRLF)", () => {
    ["\n", "\r\n"].forEach((eol) => {
        const html = webviewHtml(eol);
        assert.ok(WV.hashOk(html), "исходный файл согласован");
        const r = WV.patch(html, "body { outline: 1px solid red; }\r\n.a { color: blue; }");
        assert.ok(r.ok, r.error);
        assert.ok(WV.hasPatch(r.text) && WV.hashOk(r.text), "после правки хэш сходится");
        assert.notStrictEqual(WV.cspHash(r.text), WV.cspHash(html));
        assert.strictEqual(WV.patchCss(r.text), "body { outline: 1px solid red; }\n.a { color: blue; }");
        assert.ok(r.text.indexOf(WV.START) < r.text.indexOf("`;"), "вставка внутри строки стилей");
        assert.strictEqual(WV.strip(r.text), html, "снятие возвращает файл байт в байт");
        const again = WV.patch(r.text, ".b { }");
        assert.ok(again.ok && again.text.split(WV.START).length === 2, "повторная правка не копит вставки");
        assert.strictEqual(WV.patch(r.text, "").text, html, "пустой CSS снимает вставку");
    });
});

test("webview: недопустимый CSS и уже изменённый файл — отказ, файл не меняется", () => {
    const html = webviewHtml("\n");
    ["a { content: `x`; }", "a { b: \\41; }", "a { x: ${y}; }", "</script><script>alert(1)", "a { ", "/*MOONCORE-WEBVIEW-END*/ a{}", "x".repeat(WV.MAX_CSS + 1)].forEach((css) => {
        assert.strictEqual(WV.cleanCss(css), "", css.slice(0, 30));
        const r = WV.patch(html, css);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.text, html);
    });
    // Файл, который кто-то правил, не пересчитав хэш (как Custom UI Style у пользователя).
    const foreign = html.replace("color: red;", "color: red; font-family: X;");
    assert.ok(!WV.hashOk(foreign));
    const r = WV.patch(foreign, "a { }");
    assert.ok(!r.ok && /другой программой/.test(r.error) && r.text === foreign);
    assert.strictEqual(WV.patch(html.replace("defaultStyles.textContent = `", "styles.textContent = `"), "a { }").ok, false, "другое устройство файла");
    assert.strictEqual(WV.strip(foreign), foreign);
    // Политика выключена стиранием http-equiv (так сделано в установке пользователя): страницы работают, защиты нет.
    const off = html.replace("http-equiv=\"Content-Security-Policy\"", "http-equiv=\"\"");
    assert.ok(WV.cspDisabled(off) && !WV.cspDisabled(html));
    const r2 = WV.patch(off, "a { }");
    assert.ok(!r2.ok && /отключила защиту CSP/.test(r2.error) && r2.text === off);
});

function fakeInstall(name) {
    const app = fs.mkdtempSync(path.join(TMP, name + "-")), out = path.join(app, "out");
    const put = (rel, text) => { const f = path.join(out, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text, "utf8"); return f; };
    const files = {
        "vs/code/electron-browser/workbench/workbench.html": BASE_HTML.replace(/<!-- !! VSCODE[\s\S]*?CPPDOCS-WINDOW-END -->\n/, ""),
        "vs/workbench/workbench.desktop.main.js": "class X{constructor(){this._services.set(a,this),this._globalGraph=1}} const cls='monaco-workbench part sidebar tabs-container';",
        "vs/workbench/workbench.desktop.main.css": ".part.sidebar{color:red}.statusbar-item{}.tab.active{}",
        "vs/code/electron-browser/workbench/workbench.js": "boot()",
    };
    const sums = {};
    Object.keys(files).forEach((k) => { put(k, files[k]); sums[k] = W.productChecksum(Buffer.from(files[k], "utf8")); });
    fs.writeFileSync(path.join(app, "product.json"), JSON.stringify({ commit: "abc", checksums: sums }, null, 2), "utf8");
    put(WV.REL.join("/"), webviewHtml("\n"));
    return { app: app, out: out, files: files, put: put };
}

test("целостность: исходные файлы, правки Moon Core, чужие правки и следы других загрузчиков", () => {
    const i = fakeInstall("integrity");
    let s = VF.integritySummary(i.app);
    assert.deepStrictEqual([s.total, s.foreign, s.mooncore, s.missing, s.webview, s.leftovers], [4, [], [], [], "clean", []]);
    // Moon Core встроился: блок в оболочке, крючок в бандле, стили в webview.
    const shell = "vs/code/electron-browser/workbench/workbench.html", bundle = "vs/workbench/workbench.desktop.main.js";
    i.put(shell, W.applyBlock(i.files[shell], W.buildBlock({}, "rt()", { nonce: "abcDEF12", version: "1" })));
    i.put(bundle, DP.patchBundle(i.files[bundle]).text);
    i.put(WV.REL.join("/"), WV.patch(webviewHtml("\n"), "a { }").text);
    fs.writeFileSync(path.join(i.out, shell + W.BAK_EXT), i.files[shell], "utf8");
    s = VF.integritySummary(i.app);
    assert.deepStrictEqual(s.mooncore.sort(), [shell, bundle].sort());
    assert.deepStrictEqual([s.foreign, s.webview, s.backupPristine, s.leftovers], [[], "mooncore", true, []], "наши файлы следами не считаются");
    // Чужие правки и следы.
    i.put("vs/code/electron-browser/workbench/workbench.js", "boot();evil()");
    i.put(shell, fs.readFileSync(path.join(i.out, shell), "utf8").replace("</body>", "<!-- чужое --></body>"));
    i.put(WV.REL.join("/"), webviewHtml("\n").replace("color: red;", "color: blue;"));
    i.put("vs/code/electron-browser/workbench/external.module.js", "x");
    i.put("vs/code/electron-browser/workbench/workbench.custom-ui-style.html", "xx");
    i.put("main.custom-ui-style.js", "x");
    i.put("main.js", "main()");
    fs.writeFileSync(path.join(i.out, shell + W.BAK_EXT), "не исходный", "utf8");
    fs.unlinkSync(path.join(i.out, "vs/workbench/workbench.desktop.main.css"));
    s = VF.integritySummary(i.app);
    assert.deepStrictEqual(s.foreign.sort(), ["vs/code/electron-browser/workbench/workbench.js", shell].sort());
    assert.deepStrictEqual(s.missing, ["vs/workbench/workbench.desktop.main.css"]);
    assert.strictEqual(s.webview, "foreign");
    assert.strictEqual(s.shellNoCsp, true, "в изменённой оболочке нет CSP");
    assert.strictEqual(s.backupPristine, false);
    assert.deepStrictEqual(s.leftovers.map((x) => [path.basename(x.name), x.owner]).sort(), [["external.module.js", "Custom UI Style"], ["main.custom-ui-style.js", "Custom UI Style"], ["workbench.custom-ui-style.html", "Custom UI Style"]]);
    const probs = DM.problems({ shells: [{ file: "w", injected: true, current: true, checksum: true, blockOk: true }], bridge: { running: true, streams: 1 }, files: s });
    assert.ok(probs.some((p) => p.level === "error" && /Не хватает/.test(p.title)) && probs.some((p) => /webview/.test(p.title)) && probs.some((p) => /других загрузчиков: 3/.test(p.title)) && probs.some((p) => /Бэкап оболочки/.test(p.title)));
});

test("классы: правило «точно сломано», если класса нет ни в CSS, ни в коде VS Code", () => {
    const i = fakeInstall("classes");
    assert.deepStrictEqual(VF.selectorClasses(".part.sidebar > .tab[aria-label=\".fake .x\"]:not(.active) #a\\.b .c-d"), ["part", "sidebar", "tab", "active", "c-d"]);
    const idx = VF.classIndex(i.app);
    assert.deepStrictEqual(VF.goneClasses(idx, ".part.sidebar .tabs-container"), [], "класс только из кода — тоже есть");
    assert.deepStrictEqual(VF.goneClasses(idx, ".part.sidebar .renamed-in-update"), ["renamed-in-update"]);
    assert.deepStrictEqual(VF.goneClasses(null, ".whatever"), [], "проверить нечем — не ругаемся");
    const summary = { lines: [], deadUser: [{ group: "a.css", selector: ".part .gone-class", label: "" }, { group: "~design", selector: ".statusbar-item", label: "" }] };
    assert.strictEqual(VF.annotateCheck(summary, i.app), 1);
    assert.deepStrictEqual(summary.deadUser[0].gone, ["gone-class"]);
    assert.strictEqual(summary.deadUser[1].gone, undefined, "класс есть — элемент просто не показан");
    assert.ok(summary.lines.some((l) => /точно сломано/.test(l)) && summary.gone === 1);
    const local = path.join(__dirname, "..", "..", ".vscode-test");
    const real = fs.existsSync(local) ? fs.readdirSync(local).filter((n) => /^vscode-/.test(n)).map((n) => path.join(local, n)) : [];
    // Если рядом лежит настоящий VS Code (после npm run e2e) — каталог сверяется с его файлами.
    real.forEach((root) => {
        const sub = fs.readdirSync(root).map((n) => path.join(root, n, "resources", "app")).concat([path.join(root, "resources", "app")]).find((p) => fs.existsSync(path.join(p, "product.json")));
        const ri = sub && VF.classIndex(sub);
        if (!ri) return;
        const C = require(path.join(EXT, "lib", "catalog")), GL = require(path.join(EXT, "lib", "gallery"));
        C.CATALOG.filter((e) => e.selector).forEach((e) => assert.deepStrictEqual(VF.goneClasses(ri, e.selector), [], "каталог: " + e.id));
    });
});

test("имена из CSS установки: классы и переменные темы для подсказок; страж видит корень в выборе нескольких элементов", () => {
    const i = fakeInstall("names");
    i.put("vs/workbench/workbench.desktop.main.css", ".part.sidebar>.title{color:var(--vscode-sideBar-foreground)}.monaco-workbench .tab.active:hover{background:var(--vscode-tab-activeBackground);width:1.5px}@font-face{src:url(x.ttf)}");
    const n = VF.cssNames(i.app);
    assert.deepStrictEqual(n.classes, ["active", "monaco-workbench", "part", "sidebar", "tab", "title"], "числа и расширения файлов — не классы");
    assert.deepStrictEqual(n.vars, ["--vscode-sideBar-foreground", "--vscode-tab-activeBackground"]);
    assert.strictEqual(VF.cssNames(i.app), n, "повторный вызов — из кэша");
    assert.strictEqual(VF.cssNames(path.join(i.app, "nope")), null);
    const G = require(path.join(EXT, "lib", "design-guard"));
    assert.ok(G.risky(".part.sidebar .title, .monaco-workbench", "hide", true), "корень среди нескольких выбранных");
    assert.strictEqual(D.cleanSelector(".part.sidebar .title, .part.panel .title"), ".part.sidebar .title, .part.panel .title");
});

test("сниппеты webview*.css: не идут в окно, собираются в один CSS для основы webview", () => {
    const dir = fs.mkdtempSync(path.join(TMP, "wvsnip-"));
    fs.writeFileSync(path.join(dir, "webview.css"), "body { margin: 0; }", "utf8");
    fs.writeFileSync(path.join(dir, "webview-md.css"), "h1 { color: red; }", "utf8");
    fs.writeFileSync(path.join(dir, "webview-off.css"), "h2 { }", "utf8");
    fs.writeFileSync(path.join(dir, "window.css"), ".part { }", "utf8");
    assert.ok(S.isWebview("webview.css") && S.isWebview("Webview-md.css") && !S.isWebview("window.css") && !S.isWebview("webview.js") && !S.isWebview("my-webview.css"));
    const css = S.webviewCss(dir, { disabled: ["webview-off.css"] });
    assert.strictEqual(css, "/* webview-md.css */\nh1 { color: red; }\n/* webview.css */\nbody { margin: 0; }");
    assert.strictEqual(WV.cleanCss(css), css);
});

test("история в файле: переживает перезапуск, чужой или битый файл не мешает", async () => {
    const dir = fs.mkdtempSync(path.join(TMP, "histfile-")), user = {};
    const opts = { designFile: path.join(dir, "d.json"), profilesFile: path.join(dir, "p.json"), historyFile: path.join(dir, "h.json"),
        config: { globalValue: (k) => user[k], update: async (k, v) => { if (v === undefined) delete user[k]; else user[k] = v; } } };
    const e = new DesignEngine(opts);
    await e.apply([{ op: "set", selector: ".a", prop: "hide", value: true }]);
    await e.apply([{ op: "setting", key: "editor.minimap.enabled", value: false }]);
    const e2 = new DesignEngine(opts);                                   // «перезагрузка окна»
    assert.strictEqual(e2.history.summary().undo, 2);
    assert.ok((await e2.apply([{ op: "undo" }])).ok);
    assert.strictEqual(user["editor.minimap.enabled"], undefined);
    assert.ok((await e2.apply([{ op: "undo" }])).ok);
    assert.deepStrictEqual(e2.design.rules, {});
    fs.writeFileSync(opts.historyFile, "{ битый", "utf8");
    assert.strictEqual(new DesignEngine(opts).history.summary().undo, 0);
    fs.writeFileSync(opts.historyFile, JSON.stringify({ v: 1, undo: [{ snap: { rules: { body: { props: { hide: true } } } }, after: "не тот отпечаток" }, { snap: null }, 5] }), "utf8");
    const e3 = new DesignEngine(opts);
    assert.strictEqual(e3.history.summary().undo, 1, "мусор отсеян");
    assert.deepStrictEqual(e3.history.undo[0].snap.rules, {}, "снимок из файла прошёл проверку (корень окна не прячется)");
    assert.strictEqual((await e3.apply([{ op: "undo" }])).ok, false, "шаг с чужим отпечатком не применяется");
    const h = new History((d) => JSON.stringify(d));
    h.record({ big: "x".repeat(1100 * 1024) }, "k", "");
    h.save(opts.historyFile);
    assert.ok(!fs.existsSync(opts.historyFile), "слишком большая история в файл не пишется");
});

test("копии сниппетов: наборы перечисляются, новые сверху", () => {
    const dir = fs.mkdtempSync(path.join(TMP, "sets-")), src = fs.mkdtempSync(path.join(TMP, "setsrc-"));
    fs.writeFileSync(path.join(src, "a.css"), ".a{}", "utf8"); fs.writeFileSync(path.join(src, "b.js"), "1", "utf8");
    assert.deepStrictEqual(BK.snippetSets(dir), []);
    fs.mkdirSync(path.join(dir, "snippets-1700000000000"));
    fs.writeFileSync(path.join(dir, "snippets-1700000000000", "old.css"), "", "utf8");
    fs.mkdirSync(path.join(dir, "snippets-1700000000001"));            // пустой набор не показывается
    const out = BK.saveSnippets(dir, [path.join(src, "a.css"), path.join(src, "b.js")]);
    const sets = BK.snippetSets(dir);
    assert.deepStrictEqual(sets.map((s) => s.files), [["a.css", "b.js"], ["old.css"]]);
    assert.strictEqual(sets[0].dir, out);
    assert.ok(sets[0].at > sets[1].at);
});
