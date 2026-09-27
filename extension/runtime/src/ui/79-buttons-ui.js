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
