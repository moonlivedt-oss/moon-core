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
