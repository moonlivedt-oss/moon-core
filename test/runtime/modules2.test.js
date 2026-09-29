// Тесты рантайма: VS Code для модулей — события, команды, ленивая загрузка, включение и
// выключение без перезагрузки, плавающие окна, общая шина, части окна.
"use strict";

const assert = require("assert");
const vm = require("vm");

module.exports = function (test, h) {
    const { makeWindow, baseBoot, tick } = h;
    const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));   // объект из vm -> обычный
    const LAZY = { id: "cpd", name: "Docs", version: "1", base: "http://localhost/c/", lazy: { delay: 0 }, file: { src: "mooncore-mod-cpd.js", integrity: "" } };

    /** Выполнить подключённый рантаймом <script src> модуля так, как это сделал бы браузер. */
    function runScript(t, id, code) {
        const s = t.head.children.find((c) => c.tagName === "SCRIPT" && c.getAttribute("data-mooncore-module") === id);
        assert.ok(s, "рантайм подключил файл модуля " + id);
        assert.strictEqual(s.src, "mooncore-mod-" + id + ".js");
        vm.runInContext("window.__MOONCORE__._skip(" + JSON.stringify(id) + ");\n" + code, t.w);
        s.onload();
        return s;
    }

    test("события VS Code: подписка уходит хостам, full-часть — только модулям с правом", async () => {
        const t = makeWindow(baseBoot({ modules: baseBoot().modules.concat([Object.assign({}, LAZY, { lazy: null, id: "rd", file: null })]) }));
        await tick(5);
        const bg = t.mc.module("mlbg"), rd = t.mc.module("rd");
        const got = { bg: [], rd: [] };
        bg.vscode.on("cursor", (d) => got.bg.push(d));
        rd.vscode.on("cursor", (d) => got.rd.push(d));
        await tick(5);
        const subs = t.calls.filter((c) => c.method === "vsSubscribe");
        assert.ok(subs.some((c) => c.port === 1001 && c.body.id === "mlbg") && subs.some((c) => c.port === 1002 && c.body.id === "rd"), "подписка — всем хостам");
        assert.deepStrictEqual(subs[0].body.kinds, ["cursor"]);
        t.es(1001).emit("focus", { focused: true });
        t.es(1001).emit("vs", { kind: "cursor", data: { line: 3, col: 1 }, full: { word: "vector" }, readers: ["rd"] });
        t.es(1002).emit("vs", { kind: "cursor", data: { line: 99, col: 0 }, full: null, readers: [] });
        assert.deepStrictEqual(plain(got.bg), [{ line: 3, col: 1 }], "без права — без слова; чужой хост не слышен");
        assert.deepStrictEqual(plain(got.rd), [{ line: 3, col: 1, word: "vector" }]);
        const late = [];
        bg.vscode.on("cursor", (d) => late.push(d));
        await tick(5);
        assert.deepStrictEqual(plain(late), [{ line: 3, col: 1 }], "новый подписчик получает текущее сразу");
        assert.deepStrictEqual(plain(bg.vscode.last("cursor")), { line: 3, col: 1 });
    });

    test("команды модуля: объявление уходит хостам, нажатие — разовое событие, повторно не приходит", async () => {
        const t = makeWindow(baseBoot());
        await tick(5);
        const m = t.mc.module("mlbg");
        assert.strictEqual(m.commands.register([{ id: "open", title: "Открыть", langs: ["cpp"], context: true }]), 1);
        await tick(5);
        assert.ok(t.calls.some((c) => c.method === "modCommands" && c.body.id === "mlbg" && c.body.commands[0].title === "Открыть"));
        const got = [];
        m.commands.on("open", (ctx) => got.push(ctx.word));
        t.es(1001).emit("focus", { focused: true });
        t.es(1001).emit("module", { id: "mlbg", event: "command", scope: "window", once: true, data: { id: "open", ctx: { word: "map" } } });
        t.es(1001).emit("module", { id: "mlbg", event: "command", scope: "window", once: true, data: { id: "other", ctx: {} } });
        assert.deepStrictEqual(got, ["map"]);
        const late = [];
        m.commands.on("open", (ctx) => late.push(ctx));
        await tick(5);
        assert.deepStrictEqual(late, [], "разовое событие не кэшируется");
    });

    test("ленивый модуль: не грузится на старте; команда загружает файл и доходит после загрузки", async () => {
        const t = makeWindow(baseBoot({ modules: [LAZY] }));
        await tick(5);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(t.mc.moduleState("cpd"))), { loaded: false, off: false, lazy: true });
        assert.ok(!t.head.children.some((c) => c.tagName === "SCRIPT"), "на старте файла нет");
        t.es(1001).emit("focus", { focused: true });
        t.es(1001).emit("module", { id: "cpd", event: "command", scope: "window", once: true, data: { id: "open", ctx: { word: "list" } } });
        await tick(1);
        runScript(t, "cpd", "var mc = window.__MOONCORE__.module('cpd'); mc.commands.on('open', function (c) { window.__opened = c.word; });");
        await tick(5);
        assert.strictEqual(t.w.__opened, "list", "команда дошла после загрузки");
        assert.strictEqual(t.mc.moduleState("cpd").loaded, true);
        assert.strictEqual(await t.mc.loadModule("cpd"), true, "повторная загрузка — без нового файла");
        assert.strictEqual(t.head.children.filter((c) => c.tagName === "SCRIPT").length, 1);
    });

    test("ленивый модуль: файл пропал или изменился — одобренный код берётся у хоста", async () => {
        const t = makeWindow(baseBoot({ modules: [LAZY] }));
        await tick(5);
        t.handlers["1001"] = (method, body) => (method === "moduleCode" && body.lazy === true && body.id === "cpd" ? { ok: true, code: "window.__fallback = 1" } : { ok: true });
        t.handlers["1002"] = t.handlers["1001"];
        const p = t.mc.loadModule("cpd");
        await tick(1);
        const s = t.head.children.find((c) => c.tagName === "SCRIPT" && c.getAttribute("data-mooncore-module") === "cpd");
        s.onerror();                                   // integrity не сошлась / файла нет
        assert.strictEqual(await p, true);
        assert.ok(t.calls.some((c) => c.method === "moduleCode" && c.body.id === "cpd" && c.body.lazy === true));
        assert.strictEqual(t.mc.moduleState("cpd").loaded, true);
    });

    test("Trusted Types: адрес файла модуля — через политику «mooncore», чужой адрес она не пропускает", async () => {
        for (const runtime of ["full", "core"]) {
            const policies = {}, urls = [];
            const tt = { createPolicy: (name, rules) => {
                if (policies[name]) throw new Error("дубль политики " + name);
                policies[name] = rules;
                return { createScript: rules.createScript, createScriptURL: (u) => { const r = rules.createScriptURL(u); urls.push(r); return { tt: r, toString: () => r }; } };
            } };
            const t = makeWindow(baseBoot({ modules: [LAZY] }), null, { runtime: runtime, extra: { trustedTypes: tt } });
            assert.deepStrictEqual(Object.keys(policies), ["mooncore"], runtime + ": одна политика");
            t.mc.loadModule("cpd");
            await tick(1);
            assert.deepStrictEqual(urls, ["mooncore-mod-cpd.js"], runtime);
            const s = t.head.children.find((c) => c.tagName === "SCRIPT" && c.getAttribute("data-mooncore-module") === "cpd");
            assert.strictEqual(typeof s.src, "object", runtime + ": src — доверенный объект, не строка");
            assert.throws(() => policies.mooncore.createScriptURL("https://evil.example/x.js"), /чужой адрес/);
            assert.throws(() => policies.mooncore.createScriptURL("mooncore-mod-cpd.js?x=1"), /чужой адрес/);
            assert.throws(() => policies.mooncore.createScript("alert(1)"), /непроверенный/);
        }
    });

    test("выключение и включение модуля без перезагрузки: уборка, окна, шина; снова — тем же файлом", async () => {
        const mod = Object.assign({}, LAZY, { lazy: null, id: "cpd" });
        const t = makeWindow(baseBoot({ modules: baseBoot().modules.concat([mod]) }));
        await tick(5);
        const m = t.mc.module("cpd");
        const cleaned = [];
        m.onDispose(() => cleaned.push(1));
        const win = m.window({ id: "reader", title: "Документация" });
        assert.ok(win.isOpen() && t.body.children.includes(win.el));
        m.share("cpd.topic", { name: "vector" });
        const seen = [];
        t.mc.module("mlbg").shared("cpd.topic", (v, from) => seen.push([v && v.name, from]));
        await tick(5);
        t.es(1001).emit("moduleSet", { ids: ["mlbg"] });
        assert.deepStrictEqual(cleaned, [1], "уборка модуля");
        assert.ok(!win.isOpen(), "окно модуля закрыто");
        assert.deepStrictEqual(seen, [["vector", "cpd"], [undefined, ""]], "значения модуля ушли из шины");
        assert.strictEqual(t.mc.moduleState("cpd").off, true);
        t.es(1001).emit("moduleSet", { ids: ["mlbg", "cpd"] });
        await tick(1);
        runScript(t, "cpd", "window.__again = 1;");
        await tick(5);
        assert.strictEqual(t.w.__again, 1, "модуль снова выполнен");
        assert.deepStrictEqual(JSON.parse(JSON.stringify(t.mc.moduleState("cpd"))), { loaded: true, off: false, lazy: false });
    });

    test("плавающее окно: одно на id, прилипает к краям, место запоминается, закрытие зовёт onClose", async () => {
        const ls = {};
        const t = makeWindow(baseBoot(), ls, { extra: { innerWidth: 1000, innerHeight: 800 } });
        const m = t.mc.module("mlbg");
        const w1 = m.window({ id: "panel", title: "Фон", width: 300, height: 200, x: 8, y: 400 });
        assert.strictEqual(m.window({ id: "panel" }), w1, "одно окно на id");
        assert.deepStrictEqual(plain(w1.geometry()), { x: 0, y: 400, w: 300, h: 200 }, "прилипло к левому краю");
        w1.dock("right");
        assert.deepStrictEqual(plain(w1.geometry()), { x: 500, y: 0, w: 500, h: 800 });
        assert.deepStrictEqual(JSON.parse(ls["mooncore.win.mlbg.panel"]), { x: 500, y: 0, w: 500, h: 800 });
        w1.body.appendChild(t.w.document.createElement("div"));
        let closed = 0;
        w1.onClose(() => closed++);
        w1.close();
        assert.ok(!w1.isOpen() && closed === 1);
        const w2 = m.window({ id: "panel" });
        assert.notStrictEqual(w2, w1);
        assert.deepStrictEqual(plain(w2.geometry()), { x: 500, y: 0, w: 500, h: 800 }, "место восстановлено");
    });

    test("общая шина: автор, текущее сразу, мусор не принимается; части окна по вёрстке", async () => {
        const t = makeWindow(baseBoot());
        const m = t.mc.module("mlbg");
        assert.strictEqual(m.share("accent", "#89b4fa"), true);
        assert.strictEqual(m.share("bad key!", 1), false);
        assert.strictEqual(m.share("big", "x".repeat(70000)), false);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(m.sharedGet("accent"))), { value: "#89b4fa", from: "mlbg" });
        assert.deepStrictEqual(JSON.parse(JSON.stringify(t.mc.shared.get("accent"))), { value: "#89b4fa", from: "mlbg" });
        const got = [];
        m.shared("accent", (v, from) => got.push(v + "/" + from));
        await tick(5);
        m.share("accent", "#ff0000");
        assert.deepStrictEqual(got, ["#89b4fa/mlbg", "#ff0000/mlbg"]);
        // Части окна: в заглушке у элементов нулевой размер — «не видны»; переключение идёт хосту.
        assert.strictEqual(m.layout.visible("sidebar"), false);
        assert.ok(m.layout.sizes().sidebar && m.layout.sizes().statusbar);
        await tick(5);
        const r = await m.layout.show("sidebar");
        assert.ok(r.ok && r.changed);
        assert.ok(t.calls.some((c) => c.method === "native" && c.body.op === "layout" && c.body.part === "sidebar"));
        assert.deepStrictEqual(plain(await m.layout.hide("sidebar")), { ok: true, changed: false }, "уже скрыта — без команды");
    });
};
