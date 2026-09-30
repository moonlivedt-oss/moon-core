// Тесты рантайма: страховки окна — безопасный режим, «стоп-кран», остановка падающего сниппета,
// пульс окна, стопка сообщений; новые свойства конструктора и вид интерфейса.
"use strict";

const assert = require("assert");

module.exports = function (test, h) {
    const { makeWindow, baseBoot, tick, D } = h;

    test("безопасный режим: модули пропускаются без «защиты запуска», в окне — напоминание", async () => {
        const boot = baseBoot();
        boot.state = Object.assign({}, boot.state, { safe: true });
        const t = makeWindow(boot);
        assert.strictEqual(t.mc.info().safe, true);
        assert.strictEqual(t.mc._skip("mlbg"), true, "модуль не запускается");
        await tick(400);
        assert.ok(t.body.children.some((c) => c.getAttribute("data-mooncore-ui") === "safe"), "напоминание в окне");
        // Режим выключили — состояние пришло по мосту: напоминание снято, модули больше не пропускаются.
        t.es(1001).emit("state", { v: 1, rev: "r9", snippets: [], design: { rules: {}, settings: {} } });
        assert.strictEqual(t.mc.info().safe, false);
        assert.ok(!t.body.children.some((c) => c.getAttribute("data-mooncore-ui") === "safe"));
        assert.strictEqual(t.mc._skip("mlbg"), false);
    });

    test("стоп-кран: сочетание клавиш выключает и включает все стили Moon Core, новые стили тоже", async () => {
        const t = makeWindow(baseBoot());
        t.mc.applyState({ rev: "r1", snippets: [{ id: "a.css", code: ".a{}" }], design: { rules: { ".part.sidebar": { label: "", props: { opacity: 0.5 } } }, settings: {} } });
        const key = { key: "Backspace", ctrlKey: true, altKey: true, shiftKey: true, preventDefault() {}, stopPropagation() {} };
        t.fireKey(Object.assign({}, key, { shiftKey: false }));
        assert.strictEqual(t.mc.info().panic, false, "без Shift — не наше сочетание");
        t.fireKey(key);
        assert.strictEqual(t.mc.info().panic, true);
        assert.ok(t.styles().every((s) => s.media === "not all"), "все стили выключены");
        t.mc.applyState({ rev: "r2", snippets: [{ id: "a.css", code: ".a{}" }, { id: "b.css", code: ".b{}" }], design: { rules: {}, settings: {} } });
        assert.ok(t.styles().filter((s) => s.getAttribute("data-mooncore")).every((s) => s.media === "not all"), "стиль, пришедший позже, тоже выключен");
        t.fireKey(key);
        assert.ok(t.styles().every((s) => !s.media), "стили вернулись");
        assert.strictEqual(t.mc.panic(true), true);
        assert.strictEqual(t.mc.panic(false), false);
    });

    test("падающий JS-сниппет останавливается после потока ошибок и запускается снова с новым кодом", async () => {
        const t = makeWindow(baseBoot());
        await tick(5);
        t.mc.applyState({ rev: "r1", snippets: [{ id: "boom.js", code: "window.__runs = (window.__runs || 0) + 1; mc.mount(document.body, mc.el('div', { className: 'boom' }));" }] });
        assert.strictEqual(t.w.__runs, 1);
        for (let i = 0; i < 8; i++) t.mc.fail("boom.js", new Error("раз " + i));
        await tick(20);
        assert.deepStrictEqual(t.mc.info().stopped, [], "восемь ошибок — ещё терпимо");
        t.mc.fail("boom.js", new Error("девятая"));
        await tick(20);
        assert.deepStrictEqual(t.mc.info().stopped, ["boom.js"]);
        assert.deepStrictEqual(t.mc.info().js, [], "сниппет остановлен");
        assert.strictEqual(t.body.querySelectorAll(".boom").length, 0, "и убрал за собой");
        t.mc.applyState({ rev: "r1b", snippets: [{ id: "boom.js", code: "window.__runs = (window.__runs || 0) + 1; mc.mount(document.body, mc.el('div', { className: 'boom' }));" }] });
        assert.strictEqual(t.w.__runs, 1, "тот же код не перезапускается");
        t.mc.applyState({ rev: "r2", snippets: [{ id: "boom.js", code: "window.__runs = (window.__runs || 0) + 1;" }] });
        assert.strictEqual(t.w.__runs, 2, "новый код запущен");
        assert.deepStrictEqual(t.mc.info().stopped, []);
    });

    test("пульс: окно представляется каждому хосту своим id и версией рантайма", async () => {
        const t = makeWindow(baseBoot());
        await tick(20);
        const hello = t.calls.filter((c) => c.method === "hello");
        assert.deepStrictEqual(hello.map((c) => c.port).sort(), [1001, 1002]);
        assert.ok(/^[0-9a-f]{16}$/.test(hello[0].body.win) && hello[0].body.win === hello[1].body.win);
        assert.strictEqual(hello[0].body.version, "test");
        assert.strictEqual(t.mc.info().win, hello[0].body.win);
    });

    test("сообщения: стопкой, повтор не плодит строки, лишние вытесняются", async () => {
        const t = makeWindow(baseBoot());
        t.mc.applyState({ rev: "r1", snippets: [{ id: "t.js", code: "mc.toast('раз'); mc.toast('раз'); mc.toast('два');" }] });
        const box = t.body.children.find((c) => c.getAttribute("data-mooncore-ui") === "toast");
        assert.ok(box, "контейнер сообщений");
        assert.deepStrictEqual(box.children.map((c) => c.textContent), ["раз", "два"]);
        t.mc.applyState({ rev: "r2", snippets: [{ id: "t.js", code: "['a','b','c','d'].forEach(function (x) { mc.toast(x); });" }] });
        assert.deepStrictEqual(box.children.map((c) => c.textContent), ["a", "b", "c", "d"], "не больше четырёх, старые вытеснены");
    });

    test("конструктор: шаблон значения и сопутствующее свойство попадают в стиль окна", async () => {
        const boot = baseBoot();
        boot.state.props = D.propsSpec();
        const t = makeWindow(boot);
        t.mc.applyState({ rev: "r1", snippets: [], design: { rules: { ".part.sidebar": { label: "", props: { blur: 6, borderWidth: 2, shadow: 10 } } }, settings: {} } });
        const css = t.styles().find((s) => s.getAttribute("data-mooncore") === "~design").textContent;
        assert.ok(css.includes("backdrop-filter: blur(6px) !important;"), css);
        assert.ok(css.includes("border-width: 2px !important;\n  border-style: solid !important;"), css);
        assert.ok(css.includes("box-shadow: 0 4px 10px rgba(0, 0, 0, .45) !important;"), css);
    });

    test("выключенное правило не попадает в стиль; предпросмотр галереи виден без сниппета и снимается", async () => {
        const t = makeWindow(baseBoot());
        t.mc.applyState({ rev: "r1", snippets: [], design: { rules: { ".part.sidebar": { label: "", props: { opacity: 0.5 }, off: true }, ".part.statusbar": { label: "", props: { opacity: 0.7 } } }, settings: {} } });
        const css = t.styles().find((s) => s.getAttribute("data-mooncore") === "~design").textContent;
        assert.ok(!css.includes(".part.sidebar") && css.includes(".part.statusbar"), css);
        t.mc.applyPreview({ id: "gallery-preview.css", code: ".g{}" });
        const pv = () => t.styles().find((s) => s.getAttribute("data-mooncore") === "gallery-preview.css");
        assert.ok(pv() && pv().textContent === ".g{}", "стиль галереи виден до включения");
        t.mc.applyState({ rev: "r2", snippets: [{ id: "a.css", code: ".a{}" }], design: { rules: {}, settings: {} } });
        assert.ok(pv(), "новое состояние предпросмотр не снимает");
        t.mc.applyPreview({ id: "other-unsaved.css", code: ".o{}" });
        assert.ok(!t.styles().some((s) => s.getAttribute("data-mooncore") === "other-unsaved.css"), "чужой несохранённый id не применяется");
        t.mc.applyPreview({ id: "gallery-preview.css", code: null });
        assert.ok(!pv(), "предпросмотр снят");
    });

    test("вид интерфейса: шрифт, скругление, переходы — стилем; недопустимый шрифт в стиль не попадает", async () => {
        const t = makeWindow(baseBoot());
        await tick(200);
        t.mc.applyState({ rev: "r1", snippets: [], design: { rules: {}, settings: {}, fx: { uiFont: "Inter, sans-serif", roundedUi: 6, smoothUi: true, dimInactive: true } } });
        const css = t.styles().find((s) => s.getAttribute("data-mooncore") === "~fx").textContent;
        assert.ok(/font-family: Inter, sans-serif !important/.test(css), css);
        assert.ok(/border-radius: 6px !important/.test(css) && /transition:/.test(css) && /editor-group-container:not\(\.active\)/.test(css));
        assert.ok(!t.body.children.some((c) => c.tagName === "CANVAS"), "холст для этого не нужен");
        t.mc.applyState({ rev: "r2", snippets: [], design: { rules: {}, settings: {}, fx: { uiFont: "x; } body { display: none" } } });
        const fx = t.styles().find((s) => s.getAttribute("data-mooncore") === "~fx");
        assert.ok(!fx || !/display: none/.test(fx.textContent), "инъекция через шрифт не проходит");
    });
};
