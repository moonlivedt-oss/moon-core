// ============================================================
//  Файлы самой установки VS Code — только чтение, без vscode.
//
//  1. Целостность. VS Code хранит в product.json хэши своих главных файлов. Здесь по каждому
//     видно: исходный, изменён только Moon Core (за вычетом нашего блока или крючка файл равен
//     исходному) или изменён кем-то ещё. Плюс файл-основа webview (в хэши product.json он не
//     входит, но у него свой хэш в CSP) и посторонние файлы рядом с оболочкой — следы других
//     загрузчиков и старые бэкапы.
//
//  2. Классы. После обновления VS Code правило может ничего не находить по двум причинам:
//     элемент просто не показан — или его класс переименовали. Вторую причину можно отличить
//     без окна: имени класса, которого нет ни в CSS, ни в коде воркбенча, в этой версии
//     VS Code нет вовсе.
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const W = require("./wb-patch");
const DP = require("./deep");
const WV = require("./webview-patch");

const BUNDLE_KEY = "vs/workbench/workbench.desktop.main.js";
const CSS_KEY = "vs/workbench/workbench.desktop.main.css";
// Чьи это следы рядом с оболочкой (по имени файла).
const LEFTOVERS = [
    [/custom-ui-style/i, "Custom UI Style"],
    [/^external(\.module)?\.(js|css)$/i, "Custom UI Style"],
    [/cppdocs/i, "cpp-docs-panel"],
    [/\.bak-custom-css$|custom-css/i, "Custom CSS and JS Loader"],
];

function read(file) { try { return fs.readFileSync(file); } catch (e) { return null; } }

/** Исходные хэши: из бэкапа product.json (его сделал Moon Core до своих правок), иначе текущие. */
function originalSums(appDir) {
    const prod = path.join(appDir, W.PRODUCT);
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(prod, "utf8")); } catch (e) { return null; }
    const bak = W.productBackup(prod);
    return Object.assign({}, (cur && cur.checksums) || {}, (bak && bak.checksums) || {});
}

/**
 * Состояние файлов установки. appDir — .../resources/app.
 * { files: [{ key, state }], webview: { state, file }, extra: [{ name, size, owner }], backupPristine }
 * state: "clean" — исходный; "mooncore" — отличается только правкой Moon Core;
 *        "foreign" — изменён кем-то ещё; "missing" — файла нет.
 */
function integrity(appDir) {
    const out = { files: [], webview: { state: "missing", file: "", cspOff: false }, extra: [], backupPristine: null };
    const sums = originalSums(appDir);
    if (!sums) return out;
    const outDir = path.join(appDir, "out");
    Object.keys(sums).slice(0, 64).forEach((key) => {
        const file = path.join(outDir, key);
        const buf = read(file);
        if (!buf) { out.files.push({ key: key, state: "missing" }); return; }
        if (W.productChecksum(buf) === sums[key]) { out.files.push({ key: key, state: "clean" }); return; }
        let bare = null;
        if (/\.html$/.test(key)) { const t = buf.toString("utf8"); if (W.isInjected(t)) bare = W.stripBlock(t); }
        else if (key === BUNDLE_KEY) { const t = buf.toString("utf8"); if (DP.hasDi(t)) bare = DP.stripBundle(t); }
        const ours = bare != null && W.productChecksum(Buffer.from(bare, "utf8")) === sums[key];
        const rec = { key: key, state: ours ? "mooncore" : "foreign", ours: bare != null };
        // Оболочка без политики безопасности: meta-тег CSP удалил другой загрузчик (так делает Custom CSS and JS Loader).
        if (!ours && /\/workbench\.html$/.test(key) && !/http-equiv\s*=\s*["']Content-Security-Policy["']/i.test(bare != null ? bare : buf.toString("utf8"))) rec.noCsp = true;
        out.files.push(rec);
    });

    const wv = WV.fileIn(outDir);
    const wt = read(wv);
    out.webview.file = wv;
    if (wt) {
        const t = wt.toString("utf8");
        // Своей меры «исходности» у файла нет — есть согласованность: хэш скрипта равен хэшу в CSP.
        out.webview.cspOff = WV.cspDisabled(t);
        if (out.webview.cspOff) out.webview.state = "foreign";
        else out.webview.state = WV.hasPatch(t) ? (WV.hashOk(t) && WV.hashOk(WV.strip(t)) ? "mooncore" : "foreign") : (WV.hashOk(t) ? "clean" : "foreign");
    }

    // Посторонние файлы рядом с оболочкой и основой webview.
    const shells = Object.keys(sums).filter((k) => /\/workbench\.html$/.test(k));
    const dirs = shells.map((k) => path.dirname(path.join(outDir, k))).concat([path.dirname(wv), outDir, appDir]);
    const known = new Set(Object.keys(sums).map((k) => path.join(outDir, k)).concat([wv]));
    dirs.forEach((dir, i) => {
        let names = [];
        try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name); } catch (e) { return; }
        names.forEach((name) => {
            const file = path.join(dir, name);
            if (known.has(file) || name.indexOf(W.MOD_FILE_PREFIX) === 0 || /\.mooncore-(backup|tmp)$/.test(name) || name === DP.MAIN_FILE) return;
            const hit = LEFTOVERS.find((l) => l[0].test(name));
            // В каталогах out и app лежит много своих файлов VS Code — там берём только узнанные следы.
            if (!hit && i >= shells.length) return;
            let size = 0;
            try { size = fs.statSync(file).size; } catch (e) {}
            out.extra.push({ name: path.relative(appDir, file).split(path.sep).join("/"), size: size, owner: hit ? hit[1] : "" });
        });
    });

    // Бэкап оболочки: он «исходный», только если снят с нетронутого файла.
    if (shells.length) {
        const f = path.join(outDir, shells[0]);
        const bak = read(f + W.BAK_EXT);
        if (bak) out.backupPristine = W.productChecksum(bak) === sums[shells[0]];
    }
    return out;
}

/** Коротко для Доктора: { foreign: [ключи], leftovers: [{name,size,owner}], webview, backupPristine }. */
function integritySummary(appDir) {
    const r = integrity(appDir);
    return {
        total: r.files.length,
        foreign: r.files.filter((f) => f.state === "foreign").map((f) => f.key),
        missing: r.files.filter((f) => f.state === "missing").map((f) => f.key),
        mooncore: r.files.filter((f) => f.state === "mooncore").map((f) => f.key),
        webview: r.webview.state,
        webviewCspOff: r.webview.cspOff,
        shellNoCsp: r.files.some((f) => f.noCsp),
        leftovers: r.extra.slice(0, 40),
        backupPristine: r.backupPristine,
    };
}

// ------------------------------------------------------------------ классы

/** Имена классов из селектора (без содержимого [..], кавычек и :is(...) не разбираем — там тоже классы). */
function selectorClasses(selector) {
    let s = String(selector || ""), out = [], quote = "", depth = 0, bare = "";
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === "\\") { bare += "  "; i++; continue; }          // экранированный символ — не точка класса
        if (quote) { if (ch === quote) quote = ""; continue; }
        if (ch === "\"" || ch === "'") { quote = ch; continue; }
        if (ch === "[") { depth++; continue; }
        if (ch === "]") { depth = Math.max(0, depth - 1); continue; }
        if (!depth) bare += ch;
    }
    const re = /\.(-?[A-Za-z_][\w-]*)/g;
    let m;
    while ((m = re.exec(bare))) if (out.indexOf(m[1]) === -1) out.push(m[1]);
    return out;
}

/**
 * Индекс классов установки: текст CSS и кода воркбенча. has(name) — встречается ли имя хоть где-то.
 * Тексты большие (десятки МБ) — индекс живёт, пока идёт одна проверка, и не кэшируется.
 */
function classIndex(appDir) {
    const outDir = path.join(appDir, "out");
    const css = read(path.join(outDir, CSS_KEY)), js = read(path.join(outDir, BUNDLE_KEY));
    if (!css || !js) return null;
    const texts = [css.toString("latin1"), js.toString("latin1")];
    return { has: (name) => texts.some((t) => t.indexOf(name) !== -1) };
}

let namesCache = { key: "", value: null };
/**
 * Имена из CSS воркбенча этой установки: { classes: [...], vars: ["--vscode-..."] } — для подсказок
 * в редакторе сниппета. Кэш — по размеру и времени изменения файла (он меняется только с VS Code).
 */
function cssNames(appDir) {
    const file = path.join(appDir, "out", CSS_KEY);
    let key = "";
    try { const st = fs.statSync(file); key = file + "|" + st.size + "|" + st.mtimeMs; } catch (e) { return null; }
    if (namesCache.key === key) return namesCache.value;
    const text = fs.readFileSync(file, "utf8");
    const classes = new Set(), vars = new Set();
    let m;
    const cre = /\.(-?[A-Za-z_][\w-]{1,60})(?=[\s.,:>+~{\[)#])/g;
    while ((m = cre.exec(text))) { if (!/^\d/.test(m[1]) && !/^(png|svg|ttf|woff2?|css|js|gif|jpg)$/.test(m[1])) classes.add(m[1]); }
    const vre = /--vscode-[\w-]{1,80}/g;
    while ((m = vre.exec(text))) vars.add(m[0]);
    namesCache = { key: key, value: { classes: Array.from(classes).sort(), vars: Array.from(vars).sort() } };
    return namesCache.value;
}

/** Классы селектора, которых нет в файлах VS Code. index — из classIndex (null — проверить нечем: []). */
function goneClasses(index, selector) {
    if (!index) return [];
    return selectorClasses(selector).filter((c) => /^[\x20-\x7e]+$/.test(c) && !/^(mc-|mooncore)/.test(c) && !index.has(c));
}

/**
 * Дополнить сводку проверки селекторов (lib/checks.js): у правил, которые ничего не находят,
 * отметить «точно сломано» — класс исчез из VS Code. Возвращает число таких правил.
 */
function annotateCheck(summary, appDir) {
    if (!summary || !Array.isArray(summary.deadUser) || !summary.deadUser.length) { if (summary) summary.gone = 0; return 0; }
    const index = classIndex(appDir);
    let n = 0;
    summary.deadUser.forEach((d) => {
        const gone = goneClasses(index, d.selector);
        if (!gone.length) return;
        d.gone = gone;
        n++;
        summary.lines.push("    точно сломано — в этой версии VS Code нет класса " + gone.map((c) => "." + c).join(", ") + ": " + d.selector);
    });
    summary.gone = n;
    return n;
}

module.exports = { cssNames, integrity, integritySummary, originalSums, selectorClasses, classIndex, goneClasses, annotateCheck, LEFTOVERS };
