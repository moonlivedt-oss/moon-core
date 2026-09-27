// ============================================================
//  Профили по контексту — выбор профиля, без vscode (его гоняют тесты).
//
//  Правила в настройке moonCore.autoProfiles, первое подходящее выигрывает:
//    [{ "profile": "Только код", "languages": ["markdown"] },
//     { "profile": "Минимал", "folders": ["work-*"], "branches": ["release/*"] },
//     { "profile": "Ночь", "time": "22:00-07:00" },
//     { "profile": "Светлый", "themes": ["light"] }]
//  themes — вид темы VS Code: dark, light, highContrast, highContrastLight.
//  time   — промежуток «ЧЧ:ММ-ЧЧ:ММ» (или список), может переходить через полночь.
//  Внутри правила все заданные условия должны совпасть (И), внутри списка — любое (ИЛИ).
//  В именах папок и веток работает звёздочка. Ни одно правило не подошло — профиль из
//  moonCore.autoProfileDefault (пусто — ничего не менять).
// ============================================================
"use strict";

const MAX_RULES = 50;
const THEMES = ["dark", "light", "highContrast", "highContrastLight"];
const RANGE_RE = /^([01]?\d|2[0-3]):([0-5]\d)\s*-\s*([01]?\d|2[0-3]):([0-5]\d)$/;

/** «22:00-07:00» -> { from: 1320, to: 420 } (минуты от полуночи) или null. */
function parseRange(s) {
    const m = RANGE_RE.exec(String(s || "").trim());
    if (!m) return null;
    const from = +m[1] * 60 + +m[2], to = +m[3] * 60 + +m[4];
    return from === to ? null : { from: from, to: to };
}
function inRange(r, minutes) {
    return r.from < r.to ? minutes >= r.from && minutes < r.to : minutes >= r.from || minutes < r.to;
}

function globRe(p) {
    const esc = String(p).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp("^" + esc + "$", "i");
}

function list(v) { return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()).slice(0, 50) : []; }

/** Проверенные правила: [{ profile, languages, folders, branches }]. Без условий правило не берём. */
function cleanRules(raw) {
    return (Array.isArray(raw) ? raw : []).slice(0, MAX_RULES).map((r) => {
        if (!r || typeof r !== "object" || typeof r.profile !== "string" || !r.profile.trim()) return null;
        const rule = { profile: r.profile.trim().slice(0, 40), languages: list(r.languages).map((x) => x.toLowerCase()), folders: list(r.folders), branches: list(r.branches) };
        rule.themes = list(r.themes).filter((t) => THEMES.indexOf(t) !== -1);
        rule.time = (Array.isArray(r.time) ? r.time : r.time != null ? [r.time] : []).slice(0, 10).map(parseRange).filter(Boolean);
        return rule.languages.length || rule.folders.length || rule.branches.length || rule.themes.length || rule.time.length ? rule : null;
    }).filter(Boolean);
}

function matches(rule, ctx) {
    const c = ctx || {};
    if (rule.languages.length && rule.languages.indexOf(String(c.language || "").toLowerCase()) === -1) return false;
    if (rule.folders.length && !rule.folders.some((p) => globRe(p).test(String(c.folder || "")))) return false;
    if (rule.branches.length && !rule.branches.some((p) => globRe(p).test(String(c.branch || "")))) return false;
    if (rule.themes.length && rule.themes.indexOf(String(c.theme || "")) === -1) return false;
    if (rule.time.length && !(typeof c.minutes === "number" && rule.time.some((r) => inRange(r, c.minutes)))) return false;
    return true;
}

/** Какой профиль нужен в этом контексте: имя или "" (правил нет / не подошло и нет профиля по умолчанию). */
function pick(rawRules, ctx, fallback) {
    const rules = cleanRules(rawRules);
    for (const r of rules) if (matches(r, ctx)) return r.profile;
    return typeof fallback === "string" ? fallback.trim().slice(0, 40) : "";
}

/** Есть ли правила по времени (хосту нужно перепроверять раз в минуту). */
function usesTime(rawRules) { return cleanRules(rawRules).some((r) => r.time.length > 0); }

module.exports = { cleanRules, matches, pick, globRe, parseRange, usesTime, THEMES };
