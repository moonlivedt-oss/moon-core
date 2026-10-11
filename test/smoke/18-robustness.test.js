// Смоук-тесты Moon Core: надёжность второго круга — мост под нагрузкой, уборка модулей, сверка
// записи оболочки, файл журнала, счётчики ошибок, таблица RPC и фаззинг разборщиков.
"use strict";
const { test, withVscode, assert, fs, path, http, EXT, TMP, P, createBridge, D, B, E2, M, request } = require("./harness");

const LOG = require(path.join(EXT, "lib", "log"));
const PR = require(path.join(EXT, "lib", "project"));
const DM = require(path.join(EXT, "lib", "doctor-model"));
const { MAX_BUFFERED, OWN_BUCKET } = require(path.join(EXT, "lib", "bridge"));

test("мост: окно, которое не читает поток, отключается, а не копит память хоста", async () => {
    const b = createBridge({ dispatch: async () => ({ ok: true }), ports: [0] });
    await b.ready;
    let req;
    await new Promise((resolve) => {
        req = http.get({ host: "127.0.0.1", port: b.port, path: "/events/" + b.token, agent: false }, (res) => { res.pause(); resolve(); });
    });
    const big = "x".repeat(512 * 1024);
    for (let i = 0; i < 2 * MAX_BUFFERED / big.length + 40 && b.status().streams; i++) {
        b.broadcast("state", big);
        await new Promise((r) => setImmediate(r));
    }
    const st = b.status();
    assert.strictEqual(st.streams, 0, "поток отключён");
    assert.ok(st.dropped >= 1);
    req.destroy();
    b.dispose();
});

test("мост: у журнала окна своя корзина лимита — поток ошибок не блокирует конструктор", async () => {
    const b = createBridge({ dispatch: async () => ({ ok: true }), ports: [0] });
    await b.ready;
    const post = (method) => request(b.port, { method: "POST", path: "/rpc/" + b.token + "/" + method, headers: { "Content-Type": "application/json" } }, "{}");
    const codes = [];
    for (let i = 0; i < OWN_BUCKET.log + 5; i++) codes.push((await post("log")).status);
    assert.strictEqual(codes.filter((c) => c === 429).length, 5, "лишние log отклонены");
    assert.strictEqual((await post("design")).status, 200, "конструктор работает");
    const st = b.status();
    assert.strictEqual(st.byMethod.log, OWN_BUCKET.log);
    assert.strictEqual(st.byMethod.design, 1);
    assert.strictEqual(st.rejected, 5);
    b.dispose();
});

test("модули: выключенный модуль уходит из кэша событий, хост убирает его элементы", () => {
    const sent = [];
    const hub = new M.ModuleHub({ broadcast: (e, d) => sent.push(d) });
    const removed = [];
    hub.onRemoved = (ids) => removed.push(...ids);
    hub.setModules([{ id: "aa" }, { id: "bb" }]);
    hub.publish("aa", "live", { x: 1 });
    hub.publish("bb", "live", { x: 2 });
    assert.strictEqual(hub.hello().length, 2);
    assert.deepStrictEqual(hub.setModules([{ id: "bb" }]), ["aa"]);
    assert.deepStrictEqual(removed, ["aa"]);
    assert.deepStrictEqual(hub.hello().map((h) => h.data.id), ["bb"], "новое окно не получит события выключенного модуля");
});

test("внедрение: после записи файлы сверяются; не совпало — откат всего плана", () => withVscode(() => {
    const PL = require(path.join(EXT, "lib", "inject", "plan"));
    const dir = fs.mkdtempSync(path.join(TMP, "verify-"));
    const a = path.join(dir, "workbench.html"), b2 = path.join(dir, "mooncore-mod-x.js");
    fs.writeFileSync(a, "СТАРОЕ");
    const orig = fs.readFileSync;
    // Кто-то (антивирус, чужой загрузчик) подменил файл сразу после записи.
    fs.readFileSync = function (f, enc) { if (f === a && enc === "utf8") return "ПОДМЕНА"; return orig.apply(fs, arguments); };
    let err = null;
    try { PL.execPlan([{ file: a, data: "НОВОЕ", atomic: true }, { file: b2, data: "мод" }]); } catch (e) { err = e; }
    finally { fs.readFileSync = orig; }
    assert.ok(err && err.code === "EVERIFY", String(err));
    assert.strictEqual(fs.readFileSync(a, "utf8"), "СТАРОЕ", "откат");
    assert.ok(!fs.existsSync(b2), "новый файл убран");
    PL.execPlan([{ file: a, data: "НОВОЕ", atomic: true }]);
    assert.strictEqual(fs.readFileSync(a, "utf8"), "НОВОЕ", "без подмены — записано");
}));

test("журнал: файл в хранилище с ротацией, секреты и домашняя папка вырезаны", () => {
    const dir = fs.mkdtempSync(path.join(TMP, "log-"));
    const f = path.join(dir, "mooncore.log");
    LOG.setLogFile(f);
    try {
        LOG.log("пароль password=hunter22 в " + require("os").homedir());
        LOG.flushFile();
        const text = fs.readFileSync(f, "utf8");
        assert.ok(/password=<секрет>/.test(text) && text.indexOf("hunter22") === -1 && text.indexOf(require("os").homedir()) === -1, text);
        const chunk = "y".repeat(2000);
        // Строки разные: одинаковые подряд журнал сводит в одну (см. тест ниже).
        for (let i = 0; i < 700; i++) { LOG.log(i + " " + chunk); if (i % 100 === 99) LOG.flushFile(); }
        LOG.flushFile();
        assert.ok(fs.existsSync(f + ".1"), "старый файл ушёл в .1");
        assert.ok(fs.statSync(f).size <= 1024 * 1024, "текущий не больше 1 МБ");
    } finally { LOG.setLogFile(""); }
});

test("журнал: повторы подряд сводятся в одну строку со счётчиком, ротация считает байты", () => {
    const dir = fs.mkdtempSync(path.join(TMP, "log-rep-"));
    const f = path.join(dir, "mooncore.log");
    LOG.setLogFile(f);
    try {
        for (let i = 0; i < 50; i++) LOG.log("модули: mlbg: такой id уже есть");
        LOG.log("другая запись");
        LOG.flushFile();
        const text = fs.readFileSync(f, "utf8");
        assert.strictEqual(text.split("такой id уже есть").length - 1, 1, text);
        assert.ok(/повторилась ещё 49 раз/.test(text), text);
        assert.ok(text.indexOf("повторилась") < text.indexOf("другая запись"), "счётчик — до следующей записи");
        // Кириллица: 600 000 символов — 1,2 МБ в UTF-8, файл должен уйти в .1 по байтам.
        const ru = "я".repeat(3000);
        for (let i = 0; i < 200; i++) { LOG.log(i + ru); if (i % 50 === 49) LOG.flushFile(); }
        LOG.flushFile();
        assert.ok(fs.existsSync(f + ".1"), "ротация по байтам");
        assert.ok(fs.statSync(f).size <= 1024 * 1024 + 8192, "текущий около 1 МБ, а не 2");
    } finally { LOG.setLogFile(""); }
});

test("хост: таблица RPC покрывает ровно методы протокола; счётчики ошибок окна по источникам", () => withVscode(() => {
    const { Host } = require(path.join(EXT, "lib", "host"));
    const h = Object.create(Host.prototype);
    assert.deepStrictEqual(Object.keys(h.rpcTable()).sort(), P.METHODS.slice().sort());
    h.errorsShown = new Set();
    h.state = { rev: "r" };
    for (let i = 0; i < 25; i++) h.onWindowLog({ where: "модуль mlbg: событие live", msg: "boom" });
    h.onWindowLog({ where: "CSS", msg: "x" });
    const top = h.errorTop(5);
    assert.deepStrictEqual(top.map((t) => [t.source, t.n]), [["модуль mlbg", 25], ["CSS", 1]]);
    for (let i = 0; i < 100; i++) h.countError("источник " + i);
    assert.ok(h.errorCounts.size <= 64, "источников не больше 64");
    const probs = DM.problems({ shells: [], bridge: { running: true, dropped: 2 }, errors: top });
    assert.ok(probs.some((p) => /Часто падает: модуль mlbg \(25\)/.test(p.title)) && probs.some((p) => /зависших окон: 2/.test(p.title)));
}));

// ------------------------------------------------------------------ фаззинг разборщиков

/** Детерминированный генератор (mulberry32): падение воспроизводится по номеру прогона. */
function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const NASTY = ["}", "{", ";", "/*", "*/", "<\/style>", "@import", "\\", "\n", "\"", "'", "(", ")", "[", "]", "#fff", ".part.sidebar", "__proto__", "constructor", "hide", "fontSize", "Минимал", " ", "a".repeat(700)];
function randValue(r, depth) {
    const k = Math.floor(r() * (depth > 3 ? 5 : 8));
    if (k === 0) return null;
    if (k === 1) return r() < 0.5;
    if (k === 2) return Math.floor((r() - 0.3) * 5000) / 10;
    if (k === 3 || k === 4) return r() < 0.6 ? NASTY[Math.floor(r() * NASTY.length)] : r().toString(36).slice(2, 2 + Math.floor(r() * 12));
    if (k === 5) return Array.from({ length: Math.floor(r() * 4) }, () => randValue(r, depth + 1));
    const o = {};
    for (let i = Math.floor(r() * 5); i > 0; i--) o[r() < 0.5 ? NASTY[Math.floor(r() * NASTY.length)] : ["rules", "settings", "props", "label", "colors", "buttons", "fx", "profiles", "list", "snippets", "id", "code", "use", "value"][Math.floor(r() * 14)]] = randValue(r, depth + 1);
    return o;
}
/** CSS правил — без чужого кода: скобки сбалансированы, нет @-правил и закрытия <style>. */
function cssSafe(css) {
    const body = css.replace(/\/\*[^]*?\*\//g, "");
    let depth = 0;
    for (const ch of body) { if (ch === "{") depth++; if (ch === "}") depth--; if (depth < 0 || depth > 1) return false; }
    return depth === 0 && !/@|<\/style/i.test(body);
}

test("фаззинг: пакет, профиль проекта, файл правок и профиль не падают на мусоре и не пропускают CSS-код", () => {
    const dir = fs.mkdtempSync(path.join(TMP, "fuzz-"));
    const file = path.join(dir, "design.json");
    for (let run = 0; run < 400; run++) {
        const r = rng(run + 1);
        const v = randValue(r, 0);
        const shaped = { format: "moon-core-bundle", v: 1, design: { rules: { [NASTY[run % NASTY.length]]: { props: randValue(r, 1) }, ".ok": { props: { hide: true, fontSize: r() * 60 } } }, settings: randValue(r, 1) }, profiles: { list: { p: randValue(r, 1) } }, snippets: randValue(r, 1) };
        try {
            B.parseBundle(JSON.stringify(v));
            const pb = B.parseBundle(shaped);
            PR.parse(JSON.stringify(Object.assign({ mooncore: 1 }, v && typeof v === "object" && !Array.isArray(v) ? v : { rules: v })));
            const prof = E2.cleanProfile(v);
            Object.keys(prof.rules).forEach((sel) => assert.strictEqual(D.cleanSelector(sel), sel, "селектор профиля прошёл проверку"));
            fs.writeFileSync(file, JSON.stringify(shaped.design));
            const d = D.readDesign(file);
            assert.ok(cssSafe(D.buildCss(d)), "CSS правок безопасен: " + D.buildCss(d).slice(0, 200));
            if (pb.ok) assert.ok(cssSafe(D.buildCss(Object.assign(D.emptyDesign(), { rules: pb.bundle.design.rules }))));
        } catch (e) { e.message = "прогон " + run + ": " + e.message; throw e; }
    }
});

test("правки и профили: имена вроде constructor и __proto__ не ломают объект правил", async () => {
    ["constructor", "__proto__", "prototype", " toString "].forEach((k) => assert.strictEqual(D.cleanSelector(k), "", k));
    const d = D.emptyDesign();
    D.applyCssOps(d, [{ op: "set", selector: "constructor", prop: "fontSize", value: 12 }, { op: "set", selector: "__proto__", prop: "hide", value: true }]);
    assert.deepStrictEqual(Object.keys(d.rules), []);
    assert.strictEqual(Object.getPrototypeOf(d.rules), Object.prototype, "прототип не подменён");
    assert.strictEqual(E2.cleanName("constructor"), "");
    assert.strictEqual(E2.cleanName("__proto__"), "");
    assert.deepStrictEqual(E2.cleanModules({ constructor: { a: 1 }, mlbg: { b: 2 } }), { mlbg: { b: 2 } });
});
