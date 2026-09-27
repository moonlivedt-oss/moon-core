// Модуль-зонд для прогона в настоящем VS Code (test/e2e). Доказывает, что модуль выполнился в
// окне, и по запросу хоста («probe») сообщает, что окно видит: есть ли элемент и его стиль.
// Ответы идут через файл данных модуля (mc.saveData) — его хост читает сам.
(function () {
    "use strict";
    var mc = window.__MOONCORE__ && window.__MOONCORE__.module("e2e-probe");
    if (!mc) return;
    var state = { started: Date.now(), workbench: false, probe: null };

    // Моста в момент запуска ещё нет: ждём связи и тогда отчитываемся.
    // Хост может узнать о модуле чуть позже окна — повторяем, пока запись не примут.
    var busy = false;
    var t = setInterval(function () {
        if (busy || !mc.connected()) return;
        busy = true;
        state.workbench = !!document.querySelector(".monaco-workbench");
        mc.saveData(state).then(function (r) { busy = false; if (r && r.ok) clearInterval(t); });
    }, 500);

    // Шлюз к API VS Code: настоящий элемент статусбара от имени модуля.
    var nat = setInterval(function () {
        if (!mc.connected()) return;
        clearInterval(nat);
        mc.vscode.statusItem("probe", { text: "$(beaker) e2e", tooltip: "зонд Moon Core" }).then(function (r) { state.native = !!(r && r.ok); mc.saveData(state); });
    }, 500);

    // Ленивый интерфейс: до открытия конструктора чанка нет, открытие грузит его в настоящем окне.
    mc.on("probeUi", function (d) {
        var MC = window.__MOONCORE__;
        state.ui = { id: d && d.id, before: MC.info().ui };
        MC.startDesign();
        setTimeout(function () {
            state.ui.after = MC.info().ui;
            state.ui.panel = !!document.querySelector("[data-mooncore-ui=design]");
            MC.stopDesign();
            state.ui.closed = !document.querySelector("[data-mooncore-ui=design]");
            mc.saveData(state);
        }, 1500);
    });

    mc.on("probe", function (d) {
        if (!d || typeof d.selector !== "string") return;
        var el = null;
        try { el = document.querySelector(d.selector); } catch (e) {}
        var cs = el ? getComputedStyle(el) : null;
        state.probe = {
            id: d.id, found: !!el, opacity: cs ? cs.opacity : null, display: cs ? cs.display : null, bg: cs ? cs.backgroundColor : null,
            button: !!document.querySelector(".part.statusbar [data-mooncore-btn]"),
            lang: document.documentElement.getAttribute("data-mc-lang") || "",
            svc: !!(mc.service && mc.service("statusbarService")),
            svcCount: window.__MOONCORE__.services ? window.__MOONCORE__.services.names().length : 0,
        };
        mc.saveData(state);
    });
})();
