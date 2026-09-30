// ============================================================
//  Резервные копии вида: перед тем как правки конструктора заменяются целиком (профиль, сброс,
//  загрузка пакета, восстановление), текущий вид кладётся в <globalStorage>/backups.
//
//  Хранится BACKUPS_MAX последних копий; одинаковые подряд не плодятся. Копия — тот же формат,
//  что файл правок, в конверте { at, reason, design }; при чтении проходит ту же проверку
//  (design.cleanDesign), что и любые правки.
//
//  Сюда же — спасение повреждённого файла правок: нечитаемый файл не затирается пустым видом,
//  а откладывается рядом как .corrupt, вид берётся из последней копии.
//  Модуль без vscode.
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const D = require("./design");
const { writeAtomic } = require("./fsx");

const BACKUPS_MAX = 12;
const NAME_RE = /^design-(\d{13})\.json$/;
const REASONS = { profile: "перед применением профиля", clear: "перед сбросом", import: "перед загрузкой вида", restore: "перед восстановлением", manual: "вручную" };

function count(d) {
    return Object.keys(d.rules || {}).length + Object.keys(d.settings || {}).length + Object.keys(d.colors || {}).length +
        (d.buttons || []).length + Object.keys(d.fx || {}).length;
}

function files(dir) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return []; }
    return names.filter((n) => NAME_RE.test(n)).sort().reverse().map((n) => path.join(dir, n));
}

function readEnvelope(file) {
    try {
        const o = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!o || typeof o !== "object" || !o.design || typeof o.design !== "object") return null;
        return { file: file, at: Number(o.at) || 0, reason: Object.prototype.hasOwnProperty.call(REASONS, o.reason) ? o.reason : "manual", design: D.cleanDesign(o.design) };
    } catch (e) { return null; }
}

/**
 * Сохранить копию вида. Пустой вид и копия, равная последней, не сохраняются.
 * Возвращает путь файла или null.
 */
function save(dir, design, reason) {
    if (!dir || !design || !count(design)) return null;
    const text = JSON.stringify(design);
    const last = files(dir)[0];
    if (last) {
        const prev = readEnvelope(last);
        if (prev && JSON.stringify(prev.design) === JSON.stringify(D.cleanDesign(JSON.parse(text)))) return null;
    }
    fs.mkdirSync(dir, { recursive: true });
    let at = Date.now();
    while (fs.existsSync(path.join(dir, "design-" + at + ".json"))) at++;
    const file = path.join(dir, "design-" + at + ".json");
    writeAtomic(file, JSON.stringify({ at: at, reason: reason || "manual", design: JSON.parse(text) }));
    files(dir).slice(BACKUPS_MAX).forEach((f) => { try { fs.unlinkSync(f); } catch (e) {} });
    return file;
}

const SNIPPET_SETS_MAX = 5;
/**
 * Отложить файлы сниппетов, которые сейчас будут перезаписаны (загрузка вида из файла):
 * <dir>/snippets-<время>/<имя>. Хранится SNIPPET_SETS_MAX последних наборов. Возвращает папку или null.
 */
function saveSnippets(dir, files) {
    const list = (Array.isArray(files) ? files : []).filter((f) => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } });
    if (!dir || !list.length) return null;
    const out = path.join(dir, "snippets-" + Date.now());
    fs.mkdirSync(out, { recursive: true });
    list.forEach((f) => { try { fs.copyFileSync(f, path.join(out, path.basename(f))); } catch (e) {} });
    let sets = [];
    try { sets = fs.readdirSync(dir).filter((n) => /^snippets-\d{13}$/.test(n)).sort().reverse(); } catch (e) {}
    sets.slice(SNIPPET_SETS_MAX).forEach((n) => { try { fs.rmSync(path.join(dir, n), { recursive: true, force: true }); } catch (e) {} });
    return out;
}

/** Наборы копий сниппетов, новые сверху: [{ dir, at, files: [имена] }]. */
function snippetSets(dir) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => /^snippets-\d{13}$/.test(n)).sort().reverse(); } catch (e) { return []; }
    return names.map((n) => {
        let files = [];
        try { files = fs.readdirSync(path.join(dir, n)).filter((f) => /\.(css|js)$/.test(f)).sort(); } catch (e) {}
        return { dir: path.join(dir, n), at: Number(n.slice(9)), files: files };
    }).filter((s) => s.files.length);
}

/** Копии, новые сверху: [{ file, at, reason, title, edits, design }]. */
function list(dir) {
    return files(dir).map(readEnvelope).filter(Boolean).map((e) => Object.assign(e, { edits: count(e.design), title: REASONS[e.reason] }));
}

/** Файл правок есть, не пуст и не разбирается как JSON-объект. */
function isCorrupt(file) {
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch (e) { return false; }
    if (!text.trim()) return false;
    try { const o = JSON.parse(text); return !o || typeof o !== "object" || Array.isArray(o); } catch (e) { return true; }
}

/**
 * Спасти повреждённый файл правок: отложить его как <файл>.corrupt и вернуть вид из последней
 * копии (или null, если копий нет). Сам файл правок перезапишет вызывающий.
 */
function recover(file, dir, log) {
    try { fs.copyFileSync(file, file + ".corrupt"); } catch (e) {}
    const last = dir ? list(dir)[0] : null;
    if (log) log("файл правок конструктора повреждён — отложен как " + path.basename(file) + ".corrupt" +
        (last ? ", вид взят из резервной копии от " + new Date(last.at).toISOString().slice(0, 16).replace("T", " ") : ", резервных копий нет"));
    return last ? last.design : null;
}

module.exports = { snippetSets, saveSnippets, save, list, isCorrupt, recover, count, BACKUPS_MAX, REASONS };
