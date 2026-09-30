// ============================================================
//  Переезд с расширения Custom CSS and JS Loader (be5invis.vscode-custom-css).
//
//  Оно хранит список подключаемых файлов в настройке vscode_custom_css.imports
//  ("file:///C:/.../my.css"). Здесь — что из этого списка можно забрать в сниппеты Moon Core:
//  только локальные файлы .css и .js в пределах лимита сниппета. CSS заработает сразу; JS
//  копируется, но запускается лишь после одобрения (как любой JS, появившийся не из редактора).
//  Модуль без vscode.
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const url = require("url");
const P = require("./protocol");
const S = require("./snippets");

const PREFIX = "custom-";

/** Локальный путь из записи списка ("file:///..." или обычный путь) или "". */
function localPath(entry) {
    const s = String(entry == null ? "" : entry).trim();
    if (!s) return "";
    if (/^file:\/\//i.test(s)) { try { return url.fileURLToPath(s); } catch (e) { return ""; } }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return "";          // http(s) и прочее — не берём
    return path.isAbsolute(s) ? s : "";
}

/**
 * Что забрать: { items: [{ src, id, kind, code }], skipped: [{ entry, why }] }.
 * taken — имена, уже занятые в папке сниппетов (функция id -> boolean).
 */
function plan(imports, taken) {
    const items = [], skipped = [], used = new Set();
    (Array.isArray(imports) ? imports : []).slice(0, 50).forEach((entry) => {
        const src = localPath(entry);
        const short = String(entry).slice(0, 120);
        if (!src) { skipped.push({ entry: short, why: "не локальный файл" }); return; }
        const ext = path.extname(src).toLowerCase();
        if (ext !== ".css" && ext !== ".js") { skipped.push({ entry: short, why: "не .css и не .js" }); return; }
        let st;
        try { st = fs.statSync(src); } catch (e) { skipped.push({ entry: short, why: "файл не найден" }); return; }
        if (!st.isFile() || st.size > P.MAX_SNIPPET) { skipped.push({ entry: short, why: "больше " + Math.round(P.MAX_SNIPPET / 1024) + " КБ" }); return; }
        let code = "";
        try { code = fs.readFileSync(src, "utf8").replace(/^\uFEFF/, ""); } catch (e) { skipped.push({ entry: short, why: "не читается" }); return; }
        const base = (PREFIX + path.basename(src, ext)).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 50) || "custom";
        let id = base + ext;
        for (let i = 2; (used.has(id) || (taken && taken(id))) && i < 100; i++) id = base + "-" + i + ext;
        if (!S.validId(id) || used.has(id)) { skipped.push({ entry: short, why: "не подобрать имя" }); return; }
        used.add(id);
        items.push({ src: src, id: id, kind: ext === ".js" ? "js" : "css", code: code });
    });
    return { items: items, skipped: skipped };
}

module.exports = { plan, localPath, PREFIX };
