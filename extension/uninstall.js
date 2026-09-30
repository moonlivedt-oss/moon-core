// ============================================================
//  Хук удаления (package.json -> scripts."vscode:uninstall").
//
//  VS Code запускает его голым Node без API расширений, когда расширение удалено и редактор
//  перезапущен. Наш блок впечатан в оболочку (workbench.html) и сам оттуда не уйдёт —
//  снимаем его. Чужие вставки (custom-css, cpp-docs-panel) не трогаем.
//
//  process.execPath — исполняемый файл VS Code; рядом лежит resources/app/out
//  (в новых сборках Windows — ещё и в подпапке с хэшем версии).
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { findWorkbenchIn, unpatchFile, TMP_EXT, restoreChecksum, checksumKey } = require("./lib/wb-patch");
const DP = require("./lib/deep");
const WV = require("./lib/webview-patch");

/** Снять глубокие патчи: крючок сервисов окна в бандле (и его хэш), импорт в main.js, скрипт главного процесса. */
function unpatchDeep(dir) {
    const bundle = path.join(dir, "vs", "workbench", "workbench.desktop.main.js");
    try {
        const t = fs.readFileSync(bundle, "utf8");
        if (DP.hasDi(t)) { fs.writeFileSync(bundle, DP.stripBundle(t), "utf8"); restoreChecksum(path.dirname(dir), checksumKey(dir, bundle)); }
    } catch (e) { /* файла нет или нет прав */ }
    const main = path.join(dir, "main.js");
    try { const t = fs.readFileSync(main, "utf8"); if (DP.hasMain(t)) fs.writeFileSync(main, DP.stripMain(t), "utf8"); } catch (e) {}
    try { fs.unlinkSync(path.join(dir, DP.MAIN_FILE)); } catch (e) {}
    // Стили webview: наша вставка в основе webview — прочь, хэш скрипта возвращается.
    const wv = WV.fileIn(dir);
    try { const t = fs.readFileSync(wv, "utf8"); if (WV.hasPatch(t)) fs.writeFileSync(wv, WV.strip(t), "utf8"); } catch (e) {}
}

function outDirs() {
    const exeDir = path.dirname(process.execPath);
    const bases = [exeDir, path.join(exeDir, "..")];
    try {
        fs.readdirSync(exeDir, { withFileTypes: true }).forEach((d) => { if (d.isDirectory()) bases.push(path.join(exeDir, d.name)); });
    } catch (e) { /* каталог недоступен — хватит основных */ }
    const out = [];
    bases.forEach((b) => {
        ["resources", "Resources"].forEach((r) => {
            const o = path.join(b, r, "app", "out");
            if (fs.existsSync(o) && out.indexOf(o) === -1) out.push(o);
        });
    });
    return out;
}

function main() {
    let done = 0;
    outDirs().forEach((dir) => {
        // Оболочка и окно сессий; вместе с блоком уходят файлы модулей рядом и возвращается
        // исходный хэш оболочки в product.json (из бэкапа, который сделал Moon Core).
        findWorkbenchIn(dir, 6, true).forEach((f) => {
            let clean = true;
            try { if (unpatchFile(f)) done++; } catch (e) { clean = false; console.log("moon-core: нет прав на " + f + " (" + e.code + ")"); }
            try { fs.unlinkSync(f + TMP_EXT); } catch (e) { /* хвоста нет */ }
            // Исходный хэш — только если блок действительно снят: иначе он не сойдётся с оболочкой.
            if (clean) { try { restoreChecksum(path.dirname(dir), checksumKey(dir, f)); } catch (e) { /* бэкапа нет — хэш не трогали */ } }
        });
        unpatchDeep(dir);
    });
    console.log("moon-core: блок снят из оболочки VS Code: " + done);
}

if (require.main === module) main();
module.exports = { outDirs, main, unpatchDeep };
