// Смоук-тесты Moon Core: ленивая загрузка интерфейса окна — сборка, файл интерфейса, выбор рантайма.
"use strict";
const { test, withVscode, assert, fs, path, EXT, TMP, W } = require("./harness");

const BUILD = require(path.join(EXT, "..", "scripts", "build-runtime"));
const RT = path.join(EXT, "runtime");

test("сборка: ядро зовёт интерфейс только через заглушки загрузчика, чанк возвращает ровно их", () => {
    const loader = fs.readFileSync(path.join(BUILD.SRC, "65-ui-loader.js"), "utf8");
    const ui = fs.readdirSync(BUILD.UI_DIR).map((f) => fs.readFileSync(path.join(BUILD.UI_DIR, f), "utf8")).join("\n");
    BUILD.UI_EXPORTS.forEach((n) => {
        assert.ok(new RegExp("^    function " + n + "\\(", "m").test(loader), "заглушка " + n + " в загрузчике");
        assert.ok(new RegExp("^    function " + n + "\\(", "m").test(ui), n + " объявлен в чанке");
    });
    const chunk = fs.readFileSync(BUILD.OUT_UI, "utf8");
    assert.ok(chunk.includes("({ " + BUILD.UI_EXPORTS.map((n) => n + ": " + n).join(", ") + " });"));
    const core = fs.readFileSync(BUILD.OUT_CORE, "utf8"), full = fs.readFileSync(BUILD.OUT, "utf8");
    assert.ok(core.includes("function evalUi(") && !full.includes("function evalUi("), "загрузчик только в ленивой сборке");
    assert.ok(!core.includes("var DES_CSS") && full.includes("var DES_CSS"), "стили конструктора — только в чанке и полной сборке");
    assert.ok(core.length < full.length * 0.6, "ядро заметно меньше полного: " + core.length + " / " + full.length);
});

function fakeContext(dir) {
    const gs = new Map();
    return { extensionPath: EXT, globalStorageUri: { fsPath: dir }, globalState: { get: (k) => gs.get(k), update: async (k, v) => { gs.set(k, v); } } };
}

test("файл интерфейса: имя по SHA, пишется в хранилище, старые версии убираются", () => withVscode(() => {
    const UF = require(path.join(EXT, "lib", "inject", "ui-file"));
    const dir = fs.mkdtempSync(path.join(TMP, "uifile-"));
    const ctx = fakeContext(dir);
    const code = fs.readFileSync(path.join(RT, "mooncore-ui.js"), "utf8");
    const c = UF.uiChunk(ctx);
    assert.strictEqual(c.sha, W.sha256(code));
    assert.strictEqual(c.name, "mooncore-ui-" + c.sha.slice(0, 16) + ".js");
    fs.writeFileSync(path.join(dir, "mooncore-ui-0000000000000000.js"), "old");
    fs.writeFileSync(path.join(dir, c.name), "подменённый");
    const r = UF.ensureUiFile(ctx);
    assert.strictEqual(fs.readFileSync(path.join(dir, c.name), "utf8"), code, "подменённый файл переписан");
    assert.ok(!fs.existsSync(path.join(dir, "mooncore-ui-0000000000000000.js")), "старая версия убрана");
    assert.strictEqual(r.sha, c.sha);
    assert.ok(/^file:\/\/\/.+mooncore-ui-[0-9a-f]{16}\.js$/.test(r.url), r.url);
}));

test("рантайм для оболочки: ядро с SHA чанка или полный; после отказа окна — полный в этой версии", () => withVscode(async () => {
    const UF = require(path.join(EXT, "lib", "inject", "ui-file"));
    const ctx = fakeContext(fs.mkdtempSync(path.join(TMP, "uirt-")));
    const core = fs.readFileSync(path.join(RT, "mooncore-core.js"), "utf8"), full = fs.readFileSync(path.join(RT, "mooncore-runtime.js"), "utf8");
    assert.strictEqual(UF.lazyOn(ctx), true);
    const lazy = UF.runtimeFor(ctx);
    assert.strictEqual(lazy.code, core + "// mooncore-ui " + UF.uiChunk(ctx).sha + "\n");
    assert.deepStrictEqual(lazy.ui, { name: UF.uiChunk(ctx).name, sha: UF.uiChunk(ctx).sha });
    const inl = UF.runtimeFor(ctx, { inline: true });
    assert.strictEqual(inl.code, full);
    assert.strictEqual(inl.ui, null);
    assert.notStrictEqual(W.blockSha(lazy.code, []), W.blockSha(inl.code, []), "смена режима — блок устарел");
    await UF.markInline(ctx);
    assert.strictEqual(UF.lazyOn(ctx), false);
    assert.strictEqual(UF.runtimeFor(ctx).ui, null, "окно сообщило, что eval нельзя — дальше целиком");
}));

// Мета CSP настоящего VS Code 1.139 (многострочная, с Trusted Types) — в сокращении.
const REAL_CSP = [
    "<meta\r\n\t\t\thttp-equiv=\"Content-Security-Policy\"\r\n\t\t\tcontent=\"\r\n\t\t\t\tdefault-src\r\n\t\t\t\t\t'none'\r\n\t\t\t\t;",
    "\r\n\t\t\t\tscript-src\r\n\t\t\t\t\t'self'\r\n\t\t\t\t\t'unsafe-eval'\r\n\t\t\t\t\tblob:\r\n\t\t\t\t;",
    "\r\n\t\t\t\tstyle-src\r\n\t\t\t\t\t'self'\r\n\t\t\t\t\t'unsafe-inline'\r\n\t\t\t\t;",
    "\r\n\t\t\t\tconnect-src\r\n\t\t\t\t\t'self'\r\n\t\t\t\t\thttps:\r\n\t\t\t\t\tws:\r\n\t\t\t\t;",
    "\r\n\t\t\t\trequire-trusted-types-for\r\n\t\t\t\t\t'script'\r\n\t\t\t\t;",
    "\r\n\t\t\t\ttrusted-types\r\n\t\t\t\t\tamdLoader\r\n\t\t\t\t\tdompurify\r\n\t\t\t\t\tmooncoreX\r\n\t\t\t\t;\r\n\t\t\"/>",
].join("");

const TT_DIR = /[;\s]trusted-types([^;]*);/;   // сама директива, не require-trusted-types-for

test("CSP настоящего VS Code: политика «mooncore» добавляется в trusted-types один раз и снимается ровно", () => {
    const html = "<!DOCTYPE html>\r\n<html>\r\n\t<head>\r\n\t\t<meta charset=\"utf-8\" />\r\n\t\t" + REAL_CSP + "\r\n\t</head>\r\n</html>\r\n";
    const inject = (h, nonce, old) => W.armCsp(W.applyBlock(h, W.buildBlock({}, "rt()", { nonce: nonce, version: "1" })), nonce, old);
    const a = inject(html, "NONCEAAA1", "");
    const tt = TT_DIR.exec(a)[1];
    assert.ok(/\smooncore(\s|$)/.test(tt) && /mooncoreX/.test(tt), "своя политика добавлена, чужая похожая цела: " + JSON.stringify(tt));
    assert.ok(/'unsafe-eval'\s+blob:\s+'nonce-NONCEAAA1'/.test(a), "nonce в script-src");
    assert.ok(!/style-src[^;]*nonce/.test(a), "style-src с 'unsafe-inline' без nonce");
    const b = inject(a, "NONCEBBB2", "NONCEAAA1");
    assert.strictEqual((TT_DIR.exec(b)[1].match(/\smooncore(?=\s)/g) || []).length, 1, "повторное внедрение не дублирует");
    assert.strictEqual(W.stripBlock(b), html, "после снятия — ровно исходная оболочка");
    assert.strictEqual(W.addTrustedType("<meta content=\"trusted-types 'none'\">"), "<meta content=\"trusted-types 'none'\">", "'none' не трогаем");
});
