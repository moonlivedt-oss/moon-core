// ============================================================
//  Правила шлюза модулей к API VS Code (метод моста "native") — чистая часть без vscode.
//
//  Модуль одобрен человеком, но это не значит «всё можно»:
//    - настройки с секретами (токены, пароли, ключи API, прокси с логином) шлюз не читает —
//      модуль не вынесет их из VS Code;
//    - открыть без вопроса можно только файл внутри папок проекта, самого модуля или данных
//      Moon Core, остальное — с подтверждением;
//    - всё, что модуль показывает человеку (уведомление, выбор, ввод), подписано его именем:
//      модуль не выдаст себя за VS Code или другое расширение, особенно спрашивая пароль;
//    - у модуля один вопрос за раз и не больше NOTIFY_PER_MIN уведомлений в минуту — сломанный
//      или злой модуль не завалит окно диалогами.
// ============================================================
"use strict";

const path = require("path");

// token, но не editor.tokenColorCustomizations / semanticTokenColors (цвета темы нужны модулям).
const SECRET_KEY_RE = /(token(?!colors?\b|colorcustomizations)|passw(or)?d|\bpwd\b|secret|api[-_.]?key|apikey|credential|\bauth|cookie|private[-_.]?key|access[-_.]?key|session[-_.]?id|proxy)/i;
const NOTIFY_PER_MIN = 10;

/** Настройка может хранить секрет — шлюз её не отдаёт. */
function secretKey(key) { return SECRET_KEY_RE.test(String(key || "")); }

/**
 * Значение настройки без секретов: раздел («github», «http») приходит объектом, и секрет в нём —
 * вложенным ключом. Такие ключи вырезаются на любой глубине (путь проверяется целиком).
 */
function stripSecrets(v, prefix, depth) {
    const d = depth || 0;
    if (!v || typeof v !== "object" || d > 8) return v;
    if (Array.isArray(v)) return v.map((x) => stripSecrets(x, prefix, d + 1));
    const out = {};
    Object.keys(v).forEach((k) => {
        const full = prefix ? prefix + "." + k : k;
        if (!secretKey(full)) out[k] = stripSecrets(v[k], full, d + 1);
    });
    return out;
}

/** Файл p внутри одной из папок roots (без выхода через ..). Регистр не важен на Windows/macOS. */
function insideAny(p, roots) {
    if (typeof p !== "string" || !path.isAbsolute(p)) return false;
    const fold = process.platform === "win32" || process.platform === "darwin" ? (s) => s.toLowerCase() : (s) => s;
    const abs = fold(path.resolve(p));
    return (roots || []).filter((r) => typeof r === "string" && r).some((r) => {
        const rel = path.relative(fold(path.resolve(r)), abs);
        return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
    });
}

/** Подпись текста модуля: «[Имя модуля] текст». */
function signed(name, text) { return "[" + String(name || "модуль").slice(0, 60) + "] " + String(text == null ? "" : text); }

/**
 * Ограничитель модуля: один открытый вопрос за раз и лимит уведомлений в минуту.
 * now — источник времени (тесты подставляют свой).
 */
class Throttle {
    constructor(now) {
        this.now = now || Date.now;
        this.busy = new Set();          // модули, у которых открыт вопрос
        this.notes = new Map();         // модуль -> [время уведомления]
    }
    /** Можно ли показать ещё одно уведомление (и учесть его). */
    notify(id) {
        const t = this.now();
        const list = (this.notes.get(id) || []).filter((x) => t - x < 60000);
        if (list.length >= NOTIFY_PER_MIN) { this.notes.set(id, list); return false; }
        list.push(t);
        this.notes.set(id, list);
        return true;
    }
    /** Выполнить вопрос fn (Promise), если у модуля нет открытого. Иначе { ok:false, busy:true }. */
    async ask(id, fn) {
        if (this.busy.has(id)) return { ok: false, busy: true, error: "у модуля уже открыт вопрос" };
        this.busy.add(id);
        try { return await fn(); } finally { this.busy.delete(id); }
    }
}

module.exports = { secretKey, stripSecrets, insideAny, signed, Throttle, NOTIFY_PER_MIN };
