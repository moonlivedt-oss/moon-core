// Смоук-тесты Moon Core: страж структуры — каждый файл парсится, ни один не разрастается.
"use strict";
const { test, assert, fs, path } = require("./harness");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "..");
// Лимит строк на файл исходников и тестов. Файл подошёл к лимиту — пора делить его по смыслу
// (как lib/inject/, lib/ext/, test/smoke/), а не поднимать число.
const MAX_LINES = 400;
// Собранный рантайм — склейка runtime/src/*.js и src/ui/*.js (правят части, а не его).
const GENERATED = new Set(["extension/runtime/mooncore-runtime.js", "extension/runtime/mooncore-core.js", "extension/runtime/mooncore-ui.js"]);

function jsFiles(dir, rel, out) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
        if (d.name.startsWith(".") || d.name === "node_modules" || d.name === "dist") return;
        const abs = path.join(dir, d.name), r = rel + "/" + d.name;
        if (d.isDirectory()) jsFiles(abs, r, out);
        else if (/\.js$/.test(d.name)) out.push({ abs: abs, rel: r.slice(1) });
    });
    return out;
}
const FILES = ["extension", "scripts", "test"].reduce((acc, d) => jsFiles(path.join(ROOT, d), "/" + d, acc), []);

test("структура: каждый JS-файл парсится (в том числе те, что тесты не загружают)", () => {
    assert.ok(FILES.length > 40, "нашлись файлы: " + FILES.length);
    FILES.forEach((f) => {
        const code = fs.readFileSync(f.abs, "utf8");
        // Части рантайма — куски тела одной функции, прочие файлы — модули CommonJS: обе обёртки — функция.
        try { new vm.Script("(function (exports, require, module, __filename, __dirname) {\n" + code + "\n})", { filename: f.rel }); }
        catch (e) { assert.fail(f.rel + ": " + e.message); }
    });
});

test("структура: ни один файл исходников и тестов не длиннее " + MAX_LINES + " строк", () => {
    const big = FILES.filter((f) => !GENERATED.has(f.rel))
        .map((f) => ({ rel: f.rel, n: fs.readFileSync(f.abs, "utf8").split("\n").length }))
        .filter((f) => f.n > MAX_LINES);
    assert.deepStrictEqual(big, [], "разделить: " + big.map((f) => f.rel + " (" + f.n + ")").join(", "));
});

test("структура: без управляющих символов, окончания строк — LF", () => {
    FILES.forEach((f) => {
        const code = fs.readFileSync(f.abs, "utf8");
        assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(code), f.rel + ": управляющий символ в исходнике");
        assert.ok(code.indexOf("\r") === -1, f.rel + ": CRLF (нужен LF)");
    });
});
