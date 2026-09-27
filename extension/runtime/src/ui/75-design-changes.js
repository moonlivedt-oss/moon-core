    // ---- профили вида
    function renderProfiles() {
        var PR = PROFILES || { list: [], active: "", dirty: false };
        var n = changesCount();
        des.panel.appendChild(h("div", "mc-note mc-pad", "Профиль — снимок всех правок: элементы и настройки VS Code. Применение заменяет текущие правки. «Исходный вид» возвращает VS Code таким, каким он был до Moon Core."));
        var now = section("Сейчас");
        now.appendChild(h("div", null, PR.active ? "Профиль «" + PR.active + "»" + (PR.dirty ? " — изменён после применения" : "") : n ? "Свои правки без профиля (" + n + ")" : "Исходный вид VS Code"));
        if (PR.active && PR.dirty) now.appendChild(h("div", "mc-note", "Сохрани изменения, иначе при переключении профиля они пропадут."));

        var save = section("Сохранить текущий вид");
        var line = h("div", "mc-row");
        var inp = h("input"); inp.type = "text"; inp.placeholder = "Имя профиля"; inp.maxLength = 40;
        inp.value = PR.active && !isBuiltin(PR.active) ? PR.active : "";
        line.appendChild(inp);
        var doSave = function () {
            var name = inp.value.trim();
            if (!name) { toast("Введи имя профиля"); return; }
            if (isBuiltin(name)) { toast("«" + name + "» — встроенный профиль, выбери другое имя"); return; }
            profileOp({ op: "saveProfile", name: name, modules: collectModuleProfile() }, "Сохранено: «" + name + "»");
        };
        inp.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); doSave(); } });
        line.appendChild(btn("Сохранить", "pri", doSave));
        save.appendChild(line);
        if (!n) save.appendChild(h("div", "mc-note", "Правок пока нет — профиль будет равен исходному виду."));

        var listSec = section("Профили");
        listSec.appendChild(profileCard("", "Исходный вид VS Code", "Без правок Moon Core: всё как до установки", false, !PR.active && !n));
        PR.list.forEach(function (p) {
            var desc = p.note || ("элементов: " + p.rules + ", настроек: " + p.settings);
            // Профиль несёт и состояние модулей (например, фон MoonLight BG) — пусть это будет видно.
            var mods = Array.isArray(p.modules) ? p.modules.filter(function (id) { return MODS[id]; }).map(function (id) { return MODS[id].name; }) : [];
            if (mods.length) desc += " + " + mods.join(", ");
            listSec.appendChild(profileCard(p.name, p.name, desc, !p.builtin, PR.active === p.name, p.builtin));
        });
    }
    function isBuiltin(name) { return !!(PROFILES && PROFILES.list.some(function (p) { return p.builtin && p.name === name; })); }

    function profileCard(name, title, desc, deletable, active, builtin) {
        var card = h("div", "mc-prof" + (active ? " on" : ""));
        var head = h("div", "mc-prof-h");
        head.appendChild(h("span", "mc-cap", title));
        if (builtin) head.appendChild(h("small", null, "встроенный"));
        if (active) head.appendChild(h("small", "mc-now", "сейчас"));
        card.appendChild(head);
        card.appendChild(h("div", "mc-note", desc));
        var bs = h("div", "mc-btns");
        var key = "apply:" + name;
        var needConfirm = changesCount() > 0 && !(active && !(PROFILES && PROFILES.dirty));
        if (!(active && !(PROFILES && PROFILES.dirty))) bs.appendChild(btn(des.confirm === key ? "Заменить текущие правки?" : "Применить", "pri", function () {
            if (needConfirm && des.confirm !== key) { des.confirm = key; renderPanel(true); return; }
            des.confirm = "";
            profileOp(name ? { op: "applyProfile", name: name } : { op: "clearAll" }, name ? "Профиль «" + name + "»" : "Исходный вид VS Code");
        }));
        if (deletable && active && PROFILES && PROFILES.dirty) {
            bs.appendChild(btn("Обновить", "", function () { profileOp({ op: "saveProfile", name: name, modules: collectModuleProfile() }, "Профиль «" + name + "» обновлён"); }, "Записать текущие правки в этот профиль"));
        }
        if (deletable) {
            var dk = "del:" + name;
            bs.appendChild(btn(des.confirm === dk ? "Точно удалить?" : "Удалить", "danger", function () {
                if (des.confirm !== dk) { des.confirm = dk; renderPanel(true); return; }
                des.confirm = "";
                profileOp({ op: "deleteProfile", name: name }, "Профиль «" + name + "» удалён");
            }));
        }
        card.appendChild(bs);
        return card;
    }

    /** Операция с профилем: сразу на хост, по ответу — новое состояние (правила, настройки, список). */
    function profileOp(op, done) {
        flushOps();
        var seq = ++flushSeq;
        rpcFirst("design", { ops: [op] }, des && des.host).then(function (r) {
            if (!r || r.ok === false) { toast("Moon Core: " + ((r && r.error) || "расширение не ответило")); }
            else if (done) toast(done);
            if (r && r.design && seq === flushSeq) {
                DS = toDS(r.design);
                if (r.settingsNow) SETNOW = r.settingsNow;
                if (r.profiles) PROFILES = r.profiles;
                localEditAt = 0;
                clearColorPreview();
                afterDS();
            }
            if (des) renderPanel(true);
        });
    }

    /** Сколько всего правок: правила, настройки, цвета темы, кнопки, эффекты. */
    function changesCount() {
        return Object.keys(DS.rules).length + Object.keys(DS.settings).length + Object.keys(DS.colors || {}).length +
            (DS.buttons || []).length + Object.keys(DS.fx || {}).length;
    }
    function renderChanges() {
        var sels = Object.keys(DS.rules).sort(function (a, b) { return (DS.rules[b].ts || 0) - (DS.rules[a].ts || 0); });
        var keys = Object.keys(DS.settings);
        if (!changesCount()) {
            des.panel.appendChild(h("div", "mc-empty", "Изменений пока нет. Выбери элемент во вкладке «Элемент»."));
            return;
        }
        var ckeys = Object.keys(DS.colors || {});
        if (ckeys.length) {
            var cc = h("div", "mc-card");
            cc.appendChild(h("div", "mc-cap", "Цвета темы"));
            ckeys.forEach(function (k) {
                var rec = DS.colors[k];
                var line = h("div", "mc-line");
                var sw = h("span", null, "");
                var dot = h("span"); Object.assign(dot.style, { display: "inline-block", width: "10px", height: "10px", borderRadius: "2px", marginRight: "6px", background: rec.value, verticalAlign: "-1px" });
                sw.appendChild(dot);
                sw.appendChild(document.createTextNode((k.indexOf("tk:") === 0 ? "код: " : "") + k.slice(3) + "  " + rec.value + "  (было: " + (rec.hadPrev ? rec.prev : "из темы") + ")"));
                line.appendChild(sw);
                line.appendChild(xBtn(true, function () { setColor(k, null, rec.label, k.indexOf("wb:") === 0 ? k.slice(3).replace(/\./g, "-") : ""); flushOps(); renderPanel(true); }));
                cc.appendChild(line);
            });
            des.panel.appendChild(cc);
        }
        if ((DS.buttons || []).length || Object.keys(DS.fx || {}).length) {
            var mc = h("div", "mc-card");
            mc.appendChild(h("div", "mc-cap", "Кнопки и эффекты"));
            mc.appendChild(h("div", "mc-note", "Своих кнопок: " + (DS.buttons || []).length + ", эффектов: " + Object.keys(DS.fx || {}).filter(function (k) { return DS.fx[k] === true; }).length));
            var mb = h("div", "mc-btns");
            mb.appendChild(btn("Открыть «Ещё»", "", function () { des.tab = "more"; renderPanel(true); }));
            mc.appendChild(mb);
            des.panel.appendChild(mc);
        }
        if (keys.length) {
            var card = h("div", "mc-card");
            card.appendChild(h("div", "mc-cap", "Настройки VS Code"));
            keys.forEach(function (k) {
                var rec = DS.settings[k];
                var line = h("div", "mc-line");
                line.appendChild(h("span", null, (rec.label || settingLabel(k)) + ": " + fmtVal(rec.value) + "  (было: " + fmtVal(rec.hadPrev ? rec.prev : undefined) + ")"));
                line.appendChild(xBtn(true, function () { undoSetting(k); flushOps(); renderPanel(true); }));
                var ksel = settingSelector(k);
                if (ksel) hoverHighlight(line, ksel, false);
                card.appendChild(line);
            });
            des.panel.appendChild(card);
        }
        sels.forEach(function (sel) {
            var r = DS.rules[sel];
            var card = h("div", "mc-card");
            card.appendChild(h("div", "mc-cap", (r.label || "элемент") + (condText(sel) ? " — " + condText(sel) : "")));
            card.appendChild(h("code", null, sel));
            // Навёл — элементы правки обведены (скрытые на это время показаны).
            hoverHighlight(card, sel, true);
            card.title = "Наведи — элементы этой правки подсвечены в окне";
            Object.keys(r.props).forEach(function (k) {
                if (!PROPS[k]) return;
                var line = h("div", "mc-line");
                var v = r.props[k];
                line.appendChild(h("span", null, PROPS[k].label + (PROPS[k].type === "flag" ? "" : ": " + cssVal(k, v))));
                line.appendChild(xBtn(true, function () { setProp(sel, k, null, r.label); renderPanel(true); }));
                card.appendChild(line);
            });
            var bs = h("div", "mc-btns");
            var target = null;
            try { target = document.querySelector(sel); } catch (e) {}
            if (target && !(r.props.hide)) bs.appendChild(btn("Выбрать", "", function () { selectEl(target); }));
            else if (!target) bs.appendChild(h("span", "mc-note", "сейчас не на экране"));
            bs.appendChild(btn("Сбросить", "danger", function () { resetRule(sel); renderPanel(true); }));
            card.appendChild(bs);
            des.panel.appendChild(card);
        });
        var foot = h("div", "mc-btns"); foot.style.margin = "12px 12px 0";
        foot.appendChild(btn(des.confirmClear ? "Точно сбросить всё?" : "Сбросить всё", "danger", function () {
            if (!des.confirmClear) { des.confirmClear = true; renderPanel(true); return; }
            des.confirmClear = false;
            DS = toDS(null);
            queueOp("clearAll", { op: "clearAll" });
            flushOps();
            renderDesignCss();
            renderPanel(true);
        }));
        des.panel.appendChild(foot);
    }
