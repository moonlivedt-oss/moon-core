    // ---------------------------------------------------------------------------
    //  Страховки окна.
    //
    //  «Стоп-кран»: Ctrl+Alt+Shift+Backspace выключает в этом окне все стили Moon Core
    //  (сниппеты, правки конструктора, эффекты) — и включает обратно. Работает без расширения и
    //  без моста: если правка спрятала что-то нужное, до конструктора можно добраться. Ничего не
    //  удаляется и не сохраняется: после перезагрузки окна стили снова на месте.
    //
    //  Безопасный режим (его включает расширение, флаг приходит в состоянии): сниппеты, правки
    //  и модули не работают во всех окнах; в углу окна — напоминание.
    // ---------------------------------------------------------------------------
    var panicOn = false, safeEl = null;

    function ourStyleNodes() {
        var list = Object.keys(styles).map(function (id) { return styles[id]; });
        if (designStyle) list.push(designStyle);
        if (fx.style) list.push(fx.style);
        try { Array.prototype.forEach.call(document.querySelectorAll("style[data-mooncore-js]"), function (s) { list.push(s); }); } catch (e) {}
        return list;
    }
    function applyPanic() {
        var media = panicOn ? "not all" : "";
        ourStyleNodes().forEach(function (s) { try { s.media = media; } catch (e) {} });
        if (fx.canvas) fx.canvas.style.display = panicOn ? "none" : "";
    }
    function setPanic(on) {
        panicOn = !!on;
        applyPanic();
        toast(panicOn ? "Moon Core: стили отключены в этом окне. Ctrl+Alt+Shift+Backspace — включить обратно." : "Moon Core: стили снова включены.", panicOn ? "warn" : "");
        return panicOn;
    }
    function onPanicKey(e) {
        if (!e || e.key !== "Backspace" || !e.ctrlKey || !e.altKey || !e.shiftKey) return;
        try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
        setPanic(!panicOn);
    }
    try { window.addEventListener("keydown", onPanicKey, true); } catch (e) {}

    /** Напоминание о безопасном режиме в углу окна (и его снятие, когда режим выключили). */
    function safeBadge() {
        if (!SAFE) { if (safeEl) { try { safeEl.remove(); } catch (e) {} safeEl = null; } return; }
        if (safeEl || !document.body) return;
        safeEl = document.createElement("div");
        safeEl.setAttribute("data-mooncore-ui", "safe");
        safeEl.textContent = "Moon Core: безопасный режим";
        safeEl.title = "Сниппеты, правки конструктора и модули отключены. Выйти: значок Moon в статусбаре — «Безопасный режим».";
        Object.assign(safeEl.style, {
            position: "fixed", left: "10px", bottom: "30px", zIndex: String(Z + 4), padding: "3px 10px", borderRadius: "10px",
            font: "11px/1.5 var(--vscode-font-family, sans-serif)", pointerEvents: "auto", cursor: "default",
            background: "var(--vscode-statusBarItem-warningBackground, #d29922)", color: "var(--vscode-statusBarItem-warningForeground, #11111b)",
            boxShadow: "0 4px 14px rgba(0,0,0,.35)",
        });
        document.body.appendChild(safeEl);
    }
