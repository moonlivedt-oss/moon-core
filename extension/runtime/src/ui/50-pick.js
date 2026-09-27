    // ---------------------------------------------------------------------------
    //  Пипетка.
    // ---------------------------------------------------------------------------
    var pick = null;   // {host, cur, stack, frozen, box, tip, hint, menu, input, countEl, x, y}
    var PICK_EVENTS = ["mousedown", "mouseup", "click", "dblclick", "auxclick", "pointerdown", "pointerup", "contextmenu"];

    function uiBox(style) {
        var d = document.createElement("div");
        d.setAttribute("data-mooncore-ui", "pick");
        Object.assign(d.style, { position: "fixed", zIndex: String(Z), pointerEvents: "none", boxSizing: "border-box" }, style);
        document.body.appendChild(d);
        return d;
    }

    function startPick(host) {
        if (!document.body) return;
        if (pick) { pick.host = host || pick.host; return; }
        if (des) stopDesign();
        var accent = "var(--vscode-focusBorder, #89b4fa)";
        pick = { host: host || null, cur: null, stack: [], frozen: false, x: 0, y: 0 };
        pick.box = uiBox({ border: "2px solid " + accent, background: "color-mix(in srgb, " + accent + " 14%, transparent)", borderRadius: "3px", display: "none" });
        pick.tip = uiBox({
            padding: "3px 8px", borderRadius: "5px", font: "11px/1.4 var(--vscode-editor-font-family, monospace)",
            background: "var(--vscode-editorWidget-background, #1e1e2e)", color: "var(--vscode-editorWidget-foreground, #cdd6f4)",
            border: "1px solid " + accent, maxWidth: "60vw", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "none",
        });
        pick.hint = uiBox({
            bottom: "30px", left: "50%", transform: "translateX(-50%)", padding: "5px 12px", borderRadius: "6px",
            font: "12px/1.4 var(--vscode-font-family, sans-serif)", background: accent, color: "var(--vscode-button-foreground, #11111b)",
        });
        pick.hint.textContent = "Пипетка: клик — выбрать, колесо — родитель / потомок, Esc — выход";
        window.addEventListener("mousemove", onPickMove, true);
        window.addEventListener("wheel", onPickWheel, { capture: true, passive: false });
        window.addEventListener("keydown", onPickKey, true);
        PICK_EVENTS.forEach(function (ev) { window.addEventListener(ev, onPickClick, true); });
    }

    function stopPick() {
        if (!pick) return;
        window.removeEventListener("mousemove", onPickMove, true);
        window.removeEventListener("wheel", onPickWheel, { capture: true, passive: false });
        window.removeEventListener("keydown", onPickKey, true);
        PICK_EVENTS.forEach(function (ev) { window.removeEventListener(ev, onPickClick, true); });
        ["box", "tip", "hint", "menu"].forEach(function (k) { if (pick[k]) { try { pick[k].remove(); } catch (e) {} } });
        pick = null;
    }

    function onPickMove(e) {
        if (!pick || pick.frozen || isOurUi(e.target)) return;
        pick.x = e.clientX; pick.y = e.clientY;
        if (e.target !== pick.cur && e.target && e.target.nodeType === 1) { pick.cur = e.target; pick.stack = []; drawPick(); }
    }
    function onPickWheel(e) {
        if (!pick || !pick.cur || isOurUi(e.target)) return;
        e.preventDefault(); e.stopPropagation();
        // Один щелчок колеса даёт пачку событий — шагаем не чаще раза в 120 мс.
        var now = Date.now();
        if (now - (pick.wheelAt || 0) < 120) return;
        pick.wheelAt = now;
        if (e.deltaY < 0) {
            var p = pick.cur.parentElement;
            if (p && p !== document.documentElement && p !== document.body) { pick.stack.push(pick.cur); pick.cur = p; }
        } else if (pick.stack.length) pick.cur = pick.stack.pop();
        drawPick();
        if (pick.frozen && pick.input) { pick.input.value = selectorFor(pick.cur); updateCount(); }
    }
    function onPickKey(e) {
        if (!pick) return;
        if (e.key === "Escape") {
            e.preventDefault(); e.stopPropagation();
            if (pick.frozen) unfreeze(); else stopPick();
        } else if (e.key === "Enter" && pick.frozen) {
            e.preventDefault(); e.stopPropagation();
            doAction("style");
        }
    }
    function onPickClick(e) {
        if (!pick || isOurUi(e.target)) return;
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        if (e.type !== "click") return;
        if (pick.frozen) { unfreeze(); onPickMove(e); return; }
        if (pick.cur) freeze(e.clientX, e.clientY);
    }

    function drawPick() {
        if (!pick || !pick.cur) return;
        var r = pick.cur.getBoundingClientRect();
        Object.assign(pick.box.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
        pick.tip.textContent = selectorFor(pick.cur) + "   " + Math.round(r.width) + "\u00d7" + Math.round(r.height);
        pick.tip.style.display = "block";
        var ty = r.top - 24 >= 0 ? r.top - 24 : Math.min(window.innerHeight - 24, r.bottom + 4);
        Object.assign(pick.tip.style, { left: Math.max(4, Math.min(r.left, window.innerWidth - 300)) + "px", top: ty + "px" });
    }

    function button(text, fn, primary) {
        var b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        Object.assign(b.style, {
            font: "inherit", padding: "4px 10px", borderRadius: "5px", cursor: "pointer",
            border: "1px solid var(--vscode-button-border, var(--vscode-focusBorder, #89b4fa))",
            background: primary ? "var(--vscode-button-background, #89b4fa)" : "transparent",
            color: primary ? "var(--vscode-button-foreground, #11111b)" : "inherit",
        });
        b.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); fn(); });
        return b;
    }

    function freeze(x, y) {
        pick.frozen = true;
        pick.hint.textContent = "Колесо — родитель / потомок, Enter — стиль, Esc — назад";
        var m = document.createElement("div");
        m.setAttribute("data-mooncore-ui", "menu");
        Object.assign(m.style, {
            position: "fixed", zIndex: String(Z + 1), width: "360px", padding: "10px", borderRadius: "8px",
            font: "12px/1.4 var(--vscode-font-family, sans-serif)", boxShadow: "0 10px 32px rgba(0,0,0,.4)",
            background: "var(--vscode-editorWidget-background, #1e1e2e)", color: "var(--vscode-editorWidget-foreground, #cdd6f4)",
            border: "1px solid var(--vscode-focusBorder, #89b4fa)", display: "flex", flexDirection: "column", gap: "8px",
        });
        var input = document.createElement("input");
        input.type = "text";
        input.spellcheck = false;
        input.value = selectorFor(pick.cur);
        Object.assign(input.style, {
            font: "12px var(--vscode-editor-font-family, monospace)", padding: "5px 7px", borderRadius: "4px", width: "100%", boxSizing: "border-box",
            background: "var(--vscode-input-background, #11111b)", color: "var(--vscode-input-foreground, #cdd6f4)",
            border: "1px solid var(--vscode-input-border, #45475a)", outline: "none",
        });
        var countEl = document.createElement("div");
        countEl.style.opacity = "0.75";
        var row = document.createElement("div");
        Object.assign(row.style, { display: "flex", gap: "6px", flexWrap: "wrap" });
        row.appendChild(button("Стиль в CSS", function () { doAction("style"); }, true));
        row.appendChild(button("Скрыть", function () { doAction("hide"); }));
        row.appendChild(button("Копировать", function () { doAction("copy"); }));
        row.appendChild(button("Отмена", function () { stopPick(); }));
        m.appendChild(input); m.appendChild(countEl); m.appendChild(row);
        document.body.appendChild(m);
        var left = Math.min(Math.max(8, x + 12), window.innerWidth - 372);
        var top = Math.min(Math.max(8, y + 12), window.innerHeight - 140);
        Object.assign(m.style, { left: left + "px", top: top + "px" });
        pick.menu = m; pick.input = input; pick.countEl = countEl;
        input.addEventListener("input", updateCount);
        input.addEventListener("keydown", function (e) {
            if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); doAction("style"); }
            else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); unfreeze(); }
        });
        updateCount();
        setTimeout(function () { try { input.focus(); input.select(); } catch (e) {} }, 0);
    }

    function updateCount() {
        if (!pick || !pick.countEl) return;
        var n = count(pick.input.value.trim());
        pick.countEl.textContent = n === Infinity ? "селектор с ошибкой" : "совпадений: " + n + (n > 1 ? " (правило коснётся всех)" : "");
        pick.countEl.style.color = n === Infinity || n === 0 ? "var(--vscode-errorForeground, #f38ba8)" : "";
    }

    function unfreeze() {
        if (!pick) return;
        pick.frozen = false;
        if (pick.menu) pick.menu.remove();
        pick.menu = pick.input = pick.countEl = null;
        pick.hint.textContent = "Пипетка: клик — выбрать, колесо — родитель / потомок, Esc — выход";
    }

    function doAction(action) {
        if (!pick || !pick.cur) return;
        var sel = (pick.input ? pick.input.value : selectorFor(pick.cur)).trim();
        if (!sel || count(sel) === Infinity) { toast("Селектор с ошибкой"); return; }
        var el = pick.cur, host = pick.host;
        var fp = null;
        try { fp = action === "hide" ? fingerprint(el, sel) : null; } catch (e) {}
        var payload = { selector: sel, action: action, info: { label: labelFor(el), style: styleHint(el) }, fp: fp };
        stopPick();
        // Сразу видно результат «Скрыть», не дожидаясь, пока расширение запишет файл.
        rpcFirst("picked", payload, host).then(function (r) {
            if (!r || !r.ok) toast("Moon Core: " + ((r && r.error) || "расширение не ответило"));
        });
    }
