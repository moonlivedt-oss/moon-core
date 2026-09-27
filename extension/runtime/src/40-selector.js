    // ---------------------------------------------------------------------------
    //  Селектор для элемента: короткий и устойчивый к перестройке DOM.
    // ---------------------------------------------------------------------------
    var STATE_CLS = /^(focused|focus|selected|active|checked|expanded|collapsed|hover|hovered|dirty|dragging|drop-target|visible|highlighted|disabled|pressed|mouseover|synthetic-focus|is-[\w-]+|has-[\w-]+|mooncore[\w-]*)$/;
    function cssEsc(s) {
        if (window.CSS && typeof CSS.escape === "function") return CSS.escape(s);
        return String(s).replace(/[^\w-]/g, function (c) { return "\\" + c; });
    }
    function stableClasses(el) {
        return Array.prototype.filter.call(el.classList || [], function (c) {
            return c && c.length < 40 && !STATE_CLS.test(c) && !/\d{3,}/.test(c) && !/^mtk\d/.test(c);
        });
    }
    function stableId(id) { return !!id && id.length < 60 && !/\d{2,}|_\d/.test(id); }
    function count(sel) { try { return document.querySelectorAll(sel).length; } catch (e) { return Infinity; } }
    function hits(sel, el) { try { return Array.prototype.indexOf.call(document.querySelectorAll(sel), el) !== -1; } catch (e) { return false; } }

    function segment(el) {
        if (stableId(el.id)) return { text: "#" + cssEsc(el.id), anchor: true };
        var s = el.tagName.toLowerCase() + stableClasses(el).slice(0, 3).map(function (c) { return "." + cssEsc(c); }).join("");
        var anchor = el.classList && el.classList.contains("part") || (s.indexOf(".") !== -1 && count(s) === 1);
        return { text: s, anchor: !!anchor };
    }

    function selectorFor(el) {
        if (!el || el.nodeType !== 1) return "";
        var parts = [], cur = el, depth = 0;
        while (cur && cur.nodeType === 1 && cur !== document.documentElement && cur !== document.body && depth < 7) {
            var sg = segment(cur);
            parts.unshift(sg.text);
            if (sg.anchor) break;
            cur = cur.parentElement; depth++;
        }
        if (!parts.length) return el.tagName.toLowerCase();
        var base = count(parts.join(" "));
        // Выкидываем промежуточные звенья, если набор совпадений от этого не растёт.
        for (var i = parts.length - 2; i >= 1; i--) {
            var trial = parts.slice(0, i).concat(parts.slice(i + 1)).join(" ");
            if (hits(trial, el) && count(trial) <= base) parts.splice(i, 1);
        }
        var sel = parts.join(" ");
        if (count(sel) > 1) {
            var al = el.getAttribute && el.getAttribute("aria-label");
            if (al && al.length < 60) {
                var withAl = sel + "[aria-label=\"" + al.replace(/["\\]/g, "\\$&") + "\"]";
                if (hits(withAl, el)) sel = withAl;
            }
        }
        // Всё ещё неоднозначно (например, подпись внутри вкладки) — уточняем по aria-label предка.
        if (count(sel) > 1) {
            var a = el.parentElement;
            for (var k = 0; a && k < 4 && a !== document.body; k++, a = a.parentElement) {
                var aal = a.getAttribute("aria-label");
                if (!aal || aal.length >= 60) continue;
                var cand = segment(a).text + "[aria-label=\"" + aal.replace(/["\\]/g, "\\$&") + "\"] " + parts[parts.length - 1];
                if (hits(cand, el) && count(cand) < count(sel)) sel = cand;
                break;
            }
        }
        return sel;
    }

    // ---------------------------------------------------------------------------
    //  Запасные селекторы и отпечаток элемента. Селектор из классов короткий, но именно классы
    //  VS Code переименовывает при обновлениях. Поэтому к правилу конструктора запоминается
    //  отпечаток: однозначные селекторы другого рода (id, aria-label, title, :has по подписи
    //  потомка), а также признаки элемента. Сломался основной селектор — элемент ищется по ним.
    // ---------------------------------------------------------------------------
    function attrSel(name, v) { return "[" + name + "=\"" + String(v).replace(/["\\]/g, "\\$&") + "\"]"; }
    function okLabel(v) { return !!v && v.length < 80 && !/[\n\r{}]/.test(v); }
    var hasSupported = null;
    function canHas() {
        if (hasSupported === null) { try { document.querySelector(":has(*)"); hasSupported = true; } catch (e) { hasSupported = false; } }
        return hasSupported;
    }

    /** Однозначные селекторы для el другого рода, чем основной (без повторов), до max штук. */
    function selectorCandidates(el, max) {
        var out = [], seen = {}, lim = max || 6;
        if (!el || el.nodeType !== 1) return out;
        var tag = el.tagName.toLowerCase();
        var cls = stableClasses(el).slice(0, 2).map(function (c) { return "." + cssEsc(c); }).join("");
        function add(s) {
            if (!s || seen[s] || out.length >= lim) return;
            seen[s] = 1;
            if (count(s) === 1 && hits(s, el)) out.push(s);
        }
        add(selectorFor(el));
        if (stableId(el.id)) add("#" + cssEsc(el.id));
        var al = el.getAttribute("aria-label"), ti = el.getAttribute("title"), ro = el.getAttribute("role");
        if (okLabel(al)) { add(tag + cls + attrSel("aria-label", al)); add(tag + attrSel("aria-label", al)); if (ro) add(attrSel("role", ro) + attrSel("aria-label", al)); }
        if (okLabel(ti)) add(tag + cls + attrSel("title", ti));
        // Ближайший предок с устойчивым id — якорь.
        for (var a = el.parentElement, k = 0; a && k < 8 && a !== document.body; a = a.parentElement, k++) {
            if (stableId(a.id)) { add("#" + cssEsc(a.id) + " " + tag + cls); break; }
        }
        // Своей подписи нет, а у потомка есть (li с иконкой внутри): tag.cls:has([aria-label=...]).
        if (!okLabel(al) && canHas()) {
            var inner = el.querySelector("[aria-label]");
            var il = inner && inner.getAttribute("aria-label");
            if (okLabel(il)) add(tag + cls + ":has(" + attrSel("aria-label", il) + ")");
        }
        return out;
    }

    /** Отпечаток элемента для правила sel (уходит на хост вместе с правкой, хранится у правила). */
    function fingerprint(el, sel) {
        if (!el || el.nodeType !== 1 || !el.tagName) return null;
        var fp = { tag: el.tagName.toLowerCase(), one: count(sel) === 1 };
        if (fp.one) {
            var alts = selectorCandidates(el).filter(function (s) { return s !== sel; }).slice(0, 4);
            if (alts.length) fp.alts = alts;
        }
        if (stableId(el.id)) fp.id = el.id;
        var al = el.getAttribute("aria-label"); if (okLabel(al)) fp.aria = al;
        var ti = el.getAttribute("title"); if (okLabel(ti)) fp.title = ti;
        var ro = el.getAttribute("role"); if (ro && ro.length < 30) fp.role = ro;
        var tx = String(el.textContent || "").replace(/\s+/g, " ").trim();
        if (tx && tx.length <= 60 && (el.children ? el.children.length : 0) <= 3) fp.text = tx;
        var cls = stableClasses(el).slice(0, 6); if (cls.length) fp.cls = cls;
        var pc = el.parentElement ? stableClasses(el.parentElement).slice(0, 4) : []; if (pc.length) fp.pcls = pc;
        var c = catalogFor(el);
        if (c && c.anchor === el) { fp.cat = c.entry.id; if (sel === c.entry.selector) fp.whole = true; }
        return fp;
    }
    /** Отпечаток правила «все такие» (весь тип элемента из каталога). */
    function fingerprintEntry(entry) { return entry && entry.id ? { cat: entry.id, whole: true } : null; }

    function textOf(el) { return String(el.textContent || "").replace(/\s+/g, " ").trim(); }

    /** Найти элемент по признакам отпечатка: нужен явный лидер, иначе null. */
    function findByPrint(fp) {
        if (!fp || !(fp.id || fp.aria || fp.title || fp.text)) return null;   // только по классам — слишком зыбко
        var list;
        try { list = document.querySelectorAll(fp.tag || "*"); } catch (e) { return null; }
        var top = null, topScore = 0, second = 0;
        for (var i = 0; i < list.length && i < 8000; i++) {
            var el = list[i];
            if (isOurUi(el)) continue;
            var sc = 0;
            if (fp.id && el.id === fp.id) sc += 6;
            if (fp.aria && el.getAttribute("aria-label") === fp.aria) sc += 4;
            if (fp.title && el.getAttribute("title") === fp.title) sc += 2;
            if (fp.role && el.getAttribute("role") === fp.role) sc += 1;
            if (fp.text && sc + 2 > second && textOf(el) === fp.text) sc += 2;
            if (fp.cls) { var own = stableClasses(el), k = 0; fp.cls.forEach(function (c) { if (own.indexOf(c) !== -1) k++; }); sc += Math.min(3, k); }
            if (fp.pcls && el.parentElement) { var pcl = stableClasses(el.parentElement); if (fp.pcls.some(function (c) { return pcl.indexOf(c) !== -1; })) sc += 1; }
            if (sc > topScore) { second = topScore; topScore = sc; top = el; } else if (sc > second) second = sc;
        }
        return topScore >= 5 && topScore > second ? top : null;
    }

    /**
     * Сломанное правило (sel ничего не находит): где теперь его элемент? {to, how, fp?} или null.
     *   alt     — сработал запасной селектор из отпечатка;
     *   catalog — правило на весь тип из каталога, а в новом каталоге у типа другой селектор;
     *   search  — элемент найден по признакам (id, aria-label, текст, классы).
     */
    function healRule(sel, fp) {
        if (!fp) return null;
        var i;
        for (i = 0; fp.alts && i < fp.alts.length; i++) {
            var n = count(fp.alts[i]);
            if (n !== Infinity && n >= 1 && (!fp.one || n === 1) && fp.alts[i] !== sel) return { to: fp.alts[i], how: "alt" };
        }
        if (fp.cat && fp.whole) {
            for (i = 0; i < CATALOG.length; i++) {
                var e = CATALOG[i];
                if (e.id === fp.cat) {
                    if (e.selector && e.selector !== sel && count(e.selector) > 0) return { to: e.selector, how: "catalog" };
                    break;
                }
            }
        }
        if (fp.one) {
            var el = findByPrint(fp);
            var to = el ? selectorFor(el) : "";
            if (to && to !== sel && hits(to, el)) return { to: to, how: "search", fp: fingerprint(el, to) };
        }
        return null;
    }

    var STYLE_KEYS = ["color", "background-color", "font-size", "font-weight", "padding", "margin", "border-radius", "opacity", "display"];
    function styleHint(el) {
        try {
            var cs = getComputedStyle(el), out = [];
            STYLE_KEYS.forEach(function (k) {
                var v = cs.getPropertyValue(k);
                if (!v || v === "0px" || v === "normal" || v === "rgba(0, 0, 0, 0)" || (k === "opacity" && v === "1") || (k === "font-weight" && v === "400")) return;
                out.push(k + ": " + v);
            });
            return out.join("; ").slice(0, 400);
        } catch (e) { return ""; }
    }
    function labelFor(el) {
        var t = el.tagName.toLowerCase();
        var cls = stableClasses(el).slice(0, 3);
        var al = el.getAttribute && el.getAttribute("aria-label");
        return (t + (cls.length ? "." + cls.join(".") : "") + (al ? " «" + al.slice(0, 40) + "»" : "")).slice(0, 80);
    }

    /** Узел — часть интерфейса Moon Core (пипетка, конструктор, эффекты): его не выбирают и не проверяют. */
    function isOurUi(node) {
        for (var n = node; n && n.nodeType === 1; n = n.parentElement) if (n.hasAttribute("data-mooncore-ui")) return true;
        return false;
    }
