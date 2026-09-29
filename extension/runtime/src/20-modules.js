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
