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
