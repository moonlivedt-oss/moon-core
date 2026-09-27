    // ---------------------------------------------------------------------------
    //  Сниппеты.
    // ---------------------------------------------------------------------------
    var saved = {};          // id -> {kind, code} — сохранённые включённые сниппеты
    var previews = {};       // id -> code — несохранённая правка CSS
    var styles = {};         // id -> <style>
    var running = {};        // id -> {code, disposers}
    var rev = "";
    var domReady = false;

    function applyState(st) {
        if (!st || !Array.isArray(st.snippets)) return;
        var next = {};
        st.snippets.slice(0, PROTO.MAX_SNIPPETS).forEach(function (s) {
            if (!s || !ID_RE.test(String(s.id)) || typeof s.code !== "string" || s.code.length > PROTO.MAX_SNIPPET) return;
            next[s.id] = { kind: /\.js$/.test(s.id) ? "js" : "css", code: s.code };
        });
        // Сохранили ровно то, что было в превью, — превью больше не нужно.
        Object.keys(previews).forEach(function (id) { if (!next[id] || next[id].code === previews[id]) delete previews[id]; });
        saved = next;
        rev = String(st.rev || "");
        adoptDesign(st);
        render(false);
    }

    function applyPreview(d) {
        if (!d || !ID_RE.test(String(d.id)) || /\.js$/.test(d.id)) return;
        if (typeof d.code === "string" && d.code.length <= PROTO.MAX_SNIPPET) previews[d.id] = d.code;
        else delete previews[d.id];
        renderCss();
    }

    function headEl() { return document.head || document.documentElement; }

    function renderCss() {
        var ids = Object.keys(saved).filter(function (id) { return saved[id].kind === "css"; }).sort();
        Object.keys(styles).forEach(function (id) {
            if (ids.indexOf(id) === -1) { try { styles[id].remove(); } catch (e) {} delete styles[id]; }
        });
        var reorder = false;
        ids.forEach(function (id) {
            var code = previews[id] != null ? previews[id] : saved[id].code;
            var el = styles[id];
            if (!el) {
                el = document.createElement("style");
                el.setAttribute("data-mooncore", id);
                if (NONCE) el.setAttribute("nonce", NONCE);
                styles[id] = el;
                reorder = true;
            }
            if (el.textContent !== code) el.textContent = code;
            if (!el.isConnected) reorder = true;
        });
        // Порядок = порядок имён (каскад предсказуем): перекладываем в конец <head> по очереди.
        if (reorder) ids.forEach(function (id) { headEl().appendChild(styles[id]); });
        if (reorder && designStyle) headEl().appendChild(designStyle);
        renderDesignCss();
    }

    function renderJs(force) {
        Object.keys(running).forEach(function (id) {
            var s = saved[id];
            if (force || !s || s.kind !== "js" || s.code !== running[id].code) stopJs(id);
        });
        if (!domReady) return;
        Object.keys(saved).sort().forEach(function (id) {
            if (saved[id].kind === "js" && !running[id]) runJs(id, saved[id].code);
        });
    }

    function render(force) {
        try { renderCss(); } catch (e) { report("CSS", e); }
        try { renderJs(force); } catch (e) { report("JS", e); }
    }

    // ---------------------------------------------------------------------------
    //  JS-сниппеты: помощник mc и уборка.
    // ---------------------------------------------------------------------------
    function makeApi(id, disposers) {
        var add = function (fn) { disposers.push(fn); return fn; };
        var api = {
            id: id,
            version: BOOT.version || "",
            onDispose: function (fn) { if (typeof fn === "function") add(fn); },
            el: function (tag, props, children) {
                var n = document.createElement(tag);
                if (props) Object.keys(props).forEach(function (k) {
                    if (k === "style" && typeof props[k] === "object") Object.assign(n.style, props[k]);
                    else if (k === "attrs" && typeof props[k] === "object") Object.keys(props[k]).forEach(function (a) { n.setAttribute(a, props[k][a]); });
                    else n[k] = props[k];
                });
                (children || []).forEach(function (c) { n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
                return n;
            },
            mount: function (parent, node, before) {
                if (!parent || !node) return node;
                parent.insertBefore(node, before || null);
                if (node.setAttribute) node.setAttribute("data-mooncore-owner", id);
                add(function () { try { node.remove(); } catch (e) {} });
                return node;
            },
            css: function (text) {
                var st = document.createElement("style");
                st.setAttribute("data-mooncore-js", id);
                if (NONCE) st.setAttribute("nonce", NONCE);
                st.textContent = String(text);
                headEl().appendChild(st);
                add(function () { try { st.remove(); } catch (e) {} });
                return st;
            },
            on: function (target, ev, fn, opt) {
                target.addEventListener(ev, fn, opt);
                add(function () { try { target.removeEventListener(ev, fn, opt); } catch (e) {} });
            },
            every: function (ms, fn) {
                var t = setInterval(function () { try { fn(); } catch (e) { report("mc.every", e, id); } }, Math.max(50, ms | 0));
                add(function () { clearInterval(t); });
                return t;
            },
            after: function (ms, fn) {
                var t = setTimeout(function () { try { fn(); } catch (e) { report("mc.after", e, id); } }, ms | 0);
                add(function () { clearTimeout(t); });
                return t;
            },
            watch: function (selector, cb) {
                var seen = typeof WeakSet === "function" ? new WeakSet() : null;
                var queued = false, stopped = false;
                var scan = function () {
                    queued = false;
                    if (stopped) return;
                    var list;
                    try { list = document.querySelectorAll(selector); } catch (e) { report("mc.watch: плохой селектор " + selector, e, id); stopped = true; return; }
                    for (var i = 0; i < list.length; i++) {
                        var el = list[i];
                        if (seen && seen.has(el)) continue;
                        if (seen) seen.add(el);
                        try { var r = cb(el); if (typeof r === "function") add(r); } catch (e) { report("mc.watch", e, id); }
                    }
                };
                var mo = new MutationObserver(function () { if (!queued) { queued = true; requestAnimationFrame(scan); } });
                mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
                scan();
                var stop = function () { stopped = true; mo.disconnect(); };
                add(stop);
                return stop;
            },
            command: function (cmd) {
                var args = Array.prototype.slice.call(arguments, 1);
                return rpcFirst("command", { id: String(cmd), args: args, from: id }, null).then(function (r) {
                    if (!r || !r.ok) throw new Error((r && r.error) || "команда не выполнена");
                    return r.result;
                });
            },
            toast: function (text) { toast(text); },
            log: function () { try { console.log.apply(console, ["[moon:" + id + "]"].concat([].slice.call(arguments))); } catch (e) {} },
            $: function (sel, root) { return (root || document).querySelector(sel); },
            $$: function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); },
        };
        return api;
    }

    window.__MOONCORE_RUN__ = window.__MOONCORE_RUN__ || {};

    function runJs(id, code) {
        var rec = { code: code, disposers: [] };
        running[id] = rec;
        var api = makeApi(id, rec.disposers);
        var fn = null;
        try { fn = new Function("mc", "\"use strict\";\n" + code + "\n//# sourceURL=mooncore/" + id); }
        catch (e) {
            if (!(e instanceof EvalError) && !/unsafe-eval|Content Security Policy/i.test(String(e && e.message))) { report("синтаксис", e, id); return; }
            fn = null;       // CSP запрещает eval — исполняем через <script nonce>
        }
        if (fn) {
            try {
                var r = fn(api);
                if (typeof r === "function") rec.disposers.push(r);
                else if (r && typeof r.then === "function") r.catch(function (e) { report("async", e, id); });
            } catch (e) { report("выполнение", e, id); }
            return;
        }
        window.__MOONCORE_RUN__[id] = api;
        var s = document.createElement("script");
        if (NONCE) s.setAttribute("nonce", NONCE);
        s.textContent = "(function(mc){\"use strict\";try{\n" + code + "\n}catch(e){window.__MOONCORE__.fail(" + JSON.stringify(id) + ",e);}})(window.__MOONCORE_RUN__[" + JSON.stringify(id) + "]);";
        headEl().appendChild(s);
        s.remove();
    }

    function stopJs(id) {
        var rec = running[id];
        if (!rec) return;
        delete running[id];
        delete window.__MOONCORE_RUN__[id];
        for (var i = rec.disposers.length - 1; i >= 0; i--) {
            try { rec.disposers[i](); } catch (e) { report("уборка", e, id); }
        }
    }

    // ---------------------------------------------------------------------------
    //  Тост.
    // ---------------------------------------------------------------------------
    var toastEl = null, toastTimer = null;
    function toast(text) {
        if (!document.body) return;
        if (!toastEl) {
            toastEl = document.createElement("div");
            toastEl.setAttribute("data-mooncore-ui", "toast");
            Object.assign(toastEl.style, {
                position: "fixed", left: "50%", bottom: "48px", transform: "translateX(-50%)", zIndex: String(Z + 5),
                padding: "8px 14px", borderRadius: "8px", font: "12px/1.4 var(--vscode-font-family, sans-serif)",
                background: "var(--vscode-editorWidget-background, #1e1e2e)", color: "var(--vscode-editorWidget-foreground, #cdd6f4)",
                border: "1px solid var(--vscode-focusBorder, #89b4fa)", boxShadow: "0 6px 24px rgba(0,0,0,.35)", pointerEvents: "none",
                maxWidth: "70vw", whiteSpace: "pre-wrap",
            });
        }
        toastEl.textContent = String(text);
        document.body.appendChild(toastEl);
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { if (toastEl) toastEl.remove(); }, 2600);
    }
