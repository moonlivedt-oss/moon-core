// Смоук-тесты Moon Core: история правок (отменить / вернуть), резервные копии вида, страж корня окна.
"use strict";
const { test, assert, fs, path, EXT, TMP, D, C, DesignEngine } = require("./harness");
const G = require(path.join(EXT, "lib", "design-guard"));
const BK = require(path.join(EXT, "lib", "backups"));
const { History } = require(path.join(EXT, "lib", "history"));

function engineIn(name, user) {
    const dir = fs.mkdtempSync(path.join(TMP, name + "-"));
    const opts = {
        designFile: path.join(dir, "design.json"), profilesFile: path.join(dir, "profiles.json"), backupDir: path.join(dir, "backups"),
        config: { globalValue: (k) => user[k], update: async (k, v) => { if (v === undefined) delete user[k]; else user[k] = v; } },
    };
    return { e: new DesignEngine(opts), dir: dir, opts: opts };
}

test("страж: корень окна и интерфейс Moon Core не прячутся, обычные элементы — можно", () => {
    assert.ok(G.risky("body", "hide", true));
    assert.ok(G.risky(".monaco-workbench", "opacity", 0.05));
    assert.ok(G.risky("html[data-mc-lang=\"markdown\"] .monaco-workbench", "hide", true), "условие перед селектором не обходит проверку");
    assert.ok(G.risky(".part.sidebar, body", "hide", true), "корень в списке через запятую");
    assert.ok(G.risky(".part.editor", "hide", true));
    assert.ok(G.risky("[data-mooncore-ui=design]", "hide", true));
    assert.ok(G.risky(".monaco-grid-view", "width", 10));
    assert.strictEqual(G.risky(".part.sidebar", "hide", true), "");
    assert.strictEqual(G.risky(".monaco-workbench", "fontSize", 14), "", "безвредное свойство на корне допустимо");
    assert.strictEqual(G.risky(".monaco-workbench .tab[aria-label=\"body div\"]", "hide", true), "", "текст в атрибуте — не звено селектора");
    assert.strictEqual(G.risky(".part.editor", "opacity", 0.5), "");
});

test("страж: правка корня отбрасывается в операциях, файле правок и профиле", async () => {
    const d = D.emptyDesign();
    assert.strictEqual(D.applyCssOps(d, [{ op: "set", selector: "body", prop: "hide", value: true }]), 0);
    assert.strictEqual(D.applyCssOps(d, [{ op: "set", selector: ".part.sidebar", prop: "hide", value: true }]), 1);
    const clean = D.cleanDesign({ rules: { ".monaco-workbench": { props: { hide: true, fontSize: 13 } } } });
    assert.deepStrictEqual(clean.rules[".monaco-workbench"].props, { fontSize: 13 });
    const { e } = engineIn("guard", {});
    const r = await e.apply([{ op: "set", selector: "body", prop: "hide", value: true }]);
    assert.strictEqual(r.ok, false);
    assert.ok(/корень окна/.test(r.error));
    assert.deepStrictEqual(e.design.rules, {});
});

test("новые свойства: шаблон значения, рамка со стилем, шрифты настроек и эффектов", () => {
    assert.strictEqual(D.cleanValue("blur", 8), 8);
    assert.strictEqual(D.cleanValue("blur", 400), undefined);
    assert.strictEqual(D.cleanValue("textTransform", "uppercase"), "uppercase");
    const d = D.emptyDesign();
    D.applyCssOps(d, [{ op: "set", selector: ".a", prop: "blur", value: 8 }, { op: "set", selector: ".a", prop: "borderWidth", value: 2 }, { op: "set", selector: ".a", prop: "shadow", value: 12 }]);
    const css = D.buildCss(d);
    assert.ok(css.includes("backdrop-filter: blur(8px) !important;"), css);
    assert.ok(css.includes("border-width: 2px !important;\n  border-style: solid !important;"), css);
    assert.ok(css.includes("box-shadow: 0 4px 12px rgba(0, 0, 0, .45) !important;"), css);
    assert.strictEqual(C.validateSetting("editor.fontFamily", "Fira Code, 'JetBrains Mono', monospace"), "Fira Code, 'JetBrains Mono', monospace");
    assert.strictEqual(C.validateSetting("editor.fontFamily", "x; } body { display: none"), undefined);
    assert.strictEqual(C.validateSetting("editor.fontFamily", "url(http://x)"), undefined);
    assert.strictEqual(C.validateSetting("editor.fontFamily", "'Fira Code"), undefined, "незакрытая кавычка");
    assert.strictEqual(D.cleanFxValue("uiFont", "Inter, sans-serif"), "Inter, sans-serif");
    assert.strictEqual(D.cleanFxValue("uiFont", "x} body{"), undefined);
    assert.strictEqual(D.cleanFxValue("roundedUi", 6), 6);
    assert.strictEqual(D.cleanFxValue("roundedUi", 99), undefined);
    Object.keys(C.PRESETS).forEach((n) => Object.keys(C.PRESETS[n].settings).forEach((k) =>
        assert.notStrictEqual(C.validateSetting(k, C.PRESETS[n].settings[k]), undefined, "профиль «" + n + "»: " + k)));
});

test("история: отмена и возврат правил, настроек и цветов; ползунок — один шаг", async () => {
    const user = { "editor.minimap.enabled": true };
    const { e } = engineIn("hist", user);
    await e.apply([{ op: "set", selector: ".part.sidebar", prop: "opacity", value: 0.5 }]);
    await e.apply([{ op: "set", selector: ".part.sidebar", prop: "opacity", value: 0.6 }]);
    await e.apply([{ op: "set", selector: ".part.sidebar", prop: "opacity", value: 0.7 }]);
    assert.strictEqual(e.history.summary().undo, 1, "три правки одного свойства подряд — один шаг");
    await e.apply([{ op: "setting", key: "editor.minimap.enabled", value: false }]);
    await e.apply([{ op: "color", key: "wb:statusBar.background", value: "#112233" }]);
    assert.strictEqual(user["editor.minimap.enabled"], false);
    assert.deepStrictEqual(user["workbench.colorCustomizations"], { "statusBar.background": "#112233" });
    assert.deepStrictEqual(e.stateExtra({}).history, { undo: 3, redo: 0 });

    let r = await e.apply([{ op: "undo" }]);
    assert.ok(r.ok, r.error);
    assert.strictEqual(user["workbench.colorCustomizations"], undefined, "цвет темы вернулся");
    r = await e.apply([{ op: "undo" }]);
    assert.strictEqual(user["editor.minimap.enabled"], true, "настройка вернулась к исходной");
    assert.deepStrictEqual(e.design.settings, {});
    r = await e.apply([{ op: "undo" }]);
    assert.deepStrictEqual(e.design.rules, {}, "правило снято");
    assert.deepStrictEqual(e.history.summary(), { undo: 0, redo: 3 });
    r = await e.apply([{ op: "undo" }]);
    assert.strictEqual(r.ok, false);

    await e.apply([{ op: "redo" }]);
    await e.apply([{ op: "redo" }]);
    assert.strictEqual(e.design.rules[".part.sidebar"].props.opacity, 0.7);
    assert.strictEqual(user["editor.minimap.enabled"], false);
    assert.strictEqual(e.design.settings["editor.minimap.enabled"].prev, true, "исходное значение настройки не потеряно");
    // Новая правка после отмены обрывает «вернуть».
    await e.apply([{ op: "set", selector: ".x", prop: "hide", value: true }]);
    assert.strictEqual(e.history.summary().redo, 0);
});

test("история: вид изменён мимо истории (другое окно) — шаг не применяется, история сброшена", async () => {
    const { e, opts } = engineIn("stale", {});
    await e.apply([{ op: "set", selector: ".a", prop: "hide", value: true }]);
    const other = new DesignEngine(opts);                       // «другое окно» с тем же хранилищем
    await other.apply([{ op: "set", selector: ".b", prop: "hide", value: true }]);
    const r = await e.apply([{ op: "undo" }]);
    assert.strictEqual(r.ok, false);
    assert.ok(/другом окне/.test(r.error));
    assert.deepStrictEqual(Object.keys(e.design.rules).sort(), [".a", ".b"], "чужая правка цела");
    assert.deepStrictEqual(e.history.summary(), { undo: 0, redo: 0 });
    const h = new History((d) => JSON.stringify(d));
    for (let i = 0; i < 60; i++) h.record({ i: i }, "k" + i, "");
    assert.strictEqual(h.summary().undo, 40, "история ограничена");
});

test("резервные копии: перед профилем и сбросом; восстановление возвращает вид и настройки", async () => {
    const user = {};
    const { e, opts } = engineIn("bak", user);
    await e.apply([{ op: "set", selector: ".part.sidebar", prop: "opacity", value: 0.5 }, { op: "setting", key: "editor.minimap.enabled", value: false }]);
    await e.apply([{ op: "applyProfile", name: "Крупный" }]);
    let list = BK.list(opts.backupDir);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].reason, "profile");
    assert.strictEqual(list[0].edits, 2);
    await e.apply([{ op: "clearAll" }]);
    assert.strictEqual(BK.list(opts.backupDir).length, 2);
    await e.apply([{ op: "clearAll" }]);
    assert.strictEqual(BK.list(opts.backupDir).length, 2, "пустой вид не копируется");
    list = BK.list(opts.backupDir);
    const r = await e.apply([{ op: "restore", design: list[list.length - 1].design }]);
    assert.ok(r.ok, r.error);
    assert.strictEqual(e.design.rules[".part.sidebar"].props.opacity, 0.5);
    assert.strictEqual(user["editor.minimap.enabled"], false);
    // Подложенная копия с правкой корня окна и чужой настройкой — отсеивается проверкой.
    await e.apply([{ op: "restore", design: { rules: { body: { props: { hide: true } } }, settings: { "terminal.integrated.shell.windows": { value: "evil.exe" } } } }]);
    assert.deepStrictEqual(e.design.rules, {});
    assert.deepStrictEqual(e.design.settings, {});
    for (let i = 0; i < 20; i++) BK.save(opts.backupDir, { rules: { [".r" + i]: { label: "", props: { hide: true }, ts: 1 } }, settings: {}, colors: {}, buttons: [], fx: {} }, "manual");
    assert.strictEqual(BK.list(opts.backupDir).length, BK.BACKUPS_MAX);
});

test("повреждённый файл правок не затирается: откладывается, вид берётся из копии", async () => {
    const { e, opts } = engineIn("corrupt", {});
    await e.apply([{ op: "set", selector: ".keep", prop: "hide", value: true }]);
    BK.save(opts.backupDir, e.design, "manual");
    fs.writeFileSync(opts.designFile, "{ \"rules\": { \".keep\": ", "utf8");      // недописанный JSON
    assert.ok(BK.isCorrupt(opts.designFile));
    const again = new DesignEngine(opts);
    assert.ok(again.design.rules[".keep"], "вид восстановлен из копии");
    assert.ok(fs.existsSync(opts.designFile + ".corrupt"), "повреждённый файл отложен");
    assert.ok(!BK.isCorrupt(opts.designFile), "файл правок снова читается");
});
