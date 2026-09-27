// Смоук-тесты Moon Core: Манифест и рантайм.
"use strict";
const { test, assert, fs, os, path, http, EXT, TMP, W, S, P, createBridge, readHosts, D, C, DesignEngine, M, K, CMD, B, AP, D2, E2,
    BASE_HTML, CSP, request, makeEngine, makeModuleDir } = require("./harness");

// ------------------------------------------------------------------ манифест и рантайм
test("манифест: каждая команда зарегистрирована, и наоборот", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(EXT, "package.json"), "utf8"));
    const declared = pkg.contributes.commands.map((c) => c.command).sort();
    const src = fs.readFileSync(path.join(EXT, "extension.js"), "utf8");
    const registered = Array.from(src.matchAll(/reg\("([\w.]+)"/g)).map((m) => m[1]).sort();
    assert.deepStrictEqual(registered, declared);
    assert.strictEqual(pkg.scripts["vscode:uninstall"], "node ./uninstall.js");
    assert.ok(fs.existsSync(path.join(EXT, pkg.contributes.viewsContainers.activitybar[0].icon)));
});

test("рантайм: протокол из boot совпадает с методами хоста", () => {
    const read = (n) => fs.readFileSync(path.join(EXT, "runtime", n), "utf8");
    // Полная сборка и ленивая (ядро + чанк интерфейса) вместе используют весь протокол.
    const rt = read("mooncore-runtime.js") + read("mooncore-core.js");
    P.METHODS.forEach((m) => assert.ok(rt.includes("\"" + m + "\""), "рантайм не использует метод " + m));
    P.EVENTS.forEach((e) => assert.ok(rt.includes("\"" + e + "\""), "рантайм не слушает событие " + e));
    ["mooncore-runtime.js", "mooncore-core.js", "mooncore-ui.js"].forEach((n) => new Function(read(n)));   // парсятся
});
