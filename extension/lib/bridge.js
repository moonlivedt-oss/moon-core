// ============================================================
//  Мост «окно <-> расширение».
//
//  Рантайм впечатан в оболочку VS Code, а оболочка работает в песочнице: Node у неё нет.
//  Поэтому расширение поднимает крошечный HTTP-сервер:
//    - слушает только 127.0.0.1, порт — любой свободный;
//    - адрес содержит случайный токен (48 hex), без него запрос отклоняется;
//    - принимает только Origin оболочки (vscode-file://vscode-app) и Host 127.0.0.1:<порт>
//      (защита от сайтов в браузере и от DNS-rebinding);
//    - GET  /events/<токен>         — поток событий (SSE), первым приходит текущее состояние;
//    - POST /rpc/<токен>/<метод>    — запрос окна с ответом сразу;
//    - GET  /ping/<токен>           — проверка связи.
//
//  Несколько окон VS Code = несколько хостов расширений с одним хранилищем. В
//  mooncore-bridge.json лежит список живых хостов; рантайм каждого окна подключается ко ВСЕМ,
//  поэтому событие любого хоста видят все окна. Действие, которое должно случиться «в этом
//  окне» (команда VS Code), выполняет только хост окна в фокусе, остальные отвечают 409.
//
//  Модуль не требует vscode — его можно поднять в тестах.
// ============================================================
"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const P = require("./protocol");
const { log } = require("./log");
const { renameRetry } = require("./fsx");

const ORIGIN = "vscode-file://vscode-app";
// Порты моста — фиксированный диапазон: в CSP оболочки разрешены только они (не «любой порт»).
const PORTS = Array.from({ length: P.BRIDGE_PORT_COUNT }, (_, i) => P.BRIDGE_PORT_FIRST + i);
const METHODS = new Set(P.METHODS);
const REFRESH_MS = 30000;   // держим себя в списке: другой хост мог затереть файл одновременно
const BEAT_MS = 25000;      // пульс потокам: без трафика соединение могут оборвать
// Окно, которое не читает поток (зависло, стоит в отладчике), копит в памяти хоста всё, что ему
// шлют: состояние с каталогом — десятки КБ на каждую правку. Больше этого в буфере — отключаем,
// окно само переподключится (EventSource) и первым событием получит свежее состояние.
const MAX_BUFFERED = 4 * 1024 * 1024;
// Методы со своим лимитом: поток ошибок окна (log) или время запуска не съедают лимит
// конструктора и команд — и наоборот.
const OWN_BUCKET = { log: 300, timing: 60 };

function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (pid === process.pid) return true;
    try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === "EPERM"); }
}

function readHosts(file) {
    let o = null;
    try { o = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return []; }
    const list = o && Array.isArray(o.hosts) ? o.hosts : [];
    return list.filter((h) => h && (h.port | 0) > 0 && /^[0-9a-f]{48}$/.test(String(h.token)) && pidAlive(h.pid));
}

function writeHosts(file, hosts) {
    if (!hosts.length) { try { fs.unlinkSync(file); } catch (e) {} return; }
    const tmp = file + "." + process.pid + ".tmp";
    // В файле токены моста: читать его должен только владелец (на Windows папка профиля и так закрыта).
    fs.writeFileSync(tmp, JSON.stringify({ v: P.VERSION, hosts: hosts, ts: Date.now() }), { encoding: "utf8", mode: 0o600 });
    try { renameRetry(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch (e2) {} throw e; }
    if (process.platform !== "win32") { try { fs.chmodSync(file, 0o600); } catch (e) {} }
}

/**
 * Поднять мост.
 * opts: {
 *   file:      путь к mooncore-bridge.json,
 *   dispatch:  (method, body) => Promise<object>  — обработчик запросов окна,
 *   hello:     () => [{event, data}]              — что отправить новому потоку сразу,
 *   isFocused: () => boolean                      — окно этого хоста в фокусе,
 *   origin:    допустимый Origin (по умолчанию оболочка VS Code; другой — только для тестового стенда),
 * }
 * Возвращает объект моста: { ready: Promise, port, token, broadcast, status, dispose }.
 */
function createBridge(opts) {
    const token = crypto.randomBytes(24).toString("hex");
    const allowOrigin = opts.origin || ORIGIN;
    const clients = new Set();
    let port = 0, lastSeen = 0, requests = 0, disposed = false, rejected = 0, dropped = 0;
    const byMethod = {};
    // Ограничение частоты: окно шлёт немного (журнал ошибок сам себя ограничивает), поэтому
    // поток сотен запросов в секунду — это не окно, а кто-то, кто подобрал токен или сломался.
    // Окно 10 с на корзину: общая для всех методов и отдельные для OWN_BUCKET.
    const buckets = new Map();
    const overLimit = (method) => {
        const name = Object.prototype.hasOwnProperty.call(OWN_BUCKET, method) ? method : "*";
        const limit = name === "*" ? P.RPC_LIMIT_PER_10S : OWN_BUCKET[name];
        const t = Date.now();
        let b = buckets.get(name);
        if (!b || t - b.start > 10000) { b = { start: t, count: 0 }; buckets.set(name, b); }
        return ++b.count > limit;
    };

    const sameToken = (a) => {
        const x = Buffer.from(String(a || "")), y = Buffer.from(token);
        return x.length === y.length && crypto.timingSafeEqual(x, y);
    };

    function sse(res, event, data) {
        const text = typeof data === "string" ? data : JSON.stringify(data);
        res.write("event: " + event + "\ndata: " + text.replace(/\r?\n/g, "\ndata: ") + "\n\n");
    }

    function dropClient(res) {
        clients.delete(res);
        try { res.destroy(); } catch (e) {}
    }
    /** Поток переполнен (окно не читает) — отключить. true — отключили. */
    function stalled(res) {
        if (!(res.writableLength > MAX_BUFFERED)) return false;
        dropped++;
        log("мост: окно не читает поток (" + Math.round(res.writableLength / 1024) + " КБ в очереди) — отключено");
        dropClient(res);
        return true;
    }
    function broadcast(event, data) {
        for (const res of clients) {
            if (stalled(res)) continue;
            try { sse(res, event, data); } catch (e) { dropClient(res); }
        }
    }

    function readBody(req, cb) {
        let size = 0, over = false, done = false;
        const chunks = [];
        const finish = (v) => { if (!done) { done = true; cb(v); } };
        req.on("data", (c) => {
            if (over) return;                      // лишнее просто сливаем
            size += c.length;
            if (size > P.MAX_BODY) { over = true; chunks.length = 0; finish(null); return; }
            chunks.push(c);
        });
        req.on("end", () => finish(over ? null : Buffer.concat(chunks).toString("utf8")));
        // Окно закрыли посреди запроса: без этого запрос висел бы, а ошибка сокета ушла бы наружу.
        req.on("error", () => finish(null));
        req.on("aborted", () => finish(null));
    }

    const server = http.createServer((req, res) => {
        const cors = {
            "Access-Control-Allow-Origin": allowOrigin,
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Private-Network": "true",
            "Vary": "Origin",
        };
        const end = (code, body, type) => {
            res.writeHead(code, Object.assign({ "Content-Type": type || "text/plain; charset=utf-8", "Cache-Control": "no-store" }, cors));
            res.end(body || "");
        };
        const origin = req.headers.origin || "";
        if (req.headers.host !== "127.0.0.1:" + port) return end(403, "host");
        if (origin && origin !== allowOrigin) return end(403, "origin");
        if (req.method === "OPTIONS") return end(204);
        const m = /^\/(ping|events|rpc)\/([0-9a-f]{48})(?:\/([\w.-]+))?$/.exec(req.url || "");
        if (!m || !sameToken(m[2])) return end(403, "token");
        lastSeen = Date.now();
        if (m[1] === "ping") return end(200, "ok");
        if (m[1] === "events") {
            if (req.method !== "GET") return end(405, "method");
            if (clients.size >= P.MAX_STREAMS) return end(503, "streams");
            res.writeHead(200, Object.assign({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "Connection": "keep-alive" }, cors));
            res.write("retry: 3000\n\n");
            clients.add(res);
            req.on("close", () => clients.delete(res));
            try { (opts.hello ? opts.hello() : []).forEach((e) => sse(res, e.event, e.data)); }
            catch (e) { log("мост: приветствие потока", e); }
            return undefined;
        }
        if (req.method !== "POST") return end(405, "method");
        const method = m[3] || "";
        if (!METHODS.has(method)) return end(404, "method");
        // Только JSON: «простой» запрос (form/text) браузер шлёт без предварительной проверки CORS.
        if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) return end(415, "type");
        if (overLimit(method)) { rejected++; if (rejected === 1 || rejected % 500 === 0) log("мост: слишком много запросов, лишние отклонены (" + rejected + ")"); return end(429, "rate"); }
        readBody(req, (text) => {
            if (text == null) { if (!res.writableEnded && !res.destroyed) end(413, "size"); return undefined; }
            let body;
            try { body = JSON.parse(text); } catch (e) { return end(400, "json"); }
            if (!body || typeof body !== "object" || Array.isArray(body)) return end(400, "json");
            requests++;
            byMethod[method] = (byMethod[method] || 0) + 1;
            // «Команда» должна выполниться в том окне, где нажали кнопку: это окно в фокусе.
            if (method === "command" && opts.isFocused && !opts.isFocused()) {
                return end(409, JSON.stringify({ ok: false, retry: true }), "application/json; charset=utf-8");
            }
            Promise.resolve()
                .then(() => opts.dispatch(method, body))
                .catch((e) => { log("мост: запрос " + method, e); return { ok: false, error: String(e && e.message || e) }; })
                .then((out) => end(200, JSON.stringify(out || { ok: true }), "application/json; charset=utf-8"));
            return undefined;
        });
        return undefined;
    });
    // Занятый порт — обычное дело (его держит мост другого окна VS Code): следующий порт берёт
    // listen ниже, в журнал это не пишем.
    server.on("error", (e) => { if (!(e && e.code === "EADDRINUSE")) log("мост", e); });
    server.unref();

    function registerSelf() {
        if (!port || disposed || !opts.file) return;
        try {
            const hosts = readHosts(opts.file);
            if (hosts.some((h) => h.pid === process.pid && h.port === port && h.token === token)) return;
            const others = hosts.filter((h) => h.pid !== process.pid);
            writeHosts(opts.file, [{ port: port, token: token, pid: process.pid, ts: Date.now() }].concat(others));
        } catch (e) { log("мост: запись адреса", e); }
    }
    function unregisterSelf() {
        if (!opts.file) return;
        try { writeHosts(opts.file, readHosts(opts.file).filter((h) => h.pid !== process.pid)); } catch (e) {}
    }

    // Первый свободный порт из диапазона; все заняты (20 окон VS Code) — любой свободный,
    // но тогда при CSP в оболочке окно не достучится — пишем об этом в журнал.
    const candidates = (opts.ports || PORTS).concat([0]);
    const ready = new Promise((resolve, reject) => {
        let i = 0;
        const tryNext = () => {
            const want = candidates[i++];
            const onErr = (e) => {
                server.removeListener("listening", onOk);
                if (e && e.code === "EADDRINUSE" && i < candidates.length) tryNext(); else reject(e);
            };
            const onOk = () => {
                server.removeListener("error", onErr);
                port = server.address().port;
                if (want === 0) log("мост: порты " + PORTS[0] + "–" + PORTS[PORTS.length - 1] + " заняты, взят " + port + " — при CSP в оболочке окно его не увидит");
                registerSelf();
                resolve();
            };
            server.once("error", onErr);
            server.once("listening", onOk);
            server.listen(want, "127.0.0.1");
        };
        tryNext();
    });
    const refresh = setInterval(registerSelf, REFRESH_MS);
    const beat = setInterval(() => {
        for (const r of clients) { if (!stalled(r)) { try { r.write(": ping\n\n"); } catch (e) { dropClient(r); } } }
    }, BEAT_MS);
    if (refresh.unref) refresh.unref();
    if (beat.unref) beat.unref();

    return {
        ready: ready,
        get port() { return port; },
        get token() { return token; },
        broadcast: broadcast,
        status: () => ({ running: port > 0 && !disposed, port: port, lastSeen: lastSeen, requests: requests, streams: clients.size, rejected: rejected, dropped: dropped, byMethod: Object.assign({}, byMethod) }),
        dispose() {
            if (disposed) return;
            disposed = true;
            clearInterval(refresh); clearInterval(beat);
            for (const r of clients) { try { r.end(); } catch (e) {} }
            clients.clear();
            try { server.close(); } catch (e) {}
            try { if (server.closeAllConnections) server.closeAllConnections(); } catch (e) {} // порт диапазона займёт следующий хост
            unregisterSelf();
            port = 0;
        },
    };
}

module.exports = { createBridge, readHosts, pidAlive, ORIGIN, PORTS, MAX_BUFFERED, OWN_BUCKET };
