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
