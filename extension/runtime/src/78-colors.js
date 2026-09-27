    // ---------------------------------------------------------------------------
    //  Цвета темы: общие помощники (переменные темы, разбор цвета). Секции «Цвета темы» и
    //  «Цвета кода» конструктора — в чанке интерфейса (runtime/src/ui/78-colors.js).
    // ---------------------------------------------------------------------------
    /** Все переменные темы: имя (без --vscode-) -> значение. */
    function themeVars() {
        var out = {};
        var root = document.querySelector(".monaco-workbench") || document.documentElement;
        try {
            var cs = getComputedStyle(root);
            for (var i = 0; i < cs.length; i++) { var n = cs[i]; if (n && n.indexOf("--vscode-") === 0) out[n.slice(9)] = cs.getPropertyValue(n).trim(); }
        } catch (e) {}
        return out;
    }

    /** Цвет в [r, g, b, a] (hex или rgb/rgba) или null. */
    function rgba(c) {
        var s = String(c || "").trim(), m;
        if ((m = /^#([0-9a-f]{3,8})$/i.exec(s))) {
            var hx = m[1];
            if (hx.length <= 4) hx = hx.split("").map(function (x) { return x + x; }).join("");
            if (hx.length !== 6 && hx.length !== 8) return null;
            return [parseInt(hx.slice(0, 2), 16), parseInt(hx.slice(2, 4), 16), parseInt(hx.slice(4, 6), 16), hx.length === 8 ? parseInt(hx.slice(6, 8), 16) / 255 : 1];
        }
        if ((m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i.exec(s))) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
        return null;
    }
    function sameColor(a, b) {
        var x = rgba(a), y = rgba(b);
        return !!(x && y) && Math.abs(x[0] - y[0]) < 2 && Math.abs(x[1] - y[1]) < 2 && Math.abs(x[2] - y[2]) < 2 && Math.abs(x[3] - y[3]) < 0.02;
    }
    function hex6(c) {
        var x = rgba(c);
        return x ? "#" + [x[0], x[1], x[2]].map(function (n) { return ("0" + Math.round(n).toString(16)).slice(-2); }).join("") : "#000000";
    }
