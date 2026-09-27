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
        rec.es.onopen = function () { rec.errors = 0; rec.open = true; if (hasFocus() && !ownToken) probeOwnHost(); };
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

    function rpc(h, method, body) {
        if (typeof fetch !== "function") return Promise.resolve({ ok: false, error: "нет fetch" });
        var ctl = typeof AbortController === "function" ? new AbortController() : null;
        var timer = setTimeout(function () { if (ctl) ctl.abort(); }, PROTO.RPC_TIMEOUT_MS || 8000);
        return fetch("http://127.0.0.1:" + h.port + "/rpc/" + h.token + "/" + method, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body || {}),
            cache: "no-store",
            signal: ctl ? ctl.signal : undefined,
        }).then(function (res) {
            if (res.status === 409) return { ok: false, retry: true };
            return res.json().catch(function () { return { ok: res.ok }; });
        }).catch(function (e) { return { ok: false, error: String(e && e.message || e), net: true }; })
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
