// Смоук-тесты Moon Core: Проверка селекторов, команды, перенос вида, профили по контексту.
"use strict";
const { test, assert, fs, os, path, http, EXT, TMP, W, S, P, createBridge, readHosts, D, C, DesignEngine, M, K, CMD, B, AP, D2, E2,
    BASE_HTML, CSP, request, makeEngine, makeModuleDir } = require("./harness");

// ------------------------------------------------------------------ проверка после обновления, команды, перенос, контекст

test("проверка селекторов: сводка отделяет правки пользователя от каталога", () => {
    const s = K.summarize([
        { id: "a.css", rules: [{ selector: ".a", found: true }, { selector: ".old", found: false }] },
        { id: "~design", rules: [{ selector: ".part.x", label: "Икс", found: false }] },
        { id: "~catalog", rules: [{ selector: ".c1", found: true }, { selector: ".c2", found: false }] },
        null, { id: "b.css", rules: "мусор" },
    ]);
    assert.deepStrictEqual(s.user, { total: 3, dead: 2 });
    assert.deepStrictEqual(s.catalog, { total: 2, dead: 1 });
    assert.deepStrictEqual(s.deadUser.map((x) => x.selector), [".old", ".part.x"]);
    assert.ok(s.lines.some((l) => l.indexOf("Правки конструктора") === 0) && s.lines.some((l) => /Икс — \.part\.x/.test(l)));
});

test("команды из окна: разрешено / спросить / запрещено", () => {
    const denied = new Set(["x.bad"]);
    assert.strictEqual(CMD.decide("workbench.action.reloadWindow", {}), "ask");
    assert.strictEqual(CMD.decide("a.b", { setting: ["a.b"] }), "allow");
    assert.strictEqual(CMD.decide("a.b", { stored: ["a.b"] }), "allow");
    assert.strictEqual(CMD.decide("a.b", { stored: { "a.b": true } }), "allow", "старый формат хранения — объект");
    assert.strictEqual(CMD.decide("x.bad", { setting: ["x.bad"], denied: denied }), "deny", "запрет сессии сильнее");
    assert.strictEqual(CMD.decide("a.b", { enabled: false, setting: ["a.b"] }), "deny");
    assert.strictEqual(CMD.decide("rm -rf /", {}), "deny");
    assert.deepStrictEqual(CMD.cleanList(["a", "a", 5, "b c", "d.e"]), ["a", "d.e"]);
});

test("перенос вида: пакет собирается, проверяется и приводит конструктор к себе", () => {
    const src = {
        design: { rules: { ".part.sidebar": { label: "Сайдбар", props: { hide: true }, ts: 1 } }, settings: { "editor.minimap.enabled": { value: false, prev: true, hadPrev: true } } },
        profiles: { active: "Мой", list: { "Мой": { rules: {}, settings: { "editor.minimap.enabled": false }, modules: { mlbg: { mode: "2" } } } } },
        snippets: [{ id: "a.css", code: ".a{}", enabled: true }, { id: "b.js", code: "1", enabled: false }, { id: "c.css", code: "", error: "большой" }],
    };
    const b = B.makeBundle(src);
    assert.strictEqual(b.format, B.FORMAT);
    assert.deepStrictEqual(b.design.settings, { "editor.minimap.enabled": false });
    assert.strictEqual(b.snippets.length, 2, "битый сниппет не едет");
    const p = B.parseBundle(JSON.stringify(b));
    assert.ok(p.ok && p.dropped === 0);
    assert.deepStrictEqual(p.bundle.profiles.list["Мой"].modules, { mlbg: { mode: "2" } }, "часть модулей в профиле переносится");
    assert.strictEqual(p.bundle.profiles.active, "Мой");
    const ops = B.designOps(p.bundle);
    assert.strictEqual(ops[0].op, "clearAll");
    assert.ok(ops.some((o) => o.op === "set" && o.selector === ".part.sidebar" && o.prop === "hide"));
    assert.ok(ops.some((o) => o.op === "setting" && o.key === "editor.minimap.enabled" && o.value === false));
    assert.strictEqual(B.contentKey(p.bundle), B.contentKey(B.parseBundle(B.makeBundle(src)).bundle), "метка времени не влияет на сравнение");
    assert.strictEqual(B.makeBundle(src, { snippets: false }).snippets, undefined);
    assert.ok(/правок конструктора: 1/.test(B.describe(p.bundle)));
});

test("перенос вида: чужой пакет не протащит CSS-инъекцию, чужие настройки и мусор", () => {
    const evil = {
        format: B.FORMAT, v: 1,
        design: {
            rules: { "body{} .x": { props: { hide: true } }, ".ok": { props: { color: "red;} body{display:none", opacity: 0.5 } } },
            settings: { "terminal.integrated.shell.windows": "evil.exe", "editor.minimap.enabled": "да" },
        },
        profiles: { list: { "Минимал": { rules: {} }, "<script>": {}, "Норм": { modules: { "BAD ID": { a: 1 }, mlbg: [1] } } } },
        snippets: [{ id: "../x.css", code: "a" }, { id: "ok.css", code: 5 }, { id: "fine.css", code: ".f{}" }, { id: "fine.css", code: "дубль" }],
    };
    const p = B.parseBundle(evil);
    assert.ok(p.ok);
    assert.deepStrictEqual(Object.keys(p.bundle.design.rules), [".ok"]);
    assert.deepStrictEqual(p.bundle.design.rules[".ok"].props, { opacity: 0.5 });
    assert.deepStrictEqual(p.bundle.design.settings, {});
    assert.deepStrictEqual(Object.keys(p.bundle.profiles.list), ["Норм"]);
    assert.deepStrictEqual(p.bundle.profiles.list["Норм"].modules, {});
    assert.deepStrictEqual(p.bundle.snippets.map((s) => s.id), ["fine.css"]);
    assert.ok(p.dropped >= 8);
    assert.ok(!B.parseBundle({ format: "other" }).ok);
    assert.ok(!B.parseBundle("{битый").ok);
    assert.ok(!B.parseBundle({ format: B.FORMAT, v: 99 }).ok, "пакет новее версии не принимаем");
    assert.ok(B.isEmptyLocal({ design: { rules: {}, settings: {} }, profiles: { list: {} }, snippets: [] }));
    assert.ok(!B.isEmptyLocal({ design: { rules: {}, settings: {} }, profiles: { list: {} }, snippets: [{ id: "a.css" }] }));
});

test("профили по контексту: первое подходящее правило, звёздочки, профиль по умолчанию", () => {
    const rules = [
        { profile: "Только код", languages: ["Markdown"] },
        { profile: "Работа", folders: ["work-*"], branches: ["release/*", "main"] },
        { profile: "Без условий" },
        "мусор",
    ];
    assert.strictEqual(AP.cleanRules(rules).length, 2, "правило без условий и мусор отброшены");
    assert.strictEqual(AP.pick(rules, { language: "markdown", folder: "work-app" }), "Только код");
    assert.strictEqual(AP.pick(rules, { language: "ts", folder: "WORK-app", branch: "release/1.2" }), "Работа");
    assert.strictEqual(AP.pick(rules, { language: "ts", folder: "work-app", branch: "feature/x" }), "", "не все условия правила совпали");
    assert.strictEqual(AP.pick(rules, { language: "ts" }, " Минимал "), "Минимал");
    assert.strictEqual(AP.pick([], {}, ""), "");
    assert.ok(AP.globRe("a.b*").test("a.bXYZ") && !AP.globRe("a.b*").test("aXb"), "точка — буквально, звёздочка — что угодно");
});

test("профили: часть модулей сохраняется, переживает «Обновить» и отдаётся при применении", async () => {
    const e = makeEngine({});
    let r = await e.apply([{ op: "set", selector: ".part.sidebar", prop: "hide", value: true }, { op: "saveProfile", name: "С фоном", modules: { mlbg: { mode: "5" }, "BAD": { x: 1 } } }]);
    assert.ok(r.ok);
    assert.deepStrictEqual(e.profiles.list["С фоном"].modules, { mlbg: { mode: "5" } });
    r = await e.apply([{ op: "saveProfile", name: "С фоном" }]);
    assert.deepStrictEqual(e.profiles.list["С фоном"].modules, { mlbg: { mode: "5" } }, "без modules — прежняя часть сохраняется");
    r = await e.apply([{ op: "applyProfile", name: "С фоном" }]);
    assert.deepStrictEqual(r.applied, [{ name: "С фоном", modules: { mlbg: { mode: "5" } } }]);
    assert.deepStrictEqual(e.summary().list.find((p) => p.name === "С фоном").modules, ["mlbg"]);
    const big = { mlbg: { s: "x".repeat(70 * 1024) } };
    await e.apply([{ op: "saveProfile", name: "Большой", modules: big }]);
    assert.deepStrictEqual(e.profiles.list["Большой"].modules, {}, "часть модуля сверх лимита не хранится");
});
