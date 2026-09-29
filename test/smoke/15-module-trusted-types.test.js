// Смоук-тесты Moon Core: политики Trusted Types модулей (манифест "trustedTypes").
// VS Code 1.139 с CSP (require-trusted-types-for 'script') разрешает только перечисленные политики:
// без записи в trusted-types модуль не создаст свою (окно документации C++ не появлялось).
"use strict";
const { test, assert, fs, path, EXT, TMP, W } = require("./harness");

const M = require(path.join(EXT, "lib", "modules"));
const TT = require(path.join(EXT, "lib", "trusted-types"));

// CSP-мета как в настоящей оболочке VS Code 1.139: многострочная, с отступами табами.
const HTML = "<!DOCTYPE html>\r\n<html>\r\n\t<head>\r\n\t\t<meta charset=\"utf-8\" />\r\n\t\t<meta\r\n\t\t\thttp-equiv=\"Content-Security-Policy\"\r\n\t\t\tcontent=\"" +
    "\r\n\t\t\t\tdefault-src\r\n\t\t\t\t\t'none'\r\n\t\t\t\t;" +
    "\r\n\t\t\t\tscript-src\r\n\t\t\t\t\t'self'\r\n\t\t\t\t\t'unsafe-eval'\r\n\t\t\t\t\tblob:\r\n\t\t\t\t;" +
    "\r\n\t\t\t\tstyle-src\r\n\t\t\t\t\t'self'\r\n\t\t\t\t\t'unsafe-inline'\r\n\t\t\t\t;" +
    "\r\n\t\t\t\tconnect-src\r\n\t\t\t\t\t'self'\r\n\t\t\t\t\thttps:\r\n\t\t\t\t;" +
    "\r\n\t\t\t\trequire-trusted-types-for\r\n\t\t\t\t\t'script'\r\n\t\t\t\t;" +
    "\r\n\t\t\t\ttrusted-types\r\n\t\t\t\t\tamdLoader\r\n\t\t\t\t\tdompurify\r\n\t\t\t\t;\r\n\t\t\"/>\r\n\t</head>\r\n\t<body></body>\r\n</html>\r\n";

const names = (html) => TT.namesOf(html.match(/<meta\s+[^>]*Content-Security-Policy[^>]*>/i)[0]);
/** Внедрение как в plan.js: политики модулей считаются по чистой оболочке, прошлые — из блока. */
function inject(html, declared, nonce) {
    const old = W.blockInfo(html);
    const tt = W.moduleTrustedTypes(html, declared);
    const block = W.buildBlock({}, "rt()", { nonce: nonce, version: "1", trustedTypes: tt });
    return W.armCsp(W.applyBlock(html, block), nonce, old && old.nonce, tt, old && old.tt);
}

test("манифест: trustedTypes — до 4 допустимых имён, без «default» и «mooncore»", () => {
    const dir = fs.mkdtempSync(path.join(TMP, "tt-mod-"));
    fs.writeFileSync(path.join(dir, "m.js"), "1");
    const norm = (tt) => M.normalize({ id: "demo", script: "m.js", trustedTypes: tt }, dir, "test");
    assert.deepStrictEqual(norm(["cppdocs", "cppdocs"]).module.trustedTypes, ["cppdocs"]);
    assert.deepStrictEqual(norm(undefined).module.trustedTypes, []);
    ["default", "mooncore", "Bad", "a b"].forEach((n) => assert.ok(!norm([n]).ok, "имя «" + n + "» отвергнуто"));
    assert.ok(!norm(["a1", "a2", "a3", "a4", "a5"]).ok, "не больше 4");
    assert.ok(!norm("cppdocs").ok, "только список");
});

test("CSP VS Code 1.139: политика модуля вписывается один раз и снимается ровно", () => {
    const a = inject(HTML, ["cppdocs"], "N0NCE0001");
    assert.deepStrictEqual(names(a), ["amdLoader", "dompurify", "mooncore", "cppdocs"]);
    assert.deepStrictEqual(W.blockInfo(a).tt, ["cppdocs"]);
    assert.deepStrictEqual(W.missingTrustedTypes(a, ["cppdocs"]), [], "блок актуален");
    const b = inject(a, ["cppdocs"], "N0NCE0002");
    assert.deepStrictEqual(names(b), ["amdLoader", "dompurify", "mooncore", "cppdocs"], "повтор не дублирует");
    assert.strictEqual(W.stripBlock(b), HTML, "снятие возвращает оболочку байт в байт");
    // Модуль убрали — его политика уходит при следующем внедрении.
    const c = inject(b, [], "N0NCE0003");
    assert.deepStrictEqual(names(c), ["amdLoader", "dompurify", "mooncore"]);
});

test("CSP: чужие политики не присваиваем, без CSP и при 'none' ничего не пишем", () => {
    // «dompurify» уже есть у VS Code — не пишем и при снятии не трогаем.
    const a = inject(HTML, ["dompurify", "cppdocs"], "N0NCE0004");
    assert.deepStrictEqual(W.blockInfo(a).tt, ["cppdocs"]);
    assert.strictEqual(W.stripBlock(a), HTML);
    // Снаружи сняли «cppdocs» (cpp-docs-panel убирал свою прежнюю вставку) — блок устарел.
    const cut = a.replace(/\scppdocs(?=\s)/, "");
    assert.deepStrictEqual(W.missingTrustedTypes(cut, ["cppdocs"]), ["cppdocs"]);
    const plain = "<html><head></head><body></body></html>";
    assert.deepStrictEqual(W.moduleTrustedTypes(plain, ["cppdocs"]), []);
    assert.deepStrictEqual(W.missingTrustedTypes(plain, ["cppdocs"]), []);
    const none = "<html><head><meta http-equiv=\"Content-Security-Policy\" content=\"trusted-types 'none'\"></head></html>";
    assert.deepStrictEqual(W.moduleTrustedTypes(none, ["cppdocs"]), []);
});
