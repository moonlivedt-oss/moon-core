// Демо-модуль для стенда: так модуль пользуется помощником Moon Core.
// Итог пишет в window.__DEMO__ (для проверки) и в пункт статусбара.
(function () {
    "use strict";
    var mc = window.__MOONCORE__ && window.__MOONCORE__.module("demo");
    var out = window.__DEMO__ = { api: !!mc, base: mc ? mc.base : "", events: [], rpc: null, missing: window.__MOONCORE__.module("nope") };
    if (!mc) return;
    mc.on("live", function (d) { out.events.push(d); show("live: " + JSON.stringify(d)); });
    mc.rpc("double", { n: 21 }).then(function (r) { out.rpc = r; });
    function show(text) {
        var bar = document.querySelector(".statusbar .right-items");
        if (!bar) return;
        var el = document.getElementById("mc-demo") || bar.appendChild(Object.assign(document.createElement("div"), { id: "mc-demo", className: "statusbar-item" }));
        el.textContent = text;
    }
})();
