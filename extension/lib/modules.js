// ============================================================
//  Модули Moon Core — чистая часть без vscode (её гоняют тесты и стенд).
//
//  Модуль — чужой рантайм, который Moon Core впечатывает в оболочку VS Code своим же блоком
//  (инлайн, с нашим nonce) сразу после собственного рантайма. Так модулю не нужен ни свой
//  патч workbench.html, ни be5invis / custom-ui-style.
//
//  Манифест модуля (одинаковый в обоих источниках):
//    {
//      "id":      "mlbg",              // ^[a-z][a-z0-9-]{1,31}$, уникален
//      "name":    "MoonLight BG",      // для людей (необязательно)
//      "version": "20.0.0",            // для диагностики (необязательно)
//      "script":  "custom-bg.js",      // путь к рантайму ОТНОСИТЕЛЬНО корня модуля
//      "assets":  "."                  // папка ресурсов относительно корня (необязательно)
//      "trustedTypes": ["mlbg"]        // свои политики Trusted Types (необязательно, до 4): Moon Core
//                                      // впишет их в CSP оболочки — без этого trustedTypes.createPolicy
//                                      // в VS Code с CSP (require-trusted-types-for) упадёт
//    }
//  Источники:
//    - расширение: package.json -> "moonCore": { "modules": [ <манифест>, ... ] }, корень = папка расширения;
//    - папка: настройка moonCore.modules = ["D:/path/to/module"], в папке mooncore-module.json.
//
//  В окне модуль получает помощника: window.__MOONCORE__.module("<id>") (см. рантайм).
//  В хосте расширений — через API Moon Core: exports.module("<id>") (см. ModuleHub.api).
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { writeAtomic } = require("./storage");
const TT = require("./trusted-types");
const MF = require("./module-manifest");

const MODULE_FILE = "mooncore-module.json";
const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const EVENT_RE = /^[a-z][\w.-]{0,39}$/i;
const LIMITS = {
    MAX_MODULES: 16,
    MAX_SCRIPT: 4 * 1024 * 1024,     // байт в рантайме одного модуля
    MAX_TOTAL: 12 * 1024 * 1024,     // байт во всех модулях вместе
    MAX_DATA: 256 * 1024,            // байт в одном событии модуля (JSON)
    MAX_CACHED: 32,                  // событий, которые помним на модуль для новых окон
    MAX_MODULE_DATA: 1024 * 1024,    // байт в файле данных модуля (JSON)
};

const clip = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001F]/g, " ").trim().slice(0, n);

function sha256(s) { return crypto.createHash("sha256").update(String(s), "utf8").digest("hex"); }

/** Путь rel внутри root (без выхода наружу через .. и через симлинки). null — если нельзя. */
function inside(root, rel) {
    if (typeof rel !== "string" || !rel || rel.length > 260 || path.isAbsolute(rel)) return null;
    let realRoot;
    try { realRoot = fs.realpathSync(root); } catch (e) { return null; }
    const abs = path.resolve(realRoot, rel);
    let real;
    try { real = fs.realpathSync(abs); } catch (e) { return null; }
    const r = path.relative(realRoot, real);
    if (r.startsWith("..") || path.isAbsolute(r)) return null;
    return real;
}

/**
 * Проверить манифест. Возвращает { ok, module?, error? }.
 * module: { id, name, version, root, script (абсолютный путь), assets (абсолютный путь), source }
 */
function normalize(raw, root, source) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "манифест не объект" };
    const id = String(raw.id || "");
    if (!ID_RE.test(id)) return { ok: false, error: "неверный id «" + clip(id, 40) + "»" };
    if (typeof root !== "string" || !root) return { ok: false, error: id + ": нет корня модуля" };
    const script = inside(root, raw.script);
    if (!script) return { ok: false, error: id + ": скрипт не найден внутри папки модуля" };
    if (!/\.js$/i.test(script)) return { ok: false, error: id + ": скрипт должен быть .js" };
    let st;
    try { st = fs.statSync(script); } catch (e) { return { ok: false, error: id + ": скрипт недоступен" }; }
    if (!st.isFile()) return { ok: false, error: id + ": скрипт не файл" };
    if (st.size > LIMITS.MAX_SCRIPT) return { ok: false, error: id + ": скрипт больше " + (LIMITS.MAX_SCRIPT >> 20) + " МБ" };
    const tt = TT.checkNames(raw.trustedTypes);
    if (!tt.ok) return { ok: false, error: id + ": " + tt.error };
    let assets = fs.realpathSync(root);
    if (raw.assets != null) {
        assets = inside(root, String(raw.assets));
        if (!assets) return { ok: false, error: id + ": папка ресурсов вне модуля" };
        try { if (!fs.statSync(assets).isDirectory()) return { ok: false, error: id + ": assets не папка" }; }
        catch (e) { return { ok: false, error: id + ": assets недоступна" }; }
    }
    return {
        ok: true,
        module: {
            id: id,
            name: clip(raw.name, 80) || id,
            version: clip(raw.version, 40).replace(/[^\w.+-]/g, ""),
            root: fs.realpathSync(root),
            script: script,
            assets: assets,
            trustedTypes: tt.names,
            caps: MF.cleanCaps(raw.capabilities),
            lazy: MF.cleanLazy(raw.lazy),
            commands: MF.cleanCommands(raw.commands),
            source: clip(source, 200),
        },
    };
}

/** Манифесты из package.json расширения: packageJSON.moonCore.modules. */
function fromPackage(pkg, extPath, extId) {
    const list = pkg && pkg.moonCore && Array.isArray(pkg.moonCore.modules) ? pkg.moonCore.modules : [];
    return list.slice(0, LIMITS.MAX_MODULES).map((raw) => normalize(raw, extPath, "ext:" + extId));
}

/** Манифест из папки (mooncore-module.json). */
function fromFolder(dir) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(dir, MODULE_FILE), "utf8")); }
    catch (e) { return { ok: false, error: "в папке " + dir + " нет читаемого " + MODULE_FILE }; }
    return normalize(raw, dir, "dir:" + dir);
}

/**
 * Свести найденные модули: дубли id отбрасываются (первый выигрывает), лимиты по числу.
 * Возвращает { modules, errors }.
 */
function collect(results) {
    const modules = [], errors = [], seen = new Set();
    results.forEach((r) => {
        if (!r || !r.ok) { if (r && r.error) errors.push(r.error); return; }
        if (seen.has(r.module.id)) { errors.push(r.module.id + ": такой id уже есть (" + r.module.source + " пропущен)"); return; }
        if (modules.length >= LIMITS.MAX_MODULES) { errors.push(r.module.id + ": модулей больше " + LIMITS.MAX_MODULES); return; }
        seen.add(r.module.id);
        modules.push(r.module);
    });
    return { modules: modules, errors: errors };
}

/**
 * Прочитать рантаймы модулей для впечатывания. [{id, code, sha}] и ошибки.
 * Общий лимит объёма — чтобы оболочка VS Code не распухла до неприличия.
 */
function loadScripts(modules) {
    const out = [], errors = [];
    let total = 0;
    modules.forEach((m) => {
        let code;
        try { code = fs.readFileSync(m.script, "utf8"); } catch (e) { errors.push(m.id + ": " + (e.code || e.message)); return; }
        if (code.length > LIMITS.MAX_SCRIPT) { errors.push(m.id + ": скрипт вырос сверх лимита"); return; }
        total += code.length;
        if (total > LIMITS.MAX_TOTAL) { errors.push(m.id + ": общий объём модулей сверх лимита"); return; }
        out.push({ id: m.id, code: code, sha: sha256(code) });
    });
    return { scripts: out, errors: errors };
}

/** Файл данных модуля: <dataDir>/<id>.json (id проверен регуляркой — выйти из папки нельзя). */
function dataFile(dataDir, id) { return path.join(dataDir, id + ".json"); }

/**
 * Что окно знает о модуле (уходит в boot). Пути — file:///-URL, рантайм сам переводит в vscode-file.
 * dataUrl — файл данных модуля: окно читает его синхронно при старте (раньше, чем появится мост).
 */
function bootInfo(modules, fileUrl, dataDir) {
    return modules.map((m) => ({
        id: m.id, name: m.name, version: m.version,
        base: fileUrl(m.assets).replace(/\/?$/, "/"),
        dataUrl: dataDir ? fileUrl(dataFile(dataDir, m.id)) : "",
        // Ленивый модуль: когда грузить (файл и integrity дописывает план внедрения).
        lazy: m.lazy ? { delay: m.lazy.delay } : null,
        commands: (m.commands || []).map((c) => c.id),
    }));
}

/** Отпечаток набора модулей: меняется, если поменялся состав или код любого из них. */
function fingerprint(scripts) {
    return scripts.map((s) => s.id + ":" + s.sha).join(",");
}

// ------------------------------------------------------------------ маршрутизация

/**
 * Хаб модулей в хосте: события модулей -> окна (через мост), запросы окон -> обработчики.
 * opts: { broadcast(event, data), log(msg, err?) }
 */
class ModuleHub {
    constructor(opts) {
        this.broadcast = opts.broadcast;
        this.log = opts.log || (() => {});
        this.dataDir = opts.dataDir || "";
        this.known = new Map();       // id -> модуль (найденные и разрешённые)
        this.handlers = new Map();    // id -> fn(method, body)
        this.cache = new Map();       // id -> Map(event -> {data, scope})
    }

    setModules(list) {
        const next = new Map(list.map((m) => [m.id, m]));
        const removed = Array.from(this.known.keys()).filter((id) => !next.has(id));
        this.known = next;
        // Выключенный модуль: его последние события не должны доставаться новым окнам, а то, что
        // он создал в VS Code (элементы статусбара через шлюз), — оставаться висеть.
        removed.forEach((id) => this.cache.delete(id));
        if (removed.length && typeof this.onRemoved === "function") { try { this.onRemoved(removed); } catch (e) { this.log("модули: уборка", e); } }
        return removed;
    }

    has(id) { return this.known.has(id); }

    /** Отправить событие модулю во всех окнах. scope "window" — только окну этого хоста. */
    publish(id, event, data, opts) {
        if (!ID_RE.test(String(id))) throw new Error("Moon Core: неверный id модуля");
        if (!EVENT_RE.test(String(event))) throw new Error("Moon Core: неверное имя события");
        const scope = opts && opts.scope === "window" ? "window" : "all";
        let text;
        try { text = JSON.stringify(data === undefined ? null : data); } catch (e) { throw new Error("Moon Core: данные события не сериализуются"); }
        if (text.length > LIMITS.MAX_DATA) throw new Error("Moon Core: событие больше " + (LIMITS.MAX_DATA >> 10) + " КБ");
        const payload = { id: id, event: event, scope: scope, data: JSON.parse(text) };
        // cache: false — разовое событие (клик, команда): новое окно не должно получить его при
        // подключении, иначе после перезагрузки окна старый клик «нажался» бы ещё раз.
        if (opts && opts.cache === false) { payload.once = true; this.broadcast("module", payload); return; }
        let c = this.cache.get(id);
        if (!c) { c = new Map(); this.cache.set(id, c); }
        c.delete(event);
        c.set(event, payload);
        while (c.size > LIMITS.MAX_CACHED) c.delete(c.keys().next().value);
        this.broadcast("module", payload);
    }

    /** Последние события всех модулей — новое окно получает их сразу при подключении. */
    hello() {
        const out = [];
        this.cache.forEach((c) => c.forEach((p) => out.push({ event: "module", data: p })));
        return out;
    }

    /** Обработчик запросов окна к модулю. Один на модуль в этом хосте. Возвращает отписку. */
    handle(id, fn) {
        if (typeof fn !== "function") throw new Error("Moon Core: обработчик должен быть функцией");
        this.handlers.set(id, fn);
        return () => { if (this.handlers.get(id) === fn) this.handlers.delete(id); };
    }

    /** Запрос окна: POST /rpc/<токен>/module { id, method, body }. */
    async dispatch(req) {
        const id = String(req && req.id || "");
        const method = String(req && req.method || "");
        if (!this.known.has(id)) return { ok: false, error: "unknown module" };
        if (!EVENT_RE.test(method)) return { ok: false, error: "bad method" };
        const fn = this.handlers.get(id);
        if (!fn) return { ok: false, error: "no handler" };
        try {
            const result = await fn(method, req.body === undefined ? null : req.body);
            let safe = null;
            try { safe = result === undefined ? null : JSON.parse(JSON.stringify(result)); } catch (e) { safe = null; }
            return { ok: true, result: safe };
        } catch (e) {
            this.log("модуль " + id + ": запрос " + method, e);
            return { ok: false, error: String(e && e.message || e) };
        }
    }

    /** Прочитать файл данных модуля: объект или null. */
    readData(id) {
        if (!ID_RE.test(String(id)) || !this.dataDir) return null;
        try {
            const text = fs.readFileSync(dataFile(this.dataDir, id), "utf8");
            if (text.length > LIMITS.MAX_MODULE_DATA) return null;
            const v = JSON.parse(text);
            return v && typeof v === "object" && !Array.isArray(v) ? v : null;
        } catch (e) { return null; }
    }

    /** Записать файл данных модуля (объект, до 1 МБ JSON). Атомарно: окно не прочтёт недописанное. */
    writeData(id, data) {
        if (!ID_RE.test(String(id))) throw new Error("Moon Core: неверный id модуля");
        if (!this.dataDir) throw new Error("Moon Core: хранилище данных модулей недоступно");
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Moon Core: данные модуля должны быть объектом");
        let text;
        try { text = JSON.stringify(data); } catch (e) { throw new Error("Moon Core: данные модуля не сериализуются"); }
        if (text.length > LIMITS.MAX_MODULE_DATA) throw new Error("Moon Core: данные модуля больше " + (LIMITS.MAX_MODULE_DATA >> 10) + " КБ");
        fs.mkdirSync(this.dataDir, { recursive: true });
        writeAtomic(dataFile(this.dataDir, id), text);
    }

    /** Запрос окна: POST /rpc/<токен>/moduleData { id, data } — сохранить данные модуля. */
    saveFromWindow(req) {
        const id = String(req && req.id || "");
        if (!this.known.has(id)) return { ok: false, error: "unknown module" };
        try { this.writeData(id, req.data); return { ok: true }; }
        catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    }

    /** Объект для расширения-модуля (exports Moon Core -> module(id)). */
    api(id) {
        if (!ID_RE.test(String(id))) throw new Error("Moon Core: неверный id модуля");
        const hub = this;
        return {
            id: id,
            /** Модуль найден и разрешён пользователем (иначе в окне его нет). */
            get active() { return hub.has(id); },
            publish: (event, data, opts) => hub.publish(id, event, data, opts),
            onRequest: (fn) => { const off = hub.handle(id, fn); return { dispose: off }; },
            /** Файл данных модуля (его же окно читает при старте): объект или null. */
            readData: () => hub.readData(id),
            writeData: (data) => hub.writeData(id, data),
        };
    }
}

module.exports = {
    MODULE_FILE, ID_RE, LIMITS, inside, dataFile, normalize, fromPackage, fromFolder, collect, loadScripts, bootInfo, fingerprint, ModuleHub, sha256,
};
