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
