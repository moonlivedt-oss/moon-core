// ============================================================
//  Moon Core — рантайм в окне VS Code (впечатан в workbench.html).
//  СОБРАН из runtime/src/*.js (node scripts/build-runtime.js) — правь исходники, не этот файл.
//
//  Что делает:
//    - применяет CSS-сниппеты (<style> в <head>, самолечение, если VS Code их снёс);
//    - выполняет JS-сниппеты с помощником mc (всё созданное через него убирается само);
//    - слушает мост расширения (SSE) — новые версии сниппетов, живой предпросмотр CSS,
//      пипетку и проверку селекторов;
//    - пипетка: подсветка элемента под курсором, колесо — родитель/потомок, клик — меню
//      действий (стиль в CSS / скрыть / копировать селектор);
//    - конструктор: панель свойств, ручки на элементе, порядок мышкой, карта, профили.
//
//  Node здесь нет (песочница оболочки): читаем файлы хранилища по vscode-file://,
//  пишем и зовём команды через HTTP-мост на 127.0.0.1.
// ============================================================
(function () {
    "use strict";
    if (window.__MOONCORE__) return;

    var BOOT = window.__MOONCORE_BOOT__ || {};
    function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
    // Та же шкала, что у now(): без performance было T0 = 0 при now() = Date.now() — время старта
    // выходило «с 1970 года».
    var T0 = now();

    // ---------------------------------------------------------------------------
    //  Защита запуска. Каждый запуск помечается «идёт» (n+1) и «последний модуль» (last); когда
    //  окно поработало несколько секунд — метка снимается. Если прошлый запуск не дошёл до конца
    //  на модуле X (завис/уронил окно) — X в этот раз пропускается. Три незавершённых запуска
    //  подряд без известного виновника — пропускаются все модули. Файл модуля первой строкой
    //  спрашивает _skip(id) и при «да» не выполняется.
    // ---------------------------------------------------------------------------
    var GUARD_KEY = "mooncore.bootGuard";
    var guard = (function () {
        var g = null;
        try { g = JSON.parse(localStorage.getItem(GUARD_KEY) || "null"); } catch (e) {}
        return (g && typeof g === "object") ? { n: +g.n || 0, last: String(g.last || "") } : { n: 0, last: "" };
    })();
    var skipAll = guard.n >= 3 && !guard.last, skipOne = guard.n >= 1 ? guard.last : "", skipped = [];
    function saveGuard() { try { localStorage.setItem(GUARD_KEY, JSON.stringify(guard)); } catch (e) {} }
    guard.n = skipAll ? 0 : guard.n + 1; guard.last = ""; saveGuard();
    var timing = { runtime: 0, modules: {}, skipped: skipped, failed: [], stages: {} };
    /**
     * Этап старта окна: мс от начала рантайма (в Доктор) и performance.mark «mooncore:<этап>»
     * (видно во вкладке Performance DevTools). Каждый этап — один раз, первое достижение.
     */
    function stage(name) {
        if (timing.stages[name] != null) return;
        timing.stages[name] = Math.round((now() - T0) * 10) / 10;
        try { if (window.performance && performance.mark) performance.mark("mooncore:" + name); } catch (e) {}
    }
    var modRan = {};   // файл модуля начал выполняться (его первая строка зовёт _skip)
    var PROTO = BOOT.proto || { VERSION: 1, MAX_SNIPPET: 262144, MAX_SNIPPETS: 200, MAX_LOG: 4000, RPC_TIMEOUT_MS: 8000 };
    var NONCE = (document.currentScript && document.currentScript.nonce) || "";
    var ID_RE = /^[A-Za-z0-9][\w.-]{0,63}\.(css|js)$/;
    var Z = 2147483000;

    // ---------------------------------------------------------------------------
    //  Файлы хранилища (только чтение) — через vscode-file://vscode-app/<путь>.
    // ---------------------------------------------------------------------------
    function appUrl(u) {
        var m = String(u || "").match(/^file:\/\/\/([^?#]+)$/);
        if (!m) return null;
        return "vscode-file://vscode-app/" + m[1].split("/").map(function (seg) {
            try { return encodeURIComponent(decodeURIComponent(seg)).replace(/%3A/gi, ":"); } catch (e) { return ""; }
        }).join("/");
    }
    function canReadApp() { return typeof location !== "undefined" && location.protocol === "vscode-file:" && typeof XMLHttpRequest !== "undefined"; }
    function readSync(u) {
        try {
            if (!canReadApp()) return null;
            var url = appUrl(u); if (!url) return null;
            var x = new XMLHttpRequest();
            x.open("GET", url + "?t=" + Date.now(), false);
            x.send();
            return x.status === 200 || (x.status === 0 && x.responseText) ? x.responseText : null;
        } catch (e) { return null; }
    }
    function readAsync(u, cb) {
        if (!canReadApp()) { cb(null); return; }
        var url = appUrl(u); if (!url) { cb(null); return; }
        try {
            var x = new XMLHttpRequest();
            x.open("GET", url + "?t=" + Date.now(), true);
            x.onload = function () { cb(x.status === 200 || (x.status === 0 && x.responseText) ? x.responseText : null); };
            x.onerror = function () { cb(null); };
            x.send();
        } catch (e) { cb(null); }
    }
    function parse(txt) { try { return txt ? JSON.parse(txt) : null; } catch (e) { return null; } }

    // ---------------------------------------------------------------------------
    //  Журнал: ошибки уходят в Output «Moon Core» (через мост), плюс консоль DevTools.
    // ---------------------------------------------------------------------------
    var _logCount = 0, _logWindow = 0;
    function report(where, err, snippet) {
        try { console.error("[moon-core] " + where + ":", err); } catch (e) {}
        var now = Date.now();
        if (now - _logWindow > 60000) { _logWindow = now; _logCount = 0; }
        if (++_logCount > 30) return;                         // цикл ошибок не завалит журнал
        rpcAny("log", {
            where: String(where).slice(0, 80),
            snippet: snippet || "",
            msg: String(err && err.message || err).slice(0, PROTO.MAX_LOG),
            stack: String(err && err.stack || "").slice(0, PROTO.MAX_LOG),
        });
    }

    // ---------------------------------------------------------------------------
    //  Trusted Types. В VS Code с CSP «require-trusted-types-for 'script'» строка не станет кодом
    //  (eval, <script>.textContent) и адресом скрипта (<script>.src) без политики из списка CSP.
    //  Moon Core вписывает туда «mooncore» при внедрении. Политика создаётся сразу при старте (имя
    //  не займёт чужой скрипт) и пропускает:
    //    - код — только ту строку, которую рантайм передал сам через trustedScript() (чанк
    //      интерфейса после сверки SHA-256, код модуля от хоста, JS-сниппет);
    //    - адрес — только файл модуля рядом с оболочкой (mooncore-mod-<id>.js).
    //  Нет Trusted Types (старый VS Code, стенд) — строки идут как есть.
    // ---------------------------------------------------------------------------
    var ttPolicy = null, ttScript = null;
    var TT_SRC_RE = /^mooncore-mod-[a-z0-9-]{2,32}\.js$/;
    try {
        if (window.trustedTypes && typeof window.trustedTypes.createPolicy === "function") {
            ttPolicy = window.trustedTypes.createPolicy("mooncore", {
                createScript: function (s) { if (s !== ttScript) throw new Error("Moon Core: непроверенный код"); return s; },
                createScriptURL: function (u) {
                    var base = typeof BOOT.moduleFileBase === "string" ? BOOT.moduleFileBase : "";
                    if (u.indexOf(base) !== 0 || !TT_SRC_RE.test(u.slice(base.length))) throw new Error("Moon Core: чужой адрес скрипта");
                    return u;
                },
            });
        }
    } catch (e) { ttPolicy = null; }   // имени нет в списке CSP — строки пойдут как есть
    function trustedScript(code) {
        if (!ttPolicy) return code;
        ttScript = code;
        try { return ttPolicy.createScript(code); } finally { ttScript = null; }
    }
    function trustedScriptUrl(u) { return ttPolicy ? ttPolicy.createScriptURL(u) : u; }
    /** Ошибка запрета кода из строки: CSP без unsafe-eval или Trusted Types. */
    function isCodeBlocked(e) {
        return (typeof EvalError === "function" && e instanceof EvalError) || /unsafe-eval|Content Security Policy|Trusted ?Type|TrustedScript/i.test(String(e && e.message || e));
    }

    // ---------------------------------------------------------------------------
    //  Мост: подключаемся ко всем живым хостам из mooncore-bridge.json.
    // ---------------------------------------------------------------------------
    var hosts = {};          // token -> {port, token, es, errors, open}
    var badUntil = {};       // token -> время, до которого не переподключаемся
    var lastHostsText = "", lastTokens = [];   // прошлое содержимое mooncore-bridge.json и его хосты
    var protoWarned = false;

    /** Хост говорит на другой версии протокола (расширение обновили, окно не перезагрузили). */
    function checkProto(d) {
        if (protoWarned || !d || typeof d.v !== "number" || d.v === PROTO.VERSION) return;
        protoWarned = true;
        var msg = "Moon Core обновился (протокол " + PROTO.VERSION + " -> " + d.v + "): перезагрузи окно, чтобы рантайм совпал с расширением.";
        report("протокол", msg);
        try { toast(msg); } catch (e) {}
    }

    function validHost(h) { return h && (h.port | 0) > 0 && (h.port | 0) < 65536 && /^[0-9a-f]{48}$/.test(String(h.token)); }

    function refreshHosts() {
        // Тестовый стенд (test/serve.js): адреса хостов приходят прямо в boot.
        if (!canReadApp() && Array.isArray(BOOT.testHosts)) {
            BOOT.testHosts.filter(validHost).forEach(function (h) { if (!hosts[h.token] && !(badUntil[h.token] > Date.now())) connect(h); });
            return;
        }
        if (!BOOT.bridgeUrl) return;
        readAsync(BOOT.bridgeUrl, function (txt) {
            // Файл адресов не менялся и все хосты из него подключены — разбирать нечего.
            if (txt && txt === lastHostsText && lastTokens.length && lastTokens.every(function (t) { return !!hosts[t]; })) return;
            lastHostsText = txt || "";
            var o = parse(txt);
            var list = o && Array.isArray(o.hosts) ? o.hosts.slice(0, 16).filter(validHost) : [];
            lastTokens = list.map(function (h) { return h.token; });
            var alive = {};
            list.forEach(function (h) {
                alive[h.token] = 1;
                if (!hosts[h.token] && !(badUntil[h.token] > Date.now())) connect(h);
            });
            Object.keys(hosts).forEach(function (t) { if (!alive[t]) disconnect(t); });
        });
    }

    function connect(h) {
        if (typeof EventSource !== "function") return;
        var rec = { port: h.port | 0, token: h.token, es: null, errors: 0, open: false };
        try { rec.es = new EventSource("http://127.0.0.1:" + rec.port + "/events/" + rec.token); }
        catch (e) { return; }
        hosts[rec.token] = rec;
        rec.es.onopen = function () {
            stage("bridge"); rec.errors = 0; rec.open = true;
            if (hasFocus() && !ownToken) probeOwnHost();
            // Новый (или вернувшийся) хост не знает подписок модулей на события VS Code и их команд.
            setTimeout(function () { try { vsResubscribe(null); } catch (e) {} }, 0);
        };
        rec.es.onerror = function () {
            rec.open = false;
            // Хост из файла мёртв (адрес прошлого сеанса) — не переподключаемся вечно.
            if (++rec.errors >= 4 || rec.es.readyState === 2) { badUntil[rec.token] = Date.now() + 30000; disconnect(rec.token); }
        };
        on(rec, "state", function (d) {
            checkProto(d);
            // Кнопки расширений у каждого хоста свои: помним по хосту, в окне — объединение.
            if (d && typeof d === "object") uibByHost[rec.token] = Array.isArray(d.uiButtons) ? d.uiButtons : [];
            applyState(d);
        });
        on(rec, "preview", function (d) { applyPreview(d); });
        on(rec, "pick", function (d) { if (hasFocus()) { if (d && d.on === false) stopPick(); else startPick(d && d.host); } });
        on(rec, "check", function (d) { if (hasFocus() && d && d.reqId) answerCheck(d); });
        on(rec, "reload", function () { render(true); });
        on(rec, "design", function (d) { if (hasFocus()) { if (d && d.on === false) stopDesign(); else toggleDesign(d && d.host); } });
        on(rec, "focus", function (d) { if (d && d.focused && hasFocus()) setOwnHost(rec.token); });
        on(rec, "module", function (d) { deliverModule(rec, d); });
        on(rec, "profile", function (d) { applyModuleProfile(d); });
        on(rec, "moduleReload", function (d) { hotReloadModule(rec, d); });
        on(rec, "ctx", function (d) { onCtx(rec, d); });
        on(rec, "vs", function (d) { deliverVs(rec, d); });
        on(rec, "moduleSet", function (d) { applyModuleSet(rec, d); });
    }
    function on(rec, ev, fn) {
        rec.es.addEventListener(ev, function (e) {
            var d = parse(e.data);
            try { fn(d); } catch (err) { report("событие " + ev, err); }
        });
    }
    function disconnect(token) {
        var rec = hosts[token];
        if (!rec) return;
        try { rec.es.close(); } catch (e) {}
        delete hosts[token];
        if (uibByHost[token]) { delete uibByHost[token]; UIB = mergeUib(null); }
        if (ownToken === token) ownToken = null;
    }
    function hasFocus() { try { return document.hasFocus(); } catch (e) { return true; } }

    function hostList(prefer) {
        var list = Object.keys(hosts).map(function (t) { return hosts[t]; });
        list.sort(function (a, b) { return (b.open ? 1 : 0) - (a.open ? 1 : 0); });
        if (prefer && validHost(prefer)) list = [prefer].concat(list.filter(function (h) { return h.token !== prefer.token; }));
        return list;
    }

    // timeoutMs — своё ожидание (долгие запросы модулей: компиляция); по умолчанию RPC_TIMEOUT_MS.
    // Оборвали по времени — ответ { timeout: true }, а не { net: true }: хост, скорее всего, жив и
    // ещё работает, и слать тот же запрос следующему хосту (второй раз выполнять) нельзя.
    function rpc(h, method, body, timeoutMs) {
        if (typeof fetch !== "function") return Promise.resolve({ ok: false, error: "нет fetch" });
        var ctl = typeof AbortController === "function" ? new AbortController() : null;
        var timedOut = false;
        var wait = timeoutMs > 0 ? Math.min(timeoutMs, 10 * 60000) : (PROTO.RPC_TIMEOUT_MS || 8000);
        var timer = setTimeout(function () { timedOut = true; if (ctl) ctl.abort(); }, wait);
        return fetch("http://127.0.0.1:" + h.port + "/rpc/" + h.token + "/" + method, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body || {}),
            cache: "no-store",
            signal: ctl ? ctl.signal : undefined,
        }).then(function (res) {
            if (res.status === 409) return { ok: false, retry: true };
            return res.json().catch(function () { return { ok: res.ok }; });
        }).catch(function (e) {
            if (timedOut) return { ok: false, error: "нет ответа за " + Math.round(wait / 1000) + " с", timeout: true };
            return { ok: false, error: String(e && e.message || e), net: true };
        })
          .then(function (out) { clearTimeout(timer); return out; });
    }

    /** Запрос к хостам по очереди, пока кто-то не ответит без retry (для команд — хост окна в фокусе). */
    function rpcFirst(method, body, prefer) {
        var list = hostList(prefer);
        var i = 0;
        function next() {
            if (i >= list.length) return Promise.resolve({ ok: false, error: "нет связи с расширением Moon Core" });
            return rpc(list[i++], method, body).then(function (r) { return r && (r.retry || r.net) ? next() : r; });
        }
        return next();
    }
    function rpcAny(method, body) { return rpcFirst(method, body, null); }

    // ---------------------------------------------------------------------------
    //  Модули: чужие рантаймы, впечатанные следом за нашим. Каждый берёт себе помощника
    //  window.__MOONCORE__.module("<id>"): события от своего расширения, запросы к нему,
    //  адрес своих ресурсов и журнал. Модуль, которого нет в boot, помощника не получит.
    //
    //  «Свой» хост. Окон VS Code может быть несколько, и окно подключено ко всем хостам.
    //  Данные вроде git-ветки относятся к конкретному окну (scope "window"), поэтому окно
    //  запоминает хост, который прислал «focus» в момент, когда само было в фокусе.
    //  Пока пары нет и хост один — он и свой.
    // ---------------------------------------------------------------------------
    var MOD_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
    var MOD_EV_RE = /^[a-z][\w.-]{0,39}$/i;
    var ownToken = null;
    var MODS = {};           // id -> {id, name, version, base, dataUrl, data?}
    var modSubs = {};        // id -> event -> [fn]
    var modLast = {};        // id -> event -> {all: payload|null, win: {token: payload}}
    var modApis = {};        // id -> помощник (один на модуль)
    var modProfile = {};     // id -> { save(): object, apply(object) } — часть модуля в профиле вида
    var modDispose = {};     // id -> [fn] — уборка модуля перед горячей перезагрузкой
    var modHot = {};         // id -> sha кода, уже перезапущенного в этом окне

    (Array.isArray(BOOT.modules) ? BOOT.modules : []).slice(0, 16).forEach(function (m) {
        if (!m || !MOD_ID_RE.test(String(m.id)) || MODS[m.id]) return;
        var base = typeof m.base === "string" ? m.base : "";
        if (canReadApp()) base = appUrl(base) || "";
        else if (!/^https?:\/\//.test(base)) base = "";                   // стенд отдаёт ресурсы по http
        if (base && !/\/$/.test(base)) base += "/";
        MODS[m.id] = {
            id: m.id, name: String(m.name || m.id).slice(0, 80), version: String(m.version || "").slice(0, 40), base: base,
            dataUrl: typeof m.dataUrl === "string" ? m.dataUrl : "",
            // Стенд (test/serve.js) не умеет vscode-file: данные приходят прямо в boot.
            data: (m.data && typeof m.data === "object") ? m.data : null,
            // Файл модуля рядом с оболочкой { src, integrity } (ленивая загрузка, повторное включение)
            // и ленивость { delay }. Ленивый модуль не выполнен, пока его не загрузят.
            file: m.file && typeof m.file.src === "string" && /^[\w.-]+\.js$/.test(m.file.src) ? { src: m.file.src, integrity: String(m.file.integrity || "") } : null,
            lazy: m.lazy && typeof m.lazy === "object" ? { delay: Math.max(0, +m.lazy.delay || 0) } : null,
            loaded: !(m.lazy && m.file), off: false,
        };
    });

    // Второй путь найти свой хост — спросить самим. Окно получило фокус: через короткую паузу
    // (хосту нужно время заметить смену фокуса) опрашиваем все хосты «в фокусе ли твоё окно?».
    // Ответ «да» при нашем же фокусе — это наш хост. Вместе с событием «focus» от хоста это
    // закрывает гонки при быстром переключении окон: какой путь сработает первым, тот и прав.
    var focusProbeSeq = 0;
    function probeOwnHost() {
        var seq = ++focusProbeSeq;
        [250, 1200].forEach(function (delay) {
            setTimeout(function () {
                if (seq !== focusProbeSeq || !hasFocus()) return;
                Object.keys(hosts).forEach(function (t) {
                    var h = hosts[t];
                    if (!h || !h.open) return;
                    rpc(h, "focus", {}).then(function (r) {
                        if (seq === focusProbeSeq && r && r.focused === true && hasFocus() && hosts[t]) setOwnHost(t);
                    });
                });
            }, delay);
        });
    }
    try { window.addEventListener("focus", probeOwnHost); } catch (e) {}

    function isOwnHost(token) {
        if (ownToken) return token === ownToken;
        return Object.keys(hosts).length === 1 && !!hosts[token];
    }

    function setOwnHost(token) {
        if (ownToken === token) return;
        ownToken = token;
        if (ctxByHost[token]) applyCtx(ctxByHost[token]);
        // Данные окна от нового «своего» хоста уже могли прийти раньше — отдаём их модулям.
        Object.keys(modLast).forEach(function (id) {
            Object.keys(modLast[id]).forEach(function (ev) {
                var p = modLast[id][ev].win[token];
                if (p) fireModule(id, ev, p.data);
            });
        });
    }

    function fireModule(id, ev, data) {
        var subs = modSubs[id] && modSubs[id][ev];
        if (!subs) return;
        subs.slice().forEach(function (fn) {
            try { fn(data); } catch (err) { report("модуль " + id + ": событие " + ev, err); }
        });
    }

    function deliverModule(rec, d) {
        if (!d || !MODS[d.id] || !MOD_EV_RE.test(String(d.event))) return;
        // Разовое событие (клик, команда): не кэшируется — новые подписчики его не получат.
        // Модуль ещё не загружен (ленивый) или выключен — событие ждёт загрузки.
        if (d.once) {
            if (d.scope === "window" && !isOwnHost(rec.token)) return;
            if (!MODS[d.id].loaded || MODS[d.id].off) { queueOnce(d); return; }
            fireModule(d.id, d.event, d.data);
            return;
        }
        var slot = (modLast[d.id] = modLast[d.id] || {});
        var last = (slot[d.event] = slot[d.event] || { all: null, win: {} });
        if (d.scope === "window") {
            last.win[rec.token] = d;
            if (!isOwnHost(rec.token)) return;                          // это данные другого окна
        } else {
            last.all = d;
        }
        fireModule(d.id, d.event, d.data);
    }

    function lastModule(id, ev) {
        var last = modLast[id] && modLast[id][ev];
        if (!last) return undefined;
        var tokens = Object.keys(last.win).filter(isOwnHost);
        if (tokens.length) return last.win[tokens[0]].data;
        return last.all ? last.all.data : undefined;
    }

    /** Запрос модуля: сначала свой хост; хост без обработчика или без связи — следующий. */
    function moduleRpc(id, method, body, timeoutMs) {
        var prefer = ownToken && hosts[ownToken] ? hosts[ownToken] : null;
        var list = hostList(prefer);
        var i = 0;
        var req = { id: id, method: method, body: body === undefined ? null : body };
        function next() {
            if (i >= list.length) return Promise.resolve({ ok: false, error: "нет связи с расширением модуля" });
            return rpc(list[i++], "module", req, timeoutMs).then(function (r) {
                return r && (r.retry || r.net || r.error === "no handler") ? next() : r;
            });
        }
        return next();
    }

    /** Шлюз к API VS Code: сначала хост своего окна. */
    function nativeRpc(id, body) {
        var prefer = ownToken && hosts[ownToken] ? hosts[ownToken] : null;
        return rpcFirst("native", Object.assign({ id: id }, body), prefer);
    }

    /** Состояние всех модулей для сохраняемого профиля: { id: object }. */
    function collectModuleProfile() {
        var out = {};
        Object.keys(modProfile).forEach(function (id) {
            try {
                var v = modProfile[id].save();
                if (v && typeof v === "object" && !Array.isArray(v)) out[id] = JSON.parse(JSON.stringify(v));
            } catch (err) { report("модуль " + id + ": сохранение в профиль", err); }
        });
        return out;
    }
    /** Применён профиль: каждый модуль получает свою часть (если она в профиле есть). */
    function applyModuleProfile(d) {
        if (!d || !d.modules || typeof d.modules !== "object") return;
        Object.keys(d.modules).forEach(function (id) {
            var h = modProfile[id], part = d.modules[id];
            if (!h || !part || typeof part !== "object") return;
            try { h.apply(part, String(d.name || "")); } catch (err) { report("модуль " + id + ": применение профиля", err); }
        });
    }

    function moduleApi(id) {
        if (modApis[id]) return modApis[id];
        var m = MODS[id];
        if (!m) return null;
        modApis[id] = {
            id: m.id, name: m.name, version: m.version,
            /** Адрес папки ресурсов модуля (со слэшем на конце) — для картинок, шрифтов. */
            base: m.base,
            /** Подписка на событие своего расширения. Есть значение — fn получит его сразу (асинхронно). Возвращает отписку. */
            on: function (ev, fn) {
                if (!MOD_EV_RE.test(String(ev)) || typeof fn !== "function") return function () {};
                var byEv = (modSubs[id] = modSubs[id] || {});
                var subs = (byEv[ev] = byEv[ev] || []);
                subs.push(fn);
                var cur = lastModule(id, ev);
                if (cur !== undefined) setTimeout(function () {
                    if (subs.indexOf(fn) !== -1) { try { fn(cur); } catch (err) { report("модуль " + id + ": событие " + ev, err); } }
                }, 0);
                return function () { var i = subs.indexOf(fn); if (i !== -1) subs.splice(i, 1); };
            },
            /** Последнее значение события (или undefined). */
            get: function (ev) { return lastModule(id, ev); },
            /** Запрос к своему расширению: Promise<{ok, result?, error?}>. */
            rpc: function (method, body, opts) {
                if (!MOD_EV_RE.test(String(method))) return Promise.resolve({ ok: false, error: "bad method" });
                var t = opts && typeof opts.timeoutMs === "number" && isFinite(opts.timeoutMs) ? opts.timeoutMs : 0;
                return moduleRpc(id, method, body, t);
            },
            /** Ошибка модуля — в журнал Moon Core (Output «Moon Core»). */
            log: function (where, err) { report("модуль " + id + (err === undefined ? "" : ": " + where), err === undefined ? where : err); },
            /**
             * Файл данных модуля — синхронно, прямо при старте (моста ещё нет). Объект или null.
             * Сюда модуль кладёт то, что должно пережить очистку localStorage (например, свой конфиг).
             */
            data: function () {
                var v = canReadApp() ? parse(readSync(m.dataUrl)) : m.data;
                return (v && typeof v === "object" && !Array.isArray(v)) ? v : null;
            },
            /** Сохранить файл данных модуля (объект до 1 МБ): Promise<{ok, error?}>. Запись делает хост. */
            saveData: function (obj) {
                if (!obj || typeof obj !== "object" || Array.isArray(obj)) return Promise.resolve({ ok: false, error: "data must be object" });
                if (!canReadApp()) m.data = JSON.parse(JSON.stringify(obj));
                return rpcAny("moduleData", { id: id, data: obj });
            },
            /**
             * Часть модуля в профиле вида Moon Core. save() — снимок состояния модуля при сохранении
             * профиля; apply(obj, name) — вернуть его при применении профиля (в том числе по
             * контексту). Так один профиль переключает и раскладку интерфейса, и, например, фон.
             */
            profile: function (hooks) {
                if (!hooks || typeof hooks.save !== "function" || typeof hooks.apply !== "function") return false;
                modProfile[id] = { save: hooks.save, apply: hooks.apply };
                return true;
            },
            /**
             * Уборка перед горячей перезагрузкой (режим разработки модуля): сними свои узлы, стили,
             * таймеры и флаг «уже запущен», иначе новый код увидит старый и не стартует.
             */
            onDispose: function (fn) { if (typeof fn === "function") (modDispose[id] = modDispose[id] || []).push(fn); },
            /** Сколько раз модуль перезапущен в этом окне (0 — обычный запуск). */
            hot: 0,
            /**
             * Настоящий API VS Code через хост своего окна (не подделки в вёрстке):
             *   vscode.statusItem(id, { text, tooltip, side, priority, hidden, dispose }) — элемент статусбара,
             *     клик приходит событием "nativeClick" { item };
             *   vscode.notify(text, { kind, buttons }), vscode.quickPick(items, { placeholder, many }),
             *   vscode.input(prompt, value), vscode.open(path), vscode.config(key), vscode.context().
             * Каждый вызов — Promise<{ ok, result?, error? }>.
             */
            vscode: {
                statusItem: function (item, props) { return nativeRpc(id, Object.assign({}, props || {}, { op: "statusItem", item: String(item) })); },
                notify: function (text, o) { return nativeRpc(id, Object.assign({}, o || {}, { op: "notify", text: String(text) })); },
                quickPick: function (items, o) { return nativeRpc(id, Object.assign({}, o || {}, { op: "quickPick", items: items })); },
                input: function (prompt, value) { return nativeRpc(id, { op: "input", prompt: String(prompt || ""), value: value == null ? "" : String(value) }); },
                open: function (p, o) { return nativeRpc(id, Object.assign({}, o || {}, { op: "open", path: String(p) })); },
                config: function (key) { return nativeRpc(id, { op: "config", key: String(key) }); },
                context: function () { return nativeRpc(id, { op: "context" }); },
            },
            /**
             * Сервис окна VS Code по имени ("statusbarService", "codeEditorService"...) или null,
             * если глубокая интеграция выключена. Внутренний API VS Code: между версиями меняется.
             */
            service: function (name) { return service(name); },
            /** Есть ли сейчас связь хотя бы с одним хостом. */
            connected: function () { return Object.keys(hosts).some(function (t) { return hosts[t].open; }); },
        };
        // События VS Code, команды, окна, общая шина, части окна (21-vs.js, 83-windows.js, 84-shared.js).
        extendModuleApi(id, modApis[id]);
        return modApis[id];
    }

    /**
     * Горячая перезагрузка модуля (режим разработки, команда «Moon Core: Режим разработки модуля»).
     * Хост сообщает, что код модуля изменился; окно убирает старый модуль (его onDispose),
     * забирает новый код у хоста (метод moduleCode — хост отдаёт код только модулю в режиме
     * разработки) и выполняет его тем же путём, что и сниппеты: <script nonce>. Последние
     * события модуля остаются в кэше — новый код получит их при подписке.
     */
    function hotReloadModule(rec, d) {
        if (!d || !MODS[d.id] || !/^[0-9a-f]{64}$/.test(String(d.sha))) return;
        var id = d.id;
        if (modHot[id] === d.sha) return;                      // уже перезапущен (событие от другого хоста)
        modHot[id] = d.sha;
        rpc(rec, "moduleCode", { id: id }).then(function (r) {
            if (!r || !r.ok || typeof r.code !== "string") {
                // Код не пришёл (хост занят, сеть) — следующее событие с тем же sha повторит попытку.
                if (modHot[id] === d.sha) delete modHot[id];
                report("модуль " + id + ": горячая перезагрузка", (r && r.error) || "хост не отдал код");
                return;
            }
            var list = modDispose[id] || [];
            modDispose[id] = [];
            for (var i = list.length - 1; i >= 0; i--) { try { list[i](); } catch (e) { report("модуль " + id + ": уборка", e); } }
            delete modSubs[id];
            delete modProfile[id];
            var api = moduleApi(id);
            if (api) api.hot = (api.hot || 0) + 1;
            var s = document.createElement("script");
            if (NONCE) s.setAttribute("nonce", NONCE);
            s.setAttribute("data-mooncore-module", id);
            s.textContent = trustedScript("try{\n" + r.code + "\n}catch(e){window.__MOONCORE__.fail(" + JSON.stringify("модуль " + id) + ",e);}\n//# sourceURL=mooncore-module/" + id + ".js");
            headEl().appendChild(s);
            s.remove();
            try { toast("Moon Core: модуль " + (MODS[id].name || id) + " перезапущен"); } catch (e) {}
        });
    }

    // ---------------------------------------------------------------------------
    //  VS Code для модулей: события редактора (mc.vscode.on), код под курсором и подсказки
    //  языкового сервера (mc.vscode.symbol), подсветка кода (decorate), вкладки, части окна
    //  (mc.layout) и команды модуля в палитре и контекстном меню (mc.commands).
    //
    //  Подписка уходит ВСЕМ хостам (каждый шлёт события своего окна), а применяются события только
    //  своего хоста. Хост держит подписку, пока окно подтверждает её раз в минуту. full-часть
    //  события (слово, выделение, путь, тексты ошибок) хост отдаёт модулям с правом editor.read —
    //  окно передаёт её только им (d.readers).
    // ---------------------------------------------------------------------------
    var VS_KINDS = ["editor", "cursor", "save", "diagnostics", "debug", "terminal", "task", "git", "theme"];
    var vsSubs = {};         // id модуля -> kind -> [fn]
    var vsLast = {};         // kind -> последнее событие своего хоста { data, full, readers }
    var modCmds = {};        // id модуля -> команды, объявленные из окна

    function vsKindsOf(id) {
        var byKind = vsSubs[id] || {};
        return Object.keys(byKind).filter(function (k) { return byKind[k].length > 0; });
    }
    /** Подписки модуля id (или всех) — всем хостам. */
    function vsResubscribe(onlyId) {
        Object.keys(vsSubs).forEach(function (id) {
            if (onlyId && id !== onlyId) return;
            var kinds = vsKindsOf(id);
            if (!kinds.length || !MODS[id] || MODS[id].off) return;
            Object.keys(hosts).forEach(function (t) { if (hosts[t].open) rpc(hosts[t], "vsSubscribe", { id: id, kinds: kinds }); });
        });
        Object.keys(modCmds).forEach(function (id) {
            if (onlyId && id !== onlyId) return;
            Object.keys(hosts).forEach(function (t) { if (hosts[t].open) rpc(hosts[t], "modCommands", { id: id, commands: modCmds[id] }); });
        });
    }
    setInterval(function () { try { vsResubscribe(null); } catch (e) {} }, 60000);

    /** Событие для модуля id: базовая часть плюс full, если модуль среди читателей. */
    function vsPayload(d, id) {
        if (!d || d.data == null) return null;
        var out = {};
        Object.keys(d.data).forEach(function (k) { out[k] = d.data[k]; });
        if (d.full && Array.isArray(d.readers) && d.readers.indexOf(id) !== -1) Object.keys(d.full).forEach(function (k) { out[k] = d.full[k]; });
        return out;
    }

    function deliverVs(rec, d) {
        if (!d || VS_KINDS.indexOf(d.kind) === -1 || !isOwnHost(rec.token)) return;
        vsLast[d.kind] = d;
        Object.keys(vsSubs).forEach(function (id) {
            var list = vsSubs[id][d.kind];
            if (!list || !list.length || !MODS[id] || MODS[id].off) return;
            var p = vsPayload(d, id);
            list.slice().forEach(function (fn) { try { fn(p); } catch (e) { report("модуль " + id + ": событие VS Code " + d.kind, e); } });
        });
    }

    // Части окна по вёрстке VS Code: видимость и размеры читаем сами, переключаем — командой.
    var PART_SEL = {
        sidebar: ".part.sidebar", panel: ".part.panel", auxiliarybar: ".part.auxiliarybar", activitybar: ".part.activitybar",
        statusbar: ".part.statusbar", titlebar: ".part.titlebar", editor: ".part.editor", minimap: ".minimap",
    };
    function partEl(part) { return PART_SEL[part] ? document.querySelector(PART_SEL[part]) : null; }
    function partRect(el) {
        if (!el) return null;
        var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        var st = null;
        try { st = window.getComputedStyle ? getComputedStyle(el) : null; } catch (e) {}
        var shown = !!r && r.width > 0 && r.height > 0 && !(st && (st.display === "none" || st.visibility === "hidden"));
        return { x: r ? Math.round(r.left) : 0, y: r ? Math.round(r.top) : 0, w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0, visible: shown };
    }
    function layoutApi(id) {
        var visible = function (part) { var r = partRect(partEl(part)); return !!(r && r.visible); };
        var toggle = function (part) { return nativeRpc(id, { op: "layout", part: String(part) }); };
        var set = function (part, want) {
            if (visible(part) === want) return Promise.resolve({ ok: true, changed: false });
            return toggle(part).then(function (r) { return r && r.ok ? { ok: true, changed: true } : r; });
        };
        return {
            /** Видна ли часть окна: sidebar, panel, auxiliarybar, activitybar, statusbar, titlebar, editor, minimap. */
            visible: visible,
            /** Размеры и видимость всех частей: { part: { x, y, w, h, visible } }. */
            sizes: function () {
                var out = {};
                Object.keys(PART_SEL).forEach(function (p) { var r = partRect(partEl(p)); if (r) out[p] = r; });
                return out;
            },
            /** Переключить часть (нужно право layout); ещё zen и maximizedPanel. */
            toggle: toggle,
            show: function (part) { return set(part, true); },
            hide: function (part) { return set(part, false); },
        };
    }

    function commandsApi(id, api) {
        return {
            /** Объявить команды модуля: [{ id, title, langs?, context? }] — в палитре и контекстном меню. */
            register: function (list) {
                modCmds[id] = (Array.isArray(list) ? list : []).slice(0, 20).map(function (c) {
                    return { id: String(c && c.id || ""), title: String(c && c.title || ""), langs: Array.isArray(c && c.langs) ? c.langs.slice(0, 20) : [], context: !!(c && c.context) };
                });
                vsResubscribe(id);
                return modCmds[id].length;
            },
            /** Нажали команду модуля: fn(ctx) — { lang, line, word?, selection?, path? } (слово и путь — с editor.read). */
            on: function (cmdId, fn) {
                return api.on("command", function (d) { if (d && d.id === cmdId) fn(d.ctx || {}); });
            },
        };
    }

    /** Дополнить помощника модуля (зовёт moduleApi в 20-modules.js). */
    function extendModuleApi(id, api) {
        var v = api.vscode;
        /**
         * Событие VS Code: editor, cursor, save, diagnostics, debug, terminal, task, git, theme.
         * Текущее значение приходит сразу. Возвращает отписку.
         */
        v.on = function (kind, fn) {
            if (VS_KINDS.indexOf(kind) === -1 || typeof fn !== "function") return function () {};
            var byKind = (vsSubs[id] = vsSubs[id] || {});
            var list = (byKind[kind] = byKind[kind] || []);
            list.push(fn);
            if (vsLast[kind]) {
                var cur = vsPayload(vsLast[kind], id);
                setTimeout(function () { if (list.indexOf(fn) !== -1) { try { fn(cur); } catch (e) { report("модуль " + id + ": событие VS Code " + kind, e); } } }, 0);
            }
            if (list.length === 1) vsResubscribe(id);
            return function () { var i = list.indexOf(fn); if (i !== -1) list.splice(i, 1); };
        };
        /** Последнее событие VS Code (или undefined). */
        v.last = function (kind) { return vsLast[kind] ? vsPayload(vsLast[kind], id) : undefined; };
        /** Код под курсором (право editor.read): what = word | hover | definition | symbols. */
        v.symbol = function (what) { return nativeRpc(id, { op: "symbol", what: String(what || "word") }); };
        /** Подсветка в активном редакторе (право decorations): key, стиль, [{ line, start?, end?, hover? }]. */
        v.decorate = function (key, style, ranges) { return nativeRpc(id, { op: "decorate", key: String(key), style: style || {}, ranges: ranges || [] }); };
        v.undecorate = function (key) { return nativeRpc(id, { op: "undecorate", key: String(key) }); };
        /** Открытые вкладки по группам (пути — с правом editor.read). */
        v.tabs = function () { return nativeRpc(id, { op: "tabs" }); };
        api.layout = layoutApi(id);
        api.commands = commandsApi(id, api);
        /** Плавающее окно модуля (83-windows.js). */
        api.window = function (opts) { return createWindow(id, opts); };
        /** Общая шина модулей (84-shared.js): значение, которое видят другие модули этого окна. */
        api.share = function (key, value) { return shareValue(id, key, value); };
        api.shared = function (key, fn) { return sharedOn(key, fn); };
        api.sharedGet = function (key) { return sharedGet(key); };
        /** Загрузить другой (ленивый) модуль: Promise<boolean>. */
        api.load = function (other) { return loadModule(String(other)); };
    }

    // ---------------------------------------------------------------------------
    //  Жизнь модуля в окне без перезагрузки.
    //    - Ленивый модуль ("lazy" в манифесте) не грузится при старте: файл рядом с оболочкой
    //      подключается по его команде, по просьбе другого модуля (mc.load / __MOONCORE__.loadModule)
    //      или через delay мс после загрузки окна. Разовые события (команда) ждут загрузки.
    //    - Хост сообщает список разрешённых модулей (событие moduleSet): выключенный модуль
    //      убирается сразу (его onDispose, подписки, окна, значения в общей шине), включённый
    //      снова — загружается тем же файлом. Модуль, которого нет в оболочке, требует перезагрузки.
    // ---------------------------------------------------------------------------
    var onceQueue = {};      // id -> [разовое событие], ждущее загрузки модуля
    var loadingMod = {};     // id -> Promise загрузки

    function queueOnce(d) {
        var q = (onceQueue[d.id] = onceQueue[d.id] || []);
        q.push(d);
        if (q.length > 20) q.shift();
        if (!MODS[d.id].off) loadModule(d.id);
    }
    function flushOnce(id) {
        var q = onceQueue[id] || [];
        delete onceQueue[id];
        q.forEach(function (d) { fireModule(d.id, d.event, d.data); });
    }

    /** Загрузить файл модуля (ленивого или выключенного раньше). Promise<boolean>. */
    function loadModule(id) {
        var m = MODS[id];
        if (!m) return Promise.resolve(false);
        if (m.loaded && !m.off) return Promise.resolve(true);
        if (loadingMod[id]) return loadingMod[id];
        if (!m.file) {
            report("модуль " + id, "модуль встроен в оболочку целиком — снова включить его можно только перезагрузкой окна");
            return Promise.resolve(false);
        }
        m.off = false;
        loadingMod[id] = new Promise(function (resolve) {
            var s = document.createElement("script");
            var done = function (ok) {
                delete loadingMod[id];
                if (ok) { m.loaded = true; setTimeout(function () { flushOnce(id); }, 0); }
                resolve(ok);
            };
            var finish = function (ok) {
                window.__MOONCORE__._modDone(id);
                if (ok) { done(true); return; }
                // Файла нет или он другой (integrity): модуль обновило или убрало другое окно. Берём
                // одобренный код у хоста и выполняем тем же путём, что сниппеты, — <script nonce>.
                rpcFirst("moduleCode", { id: id, lazy: true }, ownToken && hosts[ownToken] ? hosts[ownToken] : null).then(function (r) {
                    if (!r || !r.ok || typeof r.code !== "string") {
                        report("модуль " + id, "файл модуля не загрузился (" + m.file.src + "), хост код не отдал: " + ((r && r.error) || "нет связи"));
                        done(false);
                        return;
                    }
                    var s2 = document.createElement("script");
                    if (NONCE) s2.setAttribute("nonce", NONCE);
                    s2.setAttribute("data-mooncore-module", id);
                    try {
                        s2.textContent = trustedScript("try{\n" + r.code + "\n}catch(e){window.__MOONCORE__.fail(" + JSON.stringify("модуль " + id) + ",e);}\n//# sourceURL=mooncore-module/" + id + ".js");
                        headEl().appendChild(s2);
                        s2.remove();
                    } catch (e) { report("модуль " + id + ": код от хоста", e); done(false); return; }
                    done(true);
                });
            };
            if (NONCE) s.setAttribute("nonce", NONCE);
            if (m.file.integrity) s.setAttribute("integrity", m.file.integrity);
            s.setAttribute("data-mooncore-module", id);
            s.onload = function () { finish(!!modRan[id]); };
            s.onerror = function () { finish(false); };
            modRan[id] = false;
            window.__MOONCORE__._modStart(id);
            // Адрес — через политику Trusted Types (05-trusted.js): VS Code с CSP иначе откажет.
            // Отказ здесь — тот же путь, что и незагрузившийся файл: код у хоста.
            try {
                s.src = trustedScriptUrl((typeof BOOT.moduleFileBase === "string" ? BOOT.moduleFileBase : "") + m.file.src);
                headEl().appendChild(s);
            } catch (e) { report("модуль " + id + ": адрес файла", e); finish(false); }
        });
        return loadingMod[id];
    }

    /** Выключить модуль в этом окне: его уборка, подписки, окна и значения в общей шине. */
    function disableModule(id) {
        var m = MODS[id];
        if (!m || m.off) return;
        m.off = true;
        var list = modDispose[id] || [];
        modDispose[id] = [];
        for (var i = list.length - 1; i >= 0; i--) { try { list[i](); } catch (e) { report("модуль " + id + ": уборка", e); } }
        delete modSubs[id];
        delete modProfile[id];
        delete vsSubs[id];
        delete modCmds[id];
        delete onceQueue[id];
        closeModuleWindows(id);
        sharedDrop(id);
        m.loaded = false;
        try { toast("Moon Core: модуль " + (m.name || id) + " выключен"); } catch (e) {}
    }

    function applyModuleSet(rec, d) {
        // Разрешения общие для всех окон (globalState), поэтому годится любой хост: список шлёт тот,
        // кто только что их поменял, а при подключении — каждый.
        if (!d || !Array.isArray(d.ids) || !rec) return;
        Object.keys(MODS).forEach(function (id) {
            var want = d.ids.indexOf(id) !== -1, m = MODS[id];
            if (!want && !m.off) disableModule(id);
            else if (want && m.off) {
                m.off = false;
                if (!m.lazy) loadModule(id).then(function (ok) { if (ok) { try { toast("Moon Core: модуль " + (m.name || id) + " включён"); } catch (e) {} } });
            }
        });
    }

    // Ленивые модули с задержкой: после загрузки окна.
    function scheduleLazy() {
        Object.keys(MODS).forEach(function (id) {
            var m = MODS[id];
            if (m.lazy && m.lazy.delay > 0 && !m.loaded) setTimeout(function () { if (!m.off) loadModule(id); }, m.lazy.delay);
        });
    }

    // ---------------------------------------------------------------------------
    //  Сниппеты.
    // ---------------------------------------------------------------------------
    var saved = {};          // id -> {kind, code} — сохранённые включённые сниппеты
    var previews = {};       // id -> code — несохранённая правка CSS
    var styles = {};         // id -> <style>
    var running = {};        // id -> {code, disposers}
    var rev = "";
    var domReady = false;

    function applyState(st) {
        if (!st || !Array.isArray(st.snippets)) return;
        var next = {};
        st.snippets.slice(0, PROTO.MAX_SNIPPETS).forEach(function (s) {
            if (!s || !ID_RE.test(String(s.id)) || typeof s.code !== "string" || s.code.length > PROTO.MAX_SNIPPET) return;
            next[s.id] = { kind: /\.js$/.test(s.id) ? "js" : "css", code: s.code };
        });
        // Сохранили ровно то, что было в превью, — превью больше не нужно.
        Object.keys(previews).forEach(function (id) { if (!next[id] || next[id].code === previews[id]) delete previews[id]; });
        saved = next;
        rev = String(st.rev || "");
        adoptDesign(st);
        render(false);
    }

    function applyPreview(d) {
        if (!d || !ID_RE.test(String(d.id)) || /\.js$/.test(d.id)) return;
        if (typeof d.code === "string" && d.code.length <= PROTO.MAX_SNIPPET) previews[d.id] = d.code;
        else delete previews[d.id];
        renderCss();
    }

    function headEl() { return document.head || document.documentElement; }

    function renderCss() {
        var ids = Object.keys(saved).filter(function (id) { return saved[id].kind === "css"; }).sort();
        Object.keys(styles).forEach(function (id) {
            if (ids.indexOf(id) === -1) { try { styles[id].remove(); } catch (e) {} delete styles[id]; }
        });
        var reorder = false;
        ids.forEach(function (id) {
            var code = previews[id] != null ? previews[id] : saved[id].code;
            var el = styles[id];
            if (!el) {
                el = document.createElement("style");
                el.setAttribute("data-mooncore", id);
                if (NONCE) el.setAttribute("nonce", NONCE);
                styles[id] = el;
                reorder = true;
            }
            if (el.textContent !== code) el.textContent = code;
            if (!el.isConnected) reorder = true;
        });
        // Порядок = порядок имён (каскад предсказуем): перекладываем в конец <head> по очереди.
        if (reorder) ids.forEach(function (id) { headEl().appendChild(styles[id]); });
        if (reorder && designStyle) headEl().appendChild(designStyle);
        renderDesignCss();
    }

    function renderJs(force) {
        Object.keys(running).forEach(function (id) {
            var s = saved[id];
            if (force || !s || s.kind !== "js" || s.code !== running[id].code) stopJs(id);
        });
        if (!domReady) return;
        Object.keys(saved).sort().forEach(function (id) {
            if (saved[id].kind === "js" && !running[id]) runJs(id, saved[id].code);
        });
    }

    function render(force) {
        try { renderCss(); } catch (e) { report("CSS", e); }
        try { renderJs(force); } catch (e) { report("JS", e); }
    }

    // ---------------------------------------------------------------------------
    //  JS-сниппеты: помощник mc и уборка.
    // ---------------------------------------------------------------------------
    function makeApi(id, disposers) {
        var add = function (fn) { disposers.push(fn); return fn; };
        var api = {
            id: id,
            version: BOOT.version || "",
            onDispose: function (fn) { if (typeof fn === "function") add(fn); },
            el: function (tag, props, children) {
                var n = document.createElement(tag);
                if (props) Object.keys(props).forEach(function (k) {
                    if (k === "style" && typeof props[k] === "object") Object.assign(n.style, props[k]);
                    else if (k === "attrs" && typeof props[k] === "object") Object.keys(props[k]).forEach(function (a) { n.setAttribute(a, props[k][a]); });
                    else n[k] = props[k];
                });
                (children || []).forEach(function (c) { n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
                return n;
            },
            mount: function (parent, node, before) {
                if (!parent || !node) return node;
                parent.insertBefore(node, before || null);
                if (node.setAttribute) node.setAttribute("data-mooncore-owner", id);
                add(function () { try { node.remove(); } catch (e) {} });
                return node;
            },
            css: function (text) {
                var st = document.createElement("style");
                st.setAttribute("data-mooncore-js", id);
                if (NONCE) st.setAttribute("nonce", NONCE);
                st.textContent = String(text);
                headEl().appendChild(st);
                add(function () { try { st.remove(); } catch (e) {} });
                return st;
            },
            on: function (target, ev, fn, opt) {
                target.addEventListener(ev, fn, opt);
                add(function () { try { target.removeEventListener(ev, fn, opt); } catch (e) {} });
            },
            every: function (ms, fn) {
                var t = setInterval(function () { try { fn(); } catch (e) { report("mc.every", e, id); } }, Math.max(50, ms | 0));
                add(function () { clearInterval(t); });
                return t;
            },
            after: function (ms, fn) {
                var t = setTimeout(function () { try { fn(); } catch (e) { report("mc.after", e, id); } }, ms | 0);
                add(function () { clearTimeout(t); });
                return t;
            },
            watch: function (selector, cb) {
                var seen = typeof WeakSet === "function" ? new WeakSet() : null;
                var queued = false, stopped = false;
                var scan = function () {
                    queued = false;
                    if (stopped) return;
                    var list;
                    try { list = document.querySelectorAll(selector); } catch (e) { report("mc.watch: плохой селектор " + selector, e, id); stopped = true; return; }
                    for (var i = 0; i < list.length; i++) {
                        var el = list[i];
                        if (seen && seen.has(el)) continue;
                        if (seen) seen.add(el);
                        try { var r = cb(el); if (typeof r === "function") add(r); } catch (e) { report("mc.watch", e, id); }
                    }
                };
                var mo = new MutationObserver(function () { if (!queued) { queued = true; requestAnimationFrame(scan); } });
                mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
                scan();
                var stop = function () { stopped = true; mo.disconnect(); };
                add(stop);
                return stop;
            },
            command: function (cmd) {
                var args = Array.prototype.slice.call(arguments, 1);
                return rpcFirst("command", { id: String(cmd), args: args, from: id }, null).then(function (r) {
                    if (!r || !r.ok) throw new Error((r && r.error) || "команда не выполнена");
                    return r.result;
                });
            },
            toast: function (text) { toast(text); },
            log: function () { try { console.log.apply(console, ["[moon:" + id + "]"].concat([].slice.call(arguments))); } catch (e) {} },
            $: function (sel, root) { return (root || document).querySelector(sel); },
            $$: function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); },
        };
        return api;
    }

    window.__MOONCORE_RUN__ = window.__MOONCORE_RUN__ || {};

    function runJs(id, code) {
        var rec = { code: code, disposers: [] };
        running[id] = rec;
        var api = makeApi(id, rec.disposers);
        var fn = null;
        try { fn = new Function("mc", "\"use strict\";\n" + code + "\n//# sourceURL=mooncore/" + id); }
        catch (e) {
            if (!isCodeBlocked(e)) { report("синтаксис", e, id); return; }
            fn = null;       // CSP или Trusted Types запрещают eval — исполняем через <script nonce>
        }
        if (fn) {
            try {
                var r = fn(api);
                if (typeof r === "function") rec.disposers.push(r);
                else if (r && typeof r.then === "function") r.catch(function (e) { report("async", e, id); });
            } catch (e) { report("выполнение", e, id); }
            return;
        }
        window.__MOONCORE_RUN__[id] = api;
        var s = document.createElement("script");
        if (NONCE) s.setAttribute("nonce", NONCE);
        s.textContent = trustedScript("(function(mc){\"use strict\";try{\n" + code + "\n}catch(e){window.__MOONCORE__.fail(" + JSON.stringify(id) + ",e);}})(window.__MOONCORE_RUN__[" + JSON.stringify(id) + "]);");
        headEl().appendChild(s);
        s.remove();
    }

    function stopJs(id) {
        var rec = running[id];
        if (!rec) return;
        delete running[id];
        delete window.__MOONCORE_RUN__[id];
        for (var i = rec.disposers.length - 1; i >= 0; i--) {
            try { rec.disposers[i](); } catch (e) { report("уборка", e, id); }
        }
    }

    // ---------------------------------------------------------------------------
    //  Тост.
    // ---------------------------------------------------------------------------
    var toastEl = null, toastTimer = null;
    function toast(text) {
        if (!document.body) return;
        if (!toastEl) {
            toastEl = document.createElement("div");
            toastEl.setAttribute("data-mooncore-ui", "toast");
            Object.assign(toastEl.style, {
                position: "fixed", left: "50%", bottom: "48px", transform: "translateX(-50%)", zIndex: String(Z + 5),
                padding: "8px 14px", borderRadius: "8px", font: "12px/1.4 var(--vscode-font-family, sans-serif)",
                background: "var(--vscode-editorWidget-background, #1e1e2e)", color: "var(--vscode-editorWidget-foreground, #cdd6f4)",
                border: "1px solid var(--vscode-focusBorder, #89b4fa)", boxShadow: "0 6px 24px rgba(0,0,0,.35)", pointerEvents: "none",
                maxWidth: "70vw", whiteSpace: "pre-wrap",
            });
        }
        toastEl.textContent = String(text);
        document.body.appendChild(toastEl);
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { if (toastEl) toastEl.remove(); }, 2600);
    }

    // ---------------------------------------------------------------------------
    //  Селектор для элемента: короткий и устойчивый к перестройке DOM.
    // ---------------------------------------------------------------------------
    var STATE_CLS = /^(focused|focus|selected|active|checked|expanded|collapsed|hover|hovered|dirty|dragging|drop-target|visible|highlighted|disabled|pressed|mouseover|synthetic-focus|is-[\w-]+|has-[\w-]+|mooncore[\w-]*)$/;
    function cssEsc(s) {
        if (window.CSS && typeof CSS.escape === "function") return CSS.escape(s);
        return String(s).replace(/[^\w-]/g, function (c) { return "\\" + c; });
    }
    function stableClasses(el) {
        return Array.prototype.filter.call(el.classList || [], function (c) {
            return c && c.length < 40 && !STATE_CLS.test(c) && !/\d{3,}/.test(c) && !/^mtk\d/.test(c);
        });
    }
    function stableId(id) { return !!id && id.length < 60 && !/\d{2,}|_\d/.test(id); }
    function count(sel) { try { return document.querySelectorAll(sel).length; } catch (e) { return Infinity; } }
    function hits(sel, el) { try { return Array.prototype.indexOf.call(document.querySelectorAll(sel), el) !== -1; } catch (e) { return false; } }

    function segment(el) {
        if (stableId(el.id)) return { text: "#" + cssEsc(el.id), anchor: true };
        var s = el.tagName.toLowerCase() + stableClasses(el).slice(0, 3).map(function (c) { return "." + cssEsc(c); }).join("");
        var anchor = el.classList && el.classList.contains("part") || (s.indexOf(".") !== -1 && count(s) === 1);
        return { text: s, anchor: !!anchor };
    }

    function selectorFor(el) {
        if (!el || el.nodeType !== 1) return "";
        var parts = [], cur = el, depth = 0;
        while (cur && cur.nodeType === 1 && cur !== document.documentElement && cur !== document.body && depth < 7) {
            var sg = segment(cur);
            parts.unshift(sg.text);
            if (sg.anchor) break;
            cur = cur.parentElement; depth++;
        }
        if (!parts.length) return el.tagName.toLowerCase();
        var base = count(parts.join(" "));
        // Выкидываем промежуточные звенья, если набор совпадений от этого не растёт.
        for (var i = parts.length - 2; i >= 1; i--) {
            var trial = parts.slice(0, i).concat(parts.slice(i + 1)).join(" ");
            if (hits(trial, el) && count(trial) <= base) parts.splice(i, 1);
        }
        var sel = parts.join(" ");
        if (count(sel) > 1) {
            var al = el.getAttribute && el.getAttribute("aria-label");
            if (al && al.length < 60) {
                var withAl = sel + "[aria-label=\"" + al.replace(/["\\]/g, "\\$&") + "\"]";
                if (hits(withAl, el)) sel = withAl;
            }
        }
        // Всё ещё неоднозначно (например, подпись внутри вкладки) — уточняем по aria-label предка.
        if (count(sel) > 1) {
            var a = el.parentElement;
            for (var k = 0; a && k < 4 && a !== document.body; k++, a = a.parentElement) {
                var aal = a.getAttribute("aria-label");
                if (!aal || aal.length >= 60) continue;
                var cand = segment(a).text + "[aria-label=\"" + aal.replace(/["\\]/g, "\\$&") + "\"] " + parts[parts.length - 1];
                if (hits(cand, el) && count(cand) < count(sel)) sel = cand;
                break;
            }
        }
        return sel;
    }

    // ---------------------------------------------------------------------------
    //  Запасные селекторы и отпечаток элемента. Селектор из классов короткий, но именно классы
    //  VS Code переименовывает при обновлениях. Поэтому к правилу конструктора запоминается
    //  отпечаток: однозначные селекторы другого рода (id, aria-label, title, :has по подписи
    //  потомка), а также признаки элемента. Сломался основной селектор — элемент ищется по ним.
    // ---------------------------------------------------------------------------
    function attrSel(name, v) { return "[" + name + "=\"" + String(v).replace(/["\\]/g, "\\$&") + "\"]"; }
    function okLabel(v) { return !!v && v.length < 80 && !/[\n\r{}]/.test(v); }
    var hasSupported = null;
    function canHas() {
        if (hasSupported === null) { try { document.querySelector(":has(*)"); hasSupported = true; } catch (e) { hasSupported = false; } }
        return hasSupported;
    }

    /** Однозначные селекторы для el другого рода, чем основной (без повторов), до max штук. */
    function selectorCandidates(el, max) {
        var out = [], seen = {}, lim = max || 6;
        if (!el || el.nodeType !== 1) return out;
        var tag = el.tagName.toLowerCase();
        var cls = stableClasses(el).slice(0, 2).map(function (c) { return "." + cssEsc(c); }).join("");
        function add(s) {
            if (!s || seen[s] || out.length >= lim) return;
            seen[s] = 1;
            if (count(s) === 1 && hits(s, el)) out.push(s);
        }
        add(selectorFor(el));
        if (stableId(el.id)) add("#" + cssEsc(el.id));
        var al = el.getAttribute("aria-label"), ti = el.getAttribute("title"), ro = el.getAttribute("role");
        if (okLabel(al)) { add(tag + cls + attrSel("aria-label", al)); add(tag + attrSel("aria-label", al)); if (ro) add(attrSel("role", ro) + attrSel("aria-label", al)); }
        if (okLabel(ti)) add(tag + cls + attrSel("title", ti));
        // Ближайший предок с устойчивым id — якорь.
        for (var a = el.parentElement, k = 0; a && k < 8 && a !== document.body; a = a.parentElement, k++) {
            if (stableId(a.id)) { add("#" + cssEsc(a.id) + " " + tag + cls); break; }
        }
        // Своей подписи нет, а у потомка есть (li с иконкой внутри): tag.cls:has([aria-label=...]).
        if (!okLabel(al) && canHas()) {
            var inner = el.querySelector("[aria-label]");
            var il = inner && inner.getAttribute("aria-label");
            if (okLabel(il)) add(tag + cls + ":has(" + attrSel("aria-label", il) + ")");
        }
        return out;
    }

    /** Отпечаток элемента для правила sel (уходит на хост вместе с правкой, хранится у правила). */
    function fingerprint(el, sel) {
        if (!el || el.nodeType !== 1 || !el.tagName) return null;
        var fp = { tag: el.tagName.toLowerCase(), one: count(sel) === 1 };
        if (fp.one) {
            var alts = selectorCandidates(el).filter(function (s) { return s !== sel; }).slice(0, 4);
            if (alts.length) fp.alts = alts;
        }
        if (stableId(el.id)) fp.id = el.id;
        var al = el.getAttribute("aria-label"); if (okLabel(al)) fp.aria = al;
        var ti = el.getAttribute("title"); if (okLabel(ti)) fp.title = ti;
        var ro = el.getAttribute("role"); if (ro && ro.length < 30) fp.role = ro;
        var tx = String(el.textContent || "").replace(/\s+/g, " ").trim();
        if (tx && tx.length <= 60 && (el.children ? el.children.length : 0) <= 3) fp.text = tx;
        var cls = stableClasses(el).slice(0, 6); if (cls.length) fp.cls = cls;
        var pc = el.parentElement ? stableClasses(el.parentElement).slice(0, 4) : []; if (pc.length) fp.pcls = pc;
        var c = catalogFor(el);
        if (c && c.anchor === el) { fp.cat = c.entry.id; if (sel === c.entry.selector) fp.whole = true; }
        return fp;
    }
    /** Отпечаток правила «все такие» (весь тип элемента из каталога). */
    function fingerprintEntry(entry) { return entry && entry.id ? { cat: entry.id, whole: true } : null; }

    function textOf(el) { return String(el.textContent || "").replace(/\s+/g, " ").trim(); }

    /** Найти элемент по признакам отпечатка: нужен явный лидер, иначе null. */
    function findByPrint(fp) {
        if (!fp || !(fp.id || fp.aria || fp.title || fp.text)) return null;   // только по классам — слишком зыбко
        var list;
        try { list = document.querySelectorAll(fp.tag || "*"); } catch (e) { return null; }
        var top = null, topScore = 0, second = 0;
        for (var i = 0; i < list.length && i < 8000; i++) {
            var el = list[i];
            if (isOurUi(el)) continue;
            var sc = 0;
            if (fp.id && el.id === fp.id) sc += 6;
            if (fp.aria && el.getAttribute("aria-label") === fp.aria) sc += 4;
            if (fp.title && el.getAttribute("title") === fp.title) sc += 2;
            if (fp.role && el.getAttribute("role") === fp.role) sc += 1;
            if (fp.text && sc + 2 > second && textOf(el) === fp.text) sc += 2;
            if (fp.cls) { var own = stableClasses(el), k = 0; fp.cls.forEach(function (c) { if (own.indexOf(c) !== -1) k++; }); sc += Math.min(3, k); }
            if (fp.pcls && el.parentElement) { var pcl = stableClasses(el.parentElement); if (fp.pcls.some(function (c) { return pcl.indexOf(c) !== -1; })) sc += 1; }
            if (sc > topScore) { second = topScore; topScore = sc; top = el; } else if (sc > second) second = sc;
        }
        return topScore >= 5 && topScore > second ? top : null;
    }

    /**
     * Сломанное правило (sel ничего не находит): где теперь его элемент? {to, how, fp?} или null.
     *   alt     — сработал запасной селектор из отпечатка;
     *   catalog — правило на весь тип из каталога, а в новом каталоге у типа другой селектор;
     *   search  — элемент найден по признакам (id, aria-label, текст, классы).
     */
    function healRule(sel, fp) {
        if (!fp) return null;
        var i;
        for (i = 0; fp.alts && i < fp.alts.length; i++) {
            var n = count(fp.alts[i]);
            if (n !== Infinity && n >= 1 && (!fp.one || n === 1) && fp.alts[i] !== sel) return { to: fp.alts[i], how: "alt" };
        }
        if (fp.cat && fp.whole) {
            for (i = 0; i < CATALOG.length; i++) {
                var e = CATALOG[i];
                if (e.id === fp.cat) {
                    if (e.selector && e.selector !== sel && count(e.selector) > 0) return { to: e.selector, how: "catalog" };
                    break;
                }
            }
        }
        if (fp.one) {
            var el = findByPrint(fp);
            var to = el ? selectorFor(el) : "";
            if (to && to !== sel && hits(to, el)) return { to: to, how: "search", fp: fingerprint(el, to) };
        }
        return null;
    }

    var STYLE_KEYS = ["color", "background-color", "font-size", "font-weight", "padding", "margin", "border-radius", "opacity", "display"];
    function styleHint(el) {
        try {
            var cs = getComputedStyle(el), out = [];
            STYLE_KEYS.forEach(function (k) {
                var v = cs.getPropertyValue(k);
                if (!v || v === "0px" || v === "normal" || v === "rgba(0, 0, 0, 0)" || (k === "opacity" && v === "1") || (k === "font-weight" && v === "400")) return;
                out.push(k + ": " + v);
            });
            return out.join("; ").slice(0, 400);
        } catch (e) { return ""; }
    }
    function labelFor(el) {
        var t = el.tagName.toLowerCase();
        var cls = stableClasses(el).slice(0, 3);
        var al = el.getAttribute && el.getAttribute("aria-label");
        return (t + (cls.length ? "." + cls.join(".") : "") + (al ? " «" + al.slice(0, 40) + "»" : "")).slice(0, 80);
    }

    /** Узел — часть интерфейса Moon Core (пипетка, конструктор, эффекты): его не выбирают и не проверяют. */
    function isOurUi(node) {
        for (var n = node; n && n.nodeType === 1; n = n.parentElement) if (n.hasAttribute("data-mooncore-ui")) return true;
        return false;
    }

    // ---------------------------------------------------------------------------
    //  Проверка селекторов: какие правила CSS-сниппетов ничего не находят.
    // ---------------------------------------------------------------------------
    var PSEUDO_RE = /::?(before|after|placeholder|selection|marker|backdrop|first-line|first-letter|-webkit-[\w-]+)(\([^)]*\))?|:(hover|focus-within|focus-visible|focus|active|visited|link|target|checked|placeholder-shown)\b/g;
    function splitSelectors(text) {
        var out = [], depth = 0, cur = "";
        for (var i = 0; i < text.length; i++) {
            var c = text[i];
            if (c === "(" || c === "[") depth++;
            else if (c === ")" || c === "]") depth--;
            if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += c;
        }
        if (cur.trim()) out.push(cur.trim());
        return out;
    }
    function selectorAlive(sel) {
        var s = sel.replace(PSEUDO_RE, "").trim() || "*";
        try { return !!document.querySelector(s); } catch (e) { return true; }   // не можем проверить — не ругаемся
    }
    function collectRules(rules, out) {
        for (var i = 0; i < rules.length && out.length < 2000; i++) {
            var r = rules[i];
            if (r.selectorText) splitSelectors(r.selectorText).forEach(function (s) { out.push({ selector: s.slice(0, 300), found: selectorAlive(s) }); });
            else if (r.cssRules) collectRules(r.cssRules, out);
        }
        return out;
    }
    function checkAll(prints) {
        var out = Object.keys(styles).sort().map(function (id) {
            var rules = [];
            try { if (styles[id].sheet) collectRules(styles[id].sheet.cssRules, rules); } catch (e) {}
            return { id: id, rules: rules };
        });
        // Правки конструктора: каждое правило — селектор элемента, который пользователь выбрал мышкой.
        // Не находит — ищем элемент по отпечатку правила и предлагаем замену (хост спросит).
        var design = Object.keys(DS.rules).sort().map(function (sel) {
            var r = DS.rules[sel] || {};
            var o = { selector: sel.slice(0, 300), label: String(r.label || "").slice(0, 80), found: selectorAlive(sel) };
            if (!o.found && r.fp) { try { var hl = healRule(sel, r.fp); if (hl) o.heal = hl; } catch (e) { report("самолечение " + sel, e); } }
            return o;
        });
        if (design.length) out.push({ id: "~design", rules: design });
        // Каталог: что конструктор умеет находить. Его поломка после обновления VS Code — повод обновить каталог.
        // prints — отпечатки элементов каталога из прошлого прогона (e2e): найден элемент — свежий
        // отпечаток для следующего раза, пропал — поиск по старому отпечатку и предложение селектора.
        var cat = CATALOG.filter(function (e) { return e && e.selector; }).map(function (e) {
            var o = { id: String(e.id || "").slice(0, 40), selector: String(e.selector).slice(0, 300), label: String(e.label || "").slice(0, 80), found: selectorAlive(e.selector) };
            if (!prints) return o;
            try {
                if (o.found) {
                    var el = document.querySelector(e.selector);
                    if (el) o.fp = fingerprint(el, e.selector);
                } else if (prints[o.id]) {
                    var hl = healRule(e.selector, prints[o.id]);
                    if (hl) o.heal = hl;
                }
            } catch (err) {}
            return o;
        });
        if (cat.length) out.push({ id: "~catalog", rules: cat });
        return out;
    }
    function answerCheck(d) {
        var prints = d.prints && typeof d.prints === "object" ? d.prints : null;
        rpcFirst("report", { reqId: String(d.reqId), results: checkAll(prints) }, d.host);
    }

    // ---------------------------------------------------------------------------
    //  Ленивая загрузка интерфейса (только в ленивой сборке — mooncore-core.js).
    //
    //  Конструктор и пипетка — больше половины рантайма, а нужны редко. Их код (runtime/src/ui/)
    //  лежит отдельным файлом в globalStorage (BOOT.ui = { url, sha }) и не разбирается при
    //  старте окна: его читают при первом открытии, сверяют SHA-256 из boot и вычисляют прямым
    //  eval внутри этой функции — поэтому код интерфейса видит общие переменные рантайма так же,
    //  как в полной сборке. Ядро зовёт интерфейс только через заглушки ниже.
    //
    //  Не вышло: файла нет или он другой — хост перепишет его, окно попробует ещё раз; eval
    //  запрещён (CSP) — хост встроит интерфейс в оболочку целиком (rpc "uiFailed").
    // ---------------------------------------------------------------------------
    var UI = null, uiWait = [], uiBusy = false, uiRetried = false;

    function startPick(host) { withUi(function (u) { u.startPick(host); }); }
    function stopPick() { if (UI) UI.stopPick(); }
    function toggleDesign(host) { withUi(function (u) { u.toggleDesign(host); }); }
    function startDesign(host) { withUi(function (u) { u.startDesign(host); }); }
    function stopDesign() { if (UI) UI.stopDesign(); }
    function renderPanel(full) { if (UI) UI.renderPanel(full); }
    function clearColorPreview() { if (UI) UI.clearColorPreview(); }

    function withUi(fn) {
        if (UI) { try { fn(UI); } catch (e) { report("интерфейс", e); } return; }
        uiWait.push(fn);
        if (!uiBusy) loadUi();
    }

    function sha256Hex(text) {
        var c = window.crypto && window.crypto.subtle;
        if (!c || typeof TextEncoder !== "function") return Promise.reject(new Error("nocrypto"));
        return c.digest("SHA-256", new TextEncoder().encode(text)).then(function (buf) {
            return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
        });
    }
    // Trusted Types — политика «mooncore» (05-trusted.js): код чанка проходит её только после
    // сверки SHA-256 ниже.
    var isCspError = isCodeBlocked;
    /** Прямой eval: код чанка видит область рантайма (свои функции он объявляет у себя). */
    function evalUi(code) { return eval(trustedScript(code)); }

    function loadUi() {
        var info = BOOT.ui || null;
        uiBusy = true;
        if (!info || !info.url || !/^[0-9a-f]{64}$/.test(String(info.sha))) { uiFail("missing"); return; }
        var t0 = now();
        readAsync(info.url, function (text) {
            if (!text) { uiFail("missing"); return; }
            sha256Hex(text).then(function (h) {
                if (h !== info.sha) { uiFail("sha"); return; }
                var api = null;
                try { api = evalUi(text); } catch (e) { uiFail(isCspError(e) ? "eval" : "error", e); return; }
                if (!api || typeof api.startDesign !== "function") { uiFail("error", "чанк интерфейса не вернул функции"); return; }
                UI = api; uiBusy = false;
                timing.ui = Math.round((now() - t0) * 10) / 10;
                var w = uiWait; uiWait = [];
                w.forEach(function (f) { try { f(UI); } catch (e) { report("интерфейс", e); } });
            }, function (e) { uiFail(/nocrypto/.test(String(e && e.message)) ? "nocrypto" : "sha", e); });
        });
    }

    var UI_FAIL_TEXT = {
        missing: "Moon Core: конструктор обновился — перезагрузи окно.",
        sha: "Moon Core: конструктор обновился — перезагрузи окно.",
        eval: "Moon Core: VS Code не дал загрузить конструктор отдельно — он будет встроен в оболочку. Перезагрузи окно.",
        nocrypto: "Moon Core: конструктор не проверить отдельно — он будет встроен в оболочку. Перезагрузи окно.",
        error: "Moon Core: ошибка при загрузке конструктора — подробности в журнале Moon Core.",
    };
    function uiFail(reason, err) {
        uiBusy = false;
        var waiting = uiWait; uiWait = [];
        report("интерфейс (" + reason + ")", err || reason);
        rpcAny("uiFailed", { reason: reason, sha: (BOOT.ui && BOOT.ui.sha) || "" }).then(function (r) {
            // Хост переписал файл интерфейса — одна повторная попытка.
            if (r && r.ok && r.again && !uiRetried) { uiRetried = true; uiWait = waiting.concat(uiWait); if (!uiBusy) loadUi(); return; }
            toast(UI_FAIL_TEXT[reason] || UI_FAIL_TEXT.error);
        });
    }

    // ---------------------------------------------------------------------------
    //  Конструктор: клик по элементу -> панель свойств; все правки копятся в списке
    //  изменений с отменой. Где есть настройка VS Code — предлагается она (надёжнее CSS).
    //  Правка видна сразу (локальный CSS), на диск её пишет хост (rpc "design").
    // ---------------------------------------------------------------------------
    var DS = toDS(null);                       // правила, настройки, цвета темы, кнопки, эффекты
    var TOKEN_GROUPS = [];
    function toDS(d) {
        d = d || {};
        return { rules: d.rules || {}, settings: d.settings || {}, colors: d.colors || {}, buttons: Array.isArray(d.buttons) ? d.buttons : [], fx: d.fx || {} };
    }
    /** Новое состояние конструктора пришло: всё, что из него рисуется, — обновить. */
    function afterDS() {
        renderDesignCss();
        try { ensureButtons(); } catch (e) { report("кнопки", e); }
        try { applyFx(); } catch (e) { report("эффекты", e); }
    }
    var CATALOG = [], ZONES = [], PROPS = {}, SETNOW = {}, PROFILES = null;
    var localEditAt = 0, opQueue = [], opKeys = {}, opTimer = null, flushSeq = 0;
    var designStyle = null;
    var des = null;   // {host, hoverEl, selEl, sel, entry, stack, tab, confirmClear, ...}

    function adoptDesign(st) {
        if (Array.isArray(st.catalog)) CATALOG = st.catalog;
        if (Array.isArray(st.zones)) ZONES = st.zones;
        if (st.profiles && Array.isArray(st.profiles.list)) PROFILES = st.profiles;
        if (st.props && typeof st.props === "object") PROPS = st.props;
        if (st.settingsNow && typeof st.settingsNow === "object") SETNOW = st.settingsNow;
        if (Array.isArray(st.tokenGroups)) TOKEN_GROUPS = st.tokenGroups;
        if (st.fxSpec && typeof st.fxSpec === "object") FXSPEC = st.fxSpec;
        if (Array.isArray(st.uiButtons) || Object.keys(uibByHost).length) UIB = mergeUib(st.uiButtons);
        // Пока пользователь двигает ползунок, не затираем его правку старым состоянием.
        if (st.design && !opQueue.length && Date.now() - localEditAt > 1200) {
            DS = toDS(st.design);
            clearColorPreview();
        }
        if (domReady) afterDS();
        if (des) renderPanel(false);
    }

    function cssVal(prop, v) {
        var p = PROPS[prop];
        if (!p) return "";
        if (p.type === "flag") return p.value;
        if (p.type === "number") return v + (p.unit || "");
        return String(v);
    }
    function designCss() {
        var sels = Object.keys(DS.rules).sort(function (a, b) { return ((DS.rules[a].ts || 0) - (DS.rules[b].ts || 0)) || (a < b ? -1 : 1); });
        // peek — правило, скрытое на время подсветки (наведение на правку во вкладке «Правки»).
        if (des && des.peek) sels = sels.filter(function (s) { return s !== des.peek; });
        return sels.map(function (sel) {
            var r = DS.rules[sel];
            var decl = Object.keys(r.props || {}).filter(function (k) { return PROPS[k]; }).map(function (k) {
                return "  " + PROPS[k].css + ": " + cssVal(k, r.props[k]) + " !important;";
            });
            return sel + " {\n" + decl.join("\n") + "\n}";
        }).join("\n");
    }
    function renderDesignCss() {
        if (!designStyle) {
            designStyle = document.createElement("style");
            designStyle.setAttribute("data-mooncore", "~design");
            if (NONCE) designStyle.setAttribute("nonce", NONCE);
        }
        var css = designCss();
        if (designStyle.textContent !== css) designStyle.textContent = css;
        // Правки конструктора — последними, поверх сниппетов (порядок держит renderCss).
        if (!designStyle.isConnected) headEl().appendChild(designStyle);
    }

    // ---- очередь правок -> хост
    function queueOp(key, op) {
        if (opKeys[key] != null) opQueue[opKeys[key]] = op;
        else { opKeys[key] = opQueue.length; opQueue.push(op); }
        localEditAt = Date.now();
        clearTimeout(opTimer);
        opTimer = setTimeout(flushOps, 250);
    }
    function flushOps() {
        if (!opQueue.length) return;
        var ops = opQueue; opQueue = []; opKeys = {};
        var seq = ++flushSeq;
        rpcFirst("design", { ops: ops }, des && des.host).then(function (r) {
            if (!r || r.ok === false) toast("Moon Core: " + ((r && r.error) || "расширение не ответило — правка видна, но не сохранена"));
            if (r && r.design && seq === flushSeq && !opQueue.length) {
                DS = toDS(r.design);
                if (r.settingsNow) SETNOW = r.settingsNow;
                if (r.profiles) PROFILES = r.profiles;
                localEditAt = 0;
                setTimeout(clearColorPreview, 400);
                afterDS();
                if (des) renderPanel(false);
            }
        });
    }
    /**
     * Правка свойства. el — элемент, на котором её сделали (для отпечатка; по умолчанию выбранный
     * в конструкторе), entry — запись каталога, если правка на весь тип элемента.
     */
    function setProp(sel, prop, value, label, el, entry) {
        var r = DS.rules[sel];
        if (value === null || value === undefined || value === false) {
            if (r && r.props[prop] !== undefined) { delete r.props[prop]; if (!Object.keys(r.props).length) delete DS.rules[sel]; }
        } else {
            if (!r) r = DS.rules[sel] = { label: label || "", props: {}, ts: Date.now() };
            r.props[prop] = value;
        }
        queueOp("set|" + sel + "|" + prop, { op: "set", selector: sel, prop: prop, value: value === undefined || value === false ? null : value, label: label || "" });
        // Отпечаток — отдельной операцией после set: ползунок шлёт много set подряд, и они
        // схлопываются в последний, а отпечаток должен дойти один раз.
        if (r && DS.rules[sel] && !r.fp) {
            var fp = fpFor(sel, el, entry);
            if (fp) { r.fp = fp; queueOp("fp|" + sel, { op: "fingerprint", selector: sel, fp: fp }); }
        }
        renderDesignCss();
    }
    function fpFor(sel, el, entry) {
        try {
            var e = el || (des && des.selEl);
            if (e && e.isConnected && hits(sel, e)) return fingerprint(e, sel);
            var en = entry || (des && des.entry);
            if (en && sel === en.selector) return fingerprintEntry(en);
        } catch (err) {}
        return null;
    }
    function resetRule(sel) {
        delete DS.rules[sel];
        queueOp("reset|" + sel, { op: "resetRule", selector: sel });
        renderDesignCss();
    }
    function setSetting(key, value, label) {
        SETNOW[key] = value;
        queueOp("setting|" + key, { op: "setting", key: key, value: value, label: label || "" });
    }
    function undoSetting(key) {
        var rec = DS.settings[key];
        if (rec) SETNOW[key] = rec.prev;
        delete DS.settings[key];
        queueOp("undo|" + key, { op: "undoSetting", key: key });
    }

    // ---- каталог
    function catalogFor(el) {
        var best = null, bestDist = Infinity;
        CATALOG.forEach(function (e) {
            if (!e.selector) return;
            var a = null;
            try { a = el.closest(e.selector); } catch (err) { return; }
            if (!a) return;
            var d = 0;
            for (var n = el; n && n !== a; n = n.parentElement) d++;
            if (d <= bestDist) { best = { entry: e, anchor: a }; bestDist = d; }
        });
        return best;
    }
    /** Селектор элемента каталога, к которому относится настройка (для подсветки). */
    function settingSelector(key) {
        for (var i = 0; i < CATALOG.length; i++) {
            var ss = CATALOG[i].settings || [];
            for (var j = 0; j < ss.length; j++) if (ss[j].key === key && CATALOG[i].selector) return CATALOG[i].selector;
        }
        return "";
    }
    function settingLabel(key) {
        for (var i = 0; i < CATALOG.length; i++) {
            var ss = CATALOG[i].settings || [];
            for (var j = 0; j < ss.length; j++) if (ss[j].key === key) return ss[j].label + " (" + CATALOG[i].label + ")";
        }
        return key;
    }

    /**
     * Правила, созданные до отпечатков (или руками в пакете): если элемент сейчас на экране —
     * запомнить его отпечаток, чтобы правило могло «вылечиться» после следующего обновления.
     */
    function backfillPrints() {
        var n = 0;
        Object.keys(DS.rules).forEach(function (sel) {
            var r = DS.rules[sel];
            if (!r || r.fp || n >= 50) return;
            var el = null;
            try { el = document.querySelector(sel); } catch (e) { return; }
            if (!el) return;
            var fp = null;
            if (count(sel) === 1) fp = fingerprint(el, sel);
            else for (var i = 0; i < CATALOG.length; i++) if (CATALOG[i].selector === sel) { fp = fingerprintEntry(CATALOG[i]); break; }
            if (fp) { r.fp = fp; queueOp("fp|" + sel, { op: "fingerprint", selector: sel, fp: fp }); n++; }
        });
        return n;
    }

    // ---------------------------------------------------------------------------
    //  Контекст окна для правил «только для...». Хост сообщает язык активного файла, ветку,
    //  папку проекта и вид темы (событие "ctx"); окно пишет их атрибутами на <html>:
    //    data-mc-lang, data-mc-branch, data-mc-folder, data-mc-theme.
    //  Правило с условием — это обычное правило с приставкой к селектору:
    //    html[data-mc-lang="markdown"] .monaco-editor .minimap
    //  Поэтому условия работают везде (сниппеты, конструктор, профили) без новой модели.
    // ---------------------------------------------------------------------------
    var ctxByHost = {};                              // token -> последний контекст этого хоста
    var CTX_ATTR = { lang: "data-mc-lang", branch: "data-mc-branch", folder: "data-mc-folder", theme: "data-mc-theme" };
    var COND_TITLES = { lang: "язык", branch: "ветка", folder: "проект", theme: "тема" };
    var COND_RE = /^html\[data-mc-(lang|branch|folder|theme)="((?:[^"\\]|\\.)*)"\]\s+/;

    function onCtx(rec, d) {
        if (!d || typeof d !== "object") return;
        ctxByHost[rec.token] = d;
        if (isOwnHost(rec.token)) applyCtx(d);
    }
    function applyCtx(d) {
        var root = document.documentElement;
        Object.keys(CTX_ATTR).forEach(function (k) {
            var v = typeof d[k] === "string" ? d[k].slice(0, 120) : "";
            if (v) root.setAttribute(CTX_ATTR[k], v); else root.removeAttribute(CTX_ATTR[k]);
        });
        if (des && des.tab === "el") renderPanel(false);
    }
    function ctxNow() {
        var root = document.documentElement, out = {};
        Object.keys(CTX_ATTR).forEach(function (k) { out[k] = root.getAttribute(CTX_ATTR[k]) || ""; });
        return out;
    }
    /** "html[data-mc-lang="md"] .x" -> { kind: "lang", value: "md", base: ".x" }. */
    function splitCond(sel) {
        var m = COND_RE.exec(sel || "");
        return m ? { kind: m[1], value: m[2].replace(/\\(.)/g, "$1"), base: sel.slice(m[0].length) } : { kind: "", value: "", base: sel || "" };
    }
    function withCond(base, kind, value) {
        return kind && value ? "html" + attrSel("data-mc-" + kind, value) + " " + base : base;
    }
    function condText(sel) {
        var c = splitCond(sel);
        return c.kind ? "только " + COND_TITLES[c.kind] + " «" + c.value + "»" : "";
    }

    // ---------------------------------------------------------------------------
    //  Цвета темы: общие помощники (переменные темы, разбор цвета). Секции «Цвета темы» и
    //  «Цвета кода» конструктора — в чанке интерфейса (runtime/src/ui/78-colors.js).
    // ---------------------------------------------------------------------------
    /** Все переменные темы: имя (без --vscode-) -> значение. */
    function themeVars() {
        var out = {};
        var root = document.querySelector(".monaco-workbench") || document.documentElement;
        try {
            var cs = getComputedStyle(root);
            for (var i = 0; i < cs.length; i++) { var n = cs[i]; if (n && n.indexOf("--vscode-") === 0) out[n.slice(9)] = cs.getPropertyValue(n).trim(); }
        } catch (e) {}
        return out;
    }

    /** Цвет в [r, g, b, a] (hex или rgb/rgba) или null. */
    function rgba(c) {
        var s = String(c || "").trim(), m;
        if ((m = /^#([0-9a-f]{3,8})$/i.exec(s))) {
            var hx = m[1];
            if (hx.length <= 4) hx = hx.split("").map(function (x) { return x + x; }).join("");
            if (hx.length !== 6 && hx.length !== 8) return null;
            return [parseInt(hx.slice(0, 2), 16), parseInt(hx.slice(2, 4), 16), parseInt(hx.slice(4, 6), 16), hx.length === 8 ? parseInt(hx.slice(6, 8), 16) / 255 : 1];
        }
        if ((m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i.exec(s))) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
        return null;
    }
    function sameColor(a, b) {
        var x = rgba(a), y = rgba(b);
        return !!(x && y) && Math.abs(x[0] - y[0]) < 2 && Math.abs(x[1] - y[1]) < 2 && Math.abs(x[2] - y[2]) < 2 && Math.abs(x[3] - y[3]) < 0.02;
    }
    function hex6(c) {
        var x = rgba(c);
        return x ? "#" + [x[0], x[1], x[2]].map(function (n) { return ("0" + Math.round(n).toString(16)).slice(-2); }).join("") : "#000000";
    }

    // ---------------------------------------------------------------------------
    //  Свои кнопки: любая команда VS Code — кнопкой в статусбаре, титлбаре или над редактором.
    //  Свои (DS.buttons) создаются во вкладке «Ещё» конструктора; кнопки других расширений
    //  (UIB, API Moon Core ui.button) приходят с состоянием хоста. Клик по своей — команда
    //  через мост (выбранная в VS Code команда уже разрешена), по чужой — её расширению.
    // ---------------------------------------------------------------------------
    var UIB = [];                                     // кнопки от других расширений (объединение по хостам)
    var uibByHost = {};                               // token хоста -> его кнопки расширений
    var btnMounted = false;                           // в окне есть хоть одна наша кнопка

    /** Кнопки расширений всех хостов без повторов (id кнопки одинаков во всех окнах), свой хост — первым. */
    function mergeUib(fallback) {
        var tokens = Object.keys(uibByHost);
        if (!tokens.length) return Array.isArray(fallback) ? fallback : [];
        tokens.sort(function (a, b) { return (isOwnHost(b) ? 1 : 0) - (isOwnHost(a) ? 1 : 0); });
        var seen = {}, out = [];
        tokens.forEach(function (t) {
            uibByHost[t].forEach(function (b) { if (b && b.id && !seen[b.id]) { seen[b.id] = 1; out.push(b); } });
        });
        return out;
    }
    function zoneTargets(zone) {
        var q = function (s) { try { return Array.prototype.slice.call(document.querySelectorAll(s)); } catch (e) { return []; } };
        if (zone === "statusbar-left") return q(".part.statusbar .left-items").slice(0, 1);
        if (zone === "statusbar-right") return q(".part.statusbar .right-items").slice(0, 1);
        if (zone === "titlebar") { var t = q(".part.titlebar .titlebar-right"); return (t.length ? t : q(".part.titlebar .titlebar-container")).slice(0, 1); }
        if (zone === "editor") return q(".part.editor .editor-group-container > .title .editor-actions").slice(0, 8);
        return [];
    }
    function btnSig(b) { return [b.zone, b.command, b.icon, b.label, b.tooltip, b.order, b.owner || ""].join("|"); }

    function makeButton(b) {
        var sb = b.zone.indexOf("statusbar") === 0;
        var el = document.createElement("div");
        el.setAttribute("data-mooncore-btn", b.id);
        el.setAttribute("data-mc-sig", btnSig(b));
        el.setAttribute("role", "button");
        el.setAttribute("tabindex", "0");
        el.title = b.tooltip || b.label || b.command;
        el.setAttribute("aria-label", el.title);
        el.className = sb ? "statusbar-item " + (b.zone === "statusbar-left" ? "left" : "right") + " mooncore-btn" : "action-item mooncore-btn";
        var a = document.createElement("a");
        a.className = sb ? "statusbar-item-label" : "action-label";
        if (b.icon) { var ic = document.createElement("span"); ic.className = "codicon codicon-" + b.icon; a.appendChild(ic); }
        if (b.label && (sb || !b.icon)) a.appendChild(document.createTextNode((b.icon ? " " : "") + b.label));
        el.appendChild(a);
        Object.assign(el.style, { cursor: "pointer", order: String(b.order || 0) });
        if (!sb) Object.assign(el.style, { display: "flex", alignItems: "center", padding: "0 3px", webkitAppRegion: "no-drag" });
        if (el.style.setProperty) el.style.setProperty("-webkit-app-region", "no-drag");   // в титлбаре иначе клик тащит окно
        var run = function (e) {
            if (e) { e.preventDefault(); e.stopPropagation(); }
            // Кнопка расширения — сначала своему хосту (он её зарегистрировал), чужой ответит retry.
            var own = ownToken && hosts[ownToken] ? hosts[ownToken] : null;
            var p = b.owner ? rpcFirst("uiClick", { id: b.id }, own) : rpcFirst("command", { id: b.command, args: b.args || [], from: "" }, null);
            p.then(function (r) { if (!r || r.ok === false) toast("Moon Core: " + ((r && r.error) || "команда не выполнена")); });
        };
        el.addEventListener("click", run);
        el.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") run(e); });
        return el;
    }

    /** Кнопки на месте: новые вставить, изменённые пересоздать, лишние убрать. Вызывается и по таймеру: VS Code перерисовывает части. */
    function ensureButtons() {
        if (!domReady || !document.body) return;
        var list = (DS.buttons || []).concat(UIB || []), want = {};
        // Кнопок нет и не было — таймер раз в 1,5 с ничего не ищет в DOM.
        if (!list.length && !btnMounted) return;
        btnMounted = list.length > 0;
        list.forEach(function (b) {
            if (!b || !b.id || !b.zone) return;
            zoneTargets(b.zone).forEach(function (box, i) {
                var key = b.id + "#" + i;
                want[key] = 1;
                var el = null;
                for (var c = box.firstElementChild; c; c = c.nextElementSibling) if (c.getAttribute && c.getAttribute("data-mooncore-btn") === b.id) { el = c; break; }
                if (el && el.getAttribute("data-mc-sig") === btnSig(b)) { el.setAttribute("data-mc-key", key); return; }
                if (el) el.remove();
                el = makeButton(b);
                el.setAttribute("data-mc-key", key);
                if (b.zone === "titlebar" || b.zone === "editor") box.insertBefore(el, box.firstChild); else box.appendChild(el);
            });
        });
        try {
            Array.prototype.forEach.call(document.querySelectorAll("[data-mooncore-btn]"), function (el) { if (!want[el.getAttribute("data-mc-key")]) el.remove(); });
        } catch (e) {}
    }

    // ---------------------------------------------------------------------------
    //  Эффекты редактора: след за курсором, искры при наборе, свечение строки и курсора.
    //  Рисуются на одном прозрачном холсте поверх окна (клики сквозь него проходят); цикл
    //  анимации крутится, только пока эффект включён и есть что рисовать.
    // ---------------------------------------------------------------------------
    var FXSPEC = {};
    var fx = { canvas: null, ctx: null, raf: 0, trail: [], sparks: [], last: null, style: null, keyOn: false };

    function fxConf() { return DS.fx || {}; }
    function fxColor() {
        var f = fxConf();
        if (f.color) return f.color;
        var v = themeVars()["editorCursor-foreground"];
        return v && rgba(v) ? hex6(v) : "#89b4fa";
    }
    function fxCss() {
        var f = fxConf(), c = fxColor(), k = (f.intensity || 5);
        var out = [];
        if (f.lineGlow) out.push(".monaco-editor .view-overlays .current-line { box-shadow: 0 0 " + (4 + k * 2) + "px " + Math.round(k / 2) + "px " + c + "55 !important; border-radius: 3px; }");
        if (f.cursorGlow) out.push(".monaco-editor .cursors-layer .cursor { box-shadow: 0 0 " + (3 + k) + "px " + Math.max(1, Math.round(k / 3)) + "px " + c + " !important; }");
        return out.join("\n");
    }
    function cursorRect() {
        var c = null;
        try { c = document.querySelector(".monaco-editor.focused .cursors-layer .cursor") || document.querySelector(".monaco-editor .cursors-layer .cursor"); } catch (e) {}
        if (!c) return null;
        var r = c.getBoundingClientRect();
        return r.width || r.height ? r : null;
    }
    function ensureFxCanvas(on) {
        if (on && !fx.canvas && document.body) {
            var cv = document.createElement("canvas");
            cv.setAttribute("data-mooncore-ui", "fx");
            Object.assign(cv.style, { position: "fixed", left: "0", top: "0", width: "100vw", height: "100vh", pointerEvents: "none", zIndex: String(Z - 10) });
            document.body.appendChild(cv);
            fx.canvas = cv; fx.ctx = cv.getContext && cv.getContext("2d");
            fx.resize = function () {
                var d = window.devicePixelRatio || 1;
                cv.width = Math.round(window.innerWidth * d); cv.height = Math.round(window.innerHeight * d);
                if (fx.ctx) fx.ctx.setTransform(d, 0, 0, d, 0, 0);
            };
            fx.resize();
            window.addEventListener("resize", fx.resize);
        } else if (!on && fx.canvas) {
            window.removeEventListener("resize", fx.resize);
            fx.canvas.remove(); fx.canvas = fx.ctx = null;
            fx.trail = []; fx.sparks = [];
        }
    }
    function onFxKey(e) {
        var f = fxConf();
        if (!f.typingParticles || !e.target || !e.target.closest || !e.target.closest(".monaco-editor")) return;
        if (e.key.length !== 1 && e.key !== "Backspace" && e.key !== "Enter") return;
        setTimeout(function () {
            var r = cursorRect(); if (!r) return;
            var n = 3 + (f.intensity || 5);
            for (var i = 0; i < n; i++) {
                fx.sparks.push({ x: r.left, y: r.top + r.height / 2, vx: (Math.random() - 0.5) * 3.2, vy: -Math.random() * 2.8 - 0.6, life: 1, s: 1 + Math.random() * 2 });
            }
            if (fx.sparks.length > 400) fx.sparks.splice(0, fx.sparks.length - 400);
            fxLoop();
        }, 0);
    }
    function fxFrame() {
        fx.raf = 0;
        var f = fxConf(), g = fx.ctx;
        if (!g) return;
        var w = window.innerWidth, hgt = window.innerHeight, col = fxColor(), busy = false;
        g.clearRect(0, 0, w, hgt);
        if (f.cursorTrail) {
            var r = cursorRect();
            if (r) {
                var p = { x: r.left + 1, y: r.top, h: r.height, t: now() };
                if (!fx.last || fx.last.x !== p.x || fx.last.y !== p.y) fx.trail.push(p);
                fx.last = p;
            }
            var life = 120 + (f.intensity || 5) * 40, tNow = now();
            fx.trail = fx.trail.filter(function (q) { return tNow - q.t < life; });
            for (var i = 1; i < fx.trail.length; i++) {
                var a = fx.trail[i - 1], b = fx.trail[i], k = 1 - (tNow - b.t) / life;
                g.globalAlpha = Math.max(0, k * 0.8);
                g.strokeStyle = col; g.lineWidth = Math.max(1, b.h * 0.35 * k); g.lineCap = "round";
                g.beginPath(); g.moveTo(a.x, a.y + a.h / 2); g.lineTo(b.x, b.y + b.h / 2); g.stroke();
            }
            busy = busy || fx.trail.length > 1;
        }
        if (fx.sparks.length) {
            fx.sparks.forEach(function (s) { s.x += s.vx; s.y += s.vy; s.vy += 0.12; s.life -= 0.03; });
            fx.sparks = fx.sparks.filter(function (s) { return s.life > 0; });
            g.fillStyle = col;
            fx.sparks.forEach(function (s) { g.globalAlpha = Math.max(0, s.life); g.fillRect(s.x, s.y, s.s, s.s); });
            busy = true;
        }
        g.globalAlpha = 1;
        // След требует следить за курсором постоянно; без него — только пока летят искры.
        if (busy || f.cursorTrail) fx.raf = requestAnimationFrame(fxFrame);
    }
    function fxLoop() { if (!fx.raf && fx.canvas) fx.raf = requestAnimationFrame(fxFrame); }

    /** Применить текущие эффекты: стиль свечения, холст, слушатель набора. */
    function applyFx() {
        var f = fxConf();
        var css = fxCss();
        if (css && !fx.style) {
            fx.style = document.createElement("style");
            fx.style.setAttribute("data-mooncore", "~fx");
            if (NONCE) fx.style.setAttribute("nonce", NONCE);
        }
        if (fx.style) { if (fx.style.textContent !== css) fx.style.textContent = css; if (css && !fx.style.isConnected) headEl().appendChild(fx.style); if (!css) fx.style.remove(); }
        var need = !!(f.cursorTrail || f.typingParticles);
        ensureFxCanvas(need);
        if (need && !fx.keyOn) { window.addEventListener("keydown", onFxKey, true); fx.keyOn = true; }
        if (!need && fx.keyOn) { window.removeEventListener("keydown", onFxKey, true); fx.keyOn = false; }
        if (f.cursorTrail) fxLoop();
    }

    // ---------------------------------------------------------------------------
    //  Сервисы окна VS Code (глубокая интеграция, moonCore.deepHooks). Крючок в бандле воркбенча
    //  кладёт каждый InstantiationService в globalThis.__MOONCORE_DI__; корневой — без родителя
    //  и с самым большим набором сервисов. Сервис берётся по имени (то, что VS Code пишет в
    //  createDecorator: "statusbarService", "codeEditorService", "commandService"...).
    //  Внутренности VS Code меняются между версиями — всё здесь осторожно и без исключений наружу.
    // ---------------------------------------------------------------------------
    var SVC_RE = /^[A-Za-z][\w]{1,60}$/;
    var svcCache = {};

    function diRoot() {
        var list = window.__MOONCORE_DI__;
        if (!list || !list.length) return null;
        var best = null, size = -1;
        for (var i = 0; i < list.length; i++) {
            try {
                var inst = list[i], e = inst && inst._services && inst._services._entries;
                if (inst && !inst._parent && e && e.size > size) { best = inst; size = e.size; }
            } catch (err) {}
        }
        return best || list[0];
    }
    function serviceNames() {
        var inst = diRoot(), out = [];
        try { inst._services._entries.forEach(function (v, k) { var n = String(k); if (SVC_RE.test(n)) out.push(n); }); } catch (e) {}
        return out.sort();
    }
    /** Сервис окна по имени или null (глубокая интеграция выключена, имени нет, VS Code устроен иначе). */
    function service(name) {
        name = String(name || "");
        if (!SVC_RE.test(name)) return null;
        if (svcCache[name]) return svcCache[name];
        var inst = diRoot();
        if (!inst || typeof inst.invokeFunction !== "function") return null;
        var dec = null;
        try { inst._services._entries.forEach(function (v, k) { if (!dec && String(k) === name) dec = k; }); } catch (e) { return null; }
        if (!dec) return null;
        try {
            var s = inst.invokeFunction(function (acc) { return acc.get(dec); });
            if (s) svcCache[name] = s;
            return s || null;
        } catch (e) { report("сервис окна " + name, e); return null; }
    }
    var servicesApi = {
        /** Включена ли глубокая интеграция (крючок в бандле сработал). */
        available: function () { return !!diRoot(); },
        get: service,
        names: serviceNames,
    };

    // ---------------------------------------------------------------------------
    //  Плавающие окна модулей (mc.window): общий сервис вместо своего окна в каждом модуле.
    //  Заголовок с перетаскиванием, уголок для размера, прилипание к краям окна VS Code, место и
    //  размер запоминаются (localStorage, по модулю и id окна). Содержимое модуль строит сам в
    //  win.body обычным DOM (без innerHTML — Trusted Types не нужны). Окна модуля закрываются при
    //  его выключении и горячей перезагрузке.
    // ---------------------------------------------------------------------------
    var WINS = {};           // "мод/id" -> окно
    var WIN_ID_RE = /^[\w.-]{1,40}$/;
    var SNAP = 16;

    function winKey(mod, id) { return "mooncore.win." + mod + "." + id; }
    function winLoad(mod, id) { try { var g = JSON.parse(localStorage.getItem(winKey(mod, id)) || "null"); return g && typeof g === "object" ? g : null; } catch (e) { return null; } }
    function winSave(mod, id, g) { try { localStorage.setItem(winKey(mod, id), JSON.stringify(g)); } catch (e) {} }
    function viewport() { return { w: window.innerWidth || 1200, h: window.innerHeight || 800 }; }

    /** Вписать геометрию в окно VS Code и прилепить к краям, если близко. */
    function fitGeom(g) {
        var v = viewport();
        var w = Math.max(160, Math.min(v.w, g.w | 0)), h = Math.max(100, Math.min(v.h, g.h | 0));
        var x = Math.max(0, Math.min(v.w - w, g.x | 0)), y = Math.max(0, Math.min(v.h - h, g.y | 0));
        if (x < SNAP) x = 0;
        if (y < SNAP) y = 0;
        if (v.w - (x + w) < SNAP) x = v.w - w;
        if (v.h - (y + h) < SNAP) y = v.h - h;
        return { x: x, y: y, w: w, h: h };
    }

    function createWindow(mod, opts) {
        var o = opts || {};
        var id = WIN_ID_RE.test(String(o.id || "")) ? String(o.id) : "main";
        var key = mod + "/" + id;
        if (WINS[key]) { if (o.title) WINS[key].setTitle(o.title); return WINS[key]; }
        var v = viewport();
        var w0 = o.width > 0 ? o.width : 420, h0 = o.height > 0 ? o.height : 320;
        var geom = fitGeom(winLoad(mod, id) || { x: o.x >= 0 ? o.x : (v.w - w0) / 2, y: o.y >= 0 ? o.y : (v.h - h0) / 3, w: w0, h: h0 });
        var closers = [];

        var el = document.createElement("div");
        el.setAttribute("data-mooncore-ui", "window");
        el.setAttribute("data-mooncore-owner", mod);
        Object.assign(el.style, {
            position: "fixed", zIndex: String(Z - 20), display: "flex", flexDirection: "column", overflow: "hidden",
            background: "var(--vscode-editorWidget-background, #1e1e2e)", color: "var(--vscode-editorWidget-foreground, #cdd6f4)",
            border: "1px solid var(--vscode-widget-border, var(--vscode-focusBorder, #45475a))", borderRadius: "8px",
            boxShadow: "0 12px 40px rgba(0,0,0,.45)", font: "13px/1.4 var(--vscode-font-family, sans-serif)",
        });
        var head = document.createElement("div");
        Object.assign(head.style, { display: "flex", alignItems: "center", gap: "8px", padding: "6px 10px", cursor: "move", userSelect: "none",
            background: "var(--vscode-titleBar-activeBackground, rgba(127,127,127,.12))", borderBottom: "1px solid var(--vscode-widget-border, transparent)" });
        var title = document.createElement("div");
        Object.assign(title.style, { flex: "1", fontWeight: "600", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
        title.textContent = String(o.title || (MODS[mod] && MODS[mod].name) || mod);
        var close = document.createElement("div");
        close.textContent = "×";
        close.title = "Закрыть";
        Object.assign(close.style, { cursor: "pointer", fontSize: "16px", padding: "0 4px", opacity: ".75" });
        head.appendChild(title);
        head.appendChild(close);
        var body = document.createElement("div");
        Object.assign(body.style, { flex: "1", overflow: "auto", padding: o.padding === false ? "0" : "10px" });
        var grip = document.createElement("div");
        Object.assign(grip.style, { position: "absolute", right: "0", bottom: "0", width: "14px", height: "14px", cursor: "nwse-resize",
            background: "linear-gradient(135deg, transparent 50%, var(--vscode-focusBorder, #89b4fa) 50%)", opacity: ".6" });
        el.appendChild(head);
        el.appendChild(body);
        el.appendChild(grip);

        function place() { el.style.left = geom.x + "px"; el.style.top = geom.y + "px"; el.style.width = geom.w + "px"; el.style.height = geom.h + "px"; }
        function commit() { geom = fitGeom(geom); place(); winSave(mod, id, geom); }
        place();

        // Перетаскивание заголовка и уголка: слушатели документа — только пока тянут.
        function drag(e, resize) {
            if (e.button !== undefined && e.button !== 0) return;
            if (e.target === close) return;
            var sx = e.clientX, sy = e.clientY, g0 = { x: geom.x, y: geom.y, w: geom.w, h: geom.h };
            var move = function (ev) {
                var dx = ev.clientX - sx, dy = ev.clientY - sy;
                geom = resize ? { x: g0.x, y: g0.y, w: g0.w + dx, h: g0.h + dy } : { x: g0.x + dx, y: g0.y + dy, w: g0.w, h: g0.h };
                geom = fitGeom(geom);
                place();
            };
            var up = function () { document.removeEventListener("mousemove", move, true); document.removeEventListener("mouseup", up, true); commit(); };
            document.addEventListener("mousemove", move, true);
            document.addEventListener("mouseup", up, true);
            if (e.preventDefault) e.preventDefault();
        }
        head.addEventListener("mousedown", function (e) { drag(e, false); });
        grip.addEventListener("mousedown", function (e) { drag(e, true); });

        var win = {
            id: id, el: el, body: body,
            setTitle: function (t) { title.textContent = String(t); return win; },
            show: function () { if (!el.isConnected && document.body) document.body.appendChild(el); return win; },
            hide: function () { try { el.remove(); } catch (e) {} return win; },
            toggle: function () { return el.isConnected ? win.hide() : win.show(); },
            isOpen: function () { return !!el.isConnected; },
            /** Прилепить: left | right | top | bottom (половина окна VS Code) или center. */
            dock: function (side) {
                var vp = viewport();
                if (side === "left") geom = { x: 0, y: 0, w: vp.w / 2, h: vp.h };
                else if (side === "right") geom = { x: vp.w / 2, y: 0, w: vp.w / 2, h: vp.h };
                else if (side === "top") geom = { x: 0, y: 0, w: vp.w, h: vp.h / 2 };
                else if (side === "bottom") geom = { x: 0, y: vp.h / 2, w: vp.w, h: vp.h / 2 };
                else geom = { x: (vp.w - geom.w) / 2, y: (vp.h - geom.h) / 3, w: geom.w, h: geom.h };
                commit();
                return win;
            },
            geometry: function () { return { x: geom.x, y: geom.y, w: geom.w, h: geom.h }; },
            onClose: function (fn) { if (typeof fn === "function") closers.push(fn); return win; },
            close: function () {
                if (!WINS[key]) return;
                delete WINS[key];
                win.hide();
                closers.splice(0).forEach(function (fn) { try { fn(); } catch (e) { report("модуль " + mod + ": окно", e); } });
            },
        };
        close.addEventListener("click", function () { if (o.closeHides) win.hide(); else win.close(); });
        WINS[key] = win;
        (modDispose[mod] = modDispose[mod] || []).push(function () { win.close(); });
        if (o.show !== false) win.show();
        return win;
    }

    function closeModuleWindows(mod) {
        Object.keys(WINS).forEach(function (k) { if (k.indexOf(mod + "/") === 0) WINS[k].close(); });
    }

    // ---------------------------------------------------------------------------
    //  Общая шина модулей одного окна: mc.share("accent", "#89b4fa") в одном модуле и
    //  mc.shared("accent", fn) в другом. Значение — JSON (до 64 КБ), у каждого ключа есть автор
    //  (id модуля): подписчик получает (value, from). Выключенный модуль забирает свои значения.
    //  Договорённости о ключах — в types/mooncore.d.ts (SharedKeys).
    // ---------------------------------------------------------------------------
    var SHARED = {};         // key -> { value, from }
    var sharedSubs = {};     // key -> [fn]
    var SHARED_KEY_RE = /^[a-z][\w.-]{0,63}$/i;
    var SHARED_MAX = 65536;

    function sharedFire(key) {
        var rec = SHARED[key];
        (sharedSubs[key] || []).slice().forEach(function (fn) {
            try { fn(rec ? JSON.parse(JSON.stringify(rec.value)) : undefined, rec ? rec.from : ""); } catch (e) { report("общая шина: " + key, e); }
        });
    }

    /** Записать значение (undefined — убрать). true — принято. */
    function shareValue(from, key, value) {
        if (!SHARED_KEY_RE.test(String(key))) return false;
        if (value === undefined) {
            if (!SHARED[key]) return true;
            delete SHARED[key];
            sharedFire(key);
            return true;
        }
        var text;
        try { text = JSON.stringify(value); } catch (e) { return false; }
        if (text === undefined || text.length > SHARED_MAX) return false;
        if (SHARED[key] && SHARED[key].from === from && JSON.stringify(SHARED[key].value) === text) return true;
        SHARED[key] = { value: JSON.parse(text), from: from };
        sharedFire(key);
        return true;
    }

    /** Подписка: fn(value, from). Текущее значение — сразу (асинхронно). Возвращает отписку. */
    function sharedOn(key, fn) {
        if (!SHARED_KEY_RE.test(String(key)) || typeof fn !== "function") return function () {};
        var list = (sharedSubs[key] = sharedSubs[key] || []);
        list.push(fn);
        if (SHARED[key]) setTimeout(function () {
            var rec = SHARED[key];
            if (rec && list.indexOf(fn) !== -1) { try { fn(JSON.parse(JSON.stringify(rec.value)), rec.from); } catch (e) { report("общая шина: " + key, e); } }
        }, 0);
        return function () { var i = list.indexOf(fn); if (i !== -1) list.splice(i, 1); };
    }

    function sharedGet(key) {
        var rec = SHARED[key];
        return rec ? { value: JSON.parse(JSON.stringify(rec.value)), from: rec.from } : undefined;
    }

    /** Модуль выключен — его значения уходят (подписчики получают undefined). */
    function sharedDrop(from) {
        Object.keys(SHARED).forEach(function (k) { if (SHARED[k].from === from) { delete SHARED[k]; sharedFire(k); } });
    }

    // ---------------------------------------------------------------------------
    //  Старт и самолечение.
    // ---------------------------------------------------------------------------
    function whenWorkbench(cb) {
        var started = Date.now();
        (function wait() {
            if (document.body && (document.querySelector(".monaco-workbench") || Date.now() - started > 30000)) cb();
            else setTimeout(wait, 150);
        })();
    }

    applyState(parse(readSync(BOOT.stateUrl)) || BOOT.state || null);
    stage("state");

    whenWorkbench(function () {
        domReady = true;
        stage("workbench");
        render(false);
        stage("snippets");
        afterDS();
        // VS Code перерисовывает статусбар и титлбар — свои кнопки возвращаем на место.
        setInterval(function () { try { ensureButtons(); } catch (e) {} }, 1500);
        // Контекст окна (язык, ветка...) — спросить свой хост сразу, не дожидаясь событий.
        setTimeout(function () { rpcFirst("context", {}, ownToken && hosts[ownToken] ? hosts[ownToken] : null).then(function (r) { if (r && r.ok) applyCtx(r); }); }, 1500);
    });

    refreshHosts();
    setInterval(refreshHosts, 5000);
    // VS Code перестраивает DOM — наши <style> могли выпасть из <head>. Наблюдатель за <head>
    // возвращает их сразу и без опроса; редкий таймер — страховка (и путь без MutationObserver).
    var cssHealT = null;
    function ourStyleLost() {
        if (designStyle && !designStyle.isConnected && designStyle.textContent) return true;
        return Object.keys(styles).some(function (id) { return !styles[id].isConnected; });
    }
    function healCssSoon() {
        if (cssHealT) return;
        cssHealT = setTimeout(function () { cssHealT = null; try { renderCss(); } catch (e) {} }, 30);
    }
    var headObserved = false;
    try {
        if (typeof MutationObserver === "function" && document.head) {
            new MutationObserver(function () { if (ourStyleLost()) healCssSoon(); }).observe(document.head, { childList: true });
            headObserved = true;
        }
    } catch (e) {}
    setInterval(function () { try { renderCss(); } catch (e) {} }, headObserved ? 10000 : 2000);

    timing.runtime = Math.round((now() - T0) * 10) / 10;
    var modT0 = {};
    // Запуск удался: окно загрузилось и прожило ещё несколько секунд — снимаем метку, шлём время.
    function bootOk() {
        guard = { n: 0, last: "" }; saveGuard();
        if (skipped.length) {
            var msg = "Moon Core: модуль " + skipped.join(", ") + " пропущен — в прошлый раз окно не запустилось на нём. Перезагрузи окно, чтобы попробовать снова.";
            report("защита запуска", msg);
            try { toast(msg); } catch (e) {}
        }
        // Старым правкам без отпечатка — отпечаток (одно окно в фокусе, чтобы не дублировать).
        if (hasFocus()) setTimeout(function () { try { if (domReady) backfillPrints(); } catch (e) { report("отпечатки правок", e); } }, 3000);
        var tries = 0;
        (function send() {
            rpcAny("timing", timing).then(function (r) { if (!(r && r.ok) && ++tries < 4) setTimeout(send, 5000); },
                function () { if (++tries < 4) setTimeout(send, 5000); });
        })();
    }
    function onLoaded() { stage("load"); scheduleLazy(); setTimeout(bootOk, 4000); }
    if (document.readyState === "complete") onLoaded();
    else window.addEventListener("load", onLoaded);

    window.__MOONCORE__ = {
        version: BOOT.version || "",
        /** Защита запуска (зовёт первая строка файла модуля): пропустить ли модуль id. */
        _skip: function (id) {
            modRan[id] = true;
            var s = skipAll || (skipOne && skipOne === id);
            if (s && skipped.indexOf(id) === -1) skipped.push(id);
            return !!s;
        },
        /** Метки вокруг скрипта модуля: время загрузки и «на ком встал запуск». */
        _modStart: function (id) { modT0[id] = now(); guard.last = String(id); saveGuard(); },
        _modDone: function (id) {
            // Файл модуля между метками так и не начал выполняться: не прошёл проверку целостности,
            // пропал или не загрузился. Хост перепишет файлы (и выключит integrity, если дело в ней).
            if (modT0[id] != null && !modRan[id] && timing.failed.indexOf(id) === -1) {
                timing.failed.push(id);
                report("модуль " + id, "файл модуля не выполнился (проверка целостности, файл отсутствует или изменён)");
            }
            if (modT0[id] != null && skipped.indexOf(id) === -1 && modRan[id]) timing.modules[id] = Math.round((now() - modT0[id]) * 10) / 10;
            if (guard.last === id) { guard.last = ""; saveGuard(); }
        },
        selectorFor: selectorFor,
        /** Сервисы окна VS Code (глубокая интеграция): available(), get(name), names(). */
        services: servicesApi,
        /** Отладка и тесты: отпечатки старых правок, поиск замены для правила. */
        _backfill: function () { return backfillPrints(); },
        _heal: function (sel, fp) { return healRule(sel, fp); },
        startPick: function () { startPick(null); },
        startDesign: function () { startDesign(null); },
        stopDesign: stopDesign,
        stopPick: stopPick,
        applyState: applyState,
        applyPreview: applyPreview,
        checkAll: checkAll,
        fail: function (id, e) { report("выполнение", e, id); },
        /** Помощник модуля (null — модуль не впечатан). */
        module: moduleApi,
        /** Загрузить ленивый (или снова включить выключенный) модуль: Promise<boolean>. */
        loadModule: function (id) { return loadModule(String(id)); },
        /** Состояние модуля: { loaded, off, lazy } или null. */
        moduleState: function (id) { var m = MODS[id]; return m ? { loaded: !!m.loaded, off: !!m.off, lazy: !!m.lazy } : null; },
        /** Общая шина модулей — только чтение (сниппеты и отладка). */
        shared: { get: function (k) { return sharedGet(k); }, on: function (k, fn) { return sharedOn(k, fn); } },
        info: function () {
            return {
                rev: rev, domReady: domReady,
                css: Object.keys(styles), js: Object.keys(running), previews: Object.keys(previews),
                design: { rules: Object.keys(DS.rules).length, settings: Object.keys(DS.settings).length, on: !!des, queued: opQueue.length },
                hosts: Object.keys(hosts).map(function (t) { return { port: hosts[t].port, open: hosts[t].open, own: isOwnHost(t) }; }),
                modules: Object.keys(MODS),
                // Интерфейс (конструктор, пипетка): встроен целиком, ждёт первого открытия или загружен.
                ui: typeof UI === "undefined" ? "inline" : UI ? "loaded" : "lazy",
            };
        },
    };
})();
