// Смоук-тесты Moon Core: Самолечение, профиль проекта, Доктор, части хоста.
"use strict";
const { test, assert, fs, os, path, http, EXT, TMP, W, S, P, createBridge, readHosts, D, C, DesignEngine, M, K, CMD, B, AP, D2, E2,
    BASE_HTML, CSP, request, makeEngine, makeModuleDir } = require("./harness");

// ------------------------------------------------------------------ самолечение, профили проекта, доктор

test("отпечаток: проверка полей, запоминается один раз, переживает чтение файла", () => {
    assert.strictEqual(D2.cleanFp(null), null);
    assert.strictEqual(D2.cleanFp({ tag: "DIV!", cls: ["a b"], alts: ["x{}"] }), null, "мусор отброшен целиком");
    const fp = D2.cleanFp({ tag: "div", id: "status.sync", aria: "Синхронизация", cls: ["statusbar-item", "bad class"], alts: ["#a", "b{c}", "#a"], cat: "statusItem", one: true, extra: 1 });
    assert.deepStrictEqual(fp, { alts: ["#a"], tag: "div", id: "status.sync", aria: "Синхронизация", cls: ["statusbar-item"], cat: "statusItem", one: true });
    const d = D2.emptyDesign();
    D2.applyCssOps(d, [{ op: "set", selector: ".x", prop: "hide", value: true, fp: { tag: "div", aria: "X" } }]);
    D2.applyCssOps(d, [{ op: "set", selector: ".x", prop: "opacity", value: 0.5, fp: { tag: "span" } }]);
    assert.strictEqual(d.rules[".x"].fp.tag, "div", "отпечаток не перезаписывается следующими правками");
    assert.strictEqual(D2.applyCssOps(d, [{ op: "fingerprint", selector: ".x", fp: { tag: "a", aria: "Y" } }]), 1);
    assert.strictEqual(d.rules[".x"].fp.aria, "Y");
    assert.strictEqual(D2.applyCssOps(d, [{ op: "fingerprint", selector: ".none", fp: { tag: "a" } }]), 0, "нет правила — нечего помечать");
    const f = path.join(TMP, "fp-design.json");
    D2.writeDesign(f, d);
    assert.deepStrictEqual(D2.readDesign(f).rules[".x"].fp, { tag: "a", aria: "Y" });
    assert.ok(!/fp|aria/.test(D2.buildCss(d)), "отпечаток в CSS не попадает");
});

test("самолечение: правило переезжает на новый селектор, свойства сливаются, профили тоже", async () => {
    const d = D2.emptyDesign();
    D2.applyCssOps(d, [
        { op: "set", selector: ".old", prop: "hide", value: true, label: "Старое", fp: { tag: "div", aria: "A" } },
        { op: "set", selector: ".new", prop: "opacity", value: 0.4 },
    ]);
    assert.strictEqual(D2.applyCssOps(d, [{ op: "renameRule", from: ".old", to: ".new", fp: { tag: "div", id: "n" } }]), 1);
    assert.ok(!d.rules[".old"]);
    assert.deepStrictEqual(d.rules[".new"].props, { opacity: 0.4, hide: true });
    assert.deepStrictEqual(d.rules[".new"].fp, { tag: "div", id: "n" });
    assert.strictEqual(D2.applyCssOps(d, [{ op: "renameRule", from: ".new", to: "a{b}" }]), 0, "инъекция в новом селекторе не проходит");

    const engine = makeEngine({});
    await engine.apply([{ op: "set", selector: ".gone", prop: "hide", value: true, label: "Пропало" }, { op: "saveProfile", name: "Мой" }]);
    const r = await engine.apply([{ op: "renameRule", from: ".gone", to: ".found" }]);
    assert.ok(r.ok);
    assert.ok(engine.design.rules[".found"] && !engine.design.rules[".gone"]);
    assert.ok(engine.profiles.list["Мой"].rules[".found"], "профиль тоже починен");
    assert.strictEqual(engine.summary().dirty, false, "профиль и правки совпадают — не «изменён»");
});

test("проверка селекторов: замены из окна проходят проверку", () => {
    const K = require(path.join(EXT, "lib", "checks"));
    const s = K.summarize([{ id: "~design", rules: [
        { selector: ".a", label: "А", found: false, heal: { to: "#a", how: "alt" } },
        { selector: ".b", found: false, heal: { to: "x{}", how: "alt" } },
        { selector: ".c", found: false, heal: { to: ".c2", how: "magic" } },
        { selector: ".d", found: true },
    ] }, { id: "x.css", rules: [{ selector: ".s", found: false, heal: { to: ".t", how: "alt" } }] }]);
    assert.deepStrictEqual(s.heals.map((h) => [h.from, h.to, h.how, h.label]), [[".a", "#a", "alt", "А"]]);
    assert.strictEqual(s.user.dead, 4);
});

test("профили по контексту: тема и время суток (через полночь)", () => {
    const AP = require(path.join(EXT, "lib", "autoprofile"));
    const rules = [{ profile: "Ночь", time: "22:00-07:00" }, { profile: "Обед", time: ["12:00-13:00"] }, { profile: "Светлый", themes: ["light", "nope"] }, { profile: "Плохое", time: "25:00-01:00" }];
    assert.strictEqual(AP.cleanRules(rules).length, 3, "правило только с неверным временем отброшено");
    assert.strictEqual(AP.pick(rules, { minutes: 23 * 60 }), "Ночь");
    assert.strictEqual(AP.pick(rules, { minutes: 6 * 60 + 59 }), "Ночь");
    assert.strictEqual(AP.pick(rules, { minutes: 7 * 60 }), "");
    assert.strictEqual(AP.pick(rules, { minutes: 12 * 60 + 30 }), "Обед");
    assert.strictEqual(AP.pick(rules, { minutes: 15 * 60, theme: "light" }), "Светлый");
    assert.strictEqual(AP.pick([{ profile: "X", time: "10:00-12:00", languages: ["go"] }], { minutes: 11 * 60, language: "js" }), "", "условия внутри правила — все сразу");
    assert.strictEqual(AP.usesTime(rules), true);
    assert.strictEqual(AP.usesTime([{ profile: "A", languages: ["md"] }]), false);
});

test("профиль проекта: use, свой вид, отказ на мусор, сборка из правок", async () => {
    const PR = require(path.join(EXT, "lib", "project"));
    assert.strictEqual(PR.parse('{"use":"Минимал"}').use, "Минимал");
    assert.ok(!PR.parse("не json").ok);
    assert.ok(!PR.parse('{"use":"a{b}"}').ok);
    assert.ok(!PR.parse('{"rules":{"x{}":{"props":{"hide":true}}},"settings":{"evil.key":1}}').ok, "после проверки пусто — отказ");
    const p = PR.parse(JSON.stringify({ note: "проект", rules: { ".part.sidebar": { label: "Сайдбар", props: { opacity: 0.8, evil: 1 } } }, settings: { "editor.minimap.enabled": false, "workbench.colorTheme": "x" }, modules: { mlbg: { a: 1 } } }));
    assert.ok(p.ok);
    assert.deepStrictEqual(p.profile.rules[".part.sidebar"].props, { opacity: 0.8 });
    assert.deepStrictEqual(p.profile.settings, { "editor.minimap.enabled": false }, "настройки только из каталога");
    assert.deepStrictEqual(p.profile.modules, {}, "модули из проекта не берутся");
    assert.strictEqual(PR.profileName("my-app"), "Проект my-app");
    assert.ok(E2.cleanName(PR.profileName("a/b\\c:<d>" + "x".repeat(60))), "имя всегда допустимое");
    const text = PR.build({ rules: { ".a": { label: "A", props: { hide: true }, ts: 5 } }, settings: { "breadcrumbs.enabled": { value: false, prev: true, hadPrev: true } } }, "мой");
    const back = PR.parse(text);
    assert.deepStrictEqual(back.profile.settings, { "breadcrumbs.enabled": false });
    assert.ok(back.profile.rules[".a"].props.hide);
    const engine = makeEngine({});
    const r = await engine.apply([{ op: "putProfile", name: "Проект x", profile: back.profile }]);
    assert.ok(r.ok && engine.profiles.list["Проект x"] && engine.profiles.active === "", "положен, но не включён");
    assert.ok(!(await engine.apply([{ op: "putProfile", name: "Минимал", profile: back.profile }])).ok, "встроенный не перезаписать");
});

test("доктор: проблемы и кнопки починки по снимку", () => {
    const DM = require(path.join(EXT, "lib", "doctor-model"));
    const base = { shells: [{ file: "C:/x/workbench.html", injected: true, current: true, checksum: true, blockOk: true }], bridge: { running: true, streams: 1 }, modules: {}, snippets: {}, design: {} };
    assert.deepStrictEqual(DM.problems(base), []);
    assert.strictEqual(DM.verdict(DM.problems(base)), "ok");
    const bad = Object.assign({}, base, {
        shells: [{ file: "C:/x/workbench.html", injected: true, current: false, checksum: false, trusted: false, foreign: ["CPPDOCS-WINDOW"], blockOk: false }],
        bridge: { running: true, streams: 0 },
        timing: { failed: ["mlbg"], skipped: [] },
        check: { deadUser: [{}, {}, {}], heals: [{ from: ".a", to: ".b", label: "А" }] },
        snippets: { jsPending: ["x.js"], errors: [{ id: "y.css", error: "больше 256 КБ" }] },
    });
    const list = DM.problems(bad);
    const fixes = list.map((p) => p.fix).filter(Boolean);
    ["inject", "reload", "heal", "jsReview", "log"].forEach((f) => assert.ok(fixes.includes(f), "нет починки " + f));
    assert.ok(fixes.every((f) => DM.ACTIONS.includes(f)), "каждая кнопка — известное действие страницы");
    assert.strictEqual(DM.verdict(list), "error");
    assert.ok(list.some((p) => /CPPDOCS/.test(p.detail)));
    assert.strictEqual(DM.problems({ shells: [{ file: "w", injected: false }], bridge: { running: true, streams: 0 } })[0].fix, "inject");
});

test("хост и страницы с vscode: части собираются в класс, модули загружаются", () => {
    const Module = require("module");
    const any = new Proxy(function () {}, { get: (t, k) => (k === "then" ? undefined : k === Symbol.toPrimitive ? () => "" : any), apply: () => any, construct: () => any });
    const orig = Module._resolveFilename;
    Module._resolveFilename = function (req) { return req === "vscode" ? "vscode" : orig.apply(this, arguments); };
    require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: any };
    try {
        const { Host } = require(path.join(EXT, "lib", "host"));
        ["runnable", "askJsPending", "exportBundle", "syncIn", "autoProfile", "projectTarget", "saveProjectProfile", "runCheck", "offerHeals", "dispatch", "onDesign"].forEach((k) => assert.strictEqual(typeof Host.prototype[k], "function", k));
        assert.ok(Object.getOwnPropertyDescriptor(Host.prototype, "design").get, "геттер design на месте");
        const MH = require(path.join(EXT, "lib", "module-host"));
        new Function(MH.templateRuntime("my-mod", "Мой \"модуль\""));   // шаблон — рабочий JS
        require(path.join(EXT, "lib", "doctor"));
        const ext = require(path.join(EXT, "extension.js"));
        assert.strictEqual(typeof ext.activate, "function");
    } finally { Module._resolveFilename = orig; delete require.cache.vscode; }
});

test("типы для модулей: d.ts описывает помощника окна целиком", () => {
    const dts = fs.readFileSync(path.join(EXT, "types", "mooncore.d.ts"), "utf8");
    const rt = fs.readFileSync(path.join(EXT, "runtime", "src", "20-modules.js"), "utf8");
    const block = rt.slice(rt.indexOf("modApis[id] = {"), rt.indexOf("return modApis[id];", rt.indexOf("modApis[id] = {")));
    const keys = Array.from(block.matchAll(/^\s{12}(\w+):/gm)).map((m) => m[1]);
    assert.ok(keys.length > 8);
    keys.forEach((k) => assert.ok(new RegExp("\\b" + k + "\\b[?(<:]").test(dts), "в d.ts нет " + k));
});
