// Поведенческие тесты рантайма окна (runtime/mooncore-runtime.js) без браузера и без jsdom.
// Рантайм исполняется в vm с заглушкой DOM, поддельными EventSource (поток событий хоста) и
// fetch (запросы к хосту). Два поддельных хоста — как два окна VS Code.
// Запуск: node test/runtime.js (входит в npm test).
"use strict";

const assert = require("assert");
const { El, makeWindow, baseBoot, tick, TOKA, TOKB, P, D, C } = require("./runtime/window-stub");

// ------------------------------------------------------------------ тесты
let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

test("сниппеты CSS: вставка по порядку имён, предпросмотр, снятие", async () => {
    const t = makeWindow(baseBoot());
    t.mc.applyState({ rev: "r1", snippets: [{ id: "b.css", code: ".b{}" }, { id: "a.css", code: ".a{}" }] });
    const ours = t.styles().filter((s) => /\.css$/.test(s.getAttribute("data-mooncore") || ""));
    assert.deepStrictEqual(ours.map((s) => s.getAttribute("data-mooncore")), ["a.css", "b.css"]);
    t.mc.applyPreview({ id: "a.css", code: ".a{color:red}" });
    assert.strictEqual(ours[0].textContent, ".a{color:red}");
    t.mc.applyPreview({ id: "a.css", code: null });
    assert.strictEqual(ours[0].textContent, ".a{}");
    t.mc.applyState({ rev: "r2", snippets: [{ id: "b.css", code: ".b{}" }] });
    assert.ok(!ours[0].isConnected, "выключенный сниппет убран из <head>");
});

test("сниппеты JS: исполняются с mc, всё созданное через mc убирается при выключении", async () => {
    const t = makeWindow(baseBoot());
    t.mc.applyState({ rev: "r1", snippets: [{ id: "x.js", code: "mc.css('.x{}'); mc.mount(document.body, mc.el('div', { className: 'mine' })); window.__ran = (window.__ran || 0) + 1;" }] });
    assert.strictEqual(t.w.__ran, 1);
    assert.strictEqual(t.body.querySelectorAll(".mine").length, 1);
    assert.strictEqual(t.styles().filter((s) => s.getAttribute("data-mooncore-js") === "x.js").length, 1);
    t.mc.applyState({ rev: "r2", snippets: [] });
    assert.strictEqual(t.body.querySelectorAll(".mine").length, 0, "узел, смонтированный через mc, снят");
    assert.strictEqual(t.styles().filter((s) => s.getAttribute("data-mooncore-js") === "x.js").length, 0, "стиль mc.css снят");
});

test("конструктор: правила из состояния становятся стилем поверх сниппетов", async () => {
    const t = makeWindow(baseBoot());
    t.mc.applyState({ rev: "r1", snippets: [{ id: "a.css", code: ".a{}" }], design: { rules: { ".part.sidebar": { label: "Сайдбар", props: { hide: true, opacity: 0.5 } } }, settings: {} } });
    const st = t.styles();
    const des = st.find((s) => s.getAttribute("data-mooncore") === "~design");
    assert.ok(des, "стиль конструктора есть");
    assert.ok(/\.part\.sidebar \{[\s\S]*display: none !important;[\s\S]*opacity: 0\.5 !important;/.test(des.textContent));
    assert.strictEqual(st[st.length - 1], des, "правки конструктора — последними");
});

test("проверка селекторов: сниппеты, правки конструктора и каталог", async () => {
    const t = makeWindow(baseBoot());
    t.mc.applyState({ rev: "r1", snippets: [], design: { rules: { ".part.sidebar": { label: "Сайдбар", props: { hide: true } }, ".gone-after-update": { label: "Пропало", props: { hide: true } } }, settings: {} } });
    const res = t.mc.checkAll();
    const design = res.find((g) => g.id === "~design");
    assert.deepStrictEqual(design.rules.map((r) => [r.selector, r.found]).sort(), [[".gone-after-update", false], [".part.sidebar", true]]);
    const cat = res.find((g) => g.id === "~catalog");
    assert.ok(cat && cat.rules.length > 10 && cat.rules.some((r) => r.selector === ".part.sidebar" && r.found));
});

test("модули: помощник только для впечатанных, данные файла, сохранение через мост", async () => {
    const t = makeWindow(baseBoot());
    assert.strictEqual(t.mc.module("nope"), null);
    const m = t.mc.module("mlbg");
    assert.strictEqual(m.base, "http://localhost/m/");
    assert.deepStrictEqual(m.data(), { v: 1, cfg: { mode: "3" } });
    await tick(5);
    const r = await m.saveData({ v: 1, cfg: { mode: "4" } });
    assert.ok(r.ok);
    const call = t.calls.find((c) => c.method === "moduleData");
    assert.deepStrictEqual(call.body, { id: "mlbg", data: { v: 1, cfg: { mode: "4" } } });
    assert.deepStrictEqual(m.data().cfg, { mode: "4" }, "стенд: сохранённое читается снова");
});

test("модули: данные окна (scope window) — только от своего хоста; свой находится по фокусу", async () => {
    const t = makeWindow(baseBoot());
    await tick(5);
    const m = t.mc.module("mlbg");
    const got = [];
    m.on("live", (d) => got.push(d.branch));
    t.es(1001).emit("module", { id: "mlbg", event: "live", scope: "window", data: { branch: "A" } });
    t.es(1002).emit("module", { id: "mlbg", event: "live", scope: "window", data: { branch: "B" } });
    assert.deepStrictEqual(got, [], "два хоста и свой не найден — данные окна не применяются");
    t.es(1002).emit("module", { id: "mlbg", event: "theme", scope: "all", data: { x: 1 } });
    assert.deepStrictEqual(m.get("theme"), { x: 1 }, "общие события доходят от любого хоста");
    t.es(1002).emit("focus", { focused: true });
    assert.deepStrictEqual(got, ["B"], "нашли свой хост — сразу получили его последние данные");
    t.es(1001).emit("module", { id: "mlbg", event: "live", scope: "window", data: { branch: "A2" } });
    assert.deepStrictEqual(got, ["B"], "данные чужого окна игнорируются");
    assert.strictEqual(m.get("live").branch, "B");
    t.setFocus(false);
    t.es(1001).emit("focus", { focused: true });
    assert.strictEqual(m.get("live").branch, "B", "фокус чужого окна, когда мы не в фокусе, не меняет пару");
});

test("модули: свой хост находится и опросом при получении фокуса окном", async () => {
    const t = makeWindow(baseBoot());
    // Свой — первый хост: второй отвечает позже и «не в фокусе» — его ответ не должен перебить пару.
    t.handlers["1001"] = (method) => (method === "focus" ? { ok: true, focused: true } : { ok: true });
    t.handlers["1002"] = (method) => (method === "focus" ? { ok: true, focused: false } : { ok: true });
    await tick(5);
    t.fireWindow("focus");
    await tick(400);
    const own = t.mc.info().hosts.filter((h) => h.own).map((h) => h.port);
    assert.deepStrictEqual(own, [1001]);
    // Запрос модуля идёт сначала своему хосту.
    t.handlers["1001"] = (method, body) => (method === "module" ? { ok: true, result: { from: 1001, n: body.body.n } } : { ok: true });
    t.calls.length = 0;
    const r = await t.mc.module("mlbg").rpc("double", { n: 2 });
    assert.deepStrictEqual(r.result, { from: 1001, n: 2 });
    assert.strictEqual(t.calls[0].port, 1001);
});

test("модули: часть в профиле вида — сохранение и применение", async () => {
    const t = makeWindow(baseBoot());
    await tick(5);
    const m = t.mc.module("mlbg");
    const applied = [];
    assert.strictEqual(m.profile({ save: () => ({ mode: "7" }), apply: (o, name) => applied.push([o.mode, name]) }), true);
    assert.strictEqual(m.profile({ save: 1 }), false, "без функций — отказ");
    t.es(1001).emit("profile", { name: "Только код", modules: { mlbg: { mode: "7" }, other: { z: 1 } } });
    assert.deepStrictEqual(applied, [["7", "Только код"]]);
    t.es(1001).emit("profile", { name: "Без фона", modules: {} });
    assert.strictEqual(applied.length, 1, "в профиле нет части модуля — модуль не трогаем");
});

test("модули: ошибка в обработчике события модуля не ломает рантайм и уходит в журнал", async () => {
    const t = makeWindow(baseBoot());
    await tick(5);
    const m = t.mc.module("mlbg");
    m.on("boom", () => { throw new Error("модуль упал"); });
    const ok = [];
    m.on("boom", (d) => ok.push(d));
    t.es(1001).emit("module", { id: "mlbg", event: "boom", scope: "all", data: 1 });
    await tick(5);
    assert.deepStrictEqual(ok, [1], "второй подписчик всё равно получил событие");
    assert.ok(t.calls.some((c) => c.method === "log" && /модуль упал/.test(c.body.msg)), "ошибка ушла в журнал");
});

test("защита запуска: модуль, на котором встал прошлый запуск, пропускается один раз", async () => {
    const ls = {};
    const a = makeWindow(baseBoot(), ls);
    assert.strictEqual(a.mc._skip("mlbg"), false, "первый запуск — ничего не пропускаем");
    a.mc._modStart("mlbg");                     // модуль начал грузиться, и окно «упало»
    assert.strictEqual(JSON.parse(ls["mooncore.bootGuard"]).last, "mlbg");
    const b = makeWindow(baseBoot(), ls);       // следующий запуск
    assert.strictEqual(b.mc._skip("mlbg"), true, "виновник пропущен");
    assert.strictEqual(b.mc._skip("other"), false, "остальные модули грузятся");
    b.mc._modStart("other"); b.mc._modDone("other");
    assert.strictEqual(JSON.parse(ls["mooncore.bootGuard"]).last, "", "модуль догрузился — метка снята");
});

test("защита запуска: три незавершённых запуска без виновника — пропустить все модули", async () => {
    const ls = { "mooncore.bootGuard": JSON.stringify({ n: 3, last: "" }) };
    const t = makeWindow(baseBoot(), ls);
    assert.strictEqual(t.mc._skip("mlbg"), true);
    assert.strictEqual(JSON.parse(ls["mooncore.bootGuard"]).n, 0, "счётчик сброшен — следующий запуск пробует снова");
});

test("время запуска: модуль измерен и уходит хосту после загрузки окна", async () => {
    const ls = {};
    const t = makeWindow(baseBoot(), ls);
    t.mc._modStart("mlbg"); t.mc._skip("mlbg"); t.mc._modDone("mlbg");   // _skip — первая строка файла модуля
    t.fireWindow("load");
    await tick(4300);
    const c = t.calls.find((x) => x.method === "timing");
    assert.ok(c, "timing отправлен");
    assert.ok(typeof c.body.modules.mlbg === "number" && typeof c.body.runtime === "number");
    assert.strictEqual(JSON.parse(ls["mooncore.bootGuard"]).n, 0, "запуск удался — метка снята");
});

test("файл модуля не выполнился (integrity/нет файла) — хост узнаёт об этом", async () => {
    const t = makeWindow(baseBoot(), {});
    t.mc._modStart("mlbg"); t.mc._modDone("mlbg");                        // между метками код не шёл
    t.fireWindow("load");
    await tick(4300);
    const c = t.calls.find((x) => x.method === "timing");
    assert.deepStrictEqual(c.body.failed, ["mlbg"]);
    assert.ok(!("mlbg" in c.body.modules), "время не пишем — модуль не работал");
    assert.ok(t.calls.some((x) => x.method === "log" && /не выполнился/.test(x.body.msg)), "и в журнал");
});

test("самолечение: сломанное правило находит элемент по запасному селектору и по признакам", async () => {
    const t = makeWindow(baseBoot());
    const item = t.bar.appendChild(new El("div")); item.id = "status-sync"; item.setAttribute("aria-label", "Sync");
    item.textContent = "sync";
    const other = t.bar.appendChild(new El("div")); other.setAttribute("aria-label", "Other"); other.textContent = "x";
    t.mc.applyState({ rev: "r1", snippets: [], design: { rules: {
        ".renamed-a": { label: "А", props: { hide: true }, fp: { tag: "div", one: true, alts: [".nope", "#status-sync"] } },
        ".renamed-b": { label: "Б", props: { opacity: 0.5 }, fp: { tag: "div", one: true, aria: "Sync", text: "sync" } },
        ".renamed-c": { label: "В", props: { opacity: 0.5 }, fp: { tag: "div", one: true, cls: ["only-classes"] } },
        ".part.sidebar": { label: "Живое", props: { opacity: 0.9 }, fp: { tag: "div", one: true, alts: ["#status-sync"] } },
    }, settings: {} } });
    const design = t.mc.checkAll().find((g) => g.id === "~design").rules;
    const by = (s) => design.find((r) => r.selector === s);
    assert.strictEqual(JSON.stringify(by(".renamed-a").heal), JSON.stringify({ to: "#status-sync", how: "alt" }));
    assert.strictEqual(by(".renamed-b").heal.how, "search");
    assert.ok(t.w.document.querySelectorAll(by(".renamed-b").heal.to).length === 1 && t.w.document.querySelector(by(".renamed-b").heal.to) === item, "найден именно тот элемент");
    assert.ok(!by(".renamed-c").heal, "по одним классам не угадываем");
    assert.ok(!by(".part.sidebar").heal, "живое правило не трогаем");
});

test("отпечатки: старые правила без отпечатка получают его, пока элемент на экране", async () => {
    const t = makeWindow(baseBoot());
    await tick(5);
    t.mc.applyState({ rev: "r1", snippets: [], design: { rules: {
        ".part.sidebar": { label: "Сайдбар", props: { hide: true } },
        ".missing": { label: "Нет", props: { hide: true } },
        ".part.statusbar": { label: "С отпечатком", props: { hide: true }, fp: { tag: "div" } },
    }, settings: {} } });
    assert.strictEqual(t.mc._backfill(), 1);
    await tick(300);
    const call = t.calls.find((c) => c.method === "design");
    assert.ok(call, "отпечаток ушёл на хост");
    const op = call.body.ops.find((o) => o.op === "fingerprint");
    assert.strictEqual(op.selector, ".part.sidebar");
    assert.strictEqual(op.fp.tag, "div");
});

test("режим разработки модуля: уборка, новый код от хоста, повтор не перезапускает", async () => {
    const t = makeWindow(baseBoot());
    await tick(5);
    const m = t.mc.module("mlbg");
    const cleaned = [];
    m.onDispose(() => cleaned.push(1));
    m.onDispose(() => cleaned.push(2));
    m.on("live", () => {});
    t.handlers["1001"] = (method, body) => (method === "moduleCode" ? { ok: true, code: "window.__hot = " + JSON.stringify(body.id) } : { ok: true });
    const sha = "c".repeat(64);
    t.es(1001).emit("moduleReload", { id: "mlbg", sha: sha });
    await tick(10);
    assert.deepStrictEqual(cleaned, [2, 1], "уборка в обратном порядке");
    assert.strictEqual(m.hot, 1);
    assert.strictEqual(t.calls.filter((c) => c.method === "moduleCode").length, 1);
    t.es(1002).emit("moduleReload", { id: "mlbg", sha: sha });   // тот же код от второго хоста
    t.es(1001).emit("moduleReload", { id: "nope", sha: sha });
    await tick(10);
    assert.strictEqual(t.calls.filter((c) => c.method === "moduleCode").length, 1, "тот же sha и чужой id — без повторов");
});

test("конструктор: «Как было» на время выключает CSS правок и сниппетов", async () => {
    const t = makeWindow(baseBoot());
    t.mc.applyState({ rev: "r1", snippets: [{ id: "a.css", code: ".a{}" }], design: { rules: { ".part.sidebar": { label: "С", props: { hide: true } } }, settings: {} } });
    t.mc.startDesign();
    const bar = t.body.children.find((c) => c.getAttribute("data-mooncore-ui") === "design-bar");
    const b = bar.children.find((c) => c.textContent === "Как было");
    const media = () => t.styles().filter((s) => /^(a\.css|~design)$/.test(s.getAttribute("data-mooncore") || "")).map((s) => s.media || "");
    b.listeners.mousedown.forEach((fn) => fn({ preventDefault() {} }));
    assert.deepStrictEqual(media(), ["not all", "not all"]);
    b.listeners.mouseup.forEach((fn) => fn({}));
    assert.deepStrictEqual(media(), ["", ""]);
    t.mc.stopDesign();
});

test("свои кнопки: появляются в своей зоне, обновляются, лишние убираются", async () => {
    const t = makeWindow(baseBoot());
    const right = t.bar.appendChild(new El("div")); right.className = "right-items";
    await tick(200);                                        // воркбенч готов
    const btn = { id: "b1a2b3", zone: "statusbar-right", command: "workbench.action.files.saveAll", icon: "save-all", label: "Всё", tooltip: "Сохранить всё", order: 0 };
    t.mc.applyState({ rev: "r1", snippets: [], design: { rules: {}, settings: {}, buttons: [btn] }, uiButtons: [{ id: "xext1", zone: "statusbar-right", command: "ext.run", icon: "rocket", label: "", tooltip: "", order: 0, owner: "Моё расширение" }] });
    const els = () => right.children.filter((c) => c.hasAttribute("data-mooncore-btn"));
    assert.deepStrictEqual(els().map((e) => e.getAttribute("data-mooncore-btn")).sort(), ["b1a2b3", "xext1"]);
    assert.strictEqual(els().find((e) => e.getAttribute("data-mooncore-btn") === "b1a2b3").title, "Сохранить всё");
    els().find((e) => e.getAttribute("data-mooncore-btn") === "xext1").listeners.click[0]({ preventDefault() {}, stopPropagation() {} });
    await tick(10);
    assert.ok(t.calls.some((c) => c.method === "uiClick" && c.body.id === "xext1"), "кнопка расширения — его обработчику");
    els().find((e) => e.getAttribute("data-mooncore-btn") === "b1a2b3").listeners.click[0]({ preventDefault() {}, stopPropagation() {} });
    await tick(10);
    assert.ok(t.calls.some((c) => c.method === "command" && c.body.id === "workbench.action.files.saveAll"), "своя — команда через мост");
    t.mc.applyState({ rev: "r2", snippets: [], design: { rules: {}, settings: {}, buttons: [] }, uiButtons: [] });
    assert.strictEqual(els().length, 0, "убраны");
});

test("кнопки расширений: у каждого хоста свои, в окне без повторов; клик — сначала своему хосту, чужой отвечает retry", async () => {
    const t = makeWindow(baseBoot());
    const right = t.bar.appendChild(new El("div")); right.className = "right-items";
    await tick(200);
    const ext = (id, owner) => ({ id: id, zone: "statusbar-right", command: "", icon: "rocket", label: "", tooltip: "", order: 0, owner: owner });
    const st = (ui) => ({ v: P.VERSION, rev: "r" + ui.length, snippets: [], design: { rules: {}, settings: {}, buttons: [] }, uiButtons: ui });
    t.es(1001).emit("state", st([ext("xaaaa", "А"), ext("xshared", "Общее")]));
    t.es(1002).emit("state", st([ext("xbbbb", "Б"), ext("xshared", "Общее")]));
    const ids = () => right.children.filter((c) => c.hasAttribute("data-mooncore-btn")).map((e) => e.getAttribute("data-mooncore-btn")).sort();
    assert.deepStrictEqual(ids(), ["xaaaa", "xbbbb", "xshared"], "состояние второго хоста не стирает кнопки первого, общая — одна");
    t.es(1002).emit("focus", { focused: true });                // свой хост — 1002
    t.handlers["1002"] = (m) => (m === "uiClick" ? { ok: false, retry: true, error: "нет такой кнопки" } : { ok: true });
    t.handlers["1001"] = () => ({ ok: true });
    right.children.find((e) => e.getAttribute("data-mooncore-btn") === "xaaaa").listeners.click[0]({ preventDefault() {}, stopPropagation() {} });
    await tick(20);
    const clicks = t.calls.filter((c) => c.method === "uiClick").map((c) => c.port);
    assert.deepStrictEqual(clicks, [1002, 1001], "свой хост первым, после retry — следующий");
    t.es(1001).emit("state", st([]));
    assert.deepStrictEqual(ids(), ["xbbbb", "xshared"], "хост убрал свою кнопку — пропала только она");
});

test("протокол: хост другой версии — окно сообщает в журнал один раз", async () => {
    const t = makeWindow(baseBoot());
    await tick(5);
    t.es(1001).emit("state", { v: P.VERSION + 1, rev: "rX", snippets: [] });
    t.es(1002).emit("state", { v: P.VERSION + 1, rev: "rY", snippets: [] });
    await tick(10);
    const logs = t.calls.filter((c) => c.method === "log" && c.body.where === "протокол");
    assert.strictEqual(logs.length, 1);
    assert.ok(/перезагрузи окно/.test(logs[0].body.msg));
    t.es(1001).emit("state", { v: P.VERSION, rev: "rZ", snippets: [] });
    await tick(10);
    assert.strictEqual(t.calls.filter((c) => c.method === "log" && c.body.where === "протокол").length, 1);
});

test("контекст окна: атрибуты на <html> только от своего хоста", async () => {
    const t = makeWindow(baseBoot());
    await tick(5);
    const html = t.w.document.documentElement;
    t.es(1001).emit("ctx", { lang: "markdown", branch: "main" });
    assert.strictEqual(html.getAttribute("data-mc-lang"), null, "два хоста, свой не найден — не применяем");
    t.es(1001).emit("focus", { focused: true });
    assert.strictEqual(html.getAttribute("data-mc-lang"), "markdown", "нашли свой — применили его последний контекст");
    t.es(1002).emit("ctx", { lang: "go" });
    assert.strictEqual(html.getAttribute("data-mc-lang"), "markdown", "контекст чужого окна игнорируется");
    t.es(1001).emit("ctx", { lang: "", branch: "dev" });
    assert.strictEqual(html.getAttribute("data-mc-lang"), null);
    assert.strictEqual(html.getAttribute("data-mc-branch"), "dev");
});

test("эффекты: свечение — стилем, след — холстом поверх окна; выключение убирает всё", async () => {
    const t = makeWindow(baseBoot());
    await tick(200);
    t.mc.applyState({ rev: "r1", snippets: [], design: { rules: {}, settings: {}, fx: { lineGlow: true, cursorTrail: true, color: "#ff00ff" } } });
    const fxStyle = t.styles().find((s) => s.getAttribute("data-mooncore") === "~fx");
    assert.ok(fxStyle && /current-line/.test(fxStyle.textContent) && /#ff00ff/.test(fxStyle.textContent));
    assert.ok(t.body.children.some((c) => c.tagName === "CANVAS" && c.getAttribute("data-mooncore-ui") === "fx"));
    t.mc.applyState({ rev: "r2", snippets: [], design: { rules: {}, settings: {}, fx: {} } });
    assert.ok(!t.body.children.some((c) => c.tagName === "CANVAS"), "холст снят");
    assert.ok(!fxStyle.isConnected, "стиль снят");
});

// Ленивая загрузка интерфейса — отдельным файлом (ленивая сборка: ядро + чанк).
require("./runtime/lazy.test")(test, { makeWindow, baseBoot, tick, P });
// Старт окна: этапы, бюджет времени; повтор горячей перезагрузки.
require("./runtime/startup.test")(test, { makeWindow, baseBoot, tick });
// VS Code для модулей: события, команды, ленивые модули, окна, шина.
require("./runtime/modules2.test")(test, { makeWindow, baseBoot, tick });
// Страховки окна: безопасный режим, стоп-кран, падающие сниппеты, пульс, сообщения.
require("./runtime/safety.test")(test, { makeWindow, baseBoot, tick, D });
// Скорость VS Code: метки старта, подвисания, пульс; таймеры скрытого окна, быстрый мост.
require("./runtime/perf.test")(test, { makeWindow, baseBoot, tick });

(async () => {
    for (const t of queue) {
        try { await t.fn(); passed++; console.log("  ok   " + t.name); }
        catch (e) { failed++; console.log("  FAIL " + t.name + "\n       " + (e && e.stack || e)); }
    }
    console.log("\nрантайм: " + passed + " passed, " + failed + " failed");
    process.exit(failed ? 1 : 0);
})();
