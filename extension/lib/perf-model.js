// ============================================================
//  «Скорость VS Code» — модель без vscode: из меток производительности VS Code собирает время
//  активации расширений и этапы старта окна, ведёт историю запусков, находит замедление и даёт
//  советы по настройкам. Страницу рисует lib/ext/speed.js, тесты гоняют эту часть.
//
//  Откуда данные (сверено с VS Code 1.139):
//    - процесс расширений: globalThis.MonacoPerformanceMarks.getMarks() — метки
//      code/extHost/willLoadExtensionCode/<id>, .../didLoadExtensionCode/<id>,
//      .../willActivateExtension/<id>, .../didActivateExtension/<id> (абсолютное время, мс).
//      Moon Core работает в том же процессе, поэтому видит их без патчей и сервисов окна;
//    - окно: performance.getEntriesByType("mark") — code/willStartWorkbench и т. д. (мс от
//      начала загрузки окна). Их присылает рантайм вместе со временем запуска (метод timing).
// ============================================================
"use strict";

const EXT_MARK_RE = /^code\/extHost\/(will|did)(LoadExtensionCode|ActivateExtension)\/([\w.-]{3,120})$/;
const EXT_ID_RE = /^[\w-]{1,60}\.[\w.-]{1,80}$/;
const MARK_NAME_RE = /^(code|mooncore)[/:][\w/.:-]{1,90}$/;

const num = (v) => (typeof v === "number" && isFinite(v)) ? v : null;
const dur = (a, b) => (a != null && b != null && b >= a) ? Math.round(b - a) : null;

/**
 * Активация расширений из меток процесса расширений: [{ id, load, activate, total, at, done }]
 * по убыванию total. load — загрузка кода (require/import), activate — функция activate() до
 * выполнения её обещания, at — когда началась загрузка (мс от старта процесса расширений).
 */
function extTable(marks) {
    const by = {};
    let origin = null;
    (Array.isArray(marks) ? marks : []).forEach((m) => {
        if (!m || typeof m.name !== "string" || num(m.startTime) == null) return;
        if (m.name === "code/timeOrigin" && origin == null) { origin = m.startTime; return; }
        const r = EXT_MARK_RE.exec(m.name);
        if (!r) return;
        const e = by[r[3]] || (by[r[3]] = { id: r[3] });
        const k = r[1] + r[2];
        if (e[k] == null) e[k] = m.startTime;                // повторная активация — не в счёт
    });
    return Object.keys(by).map((id) => {
        const e = by[id];
        const load = dur(e.willLoadExtensionCode, e.didLoadExtensionCode);
        const activate = dur(e.willActivateExtension, e.didActivateExtension);
        const start = e.willLoadExtensionCode != null ? e.willLoadExtensionCode : e.willActivateExtension;
        return {
            id: id, load: load, activate: activate, total: (load || 0) + (activate || 0),
            at: origin != null && start != null ? Math.max(0, Math.round(start - origin)) : null,
            done: e.didActivateExtension != null,
        };
    }).sort((a, b) => b.total - a.total || (a.id < b.id ? -1 : 1));
}

/**
 * Когда расширение просит активироваться (package.json -> activationEvents):
 *   star      — «*», сразу при старте окна (тормозит каждый запуск);
 *   startup   — onStartupFinished, сразу после старта;
 *   workspace — workspaceContains:..., по файлам открытой папки;
 *   language  — по языку открытого файла;
 *   event     — по команде, виду и т. п.;
 *   implicit  — событий нет: VS Code выводит их из contributes (команды, виды).
 */
function activationKind(events) {
    const ev = Array.isArray(events) ? events.map(String) : [];
    if (ev.indexOf("*") !== -1) return "star";
    if (ev.indexOf("onStartupFinished") !== -1) return "startup";
    if (ev.some((e) => e.indexOf("workspaceContains:") === 0)) return "workspace";
    if (ev.some((e) => e.indexOf("onLanguage:") === 0)) return "language";
    return ev.length ? "event" : "implicit";
}
const KIND_TITLE = { star: "при старте (*)", startup: "после старта", workspace: "по файлам папки", language: "по языку файла", event: "по событию", implicit: "по командам и видам" };
const EAGER = ["star", "startup"];

// ------------------------------------------------------------------ окно
const PHASES = [
    ["config", "Конфигурация окна", "code/willWaitForWindowConfig", "code/didWaitForWindowConfig"],
    ["code", "Загрузка кода окна", "code/willLoadWorkbenchMain", "code/didLoadWorkbenchMain"],
    ["storage", "Хранилище", "code/willInitStorage", "code/didInitStorage"],
    ["workspace", "Папка и настройки", "code/willInitWorkspaceService", "code/didInitWorkspaceService"],
    ["workbench", "Отрисовка интерфейса", "code/willStartWorkbench", "code/didStartWorkbench"],
    ["viewlet", "Боковая панель", "code/willRestoreViewlet", "code/didRestoreViewlet"],
    ["editors", "Редакторы", "code/willRestoreEditors", "code/didRestoreEditors"],
    ["panel", "Нижняя панель", "code/willRestorePanel", "code/didRestorePanel"],
    ["extensions", "Расширения", "code/willLoadExtensions", "code/didLoadExtensions"],
];

/** Метки окна, пригодные к хранению: имя -> мс (только code/* и mooncore:*, не больше 120). */
function cleanMarks(vs) {
    const out = {};
    if (!vs || typeof vs !== "object" || Array.isArray(vs)) return out;
    Object.keys(vs).slice(0, 200).forEach((k) => {
        const v = num(vs[k]);
        if (MARK_NAME_RE.test(k) && v != null && v >= 0 && v < 3600000 && Object.keys(out).length < 120) out[k] = Math.round(v);
    });
    return out;
}

/**
 * Этапы старта окна: { ready, extensions, phases: [{ key, label, start, ms }] }.
 * ready — интерфейс отрисован (didStartWorkbench), extensions — расширения поднялись.
 */
function windowTimeline(vs) {
    const m = cleanMarks(vs);
    const phases = [];
    PHASES.forEach((p) => {
        const ms = dur(m[p[2]], m[p[3]]);
        if (ms != null) phases.push({ key: p[0], label: p[1], start: m[p[2]], ms: ms });
    });
    return { ready: m["code/didStartWorkbench"] != null ? m["code/didStartWorkbench"] : null, extensions: m["code/didLoadExtensions"] != null ? m["code/didLoadExtensions"] : null, phases: phases };
}

// ------------------------------------------------------------------ история
const STARTS_MAX = 60, EXT_MAX = 400;

function emptyHistory() { return { v: 1, starts: [], ext: {} }; }

/** История из файла (чужой или повреждённый файл — пустая история, а не исключение). */
function cleanHistory(raw) {
    const h = emptyHistory();
    if (!raw || typeof raw !== "object") return h;
    (Array.isArray(raw.starts) ? raw.starts : []).slice(-STARTS_MAX).forEach((s) => {
        if (!s || typeof s !== "object" || num(s.at) == null) return;
        const phases = {};
        if (s.phases && typeof s.phases === "object") Object.keys(s.phases).forEach((k) => { if (/^[a-z]{2,16}$/.test(k) && num(s.phases[k]) != null) phases[k] = s.phases[k]; });
        h.starts.push({ at: s.at, win: /^[0-9a-f]{16}$/.test(String(s.win)) ? s.win : "", vs: String(s.vs || "").slice(0, 40), ready: num(s.ready), extensions: num(s.extensions), runtime: num(s.runtime), phases: phases });
    });
    if (raw.ext && typeof raw.ext === "object") Object.keys(raw.ext).slice(0, EXT_MAX).forEach((id) => {
        const e = raw.ext[id];
        if (!EXT_ID_RE.test(id) || !e || num(e.n) == null || e.n < 1) return;
        h.ext[id] = { n: Math.min(1e6, Math.round(e.n)), sum: num(e.sum) || 0, max: num(e.max) || 0, last: num(e.last) || 0, at: num(e.at) || 0, kind: KIND_TITLE[e.kind] ? e.kind : "implicit" };
    });
    return h;
}

/** Запуск окна в историю: тот же win обновляет свою запись (рантайм шлёт время дважды). */
function addStart(h, entry) {
    const e = Object.assign({ at: Date.now(), win: "", vs: "", ready: null, extensions: null, runtime: null, phases: {} }, entry);
    const i = e.win ? h.starts.findIndex((s) => s.win === e.win) : -1;
    if (i !== -1) {
        // Вторая отправка дополняет первую: пустые поля новой записи не затирают известные.
        const cur = h.starts[i];
        Object.keys(e).forEach((k) => { if (k !== "at" && e[k] != null && k !== "phases") cur[k] = e[k]; });
        cur.phases = Object.assign({}, cur.phases, e.phases || {});
    } else h.starts.push(e);
    if (h.starts.length > STARTS_MAX) h.starts.splice(0, h.starts.length - STARTS_MAX);
    return h;
}

/** Активации расширений одного процесса расширений в историю (одна запись на сеанс окна). */
function addExt(h, table, kinds, at) {
    (table || []).forEach((r) => {
        if (!r || !EXT_ID_RE.test(r.id) || !r.done) return;
        const cur = h.ext[r.id];
        if (!cur && Object.keys(h.ext).length >= EXT_MAX) return;
        const e = cur || { n: 0, sum: 0, max: 0, last: 0, at: 0, kind: "implicit" };
        e.n++; e.sum += r.total; e.max = Math.max(e.max, r.total); e.last = r.total; e.at = at || Date.now();
        e.kind = (kinds && kinds[r.id]) || e.kind;
        h.ext[r.id] = e;
    });
    return h;
}

function median(list) {
    const a = list.filter((x) => num(x) != null).sort((x, y) => x - y);
    if (!a.length) return null;
    const mid = a.length >> 1;
    return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
}

/** Сводка по запускам: { n, last, median (без последнего), ready, extensions }. */
function startStats(h) {
    const s = h.starts;
    const last = s.length ? s[s.length - 1] : null;
    const prev = s.slice(0, -1).slice(-20);
    return {
        n: s.length, last: last,
        readyMedian: median(prev.map((x) => x.ready)),
        extensionsMedian: median(prev.map((x) => x.extensions)),
    };
}

/**
 * Замедление: последний запуск заметно медленнее обычного. Нужны хотя бы MIN_SAMPLES прошлых
 * запусков; «заметно» — в полтора раза и не меньше чем на секунду (шум старта — сотни мс).
 * Возвращает { metric, last, median } или null.
 */
const MIN_SAMPLES = 5;
function regression(h) {
    const st = startStats(h);
    if (!st.last || st.n - 1 < MIN_SAMPLES) return null;
    const pick = [["extensions", st.extensionsMedian], ["ready", st.readyMedian]];
    for (const [metric, med] of pick) {
        const v = st.last[metric];
        if (med != null && v != null && v >= med * 1.5 && v - med >= 1000) return { metric: metric, last: v, median: med };
    }
    return null;
}

/** Расширения из истории: [{ id, n, avg, max, last, kind }] по убыванию среднего. */
function extStats(h) {
    return Object.keys(h.ext).map((id) => {
        const e = h.ext[id];
        return { id: id, n: e.n, avg: Math.round(e.sum / e.n), max: Math.round(e.max), last: Math.round(e.last), kind: e.kind };
    }).sort((a, b) => b.avg - a.avg);
}

/** Сводка подвисаний и памяти окна (из пульса и времени запуска) — только числа в разумных пределах. */
function cleanPerf(p) {
    if (!p || typeof p !== "object") return null;
    const n = (v, max) => (typeof v === "number" && isFinite(v) && v >= 0 && v <= max) ? Math.round(v) : 0;
    return { freezes: n(p.freezes, 1e6), freezeMs: n(p.freezeMs, 1e9), freezeMax: n(p.freezeMax, 36e5), heapMb: n(p.heapMb, 65536), up: n(p.up, 1e8) };
}

/** Подвисания окна: «плохо», если окно вставало больше чем на секунду или часто дольше FREEZE. */
function freezeBad(p) { return !!p && ((num(p.freezeMax) || 0) >= 1000 || (num(p.freezes) || 0) >= 10); }

module.exports = {
    extTable, activationKind, KIND_TITLE, EAGER, PHASES, cleanMarks, windowTimeline,
    emptyHistory, cleanHistory, addStart, addExt, median, startStats, regression, extStats, freezeBad, cleanPerf,
    STARTS_MAX, EXT_MAX, MIN_SAMPLES, EXT_ID_RE,
};
