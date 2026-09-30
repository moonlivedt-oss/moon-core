// Смоук-тесты Moon Core: Оболочка: блок, CSP, запись, контрольные суммы, чужие вставки.
"use strict";
const { test, assert, fs, os, path, http, EXT, TMP, W, S, P, createBridge, readHosts, D, C, DesignEngine, M, K, CMD, B, AP, D2, E2,
    BASE_HTML, CSP, request, makeEngine, makeModuleDir } = require("./harness");

test("патч: блок вставляется перед </head> и один раз", () => {
    const block = W.buildBlock({ a: 1 }, "console.log(1)", { nonce: "abcDEF12", version: "0.1.0" });
    const once = W.applyBlock(BASE_HTML, block);
    const twice = W.applyBlock(once, block);
    assert.strictEqual(once, twice);
    assert.strictEqual(once.split(W.WB_START).length - 1, 1);
    assert.ok(once.indexOf(W.WB_END) < once.indexOf("</head>"));
    assert.ok(W.isInjected(once));
});

test("патч: чужие блоки (custom-css, cpp-docs) не тронуты, снятие возвращает оригинал", () => {
    const block = W.buildBlock({}, "1", { nonce: "abcDEF12", version: "1" });
    const html = W.applyBlock(BASE_HTML, block);
    assert.ok(html.includes("/*custom-css*/") && html.includes("/*cppdocs*/"));
    assert.strictEqual(W.stripBlock(html), BASE_HTML);
});

test("патч: blockInfo читает версию, sha рантайма и nonce", () => {
    const html = W.applyBlock(BASE_HTML, W.buildBlock({}, "rt()", { nonce: "abcDEF12", version: "0.1.0" }));
    const info = W.blockInfo(html);
    assert.strictEqual(info.version, "0.1.0");
    assert.strictEqual(info.sha, W.sha256("rt()"));
    assert.strictEqual(info.nonce, "abcDEF12");
    assert.strictEqual(W.blockInfo(BASE_HTML), null);
});

test("патч: CSP — добавляем только свой nonce и снимаем только его", () => {
    const html = BASE_HTML.replace("<meta charset=\"utf-8\" />", CSP);
    let out = W.applyBlock(html, W.buildBlock({}, "1", { nonce: "MINE0001", version: "1" }));
    out = W.armCsp(out, "MINE0001", "");
    assert.ok(out.includes("'nonce-MINE0001'"));
    assert.ok(out.includes("'nonce-OTHER123'"));
    assert.ok(out.includes("connect-src 'self'" + W.CONNECT_ADD), "в CSP — только порты моста");
    assert.ok(!out.includes("127.0.0.1:*"), "не «любой порт»");
    // Повторное внедрение с новым nonce не копит старые.
    let again = W.applyBlock(out, W.buildBlock({}, "1", { nonce: "MINE0002", version: "1" }));
    again = W.armCsp(again, "MINE0002", "MINE0001");
    assert.ok(!again.includes("MINE0001") && again.includes("'nonce-MINE0002'"));
    assert.strictEqual(again.split(W.CONNECT_ADD).length - 1, 1, "порты не дублируются");
    const stripped = W.stripBlock(again);
    assert.ok(!stripped.includes("MINE0002") && stripped.includes("'nonce-OTHER123'"));
    assert.strictEqual(stripped, html, "после снятия CSP — ровно исходный");
    // Старая версия добавляла «любой порт» — заменяется на порты моста. Но если в оболочке окно
    // cpp-docs-panel, «любой порт» — адрес его моста: остаётся.
    const anyPort = html.replace("connect-src 'self'", "connect-src 'self' http://127.0.0.1:*");
    const withDocs = W.armCsp(anyPort, "MINE0003", "");
    assert.ok(withDocs.includes("127.0.0.1:*") && withDocs.includes(W.CONNECT_ADD), "мост cpp-docs не отрезан");
    const noDocs = anyPort.replace(/<!-- CPPDOCS-WINDOW-START -->[\s\S]*?<!-- CPPDOCS-WINDOW-END -->/, "");
    const legacy = W.armCsp(noDocs, "MINE0003", "");
    assert.ok(!legacy.includes("127.0.0.1:*") && legacy.includes(W.CONNECT_ADD));
});

test("патч: без CSP ничего не навязываем", () => {
    assert.strictEqual(W.armCsp(BASE_HTML, "X1234567", ""), BASE_HTML);
});

test("патч: </script> и <!-- внутри рантайма и данных не закрывают тег", () => {
    const block = W.buildBlock({ s: "</script><!--" + String.fromCharCode(0x2028) }, "var a='</script>';", { nonce: "", version: "1" });
    const inner = block.slice(block.indexOf("\n") + 1, block.lastIndexOf(W.WB_END));
    assert.strictEqual((inner.match(/<\/script>/g) || []).length, 2);   // только наши два закрывающих тега
    assert.ok(!inner.includes(String.fromCharCode(0x2028)));
});

test("патч: атомарная запись и unpatchFile", () => {
    const dir = path.join(TMP, "out", "vs", "code", "electron-browser", "workbench");
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, "workbench.html");
    fs.writeFileSync(f, W.applyBlock(BASE_HTML, W.buildBlock({}, "1", { nonce: "abcDEF12", version: "1" })));
    assert.deepStrictEqual(W.findWorkbenchIn(path.join(TMP, "out"), 6), [f]);
    assert.strictEqual(W.unpatchFile(f), true);
    assert.strictEqual(fs.readFileSync(f, "utf8"), BASE_HTML);
    assert.strictEqual(W.unpatchFile(f), false);
    assert.ok(!fs.existsSync(f + W.TMP_EXT));
});

test("патч: чужой workbench.html (не electron-browser) не находится", () => {
    const d = path.join(TMP, "other", "workbench");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "workbench.html"), "x");
    assert.deepStrictEqual(W.findWorkbenchIn(path.join(TMP, "other"), 6), []);
});


test("контрольная сумма: хэш как в product.json, формат файла сохраняется, возврат из бэкапа", () => {
    const d = fs.mkdtempSync(path.join(TMP, "app-"));
    const out = path.join(d, "out"), wbDir = path.join(out, "vs", "code", "electron-browser", "workbench");
    fs.mkdirSync(wbDir, { recursive: true });
    const wb = path.join(wbDir, "workbench.html");
    fs.writeFileSync(wb, "<html>patched</html>");
    const key = W.checksumKey(out, wb);
    assert.strictEqual(key, "vs/code/electron-browser/workbench/workbench.html");
    const sum = W.productChecksum(Buffer.from("<html>patched</html>"));
    assert.ok(!/=/.test(sum) && sum.length === 43, "base64 без «=»");
    const orig = '{\n\t"nameShort": "Code",\n\t"checksums": {\n\t\t"' + key + '": "ORIGINAL",\n\t\t"vs/other.js": "KEEP"\n\t}\n}\n';
    const next = W.setChecksumText(orig, key, sum);
    assert.ok(next.indexOf('"' + key + '": "' + sum + '"') !== -1 && next.indexOf('"KEEP"') !== -1 && next.indexOf("\t\t") !== -1, "поменялась только наша запись");
    assert.strictEqual(W.setChecksumText(next, key, sum), null, "уже верный — нечего писать");
    assert.strictEqual(W.setChecksumText(orig, "vs/nope.html", sum), null, "записи нет — не трогаем");
    assert.strictEqual(W.checksumMatches(next, key, sum), true);
    fs.writeFileSync(path.join(d, "product.json"), next);
    fs.writeFileSync(path.join(d, "product.json" + W.BAK_EXT), orig);
    assert.strictEqual(W.restoreChecksum(d, key), true);
    assert.strictEqual(fs.readFileSync(path.join(d, "product.json"), "utf8"), orig, "при снятии — ровно исходный файл");
});

test("контрольная сумма: бэкап product.json от прошлой сборки VS Code не используется", () => {
    const d = fs.mkdtempSync(path.join(TMP, "app-"));
    const key = "vs/code/electron-browser/workbench/workbench.html";
    const prod = path.join(d, "product.json");
    const now = JSON.stringify({ commit: "new", checksums: { [key]: "NEW" } });
    fs.writeFileSync(prod, now);
    fs.writeFileSync(prod + W.BAK_EXT, JSON.stringify({ commit: "old", checksums: { [key]: "OLD" } }));
    assert.strictEqual(W.productBackup(prod), null);
    assert.strictEqual(W.restoreChecksum(d, key), false, "хэш старой сборки не вписывается");
    assert.strictEqual(fs.readFileSync(prod, "utf8"), now);
    fs.writeFileSync(prod + W.BAK_EXT, JSON.stringify({ commit: "new", checksums: { [key]: "ORIG" } }));
    assert.ok(W.productBackup(prod), "бэкап этой же сборки годится");
});

test("следы старого загрузчика: пустая пара Custom CSS убирается, непустая остаётся", () => {
    const empty = "a\n<!-- !! VSCODE-CUSTOM-CSS-SESSION-ID 1-2 !! -->\n<!-- !! VSCODE-CUSTOM-CSS-START !! -->\n<!-- !! VSCODE-CUSTOM-CSS-END !! -->\nb";
    assert.ok(W.hasLegacyLeftovers(empty));
    assert.strictEqual(W.stripLegacyLeftovers(empty), "a\nb");
    assert.ok(!W.hasLegacyLeftovers(BASE_HTML), "блок с содержимым — живой загрузчик");
    assert.strictEqual(W.stripLegacyLeftovers(BASE_HTML), BASE_HTML);
    // Скрипт-значок выключенного загрузчика (ведёрко в статусбаре) — тоже след; у живого загрузчика не трогаем.
    const ind = "\t<script>/* eslint-env browser */\r\n(function () {\r\n\te.className = \"statusbar-item right __CUSTOM_CSS_JS_INDICATOR_CLS\";\r\n})();\r\n</script>\n";
    const tail = "<head></head>\n<body>\n" + ind + "</body>\n<script src=\"./workbench.js\" type=\"module\"></script>";
    assert.ok(W.hasLegacyLeftovers(tail));
    assert.strictEqual(W.stripLegacyLeftovers(tail), "<head></head>\n<body>\n</body>\n<script src=\"./workbench.js\" type=\"module\"></script>");
    const live = BASE_HTML.replace("<body></body>", "<body>" + ind + "</body>");
    assert.ok(!W.hasLegacyLeftovers(live));
    assert.strictEqual(W.stripLegacyLeftovers(live), live, "рядом живой блок загрузчика — значок его");
    const two = "<script>keep()</script>\n" + ind + "<script>keep2()</script>";
    assert.strictEqual(W.stripLegacyLeftovers(two), "<script>keep()</script>\n<script>keep2()</script>", "соседние скрипты целы");
});

test("окно сессий: находится только по флагу", () => {
    const d = fs.mkdtempSync(path.join(TMP, "sess-"));
    const wbDir = path.join(d, "vs", "code", "electron-browser", "workbench"), sDir = path.join(d, "vs", "sessions", "electron-browser");
    fs.mkdirSync(wbDir, { recursive: true }); fs.mkdirSync(sDir, { recursive: true });
    fs.writeFileSync(path.join(wbDir, "workbench.html"), "x"); fs.writeFileSync(path.join(sDir, "sessions.html"), "x");
    assert.strictEqual(W.findWorkbenchIn(d, 6).length, 1);
    assert.strictEqual(W.findWorkbenchIn(d, 6, true).length, 2);
});

test("целостность и чужие вставки: integrity у файла модуля, имена чужих блоков", () => {
    const content = W.moduleFileContent("mlbg", "bg()");
    const sri = W.sriHash(content);
    assert.ok(/^sha256-[A-Za-z0-9+/]{43}=$/.test(sri));
    const html = W.applyBlock(BASE_HTML, W.buildBlock({}, "rt()", { nonce: "abcDEF12", version: "1", modules: [{ id: "mlbg", code: "bg()", file: W.moduleFileName("mlbg"), integrity: sri }] }));
    assert.ok(html.indexOf('src="mooncore-mod-mlbg.js" integrity="' + sri + '"') !== -1);
    assert.deepStrictEqual(W.foreignBlocks(W.stripBlock(html)), ["VSCODE-CUSTOM-CSS", "CPPDOCS-WINDOW"], "наш блок не считается чужим");
    assert.deepStrictEqual(W.foreignBlocks("<head><!-- !! VSCODE-CUSTOM-CSS-START !! --><!-- !! VSCODE-CUSTOM-CSS-END !! --></head>"), [], "пустая пара — не вставка");
    assert.deepStrictEqual(W.foreignBlocks('<script src="external.js"></script>'), ["Custom UI Style"]);
});
