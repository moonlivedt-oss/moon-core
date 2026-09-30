    // ---- режим
    var DES_EVENTS = ["mousedown", "mouseup", "click", "dblclick", "auxclick", "pointerdown", "pointerup", "contextmenu"];

    function toggleDesign(host) { if (des) stopDesign(); else startDesign(host); }

    function startDesign(host) {
        if (!document.body) return;
        if (des) { des.host = host || des.host; return; }
        stopPick();
        des = { host: host || null, hoverEl: null, selEl: null, sel: "", entry: null, anchor: null, stack: [], tab: "map", confirmClear: false, confirm: "" };
        des.style = document.createElement("style");
        des.style.setAttribute("data-mooncore-ui", "design-css");
        if (NONCE) des.style.setAttribute("nonce", NONCE);
        des.style.textContent = DES_CSS;
        headEl().appendChild(des.style);
        var accent = "var(--vscode-focusBorder, #89b4fa)";
        des.hoverBox = uiBox({ border: "1px dashed " + accent, borderRadius: "3px", display: "none" });
        des.selBox = uiBox({ border: "2px solid " + accent, background: "color-mix(in srgb, " + accent + " 12%, transparent)", borderRadius: "3px", display: "none" });
        des.tip = uiBox({
            padding: "2px 7px", borderRadius: "5px", font: "11px/1.4 var(--vscode-font-family, sans-serif)",
            background: "var(--vscode-editorWidget-background, #1e1e2e)", color: "var(--vscode-editorWidget-foreground, #cdd6f4)",
            border: "1px solid " + accent, whiteSpace: "nowrap", display: "none",
        });
        des.bar = h("div");
        des.bar.setAttribute("data-mooncore-ui", "design-bar");
        des.bar.title = "Тяни за ручки рамки — размер и масштаб. Shift+клик — добавить элемент к выбранным. Стрелка вверх — родитель, Delete — скрыть, Ctrl+Z — отменить, Esc — выйти.";
        des.bar.appendChild(h("span", null, "Конструктор: клик — выбрать, Alt+клик — обычный клик"));
        des.bar.appendChild(histButtons());
        des.bar.appendChild(showHiddenButton());
        des.bar.appendChild(compareButton());
        des.bar.appendChild(btnPlain("Готово", stopDesign));
        document.body.appendChild(des.bar);
        des.panel = h("div");
        des.panel.setAttribute("data-mooncore-ui", "design");
        des.panel.setAttribute("role", "dialog");
        des.panel.setAttribute("aria-label", "Конструктор Moon Core");
        document.body.appendChild(des.panel);
        restorePanel();
        makeHandles();
        window.addEventListener("mousemove", onDesMove, true);
        window.addEventListener("keydown", onDesKey, true);
        DES_EVENTS.forEach(function (ev) { window.addEventListener(ev, onDesClick, true); });
        des.timer = setInterval(drawDesign, 150);
        renderPanel(true);
    }
    function btnPlain(text, fn) {
        var b = h("button", null, text); b.type = "button";
        b.addEventListener("click", function (e) { e.preventDefault(); fn(); });
        return b;
    }

    function stopDesign() {
        if (!des) return;
        setCompare(false);
        clearHighlight();
        flushOps();
        clearInterval(des.timer);
        window.removeEventListener("mousemove", onDesMove, true);
        window.removeEventListener("keydown", onDesKey, true);
        DES_EVENTS.forEach(function (ev) { window.removeEventListener(ev, onDesClick, true); });
        ["hoverBox", "selBox", "tip", "bar", "panel", "style", "marker"].forEach(function (k) { if (des[k]) { try { des[k].remove(); } catch (e) {} } });
        Object.keys(des.handles || {}).forEach(function (k) { try { des.handles[k].remove(); } catch (e) {} });
        des = null;
    }

    function onDesMove(e) {
        if (!des) return;
        if (des.dragging) return;
        if (isOurUi(e.target)) { des.hoverEl = null; drawDesign(); return; }
        if (e.target && e.target.nodeType === 1) des.hoverEl = e.target;
        drawDesign();
    }
    function onDesClick(e) {
        if (!des || isOurUi(e.target) || e.altKey) return;
        // Идёт перетаскивание ручки: её mouseup тоже слушает window — не глушим соседние обработчики.
        if (des.dragging) { e.preventDefault(); e.stopPropagation(); return; }
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        // Клик, которым закончилось перетаскивание ручки, — не выбор нового элемента.
        if (des.suppressClick) { if (e.type === "click") des.suppressClick = false; return; }
        if (e.type === "click" && e.target && e.target.nodeType === 1) { if (e.shiftKey && des.sel) addToSelection(e.target); else selectEl(e.target); }
    }
    function onDesKey(e) {
        if (!des) return;
        if (e.key !== "Escape") {
            // В полях панели клавиши — для текста; Alt оставлен самому VS Code.
            if (e.altKey || (isOurUi(e.target) && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName))) return;
            var act = designHotkey(e);
            if (act) { e.preventDefault(); e.stopPropagation(); act(); }
            return;
        }
        if (isOurUi(e.target) && /^(INPUT|SELECT)$/.test(e.target.tagName)) { e.target.blur(); e.preventDefault(); e.stopPropagation(); return; }
        e.preventDefault(); e.stopPropagation();
        if (des.selEl || des.sel) { des.selEl = null; des.sel = ""; des.entry = null; renderPanel(true); drawDesign(); }
        else stopDesign();
    }

    function placeBox(box, el) {
        if (!el || !el.isConnected) { box.style.display = "none"; return null; }
        var r = el.getBoundingClientRect();
        if (!r.width && !r.height) { box.style.display = "none"; return null; }
        Object.assign(box.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
        return r;
    }
    function drawDesign() {
        if (!des) return;
        var hv = des.hoverEl && des.hoverEl !== des.selEl && !des.compare && !des.dragging ? des.hoverEl : null;
        var r = placeBox(des.hoverBox, hv);
        if (r) {
            var c = catalogFor(hv);
            des.tip.textContent = c ? c.entry.label : labelFor(hv);
            var ty = r.top - 22 >= 0 ? r.top - 22 : r.bottom + 4;
            Object.assign(des.tip.style, { display: "block", left: Math.max(4, Math.min(r.left, window.innerWidth - 260)) + "px", top: ty + "px" });
        } else if (!des.dragging) des.tip.style.display = "none";
        var sr = des.compare ? placeBox(des.selBox, null) : placeBox(des.selBox, des.selEl);
        drawHandles(sr);
        if (des.hl && des.hl.length) drawHighlight();
    }

    function selectEl(el) {
        var c = catalogFor(el);
        des.selEl = el;
        des.multi = 1;
        des.entry = c ? c.entry : null;
        des.anchor = c ? c.anchor : null;
        // Однотипные элементы (many): по умолчанию — именно этот, «все такие» — кнопкой.
        des.sel = c && c.anchor === el && !c.entry.many ? c.entry.selector : selectorFor(el);
        des.tab = "el";
        des.confirmClear = false;
        renderPanel(true);
        placePanel();
        drawDesign();
    }
    /** Панель не должна закрывать выбранный элемент: перетащенную не трогаем, иначе — на другую сторону. */
    function placePanel() {
        if (!des || !des.panel || des.dragged || !des.selEl) return;
        var r = des.selEl.getBoundingClientRect();
        var pw = des.panel.offsetWidth || 340;
        var coversRight = r.right > window.innerWidth - pw - 24;
        var coversLeft = r.left < pw + 24;
        var left = coversRight && !coversLeft;
        des.panel.style.left = left ? "12px" : "auto";
        des.panel.style.right = left ? "auto" : "12px";
    }
    function makeDraggable(handle) {
        handle.style.cursor = "move";
        handle.addEventListener("dblclick", function (e) { if (!e.target.closest("button")) resetPanelPlace(); });
        handle.addEventListener("mousedown", function (e) {
            if (e.target.closest("button")) return;
            e.preventDefault();
            var p = des.panel, r = p.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
            var move = function (ev) {
                des.dragged = true;
                p.style.right = "auto";
                p.style.left = Math.max(0, Math.min(window.innerWidth - r.width, ev.clientX - dx)) + "px";
                p.style.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy)) + "px";
            };
            var up = function () {
                window.removeEventListener("mousemove", move, true); window.removeEventListener("mouseup", up, true);
                if (des && des.dragged) { var q = p.getBoundingClientRect(); rememberPanel({ left: q.left, top: q.top }); }
            };
            window.addEventListener("mousemove", move, true);
            window.addEventListener("mouseup", up, true);
        });
    }
    function selectParent() {
        if (!des || !des.selEl) return;
        var p = des.selEl.parentElement;
        if (!p || p === document.body || p === document.documentElement) return;
        des.stack.push(des.selEl);
        var keep = des.stack;
        selectEl(p);
        des.stack = keep;
    }
    function selectChild() {
        if (!des || !des.stack.length) return;
        var keep = des.stack, c = keep.pop();
        selectEl(c);
        des.stack = keep;
    }
