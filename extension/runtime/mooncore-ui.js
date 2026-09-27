// ============================================================
//  Moon Core — интерфейс окна: конструктор и пипетка. Чанк для ленивой загрузки.
//  СОБРАН из runtime/src/ui/*.js (node scripts/build-runtime.js) — правь исходники, не этот файл.
//  Сам по себе не запускается: его вычисляет прямым eval загрузчик в mooncore-core.js
//  (runtime/src/65-ui-loader.js), поэтому код видит переменные рантайма.
// ============================================================
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

    // ---- стили интерфейса конструктора
    var DES_CSS = [
        "[data-mooncore-ui=design]{position:fixed;right:12px;top:44px;width:340px;max-height:calc(100vh - 110px);overflow:auto;z-index:" + (Z + 2) + ";",
        "  box-sizing:border-box;padding:0 0 10px;border-radius:10px;font:12px/1.45 var(--vscode-font-family,sans-serif);",
        "  background:var(--vscode-editorWidget-background,#1e1e2e);color:var(--vscode-editorWidget-foreground,#cdd6f4);",
        "  border:1px solid var(--vscode-focusBorder,#89b4fa);box-shadow:0 12px 40px rgba(0,0,0,.45);}",
        "[data-mooncore-ui=design] *{box-sizing:border-box;}",
        "[data-mooncore-ui=design] .mc-h{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:8px;padding:10px 12px 8px;background:inherit;border-bottom:1px solid var(--vscode-widget-border,#313244);}",
        "[data-mooncore-ui=design] .mc-title{flex:1;font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
        "[data-mooncore-ui=design] .mc-tabs{display:flex;gap:4px;padding:8px 12px 0;}",
        "[data-mooncore-ui=design] .mc-tab{flex:1;padding:5px 0;border-radius:6px;border:1px solid transparent;background:none;color:inherit;font:inherit;cursor:pointer;opacity:.75;}",
        "[data-mooncore-ui=design] .mc-tab.on{opacity:1;border-color:var(--vscode-focusBorder,#89b4fa);background:color-mix(in srgb,var(--vscode-focusBorder,#89b4fa) 14%,transparent);}",
        "[data-mooncore-ui=design] .mc-sec{margin:10px 12px 0;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--vscode-foreground,#cdd6f4) 5%,transparent);}",
        "[data-mooncore-ui=design] .mc-sec h4{margin:0 0 6px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;opacity:.7;}",
        "[data-mooncore-ui=design] .mc-note{font-size:11px;opacity:.65;margin:2px 0 6px;}",
        "[data-mooncore-ui=design] .mc-row{display:flex;align-items:center;gap:6px;min-height:26px;}",
        "[data-mooncore-ui=design] .mc-row>label{flex:0 0 118px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
        "[data-mooncore-ui=design] .mc-row.set>label{color:var(--vscode-textLink-foreground,#89b4fa);}",
        "[data-mooncore-ui=design] .mc-ctl{flex:1;display:flex;align-items:center;gap:6px;min-width:0;}",
        "[data-mooncore-ui=design] input[type=range]{flex:1;min-width:0;accent-color:var(--vscode-focusBorder,#89b4fa);}",
        "[data-mooncore-ui=design] input[type=number],[data-mooncore-ui=design] input[type=text],[data-mooncore-ui=design] select{font:inherit;color:var(--vscode-input-foreground,#cdd6f4);background:var(--vscode-input-background,#11111b);border:1px solid var(--vscode-input-border,#45475a);border-radius:4px;padding:2px 5px;min-width:0;}",
        "[data-mooncore-ui=design] input[type=number]{width:58px;flex:0 0 58px;}",
        "[data-mooncore-ui=design] input[type=text],[data-mooncore-ui=design] select{flex:1;}",
        "[data-mooncore-ui=design] input[type=color]{width:34px;height:22px;padding:0;border:1px solid var(--vscode-input-border,#45475a);border-radius:4px;background:none;}",
        "[data-mooncore-ui=design] input[type=checkbox]{accent-color:var(--vscode-focusBorder,#89b4fa);}",
        "[data-mooncore-ui=design] .mc-x{flex:0 0 auto;width:20px;height:20px;border:none;border-radius:4px;background:none;color:inherit;opacity:.6;cursor:pointer;font:inherit;}",
        "[data-mooncore-ui=design] .mc-x:hover{opacity:1;background:color-mix(in srgb,var(--vscode-foreground,#cdd6f4) 12%,transparent);}",
        "[data-mooncore-ui=design] .mc-x.hid{visibility:hidden;}",
        "[data-mooncore-ui=design] .mc-btn{font:inherit;padding:4px 10px;border-radius:5px;cursor:pointer;color:inherit;background:transparent;border:1px solid var(--vscode-button-border,var(--vscode-focusBorder,#89b4fa));}",
        "[data-mooncore-ui=design] .mc-btn.pri{background:var(--vscode-button-background,#89b4fa);color:var(--vscode-button-foreground,#11111b);}",
        "[data-mooncore-ui=design] .mc-btn.danger{border-color:var(--vscode-errorForeground,#f38ba8);color:var(--vscode-errorForeground,#f38ba8);}",
        "[data-mooncore-ui=design] .mc-btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;}",
        "[data-mooncore-ui=design] .mc-sel{width:100%;font:11px var(--vscode-editor-font-family,monospace)!important;}",
        "[data-mooncore-ui=design] .mc-count{font-size:11px;opacity:.7;}",
        "[data-mooncore-ui=design] .mc-alt{margin-top:6px;}",
        "[data-mooncore-ui=design] .mc-drag{cursor:grab;opacity:.45;padding:0 2px;user-select:none;}",
        "[data-mooncore-ui=design] .mc-map:hover .mc-drag{opacity:.9;}",
        "[data-mooncore-ui=design] .mc-map.drop-before{box-shadow:inset 0 2px 0 var(--vscode-focusBorder,#89b4fa);}",
        "[data-mooncore-ui=design] .mc-map.drop-after{box-shadow:inset 0 -2px 0 var(--vscode-focusBorder,#89b4fa);}",
        "[data-mooncore-ui=design] .mc-count.bad{color:var(--vscode-errorForeground,#f38ba8);opacity:1;}",
        "[data-mooncore-ui=design] details>summary{cursor:pointer;opacity:.8;margin:2px 0 6px;}",
        "[data-mooncore-ui=design] .mc-card{margin:8px 12px 0;padding:8px 10px;border-radius:8px;border:1px solid var(--vscode-widget-border,#313244);}",
        "[data-mooncore-ui=design] .mc-card .mc-cap{font-weight:600;}",
        "[data-mooncore-ui=design] .mc-card code{display:block;font:10.5px var(--vscode-editor-font-family,monospace);opacity:.6;word-break:break-all;margin:2px 0 4px;}",
        "[data-mooncore-ui=design] .mc-line{display:flex;align-items:center;gap:6px;min-height:22px;}",
        "[data-mooncore-ui=design] .mc-line span{flex:1;}",
        "[data-mooncore-ui=design] .mc-empty{margin:14px 12px 4px;opacity:.7;}",
        "[data-mooncore-ui=design] .mc-tab{font-size:11.5px;}",
        "[data-mooncore-ui=design] .mc-pad{margin:10px 12px 0;}",
        "[data-mooncore-ui=design] .mc-map{display:flex;align-items:center;gap:7px;min-height:26px;}",
        "[data-mooncore-ui=design] .mc-map-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
        "[data-mooncore-ui=design] .mc-map-name small{opacity:.55;}",
        "[data-mooncore-ui=design] .mc-map.off .mc-map-name{opacity:.55;}",
        "[data-mooncore-ui=design] .mc-map.hidden-el .mc-map-name{text-decoration:line-through;opacity:.6;}",
        "[data-mooncore-ui=design] .mc-btn.mc-mini{padding:1px 8px;font-size:11px;opacity:.8;}",
        "[data-mooncore-ui=design] .mc-map:not(:hover) .mc-mini{opacity:.35;}",
        "[data-mooncore-ui=design] .mc-list{margin:0 0 4px 22px;padding-left:8px;border-left:1px solid var(--vscode-widget-border,#313244);}",
        "[data-mooncore-ui=design] .mc-sub{min-height:22px;font-size:11.5px;}",
        "[data-mooncore-ui=design] .mc-prof{margin-top:8px;padding:8px 10px;border-radius:8px;border:1px solid var(--vscode-widget-border,#313244);}",
        "[data-mooncore-ui=design] .mc-prof.on{border-color:var(--vscode-focusBorder,#89b4fa);}",
        "[data-mooncore-ui=design] .mc-prof-h{display:flex;align-items:center;gap:8px;}",
        "[data-mooncore-ui=design] .mc-prof-h small{opacity:.6;}",
        "[data-mooncore-ui=design] .mc-prof-h .mc-now{opacity:1;color:var(--vscode-textLink-foreground,#89b4fa);}",
        "[data-mooncore-ui=design-bar]{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);z-index:" + (Z + 2) + ";display:flex;align-items:center;gap:10px;",
        "  padding:6px 8px 6px 14px;border-radius:8px;font:12px/1.4 var(--vscode-font-family,sans-serif);",
        "  background:var(--vscode-focusBorder,#89b4fa);color:var(--vscode-button-foreground,#11111b);box-shadow:0 6px 24px rgba(0,0,0,.35);}",
        "[data-mooncore-ui=design-bar] button{font:inherit;padding:3px 10px;border-radius:5px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;white-space:nowrap;}",
        "[data-mooncore-ui=design-bar]{max-width:calc(100vw - 24px);box-sizing:border-box;}",
    ].join("\n");

    function h(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }
    function btn(text, cls, fn, title) {
        var b = h("button", "mc-btn" + (cls ? " " + cls : ""), text);
        b.type = "button";
        if (title) b.title = title;
        b.addEventListener("click", function (e) { e.preventDefault(); fn(e); });
        return b;
    }
    function xBtn(visible, fn, title) {
        var b = h("button", "mc-x" + (visible ? "" : " hid"), "×");
        b.type = "button";
        b.title = title || "Вернуть как было";
        b.addEventListener("click", function (e) { e.preventDefault(); fn(); });
        return b;
    }

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
        des.bar.appendChild(h("span", null, "Конструктор: клик — выбрать, тяни за ручки рамки, Alt+клик — обычный клик"));
        des.bar.appendChild(compareButton());
        des.bar.appendChild(btnPlain("Готово", stopDesign));
        document.body.appendChild(des.bar);
        des.panel = h("div");
        des.panel.setAttribute("data-mooncore-ui", "design");
        document.body.appendChild(des.panel);
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
        if (e.type === "click" && e.target && e.target.nodeType === 1) selectEl(e.target);
    }
    function onDesKey(e) {
        if (!des || e.key !== "Escape") return;
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
            var up = function () { window.removeEventListener("mousemove", move, true); window.removeEventListener("mouseup", up, true); };
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
        head.appendChild(h("div", "mc-title", des.entry && des.anchor === des.selEl ? des.entry.label : des.selEl ? labelFor(des.selEl) : "Конструктор"));
        head.appendChild(xBtn(true, stopDesign, "Закрыть конструктор"));
        head.title = "Перетащи, чтобы подвинуть панель";
        makeDraggable(head);
        des.panel.appendChild(head);
        var n = changesCount();
        var tabs = h("div", "mc-tabs");
        [["map", "Карта"], ["el", "Элемент"], ["changes", "Правки" + (n ? " " + n : "")], ["profiles", "Профили"], ["more", "Ещё"]].forEach(function (t) {
            var b = h("button", "mc-tab" + (des.tab === t[0] ? " on" : ""), t[1]);
            b.type = "button";
            b.addEventListener("click", function () { des.tab = t[0]; des.confirmClear = false; des.confirm = ""; renderPanel(true); });
            tabs.appendChild(b);
        });
        des.panel.appendChild(tabs);
        if (des.tab === "changes") renderChanges();
        else if (des.tab === "map") renderMap();
        else if (des.tab === "profiles") renderProfiles();
        else if (des.tab === "more") renderMore();
        else renderElement();
        des.panel.scrollTop = scroll;
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
            var k = count(inp.value.trim());
            cnt.textContent = k === Infinity ? "селектор с ошибкой" : k === 0 ? "сейчас ничего не находит" : "совпадений: " + k + (k > 1 ? " — правка коснётся всех" : "");
            cnt.className = "mc-count" + (k === Infinity || k === 0 ? " bad" : "");
        };
        inp.addEventListener("input", upd);
        inp.addEventListener("change", function () {
            var v = inp.value.trim();
            if (v && count(v) !== Infinity) { des.sel = v; renderPanel(true); }
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
        if (nav.childNodes.length) tgt.appendChild(nav);
        orderSection();
        condSection();
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
        if (DS.rules[sel]) {
            var foot = h("div", "mc-btns"); foot.style.margin = "10px 12px 0";
            foot.appendChild(btn("Сбросить этот элемент", "danger", function () { resetRule(sel); renderPanel(true); }));
            des.panel.appendChild(foot);
        }
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
        }
        row.appendChild(xBtn(!!rec, function () { undoSetting(s.key); flushOps(); renderPanel(true); }, rec ? "Вернуть: " + fmtVal(rec.hadPrev ? rec.prev : undefined) : ""));
        return row;
    }

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

    // ---- профили вида
    function renderProfiles() {
        var PR = PROFILES || { list: [], active: "", dirty: false };
        var n = changesCount();
        des.panel.appendChild(h("div", "mc-note mc-pad", "Профиль — снимок всех правок: элементы и настройки VS Code. Применение заменяет текущие правки. «Исходный вид» возвращает VS Code таким, каким он был до Moon Core."));
        var now = section("Сейчас");
        now.appendChild(h("div", null, PR.active ? "Профиль «" + PR.active + "»" + (PR.dirty ? " — изменён после применения" : "") : n ? "Свои правки без профиля (" + n + ")" : "Исходный вид VS Code"));
        if (PR.active && PR.dirty) now.appendChild(h("div", "mc-note", "Сохрани изменения, иначе при переключении профиля они пропадут."));

        var save = section("Сохранить текущий вид");
        var line = h("div", "mc-row");
        var inp = h("input"); inp.type = "text"; inp.placeholder = "Имя профиля"; inp.maxLength = 40;
        inp.value = PR.active && !isBuiltin(PR.active) ? PR.active : "";
        line.appendChild(inp);
        var doSave = function () {
            var name = inp.value.trim();
            if (!name) { toast("Введи имя профиля"); return; }
            if (isBuiltin(name)) { toast("«" + name + "» — встроенный профиль, выбери другое имя"); return; }
            profileOp({ op: "saveProfile", name: name, modules: collectModuleProfile() }, "Сохранено: «" + name + "»");
        };
        inp.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); doSave(); } });
        line.appendChild(btn("Сохранить", "pri", doSave));
        save.appendChild(line);
        if (!n) save.appendChild(h("div", "mc-note", "Правок пока нет — профиль будет равен исходному виду."));

        var listSec = section("Профили");
        listSec.appendChild(profileCard("", "Исходный вид VS Code", "Без правок Moon Core: всё как до установки", false, !PR.active && !n));
        PR.list.forEach(function (p) {
            var desc = p.note || ("элементов: " + p.rules + ", настроек: " + p.settings);
            // Профиль несёт и состояние модулей (например, фон MoonLight BG) — пусть это будет видно.
            var mods = Array.isArray(p.modules) ? p.modules.filter(function (id) { return MODS[id]; }).map(function (id) { return MODS[id].name; }) : [];
            if (mods.length) desc += " + " + mods.join(", ");
            listSec.appendChild(profileCard(p.name, p.name, desc, !p.builtin, PR.active === p.name, p.builtin));
        });
    }
    function isBuiltin(name) { return !!(PROFILES && PROFILES.list.some(function (p) { return p.builtin && p.name === name; })); }

    function profileCard(name, title, desc, deletable, active, builtin) {
        var card = h("div", "mc-prof" + (active ? " on" : ""));
        var head = h("div", "mc-prof-h");
        head.appendChild(h("span", "mc-cap", title));
        if (builtin) head.appendChild(h("small", null, "встроенный"));
        if (active) head.appendChild(h("small", "mc-now", "сейчас"));
        card.appendChild(head);
        card.appendChild(h("div", "mc-note", desc));
        var bs = h("div", "mc-btns");
        var key = "apply:" + name;
        var needConfirm = changesCount() > 0 && !(active && !(PROFILES && PROFILES.dirty));
        if (!(active && !(PROFILES && PROFILES.dirty))) bs.appendChild(btn(des.confirm === key ? "Заменить текущие правки?" : "Применить", "pri", function () {
            if (needConfirm && des.confirm !== key) { des.confirm = key; renderPanel(true); return; }
            des.confirm = "";
            profileOp(name ? { op: "applyProfile", name: name } : { op: "clearAll" }, name ? "Профиль «" + name + "»" : "Исходный вид VS Code");
        }));
        if (deletable && active && PROFILES && PROFILES.dirty) {
            bs.appendChild(btn("Обновить", "", function () { profileOp({ op: "saveProfile", name: name, modules: collectModuleProfile() }, "Профиль «" + name + "» обновлён"); }, "Записать текущие правки в этот профиль"));
        }
        if (deletable) {
            var dk = "del:" + name;
            bs.appendChild(btn(des.confirm === dk ? "Точно удалить?" : "Удалить", "danger", function () {
                if (des.confirm !== dk) { des.confirm = dk; renderPanel(true); return; }
                des.confirm = "";
                profileOp({ op: "deleteProfile", name: name }, "Профиль «" + name + "» удалён");
            }));
        }
        card.appendChild(bs);
        return card;
    }

    /** Операция с профилем: сразу на хост, по ответу — новое состояние (правила, настройки, список). */
    function profileOp(op, done) {
        flushOps();
        var seq = ++flushSeq;
        rpcFirst("design", { ops: [op] }, des && des.host).then(function (r) {
            if (!r || r.ok === false) { toast("Moon Core: " + ((r && r.error) || "расширение не ответило")); }
            else if (done) toast(done);
            if (r && r.design && seq === flushSeq) {
                DS = toDS(r.design);
                if (r.settingsNow) SETNOW = r.settingsNow;
                if (r.profiles) PROFILES = r.profiles;
                localEditAt = 0;
                clearColorPreview();
                afterDS();
            }
            if (des) renderPanel(true);
        });
    }

    /** Сколько всего правок: правила, настройки, цвета темы, кнопки, эффекты. */
    function changesCount() {
        return Object.keys(DS.rules).length + Object.keys(DS.settings).length + Object.keys(DS.colors || {}).length +
            (DS.buttons || []).length + Object.keys(DS.fx || {}).length;
    }
    function renderChanges() {
        var sels = Object.keys(DS.rules).sort(function (a, b) { return (DS.rules[b].ts || 0) - (DS.rules[a].ts || 0); });
        var keys = Object.keys(DS.settings);
        if (!changesCount()) {
            des.panel.appendChild(h("div", "mc-empty", "Изменений пока нет. Выбери элемент во вкладке «Элемент»."));
            return;
        }
        var ckeys = Object.keys(DS.colors || {});
        if (ckeys.length) {
            var cc = h("div", "mc-card");
            cc.appendChild(h("div", "mc-cap", "Цвета темы"));
            ckeys.forEach(function (k) {
                var rec = DS.colors[k];
                var line = h("div", "mc-line");
                var sw = h("span", null, "");
                var dot = h("span"); Object.assign(dot.style, { display: "inline-block", width: "10px", height: "10px", borderRadius: "2px", marginRight: "6px", background: rec.value, verticalAlign: "-1px" });
                sw.appendChild(dot);
                sw.appendChild(document.createTextNode((k.indexOf("tk:") === 0 ? "код: " : "") + k.slice(3) + "  " + rec.value + "  (было: " + (rec.hadPrev ? rec.prev : "из темы") + ")"));
                line.appendChild(sw);
                line.appendChild(xBtn(true, function () { setColor(k, null, rec.label, k.indexOf("wb:") === 0 ? k.slice(3).replace(/\./g, "-") : ""); flushOps(); renderPanel(true); }));
                cc.appendChild(line);
            });
            des.panel.appendChild(cc);
        }
        if ((DS.buttons || []).length || Object.keys(DS.fx || {}).length) {
            var mc = h("div", "mc-card");
            mc.appendChild(h("div", "mc-cap", "Кнопки и эффекты"));
            mc.appendChild(h("div", "mc-note", "Своих кнопок: " + (DS.buttons || []).length + ", эффектов: " + Object.keys(DS.fx || {}).filter(function (k) { return DS.fx[k] === true; }).length));
            var mb = h("div", "mc-btns");
            mb.appendChild(btn("Открыть «Ещё»", "", function () { des.tab = "more"; renderPanel(true); }));
            mc.appendChild(mb);
            des.panel.appendChild(mc);
        }
        if (keys.length) {
            var card = h("div", "mc-card");
            card.appendChild(h("div", "mc-cap", "Настройки VS Code"));
            keys.forEach(function (k) {
                var rec = DS.settings[k];
                var line = h("div", "mc-line");
                line.appendChild(h("span", null, (rec.label || settingLabel(k)) + ": " + fmtVal(rec.value) + "  (было: " + fmtVal(rec.hadPrev ? rec.prev : undefined) + ")"));
                line.appendChild(xBtn(true, function () { undoSetting(k); flushOps(); renderPanel(true); }));
                var ksel = settingSelector(k);
                if (ksel) hoverHighlight(line, ksel, false);
                card.appendChild(line);
            });
            des.panel.appendChild(card);
        }
        sels.forEach(function (sel) {
            var r = DS.rules[sel];
            var card = h("div", "mc-card");
            card.appendChild(h("div", "mc-cap", (r.label || "элемент") + (condText(sel) ? " — " + condText(sel) : "")));
            card.appendChild(h("code", null, sel));
            // Навёл — элементы правки обведены (скрытые на это время показаны).
            hoverHighlight(card, sel, true);
            card.title = "Наведи — элементы этой правки подсвечены в окне";
            Object.keys(r.props).forEach(function (k) {
                if (!PROPS[k]) return;
                var line = h("div", "mc-line");
                var v = r.props[k];
                line.appendChild(h("span", null, PROPS[k].label + (PROPS[k].type === "flag" ? "" : ": " + cssVal(k, v))));
                line.appendChild(xBtn(true, function () { setProp(sel, k, null, r.label); renderPanel(true); }));
                card.appendChild(line);
            });
            var bs = h("div", "mc-btns");
            var target = null;
            try { target = document.querySelector(sel); } catch (e) {}
            if (target && !(r.props.hide)) bs.appendChild(btn("Выбрать", "", function () { selectEl(target); }));
            else if (!target) bs.appendChild(h("span", "mc-note", "сейчас не на экране"));
            bs.appendChild(btn("Сбросить", "danger", function () { resetRule(sel); renderPanel(true); }));
            card.appendChild(bs);
            des.panel.appendChild(card);
        });
        var foot = h("div", "mc-btns"); foot.style.margin = "12px 12px 0";
        foot.appendChild(btn(des.confirmClear ? "Точно сбросить всё?" : "Сбросить всё", "danger", function () {
            if (!des.confirmClear) { des.confirmClear = true; renderPanel(true); return; }
            des.confirmClear = false;
            DS = toDS(null);
            queueOp("clearAll", { op: "clearAll" });
            flushOps();
            renderDesignCss();
            renderPanel(true);
        }));
        des.panel.appendChild(foot);
    }

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

    // ---- секция «Когда применять» (условия правил — ядро: runtime/src/77-context.js)
    /** Секция «Когда применять» во вкладке «Элемент». */
    function condSection() {
        var cur = splitCond(des.sel), now = ctxNow();
        var opts = [["", "", "Всегда"]];
        ["lang", "branch", "folder", "theme"].forEach(function (k) {
            var v = cur.kind === k ? cur.value : now[k];
            if (v) opts.push([k, v, "Только " + COND_TITLES[k] + " «" + v + "»"]);
        });
        if (opts.length === 1) return;
        var sec = section("Когда применять", "Правки ниже сработают только в этом случае: например, миникарта спрятана лишь в markdown.");
        var s = h("select");
        opts.forEach(function (o) { var op = h("option", null, o[2]); op.value = o[0] + "|" + o[1]; s.appendChild(op); });
        s.value = cur.kind + "|" + (cur.kind ? cur.value : "");
        s.addEventListener("change", function () {
            var p = s.value.split("|"), kind = p[0], value = p.slice(1).join("|");
            des.sel = withCond(cur.base, kind, value);
            renderPanel(true);
        });
        var row = h("div", "mc-row"); row.appendChild(s);
        sec.appendChild(row);
    }

    // ---------------------------------------------------------------------------
    //  Цвета темы. Вместо CSS-правила — штатная настройка VS Code: выбранный элемент красится
    //  через workbench.colorCustomizations, код — через editor.tokenColorCustomizations. Такое
    //  переживает любые обновления и работает во всех окнах.
    //
    //  Какой цвет темы красит элемент: сначала точно — по правилам CSS VS Code, которые подходят
    //  к элементу и берут var(--vscode-...); если VS Code красит элемент прямо в style="", — по
    //  значению: переменные темы с тем же цветом, ближайшие к зоне элемента.
    // ---------------------------------------------------------------------------
    var COLOR_PROPS = [["background-color", "bg"], ["background", "bg"], ["color", "fg"], ["border-color", "border"], ["border-top-color", "border"],
        ["border-bottom-color", "border"], ["border-left-color", "border"], ["border-right-color", "border"], ["outline-color", "border"]];
    var KIND_TITLES = { bg: "Фон", fg: "Текст", border: "Рамка" };
    var themeRules = null, themeRulesAt = 0;
    var colorPreview = {};                            // token -> значение, показанное до ответа хоста

    function scanThemeRules() {
        if (themeRules && Date.now() - themeRulesAt < 60000) return themeRules;
        var out = [];
        var walk = function (rules) {
            for (var i = 0; rules && i < rules.length; i++) {
                var r = rules[i];
                if (r.cssRules && !r.selectorText) { walk(r.cssRules); continue; }
                if (!r.selectorText || !r.style) continue;
                var props = [];
                for (var j = 0; j < COLOR_PROPS.length; j++) {
                    var v = r.style.getPropertyValue(COLOR_PROPS[j][0]);
                    var m = v && /var\(--vscode-([\w-]+)/.exec(v);
                    if (m) props.push({ kind: COLOR_PROPS[j][1], token: m[1] });
                }
                if (props.length) out.push({ sel: r.selectorText, props: props });
            }
        };
        Array.prototype.forEach.call(document.styleSheets || [], function (sh) {
            if (sh.ownerNode && sh.ownerNode.getAttribute && (sh.ownerNode.getAttribute("data-mooncore") || sh.ownerNode.getAttribute("data-mooncore-ui"))) return;
            try { walk(sh.cssRules); } catch (e) {}
        });
        themeRules = out; themeRulesAt = Date.now();
        return out;
    }

    /** statusBar-background -> statusBar.background (VS Code меняет точки на дефисы только в имени переменной). */
    function tokenToId(t) { var i = t.indexOf("-"); return i === -1 ? t : t.slice(0, i) + "." + t.slice(i + 1); }

    var ZONE_HINT = { statusbar: "statusBar", activitybar: "activityBar", sidebar: "sideBar", titlebar: "titleBar", panel: "panel", editor: "editor" };

    /** Цвета темы, которые красят el: [{ kind, token, exact }]. */
    function colorTokensFor(el) {
        var out = [], seen = {};
        var push = function (kind, token, exact) {
            var k = kind + "|" + token;
            if (seen[k] || out.length >= 8) return;
            seen[k] = 1; out.push({ kind: kind, token: token, exact: exact });
        };
        var vars = themeVars();
        var rules = scanThemeRules();
        var byKind = {};
        [el, el.parentElement].forEach(function (node, depth) {
            if (!node || node.nodeType !== 1) return;
            rules.forEach(function (r) {
                var ok = false;
                try { ok = node.matches(r.sel); } catch (e) {}
                if (!ok) return;
                r.props.forEach(function (p) {
                    if (depth && p.kind !== "fg") return;           // от родителя наследуется только цвет текста
                    if (rgba(vars[p.token]) || vars[p.token] === undefined) byKind[p.kind + "|" + p.token] = p;
                });
            });
        });
        Object.keys(byKind).forEach(function (k) { push(byKind[k].kind, byKind[k].token, true); });
        // По значению — для цветов, которые VS Code ставит прямо в style="".
        var c = catalogFor(el), hint = c ? ZONE_HINT[c.entry.zone] || "" : "";
        var cs = null;
        try { cs = getComputedStyle(el); } catch (e) {}
        if (cs) [["bg", cs.backgroundColor], ["fg", cs.color]].forEach(function (p) {
            if (out.some(function (x) { return x.kind === p[0]; })) return;
            var v = rgba(p[1]);
            if (!v || v[3] === 0) return;
            var names = Object.keys(vars).filter(function (n) { return sameColor(vars[n], p[1]); });
            names.sort(function (a, b) {
                var sa = (hint && a.indexOf(hint) === 0 ? 0 : 1) + (/(background|foreground)$/i.test(a) ? 0 : 0.5);
                var sb = (hint && b.indexOf(hint) === 0 ? 0 : 1) + (/(background|foreground)$/i.test(b) ? 0 : 0.5);
                return sa - sb || a.length - b.length;
            });
            names.slice(0, 2).forEach(function (n) { push(p[0], n, false); });
        });
        return out;
    }

    function colorValueNow(key, token) {
        var rec = DS.colors && DS.colors[key];
        if (rec) return rec.value;
        var id = key.slice(3), conf = key.indexOf("tk:") === 0 ? SETNOW["editor.tokenColorCustomizations"] : SETNOW["workbench.colorCustomizations"];
        if (conf && typeof conf[id] === "string") return hex6(conf[id]);
        if (token) return hex6(themeVars()[token]);
        return "#808080";
    }

    function setColor(key, value, label, token) {
        if (!DS.colors) DS.colors = {};
        if (value === null) delete DS.colors[key];
        else DS.colors[key] = Object.assign({}, DS.colors[key] || {}, { value: value, label: label || "" });
        // Сразу видно: переменная темы на время, пока VS Code не применит настройку сам.
        if (token) {
            var wb = document.querySelector(".monaco-workbench");
            if (wb) { if (value === null) wb.style.removeProperty("--vscode-" + token); else wb.style.setProperty("--vscode-" + token, value); }
            colorPreview[token] = value;
        }
        queueOp("color|" + key, { op: "color", key: key, value: value, label: label || "" });
    }
    /** Хост ответил и VS Code перекрасил тему — предпросмотр больше не нужен. */
    function clearColorPreview() {
        var wb = document.querySelector(".monaco-workbench");
        Object.keys(colorPreview).forEach(function (t) { if (wb) wb.style.removeProperty("--vscode-" + t); });
        colorPreview = {};
    }

    function colorRow(key, title, token, label) {
        var rec = DS.colors && DS.colors[key];
        var row = h("div", "mc-row" + (rec ? " set" : ""));
        var lab = h("label", null, title);
        lab.title = key.slice(3);
        row.appendChild(lab);
        var ctl = h("div", "mc-ctl");
        var col = h("input"); col.type = "color"; col.value = colorValueNow(key, token);
        col.addEventListener("input", function () { setColor(key, col.value, label, token); row.className = "mc-row set"; });
        ctl.appendChild(col);
        ctl.appendChild(h("span", "mc-note", key.slice(3)));
        row.appendChild(ctl);
        row.appendChild(xBtn(!!rec, function () { setColor(key, null, label, token); flushOps(); renderPanel(true); }, "Вернуть цвет темы"));
        return row;
    }

    /** Секция «Цвета темы» во вкладке «Элемент». */
    function colorSection(label) {
        var el = des.selEl;
        if (des.entry && des.entry.id === "code") {
            var sc = section("Цвета кода", "Штатная настройка editor.tokenColorCustomizations — переживает обновления и смену темы-основы.");
            var names = { comments: "Комментарии", strings: "Строки", keywords: "Ключевые слова", numbers: "Числа", types: "Типы", functions: "Функции", variables: "Переменные" };
            (TOKEN_GROUPS.length ? TOKEN_GROUPS : Object.keys(names)).forEach(function (g) { sc.appendChild(colorRow("tk:" + g, names[g] || g, "", "Код: " + (names[g] || g))); });
        }
        if (!el || !el.isConnected) return;
        var list = [];
        try { list = colorTokensFor(el); } catch (e) { report("цвета темы", e); }
        if (!list.length) return;
        var sec = section("Цвета темы", "Надёжнее, чем «Фон» и «Цвет текста» ниже: пишется в настройку VS Code и меняет цвет везде, где тема его использует.");
        list.forEach(function (x) {
            var id = tokenToId(x.token);
            sec.appendChild(colorRow("wb:" + id, KIND_TITLES[x.kind] + (x.exact ? "" : " (похоже)"), x.token, label + ": " + id));
        });
    }

    // ---- свои кнопки во вкладке «Ещё»: карточки, добавление, правка (показ кнопок — ядро: runtime/src/79-buttons.js)
    var BTN_ZONE_TITLES = { "statusbar-left": "Статусбар слева", "statusbar-right": "Статусбар справа", titlebar: "Титлбар", editor: "Над редактором" };
    var ICONS = ["terminal", "play", "debug-alt", "save-all", "search", "files", "source-control", "settings-gear", "layout-sidebar-left", "layout-panel",
        "split-horizontal", "screen-full", "window", "refresh", "zap", "rocket", "star-full", "heart", "flame", "bell", "bookmark", "tools", "beaker",
        "symbol-color", "paintcan", "color-mode", "eye", "eye-closed", "globe", "cloud", "database", "server", "package", "extensions", "git-merge",
        "word-wrap", "map", "go-to-file", "new-file", "trash", "check", "circle-large-outline", "sparkle", "wand", "layout"];

    function newButtonId() { return "b" + Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 5); }
    function putButton(b) {
        DS.buttons = (DS.buttons || []).filter(function (x) { return x.id !== b.id; }).concat([b]);
        queueOp("btn|" + b.id, { op: "button", button: b });
        ensureButtons();
    }
    function removeButton(id) {
        DS.buttons = (DS.buttons || []).filter(function (x) { return x.id !== id; });
        queueOp("btn|" + id, { op: "removeButton", id: id });
        ensureButtons();
    }
    /** «Добавить кнопку»: команду выбирают в списке VS Code (там же она и разрешается). */
    function addButtonFlow() {
        toast("Выбери команду в списке VS Code сверху");
        rpcFirst("pickCommand", {}, des && des.host).then(function (r) {
            if (!r || !r.ok) { if (r && !r.cancelled) toast("Moon Core: " + (r.error || "не удалось")); return; }
            putButton({ id: newButtonId(), zone: "statusbar-right", command: r.command, icon: r.icon || "zap", label: r.icon ? "" : r.title, tooltip: r.title, order: (DS.buttons || []).length });
            flushOps();
            if (des) { des.tab = "more"; renderPanel(true); }
        });
    }

    function buttonCard(b, own) {
        var card = h("div", "mc-card");
        var head = h("div", "mc-line");
        var prev = h("span", null, "");
        if (b.icon) { var ic = h("span", "codicon codicon-" + b.icon); ic.style.marginRight = "6px"; prev.appendChild(ic); }
        prev.appendChild(document.createTextNode(b.label || b.tooltip || b.command));
        head.appendChild(prev);
        if (own) head.appendChild(xBtn(true, function () { removeButton(b.id); flushOps(); renderPanel(true); }, "Удалить кнопку"));
        card.appendChild(head);
        card.appendChild(h("code", null, b.command + (b.owner ? "  — от " + b.owner : "")));
        if (!own) return card;
        var upd = function (patch) { var nb = Object.assign({}, b, patch); putButton(nb); };
        var r1 = h("div", "mc-row");
        r1.appendChild(h("label", null, "Где"));
        var zs = h("select");
        Object.keys(BTN_ZONE_TITLES).forEach(function (z) { var o = h("option", null, BTN_ZONE_TITLES[z]); o.value = z; zs.appendChild(o); });
        zs.value = b.zone;
        zs.addEventListener("change", function () { upd({ zone: zs.value }); flushOps(); renderPanel(true); });
        r1.appendChild(zs);
        card.appendChild(r1);
        var r2 = h("div", "mc-row");
        r2.appendChild(h("label", null, "Значок"));
        var is = h("select");
        var o0 = h("option", null, "без значка"); o0.value = ""; is.appendChild(o0);
        ICONS.concat(b.icon && ICONS.indexOf(b.icon) === -1 ? [b.icon] : []).forEach(function (n) { var o = h("option", null, n); o.value = n; is.appendChild(o); });
        is.value = b.icon || "";
        is.addEventListener("change", function () { upd({ icon: is.value }); flushOps(); renderPanel(true); });
        r2.appendChild(is);
        card.appendChild(r2);
        var r3 = h("div", "mc-row");
        r3.appendChild(h("label", null, "Подпись"));
        var lt = h("input"); lt.type = "text"; lt.maxLength = 40; lt.value = b.label || ""; lt.placeholder = b.icon ? "только значок" : "текст";
        lt.addEventListener("change", function () { upd({ label: lt.value.trim() }); flushOps(); });
        r3.appendChild(lt);
        card.appendChild(r3);
        var bs = h("div", "mc-btns");
        bs.appendChild(btn("Левее", "", function () { upd({ order: (b.order || 0) - 1 }); flushOps(); renderPanel(true); }));
        bs.appendChild(btn("Правее", "", function () { upd({ order: (b.order || 0) + 1 }); flushOps(); renderPanel(true); }));
        card.appendChild(bs);
        return card;
    }

    // ---- вкладка «Ещё»: свои кнопки, эффекты, отдельные окна (эффекты рисует ядро: runtime/src/81-fx.js)
    function setFx(key, value) {
        if (!DS.fx) DS.fx = {};
        if (value === null || value === false) delete DS.fx[key]; else DS.fx[key] = value;
        queueOp("fx|" + key, { op: "fx", key: key, value: value === false ? null : value });
        applyFx();
    }

    // ---- вкладка «Ещё»: кнопки, эффекты, отдельные окна
    var FX_SETTINGS = ["editor.cursorSmoothCaretAnimation", "editor.cursorBlinking", "editor.cursorStyle", "editor.smoothScrolling", "editor.fontLigatures", "workbench.list.smoothScrolling"];

    function renderMore() {
        var sb = section("Свои кнопки", "Любая команда VS Code — кнопкой в статусбаре, титлбаре или над редактором. Команду выбираешь в списке VS Code.");
        var own = DS.buttons || [];
        if (!own.length) sb.appendChild(h("div", "mc-note", "Кнопок пока нет."));
        var bsTop = h("div", "mc-btns");
        bsTop.appendChild(btn("Добавить кнопку", "pri", addButtonFlow));
        sb.appendChild(bsTop);
        own.slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); }).forEach(function (b) { des.panel.appendChild(buttonCard(b, true)); });
        if ((UIB || []).length) {
            section("Кнопки расширений", "Их добавили другие расширения через Moon Core; убираются вместе с расширением.");
            UIB.forEach(function (b) { des.panel.appendChild(buttonCard(b, false)); });
        }

        var se = section("Эффекты редактора", "Рисуются поверх окна, клики проходят насквозь.");
        ["cursorTrail", "typingParticles", "lineGlow", "cursorGlow"].forEach(function (k) {
            var spec = FXSPEC[k] || { label: k };
            var row = h("div", "mc-row" + (fxConf()[k] ? " set" : ""));
            row.appendChild(h("label", null, spec.label));
            var cb = h("input"); cb.type = "checkbox"; cb.checked = !!fxConf()[k];
            cb.addEventListener("change", function () { setFx(k, cb.checked ? true : null); flushOps(); renderPanel(true); });
            var ctl = h("div", "mc-ctl"); ctl.appendChild(cb); row.appendChild(ctl);
            se.appendChild(row);
        });
        var rc = h("div", "mc-row");
        rc.appendChild(h("label", null, "Цвет"));
        var cc = h("div", "mc-ctl");
        var col = h("input"); col.type = "color"; col.value = fxColor();
        col.addEventListener("input", function () { setFx("color", col.value); });
        cc.appendChild(col); cc.appendChild(h("span", "mc-note", fxConf().color ? "" : "как курсор"));
        rc.appendChild(cc);
        rc.appendChild(xBtn(!!fxConf().color, function () { setFx("color", null); flushOps(); renderPanel(true); }));
        se.appendChild(rc);
        var ri = h("div", "mc-row");
        ri.appendChild(h("label", null, "Сила"));
        var ic = h("div", "mc-ctl");
        var rng = h("input"); rng.type = "range"; rng.min = 1; rng.max = 10; rng.step = 1; rng.value = fxConf().intensity || 5;
        rng.addEventListener("input", function () { setFx("intensity", +rng.value); });
        ic.appendChild(rng); ri.appendChild(ic);
        se.appendChild(ri);
        var code = null;
        for (var i = 0; i < CATALOG.length; i++) if (CATALOG[i].id === "code") code = CATALOG[i];
        (code && code.settings || []).filter(function (s) { return FX_SETTINGS.indexOf(s.key) !== -1; }).forEach(function (s) { se.appendChild(settingRow(s, "Редактор")); });

        var sw = section("Отдельные окна", "Настоящие окна VS Code: редактор в своём окне можно положить на второй монитор. Первый раз VS Code спросит разрешение на команду.");
        var bw = h("div", "mc-btns");
        [["Редактор — в отдельное окно", "workbench.action.moveEditorToNewWindow"], ["Копия редактора в окне", "workbench.action.copyEditorToNewWindow"],
            ["Группа — в отдельное окно", "workbench.action.moveEditorGroupToNewWindow"], ["Компактное окно", "workbench.action.toggleCompactAuxiliaryWindow"]].forEach(function (c) {
            bw.appendChild(btn(c[0], "", function () {
                rpcFirst("command", { id: c[1], args: [], from: "" }, des && des.host).then(function (r) { if (!r || r.ok === false) toast("Moon Core: " + ((r && r.error) || "не вышло")); });
            }));
        });
        sw.appendChild(bw);
        sw.appendChild(h("div", "mc-note", "Любой элемент можно и открепить прямо в этом окне: вкладка «Элемент», «Плавающее окно»."));
    }
    ({ startPick: startPick, stopPick: stopPick, toggleDesign: toggleDesign, startDesign: startDesign, stopDesign: stopDesign, renderPanel: renderPanel, clearColorPreview: clearColorPreview });
//# sourceURL=mooncore-ui.js
