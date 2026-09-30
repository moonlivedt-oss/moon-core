    // ---- удобства конструктора: память панели, отмена и возврат, быстрые действия, перенос
    //      стиля между элементами, вид интерфейса целиком (акцент, шрифт, скругление)

    // Панель помнит, куда её поставили и какая вкладка была открыта (localStorage окна).
    var PANEL_KEY = "mooncore.designPanel", PANEL_TABS = ["map", "el", "changes", "profiles", "more"];
    function panelMemory() {
        try { var o = JSON.parse(localStorage.getItem(PANEL_KEY) || "null"); return o && typeof o === "object" ? o : {}; } catch (e) { return {}; }
    }
    function rememberPanel(patch) {
        try { localStorage.setItem(PANEL_KEY, JSON.stringify(Object.assign(panelMemory(), patch))); } catch (e) {}
    }
    function restorePanel() {
        var m = panelMemory();
        // «Элемент» без выбранного элемента пуст — с него не начинаем.
        if (PANEL_TABS.indexOf(m.tab) !== -1 && m.tab !== "el") des.tab = m.tab;
        if (typeof m.left === "number" && typeof m.top === "number" && m.left >= 0 && m.top >= 0 &&
            m.left < window.innerWidth - 120 && m.top < window.innerHeight - 80) {
            des.dragged = true;
            Object.assign(des.panel.style, { right: "auto", left: Math.round(m.left) + "px", top: Math.round(m.top) + "px" });
        }
    }
    /** Двойной клик по заголовку: панель возвращается на своё обычное место. */
    function resetPanelPlace() {
        if (!des || !des.panel) return;
        des.dragged = false;
        Object.assign(des.panel.style, { left: "auto", right: "12px", top: "44px" });
        rememberPanel({ left: null, top: null });
        placePanel();
    }

    // ---- отмена и возврат правок (историю ведёт хост: lib/history.js)
    function historyOp(dir) {
        profileOp({ op: dir === "redo" ? "redo" : "undo" }, dir === "redo" ? "Правка возвращена" : "Правка отменена");
    }
    function histButtons() {
        var box = h("span"); box.style.display = "inline-flex"; box.style.gap = "4px";
        des.undoBtn = btnPlain("Отменить", function () { historyOp("undo"); });
        des.redoBtn = btnPlain("Вернуть", function () { historyOp("redo"); });
        box.appendChild(des.undoBtn); box.appendChild(des.redoBtn);
        updateHist();
        return box;
    }
    function updateHist() {
        if (!des || !des.undoBtn) return;
        des.undoBtn.title = "Отменить последнюю правку (Ctrl+Z)" + (HIST.undo ? " — шагов: " + HIST.undo : "");
        des.redoBtn.title = "Вернуть отменённую правку (Ctrl+Y)" + (HIST.redo ? " — шагов: " + HIST.redo : "");
        des.redoBtn.style.opacity = HIST.redo ? "" : "0.55";
    }

    function curLabel() { return des.entry && des.anchor === des.selEl ? des.entry.label : des.selEl ? labelFor(des.selEl) : des.sel; }

    /** Клавиши конструктора, кроме Esc: отмена и возврат, родитель и обратно, Delete — скрыть. */
    function designHotkey(e) {
        var mod = e.ctrlKey || e.metaKey, code = String(e.code || ""), key = String(e.key || "");
        // По e.code: в русской раскладке клавиша Z даёт «я», а сочетание должно работать.
        if (mod && !e.shiftKey && code === "KeyZ") return function () { historyOp("undo"); };
        if (mod && (code === "KeyY" || (e.shiftKey && code === "KeyZ"))) return function () { historyOp("redo"); };
        if (mod) return null;
        if (key === "ArrowUp" && des.selEl) return selectParent;
        if (key === "ArrowDown" && des.stack.length) return selectChild;
        if (key === "Delete" && des.sel) return function () {
            setProp(des.sel, "hide", true, curLabel());
            renderPanel(true);
            toast("Скрыто. Вернуть — Ctrl+Z или вкладка «Правки»");
        };
        return null;
    }

    // ---- быстрые действия и перенос стиля
    function quickSection(sel, label) {
        var sec = section("Быстро");
        var props = function () { return (DS.rules[sel] && DS.rules[sel].props) || {}; };
        var bump = function (prop, delta, base) {
            var p = PROPS[prop]; if (!p) return;
            var cur = props()[prop]; if (cur === undefined) cur = base;
            setProp(sel, prop, Math.min(p.max, Math.max(p.min, Math.round((cur + delta) * 100) / 100)), label);
            renderPanel(true);
        };
        var bs = h("div", "mc-btns"); bs.style.marginTop = "0";
        bs.appendChild(btn(props().hide ? "Показать" : "Скрыть", "", function () { setProp(sel, "hide", props().hide ? null : true, label); renderPanel(true); }, "Клавиша Delete делает то же"));
        bs.appendChild(btn("Крупнее", "", function () { bump("zoom", 10, 100); }));
        bs.appendChild(btn("Мельче", "", function () { bump("zoom", -10, 100); }));
        bs.appendChild(btn("Прозрачнее", "", function () { bump("opacity", -0.15, 1); }));
        sec.appendChild(bs);
    }

    var styleClip = null;
    // Место и порядок — свойства конкретного элемента, с ними стиль не переносится.
    var CLIP_SKIP = { order: 1, float: 1, floatX: 1, floatY: 1, floatW: 1, floatH: 1, hide: 1 };
    function clipButtons(sel, label, box) {
        var props = DS.rules[sel] && DS.rules[sel].props;
        var keys = props ? Object.keys(props).filter(function (k) { return !CLIP_SKIP[k] && PROPS[k]; }) : [];
        if (keys.length) box.appendChild(btn("Скопировать стиль", "", function () {
            styleClip = {};
            keys.forEach(function (k) { styleClip[k] = props[k]; });
            toast("Стиль скопирован: выбери другой элемент и нажми «Вставить стиль»");
            renderPanel(true);
        }, "Запомнить правки этого элемента, чтобы перенести на другой"));
        if (styleClip) box.appendChild(btn("Вставить стиль (" + Object.keys(styleClip).length + ")", "", function () {
            Object.keys(styleClip).forEach(function (k) { if (PROPS[k]) setProp(sel, k, styleClip[k], label); });
            flushOps();
            renderPanel(true);
        }));
    }

    // ---- вид интерфейса целиком
    // Акцент — цвета темы, которыми VS Code красит фокус, кнопки, значки и активные вкладки.
    var ACCENT_KEYS = ["focusBorder", "button.background", "activityBarBadge.background", "activityBar.activeBorder", "panelTitle.activeBorder",
        "tab.activeBorderTop", "progressBar.background", "textLink.foreground", "badge.background", "statusBarItem.remoteBackground"];
    var ACCENT_FG = ["button.foreground", "activityBarBadge.foreground", "badge.foreground", "statusBarItem.remoteForeground"];
    var ACCENT_LABEL = "Акцент";
    function accentNow() { var r = DS.colors && DS.colors["wb:focusBorder"]; return r && r.label === ACCENT_LABEL ? r.value : ""; }
    function setAccent(value) {
        var c = value ? rgba(value) : null;
        // Текст на акцентном фоне — тёмный или светлый, по яркости фона.
        var fg = c ? ((0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) > 150 ? "#11111b" : "#ffffff") : null;
        ACCENT_KEYS.forEach(function (id) { setColor("wb:" + id, value, ACCENT_LABEL, id.replace(/\./g, "-")); });
        ACCENT_FG.forEach(function (id) { setColor("wb:" + id, fg, ACCENT_LABEL, id.replace(/\./g, "-")); });
    }

    function lookSection() {
        var f = fxConf();
        var sec = section("Вид интерфейса", "Весь интерфейс разом. Акцент пишется в цвета темы VS Code (переживает обновления), остальное — стилем Moon Core.");
        var row = function (title, isSet) { var r = h("div", "mc-row" + (isSet ? " set" : "")); r.appendChild(h("label", null, title)); var c = h("div", "mc-ctl"); r.appendChild(c); sec.appendChild(r); return { row: r, ctl: c }; };

        var acc = accentNow(), ra = row("Акцентный цвет", !!acc);
        var col = h("input"); col.type = "color"; col.value = acc || hex6(themeVars().focusBorder || "#89b4fa");
        col.addEventListener("input", function () { setAccent(col.value); ra.row.className = "mc-row set"; });
        col.addEventListener("change", function () { flushOps(); });
        ra.ctl.appendChild(col);
        ra.ctl.appendChild(h("span", "mc-note", acc || "как в теме"));
        colorExtras(col, ra.ctl, ra.row);
        ra.row.appendChild(xBtn(!!acc, function () { setAccent(null); flushOps(); renderPanel(true); }, "Вернуть цвета темы"));

        var rf = row("Шрифт интерфейса", !!f.uiFont);
        var t = h("input"); t.type = "text"; t.value = f.uiFont || ""; t.placeholder = "как в VS Code"; t.spellcheck = false;
        t.title = "Имена шрифтов через запятую, например: Inter, Segoe UI, sans-serif. Код и терминал не меняются.";
        t.addEventListener("change", function () {
            var v = t.value.trim();
            if (v && !/^[\w\s,'".-]{1,120}$/.test(v)) { toast("Шрифт: только буквы, цифры, пробелы, запятые и кавычки", "warn"); return; }
            setFx("uiFont", v || null); flushOps(); renderPanel(true);
        });
        rf.ctl.appendChild(t);
        rf.row.appendChild(xBtn(!!f.uiFont, function () { setFx("uiFont", null); flushOps(); renderPanel(true); }));

        var rr = row("Скругление", !!f.roundedUi);
        var rng = h("input"); rng.type = "range"; rng.min = 0; rng.max = 12; rng.step = 1; rng.value = f.roundedUi || 0;
        var note = h("span", "mc-note", f.roundedUi ? f.roundedUi + " px" : "как в теме");
        rng.addEventListener("input", function () { var v = +rng.value; setFx("roundedUi", v >= 1 ? v : null); note.textContent = v >= 1 ? v + " px" : "как в теме"; });
        rr.ctl.appendChild(rng); rr.ctl.appendChild(note);

        [["smoothUi", "Плавные переходы"], ["dimInactive", "Приглушать неактивные редакторы"]].forEach(function (x) {
            var r = row((FXSPEC[x[0]] && FXSPEC[x[0]].label) || x[1], !!f[x[0]]);
            var cb = h("input"); cb.type = "checkbox"; cb.checked = !!f[x[0]];
            cb.addEventListener("change", function () { setFx(x[0], cb.checked ? true : null); flushOps(); renderPanel(true); });
            r.ctl.appendChild(cb);
        });
    }

    // ---- поиск по карте: строки прячутся на месте, без перерисовки панели (поле не теряет фокус)
    function mapSearch(rows) {
        var inp = h("input", "mc-search"); inp.type = "text"; inp.placeholder = "Найти элемент или настройку…"; inp.spellcheck = false;
        inp.value = des.mapQuery || "";
        var apply = function () {
            var q = inp.value.trim().toLowerCase();
            des.mapQuery = inp.value;
            var shown = [];
            rows.forEach(function (r) {
                var ok = !q || r.text.indexOf(q) !== -1;
                r.node.style.display = ok ? "" : "none";
                if (r.extra) r.extra.style.display = ok ? "" : "none";
                if (ok && shown.indexOf(r.sec) === -1) shown.push(r.sec);
            });
            rows.forEach(function (r) { r.sec.style.display = shown.indexOf(r.sec) !== -1 ? "" : "none"; });
        };
        inp.addEventListener("input", apply);
        return { input: inp, apply: apply };
    }
