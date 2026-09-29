// Ленивый модуль-зонд (test/e2e): не грузится при старте окна. Команда «ping» загружает его
// настоящим <script src> с integrity; модуль отвечает словом под курсором (право editor.read),
// ставит подсветку (право decorations) и подписывается на события VS Code.
(function () {
    "use strict";
    var mc = window.__MOONCORE__ && window.__MOONCORE__.module("e2e-lazy");
    if (!mc) return;
    var state = { loadedAt: Date.now() };
    function save() { mc.saveData(state); }
    mc.commands.on("ping", function (ctx) {
        state.ping = { word: ctx.word || "", lang: ctx.lang || "" };
        mc.vscode.symbol("word").then(function (r) {
            state.symbol = r && r.ok ? r.result : "!" + (r && r.error);
            return mc.vscode.decorate("e2e", { backgroundColor: "#ff00ff33" }, [{ line: 0 }]);
        }).then(function (r) {
            state.decorate = !!(r && r.ok && r.applied === 1);
            save();
        });
    });
    mc.vscode.on("editor", function (d) { state.editor = d; save(); });
    mc.onDispose(function () { state.disposed = true; });
})();
