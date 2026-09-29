// ============================================================
//  Журнал разрешений: кто, когда и что разрешил или запретил.
//
//  Moon Core много спрашивает: команды VS Code из окна, JS-сниппеты, модули и их новый код,
//  профиль проекта, чужие вставки в оболочке. Ответы хранятся в разных ключах globalState, и
//  раньше нельзя было увидеть их вместе. Журнал — последние записи { at, kind, what, verdict }
//  в globalState (ключ mooncore.audit); команда «Разрешения» показывает его, «Отозвать все» —
//  сбрасывает сами разрешения (lib/keys.js GRANTS), а в журнал пишет отзыв.
//  Модуль без vscode: хранилище — любой объект с get/update (globalState или заглушка тестов).
// ============================================================
"use strict";

const KEYS = require("./keys");

const MAX = 200;
const KINDS = ["command", "js", "module", "moduleCode", "project", "shell", "revoke", "native", "caps"];
const clip = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001F]/g, " ").slice(0, n);

function read(store) {
    const v = store && store.get(KEYS.AUDIT);
    return Array.isArray(v) ? v.filter((r) => r && typeof r === "object" && KINDS.indexOf(r.kind) !== -1).slice(-MAX) : [];
}

/** Дописать запись. verdict: "allow" | "always" | "once" | "deny" | "revoke". */
function record(store, kind, what, verdict) {
    if (!store || KINDS.indexOf(kind) === -1) return Promise.resolve();
    const list = read(store).concat([{ at: Date.now(), kind: kind, what: clip(what, 200), verdict: clip(verdict, 20) }]);
    return Promise.resolve(store.update(KEYS.AUDIT, list.slice(-MAX)));
}

/** Сбросить все разрешения. Возвращает число ключей, в которых что-то было. */
async function revokeAll(store) {
    let n = 0;
    for (const k of KEYS.GRANTS) {
        const v = store.get(k);
        const had = v != null && (Array.isArray(v) ? v.length > 0 : typeof v === "object" ? Object.keys(v).length > 0 : true);
        if (had) n++;
        // JS-сниппеты: пустая карта (а не undefined) — иначе первый запуск счёл бы всё одобренным.
        await store.update(k, k === KEYS.JS_APPROVED ? {} : undefined);
    }
    await record(store, "revoke", "все разрешения (" + n + ")", "revoke");
    return n;
}

const KIND_TITLE = { command: "команда", js: "JS-сниппет", module: "модуль", moduleCode: "код модуля", project: "профиль проекта", shell: "оболочка", revoke: "отзыв", native: "шлюз модуля", caps: "права модуля" };

/** Строки для показа: новые сверху. */
function lines(store) {
    const p = (n) => String(n).padStart(2, "0");
    return read(store).slice().reverse().map((r) => {
        const d = new Date(r.at || 0);
        const when = d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
        return when + "  " + (KIND_TITLE[r.kind] || r.kind) + ": " + r.what + " — " + r.verdict;
    });
}

module.exports = { MAX, KINDS, read, record, revokeAll, lines };
