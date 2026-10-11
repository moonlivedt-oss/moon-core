// ============================================================
//  Поиск модулей: папки из настройки moonCore.modules и расширения с полем moonCore в
//  package.json. С кэшем: поиск зовут часто (статусбар, Доктор, проверка внедрения).
// ============================================================
"use strict";

const vscode = require("vscode");
const path = require("path");
const M = require("./modules");
const { log } = require("./log");
const { statKey } = require("./fsx");

// Поиск зовут статусбар (раз в 5 с), Доктор и проверка внедрения. Без кэша он каждый раз читал
// манифесты из папок и писал в журнал одни и те же ошибки: у пользователя журнал вырос до
// 5000 строк «такой id уже есть». Кэш — по настройке, списку расширений и времени манифестов;
// ошибка пишется в журнал один раз за сеанс.
let found = { key: "", modules: [], errors: [], dups: [] };
const loggedErrors = new Set();

function discoverKey(dirs) {
    const exts = vscode.extensions.all.filter((e) => e.packageJSON && e.packageJSON.moonCore)
        .map((e) => e.id + "@" + e.packageJSON.version + "@" + e.extensionPath);
    return JSON.stringify(dirs) + "#" + exts.join(",") + "#" +
        statKey(dirs.filter((d) => typeof d === "string" && d.trim()).map((d) => path.join(d.trim(), M.MODULE_FILE)));
}

/**
 * Все найденные модули: из папок настройки moonCore.modules и из расширений
 * (package.json -> moonCore.modules). Папки идут первыми и при совпадении id побеждают:
 * так при разработке берётся свежая сборка из репозитория, а не копия в установленном расширении.
 */
function discover() {
    const raw = vscode.workspace.getConfiguration("moonCore").get("modules", []);
    const dirs = (Array.isArray(raw) ? raw : []).slice(0, M.LIMITS.MAX_MODULES);
    const key = discoverKey(dirs);
    if (found.key === key) return found.modules.slice();
    const results = [];
    dirs.forEach((d) => {
        if (typeof d === "string" && d.trim()) results.push(M.fromFolder(d.trim()));
    });
    vscode.extensions.all.forEach((ext) => {
        const pkg = ext.packageJSON;
        if (pkg && pkg.moonCore) results.push(...M.fromPackage(pkg, ext.extensionPath, ext.id));
    });
    const r = M.collect(results);
    r.errors.forEach((e) => { if (!loggedErrors.has(e)) { loggedErrors.add(e); log("модули: " + e); } });
    found = { key: key, modules: r.modules, errors: r.errors, dups: r.dups || [] };
    return r.modules.slice();
}
/** Ошибки последнего поиска модулей (дубли id, нечитаемые манифесты) — для Доктора. */
function discoverErrors() { discover(); return found.errors.slice(); }
/** Модули, найденные дважды (папка и расширение с тем же id): [{ id, used, skipped }]. */
function discoverDups() { discover(); return found.dups.slice(); }
function resetDiscoverCache() { found = { key: "", modules: [], errors: [], dups: [] }; loggedErrors.clear(); }

module.exports = { discover, discoverErrors, discoverDups, resetDiscoverCache };
