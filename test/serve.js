// Тестовый стенд рантайма в браузере: http://127.0.0.1:8792/test/fixture.html
//
// Кроме статики поднимает НАСТОЯЩИЙ мост (lib/bridge.js) с фейковым хостом: конструктор и
// пипетка на макете сохраняют правки так же, как в VS Code (настройки — в памяти стенда).
// Boot-данные с каталогом и адресом моста — /test/boot.js.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const LIB = path.join(ROOT, "extension", "lib");
const D = require(path.join(LIB, "design"));
const C = require(path.join(LIB, "catalog"));
const S = require(path.join(LIB, "snippets"));
const P = require(path.join(LIB, "protocol"));
const { createBridge } = require(path.join(LIB, "bridge"));
const { DesignEngine } = require(path.join(LIB, "engine"));
const M = require(path.join(LIB, "modules"));
const { ModuleHub } = M;

const PORT = Number(process.env.PORT) || 8792;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

// ---- фейковый хост
const SNIPPETS = [
    { id: "a-base.css", kind: "css", enabled: true, code: ".part.sidebar { outline: 1px solid rgb(166, 227, 161); }" },
    { id: "btn.js", kind: "js", enabled: true, code: "mc.watch('.statusbar .right-items', function (bar) { mc.mount(bar, mc.el('div', { className: 'statusbar-item mc-test-btn', textContent: 'TERM' })); });" },
];
const settings = {};                                   // «settings.json» стенда: значения по умолчанию не заданы
// Контекст «окна» стенда; поменять: /test/ctx?lang=markdown
const CTX = { lang: "javascript", branch: "main", folder: "moon-core", theme: "dark" };
const DEFAULTS = {};
C.CATALOG.forEach((e) => e.settings.forEach((s) => { DEFAULTS[s.key] = s.type === "bool" ? true : s.type === "enum" ? s.options[0] : Math.max(s.min, Math.min(s.max, 12)); }));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mooncore-fixture-"));
const engine = new DesignEngine({
    designFile: path.join(TMP, "design.json"),
    profilesFile: path.join(TMP, "profiles.json"),
    config: {
        globalValue: (k) => settings[k],
        update: async (k, v) => { if (v === undefined) delete settings[k]; else settings[k] = v; },
    },
});
const log = [];
const settingsNow = () => Object.assign({}, DEFAULTS, settings);

function state() { engine.load(); return S.buildState(SNIPPETS, engine.stateExtra(settingsNow())); }

// ---- демо-модуль (test/fixture-module.js): события и запросы как у настоящего модуля
const hub = new ModuleHub({ broadcast: (e, d) => bridge.broadcast(e, d) });
// Настоящий модуль из папки: MOONCORE_MODULE=../vscode-bg node test/serve.js
// Его скрипт подключается следом за рантаймом (test/modules.js), ресурсы отдаются из /module/.
// (или node test/serve.js --module ../vscode-bg).
let extMod = null;
const argMod = process.argv.indexOf("--module") !== -1 ? process.argv[process.argv.indexOf("--module") + 1] : "";
const modDir = argMod || process.env.MOONCORE_MODULE || "";
if (modDir) {
    const r = M.fromFolder(path.resolve(modDir));
    if (!r.ok) { console.error("модуль: " + r.error); process.exit(1); }
    extMod = r.module;
}
const modRel = (abs) => path.relative(extMod.root, abs).split(path.sep).map(encodeURIComponent).join("/");
hub.setModules([{ id: "demo" }].concat(extMod ? [extMod] : []));
hub.api("demo").onRequest((method, body) => ({ method: method, twice: body && body.n * 2 }));
// Данные модулей стенда: в памяти + в TMP (как <globalStorage>/modules/<id>.json у настоящего хоста).
hub.dataDir = path.join(TMP, "modules");

async function dispatch(method, body) {
    log.push([method, body]);
    if (method === "module") return hub.dispatch(body);
    if (method === "moduleData") return hub.saveFromWindow(body);
    if (method === "focus") return { ok: true, focused: true };   // у стенда одно «окно», оно и в фокусе
    if (method === "context") return Object.assign({ ok: true }, CTX);
    if (method === "pickCommand") return { ok: true, command: "workbench.action.terminal.toggleTerminal", title: "Терминал", icon: "terminal" };
    if (method === "uiClick") return { ok: true };
    if (method === "native") return { ok: true, result: null };
    if (method === "command") return { ok: true, result: null };
    if (method === "design") {
        const r = await engine.apply(Array.isArray(body.ops) ? body.ops : []);
        const st = state();
        bridge.broadcast("state", st);
        (r.applied || []).forEach((a) => { if (Object.keys(a.modules).length) bridge.broadcast("profile", a); });
        return { ok: r.ok, error: r.error, design: st.design, settingsNow: st.settingsNow, profiles: st.profiles };
    }
    if (method === "picked" && body.action === "hide") return dispatch("design", { ops: [{ op: "set", selector: body.selector, prop: "hide", value: true, label: body.info && body.info.label }] });
    return { ok: true };
}

const bridge = createBridge({
    file: path.join(os.tmpdir(), "mooncore-fixture-bridge.json"),
    dispatch: dispatch,
    hello: () => [{ event: "state", data: state() }, { event: "focus", data: { focused: true } }, { event: "ctx", data: CTX }].concat(hub.hello()),
    isFocused: () => true,
    origin: "http://localhost:" + PORT,
});

// ---- HTTP
http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url || "/").split("?")[0]);
    if (rel === "/test/boot.js") {
        const boot = { v: P.VERSION, version: "fixture", proto: P.PROTOCOL, state: state(), testHosts: [{ port: bridge.port, token: bridge.token }],
            modules: [{ id: "demo", name: "Демо", version: "1", base: "http://localhost:" + PORT + "/test/", data: hub.readData("demo") }].concat(extMod ? [{
                id: extMod.id, name: extMod.name, version: extMod.version, data: hub.readData(extMod.id),
                base: ("http://localhost:" + PORT + "/module/" + modRel(extMod.assets)).replace(/\/?$/, "/"),
            }] : []) };
        res.writeHead(200, { "Content-Type": TYPES[".js"], "Cache-Control": "no-store" });
        res.end("window.__MOONCORE_BOOT__ = " + JSON.stringify(boot) + ";");
        return;
    }
    if (rel === "/test/modules.js") {
        // Как в оболочке VS Code: метка начала, файл модуля (с защитой запуска первой строкой), метка конца.
        const mark = (fn) => "<script>window.__MOONCORE__&&window.__MOONCORE__." + fn + "&&window.__MOONCORE__." + fn + "(\"" + extMod.id + "\")</scr" + "ipt>";
        const tag = extMod ? mark("_modStart") + "<script src=\"/test/modfile.js\" data-mooncore-module=\"" + extMod.id + "\"></scr" + "ipt>" + mark("_modDone") : "";
        res.writeHead(200, { "Content-Type": TYPES[".js"], "Cache-Control": "no-store" });
        res.end(tag ? "document.write(" + JSON.stringify(tag) + ");" : "");
        return;
    }
    if (extMod && rel === "/test/modfile.js") {
        const W = require(path.join(LIB, "wb-patch"));
        res.writeHead(200, { "Content-Type": TYPES[".js"], "Cache-Control": "no-store" });
        res.end(W.moduleFileContent(extMod.id, fs.readFileSync(extMod.script, "utf8")));
        return;
    }
    if (extMod && rel.startsWith("/module/")) {
        const f = M.inside(extMod.root, rel.slice("/module/".length));
        if (!f) { res.writeHead(404); res.end("not found"); return; }
        fs.readFile(f, (err, data) => {
            if (err) { res.writeHead(404); res.end("not found"); return; }
            const ext = path.extname(f).toLowerCase();
            const type = TYPES[ext] || ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" })[ext] || "application/octet-stream";
            res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
            res.end(data);
        });
        return;
    }
    if (rel === "/test/publish") {   // /test/publish?module=demo&event=live&scope=window&data={"a":1}
        const q = new URL(req.url, "http://x").searchParams;
        try { hub.api(q.get("module") || "demo").publish(q.get("event") || "live", JSON.parse(q.get("data") || "null"), { scope: q.get("scope") || "all" }); res.writeHead(200); res.end("ok"); }
        catch (e) { res.writeHead(400); res.end(String(e.message)); }
        return;
    }
    if (rel === "/test/ctx") {
        const q = new URL(req.url, "http://x").searchParams;
        ["lang", "branch", "folder", "theme"].forEach((k) => { if (q.has(k)) CTX[k] = q.get(k); });
        bridge.broadcast("ctx", CTX);
        res.writeHead(200); res.end(JSON.stringify(CTX));
        return;
    }
    if (rel === "/test/log") {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ log: log.slice(-50), design: engine.design, settings: settings, profiles: engine.summary() }));
        return;
    }
    const file = path.join(ROOT, rel === "/" ? "test/fixture.html" : rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end("not found"); return; }
        res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
        res.end(data);
    });
}).listen(PORT, "127.0.0.1", () => bridge.ready.then(() => console.log("fixture: http://localhost:" + PORT + "/test/fixture.html, мост 127.0.0.1:" + bridge.port + (extMod ? ", модуль " + extMod.id + " из " + extMod.root : ""))));
