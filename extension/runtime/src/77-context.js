    // ---------------------------------------------------------------------------
    //  Контекст окна для правил «только для...». Хост сообщает язык активного файла, ветку,
    //  папку проекта и вид темы (событие "ctx"); окно пишет их атрибутами на <html>:
    //    data-mc-lang, data-mc-branch, data-mc-folder, data-mc-theme.
    //  Правило с условием — это обычное правило с приставкой к селектору:
    //    html[data-mc-lang="markdown"] .monaco-editor .minimap
    //  Поэтому условия работают везде (сниппеты, конструктор, профили) без новой модели.
    // ---------------------------------------------------------------------------
    var ctxByHost = {};                              // token -> последний контекст этого хоста
    var CTX_ATTR = { lang: "data-mc-lang", branch: "data-mc-branch", folder: "data-mc-folder", theme: "data-mc-theme" };
    var COND_TITLES = { lang: "язык", branch: "ветка", folder: "проект", theme: "тема" };
    var COND_RE = /^html\[data-mc-(lang|branch|folder|theme)="((?:[^"\\]|\\.)*)"\]\s+/;

    function onCtx(rec, d) {
        if (!d || typeof d !== "object") return;
        ctxByHost[rec.token] = d;
        if (isOwnHost(rec.token)) applyCtx(d);
    }
    function applyCtx(d) {
        var root = document.documentElement;
        Object.keys(CTX_ATTR).forEach(function (k) {
            var v = typeof d[k] === "string" ? d[k].slice(0, 120) : "";
            if (v) root.setAttribute(CTX_ATTR[k], v); else root.removeAttribute(CTX_ATTR[k]);
        });
        if (des && des.tab === "el") renderPanel(false);
    }
    function ctxNow() {
        var root = document.documentElement, out = {};
        Object.keys(CTX_ATTR).forEach(function (k) { out[k] = root.getAttribute(CTX_ATTR[k]) || ""; });
        return out;
    }
    /** "html[data-mc-lang="md"] .x" -> { kind: "lang", value: "md", base: ".x" }. */
    function splitCond(sel) {
        var m = COND_RE.exec(sel || "");
        return m ? { kind: m[1], value: m[2].replace(/\\(.)/g, "$1"), base: sel.slice(m[0].length) } : { kind: "", value: "", base: sel || "" };
    }
    function withCond(base, kind, value) {
        return kind && value ? "html" + attrSel("data-mc-" + kind, value) + " " + base : base;
    }
    function condText(sel) {
        var c = splitCond(sel);
        return c.kind ? "только " + COND_TITLES[c.kind] + " «" + c.value + "»" : "";
    }
