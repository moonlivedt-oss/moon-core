// Смоук-тесты Moon Core: выключение правила, части профиля и переименование, правки «по состоянию»
// и страж, перенос из Custom CSS and JS Loader, копии сниппетов, уровни журнала.
"use strict";
const { test, assert, fs, path, EXT, TMP, D, C, B, DesignEngine } = require("./harness");
const G = require(path.join(EXT, "lib", "design-guard"));
const BK = require(path.join(EXT, "lib", "backups"));
const LI = require(path.join(EXT, "lib", "legacy-import"));
const LOG = require(path.join(EXT, "lib", "log"));
const url = require("url");

function engineIn(name, user) {
    const dir = fs.mkdtempSync(path.join(TMP, name + "-"));
    return new DesignEngine({
        designFile: path.join(dir, "design.json"), profilesFile: path.join(dir, "profiles.json"), backupDir: path.join(dir, "backups"),
        config: { globalValue: (k) => user[k], update: async (k, v) => { if (v === undefined) delete user[k]; else user[k] = v; } },
    });
}

test("правило выключается без удаления: нет в CSS, есть в файле, профиле и пакете; отменяется", async () => {
    const e = engineIn("off", {});
    await e.apply([{ op: "set", selector: ".a", prop: "hide", value: true }, { op: "set", selector: ".b", prop: "opacity", value: 0.5 }]);
    let r = await e.apply([{ op: "toggleRule", selector: ".a", off: true }]);
    assert.ok(r.ok && r.changed);
    assert.ok(!D.buildCss(e.design).includes(".a {") && D.buildCss(e.design).includes(".b {"));
    assert.strictEqual(D.readDesign(e.opts.designFile).rules[".a"].off, true, "флаг пережил запись и чтение");
    r = await e.apply([{ op: "toggleRule", selector: ".a", off: true }]);
    assert.strictEqual(r.changed, 0, "повтор ничего не меняет");
    await e.apply([{ op: "saveProfile", name: "С выключенным" }]);
    assert.strictEqual(e.profiles.list["С выключенным"].rules[".a"].off, true);
    assert.strictEqual(e.summary().dirty, false);
    const bundle = B.parseBundle(B.makeBundle({ design: e.design, profiles: e.profiles, snippets: [] })).bundle;
    assert.strictEqual(bundle.design.rules[".a"].off, true);
    assert.ok(B.designOps(bundle).some((o) => o.op === "toggleRule" && o.selector === ".a" && o.off === true));
    await e.apply([{ op: "toggleRule", selector: ".a", off: false }]);
    assert.ok(D.buildCss(e.design).includes(".a {"));
    assert.strictEqual(e.summary().dirty, true, "включённое правило — уже не тот вид, что в профиле");
    await e.apply([{ op: "undo" }]);
    assert.strictEqual(e.design.rules[".a"].off, true, "выключение — шаг истории");
    assert.strictEqual((await e.apply([{ op: "toggleRule", selector: ".nope", off: true }])).changed, 0);
});

test("профиль: взять только часть — остальное не тронуто, активный профиль прежний; переименование", async () => {
    const user = {};
    const e = engineIn("part", user);
    await e.apply([{ op: "set", selector: ".mine", prop: "hide", value: true }, { op: "setting", key: "editor.fontSize", value: 13 }]);
    await e.apply([{ op: "saveProfile", name: "Мой" }]);
    let r = await e.apply([{ op: "applyProfile", name: "Минимал", only: ["settings"] }]);
    assert.ok(r.ok, r.error);
    assert.strictEqual(user["editor.minimap.enabled"], false, "настройки профиля применены");
    assert.strictEqual(user["editor.fontSize"], 13, "своя настройка цела");
    assert.ok(e.design.rules[".mine"], "свои правила целы");
    assert.ok(!e.design.rules[".part.editor .editor-group-watermark"], "правила профиля не брались");
    assert.strictEqual(e.profiles.active, "Мой");
    r = await e.apply([{ op: "applyProfile", name: "Минимал", only: ["rules", "чужое"] }]);
    assert.ok(e.design.rules[".part.editor .editor-group-watermark"] && e.design.rules[".mine"]);
    assert.strictEqual((await e.apply([{ op: "applyProfile", name: "Минимал", only: ["чужое"] }])).ok, false);
    assert.strictEqual((await e.apply([{ op: "applyProfile", name: "Нет такого", only: ["rules"] }])).ok, false);
    // Частичное применение отменяется одним шагом.
    await e.apply([{ op: "undo" }]);
    assert.ok(!e.design.rules[".part.editor .editor-group-watermark"]);

    r = await e.apply([{ op: "renameProfile", from: "Мой", to: "Рабочий" }]);
    assert.ok(r.ok, r.error);
    assert.deepStrictEqual(Object.keys(e.profiles.list), ["Рабочий"]);
    assert.strictEqual(e.profiles.active, "Рабочий");
    assert.strictEqual((await e.apply([{ op: "renameProfile", from: "Рабочий", to: "Минимал" }])).ok, false, "имя встроенного занято");
    assert.strictEqual((await e.apply([{ op: "renameProfile", from: "Минимал", to: "Х" }])).ok, false, "встроенный не переименовать");
    assert.strictEqual((await e.apply([{ op: "renameProfile", from: "Рабочий", to: "__proto__" }])).ok, false);
    assert.deepStrictEqual(Object.keys(new DesignEngine(e.opts).profiles.list), ["Рабочий"], "переименование сохранено");
});

test("правка «по состоянию»: селектор с :hover проходит, страж видит корень и за состоянием", () => {
    assert.strictEqual(D.cleanSelector(".part.statusbar .statusbar-item:hover"), ".part.statusbar .statusbar-item:hover");
    assert.strictEqual(G.risky(".part.statusbar .statusbar-item:hover", "opacity", 0.1), "");
    assert.ok(G.risky("body:hover", "hide", true));
    assert.ok(G.risky(".monaco-workbench:not(.x):focus-within", "opacity", 0));
    assert.ok(G.risky(":root", "hide", true));
    assert.ok(G.risky(".part.editor:hover", "hide", true));
    assert.deepStrictEqual(G.lastCompounds(".a > .b:hover, html:focus-within"), [".b", "html"]);
});

test("перенос из Custom CSS and JS Loader: только локальные .css и .js, имена не сталкиваются", () => {
    const dir = fs.mkdtempSync(path.join(TMP, "legacy-"));
    const css = path.join(dir, "My Style.css"), js = path.join(dir, "tweak.js"), txt = path.join(dir, "note.txt"), big = path.join(dir, "big.css");
    fs.writeFileSync(css, "﻿.a{}", "utf8"); fs.writeFileSync(js, "1", "utf8"); fs.writeFileSync(txt, "x", "utf8");
    fs.writeFileSync(big, "x".repeat(300 * 1024), "utf8");
    const p = LI.plan([url.pathToFileURL(css).href, js, txt, big, "https://example.com/a.css", path.join(dir, "gone.css"), url.pathToFileURL(css).href, null],
        (id) => id === "custom-tweak.js");
    assert.deepStrictEqual(p.items.map((x) => [x.id, x.kind]), [["custom-my-style.css", "css"], ["custom-tweak-2.js", "js"], ["custom-my-style-2.css", "css"]]);
    assert.strictEqual(p.items[0].code, ".a{}", "BOM снят");
    assert.strictEqual(p.skipped.length, 5);
    assert.ok(p.skipped.some((s) => s.why === "не локальный файл") && p.skipped.some((s) => s.why === "файл не найден") && p.skipped.some((s) => /КБ/.test(s.why)));
    assert.deepStrictEqual(LI.plan(undefined).items, []);
    assert.strictEqual(LI.localPath("relative/a.css"), "");
});

test("копии сниппетов перед перезаписью: набор файлов, хранится пять последних", () => {
    const dir = fs.mkdtempSync(path.join(TMP, "snipbak-")), src = fs.mkdtempSync(path.join(TMP, "snipsrc-"));
    const a = path.join(src, "a.css"); fs.writeFileSync(a, ".a{}", "utf8");
    assert.strictEqual(BK.saveSnippets(dir, []), null);
    assert.strictEqual(BK.saveSnippets(dir, [path.join(src, "nope.css")]), null);
    const out = BK.saveSnippets(dir, [a, path.join(src, "nope.css")]);
    assert.strictEqual(fs.readFileSync(path.join(out, "a.css"), "utf8"), ".a{}");
    for (let i = 0; i < 8; i++) fs.mkdirSync(path.join(dir, "snippets-" + (1700000000000 + i)));
    BK.saveSnippets(dir, [a]);
    assert.strictEqual(fs.readdirSync(dir).filter((n) => /^snippets-/.test(n)).length, 5);
    assert.deepStrictEqual(BK.list(dir), [], "копии вида и копии сниппетов не путаются");
});

test("журнал: уровень errors пропускает в файл только записи с ошибкой, последние строки ведутся всегда", () => {
    const file = path.join(TMP, "level.log");
    LOG.setLogFile(file);
    try {
        assert.strictEqual(LOG.setLogLevel("чепуха"), "all");
        LOG.setLogLevel("errors");
        LOG.log("обычная строка-метка-1");
        LOG.log("сбой-метка-2", new Error("упало"));
        LOG.setLogLevel("off");
        LOG.log("тишина-метка-3", new Error("x"));
        LOG.flushFile();
        const text = fs.readFileSync(file, "utf8");
        assert.ok(!text.includes("метка-1") && text.includes("метка-2") && !text.includes("метка-3"));
        const ring = LOG.recentLog(10).join("\n");
        assert.ok(ring.includes("метка-1") && ring.includes("метка-3"), "отчёт Доктора видит всё");
    } finally { LOG.setLogLevel("all"); LOG.setLogFile(""); }
});
