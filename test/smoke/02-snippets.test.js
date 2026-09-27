// Смоук-тесты Moon Core: Сниппеты.
"use strict";
const { test, assert, fs, os, path, http, EXT, TMP, W, S, P, createBridge, readHosts, D, C, DesignEngine, M, K, CMD, B, AP, D2, E2,
    BASE_HTML, CSP, request, makeEngine, makeModuleDir } = require("./harness");

// ------------------------------------------------------------------ сниппеты
test("сниппеты: список, фильтр имён, лимит размера, выключение", () => {
    const dir = path.join(TMP, "snippets");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "b.css"), "﻿body{color:red}");
    fs.writeFileSync(path.join(dir, "a.js"), "mc.log(1)");
    fs.writeFileSync(path.join(dir, "..evil.css"), "x");
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");
    fs.writeFileSync(path.join(dir, "big.css"), "a".repeat(P.MAX_SNIPPET + 1));
    let list = S.listSnippets(dir, { disabled: [] });
    assert.deepStrictEqual(list.map((s) => s.id), ["a.js", "b.css", "big.css"]);
    assert.strictEqual(list[1].code, "body{color:red}");       // BOM снят
    assert.ok(list[2].error);
    let st = S.buildState(list);
    assert.deepStrictEqual(st.snippets.map((s) => s.id), ["a.js", "b.css"]);
    list = S.listSnippets(dir, { disabled: ["a.js"] });
    const st2 = S.buildState(list);
    assert.deepStrictEqual(st2.snippets.map((s) => s.id), ["b.css"]);
    assert.notStrictEqual(st.rev, st2.rev);
});

test("сниппеты: meta, writeState пишет только при изменении", () => {
    const meta = path.join(TMP, "meta.json");
    S.writeMeta(meta, { disabled: ["x.css", "x.css", "../bad.css"] });
    assert.deepStrictEqual(S.readMeta(meta).disabled, ["x.css"]);
    assert.deepStrictEqual(S.readMeta(path.join(TMP, "nope.json")).disabled, []);
    const f = path.join(TMP, "state.json");
    const st = S.buildState([{ id: "a.css", kind: "css", enabled: true, code: "a{}" }]);
    assert.strictEqual(S.writeState(f, st), true);
    assert.strictEqual(S.writeState(f, st), false);
});

test("сниппеты: freeId", () => {
    const dir = path.join(TMP, "snippets2");
    fs.mkdirSync(dir, { recursive: true });
    assert.strictEqual(S.freeId(dir, "My Style!", "css"), "my-style.css");
    fs.writeFileSync(path.join(dir, "my-style.css"), "");
    assert.strictEqual(S.freeId(dir, "My Style!", "css"), "my-style-2.css");
});
