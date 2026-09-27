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
