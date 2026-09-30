    // ---- инструменты конструктора: пипетка и палитра у полей цвета, правка «по состоянию»
    //      (под мышью, в фокусе), выключение правила без удаления, части профиля, переименование

    // Недавние цвета — в localStorage окна; рядом — основные цвета текущей темы.
    var RECENT_KEY = "mooncore.recentColors", RECENT_MAX = 8;
    var THEME_SWATCHES = ["focusBorder", "foreground", "editor-background", "sideBar-background", "button-background", "statusBar-background",
        "errorForeground", "editorWarning-foreground", "textLink-foreground", "terminal-ansiGreen", "terminal-ansiBlue", "terminal-ansiMagenta"];
    function recentColors() {
        try {
            var a = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
            return Array.isArray(a) ? a.filter(function (c) { return /^#[0-9a-f]{6}$/i.test(String(c)); }).slice(0, RECENT_MAX) : [];
        } catch (e) { return []; }
    }
    function rememberColor(c) {
        if (!/^#[0-9a-f]{6}$/i.test(String(c))) return;
        c = c.toLowerCase();
        try { localStorage.setItem(RECENT_KEY, JSON.stringify([c].concat(recentColors().filter(function (x) { return x.toLowerCase() !== c; })).slice(0, RECENT_MAX))); } catch (e) {}
    }
    function swatch(color, title, pick) {
        var b = h("button", "mc-sw"); b.type = "button"; b.title = title + " " + color;
        b.style.background = color;
        b.addEventListener("click", function (e) { e.preventDefault(); pick(color); });
        return b;
    }
    /**
     * Дополнения к полю цвета col: кнопка пипетки (взять цвет с экрана) и кнопка палитры (недавние
     * цвета и цвета темы). ctl — куда положить кнопки, row — строка, под которой раскрывается палитра.
     * Поле получает обычное событие input — дальше работает его собственный обработчик.
     */
    function colorExtras(col, ctl, row) {
        var set = function (c) { col.value = hex6(c); col.dispatchEvent(new Event("input", { bubbles: true })); col.dispatchEvent(new Event("change", { bubbles: true })); };
        col.addEventListener("change", function () { rememberColor(col.value); });
        if (typeof window.EyeDropper === "function") {
            var eye = h("button", "mc-x", "◉"); eye.type = "button"; eye.title = "Пипетка: взять цвет с любого места экрана";
            eye.addEventListener("click", function (e) {
                e.preventDefault();
                try { new window.EyeDropper().open().then(function (r) { if (r && r.sRGBHex) set(r.sRGBHex); }, function () {}); } catch (err) { toast("Пипетка цвета недоступна в этой версии VS Code", "warn"); }
            });
            ctl.appendChild(eye);
        }
        var pal = h("button", "mc-x", "▾"); pal.type = "button"; pal.title = "Недавние цвета и цвета темы";
        var strip = null;
        pal.addEventListener("click", function (e) {
            e.preventDefault();
            if (strip) { strip.remove(); strip = null; return; }
            strip = h("div", "mc-swatches");
            var vars = themeVars(), seen = {};
            recentColors().forEach(function (c) { seen[c] = 1; strip.appendChild(swatch(c, "недавний", set)); });
            THEME_SWATCHES.forEach(function (n) {
                var c = vars[n] && rgba(vars[n]) ? hex6(vars[n]) : "";
                if (!c || seen[c]) return;
                seen[c] = 1;
                strip.appendChild(swatch(c, "тема: " + tokenToId(n), set));
            });
            if (!strip.childNodes.length) strip.appendChild(h("span", "mc-note", "цветов пока нет"));
            if (row.parentNode) row.parentNode.insertBefore(strip, row.nextSibling);
        });
        ctl.appendChild(pal);
    }

    // ---- состояние элемента: правка только под мышью, в фокусе или при нажатии
    var STATE_RE = /:(hover|focus-within|active)$/;
    var STATE_TITLES = [["", "Всегда"], ["hover", "Под мышью"], ["focus-within", "В фокусе"], ["active", "Пока нажат"]];
    function splitState(sel) { var m = STATE_RE.exec(sel || ""); return m ? { base: sel.slice(0, m.index), state: m[1] } : { base: sel || "", state: "" }; }
    /** Селектор без состояния — для подсчёта совпадений и отпечатка (под мышью сейчас никого нет). */
    function stripState(sel) { return splitState(sel).base; }
    function stateSection() {
        var cur = splitState(des.sel);
        var sec = section("Состояние", "Правки ниже сработают только в этом состоянии: например, кнопка ярче под мышью.");
        var s = h("select");
        STATE_TITLES.forEach(function (o) { var op = h("option", null, o[1]); op.value = o[0]; s.appendChild(op); });
        s.value = cur.state;
        s.addEventListener("change", function () { des.sel = cur.base + (s.value ? ":" + s.value : ""); renderPanel(true); });
        var row = h("div", "mc-row"); row.appendChild(s);
        sec.appendChild(row);
    }

    // ---- выключить правило, не удаляя
    function setRuleOff(sel, off) {
        var r = DS.rules[sel];
        if (!r) return;
        if (off) r.off = true; else delete r.off;
        queueOp("toggle|" + sel, { op: "toggleRule", selector: sel, off: !!off });
        renderDesignCss();
    }

    // ---- части профиля и переименование (карточка профиля во вкладке «Профили»)
    var PROFILE_PARTS = [["rules", "Элементы"], ["settings", "Настройки"], ["colors", "Цвета"], ["fx", "Эффекты"], ["buttons", "Кнопки"]];
    function profileExtras(card, name, own) {
        var det = h("details");
        det.appendChild(h("summary", null, own ? "Часть профиля, имя" : "Взять только часть"));
        det.appendChild(h("div", "mc-note", "Добавить к текущему виду только выбранное — остальное не тронется, профиль не переключится."));
        var bs = h("div", "mc-btns");
        PROFILE_PARTS.forEach(function (p) {
            bs.appendChild(btn(p[1], "", function () { profileOp({ op: "applyProfile", name: name, only: [p[0]] }, "Из профиля «" + name + "» взято: " + p[1].toLowerCase()); }));
        });
        det.appendChild(bs);
        if (own) {
            var line = h("div", "mc-row"); line.style.marginTop = "6px";
            var inp = h("input"); inp.type = "text"; inp.value = name; inp.maxLength = 40;
            var go = function () {
                var to = inp.value.trim();
                if (!to || to === name) return;
                profileOp({ op: "renameProfile", from: name, to: to }, "Профиль переименован: «" + to + "»");
            };
            inp.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); go(); } });
            line.appendChild(inp);
            line.appendChild(btn("Переименовать", "", go));
            det.appendChild(line);
        }
        card.appendChild(det);
    }
