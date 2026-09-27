// Смоук-тесты Moon Core: Цвета темы, кнопки, эффекты, глубокая интеграция.
"use strict";
const { test, assert, fs, os, path, http, EXT, TMP, W, S, P, createBridge, readHosts, D, C, DesignEngine, M, K, CMD, B, AP, D2, E2,
    BASE_HTML, CSP, request, makeEngine, makeModuleDir } = require("./harness");

// ------------------------------------------------------------------ цвета темы, кнопки, эффекты
test("цвета темы: пишутся в штатную настройку, прежнее значение возвращается, чужие ключи целы", async () => {
    const user = { "workbench.colorCustomizations": { "editor.background": "#101010", "[Dracula]": { "tab.border": "#ff0000" } } };
    const engine = makeEngine(user);
    let r = await engine.apply([{ op: "color", key: "wb:statusBar.background", value: "#A6E3A1", label: "Статусбар" }, { op: "color", key: "wb:editor.background", value: "#222222" }, { op: "color", key: "tk:comments", value: "#6c7086" }]);
    assert.ok(r.ok, r.error);
    assert.deepStrictEqual(user["workbench.colorCustomizations"], { "editor.background": "#222222", "[Dracula]": { "tab.border": "#ff0000" }, "statusBar.background": "#a6e3a1" });
    assert.deepStrictEqual(user["editor.tokenColorCustomizations"], { comments: "#6c7086" });
    assert.strictEqual(engine.design.colors["wb:editor.background"].prev, "#101010");
    r = await engine.apply([{ op: "color", key: "wb:x{y}", value: "#000000" }, { op: "color", key: "tk:evil", value: "#000000" }, { op: "color", key: "wb:a.b", value: "red" }]);
    assert.ok(!r.ok, "мусор отвергнут");
    await engine.apply([{ op: "saveProfile", name: "Цвета" }, { op: "clearAll" }]);
    assert.deepStrictEqual(user["workbench.colorCustomizations"], { "editor.background": "#101010", "[Dracula]": { "tab.border": "#ff0000" } }, "исходные значения, наш ключ убран");
    assert.ok(!("editor.tokenColorCustomizations" in user), "пустая настройка снята совсем");
    await engine.apply([{ op: "applyProfile", name: "Цвета" }]);
    assert.strictEqual(user["workbench.colorCustomizations"]["statusBar.background"], "#a6e3a1", "профиль несёт цвета");
    assert.strictEqual(engine.summary().dirty, false);
});

test("кнопки и эффекты: проверка, лимиты, профили, пакет", async () => {
    const D3 = require(path.join(EXT, "lib", "design"));
    assert.strictEqual(D3.cleanButton({ id: "b1234", zone: "nowhere", command: "a.b" }), null);
    assert.strictEqual(D3.cleanButton({ id: "b1234", zone: "titlebar", command: "a b" }), null);
    const b = D3.cleanButton({ id: "b1234", zone: "titlebar", command: "workbench.action.files.saveAll", icon: "save-all", label: "x".repeat(99), args: [1, { a: 2 }], evil: 1 });
    assert.deepStrictEqual(Object.keys(b).sort(), ["args", "command", "icon", "id", "label", "order", "tooltip", "zone"]);
    assert.strictEqual(b.label.length, 40);
    assert.strictEqual(D3.cleanButton({ id: "b1234", zone: "editor", command: "a.b", icon: "Bad Icon!" }).icon, "");
    assert.deepStrictEqual(D3.cleanFx({ cursorTrail: true, lineGlow: "yes", intensity: 50, color: "#ABCDEF", hack: 1 }), { cursorTrail: true, color: "#abcdef" });
    const engine = makeEngine({});
    let r = await engine.apply([{ op: "button", button: b }, { op: "fx", key: "cursorTrail", value: true }, { op: "fx", key: "nope", value: true }]);
    assert.ok(!r.ok && engine.design.buttons.length === 1 && engine.design.fx.cursorTrail === true);
    await engine.apply([{ op: "saveProfile", name: "Кнопки" }, { op: "removeButton", id: "b1234" }, { op: "fx", key: "cursorTrail", value: null }]);
    assert.ok(!engine.design.buttons.length && !engine.design.fx.cursorTrail);
    assert.strictEqual(engine.summary().dirty, true, "после правки профиль «изменён»");
    await engine.apply([{ op: "applyProfile", name: "Кнопки" }]);
    assert.strictEqual(engine.design.buttons[0].id, "b1234");
    const B2 = require(path.join(EXT, "lib", "bundle"));
    const pack = B2.makeBundle({ design: engine.design, profiles: engine.profiles, snippets: [] });
    const parsed = B2.parseBundle(JSON.stringify(pack));
    assert.ok(parsed.ok && parsed.bundle.design.buttons.length === 1 && parsed.bundle.design.fx.cursorTrail);
    const ops = B2.designOps(parsed.bundle);
    assert.ok(ops.some((o) => o.op === "button") && ops.some((o) => o.op === "fx"));
    const bad = B2.parseBundle(JSON.stringify(Object.assign({}, pack, { design: Object.assign({}, pack.design, { buttons: [{ id: "x", zone: "titlebar", command: "a" }], colors: { "wb:a{": "#000000" } }) })));
    assert.ok(bad.ok && !bad.bundle.design.buttons.length && !Object.keys(bad.bundle.design.colors).length && bad.dropped >= 2);
});

test("плавающий элемент: CSS с фиксированной позицией и размером", () => {
    const D3 = require(path.join(EXT, "lib", "design"));
    const d = D3.emptyDesign();
    D3.applyCssOps(d, [{ op: "set", selector: ".breadcrumbs-control", prop: "float", value: true }, { op: "set", selector: ".breadcrumbs-control", prop: "floatX", value: 100 }, { op: "set", selector: ".breadcrumbs-control", prop: "floatW", value: 20 }]);
    const css = D3.buildCss(d);
    assert.ok(/position: fixed !important;/.test(css) && /z-index: 40 !important/.test(css) && /left: 100px !important/.test(css));
    assert.ok(!/width/.test(css), "ширина меньше минимума отброшена");
});

test("условия правил: селектор с приставкой контекста проходит проверку", () => {
    const D3 = require(path.join(EXT, "lib", "design"));
    assert.strictEqual(D3.cleanSelector('html[data-mc-lang="markdown"] .monaco-editor .minimap'), 'html[data-mc-lang="markdown"] .monaco-editor .minimap');
    assert.strictEqual(D3.cleanSelector('html[data-mc-branch="fe\\"at"] .x'), 'html[data-mc-branch="fe\\"at"] .x');
});

test("проверка селекторов: отпечатки и замены каталога", () => {
    const K = require(path.join(EXT, "lib", "checks"));
    const s = K.summarize([{ id: "~catalog", rules: [
        { id: "statusbar", selector: ".part.statusbar", label: "Статусбар", found: true, fp: { tag: "div", id: "workbench.parts.statusbar" } },
        { id: "minimap", selector: ".old-minimap", label: "Миникарта", found: false, heal: { to: ".monaco-editor .minimap2", how: "search" } },
        { id: "bad id!", selector: ".x", found: true, fp: { tag: "div" } },
    ] }]);
    assert.deepStrictEqual(Object.keys(s.catalogPrints), ["statusbar"]);
    assert.deepStrictEqual(s.catalogHeals.map((h) => [h.id, h.to]), [["minimap", ".monaco-editor .minimap2"]]);
    assert.strictEqual(s.heals.length, 0, "замены каталога — не правки пользователя");
});

test("глубокая интеграция: крючок в бандле и импорт в main.js ставятся и снимаются ровно", () => {
    const DP = require(path.join(EXT, "lib", "deep"));
    const bundle = "var a=1;class PKe{constructor(o){this._services=o;this._services.set(H,this),this._globalGraph=i?1:0}}var z=2;";
    const r = DP.patchBundle(bundle);
    assert.ok(r.ok && DP.hasDi(r.text) && /__MOONCORE_DI__\.push\(this\)/.test(r.text));
    assert.strictEqual(DP.patchBundle(r.text).text, r.text, "повторный патч не удваивает крючок");
    assert.strictEqual(DP.stripBundle(r.text), bundle, "снятие возвращает ровно исходник");
    assert.ok(!DP.patchBundle("var nothing=1;").ok, "нет места — не патчим");
    assert.ok(!DP.patchBundle(bundle + bundle).ok, "два места — не угадываем");
    const main = "import x from 'y';\n//# sourceMappingURL=main.js.map\n";
    const pm = DP.patchMain(main);
    assert.ok(DP.hasMain(pm) && pm.indexOf("import(\"./" + DP.MAIN_FILE + "\")") !== -1);
    assert.strictEqual(DP.patchMain(pm), pm);
    assert.strictEqual(DP.stripMain(pm), main);
    assert.deepStrictEqual(DP.cleanWindowConf({ opacity: 0.1, alwaysOnTop: "yes", material: "glass" }), { opacity: 0.3, alwaysOnTop: false, material: "none" });
    assert.deepStrictEqual(DP.cleanWindowConf({ opacity: 0.955, alwaysOnTop: true, material: "mica" }), { opacity: 0.96, alwaysOnTop: true, material: "mica" });
    const script = DP.mainScript("moonlivedt.moon-core");
    assert.ok(/import \{ app, BrowserWindow \} from "electron";/.test(script) && /browser-window-created/.test(script) && /mooncore-main\.json/.test(script));
});
