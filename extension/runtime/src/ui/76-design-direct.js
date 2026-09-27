    // ---------------------------------------------------------------------------
    //  Прямая правка мышкой на самом элементе.
    //    - ручки рамки: правый край, низ, угол — ширина/высота; кружок сверху справа — масштаб;
    //      квадрат снизу слева — внутренний отступ. Двойной клик по ручке — вернуть как было;
    //    - «::» сверху слева — перетащить элемент среди соседей (CSS order у flex-контейнера);
    //    - «Как было» в нижней полосе: пока нажата — окно без правок CSS (до / после);
    //    - подсветка: наведение на правку во вкладке «Правки» обводит её элементы.
    // ---------------------------------------------------------------------------
    var HANDLE_TITLES = {
        e: "Ширина: тяни вправо / влево. Двойной клик — как было",
        s: "Высота: тяни вниз / вверх. Двойной клик — как было",
        se: "Ширина и высота. Двойной клик — как было",
        zoom: "Масштаб: тяни вправо-вверх (крупнее) или влево-вниз. Двойной клик — как было",
        pad: "Внутренний отступ: тяни вниз (больше) или вверх. Двойной клик — как было",
        grip: "Перетащи, чтобы поставить элемент в другое место среди соседей",
    };
    var HANDLE_PROPS = { e: ["width"], s: ["height"], se: ["width", "height"], zoom: ["zoom"], pad: ["padding"] };

    function makeHandles() {
        des.handles = {};
        var accent = "var(--vscode-focusBorder, #89b4fa)";
        var base = {
            position: "fixed", zIndex: String(Z + 1), boxSizing: "border-box", display: "none",
            background: "var(--vscode-editorWidget-background, #1e1e2e)", border: "2px solid " + accent,
        };
        var cursors = { e: "ew-resize", s: "ns-resize", se: "nwse-resize", zoom: "nesw-resize", pad: "ns-resize", grip: "grab" };
        Object.keys(HANDLE_TITLES).forEach(function (k) {
            var d = document.createElement("div");
            d.setAttribute("data-mooncore-ui", "handle");
            d.setAttribute("data-handle", k);
            d.title = HANDLE_TITLES[k];
            Object.assign(d.style, base, { cursor: cursors[k], borderRadius: k === "zoom" ? "50%" : "3px" });
            if (k === "grip") {
                d.textContent = "::";
                Object.assign(d.style, { font: "bold 11px/12px var(--vscode-font-family, sans-serif)", color: accent, textAlign: "center", letterSpacing: "-1px" });
            }
            d.addEventListener("mousedown", function (e) { if (e.button === 0) startHandleDrag(k, e); });
            d.addEventListener("dblclick", function (e) { e.preventDefault(); e.stopPropagation(); resetHandle(k); });
            document.body.appendChild(d);
            des.handles[k] = d;
        });
        des.marker = uiBox({ background: accent, display: "none", borderRadius: "2px" });
    }

    function drawHandles(r) {
        if (!des || !des.handles) return;
        var H = des.handles;
        var show = !!(r && des.sel && !des.compare);
        var fl = show ? flexItem(des.selEl) : null;
        var place = function (k, x, y, w, hgt, on) {
            if (!on) { H[k].style.display = "none"; return; }
            Object.assign(H[k].style, { display: "block", left: Math.round(x) + "px", top: Math.round(y) + "px", width: w + "px", height: hgt + "px" });
        };
        place("e", r ? r.right - 4 : 0, r ? r.top + r.height / 2 - 9 : 0, 8, 18, show && r.height >= 14);
        place("s", r ? r.left + r.width / 2 - 9 : 0, r ? r.bottom - 4 : 0, 18, 8, show && r.width >= 14);
        place("se", r ? r.right - 5 : 0, r ? r.bottom - 5 : 0, 10, 10, show);
        place("zoom", r ? r.right + 3 : 0, r ? r.top - 13 : 0, 10, 10, show);
        place("pad", r ? r.left - 13 : 0, r ? r.bottom + 3 : 0, 10, 10, show);
        place("grip", r ? r.left - 2 : 0, r ? r.top - 16 : 0, 18, 14, show && (isFloating(des.sel) || (!!fl && canOrder(fl))));
        if (H.grip) H.grip.title = isFloating(des.sel) ? "Перетащи плавающее окно" : HANDLE_TITLES.grip;
    }

    function numStart(sel, prop, fallback) {
        var r = DS.rules[sel];
        var v = r && r.props[prop];
        return typeof v === "number" ? v : fallback;
    }
    function setClamped(sel, prop, v, label) {
        var p = PROPS[prop];
        if (!p || !isFinite(v)) return null;
        v = Math.min(p.max, Math.max(p.min, Math.round(v / p.step) * p.step));
        v = Math.round(v * 100) / 100;
        setProp(sel, prop, v, label);
        return v;
    }
    function selLabel() {
        return des.entry && des.anchor === des.selEl ? des.entry.label : des.selEl ? labelFor(des.selEl) : des.sel;
    }
    function dragTip(text, x, y) {
        des.tip.textContent = text;
        Object.assign(des.tip.style, { display: "block", left: Math.min(window.innerWidth - 180, x + 14) + "px", top: Math.max(4, y - 28) + "px" });
    }

    function startHandleDrag(kind, e) {
        e.preventDefault(); e.stopPropagation();
        if (!des || !des.selEl || !des.sel) return;
        if (isFloating(des.sel) && kind !== "zoom" && kind !== "pad") { startFloatDrag(kind, e); return; }
        if (kind === "grip") { startReorder(e); return; }
        var el = des.selEl, sel = des.sel, label = selLabel();
        var cs = null;
        try { cs = getComputedStyle(el); } catch (err) {}
        var rect = el.getBoundingClientRect();
        var zoom = numStart(sel, "zoom", 100), zf = zoom / 100 || 1;
        var px = function (v, fb) { var n = parseFloat(v); return isFinite(n) && n > 0 ? n : fb; };
        var start = {
            w: numStart(sel, "width", px(cs && cs.width, rect.width / zf)),
            h: numStart(sel, "height", px(cs && cs.height, rect.height / zf)),
            pad: numStart(sel, "padding", px(cs && cs.paddingTop, 0)),
            zoom: zoom,
        };
        var x0 = e.clientX, y0 = e.clientY;
        des.dragging = kind;
        des.hoverEl = null;
        var move = function (ev) {
            ev.preventDefault();
            var dx = ev.clientX - x0, dy = ev.clientY - y0, parts = [];
            if (kind === "e" || kind === "se") parts.push("ширина " + setClamped(sel, "width", start.w + dx / zf, label) + " px");
            if (kind === "s" || kind === "se") parts.push("высота " + setClamped(sel, "height", start.h + dy / zf, label) + " px");
            if (kind === "pad") parts.push("отступ " + setClamped(sel, "padding", start.pad + dy / 2, label) + " px");
            if (kind === "zoom") parts.push("масштаб " + setClamped(sel, "zoom", start.zoom + (dx - dy) / 2, label) + " %");
            drawDesign();
            dragTip(parts.join(", "), ev.clientX, ev.clientY);
        };
        var up = function () {
            window.removeEventListener("mousemove", move, true);
            window.removeEventListener("mouseup", up, true);
            if (!des) return;
            des.dragging = null;
            des.suppressClick = true;
            setTimeout(function () { if (des) des.suppressClick = false; }, 300);
            des.tip.style.display = "none";
            flushOps();
            renderPanel(true);
        };
        window.addEventListener("mousemove", move, true);
        window.addEventListener("mouseup", up, true);
    }

    function resetHandle(kind) {
        if (!des || !des.sel) return;
        if (kind === "grip") { resetOrder(); return; }
        (HANDLE_PROPS[kind] || []).forEach(function (p) { setProp(des.sel, p, null, selLabel()); });
        flushOps();
        renderPanel(true);
        drawDesign();
    }

    // ---- плавающее окно: элемент откреплён от раскладки (position: fixed) и лежит где поставили
    function isFloating(sel) { return !!(sel && DS.rules[sel] && DS.rules[sel].props.float); }
    function relayout() { clearTimeout(relayout.t); relayout.t = setTimeout(function () { try { window.dispatchEvent(new Event("resize")); } catch (e) {} }, 60); }
    function floatOn() {
        if (!des || !des.selEl || !des.sel) return;
        var r = des.selEl.getBoundingClientRect(), label = selLabel();
        setProp(des.sel, "float", true, label);
        setClamped(des.sel, "floatX", Math.max(0, r.left + 24), label);
        setClamped(des.sel, "floatY", Math.max(0, r.top + 24), label);
        setClamped(des.sel, "floatW", Math.max(160, r.width), label);
        setClamped(des.sel, "floatH", Math.max(90, Math.min(r.height, window.innerHeight - 80)), label);
        flushOps(); relayout(); renderPanel(true); setTimeout(drawDesign, 80);
    }
    function floatOff() {
        if (!des || !des.sel) return;
        ["float", "floatX", "floatY", "floatW", "floatH"].forEach(function (p) { setProp(des.sel, p, null, ""); });
        flushOps(); relayout(); renderPanel(true); setTimeout(drawDesign, 80);
    }
    function startFloatDrag(kind, e) {
        var sel = des.sel, label = selLabel(), p = DS.rules[sel].props;
        var s = { x: p.floatX || 0, y: p.floatY || 0, w: p.floatW || 300, h: p.floatH || 200 };
        var x0 = e.clientX, y0 = e.clientY;
        des.dragging = kind;
        var move = function (ev) {
            ev.preventDefault();
            var dx = ev.clientX - x0, dy = ev.clientY - y0;
            if (kind === "grip") {
                setClamped(sel, "floatX", Math.min(window.innerWidth - 60, s.x + dx), label);
                setClamped(sel, "floatY", Math.min(window.innerHeight - 30, s.y + dy), label);
            }
            if (kind === "e" || kind === "se") setClamped(sel, "floatW", s.w + dx, label);
            if (kind === "s" || kind === "se") setClamped(sel, "floatH", s.h + dy, label);
            drawDesign();
            var q = DS.rules[sel].props;
            dragTip(kind === "grip" ? q.floatX + ", " + q.floatY : q.floatW + " × " + q.floatH, ev.clientX, ev.clientY);
        };
        var up = function () {
            window.removeEventListener("mousemove", move, true);
            window.removeEventListener("mouseup", up, true);
            if (!des) return;
            des.dragging = null; des.suppressClick = true;
            setTimeout(function () { if (des) des.suppressClick = false; }, 300);
            des.tip.style.display = "none";
            flushOps(); relayout(); renderPanel(true);
        };
        window.addEventListener("mousemove", move, true);
        window.addEventListener("mouseup", up, true);
    }
    /** Секция «Плавающее окно» во вкладке «Элемент». */
    function floatSection() {
        if (!des.selEl) return;
        var on = isFloating(des.sel);
        var sec = section("Плавающее окно", on ? "Тяни за «::» — двигать, за край и угол — размер." :
            "Открепить элемент от раскладки и положить поверх окна. Для кнопок, виджетов, хлебных крошек, центра команд — отлично; крупные панели VS Code раскладывает сам, их содержимое может не подстроиться.");
        var bs = h("div", "mc-btns");
        bs.appendChild(on ? btn("Вернуть на место", "danger", floatOff) : btn("Открепить", "", floatOn));
        sec.appendChild(bs);
    }

    // ---- порядок среди соседей (flex)
    /** Ближайший к el элемент (сам el или предок до 3 уровней), который лежит во flex-ряду с соседями. */
    function flexItem(el) {
        for (var n = el, k = 0; n && k < 4; n = n.parentElement, k++) {
            var p = n.parentElement;
            if (!p || p === document.body || p === document.documentElement) return null;
            var cs = null;
            try { cs = getComputedStyle(p); } catch (e) { return null; }
            if (!/flex/.test(cs.display || "")) continue;
            if (visibleKids(p).length < 2) continue;
            return { item: n, parent: p, axis: /column/.test(cs.flexDirection || "") ? "y" : "x", reverse: /reverse/.test(cs.flexDirection || "") };
        }
        return null;
    }
    function visibleKids(p) {
        return Array.prototype.filter.call(p.children || [], function (c) {
            if (c.nodeType !== 1 || isOurUi(c)) return false;
            var r = c.getBoundingClientRect();
            return r.width > 0 || r.height > 0;
        });
    }
    /** Соседи в том порядке, в каком их видно на экране. */
    function visualOrder(fl) {
        return visibleKids(fl.parent).map(function (c) { return { el: c, r: c.getBoundingClientRect() }; })
            .sort(function (a, b) { return fl.axis === "y" ? a.r.top - b.r.top : a.r.left - b.r.left; })
            .map(function (x) { return x.el; });
    }
    /** Однозначный селектор для соседа (основной или запасной). */
    function uniqueSel(el) {
        var s = selectorFor(el);
        if (s && count(s) === 1 && hits(s, el)) return s;
        var c = selectorCandidates(el, 3);
        for (var i = 0; i < c.length; i++) if (count(c[i]) === 1) return c[i];
        return "";
    }
    function canOrder(fl) {
        if (fl.checked === undefined) fl.checked = visualOrder(fl).slice(0, 40).every(function (c) { return !!uniqueSel(c); });
        return fl.checked;
    }

    /** Поставить соседей в порядок list (как их должно быть видно). Каждому — правило order. */
    function applyOrder(fl, list) {
        var sels = list.map(uniqueSel);
        if (sels.some(function (s) { return !s; })) { toast("Moon Core: не у всех соседей есть однозначный селектор — порядок не меняю"); return false; }
        var n = list.length;
        list.forEach(function (el, i) {
            var ord = fl.reverse ? n - 1 - i : i;
            setProp(sels[i], "order", ord, "Порядок: " + itemLabel(el), el);
        });
        flushOps();
        return true;
    }
    function resetOrder() {
        var fl = des && des.selEl ? flexItem(des.selEl) : null;
        if (!fl) return;
        visibleKids(fl.parent).forEach(function (el) {
            var s = uniqueSel(el);
            if (s && DS.rules[s] && DS.rules[s].props.order !== undefined) setProp(s, "order", null, "");
        });
        flushOps();
        renderPanel(true);
        drawDesign();
    }
    /** Сдвинуть выбранный элемент на step позиций (кнопки «Раньше» / «Позже»). */
    function moveBy(step) {
        var fl = des && des.selEl ? flexItem(des.selEl) : null;
        if (!fl) return;
        var list = visualOrder(fl), i = list.indexOf(fl.item);
        var j = Math.max(0, Math.min(list.length - 1, i + step));
        if (i === -1 || i === j) return;
        list.splice(i, 1); list.splice(j, 0, fl.item);
        applyOrder(fl, list);
        renderPanel(true);
        setTimeout(drawDesign, 30);
    }

    function startReorder(e) {
        var fl = flexItem(des.selEl);
        if (!fl || !canOrder(fl)) return;
        var list = visualOrder(fl), others = list.filter(function (c) { return c !== fl.item; });
        var target = list.indexOf(fl.item);
        des.dragging = "grip";
        var move = function (ev) {
            ev.preventDefault();
            var pos = fl.axis === "y" ? ev.clientY : ev.clientX;
            target = others.filter(function (c) {
                var r = c.getBoundingClientRect();
                return (fl.axis === "y" ? r.top + r.height / 2 : r.left + r.width / 2) < pos;
            }).length;
            var pr = fl.parent.getBoundingClientRect();
            var ref = others[target] ? others[target].getBoundingClientRect() : null;
            var last = others[others.length - 1] ? others[others.length - 1].getBoundingClientRect() : pr;
            var at = ref ? (fl.axis === "y" ? ref.top : ref.left) : (fl.axis === "y" ? last.bottom : last.right);
            Object.assign(des.marker.style, fl.axis === "y"
                ? { display: "block", left: pr.left + "px", top: (at - 2) + "px", width: pr.width + "px", height: "3px" }
                : { display: "block", left: (at - 2) + "px", top: pr.top + "px", width: "3px", height: pr.height + "px" });
            dragTip("место " + (target + 1) + " из " + list.length, ev.clientX, ev.clientY);
        };
        var up = function () {
            window.removeEventListener("mousemove", move, true);
            window.removeEventListener("mouseup", up, true);
            if (!des) return;
            des.dragging = null;
            des.suppressClick = true;
            setTimeout(function () { if (des) des.suppressClick = false; }, 300);
            des.marker.style.display = "none";
            des.tip.style.display = "none";
            var next = others.slice();
            next.splice(target, 0, fl.item);
            if (next.some(function (c, i) { return c !== list[i]; })) applyOrder(fl, next);
            renderPanel(true);
            setTimeout(drawDesign, 30);
        };
        window.addEventListener("mousemove", move, true);
        window.addEventListener("mouseup", up, true);
    }

    /** Секция «Порядок» во вкладке «Элемент» — если элемент стоит в ряду с соседями. */
    function orderSection() {
        var fl = des.selEl ? flexItem(des.selEl) : null;
        if (!fl || !canOrder(fl)) return;
        var list = visualOrder(fl), i = list.indexOf(fl.item);
        var sec = section("Порядок", "Место среди соседей: " + (i + 1) + " из " + list.length + ". Можно тянуть за «::» над рамкой.");
        var bs = h("div", "mc-btns");
        bs.appendChild(btn(fl.axis === "y" ? "Выше" : "Раньше", "", function () { moveBy(-1); }));
        bs.appendChild(btn(fl.axis === "y" ? "Ниже" : "Позже", "", function () { moveBy(1); }));
        var has = list.some(function (c) { var s = uniqueSel(c); return s && DS.rules[s] && DS.rules[s].props.order !== undefined; });
        if (has) bs.appendChild(btn("Как было", "danger", resetOrder, "Вернуть исходный порядок всех соседей"));
        sec.appendChild(bs);
    }

    // ---- до / после
    function compareButton() {
        var b = btnPlain("Как было", function () {});
        b.title = "Удерживай: окно без правок CSS (конструктор и CSS-сниппеты). Настройки VS Code при этом не переключаются.";
        b.addEventListener("mousedown", function (e) { e.preventDefault(); setCompare(true); });
        ["mouseup", "mouseleave", "blur"].forEach(function (ev) { b.addEventListener(ev, function () { setCompare(false); }); });
        return b;
    }
    function setCompare(on) {
        if (!des || !!des.compare === !!on) return;
        des.compare = !!on;
        var media = on ? "not all" : "";
        Object.keys(styles).forEach(function (id) { styles[id].media = media; });
        if (designStyle) designStyle.media = media;
        try {
            Array.prototype.forEach.call(document.querySelectorAll("style[data-mooncore-js]"), function (s) { s.media = media; });
        } catch (e) {}
        if (des.panel) des.panel.style.opacity = on ? "0.12" : "";
        drawDesign();
    }

    // ---- подсветка элементов правки
    /** Обвести все элементы по селектору; peek — на время показать скрытые этим правилом. */
    function highlight(sel, peek) {
        clearHighlight();
        if (!des || !sel) return;
        if (peek && DS.rules[sel] && DS.rules[sel].props.hide) { des.peek = sel; renderDesignCss(); }
        var els = [];
        try { els = Array.prototype.slice.call(document.querySelectorAll(sel), 0, 40); } catch (e) {}
        des.hl = els.map(function (el) {
            var accent = "var(--vscode-focusBorder, #89b4fa)";
            var b = uiBox({ border: "2px dashed " + accent, background: "color-mix(in srgb, " + accent + " 18%, transparent)", borderRadius: "3px", display: "none" });
            b._el = el;
            return b;
        });
        drawHighlight();
    }
    function drawHighlight() {
        (des && des.hl || []).forEach(function (b) { placeBox(b, b._el); });
    }
    function clearHighlight() {
        if (!des) return;
        (des.hl || []).forEach(function (b) { try { b.remove(); } catch (e) {} });
        des.hl = [];
        if (des.peek) { des.peek = null; renderDesignCss(); }
    }
    /** Подсветка по наведению на строку панели. */
    function hoverHighlight(node, sel, peek) {
        node.addEventListener("mouseenter", function () { highlight(sel, peek); });
        node.addEventListener("mouseleave", clearHighlight);
    }
