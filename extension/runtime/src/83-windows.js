    // ---------------------------------------------------------------------------
    //  Плавающие окна модулей (mc.window): общий сервис вместо своего окна в каждом модуле.
    //  Заголовок с перетаскиванием, уголок для размера, прилипание к краям окна VS Code, место и
    //  размер запоминаются (localStorage, по модулю и id окна). Содержимое модуль строит сам в
    //  win.body обычным DOM (без innerHTML — Trusted Types не нужны). Окна модуля закрываются при
    //  его выключении и горячей перезагрузке.
    // ---------------------------------------------------------------------------
    var WINS = {};           // "мод/id" -> окно
    var WIN_ID_RE = /^[\w.-]{1,40}$/;
    var SNAP = 16;

    function winKey(mod, id) { return "mooncore.win." + mod + "." + id; }
    function winLoad(mod, id) { try { var g = JSON.parse(localStorage.getItem(winKey(mod, id)) || "null"); return g && typeof g === "object" ? g : null; } catch (e) { return null; } }
    function winSave(mod, id, g) { try { localStorage.setItem(winKey(mod, id), JSON.stringify(g)); } catch (e) {} }
    function viewport() { return { w: window.innerWidth || 1200, h: window.innerHeight || 800 }; }

    /** Вписать геометрию в окно VS Code и прилепить к краям, если близко. */
    function fitGeom(g) {
        var v = viewport();
        var w = Math.max(160, Math.min(v.w, g.w | 0)), h = Math.max(100, Math.min(v.h, g.h | 0));
        var x = Math.max(0, Math.min(v.w - w, g.x | 0)), y = Math.max(0, Math.min(v.h - h, g.y | 0));
        if (x < SNAP) x = 0;
        if (y < SNAP) y = 0;
        if (v.w - (x + w) < SNAP) x = v.w - w;
        if (v.h - (y + h) < SNAP) y = v.h - h;
        return { x: x, y: y, w: w, h: h };
    }

    function createWindow(mod, opts) {
        var o = opts || {};
        var id = WIN_ID_RE.test(String(o.id || "")) ? String(o.id) : "main";
        var key = mod + "/" + id;
        if (WINS[key]) { if (o.title) WINS[key].setTitle(o.title); return WINS[key]; }
        var v = viewport();
        var w0 = o.width > 0 ? o.width : 420, h0 = o.height > 0 ? o.height : 320;
        var geom = fitGeom(winLoad(mod, id) || { x: o.x >= 0 ? o.x : (v.w - w0) / 2, y: o.y >= 0 ? o.y : (v.h - h0) / 3, w: w0, h: h0 });
        var closers = [];

        var el = document.createElement("div");
        el.setAttribute("data-mooncore-ui", "window");
        el.setAttribute("data-mooncore-owner", mod);
        Object.assign(el.style, {
            position: "fixed", zIndex: String(Z - 20), display: "flex", flexDirection: "column", overflow: "hidden",
            background: "var(--vscode-editorWidget-background, #1e1e2e)", color: "var(--vscode-editorWidget-foreground, #cdd6f4)",
            border: "1px solid var(--vscode-widget-border, var(--vscode-focusBorder, #45475a))", borderRadius: "8px",
            boxShadow: "0 12px 40px rgba(0,0,0,.45)", font: "13px/1.4 var(--vscode-font-family, sans-serif)",
        });
        var head = document.createElement("div");
        Object.assign(head.style, { display: "flex", alignItems: "center", gap: "8px", padding: "6px 10px", cursor: "move", userSelect: "none",
            background: "var(--vscode-titleBar-activeBackground, rgba(127,127,127,.12))", borderBottom: "1px solid var(--vscode-widget-border, transparent)" });
        var title = document.createElement("div");
        Object.assign(title.style, { flex: "1", fontWeight: "600", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
        title.textContent = String(o.title || (MODS[mod] && MODS[mod].name) || mod);
        var close = document.createElement("div");
        close.textContent = "×";
        close.title = "Закрыть";
        Object.assign(close.style, { cursor: "pointer", fontSize: "16px", padding: "0 4px", opacity: ".75" });
        head.appendChild(title);
        head.appendChild(close);
        var body = document.createElement("div");
        Object.assign(body.style, { flex: "1", overflow: "auto", padding: o.padding === false ? "0" : "10px" });
        var grip = document.createElement("div");
        Object.assign(grip.style, { position: "absolute", right: "0", bottom: "0", width: "14px", height: "14px", cursor: "nwse-resize",
            background: "linear-gradient(135deg, transparent 50%, var(--vscode-focusBorder, #89b4fa) 50%)", opacity: ".6" });
        el.appendChild(head);
        el.appendChild(body);
        el.appendChild(grip);

        function place() { el.style.left = geom.x + "px"; el.style.top = geom.y + "px"; el.style.width = geom.w + "px"; el.style.height = geom.h + "px"; }
        function commit() { geom = fitGeom(geom); place(); winSave(mod, id, geom); }
        place();

        // Перетаскивание заголовка и уголка: слушатели документа — только пока тянут.
        function drag(e, resize) {
            if (e.button !== undefined && e.button !== 0) return;
            if (e.target === close) return;
            var sx = e.clientX, sy = e.clientY, g0 = { x: geom.x, y: geom.y, w: geom.w, h: geom.h };
            var move = function (ev) {
                var dx = ev.clientX - sx, dy = ev.clientY - sy;
                geom = resize ? { x: g0.x, y: g0.y, w: g0.w + dx, h: g0.h + dy } : { x: g0.x + dx, y: g0.y + dy, w: g0.w, h: g0.h };
                geom = fitGeom(geom);
                place();
            };
            var up = function () { document.removeEventListener("mousemove", move, true); document.removeEventListener("mouseup", up, true); commit(); };
            document.addEventListener("mousemove", move, true);
            document.addEventListener("mouseup", up, true);
            if (e.preventDefault) e.preventDefault();
        }
        head.addEventListener("mousedown", function (e) { drag(e, false); });
        grip.addEventListener("mousedown", function (e) { drag(e, true); });

        var win = {
            id: id, el: el, body: body,
            setTitle: function (t) { title.textContent = String(t); return win; },
            show: function () { if (!el.isConnected && document.body) document.body.appendChild(el); return win; },
            hide: function () { try { el.remove(); } catch (e) {} return win; },
            toggle: function () { return el.isConnected ? win.hide() : win.show(); },
            isOpen: function () { return !!el.isConnected; },
            /** Прилепить: left | right | top | bottom (половина окна VS Code) или center. */
            dock: function (side) {
                var vp = viewport();
                if (side === "left") geom = { x: 0, y: 0, w: vp.w / 2, h: vp.h };
                else if (side === "right") geom = { x: vp.w / 2, y: 0, w: vp.w / 2, h: vp.h };
                else if (side === "top") geom = { x: 0, y: 0, w: vp.w, h: vp.h / 2 };
                else if (side === "bottom") geom = { x: 0, y: vp.h / 2, w: vp.w, h: vp.h / 2 };
                else geom = { x: (vp.w - geom.w) / 2, y: (vp.h - geom.h) / 3, w: geom.w, h: geom.h };
                commit();
                return win;
            },
            geometry: function () { return { x: geom.x, y: geom.y, w: geom.w, h: geom.h }; },
            onClose: function (fn) { if (typeof fn === "function") closers.push(fn); return win; },
            close: function () {
                if (!WINS[key]) return;
                delete WINS[key];
                win.hide();
                closers.splice(0).forEach(function (fn) { try { fn(); } catch (e) { report("модуль " + mod + ": окно", e); } });
            },
        };
        close.addEventListener("click", function () { if (o.closeHides) win.hide(); else win.close(); });
        WINS[key] = win;
        (modDispose[mod] = modDispose[mod] || []).push(function () { win.close(); });
        if (o.show !== false) win.show();
        return win;
    }

    function closeModuleWindows(mod) {
        Object.keys(WINS).forEach(function (k) { if (k.indexOf(mod + "/") === 0) WINS[k].close(); });
    }
