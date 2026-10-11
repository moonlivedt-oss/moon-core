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
    // Безопасный режим (флаг из состояния): сниппеты, правки и модули не работают.
    var SAFE = false;
    // Случайный id этого окна: по нему хост отличает окна в пульсе (метод моста "hello").
    var WIN_ID = (function () {
        var s = "";
        try { var a = new Uint8Array(8); window.crypto.getRandomValues(a); for (var i = 0; i < a.length; i++) s += ("0" + a[i].toString(16)).slice(-2); } catch (e) { s = ""; }
        while (s.length < 16) s += Math.floor(Math.random() * 16).toString(16);
        return s;
    })();

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
    // JS-сниппет, который падает без остановки (таймер, наблюдатель за DOM), тормозит окно и
    // заваливает журнал. Больше CRASH_MAX ошибок за минуту — сниппет останавливается в этом
    // окне до правки его кода (или перезагрузки окна).
    var CRASH_MAX = 8, crashes = {}, crashed = {};
    function crashGuard(id) {
        var t = Date.now(), c = crashes[id];
        if (!c || t - c.start > 60000) c = crashes[id] = { start: t, n: 0 };
        if (++c.n <= CRASH_MAX || !running[id] || crashed[id] != null) return;
        crashed[id] = running[id].code;
        setTimeout(function () {
            try { stopJs(id); } catch (e) {}
            try { toast("Moon Core: сниппет " + id + " остановлен — он падает без остановки. Поправь код, он запустится снова.", "error"); } catch (e) {}
        }, 0);
    }
    function report(where, err, snippet) {
        try { console.error("[moon-core] " + where + ":", err); } catch (e) {}
        var now = Date.now();
        if (now - _logWindow > 60000) { _logWindow = now; _logCount = 0; }
        if (snippet) crashGuard(snippet);
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
            sendHello(rec);
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
    /** Пульс: хост узнаёт, что окно живо и какой в нём рантайм (Доктор покажет окна со старым), и сводку подвисаний окна. */
    function sendHello(rec) {
        try { rpc(rec, "hello", { win: WIN_ID, version: BOOT.version || "", rev: rev, safe: SAFE, perf: perfInfo() }); } catch (e) {}
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
    // Предпросмотр стиля, которого ещё нет среди сниппетов (галерея: стиль виден по наведению в
    // списке, до включения). Такой предпросмотр живёт, пока хост его не снимет.
    var PREVIEW_ONLY = "gallery-preview.css";
    var domReady = false;

    function applyState(st) {
        if (!st || !Array.isArray(st.snippets)) return;
        SAFE = st.safe === true;
        var next = {};
        st.snippets.slice(0, PROTO.MAX_SNIPPETS).forEach(function (s) {
            if (!s || !ID_RE.test(String(s.id)) || typeof s.code !== "string" || s.code.length > PROTO.MAX_SNIPPET) return;
            next[s.id] = { kind: /\.js$/.test(s.id) ? "js" : "css", code: s.code };
        });
        // Сохранили ровно то, что было в превью, — превью больше не нужно.
        Object.keys(previews).forEach(function (id) { if (id !== PREVIEW_ONLY && (!next[id] || next[id].code === previews[id])) delete previews[id]; });
        saved = next;
        rev = String(st.rev || "");
        adoptDesign(st);
        render(false);
        try { safeBadge(); } catch (e) {}
    }

    function applyPreview(d) {
        if (!d || !ID_RE.test(String(d.id)) || /\.js$/.test(d.id)) return;
        if (typeof d.code === "string" && d.code.length <= PROTO.MAX_SNIPPET) previews[d.id] = d.code;
        else delete previews[d.id];
        renderCss();
    }

    function headEl() { return document.head || document.documentElement; }

    function renderCss() {
        var ids = Object.keys(saved).filter(function (id) { return saved[id].kind === "css"; });
        if (previews[PREVIEW_ONLY] != null && !saved[PREVIEW_ONLY] && !SAFE) ids.push(PREVIEW_ONLY);
        ids.sort();
        Object.keys(styles).forEach(function (id) {
            if (ids.indexOf(id) === -1) { try { styles[id].remove(); } catch (e) {} delete styles[id]; }
        });
        var reorder = false;
        ids.forEach(function (id) {
            var code = previews[id] != null ? previews[id] : saved[id].code;
            if (typeof code !== "string") return;
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
        if (panicOn) applyPanic();                 // «стоп-кран» держит выключенными и новые стили
    }

    function renderJs(force) {
        Object.keys(running).forEach(function (id) {
            var s = saved[id];
            if (force || !s || s.kind !== "js" || s.code !== running[id].code) stopJs(id);
        });
        if (!domReady) return;
        Object.keys(saved).sort().forEach(function (id) {
            // Остановленный за поток ошибок сниппет ждёт нового кода.
            if (crashed[id] != null && crashed[id] !== saved[id].code) delete crashed[id];
            if (saved[id].kind === "js" && !running[id] && crashed[id] == null) runJs(id, saved[id].code);
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
    //  Сообщения складываются стопкой (до TOAST_MAX), каждое гаснет само; повтор того же текста
    //  не плодит строки, а продлевает уже показанную. kind: "" | "warn" | "error" — цвет рамки
    //  и время показа.
    var toastEl = null, toastItems = [], TOAST_MAX = 4;
    var TOAST_KIND = { warn: ["var(--vscode-editorWarning-foreground, #f9e2af)", 4200], error: ["var(--vscode-errorForeground, #f38ba8)", 6000] };
    function toastDrop(it) {
        clearTimeout(it.timer);
        try { it.el.remove(); } catch (e) {}
        var i = toastItems.indexOf(it);
        if (i !== -1) toastItems.splice(i, 1);
        if (!toastItems.length && toastEl) { try { toastEl.remove(); } catch (e) {} }
    }
    function toast(text, kind) {
        if (!document.body) return;
        text = String(text);
        var k = TOAST_KIND[kind] || ["var(--vscode-focusBorder, #89b4fa)", 2600];
        if (!toastEl) {
            toastEl = document.createElement("div");
            toastEl.setAttribute("data-mooncore-ui", "toast");
            toastEl.setAttribute("role", "status");
            toastEl.setAttribute("aria-live", "polite");
            Object.assign(toastEl.style, {
                position: "fixed", left: "50%", bottom: "48px", transform: "translateX(-50%)", zIndex: String(Z + 5),
                display: "flex", flexDirection: "column", alignItems: "center", gap: "6px", pointerEvents: "none", maxWidth: "70vw",
            });
        }
        var same = null;
        for (var i = 0; i < toastItems.length; i++) if (toastItems[i].text === text) same = toastItems[i];
        if (same) { clearTimeout(same.timer); same.timer = setTimeout(function () { toastDrop(same); }, k[1]); return; }
        var el = document.createElement("div");
        Object.assign(el.style, {
            padding: "8px 14px", borderRadius: "8px", font: "12px/1.4 var(--vscode-font-family, sans-serif)",
            background: "var(--vscode-editorWidget-background, #1e1e2e)", color: "var(--vscode-editorWidget-foreground, #cdd6f4)",
            border: "1px solid " + k[0], boxShadow: "0 6px 24px rgba(0,0,0,.35)", whiteSpace: "pre-wrap",
        });
        el.textContent = text;
        var it = { el: el, text: text, timer: null };
        it.timer = setTimeout(function () { toastDrop(it); }, k[1]);
        toastItems.push(it);
        while (toastItems.length > TOAST_MAX) toastDrop(toastItems[0]);
        toastEl.appendChild(el);
        toastEl.style.bottom = des ? "84px" : "48px";          // над полосой конструктора, а не поверх неё
        if (!toastEl.isConnected) document.body.appendChild(toastEl);
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
    //  Пипетка.
    // ---------------------------------------------------------------------------
    var pick = null;   // {host, cur, stack, frozen, box, tip, hint, menu, input, countEl, x, y}
    var PICK_EVENTS = ["mousedown", "mouseup", "click", "dblclick", "auxclick", "pointerdown", "pointerup", "contextmenu"];

    function uiBox(style) {
        var d = document.createElement("div");
        d.setAttribute("data-mooncore-ui", "pick");
        Object.assign(d.style, { position: "fixed", zIndex: String(Z), pointerEvents: "none", boxSizing: "border-box" }, style);
        document.body.appendChild(d);
        return d;
    }

    function startPick(host) {
        if (!document.body) return;
        if (pick) { pick.host = host || pick.host; return; }
        if (des) stopDesign();
        var accent = "var(--vscode-focusBorder, #89b4fa)";
        pick = { host: host || null, cur: null, stack: [], frozen: false, x: 0, y: 0 };
        pick.box = uiBox({ border: "2px solid " + accent, background: "color-mix(in srgb, " + accent + " 14%, transparent)", borderRadius: "3px", display: "none" });
        pick.tip = uiBox({
            padding: "3px 8px", borderRadius: "5px", font: "11px/1.4 var(--vscode-editor-font-family, monospace)",
            background: "var(--vscode-editorWidget-background, #1e1e2e)", color: "var(--vscode-editorWidget-foreground, #cdd6f4)",
            border: "1px solid " + accent, maxWidth: "60vw", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "none",
        });
        pick.hint = uiBox({
            bottom: "30px", left: "50%", transform: "translateX(-50%)", padding: "5px 12px", borderRadius: "6px",
            font: "12px/1.4 var(--vscode-font-family, sans-serif)", background: accent, color: "var(--vscode-button-foreground, #11111b)",
        });
        pick.hint.textContent = "Пипетка: клик — выбрать, колесо — родитель / потомок, Esc — выход";
        window.addEventListener("mousemove", onPickMove, true);
        window.addEventListener("wheel", onPickWheel, { capture: true, passive: false });
        window.addEventListener("keydown", onPickKey, true);
        PICK_EVENTS.forEach(function (ev) { window.addEventListener(ev, onPickClick, true); });
    }

    function stopPick() {
        if (!pick) return;
        window.removeEventListener("mousemove", onPickMove, true);
        window.removeEventListener("wheel", onPickWheel, { capture: true, passive: false });
        window.removeEventListener("keydown", onPickKey, true);
        PICK_EVENTS.forEach(function (ev) { window.removeEventListener(ev, onPickClick, true); });
        ["box", "tip", "hint", "menu"].forEach(function (k) { if (pick[k]) { try { pick[k].remove(); } catch (e) {} } });
        pick = null;
    }

    function onPickMove(e) {
        if (!pick || pick.frozen || isOurUi(e.target)) return;
        pick.x = e.clientX; pick.y = e.clientY;
        if (e.target !== pick.cur && e.target && e.target.nodeType === 1) { pick.cur = e.target; pick.stack = []; drawPick(); }
    }
    function onPickWheel(e) {
        if (!pick || !pick.cur || isOurUi(e.target)) return;
        e.preventDefault(); e.stopPropagation();
        // Один щелчок колеса даёт пачку событий — шагаем не чаще раза в 120 мс.
        var now = Date.now();
        if (now - (pick.wheelAt || 0) < 120) return;
        pick.wheelAt = now;
        if (e.deltaY < 0) {
            var p = pick.cur.parentElement;
            if (p && p !== document.documentElement && p !== document.body) { pick.stack.push(pick.cur); pick.cur = p; }
        } else if (pick.stack.length) pick.cur = pick.stack.pop();
        drawPick();
        if (pick.frozen && pick.input) { pick.input.value = selectorFor(pick.cur); updateCount(); }
    }
    function onPickKey(e) {
        if (!pick) return;
        if (e.key === "Escape") {
            e.preventDefault(); e.stopPropagation();
            if (pick.frozen) unfreeze(); else stopPick();
        } else if (e.key === "Enter" && pick.frozen) {
            e.preventDefault(); e.stopPropagation();
            doAction("style");
        }
    }
    function onPickClick(e) {
        if (!pick || isOurUi(e.target)) return;
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        if (e.type !== "click") return;
        if (pick.frozen) { unfreeze(); onPickMove(e); return; }
        if (pick.cur) freeze(e.clientX, e.clientY);
    }

    function drawPick() {
        if (!pick || !pick.cur) return;
        var r = pick.cur.getBoundingClientRect();
        Object.assign(pick.box.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
        pick.tip.textContent = selectorFor(pick.cur) + "   " + Math.round(r.width) + "\u00d7" + Math.round(r.height);
        pick.tip.style.display = "block";
        var ty = r.top - 24 >= 0 ? r.top - 24 : Math.min(window.innerHeight - 24, r.bottom + 4);
        Object.assign(pick.tip.style, { left: Math.max(4, Math.min(r.left, window.innerWidth - 300)) + "px", top: ty + "px" });
    }

    function button(text, fn, primary) {
        var b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        Object.assign(b.style, {
            font: "inherit", padding: "4px 10px", borderRadius: "5px", cursor: "pointer",
            border: "1px solid var(--vscode-button-border, var(--vscode-focusBorder, #89b4fa))",
            background: primary ? "var(--vscode-button-background, #89b4fa)" : "transparent",
            color: primary ? "var(--vscode-button-foreground, #11111b)" : "inherit",
        });
        b.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); fn(); });
        return b;
    }

    function freeze(x, y) {
        pick.frozen = true;
        pick.hint.textContent = "Колесо — родитель / потомок, Enter — стиль, Esc — назад";
        var m = document.createElement("div");
        m.setAttribute("data-mooncore-ui", "menu");
        Object.assign(m.style, {
            position: "fixed", zIndex: String(Z + 1), width: "360px", padding: "10px", borderRadius: "8px",
            font: "12px/1.4 var(--vscode-font-family, sans-serif)", boxShadow: "0 10px 32px rgba(0,0,0,.4)",
            background: "var(--vscode-editorWidget-background, #1e1e2e)", color: "var(--vscode-editorWidget-foreground, #cdd6f4)",
            border: "1px solid var(--vscode-focusBorder, #89b4fa)", display: "flex", flexDirection: "column", gap: "8px",
        });
        var input = document.createElement("input");
        input.type = "text";
        input.spellcheck = false;
        input.value = selectorFor(pick.cur);
        Object.assign(input.style, {
            font: "12px var(--vscode-editor-font-family, monospace)", padding: "5px 7px", borderRadius: "4px", width: "100%", boxSizing: "border-box",
            background: "var(--vscode-input-background, #11111b)", color: "var(--vscode-input-foreground, #cdd6f4)",
            border: "1px solid var(--vscode-input-border, #45475a)", outline: "none",
        });
        var countEl = document.createElement("div");
        countEl.style.opacity = "0.75";
        var row = document.createElement("div");
        Object.assign(row.style, { display: "flex", gap: "6px", flexWrap: "wrap" });
        row.appendChild(button("Стиль в CSS", function () { doAction("style"); }, true));
        row.appendChild(button("Скрыть", function () { doAction("hide"); }));
        row.appendChild(button("Копировать", function () { doAction("copy"); }));
        row.appendChild(button("Отмена", function () { stopPick(); }));
        m.appendChild(input); m.appendChild(countEl); m.appendChild(row);
        document.body.appendChild(m);
        var left = Math.min(Math.max(8, x + 12), window.innerWidth - 372);
        var top = Math.min(Math.max(8, y + 12), window.innerHeight - 140);
        Object.assign(m.style, { left: left + "px", top: top + "px" });
        pick.menu = m; pick.input = input; pick.countEl = countEl;
        input.addEventListener("input", updateCount);
        input.addEventListener("keydown", function (e) {
            if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); doAction("style"); }
            else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); unfreeze(); }
        });
        updateCount();
        setTimeout(function () { try { input.focus(); input.select(); } catch (e) {} }, 0);
    }

    function updateCount() {
        if (!pick || !pick.countEl) return;
        var n = count(pick.input.value.trim());
        pick.countEl.textContent = n === Infinity ? "селектор с ошибкой" : "совпадений: " + n + (n > 1 ? " (правило коснётся всех)" : "");
        pick.countEl.style.color = n === Infinity || n === 0 ? "var(--vscode-errorForeground, #f38ba8)" : "";
    }

    function unfreeze() {
        if (!pick) return;
        pick.frozen = false;
        if (pick.menu) pick.menu.remove();
        pick.menu = pick.input = pick.countEl = null;
        pick.hint.textContent = "Пипетка: клик — выбрать, колесо — родитель / потомок, Esc — выход";
    }

    function doAction(action) {
        if (!pick || !pick.cur) return;
        var sel = (pick.input ? pick.input.value : selectorFor(pick.cur)).trim();
        if (!sel || count(sel) === Infinity) { toast("Селектор с ошибкой"); return; }
        var el = pick.cur, host = pick.host;
        var fp = null;
        try { fp = action === "hide" ? fingerprint(el, sel) : null; } catch (e) {}
        var payload = { selector: sel, action: action, info: { label: labelFor(el), style: styleHint(el) }, fp: fp };
        stopPick();
        // Сразу видно результат «Скрыть», не дожидаясь, пока расширение запишет файл.
        rpcFirst("picked", payload, host).then(function (r) {
            if (!r || !r.ok) toast("Moon Core: " + ((r && r.error) || "расширение не ответило"));
        });
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
    // Сколько шагов можно отменить и вернуть — со слов хоста, который выполнил последнюю правку.
    var HIST = { undo: 0, redo: 0 };
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
        if (p.type === "number") return p.tpl ? p.tpl.replace("%", String(v)) : v + (p.unit || "");
        return String(v);
    }
    function designCss() {
        var sels = Object.keys(DS.rules).sort(function (a, b) { return ((DS.rules[a].ts || 0) - (DS.rules[b].ts || 0)) || (a < b ? -1 : 1); });
        // peek — правило, скрытое на время подсветки (наведение на правку во вкладке «Правки»).
        if (des && des.peek) sels = sels.filter(function (s) { return s !== des.peek; });
        sels = sels.filter(function (s) { return !DS.rules[s].off; });      // выключенные правила не применяются
        return sels.map(function (sel) {
            var r = DS.rules[sel];
            var decl = Object.keys(r.props || {}).filter(function (k) { return PROPS[k]; }).map(function (k) {
                // «Показать скрытое» в конструкторе: скрытый элемент виден бледным и в рамке — его можно выбрать.
                if (k === "hide" && des && des.showHidden) return "  outline: 1px dashed var(--vscode-focusBorder, #89b4fa) !important;\n  opacity: .55 !important;";
                return "  " + PROPS[k].css + ": " + cssVal(k, r.props[k]) + " !important;" + (PROPS[k].extra ? "\n  " + PROPS[k].extra + ";" : "");
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
            if (!r || r.ok === false) toast("Moon Core: " + ((r && r.error) || "расширение не ответило — правка видна, но не сохранена"), "error");
            if (r && r.design && seq === flushSeq && !opQueue.length) {
                DS = toDS(r.design);
                if (r.settingsNow) SETNOW = r.settingsNow;
                if (r.profiles) PROFILES = r.profiles;
                if (r.history) HIST = r.history;
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
            // Правило «по состоянию» (:hover) сейчас никого не находит — отпечаток снимаем по основе.
            var plain = sel.replace(/:(hover|focus-within|active)$/, "");
            if (e && e.isConnected && hits(plain, e)) return fingerprint(e, plain);
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

    // ---- стили интерфейса конструктора
    var DES_CSS = [
        "[data-mooncore-ui=design]{position:fixed;right:12px;top:44px;width:340px;max-height:calc(100vh - 110px);overflow:auto;z-index:" + (Z + 2) + ";",
        "  box-sizing:border-box;padding:0 0 10px;border-radius:10px;font:12px/1.45 var(--vscode-font-family,sans-serif);",
        "  background:var(--vscode-editorWidget-background,#1e1e2e);color:var(--vscode-editorWidget-foreground,#cdd6f4);",
        "  border:1px solid var(--vscode-focusBorder,#89b4fa);box-shadow:0 12px 40px rgba(0,0,0,.45);}",
        "[data-mooncore-ui=design] *{box-sizing:border-box;}",
        "[data-mooncore-ui=design] .mc-h{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:8px;padding:10px 12px 8px;background:inherit;border-bottom:1px solid var(--vscode-widget-border,#313244);}",
        "[data-mooncore-ui=design] .mc-title{flex:1;font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
        "[data-mooncore-ui=design] .mc-tabs{display:flex;gap:4px;padding:8px 12px 0;}",
        "[data-mooncore-ui=design] .mc-tab{flex:1;padding:5px 0;border-radius:6px;border:1px solid transparent;background:none;color:inherit;font:inherit;cursor:pointer;opacity:.75;}",
        "[data-mooncore-ui=design] .mc-tab.on{opacity:1;border-color:var(--vscode-focusBorder,#89b4fa);background:color-mix(in srgb,var(--vscode-focusBorder,#89b4fa) 14%,transparent);}",
        "[data-mooncore-ui=design] .mc-sec{margin:10px 12px 0;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--vscode-foreground,#cdd6f4) 5%,transparent);}",
        "[data-mooncore-ui=design] .mc-sec h4{margin:0 0 6px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;opacity:.7;}",
        "[data-mooncore-ui=design] .mc-note{font-size:11px;opacity:.65;margin:2px 0 6px;}",
        "[data-mooncore-ui=design] .mc-row{display:flex;align-items:center;gap:6px;min-height:26px;}",
        "[data-mooncore-ui=design] .mc-row>label{flex:0 0 118px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
        "[data-mooncore-ui=design] .mc-row.set>label{color:var(--vscode-textLink-foreground,#89b4fa);}",
        "[data-mooncore-ui=design] .mc-ctl{flex:1;display:flex;align-items:center;gap:6px;min-width:0;}",
        "[data-mooncore-ui=design] input[type=range]{flex:1;min-width:0;accent-color:var(--vscode-focusBorder,#89b4fa);}",
        "[data-mooncore-ui=design] input[type=number],[data-mooncore-ui=design] input[type=text],[data-mooncore-ui=design] select{font:inherit;color:var(--vscode-input-foreground,#cdd6f4);background:var(--vscode-input-background,#11111b);border:1px solid var(--vscode-input-border,#45475a);border-radius:4px;padding:2px 5px;min-width:0;}",
        "[data-mooncore-ui=design] input[type=number]{width:58px;flex:0 0 58px;}",
        "[data-mooncore-ui=design] input[type=text],[data-mooncore-ui=design] select{flex:1;}",
        "[data-mooncore-ui=design] input[type=color]{width:34px;height:22px;padding:0;border:1px solid var(--vscode-input-border,#45475a);border-radius:4px;background:none;}",
        "[data-mooncore-ui=design] input[type=checkbox]{accent-color:var(--vscode-focusBorder,#89b4fa);}",
        "[data-mooncore-ui=design] .mc-x{flex:0 0 auto;width:20px;height:20px;border:none;border-radius:4px;background:none;color:inherit;opacity:.6;cursor:pointer;font:inherit;}",
        "[data-mooncore-ui=design] .mc-x:hover{opacity:1;background:color-mix(in srgb,var(--vscode-foreground,#cdd6f4) 12%,transparent);}",
        "[data-mooncore-ui=design] .mc-x.hid{visibility:hidden;}",
        "[data-mooncore-ui=design] .mc-btn{font:inherit;padding:4px 10px;border-radius:5px;cursor:pointer;color:inherit;background:transparent;border:1px solid var(--vscode-button-border,var(--vscode-focusBorder,#89b4fa));}",
        "[data-mooncore-ui=design] .mc-btn.pri{background:var(--vscode-button-background,#89b4fa);color:var(--vscode-button-foreground,#11111b);}",
        "[data-mooncore-ui=design] .mc-btn.danger{border-color:var(--vscode-errorForeground,#f38ba8);color:var(--vscode-errorForeground,#f38ba8);}",
        "[data-mooncore-ui=design] .mc-btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;}",
        "[data-mooncore-ui=design] .mc-sel{width:100%;font:11px var(--vscode-editor-font-family,monospace)!important;}",
        "[data-mooncore-ui=design] .mc-count{font-size:11px;opacity:.7;}",
        "[data-mooncore-ui=design] .mc-alt{margin-top:6px;}",
        "[data-mooncore-ui=design] .mc-drag{cursor:grab;opacity:.45;padding:0 2px;user-select:none;}",
        "[data-mooncore-ui=design] .mc-map:hover .mc-drag{opacity:.9;}",
        "[data-mooncore-ui=design] .mc-map.drop-before{box-shadow:inset 0 2px 0 var(--vscode-focusBorder,#89b4fa);}",
        "[data-mooncore-ui=design] .mc-map.drop-after{box-shadow:inset 0 -2px 0 var(--vscode-focusBorder,#89b4fa);}",
        "[data-mooncore-ui=design] .mc-count.bad{color:var(--vscode-errorForeground,#f38ba8);opacity:1;}",
        "[data-mooncore-ui=design] details>summary{cursor:pointer;opacity:.8;margin:2px 0 6px;}",
        "[data-mooncore-ui=design] .mc-card{margin:8px 12px 0;padding:8px 10px;border-radius:8px;border:1px solid var(--vscode-widget-border,#313244);}",
        "[data-mooncore-ui=design] .mc-card .mc-cap{font-weight:600;}",
        "[data-mooncore-ui=design] .mc-card code{display:block;font:10.5px var(--vscode-editor-font-family,monospace);opacity:.6;word-break:break-all;margin:2px 0 4px;}",
        "[data-mooncore-ui=design] .mc-line{display:flex;align-items:center;gap:6px;min-height:22px;}",
        "[data-mooncore-ui=design] .mc-line span{flex:1;}",
        "[data-mooncore-ui=design] .mc-empty{margin:14px 12px 4px;opacity:.7;}",
        "[data-mooncore-ui=design] .mc-tab{font-size:11.5px;}",
        "[data-mooncore-ui=design] .mc-pad{margin:10px 12px 0;}",
        "[data-mooncore-ui=design] .mc-map{display:flex;align-items:center;gap:7px;min-height:26px;}",
        "[data-mooncore-ui=design] .mc-map-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
        "[data-mooncore-ui=design] .mc-map-name small{opacity:.55;}",
        "[data-mooncore-ui=design] .mc-map.off .mc-map-name{opacity:.55;}",
        "[data-mooncore-ui=design] .mc-map.hidden-el .mc-map-name{text-decoration:line-through;opacity:.6;}",
        "[data-mooncore-ui=design] .mc-btn.mc-mini{padding:1px 8px;font-size:11px;opacity:.8;}",
        "[data-mooncore-ui=design] .mc-map:not(:hover) .mc-mini{opacity:.35;}",
        "[data-mooncore-ui=design] .mc-list{margin:0 0 4px 22px;padding-left:8px;border-left:1px solid var(--vscode-widget-border,#313244);}",
        "[data-mooncore-ui=design] .mc-sub{min-height:22px;font-size:11.5px;}",
        "[data-mooncore-ui=design] .mc-prof{margin-top:8px;padding:8px 10px;border-radius:8px;border:1px solid var(--vscode-widget-border,#313244);}",
        "[data-mooncore-ui=design] .mc-prof.on{border-color:var(--vscode-focusBorder,#89b4fa);}",
        "[data-mooncore-ui=design] .mc-prof-h{display:flex;align-items:center;gap:8px;}",
        "[data-mooncore-ui=design] .mc-prof-h small{opacity:.6;}",
        "[data-mooncore-ui=design] .mc-prof-h .mc-now{opacity:1;color:var(--vscode-textLink-foreground,#89b4fa);}",
        "[data-mooncore-ui=design-bar]{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);z-index:" + (Z + 2) + ";display:flex;align-items:center;gap:10px;",
        "  padding:6px 8px 6px 14px;border-radius:8px;font:12px/1.4 var(--vscode-font-family,sans-serif);",
        "  background:var(--vscode-focusBorder,#89b4fa);color:var(--vscode-button-foreground,#11111b);box-shadow:0 6px 24px rgba(0,0,0,.35);}",
        "[data-mooncore-ui=design-bar] button{font:inherit;padding:3px 10px;border-radius:5px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;white-space:nowrap;}",
        "[data-mooncore-ui=design-bar]{max-width:calc(100vw - 24px);box-sizing:border-box;}",
        "[data-mooncore-ui=design-bar] button:hover{background:color-mix(in srgb,currentColor 16%,transparent);}",
        "[data-mooncore-ui=design] .mc-search{display:block;width:calc(100% - 24px);margin:8px 12px 0;padding:4px 8px!important;}",
        "[data-mooncore-ui=design] .mc-btn:hover{background:color-mix(in srgb,var(--vscode-focusBorder,#89b4fa) 16%,transparent);}",
        "[data-mooncore-ui=design] .mc-btn.pri:hover{filter:brightness(1.12);}",
        "[data-mooncore-ui=design] .mc-tab:hover{opacity:1;}",
        "[data-mooncore-ui=design] button:focus-visible,[data-mooncore-ui=design] input:focus-visible,[data-mooncore-ui=design] select:focus-visible,[data-mooncore-ui=design-bar] button:focus-visible{outline:1px solid var(--vscode-focusBorder,#89b4fa);outline-offset:1px;}",
        "[data-mooncore-ui=design]::-webkit-scrollbar{width:8px;}",
        "[data-mooncore-ui=design]::-webkit-scrollbar-thumb{border-radius:4px;background:color-mix(in srgb,var(--vscode-foreground,#cdd6f4) 22%,transparent);}",
        "[data-mooncore-ui=design] .mc-swatches{display:flex;flex-wrap:wrap;gap:4px;margin:2px 0 6px;}",
        "[data-mooncore-ui=design] .mc-sw{width:18px;height:18px;padding:0;border-radius:4px;border:1px solid var(--vscode-input-border,#45475a);cursor:pointer;}",
        "[data-mooncore-ui=design] .mc-sw:hover{transform:scale(1.18);}",
        "[data-mooncore-ui=design] .mc-card.off{opacity:.55;}",
        "[data-mooncore-ui=design] .mc-icons{display:flex;flex-wrap:wrap;gap:3px;max-height:150px;overflow:auto;margin-bottom:4px;}",
        "[data-mooncore-ui=design] .mc-ico{width:26px;height:26px;padding:0;border-radius:5px;border:1px solid transparent;background:none;color:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;}",
        "[data-mooncore-ui=design] .mc-ico:hover,[data-mooncore-ui=design] .mc-ico.on{border-color:var(--vscode-focusBorder,#89b4fa);background:color-mix(in srgb,var(--vscode-focusBorder,#89b4fa) 14%,transparent);}",
        "@keyframes mc-in{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}",
        "@keyframes mc-bar-in{from{opacity:0;transform:translate(-50%,8px);}to{opacity:1;transform:translate(-50%,0);}}",
        "@media (prefers-reduced-motion:no-preference){[data-mooncore-ui=design]{animation:mc-in .16s ease-out;}[data-mooncore-ui=design-bar]{animation:mc-bar-in .16s ease-out;}",
        "  [data-mooncore-ui=design] .mc-btn,[data-mooncore-ui=design] .mc-tab,[data-mooncore-ui=design] .mc-x{transition:background-color .12s ease,opacity .12s ease,border-color .12s ease;}}",
    ].join("\n");

    function h(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }
    function btn(text, cls, fn, title) {
        var b = h("button", "mc-btn" + (cls ? " " + cls : ""), text);
        b.type = "button";
        if (title) b.title = title;
        b.addEventListener("click", function (e) { e.preventDefault(); fn(e); });
        return b;
    }
    function xBtn(visible, fn, title) {
        var b = h("button", "mc-x" + (visible ? "" : " hid"), "×");
        b.type = "button";
        b.title = title || "Вернуть как было";
        b.addEventListener("click", function (e) { e.preventDefault(); fn(); });
        return b;
    }

    // ---- режим
    var DES_EVENTS = ["mousedown", "mouseup", "click", "dblclick", "auxclick", "pointerdown", "pointerup", "contextmenu"];

    function toggleDesign(host) { if (des) stopDesign(); else startDesign(host); }

    function startDesign(host) {
        if (!document.body) return;
        if (des) { des.host = host || des.host; return; }
        stopPick();
        des = { host: host || null, hoverEl: null, selEl: null, sel: "", entry: null, anchor: null, stack: [], tab: "map", confirmClear: false, confirm: "" };
        des.style = document.createElement("style");
        des.style.setAttribute("data-mooncore-ui", "design-css");
        if (NONCE) des.style.setAttribute("nonce", NONCE);
        des.style.textContent = DES_CSS;
        headEl().appendChild(des.style);
        var accent = "var(--vscode-focusBorder, #89b4fa)";
        des.hoverBox = uiBox({ border: "1px dashed " + accent, borderRadius: "3px", display: "none" });
        des.selBox = uiBox({ border: "2px solid " + accent, background: "color-mix(in srgb, " + accent + " 12%, transparent)", borderRadius: "3px", display: "none" });
        des.tip = uiBox({
            padding: "2px 7px", borderRadius: "5px", font: "11px/1.4 var(--vscode-font-family, sans-serif)",
            background: "var(--vscode-editorWidget-background, #1e1e2e)", color: "var(--vscode-editorWidget-foreground, #cdd6f4)",
            border: "1px solid " + accent, whiteSpace: "nowrap", display: "none",
        });
        des.bar = h("div");
        des.bar.setAttribute("data-mooncore-ui", "design-bar");
        des.bar.title = "Тяни за ручки рамки — размер и масштаб. Shift+клик — добавить элемент к выбранным. Стрелка вверх — родитель, Delete — скрыть, Ctrl+Z — отменить, Esc — выйти.";
        des.bar.appendChild(h("span", null, "Конструктор: клик — выбрать, Alt+клик — обычный клик"));
        des.bar.appendChild(histButtons());
        des.bar.appendChild(showHiddenButton());
        des.bar.appendChild(compareButton());
        des.bar.appendChild(btnPlain("Готово", stopDesign));
        document.body.appendChild(des.bar);
        des.panel = h("div");
        des.panel.setAttribute("data-mooncore-ui", "design");
        des.panel.setAttribute("role", "dialog");
        des.panel.setAttribute("aria-label", "Конструктор Moon Core");
        document.body.appendChild(des.panel);
        restorePanel();
        makeHandles();
        window.addEventListener("mousemove", onDesMove, true);
        window.addEventListener("keydown", onDesKey, true);
        DES_EVENTS.forEach(function (ev) { window.addEventListener(ev, onDesClick, true); });
        des.timer = setInterval(drawDesign, 150);
        renderPanel(true);
    }
    function btnPlain(text, fn) {
        var b = h("button", null, text); b.type = "button";
        b.addEventListener("click", function (e) { e.preventDefault(); fn(); });
        return b;
    }

    function stopDesign() {
        if (!des) return;
        setCompare(false);
        clearHighlight();
        flushOps();
        clearInterval(des.timer);
        window.removeEventListener("mousemove", onDesMove, true);
        window.removeEventListener("keydown", onDesKey, true);
        DES_EVENTS.forEach(function (ev) { window.removeEventListener(ev, onDesClick, true); });
        ["hoverBox", "selBox", "tip", "bar", "panel", "style", "marker"].forEach(function (k) { if (des[k]) { try { des[k].remove(); } catch (e) {} } });
        Object.keys(des.handles || {}).forEach(function (k) { try { des.handles[k].remove(); } catch (e) {} });
        des = null;
    }

    function onDesMove(e) {
        if (!des) return;
        if (des.dragging) return;
        if (isOurUi(e.target)) { des.hoverEl = null; drawDesign(); return; }
        if (e.target && e.target.nodeType === 1) des.hoverEl = e.target;
        drawDesign();
    }
    function onDesClick(e) {
        if (!des || isOurUi(e.target) || e.altKey) return;
        // Идёт перетаскивание ручки: её mouseup тоже слушает window — не глушим соседние обработчики.
        if (des.dragging) { e.preventDefault(); e.stopPropagation(); return; }
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        // Клик, которым закончилось перетаскивание ручки, — не выбор нового элемента.
        if (des.suppressClick) { if (e.type === "click") des.suppressClick = false; return; }
        if (e.type === "click" && e.target && e.target.nodeType === 1) { if (e.shiftKey && des.sel) addToSelection(e.target); else selectEl(e.target); }
    }
    function onDesKey(e) {
        if (!des) return;
        if (e.key !== "Escape") {
            // В полях панели клавиши — для текста; Alt оставлен самому VS Code.
            if (e.altKey || (isOurUi(e.target) && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName))) return;
            var act = designHotkey(e);
            if (act) { e.preventDefault(); e.stopPropagation(); act(); }
            return;
        }
        if (isOurUi(e.target) && /^(INPUT|SELECT)$/.test(e.target.tagName)) { e.target.blur(); e.preventDefault(); e.stopPropagation(); return; }
        e.preventDefault(); e.stopPropagation();
        if (des.selEl || des.sel) { des.selEl = null; des.sel = ""; des.entry = null; renderPanel(true); drawDesign(); }
        else stopDesign();
    }

    function placeBox(box, el) {
        if (!el || !el.isConnected) { box.style.display = "none"; return null; }
        var r = el.getBoundingClientRect();
        if (!r.width && !r.height) { box.style.display = "none"; return null; }
        Object.assign(box.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
        return r;
    }
    function drawDesign() {
        if (!des) return;
        var hv = des.hoverEl && des.hoverEl !== des.selEl && !des.compare && !des.dragging ? des.hoverEl : null;
        var r = placeBox(des.hoverBox, hv);
        if (r) {
            var c = catalogFor(hv);
            des.tip.textContent = c ? c.entry.label : labelFor(hv);
            var ty = r.top - 22 >= 0 ? r.top - 22 : r.bottom + 4;
            Object.assign(des.tip.style, { display: "block", left: Math.max(4, Math.min(r.left, window.innerWidth - 260)) + "px", top: ty + "px" });
        } else if (!des.dragging) des.tip.style.display = "none";
        var sr = des.compare ? placeBox(des.selBox, null) : placeBox(des.selBox, des.selEl);
        drawHandles(sr);
        if (des.hl && des.hl.length) drawHighlight();
    }

    function selectEl(el) {
        var c = catalogFor(el);
        des.selEl = el;
        des.multi = 1;
        des.entry = c ? c.entry : null;
        des.anchor = c ? c.anchor : null;
        // Однотипные элементы (many): по умолчанию — именно этот, «все такие» — кнопкой.
        des.sel = c && c.anchor === el && !c.entry.many ? c.entry.selector : selectorFor(el);
        des.tab = "el";
        des.confirmClear = false;
        renderPanel(true);
        placePanel();
        drawDesign();
    }
    /** Панель не должна закрывать выбранный элемент: перетащенную не трогаем, иначе — на другую сторону. */
    function placePanel() {
        if (!des || !des.panel || des.dragged || !des.selEl) return;
        var r = des.selEl.getBoundingClientRect();
        var pw = des.panel.offsetWidth || 340;
        var coversRight = r.right > window.innerWidth - pw - 24;
        var coversLeft = r.left < pw + 24;
        var left = coversRight && !coversLeft;
        des.panel.style.left = left ? "12px" : "auto";
        des.panel.style.right = left ? "auto" : "12px";
    }
    function makeDraggable(handle) {
        handle.style.cursor = "move";
        handle.addEventListener("dblclick", function (e) { if (!e.target.closest("button")) resetPanelPlace(); });
        handle.addEventListener("mousedown", function (e) {
            if (e.target.closest("button")) return;
            e.preventDefault();
            var p = des.panel, r = p.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
            var move = function (ev) {
                des.dragged = true;
                p.style.right = "auto";
                p.style.left = Math.max(0, Math.min(window.innerWidth - r.width, ev.clientX - dx)) + "px";
                p.style.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy)) + "px";
            };
            var up = function () {
                window.removeEventListener("mousemove", move, true); window.removeEventListener("mouseup", up, true);
                if (des && des.dragged) { var q = p.getBoundingClientRect(); rememberPanel({ left: q.left, top: q.top }); }
            };
            window.addEventListener("mousemove", move, true);
            window.addEventListener("mouseup", up, true);
        });
    }
    function selectParent() {
        if (!des || !des.selEl) return;
        var p = des.selEl.parentElement;
        if (!p || p === document.body || p === document.documentElement) return;
        des.stack.push(des.selEl);
        var keep = des.stack;
        selectEl(p);
        des.stack = keep;
    }
    function selectChild() {
        if (!des || !des.stack.length) return;
        var keep = des.stack, c = keep.pop();
        selectEl(c);
        des.stack = keep;
    }

    // ---- панель
    function panelBusy() {
        var a = document.activeElement;
        return !!(des && des.panel && a && des.panel.contains(a) && (a.type === "text" || a.type === "number"));
    }
    function renderPanel(force) {
        if (!des || !des.panel) return;
        if (!force && panelBusy()) return;
        clearHighlight();                     // строка, на которую навели, сейчас пропадёт
        var scroll = des.panel.scrollTop;
        des.panel.textContent = "";
        var head = h("div", "mc-h");
        head.appendChild(h("div", "mc-title", des.multi > 1 ? "Выбрано элементов: " + des.multi : des.entry && des.anchor === des.selEl ? des.entry.label : des.selEl ? labelFor(des.selEl) : "Конструктор"));
        head.appendChild(xBtn(true, stopDesign, "Закрыть конструктор"));
        head.title = "Перетащи, чтобы подвинуть панель; двойной клик — вернуть на место";
        makeDraggable(head);
        des.panel.appendChild(head);
        var n = changesCount();
        var tabs = h("div", "mc-tabs");
        tabs.setAttribute("role", "tablist");
        [["map", "Карта"], ["el", "Элемент"], ["changes", "Правки" + (n ? " " + n : "")], ["profiles", "Профили"], ["more", "Ещё"]].forEach(function (t) {
            var b = h("button", "mc-tab" + (des.tab === t[0] ? " on" : ""), t[1]);
            b.type = "button";
            b.setAttribute("role", "tab");
            b.setAttribute("aria-selected", des.tab === t[0] ? "true" : "false");
            b.addEventListener("click", function () { des.tab = t[0]; des.confirmClear = false; des.confirm = ""; rememberPanel({ tab: t[0] }); renderPanel(true); });
            tabs.appendChild(b);
        });
        des.panel.appendChild(tabs);
        if (des.tab === "changes") renderChanges();
        else if (des.tab === "map") renderMap();
        else if (des.tab === "profiles") renderProfiles();
        else if (des.tab === "more") renderMore();
        else renderElement();
        des.panel.scrollTop = scroll;
        updateHist();
    }

    function section(title, note) {
        var s = h("div", "mc-sec");
        if (title) s.appendChild(h("h4", null, title));
        if (note) s.appendChild(h("div", "mc-note", note));
        des.panel.appendChild(s);
        return s;
    }

    function renderElement() {
        if (!des.sel && des.entry) {
            var only = des.entry.settings || [];
            if (!only.length) { des.panel.appendChild(h("div", "mc-empty", "Элемента «" + des.entry.label + "» сейчас нет на экране. Открой его в VS Code (Alt+клик работает как обычный клик) и выбери.")); return; }
            var so = section("Настройки VS Code", "Надёжный способ: переживает обновления VS Code.");
            only.forEach(function (st) { so.appendChild(settingRow(st, des.entry.label)); });
            return;
        }
        if (!des.sel) {
            var e = h("div", "mc-empty", "Кликни по любому элементу интерфейса: кнопке, вкладке, панели, пункту статусбара. " +
                "Его можно будет убрать, увеличить, перекрасить. Alt+клик работает как обычный клик — открыть меню или вкладку, не выходя из конструктора.");
            des.panel.appendChild(e);
            return;
        }
        var sel = des.sel;
        var label = des.entry && des.anchor === des.selEl ? des.entry.label : des.selEl ? labelFor(des.selEl) : sel;

        // Что выбрано
        var tgt = section("Что меняем");
        var inp = h("input", "mc-sel"); inp.type = "text"; inp.spellcheck = false; inp.value = sel;
        var cnt = h("div", "mc-count");
        var upd = function () {
            var k = count(stripState(inp.value.trim()));
            cnt.textContent = k === Infinity ? "селектор с ошибкой" : k === 0 ? "сейчас ничего не находит" : "совпадений: " + k + (k > 1 ? " — правка коснётся всех" : "");
            cnt.className = "mc-count" + (k === Infinity || k === 0 ? " bad" : "");
        };
        inp.addEventListener("input", upd);
        inp.addEventListener("change", function () {
            var v = inp.value.trim();
            if (v && count(stripState(v)) !== Infinity) { des.sel = v; renderPanel(true); }
        });
        upd();
        tgt.appendChild(inp); tgt.appendChild(cnt);
        // Другие однозначные селекторы элемента (id, aria-label, title): переживают переименование классов.
        if (des.selEl && des.selEl.isConnected) {
            var alts = selectorCandidates(des.selEl, 6).filter(function (a) { return a !== sel; });
            if (alts.length) {
                var vs = h("select", "mc-sel mc-alt");
                var v0 = h("option", null, "Другие варианты селектора: " + alts.length); v0.value = ""; vs.appendChild(v0);
                alts.forEach(function (a) { var o = h("option", null, a); o.value = a; vs.appendChild(o); });
                vs.title = "Селекторы, которые находят ровно этот элемент. Moon Core всё равно запомнит их как запасные.";
                vs.addEventListener("change", function () { if (vs.value) { des.sel = vs.value; renderPanel(true); } });
                tgt.appendChild(vs);
            }
        }
        var nav = h("div", "mc-btns");
        if (des.selEl) nav.appendChild(btn("Родитель", "", selectParent, "Выбрать элемент, в который вложен этот"));
        if (des.stack.length) nav.appendChild(btn("Назад внутрь", "", selectChild));
        if (des.entry && des.anchor && des.anchor !== des.selEl) nav.appendChild(btn((des.entry.many ? "" : "Весь блок: ") + des.entry.label, "", function () { selectEl(des.anchor); }));
        if (des.entry && des.entry.many && des.sel !== des.entry.selector) {
            var allN = count(des.entry.selector);
            nav.appendChild(btn("Все такие (" + allN + ")", "", function () { des.sel = des.entry.selector; renderPanel(true); }, "Применять правки ко всем элементам этого типа"));
        } else if (des.entry && des.entry.many && des.selEl) {
            nav.appendChild(btn("Только этот", "", function () { des.sel = selectorFor(des.selEl); renderPanel(true); }));
        }
        similarButton(nav);
        if (nav.childNodes.length) tgt.appendChild(nav);
        if (des.selEl) tgt.appendChild(h("div", "mc-note", "Shift+клик по другому элементу — править несколько сразу."));
        quickSection(sel, label);
        orderSection();
        condSection();
        stateSection();
        colorSection(label);
        floatSection();

        // Настройки VS Code
        var settings = des.entry && des.entry.settings || [];
        if (settings.length) {
            var ss = section("Настройки VS Code", "Надёжный способ: переживает обновления VS Code.");
            settings.forEach(function (s) { ss.appendChild(settingRow(s, des.entry.label)); });
        }

        // CSS-свойства
        var groups = [["view", "Вид"], ["size", "Размер"], ["text", "Текст"]];
        groups.forEach(function (g) {
            var sec = section(g[1]);
            Object.keys(PROPS).filter(function (k) { return PROPS[k].group === g[0]; }).forEach(function (k) { sec.appendChild(propRow(sel, k, label)); });
        });
        var risky = Object.keys(PROPS).filter(function (k) { return PROPS[k].group === "risky"; });
        if (risky.length) {
            var sec2 = section(null);
            var det = h("details");
            det.appendChild(h("summary", null, "Ширина и высота"));
            det.appendChild(h("div", "mc-note", "Крупные зоны VS Code раскладывает сам — жёсткий размер может спорить с раскладкой. Для кнопок и значков безопасно."));
            risky.forEach(function (k) { det.appendChild(propRow(sel, k, label)); });
            if (risky.some(function (k) { return DS.rules[sel] && DS.rules[sel].props[k] !== undefined; })) det.open = true;
            sec2.appendChild(det);
        }
        var foot = h("div", "mc-btns"); foot.style.margin = "10px 12px 0";
        clipButtons(sel, label, foot);
        if (DS.rules[sel]) foot.appendChild(btn("Сбросить этот элемент", "danger", function () { resetRule(sel); renderPanel(true); }));
        if (foot.childNodes.length) des.panel.appendChild(foot);
    }

    function computed(prop) {
        if (!des.selEl) return null;
        try {
            var cs = getComputedStyle(des.selEl), p = PROPS[prop];
            if (prop === "zoom") return 100;
            var v = cs.getPropertyValue(p.css);
            if (p.type === "number") { var n = parseFloat(v); return isFinite(n) ? n : null; }
            if (p.type === "color") return toHex(v);
            return v || null;
        } catch (e) { return null; }
    }
    function toHex(c) {
        var m = String(c || "").match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
        if (!m) return /^#[0-9a-f]{6}$/i.test(c) ? c : "#000000";
        return "#" + [m[1], m[2], m[3]].map(function (x) { return ("0" + (+x).toString(16)).slice(-2); }).join("");
    }

    function propRow(sel, prop, label) {
        var p = PROPS[prop];
        var cur = DS.rules[sel] && DS.rules[sel].props[prop];
        var isSet = cur !== undefined;
        var row = h("div", "mc-row" + (isSet ? " set" : ""));
        row.appendChild(h("label", null, p.label));
        var ctl = h("div", "mc-ctl");
        row.appendChild(ctl);
        var reset = xBtn(isSet, function () { setProp(sel, prop, null, label); renderPanel(true); });
        var mark = function () { row.className = "mc-row set"; reset.className = "mc-x"; };

        if (p.type === "flag") {
            var cb = h("input"); cb.type = "checkbox"; cb.checked = cur === true;
            cb.addEventListener("change", function () { setProp(sel, prop, cb.checked ? true : null, label); renderPanel(true); });
            ctl.appendChild(cb);
            if (prop === "hide") ctl.appendChild(h("span", "mc-note", "вернуть — во вкладке «Правки»"));
        } else if (p.type === "number") {
            var base = isSet ? cur : computed(prop);
            if (base == null || !isFinite(base)) base = p.min;
            base = Math.min(p.max, Math.max(p.min, base));
            var range = h("input"); range.type = "range"; range.min = p.min; range.max = p.max; range.step = p.step; range.value = base;
            var numb = h("input"); numb.type = "number"; numb.min = p.min; numb.max = p.max; numb.step = p.step; numb.value = +(+base).toFixed(2);
            range.addEventListener("input", function () { numb.value = range.value; setProp(sel, prop, +range.value, label); mark(); });
            numb.addEventListener("change", function () {
                var v = +numb.value;
                if (!isFinite(v)) return;
                v = Math.min(p.max, Math.max(p.min, v));
                numb.value = v; range.value = v;
                setProp(sel, prop, v, label); mark();
            });
            ctl.appendChild(range); ctl.appendChild(numb);
            if (p.unit) ctl.appendChild(h("span", "mc-note", p.unit));
        } else if (p.type === "color") {
            var col = h("input"); col.type = "color"; col.value = isSet ? cur : (computed(prop) || "#000000");
            col.addEventListener("input", function () { setProp(sel, prop, col.value, label); mark(); });
            ctl.appendChild(col);
            ctl.appendChild(h("span", "mc-note", isSet ? cur : "как в теме"));
            colorExtras(col, ctl, row);
        } else if (p.type === "enum") {
            var s = h("select");
            var o0 = h("option", null, "как в теме"); o0.value = ""; s.appendChild(o0);
            p.options.forEach(function (o) { var op = h("option", null, o); op.value = o; s.appendChild(op); });
            s.value = isSet ? String(cur) : "";
            s.addEventListener("change", function () { setProp(sel, prop, s.value || null, label); renderPanel(true); });
            ctl.appendChild(s);
        } else if (p.type === "text") {
            var t = h("input"); t.type = "text"; t.value = isSet ? cur : ""; t.placeholder = "как в теме";
            t.addEventListener("change", function () {
                var v = t.value.trim();
                if (v && !/^[\w\s,'".-]{1,120}$/.test(v)) { toast("Шрифт: только буквы, цифры, пробелы, запятые и кавычки"); return; }
                setProp(sel, prop, v || null, label); renderPanel(true);
            });
            ctl.appendChild(t);
        }
        row.appendChild(reset);
        return row;
    }

    function fmtVal(v) { return v === undefined ? "по умолчанию" : typeof v === "boolean" ? (v ? "да" : "нет") : String(v); }

    function settingRow(s, entryLabel) {
        var rec = DS.settings[s.key];
        var cur = SETNOW[s.key];
        var row = h("div", "mc-row" + (rec ? " set" : ""));
        var lab = h("label", null, s.label);
        lab.title = s.key + (s.hint ? " — " + s.hint : "");
        row.appendChild(lab);
        var ctl = h("div", "mc-ctl");
        row.appendChild(ctl);
        var label = s.label + " (" + entryLabel + ")";
        if (s.type === "bool") {
            var cb = h("input"); cb.type = "checkbox"; cb.checked = cur === true;
            cb.addEventListener("change", function () { setSetting(s.key, cb.checked, label); flushOps(); });
            ctl.appendChild(cb);
        } else if (s.type === "enum") {
            var sel = h("select");
            s.options.forEach(function (o) { var op = h("option", null, o); op.value = o; sel.appendChild(op); });
            sel.value = cur != null ? String(cur) : s.options[0];
            sel.addEventListener("change", function () { setSetting(s.key, sel.value, label); flushOps(); });
            ctl.appendChild(sel);
        } else if (s.type === "number") {
            var v0 = typeof cur === "number" ? cur : s.min;
            var range = h("input"); range.type = "range"; range.min = s.min; range.max = s.max; range.step = s.step; range.value = v0;
            var numb = h("input"); numb.type = "number"; numb.min = s.min; numb.max = s.max; numb.step = s.step; numb.value = v0;
            range.addEventListener("input", function () { numb.value = range.value; setSetting(s.key, +range.value, label); });
            numb.addEventListener("change", function () {
                var v = Math.min(s.max, Math.max(s.min, +numb.value || 0));
                numb.value = v; range.value = v; setSetting(s.key, v, label);
            });
            ctl.appendChild(range); ctl.appendChild(numb);
        } else if (s.type === "font") {
            var ft = h("input"); ft.type = "text"; ft.spellcheck = false; ft.value = typeof cur === "string" ? cur : ""; ft.placeholder = "как в VS Code";
            ft.addEventListener("change", function () {
                var fv = ft.value.trim();
                if (!fv) { if (DS.settings[s.key]) { undoSetting(s.key); flushOps(); renderPanel(true); } return; }
                if (!/^[A-Za-z0-9 _,'".-]{1,160}$/.test(fv)) { toast("Шрифт: латинские имена через запятую, например: Fira Code, Consolas, monospace", "warn"); return; }
                setSetting(s.key, fv, label); flushOps();
            });
            ctl.appendChild(ft);
        }
        row.appendChild(xBtn(!!rec, function () { undoSetting(s.key); flushOps(); renderPanel(true); }, rec ? "Вернуть: " + fmtVal(rec.hadPrev ? rec.prev : undefined) : ""));
        return row;
    }

    // ---- карта интерфейса: все зоны окна, видимость галочками
    function jsonEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
    function entryVisible(e) {
        if (e.vis && typeof e.vis === "object") return !jsonEq(SETNOW[e.vis.key], e.vis.off);
        if (e.vis === "css") return !(DS.rules[e.selector] && DS.rules[e.selector].props.hide);
        return true;
    }
    function setEntryVisible(e, show) {
        if (e.vis && typeof e.vis === "object") {
            var rec = DS.settings[e.vis.key];
            // Включаем обратно: если выключали мы и исходно было видно — возвращаем исходное значение.
            if (show && rec && !(rec.hadPrev && jsonEq(rec.prev, e.vis.off))) undoSetting(e.vis.key);
            else setSetting(e.vis.key, show ? e.vis.on : e.vis.off, (show ? "Показать: " : "Скрыть: ") + e.label);
            flushOps();
        } else if (e.vis === "css") {
            setProp(e.selector, "hide", show ? null : true, e.label, null, e);
        }
        renderPanel(true);
    }
    function itemLabel(el) {
        var t = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").replace(/\s+/g, " ").trim();
        if (!t && el.id) t = el.id;
        return t.slice(0, 48) || labelFor(el);
    }
    function openEntry(e) {
        var el = null;
        if (e.selector && !e.many) { try { el = document.querySelector(e.selector); } catch (err) {} }
        if (el) { selectEl(el); return; }
        des.selEl = null; des.anchor = null; des.stack = [];
        des.entry = e;
        des.sel = e.selector || "";
        des.tab = "el";
        renderPanel(true);
        drawDesign();
    }

    function renderMap() {
        des.panel.appendChild(h("div", "mc-note mc-pad", "Всё, что есть в окне VS Code. Галочка — показывать или нет, «Настроить» — размер, шрифт, цвет и настройки элемента. Скрытое возвращается здесь же."));
        var rows = [], search = mapSearch(rows);
        des.panel.appendChild(search.input);
        ZONES.forEach(function (z) {
            var entries = CATALOG.filter(function (e) { return e.zone === z.id; });
            if (!entries.length) return;
            var sec = section(z.label);
            entries.forEach(function (e) {
                var row = h("div", "mc-map");
                var hasToggle = !!e.vis;
                var cb = h("input"); cb.type = "checkbox";
                if (hasToggle) {
                    cb.checked = entryVisible(e);
                    cb.title = e.vis === "css" ? "Скрыть правилом CSS" : "Настройка " + e.vis.key;
                    cb.addEventListener("change", function () { setEntryVisible(e, cb.checked); });
                } else { cb.disabled = true; cb.checked = true; cb.style.visibility = "hidden"; }
                row.appendChild(cb);
                var name = h("span", "mc-map-name", e.label);
                var n = e.selector ? count(e.selector) : -1;
                if (n === 0) { name.appendChild(h("small", null, " сейчас не на экране")); row.classList.add("off"); }
                else if (e.many && n > 0) name.appendChild(h("small", null, " " + n + " шт."));
                if (hasToggle && !cb.checked) row.classList.add("hidden-el");
                row.appendChild(name);
                var go = btn("Настроить", "mc-mini", function () { openEntry(e); });
                row.appendChild(go);
                if (e.selector) hoverHighlight(row, e.selector, false);
                sec.appendChild(row);
                var sub = e.list && n > 0 ? sec.appendChild(renderList(e)) : null;
                // Ищем по названию элемента, зоны и по названиям его настроек.
                rows.push({ node: row, extra: sub, sec: sec, text: (e.label + " " + z.label + " " + (e.settings || []).map(function (s) { return s.label + " " + s.key; }).join(" ")).toLowerCase() });
            });
        });
        if (des.mapQuery) search.apply();
    }

    /**
     * Поштучный список (пункты статусбара, иконки панели активности): галочка — показывать,
     * строки можно перетаскивать — так меняется порядок элементов в окне (CSS order).
     * Список идёт в том порядке, в каком элементы видны на экране.
     */
    function renderList(e) {
        var box = h("div", "mc-list");
        var els = [];
        try { els = Array.prototype.slice.call(document.querySelectorAll(e.selector), 0, 60); } catch (err) {}
        var parents = [];
        var items = els.map(function (el) {
            var fl = flexItem(el), r = el.getBoundingClientRect();
            var pi = fl ? parents.indexOf(fl.parent) : -1;
            if (fl && pi === -1) { parents.push(fl.parent); pi = parents.length - 1; }
            return { el: el, fl: fl, group: pi, pos: fl && fl.axis === "y" ? r.top : r.left };
        }).sort(function (a, b) { return (a.group - b.group) || (a.pos - b.pos); });
        var seen = {}, dragged = null;
        items.forEach(function (it) {
            var el = it.el, sel = selectorFor(el);
            if (!sel || seen[sel]) return;
            seen[sel] = 1;
            var hidden = !!(DS.rules[sel] && DS.rules[sel].props.hide);
            var row = h("div", "mc-map mc-sub" + (hidden ? " hidden-el" : ""));
            var movable = !hidden && it.fl && canOrder(it.fl);
            if (movable) {
                var grip = h("span", "mc-drag", "::");
                grip.title = "Перетащи строку, чтобы поменять порядок в окне";
                row.appendChild(grip);
                row.draggable = true;
                row.addEventListener("dragstart", function (ev) { dragged = it; try { ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", sel); } catch (x) {} });
                row.addEventListener("dragend", function () { dragged = null; });
                row.addEventListener("dragover", function (ev) {
                    if (!dragged || dragged === it || !dragged.fl || dragged.fl.parent !== it.fl.parent) return;
                    ev.preventDefault();
                    var rr = row.getBoundingClientRect(), after = ev.clientY > rr.top + rr.height / 2;
                    row.classList.toggle("drop-before", !after); row.classList.toggle("drop-after", after);
                });
                row.addEventListener("dragleave", function () { row.classList.remove("drop-before"); row.classList.remove("drop-after"); });
                row.addEventListener("drop", function (ev) {
                    row.classList.remove("drop-before"); row.classList.remove("drop-after");
                    if (!dragged || dragged === it || !dragged.fl || dragged.fl.parent !== it.fl.parent) return;
                    ev.preventDefault();
                    var rr = row.getBoundingClientRect(), after = ev.clientY > rr.top + rr.height / 2;
                    var list = visualOrder(it.fl).filter(function (c) { return c !== dragged.fl.item; });
                    var at = list.indexOf(it.fl.item);
                    if (at === -1) return;
                    list.splice(after ? at + 1 : at, 0, dragged.fl.item);
                    dragged = null;
                    if (applyOrder(it.fl, list)) setTimeout(function () { renderPanel(true); }, 60);
                });
            }
            var cb = h("input"); cb.type = "checkbox"; cb.checked = !hidden;
            var label = itemLabel(el);
            cb.addEventListener("change", function () { setProp(sel, "hide", cb.checked ? null : true, e.label + ": " + label, el); renderPanel(true); });
            row.appendChild(cb);
            row.appendChild(h("span", "mc-map-name", label));
            if (!hidden) row.appendChild(btn("Настроить", "mc-mini", function () { selectEl(el); }));
            hoverHighlight(row, sel, true);
            box.appendChild(row);
        });
        return box;
    }

    // ---- профили вида
    function renderProfiles() {
        var PR = PROFILES || { list: [], active: "", dirty: false };
        var n = changesCount();
        des.panel.appendChild(h("div", "mc-note mc-pad", "Профиль — снимок всех правок: элементы и настройки VS Code. Применение заменяет текущие правки. «Исходный вид» возвращает VS Code таким, каким он был до Moon Core."));
        var now = section("Сейчас");
        now.appendChild(h("div", null, PR.active ? "Профиль «" + PR.active + "»" + (PR.dirty ? " — изменён после применения" : "") : n ? "Свои правки без профиля (" + n + ")" : "Исходный вид VS Code"));
        if (PR.active && PR.dirty) now.appendChild(h("div", "mc-note", "Сохрани изменения, иначе при переключении профиля они пропадут."));

        var save = section("Сохранить текущий вид");
        var line = h("div", "mc-row");
        var inp = h("input"); inp.type = "text"; inp.placeholder = "Имя профиля"; inp.maxLength = 40;
        inp.value = PR.active && !isBuiltin(PR.active) ? PR.active : "";
        line.appendChild(inp);
        var doSave = function () {
            var name = inp.value.trim();
            if (!name) { toast("Введи имя профиля"); return; }
            if (isBuiltin(name)) { toast("«" + name + "» — встроенный профиль, выбери другое имя"); return; }
            profileOp({ op: "saveProfile", name: name, modules: collectModuleProfile() }, "Сохранено: «" + name + "»");
        };
        inp.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); doSave(); } });
        line.appendChild(btn("Сохранить", "pri", doSave));
        save.appendChild(line);
        if (!n) save.appendChild(h("div", "mc-note", "Правок пока нет — профиль будет равен исходному виду."));

        var listSec = section("Профили");
        listSec.appendChild(profileCard("", "Исходный вид VS Code", "Без правок Moon Core: всё как до установки", false, !PR.active && !n));
        PR.list.forEach(function (p) {
            var desc = p.note || ("элементов: " + p.rules + ", настроек: " + p.settings);
            // Профиль несёт и состояние модулей (например, фон MoonLight BG) — пусть это будет видно.
            var mods = Array.isArray(p.modules) ? p.modules.filter(function (id) { return MODS[id]; }).map(function (id) { return MODS[id].name; }) : [];
            if (mods.length) desc += " + " + mods.join(", ");
            listSec.appendChild(profileCard(p.name, p.name, desc, !p.builtin, PR.active === p.name, p.builtin));
        });
    }
    function isBuiltin(name) { return !!(PROFILES && PROFILES.list.some(function (p) { return p.builtin && p.name === name; })); }

    function profileCard(name, title, desc, deletable, active, builtin) {
        var card = h("div", "mc-prof" + (active ? " on" : ""));
        var head = h("div", "mc-prof-h");
        head.appendChild(h("span", "mc-cap", title));
        if (builtin) head.appendChild(h("small", null, "встроенный"));
        if (active) head.appendChild(h("small", "mc-now", "сейчас"));
        card.appendChild(head);
        card.appendChild(h("div", "mc-note", desc));
        var bs = h("div", "mc-btns");
        var key = "apply:" + name;
        var needConfirm = changesCount() > 0 && !(active && !(PROFILES && PROFILES.dirty));
        if (!(active && !(PROFILES && PROFILES.dirty))) bs.appendChild(btn(des.confirm === key ? "Заменить текущие правки?" : "Применить", "pri", function () {
            if (needConfirm && des.confirm !== key) { des.confirm = key; renderPanel(true); return; }
            des.confirm = "";
            profileOp(name ? { op: "applyProfile", name: name } : { op: "clearAll" }, name ? "Профиль «" + name + "»" : "Исходный вид VS Code");
        }));
        if (deletable && active && PROFILES && PROFILES.dirty) {
            bs.appendChild(btn("Обновить", "", function () { profileOp({ op: "saveProfile", name: name, modules: collectModuleProfile() }, "Профиль «" + name + "» обновлён"); }, "Записать текущие правки в этот профиль"));
        }
        if (deletable) {
            var dk = "del:" + name;
            bs.appendChild(btn(des.confirm === dk ? "Точно удалить?" : "Удалить", "danger", function () {
                if (des.confirm !== dk) { des.confirm = dk; renderPanel(true); return; }
                des.confirm = "";
                profileOp({ op: "deleteProfile", name: name }, "Профиль «" + name + "» удалён");
            }));
        }
        card.appendChild(bs);
        if (name) profileExtras(card, name, deletable);
        return card;
    }

    /** Операция с профилем: сразу на хост, по ответу — новое состояние (правила, настройки, список). */
    function profileOp(op, done) {
        flushOps();
        var seq = ++flushSeq;
        rpcFirst("design", { ops: [op] }, des && des.host).then(function (r) {
            if (!r || r.ok === false) { toast("Moon Core: " + ((r && r.error) || "расширение не ответило"), "warn"); }
            else if (done) toast(done);
            if (r && r.design && seq === flushSeq) {
                DS = toDS(r.design);
                if (r.settingsNow) SETNOW = r.settingsNow;
                if (r.profiles) PROFILES = r.profiles;
                if (r.history) HIST = r.history;
                localEditAt = 0;
                clearColorPreview();
                afterDS();
            }
            if (des) renderPanel(true);
        });
    }

    /** Сколько всего правок: правила, настройки, цвета темы, кнопки, эффекты. */
    function changesCount() {
        return Object.keys(DS.rules).length + Object.keys(DS.settings).length + Object.keys(DS.colors || {}).length +
            (DS.buttons || []).length + Object.keys(DS.fx || {}).length;
    }
    function renderChanges() {
        var sels = Object.keys(DS.rules).sort(function (a, b) { return (DS.rules[b].ts || 0) - (DS.rules[a].ts || 0); });
        var keys = Object.keys(DS.settings);
        if (!changesCount()) {
            des.panel.appendChild(h("div", "mc-empty", "Изменений пока нет. Выбери элемент во вкладке «Элемент»."));
            return;
        }
        changesSearch();
        var ckeys = Object.keys(DS.colors || {});
        if (ckeys.length) {
            var cc = h("div", "mc-card");
            cc.appendChild(h("div", "mc-cap", "Цвета темы"));
            ckeys.forEach(function (k) {
                var rec = DS.colors[k];
                var line = h("div", "mc-line");
                var sw = h("span", null, "");
                var dot = h("span"); Object.assign(dot.style, { display: "inline-block", width: "10px", height: "10px", borderRadius: "2px", marginRight: "6px", background: rec.value, verticalAlign: "-1px" });
                sw.appendChild(dot);
                sw.appendChild(document.createTextNode((k.indexOf("tk:") === 0 ? "код: " : "") + k.slice(3) + "  " + rec.value + "  (было: " + (rec.hadPrev ? rec.prev : "из темы") + ")"));
                line.appendChild(sw);
                line.appendChild(xBtn(true, function () { setColor(k, null, rec.label, k.indexOf("wb:") === 0 ? k.slice(3).replace(/\./g, "-") : ""); flushOps(); renderPanel(true); }));
                cc.appendChild(line);
            });
            des.panel.appendChild(cc);
        }
        if ((DS.buttons || []).length || Object.keys(DS.fx || {}).length) {
            var mc = h("div", "mc-card");
            mc.appendChild(h("div", "mc-cap", "Кнопки и эффекты"));
            mc.appendChild(h("div", "mc-note", "Своих кнопок: " + (DS.buttons || []).length + ", эффектов: " + Object.keys(DS.fx || {}).filter(function (k) { return DS.fx[k] === true; }).length));
            var mb = h("div", "mc-btns");
            mb.appendChild(btn("Открыть «Ещё»", "", function () { des.tab = "more"; renderPanel(true); }));
            mc.appendChild(mb);
            des.panel.appendChild(mc);
        }
        if (keys.length) {
            var card = h("div", "mc-card");
            card.appendChild(h("div", "mc-cap", "Настройки VS Code"));
            keys.forEach(function (k) {
                var rec = DS.settings[k];
                var line = h("div", "mc-line");
                line.appendChild(h("span", null, (rec.label || settingLabel(k)) + ": " + fmtVal(rec.value) + "  (было: " + fmtVal(rec.hadPrev ? rec.prev : undefined) + ")"));
                line.appendChild(xBtn(true, function () { undoSetting(k); flushOps(); renderPanel(true); }));
                var ksel = settingSelector(k);
                if (ksel) hoverHighlight(line, ksel, false);
                card.appendChild(line);
            });
            des.panel.appendChild(card);
        }
        sels.forEach(function (sel) {
            var r = DS.rules[sel];
            var card = h("div", "mc-card" + (r.off ? " off" : ""));
            var st = splitState(sel).state;
            card.appendChild(h("div", "mc-cap", (r.label || "элемент") + (condText(sel) ? " — " + condText(sel) : "") + (st ? " — :" + st : "") + (r.off ? " (выключено)" : "")));
            card.appendChild(h("code", null, sel));
            // Навёл — элементы правки обведены (скрытые на это время показаны).
            hoverHighlight(card, sel, true);
            card.title = "Наведи — элементы этой правки подсвечены в окне";
            Object.keys(r.props).forEach(function (k) {
                if (!PROPS[k]) return;
                var line = h("div", "mc-line");
                var v = r.props[k];
                line.appendChild(h("span", null, PROPS[k].label + (PROPS[k].type === "flag" ? "" : ": " + cssVal(k, v))));
                line.appendChild(xBtn(true, function () { setProp(sel, k, null, r.label); renderPanel(true); }));
                card.appendChild(line);
            });
            var bs = h("div", "mc-btns");
            var target = null;
            try { target = document.querySelector(sel); } catch (e) {}
            if (target && !(r.props.hide)) bs.appendChild(btn("Выбрать", "", function () { selectEl(target); }));
            else if (!target) bs.appendChild(h("span", "mc-note", "сейчас не на экране"));
            bs.appendChild(btn(r.off ? "Включить" : "Выключить", "", function () { setRuleOff(sel, !r.off); renderPanel(true); }, "Правка остаётся в списке, но не применяется"));
            bs.appendChild(btn("Сбросить", "danger", function () { resetRule(sel); renderPanel(true); }));
            card.appendChild(bs);
            des.panel.appendChild(card);
        });
        var foot = h("div", "mc-btns"); foot.style.margin = "12px 12px 0";
        foot.appendChild(btn(des.confirmClear ? "Точно сбросить всё?" : "Сбросить всё", "danger", function () {
            if (!des.confirmClear) { des.confirmClear = true; renderPanel(true); return; }
            des.confirmClear = false;
            DS = toDS(null);
            queueOp("clearAll", { op: "clearAll" });
            flushOps();
            renderDesignCss();
            renderPanel(true);
        }));
        des.panel.appendChild(foot);
    }

    // ---------------------------------------------------------------------------
    //  Прямая правка мышкой на самом элементе.
    //    - ручки рамки: правый край, низ, угол — ширина/высота; кружок сверху справа — масштаб;
    //      квадрат снизу слева — внутренний отступ. Двойной клик по ручке — вернуть как было;
    //    - «::» сверху слева — перетащить элемент среди соседей (CSS order у flex-контейнера);
    //    - «Как было» в нижней полосе: пока нажата — окно без правок CSS (до / после);
    //    - подсветка: наведение на правку во вкладке «Правки» обводит её элементы.
    // ---------------------------------------------------------------------------
    var HANDLE_TITLES = {
        e: "Ширина: тяни вправо / влево. Двойной клик — как было",
        s: "Высота: тяни вниз / вверх. Двойной клик — как было",
        se: "Ширина и высота. Двойной клик — как было",
        zoom: "Масштаб: тяни вправо-вверх (крупнее) или влево-вниз. Двойной клик — как было",
        pad: "Внутренний отступ: тяни вниз (больше) или вверх. Двойной клик — как было",
        grip: "Перетащи, чтобы поставить элемент в другое место среди соседей",
    };
    var HANDLE_PROPS = { e: ["width"], s: ["height"], se: ["width", "height"], zoom: ["zoom"], pad: ["padding"] };

    function makeHandles() {
        des.handles = {};
        var accent = "var(--vscode-focusBorder, #89b4fa)";
        var base = {
            position: "fixed", zIndex: String(Z + 1), boxSizing: "border-box", display: "none",
            background: "var(--vscode-editorWidget-background, #1e1e2e)", border: "2px solid " + accent,
        };
        var cursors = { e: "ew-resize", s: "ns-resize", se: "nwse-resize", zoom: "nesw-resize", pad: "ns-resize", grip: "grab" };
        Object.keys(HANDLE_TITLES).forEach(function (k) {
            var d = document.createElement("div");
            d.setAttribute("data-mooncore-ui", "handle");
            d.setAttribute("data-handle", k);
            d.title = HANDLE_TITLES[k];
            Object.assign(d.style, base, { cursor: cursors[k], borderRadius: k === "zoom" ? "50%" : "3px" });
            if (k === "grip") {
                d.textContent = "::";
                Object.assign(d.style, { font: "bold 11px/12px var(--vscode-font-family, sans-serif)", color: accent, textAlign: "center", letterSpacing: "-1px" });
            }
            d.addEventListener("mousedown", function (e) { if (e.button === 0) startHandleDrag(k, e); });
            d.addEventListener("dblclick", function (e) { e.preventDefault(); e.stopPropagation(); resetHandle(k); });
            document.body.appendChild(d);
            des.handles[k] = d;
        });
        des.marker = uiBox({ background: accent, display: "none", borderRadius: "2px" });
    }

    function drawHandles(r) {
        if (!des || !des.handles) return;
        var H = des.handles;
        var show = !!(r && des.sel && !des.compare);
        var fl = show ? flexItem(des.selEl) : null;
        var place = function (k, x, y, w, hgt, on) {
            if (!on) { H[k].style.display = "none"; return; }
            Object.assign(H[k].style, { display: "block", left: Math.round(x) + "px", top: Math.round(y) + "px", width: w + "px", height: hgt + "px" });
        };
        place("e", r ? r.right - 4 : 0, r ? r.top + r.height / 2 - 9 : 0, 8, 18, show && r.height >= 14);
        place("s", r ? r.left + r.width / 2 - 9 : 0, r ? r.bottom - 4 : 0, 18, 8, show && r.width >= 14);
        place("se", r ? r.right - 5 : 0, r ? r.bottom - 5 : 0, 10, 10, show);
        place("zoom", r ? r.right + 3 : 0, r ? r.top - 13 : 0, 10, 10, show);
        place("pad", r ? r.left - 13 : 0, r ? r.bottom + 3 : 0, 10, 10, show);
        place("grip", r ? r.left - 2 : 0, r ? r.top - 16 : 0, 18, 14, show && (isFloating(des.sel) || (!!fl && canOrder(fl))));
        if (H.grip) H.grip.title = isFloating(des.sel) ? "Перетащи плавающее окно" : HANDLE_TITLES.grip;
    }

    function numStart(sel, prop, fallback) {
        var r = DS.rules[sel];
        var v = r && r.props[prop];
        return typeof v === "number" ? v : fallback;
    }
    function setClamped(sel, prop, v, label) {
        var p = PROPS[prop];
        if (!p || !isFinite(v)) return null;
        v = Math.min(p.max, Math.max(p.min, Math.round(v / p.step) * p.step));
        v = Math.round(v * 100) / 100;
        setProp(sel, prop, v, label);
        return v;
    }
    function selLabel() {
        return des.entry && des.anchor === des.selEl ? des.entry.label : des.selEl ? labelFor(des.selEl) : des.sel;
    }
    function dragTip(text, x, y) {
        des.tip.textContent = text;
        Object.assign(des.tip.style, { display: "block", left: Math.min(window.innerWidth - 180, x + 14) + "px", top: Math.max(4, y - 28) + "px" });
    }

    function startHandleDrag(kind, e) {
        e.preventDefault(); e.stopPropagation();
        if (!des || !des.selEl || !des.sel) return;
        if (isFloating(des.sel) && kind !== "zoom" && kind !== "pad") { startFloatDrag(kind, e); return; }
        if (kind === "grip") { startReorder(e); return; }
        var el = des.selEl, sel = des.sel, label = selLabel();
        var cs = null;
        try { cs = getComputedStyle(el); } catch (err) {}
        var rect = el.getBoundingClientRect();
        var zoom = numStart(sel, "zoom", 100), zf = zoom / 100 || 1;
        var px = function (v, fb) { var n = parseFloat(v); return isFinite(n) && n > 0 ? n : fb; };
        var start = {
            w: numStart(sel, "width", px(cs && cs.width, rect.width / zf)),
            h: numStart(sel, "height", px(cs && cs.height, rect.height / zf)),
            pad: numStart(sel, "padding", px(cs && cs.paddingTop, 0)),
            zoom: zoom,
        };
        var x0 = e.clientX, y0 = e.clientY;
        des.dragging = kind;
        des.hoverEl = null;
        var move = function (ev) {
            ev.preventDefault();
            var dx = ev.clientX - x0, dy = ev.clientY - y0, parts = [];
            if (kind === "e" || kind === "se") parts.push("ширина " + setClamped(sel, "width", start.w + dx / zf, label) + " px");
            if (kind === "s" || kind === "se") parts.push("высота " + setClamped(sel, "height", start.h + dy / zf, label) + " px");
            if (kind === "pad") parts.push("отступ " + setClamped(sel, "padding", start.pad + dy / 2, label) + " px");
            if (kind === "zoom") parts.push("масштаб " + setClamped(sel, "zoom", start.zoom + (dx - dy) / 2, label) + " %");
            drawDesign();
            dragTip(parts.join(", "), ev.clientX, ev.clientY);
        };
        var up = function () {
            window.removeEventListener("mousemove", move, true);
            window.removeEventListener("mouseup", up, true);
            if (!des) return;
            des.dragging = null;
            des.suppressClick = true;
            setTimeout(function () { if (des) des.suppressClick = false; }, 300);
            des.tip.style.display = "none";
            flushOps();
            renderPanel(true);
        };
        window.addEventListener("mousemove", move, true);
        window.addEventListener("mouseup", up, true);
    }

    function resetHandle(kind) {
        if (!des || !des.sel) return;
        if (kind === "grip") { resetOrder(); return; }
        (HANDLE_PROPS[kind] || []).forEach(function (p) { setProp(des.sel, p, null, selLabel()); });
        flushOps();
        renderPanel(true);
        drawDesign();
    }

    // ---- плавающее окно: элемент откреплён от раскладки (position: fixed) и лежит где поставили
    function isFloating(sel) { return !!(sel && DS.rules[sel] && DS.rules[sel].props.float); }
    function relayout() { clearTimeout(relayout.t); relayout.t = setTimeout(function () { try { window.dispatchEvent(new Event("resize")); } catch (e) {} }, 60); }
    function floatOn() {
        if (!des || !des.selEl || !des.sel) return;
        var r = des.selEl.getBoundingClientRect(), label = selLabel();
        setProp(des.sel, "float", true, label);
        setClamped(des.sel, "floatX", Math.max(0, r.left + 24), label);
        setClamped(des.sel, "floatY", Math.max(0, r.top + 24), label);
        setClamped(des.sel, "floatW", Math.max(160, r.width), label);
        setClamped(des.sel, "floatH", Math.max(90, Math.min(r.height, window.innerHeight - 80)), label);
        flushOps(); relayout(); renderPanel(true); setTimeout(drawDesign, 80);
    }
    function floatOff() {
        if (!des || !des.sel) return;
        ["float", "floatX", "floatY", "floatW", "floatH"].forEach(function (p) { setProp(des.sel, p, null, ""); });
        flushOps(); relayout(); renderPanel(true); setTimeout(drawDesign, 80);
    }
    function startFloatDrag(kind, e) {
        var sel = des.sel, label = selLabel(), p = DS.rules[sel].props;
        var s = { x: p.floatX || 0, y: p.floatY || 0, w: p.floatW || 300, h: p.floatH || 200 };
        var x0 = e.clientX, y0 = e.clientY;
        des.dragging = kind;
        var move = function (ev) {
            ev.preventDefault();
            var dx = ev.clientX - x0, dy = ev.clientY - y0;
            if (kind === "grip") {
                setClamped(sel, "floatX", Math.min(window.innerWidth - 60, s.x + dx), label);
                setClamped(sel, "floatY", Math.min(window.innerHeight - 30, s.y + dy), label);
            }
            if (kind === "e" || kind === "se") setClamped(sel, "floatW", s.w + dx, label);
            if (kind === "s" || kind === "se") setClamped(sel, "floatH", s.h + dy, label);
            drawDesign();
            var q = DS.rules[sel].props;
            dragTip(kind === "grip" ? q.floatX + ", " + q.floatY : q.floatW + " × " + q.floatH, ev.clientX, ev.clientY);
        };
        var up = function () {
            window.removeEventListener("mousemove", move, true);
            window.removeEventListener("mouseup", up, true);
            if (!des) return;
            des.dragging = null; des.suppressClick = true;
            setTimeout(function () { if (des) des.suppressClick = false; }, 300);
            des.tip.style.display = "none";
            flushOps(); relayout(); renderPanel(true);
        };
        window.addEventListener("mousemove", move, true);
        window.addEventListener("mouseup", up, true);
    }
    /** Секция «Плавающее окно» во вкладке «Элемент». */
    function floatSection() {
        if (!des.selEl) return;
        var on = isFloating(des.sel);
        var sec = section("Плавающее окно", on ? "Тяни за «::» — двигать, за край и угол — размер." :
            "Открепить элемент от раскладки и положить поверх окна. Для кнопок, виджетов, хлебных крошек, центра команд — отлично; крупные панели VS Code раскладывает сам, их содержимое может не подстроиться.");
        var bs = h("div", "mc-btns");
        bs.appendChild(on ? btn("Вернуть на место", "danger", floatOff) : btn("Открепить", "", floatOn));
        sec.appendChild(bs);
    }

    // ---- порядок среди соседей (flex)
    /** Ближайший к el элемент (сам el или предок до 3 уровней), который лежит во flex-ряду с соседями. */
    function flexItem(el) {
        for (var n = el, k = 0; n && k < 4; n = n.parentElement, k++) {
            var p = n.parentElement;
            if (!p || p === document.body || p === document.documentElement) return null;
            var cs = null;
            try { cs = getComputedStyle(p); } catch (e) { return null; }
            if (!/flex/.test(cs.display || "")) continue;
            if (visibleKids(p).length < 2) continue;
            return { item: n, parent: p, axis: /column/.test(cs.flexDirection || "") ? "y" : "x", reverse: /reverse/.test(cs.flexDirection || "") };
        }
        return null;
    }
    function visibleKids(p) {
        return Array.prototype.filter.call(p.children || [], function (c) {
            if (c.nodeType !== 1 || isOurUi(c)) return false;
            var r = c.getBoundingClientRect();
            return r.width > 0 || r.height > 0;
        });
    }
    /** Соседи в том порядке, в каком их видно на экране. */
    function visualOrder(fl) {
        return visibleKids(fl.parent).map(function (c) { return { el: c, r: c.getBoundingClientRect() }; })
            .sort(function (a, b) { return fl.axis === "y" ? a.r.top - b.r.top : a.r.left - b.r.left; })
            .map(function (x) { return x.el; });
    }
    /** Однозначный селектор для соседа (основной или запасной). */
    function uniqueSel(el) {
        var s = selectorFor(el);
        if (s && count(s) === 1 && hits(s, el)) return s;
        var c = selectorCandidates(el, 3);
        for (var i = 0; i < c.length; i++) if (count(c[i]) === 1) return c[i];
        return "";
    }
    function canOrder(fl) {
        if (fl.checked === undefined) fl.checked = visualOrder(fl).slice(0, 40).every(function (c) { return !!uniqueSel(c); });
        return fl.checked;
    }

    /** Поставить соседей в порядок list (как их должно быть видно). Каждому — правило order. */
    function applyOrder(fl, list) {
        var sels = list.map(uniqueSel);
        if (sels.some(function (s) { return !s; })) { toast("Moon Core: не у всех соседей есть однозначный селектор — порядок не меняю"); return false; }
        var n = list.length;
        list.forEach(function (el, i) {
            var ord = fl.reverse ? n - 1 - i : i;
            setProp(sels[i], "order", ord, "Порядок: " + itemLabel(el), el);
        });
        flushOps();
        return true;
    }
    function resetOrder() {
        var fl = des && des.selEl ? flexItem(des.selEl) : null;
        if (!fl) return;
        visibleKids(fl.parent).forEach(function (el) {
            var s = uniqueSel(el);
            if (s && DS.rules[s] && DS.rules[s].props.order !== undefined) setProp(s, "order", null, "");
        });
        flushOps();
        renderPanel(true);
        drawDesign();
    }
    /** Сдвинуть выбранный элемент на step позиций (кнопки «Раньше» / «Позже»). */
    function moveBy(step) {
        var fl = des && des.selEl ? flexItem(des.selEl) : null;
        if (!fl) return;
        var list = visualOrder(fl), i = list.indexOf(fl.item);
        var j = Math.max(0, Math.min(list.length - 1, i + step));
        if (i === -1 || i === j) return;
        list.splice(i, 1); list.splice(j, 0, fl.item);
        applyOrder(fl, list);
        renderPanel(true);
        setTimeout(drawDesign, 30);
    }

    function startReorder(e) {
        var fl = flexItem(des.selEl);
        if (!fl || !canOrder(fl)) return;
        var list = visualOrder(fl), others = list.filter(function (c) { return c !== fl.item; });
        var target = list.indexOf(fl.item);
        des.dragging = "grip";
        var move = function (ev) {
            ev.preventDefault();
            var pos = fl.axis === "y" ? ev.clientY : ev.clientX;
            target = others.filter(function (c) {
                var r = c.getBoundingClientRect();
                return (fl.axis === "y" ? r.top + r.height / 2 : r.left + r.width / 2) < pos;
            }).length;
            var pr = fl.parent.getBoundingClientRect();
            var ref = others[target] ? others[target].getBoundingClientRect() : null;
            var last = others[others.length - 1] ? others[others.length - 1].getBoundingClientRect() : pr;
            var at = ref ? (fl.axis === "y" ? ref.top : ref.left) : (fl.axis === "y" ? last.bottom : last.right);
            Object.assign(des.marker.style, fl.axis === "y"
                ? { display: "block", left: pr.left + "px", top: (at - 2) + "px", width: pr.width + "px", height: "3px" }
                : { display: "block", left: (at - 2) + "px", top: pr.top + "px", width: "3px", height: pr.height + "px" });
            dragTip("место " + (target + 1) + " из " + list.length, ev.clientX, ev.clientY);
        };
        var up = function () {
            window.removeEventListener("mousemove", move, true);
            window.removeEventListener("mouseup", up, true);
            if (!des) return;
            des.dragging = null;
            des.suppressClick = true;
            setTimeout(function () { if (des) des.suppressClick = false; }, 300);
            des.marker.style.display = "none";
            des.tip.style.display = "none";
            var next = others.slice();
            next.splice(target, 0, fl.item);
            if (next.some(function (c, i) { return c !== list[i]; })) applyOrder(fl, next);
            renderPanel(true);
            setTimeout(drawDesign, 30);
        };
        window.addEventListener("mousemove", move, true);
        window.addEventListener("mouseup", up, true);
    }

    /** Секция «Порядок» во вкладке «Элемент» — если элемент стоит в ряду с соседями. */
    function orderSection() {
        var fl = des.selEl ? flexItem(des.selEl) : null;
        if (!fl || !canOrder(fl)) return;
        var list = visualOrder(fl), i = list.indexOf(fl.item);
        var sec = section("Порядок", "Место среди соседей: " + (i + 1) + " из " + list.length + ". Можно тянуть за «::» над рамкой.");
        var bs = h("div", "mc-btns");
        bs.appendChild(btn(fl.axis === "y" ? "Выше" : "Раньше", "", function () { moveBy(-1); }));
        bs.appendChild(btn(fl.axis === "y" ? "Ниже" : "Позже", "", function () { moveBy(1); }));
        var has = list.some(function (c) { var s = uniqueSel(c); return s && DS.rules[s] && DS.rules[s].props.order !== undefined; });
        if (has) bs.appendChild(btn("Как было", "danger", resetOrder, "Вернуть исходный порядок всех соседей"));
        sec.appendChild(bs);
    }

    // ---- до / после
    function compareButton() {
        var b = btnPlain("Как было", function () {});
        b.title = "Удерживай: окно без правок CSS (конструктор и CSS-сниппеты). Настройки VS Code при этом не переключаются.";
        b.addEventListener("mousedown", function (e) { e.preventDefault(); setCompare(true); });
        ["mouseup", "mouseleave", "blur"].forEach(function (ev) { b.addEventListener(ev, function () { setCompare(false); }); });
        return b;
    }
    function setCompare(on) {
        if (!des || !!des.compare === !!on) return;
        des.compare = !!on;
        var media = on ? "not all" : "";
        Object.keys(styles).forEach(function (id) { styles[id].media = media; });
        if (designStyle) designStyle.media = media;
        try {
            Array.prototype.forEach.call(document.querySelectorAll("style[data-mooncore-js]"), function (s) { s.media = media; });
        } catch (e) {}
        if (des.panel) des.panel.style.opacity = on ? "0.12" : "";
        drawDesign();
    }

    // ---- подсветка элементов правки
    /** Обвести все элементы по селектору; peek — на время показать скрытые этим правилом. */
    function highlight(sel, peek) {
        clearHighlight();
        if (!des || !sel) return;
        if (peek && DS.rules[sel] && DS.rules[sel].props.hide) { des.peek = sel; renderDesignCss(); }
        var els = [];
        try { els = Array.prototype.slice.call(document.querySelectorAll(sel), 0, 40); } catch (e) {}
        des.hl = els.map(function (el) {
            var accent = "var(--vscode-focusBorder, #89b4fa)";
            var b = uiBox({ border: "2px dashed " + accent, background: "color-mix(in srgb, " + accent + " 18%, transparent)", borderRadius: "3px", display: "none" });
            b._el = el;
            return b;
        });
        drawHighlight();
    }
    function drawHighlight() {
        (des && des.hl || []).forEach(function (b) { placeBox(b, b._el); });
    }
    function clearHighlight() {
        if (!des) return;
        (des.hl || []).forEach(function (b) { try { b.remove(); } catch (e) {} });
        des.hl = [];
        if (des.peek) { des.peek = null; renderDesignCss(); }
    }
    /** Подсветка по наведению на строку панели. */
    function hoverHighlight(node, sel, peek) {
        node.addEventListener("mouseenter", function () { highlight(sel, peek); });
        node.addEventListener("mouseleave", clearHighlight);
    }

    // ---- секция «Когда применять» (условия правил — ядро: runtime/src/77-context.js)
    /** Секция «Когда применять» во вкладке «Элемент». */
    function condSection() {
        var cur = splitCond(des.sel), now = ctxNow();
        var opts = [["", "", "Всегда"]];
        ["lang", "branch", "folder", "theme"].forEach(function (k) {
            var v = cur.kind === k ? cur.value : now[k];
            if (v) opts.push([k, v, "Только " + COND_TITLES[k] + " «" + v + "»"]);
        });
        if (opts.length === 1) return;
        var sec = section("Когда применять", "Правки ниже сработают только в этом случае: например, миникарта спрятана лишь в markdown.");
        var s = h("select");
        opts.forEach(function (o) { var op = h("option", null, o[2]); op.value = o[0] + "|" + o[1]; s.appendChild(op); });
        s.value = cur.kind + "|" + (cur.kind ? cur.value : "");
        s.addEventListener("change", function () {
            var p = s.value.split("|"), kind = p[0], value = p.slice(1).join("|");
            des.sel = withCond(cur.base, kind, value);
            renderPanel(true);
        });
        var row = h("div", "mc-row"); row.appendChild(s);
        sec.appendChild(row);
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
    //  Цвета темы. Вместо CSS-правила — штатная настройка VS Code: выбранный элемент красится
    //  через workbench.colorCustomizations, код — через editor.tokenColorCustomizations. Такое
    //  переживает любые обновления и работает во всех окнах.
    //
    //  Какой цвет темы красит элемент: сначала точно — по правилам CSS VS Code, которые подходят
    //  к элементу и берут var(--vscode-...); если VS Code красит элемент прямо в style="", — по
    //  значению: переменные темы с тем же цветом, ближайшие к зоне элемента.
    // ---------------------------------------------------------------------------
    var COLOR_PROPS = [["background-color", "bg"], ["background", "bg"], ["color", "fg"], ["border-color", "border"], ["border-top-color", "border"],
        ["border-bottom-color", "border"], ["border-left-color", "border"], ["border-right-color", "border"], ["outline-color", "border"]];
    var KIND_TITLES = { bg: "Фон", fg: "Текст", border: "Рамка" };
    var themeRules = null, themeRulesAt = 0;
    var colorPreview = {};                            // token -> значение, показанное до ответа хоста

    function scanThemeRules() {
        if (themeRules && Date.now() - themeRulesAt < 60000) return themeRules;
        var out = [];
        var walk = function (rules) {
            for (var i = 0; rules && i < rules.length; i++) {
                var r = rules[i];
                if (r.cssRules && !r.selectorText) { walk(r.cssRules); continue; }
                if (!r.selectorText || !r.style) continue;
                var props = [];
                for (var j = 0; j < COLOR_PROPS.length; j++) {
                    var v = r.style.getPropertyValue(COLOR_PROPS[j][0]);
                    var m = v && /var\(--vscode-([\w-]+)/.exec(v);
                    if (m) props.push({ kind: COLOR_PROPS[j][1], token: m[1] });
                }
                if (props.length) out.push({ sel: r.selectorText, props: props });
            }
        };
        Array.prototype.forEach.call(document.styleSheets || [], function (sh) {
            if (sh.ownerNode && sh.ownerNode.getAttribute && (sh.ownerNode.getAttribute("data-mooncore") || sh.ownerNode.getAttribute("data-mooncore-ui"))) return;
            try { walk(sh.cssRules); } catch (e) {}
        });
        themeRules = out; themeRulesAt = Date.now();
        return out;
    }

    /** statusBar-background -> statusBar.background (VS Code меняет точки на дефисы только в имени переменной). */
    function tokenToId(t) { var i = t.indexOf("-"); return i === -1 ? t : t.slice(0, i) + "." + t.slice(i + 1); }

    var ZONE_HINT = { statusbar: "statusBar", activitybar: "activityBar", sidebar: "sideBar", titlebar: "titleBar", panel: "panel", editor: "editor" };

    /** Цвета темы, которые красят el: [{ kind, token, exact }]. */
    function colorTokensFor(el) {
        var out = [], seen = {};
        var push = function (kind, token, exact) {
            var k = kind + "|" + token;
            if (seen[k] || out.length >= 8) return;
            seen[k] = 1; out.push({ kind: kind, token: token, exact: exact });
        };
        var vars = themeVars();
        var rules = scanThemeRules();
        var byKind = {};
        [el, el.parentElement].forEach(function (node, depth) {
            if (!node || node.nodeType !== 1) return;
            rules.forEach(function (r) {
                var ok = false;
                try { ok = node.matches(r.sel); } catch (e) {}
                if (!ok) return;
                r.props.forEach(function (p) {
                    if (depth && p.kind !== "fg") return;           // от родителя наследуется только цвет текста
                    if (rgba(vars[p.token]) || vars[p.token] === undefined) byKind[p.kind + "|" + p.token] = p;
                });
            });
        });
        Object.keys(byKind).forEach(function (k) { push(byKind[k].kind, byKind[k].token, true); });
        // По значению — для цветов, которые VS Code ставит прямо в style="".
        var c = catalogFor(el), hint = c ? ZONE_HINT[c.entry.zone] || "" : "";
        var cs = null;
        try { cs = getComputedStyle(el); } catch (e) {}
        if (cs) [["bg", cs.backgroundColor], ["fg", cs.color]].forEach(function (p) {
            if (out.some(function (x) { return x.kind === p[0]; })) return;
            var v = rgba(p[1]);
            if (!v || v[3] === 0) return;
            var names = Object.keys(vars).filter(function (n) { return sameColor(vars[n], p[1]); });
            names.sort(function (a, b) {
                var sa = (hint && a.indexOf(hint) === 0 ? 0 : 1) + (/(background|foreground)$/i.test(a) ? 0 : 0.5);
                var sb = (hint && b.indexOf(hint) === 0 ? 0 : 1) + (/(background|foreground)$/i.test(b) ? 0 : 0.5);
                return sa - sb || a.length - b.length;
            });
            names.slice(0, 2).forEach(function (n) { push(p[0], n, false); });
        });
        return out;
    }

    function colorValueNow(key, token) {
        var rec = DS.colors && DS.colors[key];
        if (rec) return rec.value;
        var id = key.slice(3), conf = key.indexOf("tk:") === 0 ? SETNOW["editor.tokenColorCustomizations"] : SETNOW["workbench.colorCustomizations"];
        if (conf && typeof conf[id] === "string") return hex6(conf[id]);
        if (token) return hex6(themeVars()[token]);
        return "#808080";
    }

    function setColor(key, value, label, token) {
        if (!DS.colors) DS.colors = {};
        if (value === null) delete DS.colors[key];
        else DS.colors[key] = Object.assign({}, DS.colors[key] || {}, { value: value, label: label || "" });
        // Сразу видно: переменная темы на время, пока VS Code не применит настройку сам.
        if (token) {
            var wb = document.querySelector(".monaco-workbench");
            if (wb) { if (value === null) wb.style.removeProperty("--vscode-" + token); else wb.style.setProperty("--vscode-" + token, value); }
            colorPreview[token] = value;
        }
        queueOp("color|" + key, { op: "color", key: key, value: value, label: label || "" });
    }
    /** Хост ответил и VS Code перекрасил тему — предпросмотр больше не нужен. */
    function clearColorPreview() {
        var wb = document.querySelector(".monaco-workbench");
        Object.keys(colorPreview).forEach(function (t) { if (wb) wb.style.removeProperty("--vscode-" + t); });
        colorPreview = {};
    }

    function colorRow(key, title, token, label) {
        var rec = DS.colors && DS.colors[key];
        var row = h("div", "mc-row" + (rec ? " set" : ""));
        var lab = h("label", null, title);
        lab.title = key.slice(3);
        row.appendChild(lab);
        var ctl = h("div", "mc-ctl");
        var col = h("input"); col.type = "color"; col.value = colorValueNow(key, token);
        col.addEventListener("input", function () { setColor(key, col.value, label, token); row.className = "mc-row set"; });
        ctl.appendChild(col);
        ctl.appendChild(h("span", "mc-note", key.slice(3)));
        row.appendChild(ctl);
        colorExtras(col, ctl, row);
        row.appendChild(xBtn(!!rec, function () { setColor(key, null, label, token); flushOps(); renderPanel(true); }, "Вернуть цвет темы"));
        return row;
    }

    /** Секция «Цвета темы» во вкладке «Элемент». */
    function colorSection(label) {
        var el = des.selEl;
        if (des.entry && des.entry.id === "code") {
            var sc = section("Цвета кода", "Штатная настройка editor.tokenColorCustomizations — переживает обновления и смену темы-основы.");
            var names = { comments: "Комментарии", strings: "Строки", keywords: "Ключевые слова", numbers: "Числа", types: "Типы", functions: "Функции", variables: "Переменные" };
            (TOKEN_GROUPS.length ? TOKEN_GROUPS : Object.keys(names)).forEach(function (g) { sc.appendChild(colorRow("tk:" + g, names[g] || g, "", "Код: " + (names[g] || g))); });
        }
        if (!el || !el.isConnected) return;
        var list = [];
        try { list = colorTokensFor(el); } catch (e) { report("цвета темы", e); }
        if (!list.length) return;
        var sec = section("Цвета темы", "Надёжнее, чем «Фон» и «Цвет текста» ниже: пишется в настройку VS Code и меняет цвет везде, где тема его использует.");
        list.forEach(function (x) {
            var id = tokenToId(x.token);
            sec.appendChild(colorRow("wb:" + id, KIND_TITLES[x.kind] + (x.exact ? "" : " (похоже)"), x.token, label + ": " + id));
        });
    }

    // ---- свои кнопки во вкладке «Ещё»: карточки, добавление, правка (показ кнопок — ядро: runtime/src/79-buttons.js)
    var BTN_ZONE_TITLES = { "statusbar-left": "Статусбар слева", "statusbar-right": "Статусбар справа", titlebar: "Титлбар", editor: "Над редактором" };
    var ICONS = ["terminal", "play", "debug-alt", "save-all", "search", "files", "source-control", "settings-gear", "layout-sidebar-left", "layout-panel",
        "split-horizontal", "screen-full", "window", "refresh", "zap", "rocket", "star-full", "heart", "flame", "bell", "bookmark", "tools", "beaker",
        "symbol-color", "paintcan", "color-mode", "eye", "eye-closed", "globe", "cloud", "database", "server", "package", "extensions", "git-merge",
        "word-wrap", "map", "go-to-file", "new-file", "trash", "check", "circle-large-outline", "sparkle", "wand", "layout"];

    function newButtonId() { return "b" + Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 5); }
    function putButton(b) {
        DS.buttons = (DS.buttons || []).filter(function (x) { return x.id !== b.id; }).concat([b]);
        queueOp("btn|" + b.id, { op: "button", button: b });
        ensureButtons();
    }
    function removeButton(id) {
        DS.buttons = (DS.buttons || []).filter(function (x) { return x.id !== id; });
        queueOp("btn|" + id, { op: "removeButton", id: id });
        ensureButtons();
    }
    /** «Добавить кнопку»: команду выбирают в списке VS Code (там же она и разрешается). */
    function addButtonFlow() {
        toast("Выбери команду в списке VS Code сверху");
        rpcFirst("pickCommand", {}, des && des.host).then(function (r) {
            if (!r || !r.ok) { if (r && !r.cancelled) toast("Moon Core: " + (r.error || "не удалось")); return; }
            putButton({ id: newButtonId(), zone: "statusbar-right", command: r.command, icon: r.icon || "zap", label: r.icon ? "" : r.title, tooltip: r.title, order: (DS.buttons || []).length });
            flushOps();
            if (des) { des.tab = "more"; renderPanel(true); }
        });
    }

    function buttonCard(b, own) {
        var card = h("div", "mc-card");
        var head = h("div", "mc-line");
        var prev = h("span", null, "");
        if (b.icon) { var ic = h("span", "codicon codicon-" + b.icon); ic.style.marginRight = "6px"; prev.appendChild(ic); }
        prev.appendChild(document.createTextNode(b.label || b.tooltip || b.command));
        head.appendChild(prev);
        if (own) head.appendChild(xBtn(true, function () { removeButton(b.id); flushOps(); renderPanel(true); }, "Удалить кнопку"));
        card.appendChild(head);
        card.appendChild(h("code", null, b.command + (b.owner ? "  — от " + b.owner : "")));
        if (!own) return card;
        var upd = function (patch) { var nb = Object.assign({}, b, patch); putButton(nb); };
        var r1 = h("div", "mc-row");
        r1.appendChild(h("label", null, "Где"));
        var zs = h("select");
        Object.keys(BTN_ZONE_TITLES).forEach(function (z) { var o = h("option", null, BTN_ZONE_TITLES[z]); o.value = z; zs.appendChild(o); });
        zs.value = b.zone;
        zs.addEventListener("change", function () { upd({ zone: zs.value }); flushOps(); renderPanel(true); });
        r1.appendChild(zs);
        card.appendChild(r1);
        var r2 = h("div", "mc-row");
        r2.appendChild(h("label", null, "Значок"));
        var is = h("select");
        var o0 = h("option", null, "без значка"); o0.value = ""; is.appendChild(o0);
        ICONS.concat(b.icon && ICONS.indexOf(b.icon) === -1 ? [b.icon] : []).forEach(function (n) { var o = h("option", null, n); o.value = n; is.appendChild(o); });
        is.value = b.icon || "";
        is.addEventListener("change", function () { upd({ icon: is.value }); flushOps(); renderPanel(true); });
        r2.appendChild(is);
        card.appendChild(r2);
        card.appendChild(iconPicker(b.icon, function (n) { upd({ icon: n }); flushOps(); renderPanel(true); }));
        var r3 = h("div", "mc-row");
        r3.appendChild(h("label", null, "Подпись"));
        var lt = h("input"); lt.type = "text"; lt.maxLength = 40; lt.value = b.label || ""; lt.placeholder = b.icon ? "только значок" : "текст";
        lt.addEventListener("change", function () { upd({ label: lt.value.trim() }); flushOps(); });
        r3.appendChild(lt);
        card.appendChild(r3);
        var bs = h("div", "mc-btns");
        bs.appendChild(btn("Левее", "", function () { upd({ order: (b.order || 0) - 1 }); flushOps(); renderPanel(true); }));
        bs.appendChild(btn("Правее", "", function () { upd({ order: (b.order || 0) + 1 }); flushOps(); renderPanel(true); }));
        card.appendChild(bs);
        return card;
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
        return out.concat(uiLookCss(f)).join("\n");
    }
    /**
     * Вид интерфейса целиком: шрифт, скругление, плавные переходы, приглушение неактивных
     * редакторов. Код редактора и терминал не задеваются: у них свой шрифт в style="".
     */
    var UI_FONT_RE = /^[\w\s,'".-]{1,120}$/;
    function uiLookCss(f) {
        var out = [], W = ".monaco-workbench ";
        if (typeof f.uiFont === "string" && UI_FONT_RE.test(f.uiFont)) {
            out.push(".monaco-workbench, " + W + ".quick-input-widget, .monaco-menu, .context-view, " + W + ".monaco-hover { font-family: " + f.uiFont + " !important; }");
        }
        var r = +f.roundedUi;
        if (r >= 1 && r <= 12) {
            out.push(W + ".monaco-button, " + W + ".monaco-inputbox, " + W + ".monaco-select-box, " + W + ".suggest-widget, " + W + ".monaco-hover, " +
                W + ".quick-input-widget, .monaco-menu, " + W + ".notification-toast, " + W + ".find-widget, " + W + ".badge { border-radius: " + r + "px !important; }");
            out.push(W + ".part.editor .tabs-container .tab { border-radius: " + r + "px " + r + "px 0 0 !important; }");
            out.push(W + ".monaco-list-row { border-radius: " + Math.min(r, 6) + "px; }");
        }
        if (f.smoothUi) {
            out.push("@media (prefers-reduced-motion: no-preference) { " + W + ".tab, " + W + ".action-label, " + W + ".monaco-button, " + W + ".statusbar-item, " +
                W + ".activitybar .action-item, " + W + ".pane-header, " + W + ".monaco-inputbox { transition: background-color .16s ease, color .16s ease, border-color .16s ease, opacity .16s ease, box-shadow .16s ease; } }");
        }
        if (f.dimInactive) {
            out.push(W + ".part.editor .editor-group-container:not(.active) .editor-container { opacity: .55; transition: opacity .18s ease; }");
            out.push(W + ".part.editor .editor-group-container:not(.active):hover .editor-container { opacity: .9; }");
        }
        return out;
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

    // ---- вкладка «Ещё»: свои кнопки, эффекты, отдельные окна (эффекты рисует ядро: runtime/src/81-fx.js)
    function setFx(key, value) {
        if (!DS.fx) DS.fx = {};
        if (value === null || value === false) delete DS.fx[key]; else DS.fx[key] = value;
        queueOp("fx|" + key, { op: "fx", key: key, value: value === false ? null : value });
        applyFx();
    }

    // ---- вкладка «Ещё»: кнопки, эффекты, отдельные окна
    var FX_SETTINGS = ["editor.cursorSmoothCaretAnimation", "editor.cursorBlinking", "editor.cursorStyle", "editor.smoothScrolling", "editor.fontLigatures", "workbench.list.smoothScrolling"];

    function renderMore() {
        lookSection();
        allColorsSection();
        var sb = section("Свои кнопки", "Любая команда VS Code — кнопкой в статусбаре, титлбаре или над редактором. Команду выбираешь в списке VS Code.");
        var own = DS.buttons || [];
        if (!own.length) sb.appendChild(h("div", "mc-note", "Кнопок пока нет."));
        var bsTop = h("div", "mc-btns");
        bsTop.appendChild(btn("Добавить кнопку", "pri", addButtonFlow));
        sb.appendChild(bsTop);
        own.slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); }).forEach(function (b) { des.panel.appendChild(buttonCard(b, true)); });
        if ((UIB || []).length) {
            section("Кнопки расширений", "Их добавили другие расширения через Moon Core; убираются вместе с расширением.");
            UIB.forEach(function (b) { des.panel.appendChild(buttonCard(b, false)); });
        }

        var se = section("Эффекты редактора", "Рисуются поверх окна, клики проходят насквозь.");
        ["cursorTrail", "typingParticles", "lineGlow", "cursorGlow"].forEach(function (k) {
            var spec = FXSPEC[k] || { label: k };
            var row = h("div", "mc-row" + (fxConf()[k] ? " set" : ""));
            row.appendChild(h("label", null, spec.label));
            var cb = h("input"); cb.type = "checkbox"; cb.checked = !!fxConf()[k];
            cb.addEventListener("change", function () { setFx(k, cb.checked ? true : null); flushOps(); renderPanel(true); });
            var ctl = h("div", "mc-ctl"); ctl.appendChild(cb); row.appendChild(ctl);
            se.appendChild(row);
        });
        var rc = h("div", "mc-row");
        rc.appendChild(h("label", null, "Цвет"));
        var cc = h("div", "mc-ctl");
        var col = h("input"); col.type = "color"; col.value = fxColor();
        col.addEventListener("input", function () { setFx("color", col.value); });
        cc.appendChild(col); cc.appendChild(h("span", "mc-note", fxConf().color ? "" : "как курсор"));
        rc.appendChild(cc);
        rc.appendChild(xBtn(!!fxConf().color, function () { setFx("color", null); flushOps(); renderPanel(true); }));
        se.appendChild(rc);
        var ri = h("div", "mc-row");
        ri.appendChild(h("label", null, "Сила"));
        var ic = h("div", "mc-ctl");
        var rng = h("input"); rng.type = "range"; rng.min = 1; rng.max = 10; rng.step = 1; rng.value = fxConf().intensity || 5;
        rng.addEventListener("input", function () { setFx("intensity", +rng.value); });
        ic.appendChild(rng); ri.appendChild(ic);
        se.appendChild(ri);
        var code = null;
        for (var i = 0; i < CATALOG.length; i++) if (CATALOG[i].id === "code") code = CATALOG[i];
        (code && code.settings || []).filter(function (s) { return FX_SETTINGS.indexOf(s.key) !== -1; }).forEach(function (s) { se.appendChild(settingRow(s, "Редактор")); });

        var sw = section("Отдельные окна", "Настоящие окна VS Code: редактор в своём окне можно положить на второй монитор. Первый раз VS Code спросит разрешение на команду.");
        var bw = h("div", "mc-btns");
        [["Редактор — в отдельное окно", "workbench.action.moveEditorToNewWindow"], ["Копия редактора в окне", "workbench.action.copyEditorToNewWindow"],
            ["Группа — в отдельное окно", "workbench.action.moveEditorGroupToNewWindow"], ["Компактное окно", "workbench.action.toggleCompactAuxiliaryWindow"]].forEach(function (c) {
            bw.appendChild(btn(c[0], "", function () {
                rpcFirst("command", { id: c[1], args: [], from: "" }, des && des.host).then(function (r) { if (!r || r.ok === false) toast("Moon Core: " + ((r && r.error) || "не вышло")); });
            }));
        });
        sw.appendChild(bw);
        sw.appendChild(h("div", "mc-note", "Любой элемент можно и открепить прямо в этом окне: вкладка «Элемент», «Плавающее окно»."));
    }

    // ---- удобства конструктора: память панели, отмена и возврат, быстрые действия, перенос
    //      стиля между элементами, вид интерфейса целиком (акцент, шрифт, скругление)

    // Панель помнит, куда её поставили и какая вкладка была открыта (localStorage окна).
    var PANEL_KEY = "mooncore.designPanel", PANEL_TABS = ["map", "el", "changes", "profiles", "more"];
    function panelMemory() {
        try { var o = JSON.parse(localStorage.getItem(PANEL_KEY) || "null"); return o && typeof o === "object" ? o : {}; } catch (e) { return {}; }
    }
    function rememberPanel(patch) {
        try { localStorage.setItem(PANEL_KEY, JSON.stringify(Object.assign(panelMemory(), patch))); } catch (e) {}
    }
    function restorePanel() {
        var m = panelMemory();
        // «Элемент» без выбранного элемента пуст — с него не начинаем.
        if (PANEL_TABS.indexOf(m.tab) !== -1 && m.tab !== "el") des.tab = m.tab;
        if (typeof m.left === "number" && typeof m.top === "number" && m.left >= 0 && m.top >= 0 &&
            m.left < window.innerWidth - 120 && m.top < window.innerHeight - 80) {
            des.dragged = true;
            Object.assign(des.panel.style, { right: "auto", left: Math.round(m.left) + "px", top: Math.round(m.top) + "px" });
        }
    }
    /** Двойной клик по заголовку: панель возвращается на своё обычное место. */
    function resetPanelPlace() {
        if (!des || !des.panel) return;
        des.dragged = false;
        Object.assign(des.panel.style, { left: "auto", right: "12px", top: "44px" });
        rememberPanel({ left: null, top: null });
        placePanel();
    }

    // ---- отмена и возврат правок (историю ведёт хост: lib/history.js)
    function historyOp(dir) {
        profileOp({ op: dir === "redo" ? "redo" : "undo" }, dir === "redo" ? "Правка возвращена" : "Правка отменена");
    }
    function histButtons() {
        var box = h("span"); box.style.display = "inline-flex"; box.style.gap = "4px";
        des.undoBtn = btnPlain("Отменить", function () { historyOp("undo"); });
        des.redoBtn = btnPlain("Вернуть", function () { historyOp("redo"); });
        box.appendChild(des.undoBtn); box.appendChild(des.redoBtn);
        updateHist();
        return box;
    }
    function updateHist() {
        if (!des || !des.undoBtn) return;
        des.undoBtn.title = "Отменить последнюю правку (Ctrl+Z)" + (HIST.undo ? " — шагов: " + HIST.undo : "");
        des.redoBtn.title = "Вернуть отменённую правку (Ctrl+Y)" + (HIST.redo ? " — шагов: " + HIST.redo : "");
        des.redoBtn.style.opacity = HIST.redo ? "" : "0.55";
    }

    function curLabel() { return des.entry && des.anchor === des.selEl ? des.entry.label : des.selEl ? labelFor(des.selEl) : des.sel; }

    /** Клавиши конструктора, кроме Esc: отмена и возврат, родитель и обратно, Delete — скрыть. */
    function designHotkey(e) {
        var mod = e.ctrlKey || e.metaKey, code = String(e.code || ""), key = String(e.key || "");
        // По e.code: в русской раскладке клавиша Z даёт «я», а сочетание должно работать.
        if (mod && !e.shiftKey && code === "KeyZ") return function () { historyOp("undo"); };
        if (mod && (code === "KeyY" || (e.shiftKey && code === "KeyZ"))) return function () { historyOp("redo"); };
        if (mod) return null;
        if (key === "ArrowUp" && des.selEl) return selectParent;
        if (key === "ArrowDown" && des.stack.length) return selectChild;
        if (key === "Delete" && des.sel) return function () {
            setProp(des.sel, "hide", true, curLabel());
            renderPanel(true);
            toast("Скрыто. Вернуть — Ctrl+Z или вкладка «Правки»");
        };
        return null;
    }

    // ---- быстрые действия и перенос стиля
    function quickSection(sel, label) {
        var sec = section("Быстро");
        var props = function () { return (DS.rules[sel] && DS.rules[sel].props) || {}; };
        var bump = function (prop, delta, base) {
            var p = PROPS[prop]; if (!p) return;
            var cur = props()[prop]; if (cur === undefined) cur = base;
            setProp(sel, prop, Math.min(p.max, Math.max(p.min, Math.round((cur + delta) * 100) / 100)), label);
            renderPanel(true);
        };
        var bs = h("div", "mc-btns"); bs.style.marginTop = "0";
        bs.appendChild(btn(props().hide ? "Показать" : "Скрыть", "", function () { setProp(sel, "hide", props().hide ? null : true, label); renderPanel(true); }, "Клавиша Delete делает то же"));
        bs.appendChild(btn("Крупнее", "", function () { bump("zoom", 10, 100); }));
        bs.appendChild(btn("Мельче", "", function () { bump("zoom", -10, 100); }));
        bs.appendChild(btn("Прозрачнее", "", function () { bump("opacity", -0.15, 1); }));
        sec.appendChild(bs);
    }

    var styleClip = null;
    // Место и порядок — свойства конкретного элемента, с ними стиль не переносится.
    var CLIP_SKIP = { order: 1, float: 1, floatX: 1, floatY: 1, floatW: 1, floatH: 1, hide: 1 };
    function clipButtons(sel, label, box) {
        var props = DS.rules[sel] && DS.rules[sel].props;
        var keys = props ? Object.keys(props).filter(function (k) { return !CLIP_SKIP[k] && PROPS[k]; }) : [];
        if (keys.length) box.appendChild(btn("Скопировать стиль", "", function () {
            styleClip = {};
            keys.forEach(function (k) { styleClip[k] = props[k]; });
            toast("Стиль скопирован: выбери другой элемент и нажми «Вставить стиль»");
            renderPanel(true);
        }, "Запомнить правки этого элемента, чтобы перенести на другой"));
        if (styleClip) box.appendChild(btn("Вставить стиль (" + Object.keys(styleClip).length + ")", "", function () {
            Object.keys(styleClip).forEach(function (k) { if (PROPS[k]) setProp(sel, k, styleClip[k], label); });
            flushOps();
            renderPanel(true);
        }));
    }

    // ---- вид интерфейса целиком
    // Акцент — цвета темы, которыми VS Code красит фокус, кнопки, значки и активные вкладки.
    var ACCENT_KEYS = ["focusBorder", "button.background", "activityBarBadge.background", "activityBar.activeBorder", "panelTitle.activeBorder",
        "tab.activeBorderTop", "progressBar.background", "textLink.foreground", "badge.background", "statusBarItem.remoteBackground"];
    var ACCENT_FG = ["button.foreground", "activityBarBadge.foreground", "badge.foreground", "statusBarItem.remoteForeground"];
    var ACCENT_LABEL = "Акцент";
    function accentNow() { var r = DS.colors && DS.colors["wb:focusBorder"]; return r && r.label === ACCENT_LABEL ? r.value : ""; }
    function setAccent(value) {
        var c = value ? rgba(value) : null;
        // Текст на акцентном фоне — тёмный или светлый, по яркости фона.
        var fg = c ? ((0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) > 150 ? "#11111b" : "#ffffff") : null;
        ACCENT_KEYS.forEach(function (id) { setColor("wb:" + id, value, ACCENT_LABEL, id.replace(/\./g, "-")); });
        ACCENT_FG.forEach(function (id) { setColor("wb:" + id, fg, ACCENT_LABEL, id.replace(/\./g, "-")); });
    }

    function lookSection() {
        var f = fxConf();
        var sec = section("Вид интерфейса", "Весь интерфейс разом. Акцент пишется в цвета темы VS Code (переживает обновления), остальное — стилем Moon Core.");
        var row = function (title, isSet) { var r = h("div", "mc-row" + (isSet ? " set" : "")); r.appendChild(h("label", null, title)); var c = h("div", "mc-ctl"); r.appendChild(c); sec.appendChild(r); return { row: r, ctl: c }; };

        var acc = accentNow(), ra = row("Акцентный цвет", !!acc);
        var col = h("input"); col.type = "color"; col.value = acc || hex6(themeVars().focusBorder || "#89b4fa");
        col.addEventListener("input", function () { setAccent(col.value); ra.row.className = "mc-row set"; });
        col.addEventListener("change", function () { flushOps(); });
        ra.ctl.appendChild(col);
        ra.ctl.appendChild(h("span", "mc-note", acc || "как в теме"));
        colorExtras(col, ra.ctl, ra.row);
        ra.row.appendChild(xBtn(!!acc, function () { setAccent(null); flushOps(); renderPanel(true); }, "Вернуть цвета темы"));

        var rf = row("Шрифт интерфейса", !!f.uiFont);
        var t = h("input"); t.type = "text"; t.value = f.uiFont || ""; t.placeholder = "как в VS Code"; t.spellcheck = false;
        t.title = "Имена шрифтов через запятую, например: Inter, Segoe UI, sans-serif. Код и терминал не меняются.";
        t.addEventListener("change", function () {
            var v = t.value.trim();
            if (v && !/^[\w\s,'".-]{1,120}$/.test(v)) { toast("Шрифт: только буквы, цифры, пробелы, запятые и кавычки", "warn"); return; }
            setFx("uiFont", v || null); flushOps(); renderPanel(true);
        });
        rf.ctl.appendChild(t);
        rf.row.appendChild(xBtn(!!f.uiFont, function () { setFx("uiFont", null); flushOps(); renderPanel(true); }));

        var rr = row("Скругление", !!f.roundedUi);
        var rng = h("input"); rng.type = "range"; rng.min = 0; rng.max = 12; rng.step = 1; rng.value = f.roundedUi || 0;
        var note = h("span", "mc-note", f.roundedUi ? f.roundedUi + " px" : "как в теме");
        rng.addEventListener("input", function () { var v = +rng.value; setFx("roundedUi", v >= 1 ? v : null); note.textContent = v >= 1 ? v + " px" : "как в теме"; });
        rr.ctl.appendChild(rng); rr.ctl.appendChild(note);

        [["smoothUi", "Плавные переходы"], ["dimInactive", "Приглушать неактивные редакторы"]].forEach(function (x) {
            var r = row((FXSPEC[x[0]] && FXSPEC[x[0]].label) || x[1], !!f[x[0]]);
            var cb = h("input"); cb.type = "checkbox"; cb.checked = !!f[x[0]];
            cb.addEventListener("change", function () { setFx(x[0], cb.checked ? true : null); flushOps(); renderPanel(true); });
            r.ctl.appendChild(cb);
        });
    }

    // ---- поиск по карте: строки прячутся на месте, без перерисовки панели (поле не теряет фокус)
    function mapSearch(rows) {
        var inp = h("input", "mc-search"); inp.type = "text"; inp.placeholder = "Найти элемент или настройку…"; inp.spellcheck = false;
        inp.value = des.mapQuery || "";
        var apply = function () {
            var q = inp.value.trim().toLowerCase();
            des.mapQuery = inp.value;
            var shown = [];
            rows.forEach(function (r) {
                var ok = !q || r.text.indexOf(q) !== -1;
                r.node.style.display = ok ? "" : "none";
                if (r.extra) r.extra.style.display = ok ? "" : "none";
                if (ok && shown.indexOf(r.sec) === -1) shown.push(r.sec);
            });
            rows.forEach(function (r) { r.sec.style.display = shown.indexOf(r.sec) !== -1 ? "" : "none"; });
        };
        inp.addEventListener("input", apply);
        return { input: inp, apply: apply };
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

    // ---- инструменты конструктора: пипетка и палитра у полей цвета, правка «по состоянию»
    //      (под мышью, в фокусе), выключение правила без удаления, части профиля, переименование

    // Недавние цвета — в localStorage окна; рядом — основные цвета текущей темы.
    var RECENT_KEY = "mooncore.recentColors", RECENT_MAX = 8;
    var THEME_SWATCHES = ["focusBorder", "foreground", "editor-background", "sideBar-background", "button-background", "statusBar-background",
        "errorForeground", "editorWarning-foreground", "textLink-foreground", "terminal-ansiGreen", "terminal-ansiBlue", "terminal-ansiMagenta"];
    function recentColors() {
        try {
            var a = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
            return Array.isArray(a) ? a.filter(function (c) { return /^#[0-9a-f]{6}$/i.test(String(c)); }).slice(0, RECENT_MAX) : [];
        } catch (e) { return []; }
    }
    function rememberColor(c) {
        if (!/^#[0-9a-f]{6}$/i.test(String(c))) return;
        c = c.toLowerCase();
        try { localStorage.setItem(RECENT_KEY, JSON.stringify([c].concat(recentColors().filter(function (x) { return x.toLowerCase() !== c; })).slice(0, RECENT_MAX))); } catch (e) {}
    }
    function swatch(color, title, pick) {
        var b = h("button", "mc-sw"); b.type = "button"; b.title = title + " " + color;
        b.style.background = color;
        b.addEventListener("click", function (e) { e.preventDefault(); pick(color); });
        return b;
    }
    /**
     * Дополнения к полю цвета col: кнопка пипетки (взять цвет с экрана) и кнопка палитры (недавние
     * цвета и цвета темы). ctl — куда положить кнопки, row — строка, под которой раскрывается палитра.
     * Поле получает обычное событие input — дальше работает его собственный обработчик.
     */
    function colorExtras(col, ctl, row) {
        var set = function (c) { col.value = hex6(c); col.dispatchEvent(new Event("input", { bubbles: true })); col.dispatchEvent(new Event("change", { bubbles: true })); };
        col.addEventListener("change", function () { rememberColor(col.value); });
        if (typeof window.EyeDropper === "function") {
            var eye = h("button", "mc-x", "◉"); eye.type = "button"; eye.title = "Пипетка: взять цвет с любого места экрана";
            eye.addEventListener("click", function (e) {
                e.preventDefault();
                try { new window.EyeDropper().open().then(function (r) { if (r && r.sRGBHex) set(r.sRGBHex); }, function () {}); } catch (err) { toast("Пипетка цвета недоступна в этой версии VS Code", "warn"); }
            });
            ctl.appendChild(eye);
        }
        var pal = h("button", "mc-x", "▾"); pal.type = "button"; pal.title = "Недавние цвета и цвета темы";
        var strip = null;
        pal.addEventListener("click", function (e) {
            e.preventDefault();
            if (strip) { strip.remove(); strip = null; return; }
            strip = h("div", "mc-swatches");
            var vars = themeVars(), seen = {};
            recentColors().forEach(function (c) { seen[c] = 1; strip.appendChild(swatch(c, "недавний", set)); });
            THEME_SWATCHES.forEach(function (n) {
                var c = vars[n] && rgba(vars[n]) ? hex6(vars[n]) : "";
                if (!c || seen[c]) return;
                seen[c] = 1;
                strip.appendChild(swatch(c, "тема: " + tokenToId(n), set));
            });
            if (!strip.childNodes.length) strip.appendChild(h("span", "mc-note", "цветов пока нет"));
            if (row.parentNode) row.parentNode.insertBefore(strip, row.nextSibling);
        });
        ctl.appendChild(pal);
    }

    // ---- состояние элемента: правка только под мышью, в фокусе или при нажатии
    var STATE_RE = /:(hover|focus-within|active)$/;
    var STATE_TITLES = [["", "Всегда"], ["hover", "Под мышью"], ["focus-within", "В фокусе"], ["active", "Пока нажат"]];
    function splitState(sel) { var m = STATE_RE.exec(sel || ""); return m ? { base: sel.slice(0, m.index), state: m[1] } : { base: sel || "", state: "" }; }
    /** Селектор без состояния — для подсчёта совпадений и отпечатка (под мышью сейчас никого нет). */
    function stripState(sel) { return splitState(sel).base; }
    function stateSection() {
        var cur = splitState(des.sel);
        var sec = section("Состояние", "Правки ниже сработают только в этом состоянии: например, кнопка ярче под мышью.");
        var s = h("select");
        STATE_TITLES.forEach(function (o) { var op = h("option", null, o[1]); op.value = o[0]; s.appendChild(op); });
        s.value = cur.state;
        s.addEventListener("change", function () { des.sel = cur.base + (s.value ? ":" + s.value : ""); renderPanel(true); });
        var row = h("div", "mc-row"); row.appendChild(s);
        sec.appendChild(row);
    }

    // ---- выключить правило, не удаляя
    function setRuleOff(sel, off) {
        var r = DS.rules[sel];
        if (!r) return;
        if (off) r.off = true; else delete r.off;
        queueOp("toggle|" + sel, { op: "toggleRule", selector: sel, off: !!off });
        renderDesignCss();
    }

    // ---- части профиля и переименование (карточка профиля во вкладке «Профили»)
    var PROFILE_PARTS = [["rules", "Элементы"], ["settings", "Настройки"], ["colors", "Цвета"], ["fx", "Эффекты"], ["buttons", "Кнопки"]];
    function profileExtras(card, name, own) {
        var det = h("details");
        det.appendChild(h("summary", null, own ? "Часть профиля, имя" : "Взять только часть"));
        det.appendChild(h("div", "mc-note", "Добавить к текущему виду только выбранное — остальное не тронется, профиль не переключится."));
        var bs = h("div", "mc-btns");
        PROFILE_PARTS.forEach(function (p) {
            bs.appendChild(btn(p[1], "", function () { profileOp({ op: "applyProfile", name: name, only: [p[0]] }, "Из профиля «" + name + "» взято: " + p[1].toLowerCase()); }));
        });
        det.appendChild(bs);
        if (own) {
            var line = h("div", "mc-row"); line.style.marginTop = "6px";
            var inp = h("input"); inp.type = "text"; inp.value = name; inp.maxLength = 40;
            var go = function () {
                var to = inp.value.trim();
                if (!to || to === name) return;
                profileOp({ op: "renameProfile", from: name, to: to }, "Профиль переименован: «" + to + "»");
            };
            inp.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); go(); } });
            line.appendChild(inp);
            line.appendChild(btn("Переименовать", "", go));
            det.appendChild(line);
        }
        card.appendChild(det);
    }

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

    // ---- то, что окно VS Code знает о себе само: все значки codicon и все цвета темы.
    //      Списки берутся из загруженных стилей и переменных темы этой версии VS Code — руками не ведутся.

    var codiconCache = null;
    /** Имена всех значков codicon из стилей окна (отсортированы); пусто — запасной короткий список. */
    function allCodicons() {
        if (codiconCache) return codiconCache;
        var out = {};
        var walk = function (rules) {
            for (var i = 0; rules && i < rules.length; i++) {
                var r = rules[i];
                if (r.cssRules && !r.selectorText) { walk(r.cssRules); continue; }
                var st = r.selectorText;
                if (!st || st.indexOf(".codicon-") === -1) continue;
                var re = /\.codicon-([a-z0-9-]{1,40}):{1,2}before/g, m;
                while ((m = re.exec(st))) out[m[1]] = 1;
            }
        };
        try { Array.prototype.forEach.call(document.styleSheets || [], function (sh) { try { walk(sh.cssRules); } catch (e) {} }); } catch (e) {}
        var list = Object.keys(out).sort();
        codiconCache = list.length > 20 ? list : ICONS.slice();
        return codiconCache;
    }

    /** Выбор значка: поиск по имени и сетка. pick(name) — выбранный значок. */
    function iconPicker(current, pick) {
        var det = h("details");
        det.appendChild(h("summary", null, "Все значки VS Code"));
        var inp = h("input", "mc-search"); inp.type = "text"; inp.placeholder = "Имя значка по-английски: git, debug, arrow…"; inp.spellcheck = false;
        inp.style.margin = "0 0 6px"; inp.style.width = "100%";
        var grid = h("div", "mc-icons"), note = h("div", "mc-note");
        var draw = function () {
            var q = inp.value.trim().toLowerCase(), all = allCodicons();
            var list = q ? all.filter(function (n) { return n.indexOf(q) !== -1; }) : ICONS.filter(function (n) { return all.indexOf(n) !== -1; });
            grid.textContent = "";
            list.slice(0, 96).forEach(function (n) {
                var b = h("button", "mc-ico" + (n === current ? " on" : "")); b.type = "button"; b.title = n;
                b.appendChild(h("span", "codicon codicon-" + n));
                b.addEventListener("click", function (e) { e.preventDefault(); pick(n); });
                grid.appendChild(b);
            });
            note.textContent = q ? (list.length ? "найдено: " + list.length + (list.length > 96 ? ", показаны первые 96" : "") : "ничего не найдено") : "всего значков: " + all.length + " — начни вводить имя";
        };
        inp.addEventListener("input", draw);
        det.addEventListener("toggle", function () { if (det.open && !grid.childNodes.length) draw(); });
        det.appendChild(inp); det.appendChild(grid); det.appendChild(note);
        return det;
    }

    // ---- выбор: несколько элементов сразу, похожие элементы, показать скрытое, поиск в правках
    /** Shift+клик: добавить элемент к выбранным — правки пойдут на все (селекторы через запятую). */
    function addToSelection(el) {
        var add = selectorFor(el);
        if (!add) return;
        var parts = des.sel.split(/\s*,\s*/);
        if (parts.indexOf(add) !== -1) { toast("Этот элемент уже выбран"); return; }
        if ((des.sel + ", " + add).length > 560) { toast("Слишком много элементов для одной правки", "warn"); return; }
        des.sel = des.sel + ", " + add;
        des.multi = parts.length + 1;
        des.entry = null; des.anchor = null;
        des.tab = "el";
        renderPanel(true);
        highlight(des.sel, false);
    }
    /** Кнопка «Похожие (N)»: все элементы с тем же классом в той же части окна. */
    function similarButton(nav) {
        var el = des.selEl;
        if (!el || des.multi > 1) return;
        var cls = stableClasses(el)[0], part = el.closest ? el.closest(".part") : null;
        if (!cls || !part) return;
        var sel = segment(part).text + " ." + cssEsc(cls), n = count(sel);
        if (n < 2 || n === Infinity || n > 200 || sel === des.sel) return;
        nav.appendChild(btn("Похожие (" + n + ")", "", function () { des.sel = sel; des.entry = null; renderPanel(true); highlight(sel, false); }, "Все элементы с классом ." + cls + " в этой части окна"));
    }
    function showHiddenButton() {
        var b = btnPlain("Скрытое", function () {
            des.showHidden = !des.showHidden;
            b.style.background = des.showHidden ? "color-mix(in srgb, currentColor 22%, transparent)" : "";
            renderDesignCss();
            toast(des.showHidden ? "Скрытые элементы показаны бледными — кликни, чтобы выбрать и вернуть" : "Скрытые элементы снова скрыты");
        });
        b.title = "Показать элементы, скрытые правками: их можно выбрать и вернуть";
        return b;
    }
    /** Поиск по списку правок (появляется, когда правок много): карточки прячутся на месте. */
    function changesSearch() {
        if (Object.keys(DS.rules).length < 6) return;
        var inp = h("input", "mc-search"); inp.type = "text"; inp.placeholder = "Найти правку: элемент, селектор, свойство…"; inp.spellcheck = false;
        inp.value = des.changesQuery || "";
        var apply = function () {
            var q = inp.value.trim().toLowerCase();
            des.changesQuery = inp.value;
            Array.prototype.forEach.call(des.panel.querySelectorAll(".mc-card"), function (c) { c.style.display = !q || String(c.textContent).toLowerCase().indexOf(q) !== -1 ? "" : "none"; });
        };
        inp.addEventListener("input", apply);
        des.panel.appendChild(inp);
        if (des.changesQuery) setTimeout(apply, 0);
    }

    /**
     * Секция «Любой цвет темы» во вкладке «Ещё»: поиск по всем цветам темы VS Code (их сотни) и
     * правка найденного — в штатную workbench.colorCustomizations, как и остальные цвета темы.
     */
    function allColorsSection() {
        var sec = section("Любой цвет темы", "Все цвета, которыми VS Code красит интерфейс. Начни вводить: statusBar, tab, sideBar, button, terminal…");
        var inp = h("input", "mc-search"); inp.type = "text"; inp.placeholder = "Имя цвета: tab.activeBackground"; inp.spellcheck = false;
        inp.style.margin = "0 0 6px"; inp.style.width = "100%";
        inp.value = des.colorQuery || "";
        var box = h("div"), note = h("div", "mc-note");
        var draw = function () {
            var q = inp.value.trim().toLowerCase().replace(/\./g, "-");
            des.colorQuery = inp.value;
            box.textContent = "";
            if (q.length < 2) { note.textContent = "Изменённые цвета — во вкладке «Правки»."; return; }
            var vars = themeVars();
            var names = Object.keys(vars).filter(function (n) { return n.toLowerCase().indexOf(q) !== -1 && rgba(vars[n]); }).sort(function (a, b) { return a.length - b.length || (a < b ? -1 : 1); });
            names.slice(0, 12).forEach(function (n) {
                var id = tokenToId(n);
                box.appendChild(colorRow("wb:" + id, id, n, "Цвет темы: " + id));
            });
            note.textContent = names.length ? "найдено: " + names.length + (names.length > 12 ? ", показаны первые 12 — уточни запрос" : "") : "такого цвета в этой теме нет";
        };
        inp.addEventListener("input", draw);
        sec.appendChild(inp); sec.appendChild(box); sec.appendChild(note);
        draw();
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
    //  Страховки окна.
    //
    //  «Стоп-кран»: Ctrl+Alt+Shift+Backspace выключает в этом окне все стили Moon Core
    //  (сниппеты, правки конструктора, эффекты) — и включает обратно. Работает без расширения и
    //  без моста: если правка спрятала что-то нужное, до конструктора можно добраться. Ничего не
    //  удаляется и не сохраняется: после перезагрузки окна стили снова на месте.
    //
    //  Безопасный режим (его включает расширение, флаг приходит в состоянии): сниппеты, правки
    //  и модули не работают во всех окнах; в углу окна — напоминание.
    // ---------------------------------------------------------------------------
    var panicOn = false, safeEl = null;

    function ourStyleNodes() {
        var list = Object.keys(styles).map(function (id) { return styles[id]; });
        if (designStyle) list.push(designStyle);
        if (fx.style) list.push(fx.style);
        try { Array.prototype.forEach.call(document.querySelectorAll("style[data-mooncore-js]"), function (s) { list.push(s); }); } catch (e) {}
        return list;
    }
    function applyPanic() {
        var media = panicOn ? "not all" : "";
        ourStyleNodes().forEach(function (s) { try { s.media = media; } catch (e) {} });
        if (fx.canvas) fx.canvas.style.display = panicOn ? "none" : "";
    }
    function setPanic(on) {
        panicOn = !!on;
        applyPanic();
        toast(panicOn ? "Moon Core: стили отключены в этом окне. Ctrl+Alt+Shift+Backspace — включить обратно." : "Moon Core: стили снова включены.", panicOn ? "warn" : "");
        return panicOn;
    }
    function onPanicKey(e) {
        if (!e || e.key !== "Backspace" || !e.ctrlKey || !e.altKey || !e.shiftKey) return;
        try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
        setPanic(!panicOn);
    }
    try { window.addEventListener("keydown", onPanicKey, true); } catch (e) {}

    /** Напоминание о безопасном режиме в углу окна (и его снятие, когда режим выключили). */
    function safeBadge() {
        if (!SAFE) { if (safeEl) { try { safeEl.remove(); } catch (e) {} safeEl = null; } return; }
        if (safeEl || !document.body) return;
        safeEl = document.createElement("div");
        safeEl.setAttribute("data-mooncore-ui", "safe");
        safeEl.textContent = "Moon Core: безопасный режим";
        safeEl.title = "Сниппеты, правки конструктора и модули отключены. Выйти: значок Moon в статусбаре — «Безопасный режим».";
        Object.assign(safeEl.style, {
            position: "fixed", left: "10px", bottom: "30px", zIndex: String(Z + 4), padding: "3px 10px", borderRadius: "10px",
            font: "11px/1.5 var(--vscode-font-family, sans-serif)", pointerEvents: "auto", cursor: "default",
            background: "var(--vscode-statusBarItem-warningBackground, #d29922)", color: "var(--vscode-statusBarItem-warningForeground, #11111b)",
            boxShadow: "0 4px 14px rgba(0,0,0,.35)",
        });
        document.body.appendChild(safeEl);
    }

    // ---------------------------------------------------------------------------
    //  Скорость VS Code: метки старта окна (code/* ставит сам VS Code, mooncore:* — мы),
    //  подвисания окна (Long Tasks API) и память JS окна. Хост собирает из них страницу
    //  «Скорость VS Code» и историю запусков. Только чтение: в работу окна ничего не вмешивается.
    // ---------------------------------------------------------------------------
    // Только этапы верхнего уровня (code/willX, code/didX) и свои: вложенных меток (чат, агенты,
    // восстановление по шагам) в VS Code 1.140 так много, что под лимитом терялись поздние
    // ключевые — didStartWorkbench и didLoadExtensions (поймал прогон в настоящем VS Code).
    var PERF_MARK_RE = /^(code\/(will|did)[A-Za-z]{2,60}|mooncore:[\w-]{1,40})$/;
    /** Метки окна: имя -> мс от начала загрузки окна (каждая — первое значение, не больше 120). */
    function vsMarks() {
        var out = {}, n = 0;
        try {
            var list = window.performance && performance.getEntriesByType ? performance.getEntriesByType("mark") : [];
            for (var i = 0; i < list.length && n < 120; i++) {
                var m = list[i];
                if (m && PERF_MARK_RE.test(m.name) && out[m.name] == null) { out[m.name] = Math.round(m.startTime); n++; }
            }
        } catch (e) {}
        return out;
    }
    // Подвисание — задача главного потока дольше FREEZE_MS (Long Tasks сообщает о задачах от 50 мс).
    // buffered: true — и те, что были до подписки (старт окна).
    var FREEZE_MS = 200;
    var freezes = { n: 0, ms: 0, max: 0 };
    function onLongTasks(entries) {
        for (var i = 0; i < entries.length; i++) {
            var d = Math.round(entries[i] && entries[i].duration || 0);
            if (d >= FREEZE_MS) { freezes.n++; freezes.ms += d; if (d > freezes.max) freezes.max = d; }
        }
    }
    try {
        if (typeof PerformanceObserver === "function") {
            new PerformanceObserver(function (list) { try { onLongTasks(list.getEntries()); } catch (e) {} }).observe({ type: "longtask", buffered: true });
        }
    } catch (e) {}
    /** Сводка для хоста: подвисания, память JS окна (МБ), сколько секунд окно открыто. */
    function perfInfo() {
        var heap = 0;
        try { if (window.performance && performance.memory) heap = Math.round(performance.memory.usedJSHeapSize / 1048576); } catch (e) {}
        return { freezes: freezes.n, freezeMs: freezes.ms, freezeMax: freezes.max, heapMb: heap, up: Math.round(now() / 1000) };
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
        // Скрытое окно не проверяем: покажется — проверим сразу (onVisible).
        setInterval(function () { if (!winHidden()) { try { ensureButtons(); } catch (e) {} } }, 1500);
        try { safeBadge(); } catch (e) {}
        // Контекст окна (язык, ветка...) — спросить свой хост сразу, не дожидаясь событий.
        setTimeout(function () { rpcFirst("context", {}, ownToken && hosts[ownToken] ? hosts[ownToken] : null).then(function (r) { if (r && r.ok) applyCtx(r); }); }, 1500);
    });

    // Окна VS Code создаются с backgroundThrottling: false (out/main.js) — в свёрнутом окне
    // таймеры идут так же часто, как в активном. Поэтому периодическая работа рантайма в
    // скрытом окне спит или идёт реже, а при показе окна догоняется сразу.
    function winHidden() { try { return document.hidden === true; } catch (e) { return false; } }
    function anyOpen() { return Object.keys(hosts).some(function (t) { return hosts[t].open; }); }
    // Адреса хостов: пока ни один хост не на связи (старт окна — расширение ещё активируется),
    // файл читается часто, с нарастающей паузой 300 мс -> 5 с; раньше — раз в 5 с, и окно
    // подключалось к мосту через 5 с после старта, хотя хост поднимался за 2-3. Дальше — раз
    // в 5 с, в скрытом окне — раз в 15 с.
    var hostTries = 0;
    function hostDelay() {
        if (anyOpen()) { hostTries = 0; return winHidden() ? 15000 : 5000; }
        hostTries++;
        return Math.min(5000, Math.round(300 * Math.pow(1.4, hostTries)));
    }
    (function hostLoop() {
        try { refreshHosts(); } catch (e) {}
        setTimeout(hostLoop, hostDelay());
    })();
    function onVisible() {
        if (winHidden()) return;
        try { refreshHosts(); } catch (e) {}
        try { if (domReady) ensureButtons(); } catch (e) {}
        try { renderCss(); } catch (e) {}
    }
    try { document.addEventListener("visibilitychange", onVisible); } catch (e) {}
    setInterval(function () { Object.keys(hosts).forEach(function (t) { if (hosts[t].open) sendHello(hosts[t]); }); }, 60000);
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
    setInterval(function () { if (!winHidden()) { try { renderCss(); } catch (e) {} } }, headObserved ? 10000 : 2000);

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
        sendTiming(false);
        // Расширения VS Code поднимаются дольше, чем окно: метки code/didLoadExtensions и
        // восстановления редакторов к первой отправке могут ещё не появиться. Второй раз —
        // позже, с полным набором (хост обновляет запись этого окна, а не добавляет новую).
        setTimeout(function () { sendTiming(true); }, 25000);
    }
    /** Время запуска хосту: своему (если знаем), иначе любому. final — вторая, полная отправка. */
    function sendTiming(final) {
        var tries = 0;
        (function send() {
            var body = {};
            Object.keys(timing).forEach(function (k) { body[k] = timing[k]; });
            body.win = WIN_ID; body.vs = vsMarks(); body.perf = perfInfo(); body.final = !!final;
            rpcFirst("timing", body, ownToken && hosts[ownToken] ? hosts[ownToken] : null).then(function (r) { if (!(r && r.ok) && ++tries < 4) setTimeout(send, 5000); },
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
            if (SAFE) return true;                       // безопасный режим: модули не запускаются
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
        /** «Стоп-кран»: выключить (true) или включить (false) все стили Moon Core в этом окне. Без аргумента — переключить. */
        panic: function (on) { return setPanic(on === undefined ? !panicOn : on); },
        /** Отладка и тесты: пауза до следующего чтения адресов хостов (мс) и реакция на показ окна. */
        _hostDelay: hostDelay,
        _onVisible: onVisible,
        /** Отладка и тесты: метки старта окна и сводка подвисаний, как их получит хост. */
        _perf: function () { return { marks: vsMarks(), info: perfInfo() }; },
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
                rev: rev, domReady: domReady, safe: SAFE, panic: panicOn, win: WIN_ID,
                stopped: Object.keys(crashed),
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
