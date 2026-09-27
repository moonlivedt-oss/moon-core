// Смоук-тесты Moon Core: Конструктор, движок и профили.
"use strict";
const { test, assert, fs, os, path, http, EXT, TMP, W, S, P, createBridge, readHosts, D, C, DesignEngine, M, K, CMD, B, AP, D2, E2,
    BASE_HTML, CSP, request, makeEngine, makeModuleDir } = require("./harness");

// ------------------------------------------------------------------ конструктор

test("каталог: уникальные id, зоны существуют, настройки описаны корректно", () => {
    const ids = new Set(), zones = new Set(C.ZONES.map((z) => z.id));
    C.CATALOG.forEach((e) => {
        assert.ok(!ids.has(e.id), "повтор id " + e.id); ids.add(e.id);
        assert.ok(zones.has(e.zone), "нет зоны " + e.zone);
        assert.ok(e.selector === "" || D.cleanSelector(e.selector) === e.selector, "селектор каталога не проходит проверку: " + e.selector);
        e.settings.forEach((s) => {
            assert.ok(/^[\w.]+$/.test(s.key));
            if (s.type === "enum") assert.ok(s.options.length >= 2);
            if (s.type === "number") assert.ok(s.min < s.max && s.step > 0);
        });
    });
});

test("каталог: validateSetting пропускает только известные ключи и допустимые значения", () => {
    assert.strictEqual(C.validateSetting("editor.minimap.enabled", false), false);
    assert.strictEqual(C.validateSetting("editor.minimap.enabled", "no"), undefined);
    assert.strictEqual(C.validateSetting("workbench.activityBar.location", "hidden"), "hidden");
    assert.strictEqual(C.validateSetting("workbench.activityBar.location", "nowhere"), undefined);
    assert.strictEqual(C.validateSetting("editor.fontSize", 14), 14);
    assert.strictEqual(C.validateSetting("editor.fontSize", 400), undefined);
    assert.strictEqual(C.validateSetting("terminal.integrated.shell.windows", "evil.exe"), undefined);
    assert.strictEqual(C.validateSetting("__proto__", 1), undefined);
});

test("конструктор: селектор и значения не пропускают инъекцию в CSS", () => {
    assert.strictEqual(D.cleanSelector(".a } body { display:none"), "");
    assert.strictEqual(D.cleanSelector(".a; @import url(x)"), "");
    assert.strictEqual(D.cleanSelector(".a /* x */"), "");
    assert.strictEqual(D.cleanSelector(".part.sidebar > .composite.title"), ".part.sidebar > .composite.title");
    assert.strictEqual(D.cleanSelector("#workbench\\.parts\\.editor .tab[aria-label=\"a.js\"]"), "#workbench\\.parts\\.editor .tab[aria-label=\"a.js\"]");
    assert.strictEqual(D.cleanValue("color", "#FF0000"), "#ff0000");
    assert.strictEqual(D.cleanValue("color", "red; } x {"), undefined);
    assert.strictEqual(D.cleanValue("fontSize", 12), 12);
    assert.strictEqual(D.cleanValue("fontSize", "12px"), undefined);
    assert.strictEqual(D.cleanValue("fontFamily", "Cascadia Code, 'Fira Code'"), "Cascadia Code, 'Fira Code'");
    assert.strictEqual(D.cleanValue("fontFamily", "x;}body{"), undefined);
    assert.strictEqual(D.cleanValue("nope", 1), undefined);
});

test("конструктор: операции, сборка CSS и снятие правила", () => {
    const d = D.emptyDesign();
    const n = D.applyCssOps(d, [
        { op: "set", selector: ".part.statusbar", prop: "fontSize", value: 11, label: "Статусбар" },
        { op: "set", selector: ".part.statusbar", prop: "hide", value: true },
        { op: "set", selector: ".x", prop: "color", value: "#123456" },
        { op: "set", selector: ".bad{", prop: "color", value: "#123456" },
        { op: "set", selector: ".x", prop: "zoom", value: 1000 },
    ]);
    assert.strictEqual(n, 3);
    const css = D.buildCss(d);
    assert.ok(css.includes(".part.statusbar {\n  font-size: 11px !important;\n  display: none !important;\n}"));
    assert.ok(css.includes("color: #123456 !important;"));
    assert.ok(!css.includes("bad") && !css.includes("zoom"));
    D.applyCssOps(d, [{ op: "set", selector: ".part.statusbar", prop: "hide", value: null }]);
    assert.deepStrictEqual(Object.keys(d.rules[".part.statusbar"].props), ["fontSize"]);
    D.applyCssOps(d, [{ op: "set", selector: ".part.statusbar", prop: "fontSize", value: null }]);
    assert.ok(!d.rules[".part.statusbar"]);
    D.applyCssOps(d, [{ op: "resetRule", selector: ".x" }]);
    assert.deepStrictEqual(d.rules, {});
});

test("конструктор: учёт настроек (было / стало, возврат к исходному убирает пункт)", () => {
    const d = D.emptyDesign();
    assert.strictEqual(D.recordSetting(d, "editor.fontSize", 16, 14, true, "Размер"), true);
    assert.deepStrictEqual([d.settings["editor.fontSize"].value, d.settings["editor.fontSize"].prev], [16, 14]);
    D.recordSetting(d, "editor.fontSize", 18, 14, true, "Размер");
    assert.strictEqual(d.settings["editor.fontSize"].prev, 14);         // исходное не теряется
    D.recordSetting(d, "editor.fontSize", 14, 14, true, "Размер");
    assert.ok(!d.settings["editor.fontSize"]);                          // вернули как было
    assert.strictEqual(D.recordSetting(d, "breadcrumbs.enabled", true, true, true, ""), false);
});

test("конструктор: файл читается с проверкой (мусор отбрасывается)", () => {
    const f = path.join(TMP, "design.json");
    fs.writeFileSync(f, JSON.stringify({
        rules: { ".ok": { label: "ок", props: { fontSize: 12, evil: "x", color: "red;}" } }, ".bad{": { props: { fontSize: 12 } } },
        settings: { "editor.fontSize": { value: 16, prev: 14, hadPrev: true }, "evil.key": { value: 1 } },
    }));
    const d = D.readDesign(f);
    assert.deepStrictEqual(Object.keys(d.rules), [".ok"]);
    assert.deepStrictEqual(d.rules[".ok"].props, { fontSize: 12 });
    assert.deepStrictEqual(Object.keys(d.settings), ["editor.fontSize"]);
    D.writeDesign(f, d);
    assert.deepStrictEqual(D.readDesign(f), d);
});

// ------------------------------------------------------------------ движок и профили

test("движок: настройки меняются и откатываются к исходному (в том числе «не задано»)", async () => {
    const user = { "editor.fontSize": 14 };
    const e = makeEngine(user);
    let r = await e.apply([{ op: "setting", key: "editor.fontSize", value: 18 }, { op: "setting", key: "breadcrumbs.enabled", value: false }]);
    assert.ok(r.ok);
    assert.deepStrictEqual(user, { "editor.fontSize": 18, "breadcrumbs.enabled": false });
    r = await e.apply([{ op: "setting", key: "evil.key", value: 1 }]);
    assert.ok(!r.ok && /недопустимое/.test(r.error));
    await e.apply([{ op: "clearAll" }]);
    assert.deepStrictEqual(user, { "editor.fontSize": 14 });
});

test("движок: профили — сохранить, применить встроенный, флаг «изменён», вернуть свой, исходный вид", async () => {
    const user = { "editor.minimap.enabled": true };
    const e = makeEngine(user);
    await e.apply([{ op: "set", selector: "#status\\.scm", prop: "hide", value: true, label: "git" }, { op: "setting", key: "editor.fontSize", value: 15 }]);
    await e.apply([{ op: "saveProfile", name: "Мой вид" }]);
    assert.strictEqual(e.summary().active, "Мой вид");
    assert.strictEqual(e.summary().dirty, false);

    await e.apply([{ op: "applyProfile", name: "Минимал" }]);
    assert.strictEqual(user["editor.minimap.enabled"], false);
    assert.ok(!("editor.fontSize" in user), "правки прошлого профиля откатились");
    assert.deepStrictEqual(Object.keys(e.design.rules), [".part.editor .editor-group-watermark"]);
    assert.strictEqual(e.design.settings["editor.minimap.enabled"].prev, true, "исходное значение запомнено от VS Code, а не от прошлого профиля");

    await e.apply([{ op: "set", selector: ".x", prop: "fontSize", value: 12 }]);
    assert.strictEqual(e.summary().dirty, true);

    await e.apply([{ op: "applyProfile", name: "Мой вид" }]);
    assert.deepStrictEqual(Object.keys(e.design.rules), ["#status\\.scm"]);
    assert.strictEqual(user["editor.fontSize"], 15);
    assert.strictEqual(user["editor.minimap.enabled"], true);

    await e.apply([{ op: "clearAll" }]);
    assert.deepStrictEqual(user, { "editor.minimap.enabled": true });
    assert.strictEqual(e.summary().active, "");
    assert.ok(e.summary().list.some((p) => p.name === "Мой вид"), "сброс не удаляет профили");
});

test("движок: имена профилей, встроенные защищены, удаление, чистка файла", async () => {
    const e = makeEngine({});
    let r = await e.apply([{ op: "saveProfile", name: "Минимал" }]);
    assert.ok(!r.ok && /встроенный/.test(r.error));
    r = await e.apply([{ op: "saveProfile", name: "плохое<имя>" }]);
    assert.ok(!r.ok);
    r = await e.apply([{ op: "applyProfile", name: "нет такого" }]);
    assert.ok(!r.ok);
    await e.apply([{ op: "saveProfile", name: "A" }, { op: "deleteProfile", name: "A" }]);
    assert.ok(!e.summary().list.some((p) => p.name === "A"));
    await e.apply([{ op: "deleteProfile", name: "Минимал" }]);
    assert.ok(e.summary().list.some((p) => p.name === "Минимал"));
    // Подложенный файл профилей: мусор отбрасывается.
    fs.writeFileSync(e.opts.profilesFile, JSON.stringify({ active: "B", list: {
        "B": { rules: { ".a{": { props: { hide: true } }, ".ok": { props: { color: "red;}", fontSize: 10 } } }, settings: { "evil.key": 1, "editor.fontSize": 13 } },
        "Минимал": { rules: {}, settings: {} },
        "<bad>": { rules: {}, settings: {} },
    } }));
    e.load();
    assert.deepStrictEqual(Object.keys(e.profiles.list), ["B"]);
    assert.deepStrictEqual(e.profiles.list.B.rules, { ".ok": { label: "", props: { fontSize: 10 } } });
    assert.deepStrictEqual(e.profiles.list.B.settings, { "editor.fontSize": 13 });
    assert.strictEqual(e.profiles.active, "B");
});

test("каталог: встроенные профили и переключатели видимости валидны", () => {
    const { cleanProfile } = require(path.join(EXT, "lib", "engine"));
    Object.keys(C.PRESETS).forEach((n) => {
        const raw = C.PRESETS[n], clean = cleanProfile(raw);
        assert.deepStrictEqual(Object.keys(clean.settings).sort(), Object.keys(raw.settings).sort(), n + ": недопустимая настройка");
        assert.strictEqual(Object.keys(clean.rules).length, Object.keys(raw.rules).length, n + ": недопустимое правило");
    });
    C.CATALOG.filter((e) => e.vis && typeof e.vis === "object").forEach((e) => {
        assert.notStrictEqual(C.validateSetting(e.vis.key, e.vis.on), undefined, e.id + ": vis.on");
        assert.notStrictEqual(C.validateSetting(e.vis.key, e.vis.off), undefined, e.id + ": vis.off");
    });
    C.CATALOG.filter((e) => e.vis === "css" || e.list).forEach((e) => assert.ok(e.selector, e.id + ": нужен селектор"));
});
