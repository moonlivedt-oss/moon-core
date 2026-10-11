// ============================================================
//  «Скорость VS Code»: советы по настройкам и выгрузка замеров — модель без vscode.
//
//  Совет предлагается, только если настройка есть в этой версии VS Code (ctx.get().exists) и
//  только по фактам: тяжёлые папки нашлись сканированием, редакторы восстанавливались долго,
//  расширение активировалось медленно в нескольких запусках. Каждый совет можно применить и
//  вернуть как было (lib/ext/speed.js помнит прежние значения).
// ============================================================
"use strict";

const PM = require("./perf-model");

// Папка меньше MIN_HEAVY_FILES файлов слежению не мешает — совет про неё был бы шумом.
const SLOW_EXT_MS = 1000, SLOW_EDITORS_MS = 1500, AFFINITY_GROUP = 1, MIN_HEAVY_FILES = 200;

/** Покрыта ли папка (имя name, путь rel от корня) исключениями files.watcherExclude. */
function covered(exclude, name, rel) {
    const ex = exclude && typeof exclude === "object" ? exclude : {};
    const keys = ["**/" + name + "/**", "**/" + name, "**/" + name + "/*", name + "/**", name];
    if (rel) keys.push(rel, rel + "/**", "**/" + rel + "/**");
    return keys.some((k) => ex[k] === true);
}

/**
 * Советы: [{ id, title, why, key, target: "global"|"workspace", value, current }].
 * ctx:
 *   get(key)      -> { exists, value, workspace, global } — значение настройки по областям;
 *   hasWorkspace  — открыта папка (советы для папки пишутся в её настройки);
 *   heavy         — [{ name, rel, files, pattern }] из lib/perf-scan.js;
 *   editorsMs     — медиана восстановления редакторов (мс) или null;
 *   slowExt       — [{ id, avg, n, builtin }] из истории.
 */
function advise(ctx) {
    const out = [];
    const get = (k) => { const r = ctx.get(k); return r && r.exists ? r : null; };
    const heavy = (Array.isArray(ctx.heavy) ? ctx.heavy : []).filter((d) => d && (d.files || 0) >= MIN_HEAVY_FILES);
    const target = ctx.hasWorkspace ? "workspace" : "global";

    const w = get("files.watcherExclude");
    const missing = w ? heavy.filter((d) => !covered(w.value, d.name, d.rel)) : [];
    if (missing.length) {
        // Пишется только своя область (VS Code сливает объектные настройки областей сам).
        const base = (target === "workspace" ? w.workspace : w.global) || {};
        const add = {};
        missing.forEach((d) => { add[d.pattern] = true; });
        const names = Array.from(new Set(missing.map((d) => d.name)));
        const files = missing.reduce((n, d) => n + (d.files || 0), 0);
        out.push({
            id: "watcher", key: "files.watcherExclude", target: target, current: Object.assign({}, base), value: Object.assign({}, base, add),
            title: "Не следить за " + names.join(", "),
            why: "VS Code следит за каждым файлом папки, чтобы обновлять проводник, поиск и git. В " + names.join(", ") +
                " около " + files + "+ файлов, которые ты не правишь руками. Минус: проводник не будет сам замечать новые файлы в этих папках.",
        });
    }

    const sym = get("search.followSymlinks");
    if (sym && sym.value === true && heavy.some((d) => d.name === "node_modules")) {
        out.push({
            id: "symlinks", key: "search.followSymlinks", target: target, current: true, value: false,
            title: "Поиск без перехода по символическим ссылкам",
            why: "В node_modules (особенно у pnpm) ссылки ведут в общие папки пакетов: поиск ходит по ним и грузит процессор. Свои файлы проекта поиск найдёт как раньше.",
        });
    }

    const big = get("editor.largeFileOptimizations");
    if (big && big.value === false) {
        out.push({
            id: "largeFiles", key: "editor.largeFileOptimizations", target: "global", current: false, value: true,
            title: "Вернуть облегчённый режим для больших файлов",
            why: "Он выключен: большие файлы открываются с подсветкой, свёрткой и подсказками целиком — окно может вставать на секунды.",
        });
    }

    const lim = get("workbench.editor.limit.enabled");
    if (lim && lim.value !== true && ctx.editorsMs != null && ctx.editorsMs >= SLOW_EDITORS_MS) {
        out.push({
            id: "editorLimit", key: "workbench.editor.limit.enabled", target: "global", current: lim.value === true, value: true,
            title: "Ограничить число открытых вкладок",
            why: "Восстановление редакторов при старте занимает около " + Math.round(ctx.editorsMs / 100) / 10 + " с. С ограничением (по умолчанию 10 вкладок) старые вкладки закрываются сами, и окно открывается быстрее.",
        });
    }

    const aff = get("extensions.experimental.affinity");
    const slow = (Array.isArray(ctx.slowExt) ? ctx.slowExt : []).filter((e) => e && !e.builtin && e.n >= 2 && e.avg >= SLOW_EXT_MS && PM.EXT_ID_RE.test(e.id));
    const cur = aff && aff.value && typeof aff.value === "object" ? aff.value : {};
    const todo = slow.filter((e) => !(e.id in cur)).slice(0, 5);
    if (aff && todo.length) {
        const base = Object.assign({}, aff.global || {});
        todo.forEach((e) => { base[e.id] = AFFINITY_GROUP; });
        out.push({
            id: "affinity", key: "extensions.experimental.affinity", target: "global", current: Object.assign({}, aff.global || {}), value: base,
            title: "Тяжёлые расширения — в отдельный процесс",
            why: todo.map((e) => e.id + " (" + e.avg + " мс)").join(", ") + " активируются медленно. В отдельном процессе расширений они не задерживают остальные расширения и не тормозят их работу. Настройка экспериментальная: если что-то перестанет работать — «Вернуть».",
        });
    }
    return out;
}

/**
 * Замеры для внешних программ (например, VS Code Launcher): какие расширения сколько стоят на
 * старте. Схема стабильна: новые поля добавляются, старые не меняют смысла.
 */
function exportData(h, info) {
    const st = PM.startStats(h);
    const i = info || {};
    return {
        schema: "moon-core/perf@1",
        generated: new Date(i.now || Date.now()).toISOString(),
        vscode: String(i.vscode || (st.last && st.last.vs) || ""),
        window: { samples: st.n, readyMedianMs: PM.median(h.starts.slice(-20).map((s) => s.ready)), extensionsMedianMs: PM.median(h.starts.slice(-20).map((s) => s.extensions)) },
        extensions: PM.extStats(h).slice(0, 200).map((e) => ({ id: e.id, samples: e.n, avgMs: e.avg, maxMs: e.max, lastMs: e.last, activation: e.kind, eager: PM.EAGER.indexOf(e.kind) !== -1 })),
    };
}

module.exports = { advise, covered, exportData, SLOW_EXT_MS, SLOW_EDITORS_MS, AFFINITY_GROUP, MIN_HEAVY_FILES };
