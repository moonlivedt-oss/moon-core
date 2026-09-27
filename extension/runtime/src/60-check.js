    // ---------------------------------------------------------------------------
    //  Проверка селекторов: какие правила CSS-сниппетов ничего не находят.
    // ---------------------------------------------------------------------------
    var PSEUDO_RE = /::?(before|after|placeholder|selection|marker|backdrop|first-line|first-letter|-webkit-[\w-]+)(\([^)]*\))?|:(hover|focus-within|focus-visible|focus|active|visited|link|target|checked|placeholder-shown)\b/g;
    function splitSelectors(text) {
        var out = [], depth = 0, cur = "";
        for (var i = 0; i < text.length; i++) {
            var c = text[i];
            if (c === "(" || c === "[") depth++;
            else if (c === ")" || c === "]") depth--;
            if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += c;
        }
        if (cur.trim()) out.push(cur.trim());
        return out;
    }
    function selectorAlive(sel) {
        var s = sel.replace(PSEUDO_RE, "").trim() || "*";
        try { return !!document.querySelector(s); } catch (e) { return true; }   // не можем проверить — не ругаемся
    }
    function collectRules(rules, out) {
        for (var i = 0; i < rules.length && out.length < 2000; i++) {
            var r = rules[i];
            if (r.selectorText) splitSelectors(r.selectorText).forEach(function (s) { out.push({ selector: s.slice(0, 300), found: selectorAlive(s) }); });
            else if (r.cssRules) collectRules(r.cssRules, out);
        }
        return out;
    }
    function checkAll(prints) {
        var out = Object.keys(styles).sort().map(function (id) {
            var rules = [];
            try { if (styles[id].sheet) collectRules(styles[id].sheet.cssRules, rules); } catch (e) {}
            return { id: id, rules: rules };
        });
        // Правки конструктора: каждое правило — селектор элемента, который пользователь выбрал мышкой.
        // Не находит — ищем элемент по отпечатку правила и предлагаем замену (хост спросит).
        var design = Object.keys(DS.rules).sort().map(function (sel) {
            var r = DS.rules[sel] || {};
            var o = { selector: sel.slice(0, 300), label: String(r.label || "").slice(0, 80), found: selectorAlive(sel) };
            if (!o.found && r.fp) { try { var hl = healRule(sel, r.fp); if (hl) o.heal = hl; } catch (e) { report("самолечение " + sel, e); } }
            return o;
        });
        if (design.length) out.push({ id: "~design", rules: design });
        // Каталог: что конструктор умеет находить. Его поломка после обновления VS Code — повод обновить каталог.
        // prints — отпечатки элементов каталога из прошлого прогона (e2e): найден элемент — свежий
        // отпечаток для следующего раза, пропал — поиск по старому отпечатку и предложение селектора.
        var cat = CATALOG.filter(function (e) { return e && e.selector; }).map(function (e) {
            var o = { id: String(e.id || "").slice(0, 40), selector: String(e.selector).slice(0, 300), label: String(e.label || "").slice(0, 80), found: selectorAlive(e.selector) };
            if (!prints) return o;
            try {
                if (o.found) {
                    var el = document.querySelector(e.selector);
                    if (el) o.fp = fingerprint(el, e.selector);
                } else if (prints[o.id]) {
                    var hl = healRule(e.selector, prints[o.id]);
                    if (hl) o.heal = hl;
                }
            } catch (err) {}
            return o;
        });
        if (cat.length) out.push({ id: "~catalog", rules: cat });
        return out;
    }
    function answerCheck(d) {
        var prints = d.prints && typeof d.prints === "object" ? d.prints : null;
        rpcFirst("report", { reqId: String(d.reqId), results: checkAll(prints) }, d.host);
    }
