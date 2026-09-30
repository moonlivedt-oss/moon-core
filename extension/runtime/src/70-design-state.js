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
