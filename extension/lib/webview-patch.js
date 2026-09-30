// ============================================================
//  Стили внутри webview VS Code (страницы расширений, превью Markdown, «Доктор», настройки
//  расширений...) — чистая часть без vscode (её гоняют тесты и хук удаления).
//
//  CSS окна в webview не доходит: каждая такая страница — отдельный документ, который VS Code
//  собирает из файла out/vs/workbench/contrib/webview/browser/pre/index.html. В нём один
//  инлайн-скрипт, и в нём — стили по умолчанию для всех webview (defaultStyles). Мы дописываем
//  свой CSS в конец этих стилей, между метками.
//
//  Скрипт впущен в CSP по хэшу (script-src 'sha256-...'), поэтому после правки хэш
//  пересчитывается. Страховки:
//    - правим только файл, у которого хэш скрипта СЕЙЧАС сходится с CSP (значит, его никто не
//      трогал или трогал аккуратно); не сходится — не лезем;
//    - после правки хэш сверяется ещё раз; снятие возвращает файл байт в байт;
//    - CSS не может выйти из строки-шаблона скрипта: обратная кавычка, обратный слэш, "${" и
//      "</script" в нём запрещены.
//  Файл не входит в контрольные суммы product.json — баннера «повреждена» не будет.
// ============================================================
"use strict";

const crypto = require("crypto");
const path = require("path");

const START = "/*MOONCORE-WEBVIEW*/", END = "/*MOONCORE-WEBVIEW-END*/";
const REL = ["vs", "workbench", "contrib", "webview", "browser", "pre", "index.html"];
const MAX_CSS = 64 * 1024;
const SCRIPT_RE = /<script async type="module">([\s\S]*?)<\/script>/;
const HASH_RE = /(script-src\s+'sha256-)([A-Za-z0-9+/=]{20,100})(')/;
const STYLES_OPEN = "defaultStyles.textContent = `";

/** Файл-основа webview под каталогом out. */
function fileIn(outDir) { return path.join.apply(path, [outDir].concat(REL)); }

/** Хэш скрипта так, как его считает браузер: переводы строк HTML нормализуются к LF. */
function scriptHash(html) {
    const m = SCRIPT_RE.exec(String(html));
    if (!m) return "";
    return crypto.createHash("sha256").update(m[1].replace(/\r\n?/g, "\n"), "utf8").digest("base64");
}
function cspHash(html) { const m = HASH_RE.exec(String(html)); return m ? m[2] : ""; }
/** Хэш скрипта сходится с CSP (иначе webview с этим файлом не работают или файл правили грубо). */
function hashOk(html) { const h = scriptHash(html); return !!h && h === cspHash(html); }

/**
 * CSP основы webview выключена: meta-тег с политикой есть, но его http-equiv стёрт или изменён
 * (так делает Custom UI Style, чтобы не пересчитывать хэш). Страницы при этом работают, но основа
 * webview остаётся без защиты от постороннего скрипта.
 */
function cspDisabled(html) {
    // Смотрим сам meta-тег с политикой: строка «http-equiv="Content-Security-Policy"» есть и в коде скрипта.
    const m = /<meta\b[^>]*script-src[^>]*>/i.exec(String(html));
    return !!m && !/http-equiv\s*=\s*["']Content-Security-Policy["']/i.test(m[0]);
}

function hasPatch(html) { return String(html).indexOf(START) !== -1; }
/** CSS, который сейчас вписан в файл ("" — нет). */
function patchCss(html) {
    const s = String(html), a = s.indexOf(START);
    if (a === -1) return "";
    const b = s.indexOf(END, a);
    return b === -1 ? "" : s.slice(a + START.length, b).replace(/\r\n/g, "\n").trim();
}

/** Проверенный CSS для вставки в строку-шаблон скрипта или "" (недопустим либо пуст). */
function cleanCss(css) {
    const s = String(css == null ? "" : css).replace(/\r\n?/g, "\n").trim();
    if (!s || s.length > MAX_CSS) return "";
    if (/[`\\]|\$\{|<\/script|<!--|MOONCORE-WEBVIEW/i.test(s)) return "";
    if (s.split("{").length !== s.split("}").length) return "";
    return s;
}

function setHash(html, hash) { return html.replace(HASH_RE, (m, a, b, c) => a + hash + c); }

/** Убрать наш CSS и вернуть хэш скрипта без него. Файл без нашей вставки возвращается как есть. */
function strip(html) {
    const s = String(html), a = s.indexOf(START);
    if (a === -1) return s;
    const b = s.indexOf(END, a);
    if (b === -1) return s;
    const bare = s.slice(0, a) + s.slice(b + END.length);
    return setHash(bare, scriptHash(bare));
}

/**
 * Вписать CSS. { ok, text, error? }. Пустой css — снять вставку.
 * Отказ, если файл устроен иначе или его хэш не сходится с CSP ещё до нас.
 */
function patch(html, css) {
    const bare = strip(html);
    const clean = cleanCss(css);
    if (!clean) return { ok: !String(css || "").trim(), text: bare, error: String(css || "").trim() ? "в стилях для webview недопустимые символы (обратная кавычка, обратный слэш, ${) или непарные скобки" : "" };
    if (cspDisabled(bare)) return { ok: false, text: bare, error: "в файле-основе webview другая программа отключила защиту CSP — Moon Core такой файл не трогает" };
    if (!hashOk(bare)) return { ok: false, text: bare, error: "файл-основа webview уже изменён другой программой (хэш скрипта не сходится с CSP) — Moon Core его не трогает" };
    const open = bare.indexOf(STYLES_OPEN);
    if (open === -1 || bare.indexOf(STYLES_OPEN, open + 1) !== -1) return { ok: false, text: bare, error: "место для стилей webview не найдено (эта версия VS Code устроена иначе)" };
    const close = bare.indexOf("`;", open + STYLES_OPEN.length);
    const script = SCRIPT_RE.exec(bare);
    if (close === -1 || !script || close > script.index + script[0].length) return { ok: false, text: bare, error: "конец стилей webview не найден" };
    if (bare.slice(open + STYLES_OPEN.length, close).indexOf("${") !== -1) return { ok: false, text: bare, error: "стили webview в этой версии VS Code собираются иначе" };
    const eol = bare.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
    const insert = START + eol + clean.replace(/\n/g, eol) + eol + END;
    const next = bare.slice(0, close) + insert + bare.slice(close);
    const out = setHash(next, scriptHash(next));
    if (!hashOk(out) || strip(out) !== bare) return { ok: false, text: bare, error: "проверка после правки не сошлась" };
    return { ok: true, text: out };
}

module.exports = { cspDisabled, START, END, REL, MAX_CSS, fileIn, scriptHash, cspHash, hashOk, hasPatch, patchCss, cleanCss, strip, patch };
