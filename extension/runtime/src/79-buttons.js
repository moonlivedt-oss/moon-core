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
