// ============================================================
//  Профиль проекта: .vscode/mooncore.json в папке проекта — чистая часть без vscode.
//
//  Файл едет вместе с репозиторием, поэтому применяется только после согласия (хост спрашивает
//  один раз на содержимое файла; изменился файл — спросит снова). Два вида:
//    { "mooncore": 1, "note": "...", "use": "Минимал" }              — включить существующий профиль;
//    { "mooncore": 1, "note": "...", "rules": {...}, "settings": {...} } — свой вид проекта.
//  Всё входящее проходит те же проверки, что и профиль вида (engine.cleanProfile): селекторы и
//  значения без CSS-инъекции, настройки только из каталога. Части модулей из файла проекта не
//  берутся: чужой репозиторий не должен управлять модулями (например, путями картинок фона).
// ============================================================
"use strict";

const crypto = require("crypto");
const E = require("./engine");

const FILE = ".vscode/mooncore.json";
const MAX_FILE = 256 * 1024;

function sha256(s) { return crypto.createHash("sha256").update(String(s), "utf8").digest("hex"); }

/** Имя профиля для проекта: «Проект <папка>» в допустимых для профиля символах. */
function profileName(folderName) {
    const clean = String(folderName || "").replace(/[^\p{L}\p{N} _.()-]/gu, " ").replace(/\s+/g, " ").trim();
    return E.cleanName(("Проект " + (clean || "без имени")).slice(0, 40).trim()) || "Проект";
}

/**
 * Разобрать файл проекта. { ok, error?, use?, profile?, note, sha }
 *   use     — имя существующего профиля, который нужно включить;
 *   profile — проверенный профиль проекта (rules, settings), без модулей.
 */
function parse(text) {
    const src = String(text == null ? "" : text);
    if (src.length > MAX_FILE) return { ok: false, error: "файл больше " + (MAX_FILE >> 10) + " КБ" };
    let o;
    try { o = JSON.parse(src); } catch (e) { return { ok: false, error: "не JSON: " + e.message }; }
    if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: false, error: "ожидается объект" };
    const note = String(o.note || "").slice(0, 120);
    const sha = sha256(src);
    if (o.use != null) {
        const use = E.cleanName(o.use);
        if (!use) return { ok: false, error: "use: недопустимое имя профиля" };
        return { ok: true, use: use, note: note, sha: sha };
    }
    const p = E.cleanProfile({ rules: o.rules, settings: o.settings, note: note });
    p.modules = {};
    if (!Object.keys(p.rules).length && !Object.keys(p.settings).length) return { ok: false, error: "в файле нет ни правил, ни настроек" };
    return { ok: true, profile: p, note: note, sha: sha };
}

/** Текст файла проекта из текущих правок конструктора (design: {rules, settings}). */
function build(design, note) {
    const snap = E.snapshot(design);
    const out = { mooncore: 1, note: String(note || "").slice(0, 120), rules: snap.rules, settings: snap.settings };
    return JSON.stringify(out, null, 2) + "\n";
}

/** Коротко о содержимом для вопроса «применять?». */
function describe(parsed) {
    if (parsed.use) return "профиль «" + parsed.use + "»";
    return "правок элементов: " + Object.keys(parsed.profile.rules).length + ", настроек VS Code: " + Object.keys(parsed.profile.settings).length;
}

module.exports = { FILE, MAX_FILE, profileName, parse, build, describe, sha256 };
