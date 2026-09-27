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
    function isCspError(e) {
        return (typeof EvalError === "function" && e instanceof EvalError) || /unsafe-eval|Content Security Policy|Trusted ?Type/i.test(String(e && e.message || e));
    }
    // Trusted Types: VS Code пускает код из строки только через политику из списка CSP; Moon Core
    // вписывает туда «mooncore» при внедрении. Политика создаётся сразу (имя не займёт чужой
    // скрипт) и пропускает только ту строку, которую загрузчик сверил по SHA-256.
    var uiPolicy = null, uiVerified = null;
    try {
        if (window.trustedTypes && typeof window.trustedTypes.createPolicy === "function") {
            uiPolicy = window.trustedTypes.createPolicy("mooncore", {
                createScript: function (s) { if (s !== uiVerified) throw new Error("Moon Core: непроверенный код"); return s; },
            });
        }
    } catch (e) { uiPolicy = null; }   // имени нет в списке CSP — eval попробуем как есть
    function trustedScript(code) {
        if (!uiPolicy) return code;
        uiVerified = code;
        try { return uiPolicy.createScript(code); } finally { uiVerified = null; }
    }
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
