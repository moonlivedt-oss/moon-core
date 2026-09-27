    // ---- карта интерфейса: все зоны окна, видимость галочками
    function jsonEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
    function entryVisible(e) {
        if (e.vis && typeof e.vis === "object") return !jsonEq(SETNOW[e.vis.key], e.vis.off);
        if (e.vis === "css") return !(DS.rules[e.selector] && DS.rules[e.selector].props.hide);
        return true;
    }
    function setEntryVisible(e, show) {
        if (e.vis && typeof e.vis === "object") {
            var rec = DS.settings[e.vis.key];
            // Включаем обратно: если выключали мы и исходно было видно — возвращаем исходное значение.
            if (show && rec && !(rec.hadPrev && jsonEq(rec.prev, e.vis.off))) undoSetting(e.vis.key);
            else setSetting(e.vis.key, show ? e.vis.on : e.vis.off, (show ? "Показать: " : "Скрыть: ") + e.label);
            flushOps();
        } else if (e.vis === "css") {
            setProp(e.selector, "hide", show ? null : true, e.label, null, e);
        }
        renderPanel(true);
    }
    function itemLabel(el) {
        var t = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").replace(/\s+/g, " ").trim();
        if (!t && el.id) t = el.id;
        return t.slice(0, 48) || labelFor(el);
    }
    function openEntry(e) {
        var el = null;
        if (e.selector && !e.many) { try { el = document.querySelector(e.selector); } catch (err) {} }
        if (el) { selectEl(el); return; }
        des.selEl = null; des.anchor = null; des.stack = [];
        des.entry = e;
        des.sel = e.selector || "";
        des.tab = "el";
        renderPanel(true);
        drawDesign();
    }

    function renderMap() {
        des.panel.appendChild(h("div", "mc-note mc-pad", "Всё, что есть в окне VS Code. Галочка — показывать или нет, «Настроить» — размер, шрифт, цвет и настройки элемента. Скрытое возвращается здесь же."));
        ZONES.forEach(function (z) {
            var entries = CATALOG.filter(function (e) { return e.zone === z.id; });
            if (!entries.length) return;
            var sec = section(z.label);
            entries.forEach(function (e) {
                var row = h("div", "mc-map");
                var hasToggle = !!e.vis;
                var cb = h("input"); cb.type = "checkbox";
                if (hasToggle) {
                    cb.checked = entryVisible(e);
                    cb.title = e.vis === "css" ? "Скрыть правилом CSS" : "Настройка " + e.vis.key;
                    cb.addEventListener("change", function () { setEntryVisible(e, cb.checked); });
                } else { cb.disabled = true; cb.checked = true; cb.style.visibility = "hidden"; }
                row.appendChild(cb);
                var name = h("span", "mc-map-name", e.label);
                var n = e.selector ? count(e.selector) : -1;
                if (n === 0) { name.appendChild(h("small", null, " сейчас не на экране")); row.classList.add("off"); }
                else if (e.many && n > 0) name.appendChild(h("small", null, " " + n + " шт."));
                if (hasToggle && !cb.checked) row.classList.add("hidden-el");
                row.appendChild(name);
                var go = btn("Настроить", "mc-mini", function () { openEntry(e); });
                row.appendChild(go);
                if (e.selector) hoverHighlight(row, e.selector, false);
                sec.appendChild(row);
                if (e.list && n > 0) sec.appendChild(renderList(e));
            });
        });
    }

    /**
     * Поштучный список (пункты статусбара, иконки панели активности): галочка — показывать,
     * строки можно перетаскивать — так меняется порядок элементов в окне (CSS order).
     * Список идёт в том порядке, в каком элементы видны на экране.
     */
    function renderList(e) {
        var box = h("div", "mc-list");
        var els = [];
        try { els = Array.prototype.slice.call(document.querySelectorAll(e.selector), 0, 60); } catch (err) {}
        var parents = [];
        var items = els.map(function (el) {
            var fl = flexItem(el), r = el.getBoundingClientRect();
            var pi = fl ? parents.indexOf(fl.parent) : -1;
            if (fl && pi === -1) { parents.push(fl.parent); pi = parents.length - 1; }
            return { el: el, fl: fl, group: pi, pos: fl && fl.axis === "y" ? r.top : r.left };
        }).sort(function (a, b) { return (a.group - b.group) || (a.pos - b.pos); });
        var seen = {}, dragged = null;
        items.forEach(function (it) {
            var el = it.el, sel = selectorFor(el);
            if (!sel || seen[sel]) return;
            seen[sel] = 1;
            var hidden = !!(DS.rules[sel] && DS.rules[sel].props.hide);
            var row = h("div", "mc-map mc-sub" + (hidden ? " hidden-el" : ""));
            var movable = !hidden && it.fl && canOrder(it.fl);
            if (movable) {
                var grip = h("span", "mc-drag", "::");
                grip.title = "Перетащи строку, чтобы поменять порядок в окне";
                row.appendChild(grip);
                row.draggable = true;
                row.addEventListener("dragstart", function (ev) { dragged = it; try { ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", sel); } catch (x) {} });
                row.addEventListener("dragend", function () { dragged = null; });
                row.addEventListener("dragover", function (ev) {
                    if (!dragged || dragged === it || !dragged.fl || dragged.fl.parent !== it.fl.parent) return;
                    ev.preventDefault();
                    var rr = row.getBoundingClientRect(), after = ev.clientY > rr.top + rr.height / 2;
                    row.classList.toggle("drop-before", !after); row.classList.toggle("drop-after", after);
                });
                row.addEventListener("dragleave", function () { row.classList.remove("drop-before"); row.classList.remove("drop-after"); });
                row.addEventListener("drop", function (ev) {
                    row.classList.remove("drop-before"); row.classList.remove("drop-after");
                    if (!dragged || dragged === it || !dragged.fl || dragged.fl.parent !== it.fl.parent) return;
                    ev.preventDefault();
                    var rr = row.getBoundingClientRect(), after = ev.clientY > rr.top + rr.height / 2;
                    var list = visualOrder(it.fl).filter(function (c) { return c !== dragged.fl.item; });
                    var at = list.indexOf(it.fl.item);
                    if (at === -1) return;
                    list.splice(after ? at + 1 : at, 0, dragged.fl.item);
                    dragged = null;
                    if (applyOrder(it.fl, list)) setTimeout(function () { renderPanel(true); }, 60);
                });
            }
            var cb = h("input"); cb.type = "checkbox"; cb.checked = !hidden;
            var label = itemLabel(el);
            cb.addEventListener("change", function () { setProp(sel, "hide", cb.checked ? null : true, e.label + ": " + label, el); renderPanel(true); });
            row.appendChild(cb);
            row.appendChild(h("span", "mc-map-name", label));
            if (!hidden) row.appendChild(btn("Настроить", "mc-mini", function () { selectEl(el); }));
            hoverHighlight(row, sel, true);
            box.appendChild(row);
        });
        return box;
    }
