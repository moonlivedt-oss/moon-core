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
        lookSection();
        allColorsSection();
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
