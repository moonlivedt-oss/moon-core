// ============================================================
//  Слежение за модулями: хабу — список разрешённых, оболочке — обновлённый блок. Следим за
//  установкой расширений, настройкой moonCore.modules и за файлами рантаймов (пересобрал
//  модуль — блок обновится; в режиме разработки окно перезапускает модуль сразу).
// ============================================================
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const inject = require("../inject");
const MH = require("../module-host");
const M = require("../modules");
const { log } = require("../log");
const { watchFile } = require("../fsx");

/** Запустить слежение. Возвращает refresh(askFirst) — пересобрать список и блок сейчас. */
function watchModules(context, host) {
    let watchers = [], timer = null;
    const touched = new Set();     // id модулей, чей скрипт изменился с прошлого обновления
    const devSha = new Map();      // id -> sha кода, который окна уже выполняют (режим разработки)
    const closeAll = () => { watchers.forEach((w) => { try { w.close(); } catch (e) {} }); watchers = []; };

    const refresh = (askFirst) => {
        const list = MH.allowed(context, MH.discover());
        host.modules.setModules(list);
        host.broadcastModuleSet();
        closeAll();
        // Слежение через папку скрипта: редакторы сохраняют «атомарно» (запись рядом + rename),
        // и watch на самом файле после первого сохранения замолкает.
        list.forEach((m) => {
            try { watchers.push(watchFile(m.script, () => schedule(false, m.id), (e) => log("слежение за модулем " + m.id, e))); }
            catch (e) { log("слежение за модулем " + m.id, e); }
        });
        // Режим разработки: код изменился — окна перезапускают модуль сразу (горячая перезагрузка),
        // а блок в оболочке обновляется молча, для следующего запуска.
        list.filter(MH.isDev).forEach((m) => {
            let sha = "";
            try { sha = M.sha256(fs.readFileSync(m.script, "utf8")); } catch (e) { return; }
            if (devSha.has(m.id) && devSha.get(m.id) !== sha) host.bridge.broadcast("moduleReload", { id: m.id, sha: sha });
            devSha.set(m.id, sha);
        });
        const ids = Array.from(touched);
        touched.clear();
        const quiet = ids.length > 0 && ids.every((id) => MH.isDev(list.find((m) => m.id === id)));
        return inject.syncModules(context, askFirst, { quiet: quiet }).catch((e) => log("модули", e));
    };
    const schedule = (askFirst, id) => { if (id) touched.add(id); clearTimeout(timer); timer = setTimeout(() => refresh(askFirst), 800); };

    context.subscriptions.push(
        vscode.extensions.onDidChange(() => schedule(true)),
        vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("moonCore.modules")) schedule(true); }),
        { dispose: () => { clearTimeout(timer); closeAll(); } },
    );
    return refresh;
}

module.exports = { watchModules };
