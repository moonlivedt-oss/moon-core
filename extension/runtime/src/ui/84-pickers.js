    // ---- то, что окно VS Code знает о себе само: все значки codicon и все цвета темы.
    //      Списки берутся из загруженных стилей и переменных темы этой версии VS Code — руками не ведутся.

    var codiconCache = null;
    /** Имена всех значков codicon из стилей окна (отсортированы); пусто — запасной короткий список. */
    function allCodicons() {
        if (codiconCache) return codiconCache;
        var out = {};
        var walk = function (rules) {
            for (var i = 0; rules && i < rules.length; i++) {
                var r = rules[i];
                if (r.cssRules && !r.selectorText) { walk(r.cssRules); continue; }
                var st = r.selectorText;
                if (!st || st.indexOf(".codicon-") === -1) continue;
                var re = /\.codicon-([a-z0-9-]{1,40}):{1,2}before/g, m;
                while ((m = re.exec(st))) out[m[1]] = 1;
            }
        };
        try { Array.prototype.forEach.call(document.styleSheets || [], function (sh) { try { walk(sh.cssRules); } catch (e) {} }); } catch (e) {}
        var list = Object.keys(out).sort();
        codiconCache = list.length > 20 ? list : ICONS.slice();
        return codiconCache;
    }

    /** Выбор значка: поиск по имени и сетка. pick(name) — выбранный значок. */
    function iconPicker(current, pick) {
        var det = h("details");
        det.appendChild(h("summary", null, "Все значки VS Code"));
        var inp = h("input", "mc-search"); inp.type = "text"; inp.placeholder = "Имя значка по-английски: git, debug, arrow…"; inp.spellcheck = false;
        inp.style.margin = "0 0 6px"; inp.style.width = "100%";
        var grid = h("div", "mc-icons"), note = h("div", "mc-note");
        var draw = function () {
            var q = inp.value.trim().toLowerCase(), all = allCodicons();
            var list = q ? all.filter(function (n) { return n.indexOf(q) !== -1; }) : ICONS.filter(function (n) { return all.indexOf(n) !== -1; });
            grid.textContent = "";
            list.slice(0, 96).forEach(function (n) {
                var b = h("button", "mc-ico" + (n === current ? " on" : "")); b.type = "button"; b.title = n;
                b.appendChild(h("span", "codicon codicon-" + n));
                b.addEventListener("click", function (e) { e.preventDefault(); pick(n); });
                grid.appendChild(b);
            });
            note.textContent = q ? (list.length ? "найдено: " + list.length + (list.length > 96 ? ", показаны первые 96" : "") : "ничего не найдено") : "всего значков: " + all.length + " — начни вводить имя";
        };
        inp.addEventListener("input", draw);
        det.addEventListener("toggle", function () { if (det.open && !grid.childNodes.length) draw(); });
        det.appendChild(inp); det.appendChild(grid); det.appendChild(note);
        return det;
    }

    // ---- выбор: несколько элементов сразу, похожие элементы, показать скрытое, поиск в правках
    /** Shift+клик: добавить элемент к выбранным — правки пойдут на все (селекторы через запятую). */
    function addToSelection(el) {
        var add = selectorFor(el);
        if (!add) return;
        var parts = des.sel.split(/\s*,\s*/);
        if (parts.indexOf(add) !== -1) { toast("Этот элемент уже выбран"); return; }
        if ((des.sel + ", " + add).length > 560) { toast("Слишком много элементов для одной правки", "warn"); return; }
        des.sel = des.sel + ", " + add;
        des.multi = parts.length + 1;
        des.entry = null; des.anchor = null;
        des.tab = "el";
        renderPanel(true);
        highlight(des.sel, false);
    }
    /** Кнопка «Похожие (N)»: все элементы с тем же классом в той же части окна. */
    function similarButton(nav) {
        var el = des.selEl;
        if (!el || des.multi > 1) return;
        var cls = stableClasses(el)[0], part = el.closest ? el.closest(".part") : null;
        if (!cls || !part) return;
        var sel = segment(part).text + " ." + cssEsc(cls), n = count(sel);
        if (n < 2 || n === Infinity || n > 200 || sel === des.sel) return;
        nav.appendChild(btn("Похожие (" + n + ")", "", function () { des.sel = sel; des.entry = null; renderPanel(true); highlight(sel, false); }, "Все элементы с классом ." + cls + " в этой части окна"));
    }
    function showHiddenButton() {
        var b = btnPlain("Скрытое", function () {
            des.showHidden = !des.showHidden;
            b.style.background = des.showHidden ? "color-mix(in srgb, currentColor 22%, transparent)" : "";
            renderDesignCss();
            toast(des.showHidden ? "Скрытые элементы показаны бледными — кликни, чтобы выбрать и вернуть" : "Скрытые элементы снова скрыты");
        });
        b.title = "Показать элементы, скрытые правками: их можно выбрать и вернуть";
        return b;
    }
    /** Поиск по списку правок (появляется, когда правок много): карточки прячутся на месте. */
    function changesSearch() {
        if (Object.keys(DS.rules).length < 6) return;
        var inp = h("input", "mc-search"); inp.type = "text"; inp.placeholder = "Найти правку: элемент, селектор, свойство…"; inp.spellcheck = false;
        inp.value = des.changesQuery || "";
        var apply = function () {
            var q = inp.value.trim().toLowerCase();
            des.changesQuery = inp.value;
            Array.prototype.forEach.call(des.panel.querySelectorAll(".mc-card"), function (c) { c.style.display = !q || String(c.textContent).toLowerCase().indexOf(q) !== -1 ? "" : "none"; });
        };
        inp.addEventListener("input", apply);
        des.panel.appendChild(inp);
        if (des.changesQuery) setTimeout(apply, 0);
    }

    /**
     * Секция «Любой цвет темы» во вкладке «Ещё»: поиск по всем цветам темы VS Code (их сотни) и
     * правка найденного — в штатную workbench.colorCustomizations, как и остальные цвета темы.
     */
    function allColorsSection() {
        var sec = section("Любой цвет темы", "Все цвета, которыми VS Code красит интерфейс. Начни вводить: statusBar, tab, sideBar, button, terminal…");
        var inp = h("input", "mc-search"); inp.type = "text"; inp.placeholder = "Имя цвета: tab.activeBackground"; inp.spellcheck = false;
        inp.style.margin = "0 0 6px"; inp.style.width = "100%";
        inp.value = des.colorQuery || "";
        var box = h("div"), note = h("div", "mc-note");
        var draw = function () {
            var q = inp.value.trim().toLowerCase().replace(/\./g, "-");
            des.colorQuery = inp.value;
            box.textContent = "";
            if (q.length < 2) { note.textContent = "Изменённые цвета — во вкладке «Правки»."; return; }
            var vars = themeVars();
            var names = Object.keys(vars).filter(function (n) { return n.toLowerCase().indexOf(q) !== -1 && rgba(vars[n]); }).sort(function (a, b) { return a.length - b.length || (a < b ? -1 : 1); });
            names.slice(0, 12).forEach(function (n) {
                var id = tokenToId(n);
                box.appendChild(colorRow("wb:" + id, id, n, "Цвет темы: " + id));
            });
            note.textContent = names.length ? "найдено: " + names.length + (names.length > 12 ? ", показаны первые 12 — уточни запрос" : "") : "такого цвета в этой теме нет";
        };
        inp.addEventListener("input", draw);
        sec.appendChild(inp); sec.appendChild(box); sec.appendChild(note);
        draw();
    }
