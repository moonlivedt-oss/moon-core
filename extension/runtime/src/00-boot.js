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
