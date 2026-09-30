    // ---- панель
    function panelBusy() {
        var a = document.activeElement;
        return !!(des && des.panel && a && des.panel.contains(a) && (a.type === "text" || a.type === "number"));
    }
    function renderPanel(force) {
        if (!des || !des.panel) return;
        if (!force && panelBusy()) return;
        clearHighlight();                     // строка, на которую навели, сейчас пропадёт
        var scroll = des.panel.scrollTop;
        des.panel.textContent = "";
        var head = h("div", "mc-h");
        head.appendChild(h("div", "mc-title", des.multi > 1 ? "Выбрано элементов: " + des.multi : des.entry && des.anchor === des.selEl ? des.entry.label : des.selEl ? labelFor(des.selEl) : "Конструктор"));
        head.appendChild(xBtn(true, stopDesign, "Закрыть конструктор"));
        head.title = "Перетащи, чтобы подвинуть панель; двойной клик — вернуть на место";
        makeDraggable(head);
        des.panel.appendChild(head);
        var n = changesCount();
        var tabs = h("div", "mc-tabs");
        tabs.setAttribute("role", "tablist");
        [["map", "Карта"], ["el", "Элемент"], ["changes", "Правки" + (n ? " " + n : "")], ["profiles", "Профили"], ["more", "Ещё"]].forEach(function (t) {
            var b = h("button", "mc-tab" + (des.tab === t[0] ? " on" : ""), t[1]);
            b.type = "button";
            b.setAttribute("role", "tab");
            b.setAttribute("aria-selected", des.tab === t[0] ? "true" : "false");
            b.addEventListener("click", function () { des.tab = t[0]; des.confirmClear = false; des.confirm = ""; rememberPanel({ tab: t[0] }); renderPanel(true); });
            tabs.appendChild(b);
        });
        des.panel.appendChild(tabs);
        if (des.tab === "changes") renderChanges();
        else if (des.tab === "map") renderMap();
        else if (des.tab === "profiles") renderProfiles();
        else if (des.tab === "more") renderMore();
        else renderElement();
        des.panel.scrollTop = scroll;
        updateHist();
    }

    function section(title, note) {
        var s = h("div", "mc-sec");
        if (title) s.appendChild(h("h4", null, title));
        if (note) s.appendChild(h("div", "mc-note", note));
        des.panel.appendChild(s);
        return s;
    }

    function renderElement() {
        if (!des.sel && des.entry) {
            var only = des.entry.settings || [];
            if (!only.length) { des.panel.appendChild(h("div", "mc-empty", "Элемента «" + des.entry.label + "» сейчас нет на экране. Открой его в VS Code (Alt+клик работает как обычный клик) и выбери.")); return; }
            var so = section("Настройки VS Code", "Надёжный способ: переживает обновления VS Code.");
            only.forEach(function (st) { so.appendChild(settingRow(st, des.entry.label)); });
            return;
        }
        if (!des.sel) {
            var e = h("div", "mc-empty", "Кликни по любому элементу интерфейса: кнопке, вкладке, панели, пункту статусбара. " +
                "Его можно будет убрать, увеличить, перекрасить. Alt+клик работает как обычный клик — открыть меню или вкладку, не выходя из конструктора.");
            des.panel.appendChild(e);
            return;
        }
        var sel = des.sel;
        var label = des.entry && des.anchor === des.selEl ? des.entry.label : des.selEl ? labelFor(des.selEl) : sel;

        // Что выбрано
        var tgt = section("Что меняем");
        var inp = h("input", "mc-sel"); inp.type = "text"; inp.spellcheck = false; inp.value = sel;
        var cnt = h("div", "mc-count");
        var upd = function () {
            var k = count(stripState(inp.value.trim()));
            cnt.textContent = k === Infinity ? "селектор с ошибкой" : k === 0 ? "сейчас ничего не находит" : "совпадений: " + k + (k > 1 ? " — правка коснётся всех" : "");
            cnt.className = "mc-count" + (k === Infinity || k === 0 ? " bad" : "");
        };
        inp.addEventListener("input", upd);
        inp.addEventListener("change", function () {
            var v = inp.value.trim();
            if (v && count(stripState(v)) !== Infinity) { des.sel = v; renderPanel(true); }
        });
        upd();
        tgt.appendChild(inp); tgt.appendChild(cnt);
        // Другие однозначные селекторы элемента (id, aria-label, title): переживают переименование классов.
        if (des.selEl && des.selEl.isConnected) {
            var alts = selectorCandidates(des.selEl, 6).filter(function (a) { return a !== sel; });
            if (alts.length) {
                var vs = h("select", "mc-sel mc-alt");
                var v0 = h("option", null, "Другие варианты селектора: " + alts.length); v0.value = ""; vs.appendChild(v0);
                alts.forEach(function (a) { var o = h("option", null, a); o.value = a; vs.appendChild(o); });
                vs.title = "Селекторы, которые находят ровно этот элемент. Moon Core всё равно запомнит их как запасные.";
                vs.addEventListener("change", function () { if (vs.value) { des.sel = vs.value; renderPanel(true); } });
                tgt.appendChild(vs);
            }
        }
        var nav = h("div", "mc-btns");
        if (des.selEl) nav.appendChild(btn("Родитель", "", selectParent, "Выбрать элемент, в который вложен этот"));
        if (des.stack.length) nav.appendChild(btn("Назад внутрь", "", selectChild));
        if (des.entry && des.anchor && des.anchor !== des.selEl) nav.appendChild(btn((des.entry.many ? "" : "Весь блок: ") + des.entry.label, "", function () { selectEl(des.anchor); }));
        if (des.entry && des.entry.many && des.sel !== des.entry.selector) {
            var allN = count(des.entry.selector);
            nav.appendChild(btn("Все такие (" + allN + ")", "", function () { des.sel = des.entry.selector; renderPanel(true); }, "Применять правки ко всем элементам этого типа"));
        } else if (des.entry && des.entry.many && des.selEl) {
            nav.appendChild(btn("Только этот", "", function () { des.sel = selectorFor(des.selEl); renderPanel(true); }));
        }
        similarButton(nav);
        if (nav.childNodes.length) tgt.appendChild(nav);
        if (des.selEl) tgt.appendChild(h("div", "mc-note", "Shift+клик по другому элементу — править несколько сразу."));
        quickSection(sel, label);
        orderSection();
        condSection();
        stateSection();
        colorSection(label);
        floatSection();

        // Настройки VS Code
        var settings = des.entry && des.entry.settings || [];
        if (settings.length) {
            var ss = section("Настройки VS Code", "Надёжный способ: переживает обновления VS Code.");
            settings.forEach(function (s) { ss.appendChild(settingRow(s, des.entry.label)); });
        }

        // CSS-свойства
        var groups = [["view", "Вид"], ["size", "Размер"], ["text", "Текст"]];
        groups.forEach(function (g) {
            var sec = section(g[1]);
            Object.keys(PROPS).filter(function (k) { return PROPS[k].group === g[0]; }).forEach(function (k) { sec.appendChild(propRow(sel, k, label)); });
        });
        var risky = Object.keys(PROPS).filter(function (k) { return PROPS[k].group === "risky"; });
        if (risky.length) {
            var sec2 = section(null);
            var det = h("details");
            det.appendChild(h("summary", null, "Ширина и высота"));
            det.appendChild(h("div", "mc-note", "Крупные зоны VS Code раскладывает сам — жёсткий размер может спорить с раскладкой. Для кнопок и значков безопасно."));
            risky.forEach(function (k) { det.appendChild(propRow(sel, k, label)); });
            if (risky.some(function (k) { return DS.rules[sel] && DS.rules[sel].props[k] !== undefined; })) det.open = true;
            sec2.appendChild(det);
        }
        var foot = h("div", "mc-btns"); foot.style.margin = "10px 12px 0";
        clipButtons(sel, label, foot);
        if (DS.rules[sel]) foot.appendChild(btn("Сбросить этот элемент", "danger", function () { resetRule(sel); renderPanel(true); }));
        if (foot.childNodes.length) des.panel.appendChild(foot);
    }

    function computed(prop) {
        if (!des.selEl) return null;
        try {
            var cs = getComputedStyle(des.selEl), p = PROPS[prop];
            if (prop === "zoom") return 100;
            var v = cs.getPropertyValue(p.css);
            if (p.type === "number") { var n = parseFloat(v); return isFinite(n) ? n : null; }
            if (p.type === "color") return toHex(v);
            return v || null;
        } catch (e) { return null; }
    }
    function toHex(c) {
        var m = String(c || "").match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
        if (!m) return /^#[0-9a-f]{6}$/i.test(c) ? c : "#000000";
        return "#" + [m[1], m[2], m[3]].map(function (x) { return ("0" + (+x).toString(16)).slice(-2); }).join("");
    }

    function propRow(sel, prop, label) {
        var p = PROPS[prop];
        var cur = DS.rules[sel] && DS.rules[sel].props[prop];
        var isSet = cur !== undefined;
        var row = h("div", "mc-row" + (isSet ? " set" : ""));
        row.appendChild(h("label", null, p.label));
        var ctl = h("div", "mc-ctl");
        row.appendChild(ctl);
        var reset = xBtn(isSet, function () { setProp(sel, prop, null, label); renderPanel(true); });
        var mark = function () { row.className = "mc-row set"; reset.className = "mc-x"; };

        if (p.type === "flag") {
            var cb = h("input"); cb.type = "checkbox"; cb.checked = cur === true;
            cb.addEventListener("change", function () { setProp(sel, prop, cb.checked ? true : null, label); renderPanel(true); });
            ctl.appendChild(cb);
            if (prop === "hide") ctl.appendChild(h("span", "mc-note", "вернуть — во вкладке «Правки»"));
        } else if (p.type === "number") {
            var base = isSet ? cur : computed(prop);
            if (base == null || !isFinite(base)) base = p.min;
            base = Math.min(p.max, Math.max(p.min, base));
            var range = h("input"); range.type = "range"; range.min = p.min; range.max = p.max; range.step = p.step; range.value = base;
            var numb = h("input"); numb.type = "number"; numb.min = p.min; numb.max = p.max; numb.step = p.step; numb.value = +(+base).toFixed(2);
            range.addEventListener("input", function () { numb.value = range.value; setProp(sel, prop, +range.value, label); mark(); });
            numb.addEventListener("change", function () {
                var v = +numb.value;
                if (!isFinite(v)) return;
                v = Math.min(p.max, Math.max(p.min, v));
                numb.value = v; range.value = v;
                setProp(sel, prop, v, label); mark();
            });
            ctl.appendChild(range); ctl.appendChild(numb);
            if (p.unit) ctl.appendChild(h("span", "mc-note", p.unit));
        } else if (p.type === "color") {
            var col = h("input"); col.type = "color"; col.value = isSet ? cur : (computed(prop) || "#000000");
            col.addEventListener("input", function () { setProp(sel, prop, col.value, label); mark(); });
            ctl.appendChild(col);
            ctl.appendChild(h("span", "mc-note", isSet ? cur : "как в теме"));
            colorExtras(col, ctl, row);
        } else if (p.type === "enum") {
            var s = h("select");
            var o0 = h("option", null, "как в теме"); o0.value = ""; s.appendChild(o0);
            p.options.forEach(function (o) { var op = h("option", null, o); op.value = o; s.appendChild(op); });
            s.value = isSet ? String(cur) : "";
            s.addEventListener("change", function () { setProp(sel, prop, s.value || null, label); renderPanel(true); });
            ctl.appendChild(s);
        } else if (p.type === "text") {
            var t = h("input"); t.type = "text"; t.value = isSet ? cur : ""; t.placeholder = "как в теме";
            t.addEventListener("change", function () {
                var v = t.value.trim();
                if (v && !/^[\w\s,'".-]{1,120}$/.test(v)) { toast("Шрифт: только буквы, цифры, пробелы, запятые и кавычки"); return; }
                setProp(sel, prop, v || null, label); renderPanel(true);
            });
            ctl.appendChild(t);
        }
        row.appendChild(reset);
        return row;
    }

    function fmtVal(v) { return v === undefined ? "по умолчанию" : typeof v === "boolean" ? (v ? "да" : "нет") : String(v); }

    function settingRow(s, entryLabel) {
        var rec = DS.settings[s.key];
        var cur = SETNOW[s.key];
        var row = h("div", "mc-row" + (rec ? " set" : ""));
        var lab = h("label", null, s.label);
        lab.title = s.key + (s.hint ? " — " + s.hint : "");
        row.appendChild(lab);
        var ctl = h("div", "mc-ctl");
        row.appendChild(ctl);
        var label = s.label + " (" + entryLabel + ")";
        if (s.type === "bool") {
            var cb = h("input"); cb.type = "checkbox"; cb.checked = cur === true;
            cb.addEventListener("change", function () { setSetting(s.key, cb.checked, label); flushOps(); });
            ctl.appendChild(cb);
        } else if (s.type === "enum") {
            var sel = h("select");
            s.options.forEach(function (o) { var op = h("option", null, o); op.value = o; sel.appendChild(op); });
            sel.value = cur != null ? String(cur) : s.options[0];
            sel.addEventListener("change", function () { setSetting(s.key, sel.value, label); flushOps(); });
            ctl.appendChild(sel);
        } else if (s.type === "number") {
            var v0 = typeof cur === "number" ? cur : s.min;
            var range = h("input"); range.type = "range"; range.min = s.min; range.max = s.max; range.step = s.step; range.value = v0;
            var numb = h("input"); numb.type = "number"; numb.min = s.min; numb.max = s.max; numb.step = s.step; numb.value = v0;
            range.addEventListener("input", function () { numb.value = range.value; setSetting(s.key, +range.value, label); });
            numb.addEventListener("change", function () {
                var v = Math.min(s.max, Math.max(s.min, +numb.value || 0));
                numb.value = v; range.value = v; setSetting(s.key, v, label);
            });
            ctl.appendChild(range); ctl.appendChild(numb);
        } else if (s.type === "font") {
            var ft = h("input"); ft.type = "text"; ft.spellcheck = false; ft.value = typeof cur === "string" ? cur : ""; ft.placeholder = "как в VS Code";
            ft.addEventListener("change", function () {
                var fv = ft.value.trim();
                if (!fv) { if (DS.settings[s.key]) { undoSetting(s.key); flushOps(); renderPanel(true); } return; }
                if (!/^[A-Za-z0-9 _,'".-]{1,160}$/.test(fv)) { toast("Шрифт: латинские имена через запятую, например: Fira Code, Consolas, monospace", "warn"); return; }
                setSetting(s.key, fv, label); flushOps();
            });
            ctl.appendChild(ft);
        }
        row.appendChild(xBtn(!!rec, function () { undoSetting(s.key); flushOps(); renderPanel(true); }, rec ? "Вернуть: " + fmtVal(rec.hadPrev ? rec.prev : undefined) : ""));
        return row;
    }
