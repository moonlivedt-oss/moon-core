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
