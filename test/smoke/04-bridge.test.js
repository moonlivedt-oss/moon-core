// Смоук-тесты Moon Core: Мост окно <-> хост.
"use strict";
const { test, assert, fs, os, path, http, EXT, TMP, W, S, P, createBridge, readHosts, D, C, DesignEngine, M, K, CMD, B, AP, D2, E2,
    BASE_HTML, CSP, request, makeEngine, makeModuleDir } = require("./harness");

// ------------------------------------------------------------------ мост

test("мост: безопасность, rpc, поток событий, уборка", async () => {
    const file = path.join(TMP, "bridge.json");
    let focused = true;
    const calls = [];
    const b = createBridge({
        file: file,
        dispatch: async (m, body) => { calls.push([m, body]); return { ok: true, echo: body.x }; },
        hello: () => [{ event: "state", data: { rev: "r1", snippets: [] } }],
        isFocused: () => focused,
    });
    await b.ready;
    const port = b.port, tok = b.token;
    const hosts = readHosts(file);
    assert.strictEqual(hosts.length, 1);
    assert.strictEqual(hosts[0].port, port);

    const post = (method, body, headers) => request(port, { method: "POST", path: "/rpc/" + tok + "/" + method, headers: Object.assign({ "Content-Type": "application/json", "Origin": "vscode-file://vscode-app" }, headers || {}) }, body);

    assert.strictEqual((await request(port, { path: "/ping/" + "0".repeat(48) })).status, 403);
    assert.strictEqual((await request(port, { path: "/ping/" + tok })).status, 200);
    assert.strictEqual((await request(port, { path: "/ping/" + tok, headers: { Origin: "https://evil.example" } })).status, 403);
    assert.strictEqual((await request(port, { path: "/ping/" + tok, headers: { Host: "localhost:" + port } })).status, 403);
    assert.strictEqual((await request(port, { method: "OPTIONS", path: "/rpc/" + tok + "/log" })).status, 204);

    const r1 = await post("log", JSON.stringify({ x: 5 }));
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(JSON.parse(r1.body).echo, 5);
    assert.strictEqual((await post("nope", "{}")).status, 404);
    assert.strictEqual((await post("log", "not json")).status, 400);
    assert.strictEqual((await post("log", "[1]")).status, 400);
    assert.strictEqual((await post("log", JSON.stringify({ big: "a".repeat(P.MAX_BODY + 10) }))).status, 413);
    focused = false;
    assert.strictEqual((await post("command", JSON.stringify({ id: "x" }))).status, 409);
    focused = true;
    assert.strictEqual((await post("command", JSON.stringify({ id: "x" }))).status, 200);

    // Поток: сначала приветствие, потом рассылка.
    const events = await new Promise((resolve, reject) => {
        const got = [];
        const req = http.get({ host: "127.0.0.1", port: port, path: "/events/" + tok }, (res) => {
            assert.strictEqual(res.headers["content-type"].indexOf("text/event-stream"), 0);
            let buf = "";
            res.on("data", (c) => {
                buf += c;
                const parts = buf.split("\n\n"); buf = parts.pop();
                parts.forEach((p) => {
                    const ev = (p.match(/^event: (.+)$/m) || [])[1];
                    const data = p.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
                    if (ev) got.push([ev, JSON.parse(data)]);
                    if (got.length === 1) b.broadcast("preview", { id: "a.css", code: "a{}\nb{}" });
                    if (got.length === 2) { req.destroy(); resolve(got); }
                });
            });
        });
        req.on("error", (e) => { if (e.code !== "ECONNRESET") reject(e); });
    });
    assert.deepStrictEqual(events[0], ["state", { rev: "r1", snippets: [] }]);
    assert.deepStrictEqual(events[1], ["preview", { id: "a.css", code: "a{}\nb{}" }]);

    b.dispose();
    assert.strictEqual(readHosts(file).length, 0);
    assert.strictEqual(calls.filter((c) => c[0] === "command").length, 1);
});

test("мост: порт из диапазона CSP, лимит частоты, файл адресов только для владельца", async () => {
    const file = path.join(TMP, "bridge-lim.json");
    const b = createBridge({ file: file, dispatch: async () => ({ ok: true }) });
    await b.ready;
    assert.ok(P.BRIDGE_PORT_FIRST <= b.port && b.port < P.BRIDGE_PORT_FIRST + P.BRIDGE_PORT_COUNT, "порт " + b.port + " — из диапазона, разрешённого в CSP");
    // Второй мост (второе окно VS Code) берёт следующий свободный порт диапазона.
    const b2 = createBridge({ file: path.join(TMP, "bridge-lim2.json"), dispatch: async () => ({ ok: true }) });
    await b2.ready;
    assert.ok(b2.port !== b.port && b2.port < P.BRIDGE_PORT_FIRST + P.BRIDGE_PORT_COUNT);
    b2.dispose();
    const post = () => request(b.port, { method: "POST", path: "/rpc/" + b.token + "/log", headers: { "Content-Type": "application/json", "Origin": "vscode-file://vscode-app" } }, "{}");
    let last = 0;
    for (let i = 0; i < P.RPC_LIMIT_PER_10S + 5; i++) last = (await post()).status;
    assert.strictEqual(last, 429, "поток запросов сверх лимита отклоняется");
    assert.ok(b.status().rejected >= 5);
    if (process.platform !== "win32") assert.strictEqual(fs.statSync(file).mode & 0o077, 0, "файл с токенами — только владельцу");
    b.dispose();
});

test("модули: запрос окна через настоящий мост", async () => {
    const hub = new M.ModuleHub({ broadcast: () => {} });
    hub.setModules([{ id: "mlbg" }]);
    hub.api("mlbg").onRequest((method, body) => ({ got: body.n * 2 }));
    const b = createBridge({ file: path.join(TMP, "bridge-mod.json"), dispatch: (m, body) => (m === "module" ? hub.dispatch(body) : { ok: false }), isFocused: () => false });
    await b.ready;
    const res = await request(b.port, { method: "POST", path: "/rpc/" + b.token + "/module", headers: { "Content-Type": "application/json", "Origin": "vscode-file://vscode-app" } },
        JSON.stringify({ id: "mlbg", method: "double", body: { n: 21 } }));
    b.dispose();
    assert.strictEqual(res.status, 200, "module не требует фокуса окна");
    assert.deepStrictEqual(JSON.parse(res.body), { ok: true, result: { got: 42 } });
});
