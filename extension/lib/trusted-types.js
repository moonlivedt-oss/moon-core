// ============================================================
//  Trusted Types в CSP-мете оболочки VS Code — чистые функции без vscode.
//
//  VS Code требует доверенные типы для кода и разметки из строки (require-trusted-types-for
//  'script') и разрешает политики только из списка trusted-types. Окно Moon Core создаёт
//  политику «mooncore» (пропускает только сверенный чанк интерфейса, runtime/src/65-ui-loader.js),
//  а модули — свои, объявленные в манифесте (окно документации C++ — «cppdocs»).
// ============================================================
"use strict";

const TT_POLICY = "mooncore";
const TT_NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

/** Директива trusted-types целиком: m[1] — разделитель перед ней, m[2] — имя, m[3] — значение.
 *  Имя стоит отдельно: «trusted-types» не находится внутри «require-trusted-types-for». */
const TT_RE = /(^|[;"'\s])(trusted-types)(?=[\s;"]|$)([^;>"]*)/i;
const tokenRe = (name) => new RegExp("\\s" + String(name).replace(/[^a-z0-9-]/g, "") + "(?=\\s|$)", "g");

/** Имена политик в trusted-types ([] — директивы нет). */
function namesOf(meta) {
    const m = TT_RE.exec(String(meta || ""));
    return m ? m[3].split(/\s+/).filter(Boolean) : [];
}
/** Директива есть и допускает политики (не 'none'). */
function open(meta) {
    const m = TT_RE.exec(String(meta || ""));
    return !!m && !/'none'/i.test(m[3]);
}

/** Добавить нашу политику и политики модулей (extra). Директивы нет или она 'none' — не трогаем. */
function add(meta, extra) {
    const m = TT_RE.exec(meta);
    if (!m || /'none'/i.test(m[3])) return meta;
    const have = m[3].split(/\s+/);
    const list = [TT_POLICY].concat(extra || []).filter((n, i, a) => have.indexOf(n) === -1 && a.indexOf(n) === i);
    if (!list.length) return meta;
    const lead = m[3].replace(/\s+$/, ""), tail = m[3].slice(lead.length);
    return meta.replace(TT_RE, () => m[1] + m[2] + lead + " " + list.join(" ") + tail);
}
/** Снять нашу политику и добавленные нами политики модулей (extra); чужие имена не трогаем. */
function strip(meta, extra) {
    const m = TT_RE.exec(meta);
    if (!m) return meta;
    let v = m[3];
    [TT_POLICY].concat(extra || []).forEach((n) => { v = v.replace(tokenRe(n), ""); });
    return meta.replace(TT_RE, () => m[1] + m[2] + v);
}
/** Какие политики модулей дописать в CSP чистой оболочки (cleanMeta — без нашего блока): тех, что
 *  там уже есть, мы не пишем и потом не снимаем — они принадлежат VS Code или соседям. */
function toAdd(cleanMeta, names) {
    if (!open(cleanMeta)) return [];
    const have = namesOf(cleanMeta);
    return (names || []).filter((n, i, a) => have.indexOf(n) === -1 && a.indexOf(n) === i && n !== TT_POLICY);
}
/** Политики модулей, которых нет в CSP (блок пора переписать). */
function missing(meta, names) {
    if (!open(meta)) return [];
    const have = namesOf(meta);
    return (names || []).filter((n) => have.indexOf(n) === -1);
}
/** Проверить список из манифеста модуля. → { ok, names?, error? } */
function checkNames(raw) {
    if (raw == null) return { ok: true, names: [] };
    if (!Array.isArray(raw) || raw.length > 4) return { ok: false, error: "trustedTypes — список до 4 имён" };
    const names = [];
    for (const x of raw) {
        const n = String(x);
        // «default» — особая политика (применяется ко всем вставкам), «mooncore» — наша.
        if (!TT_NAME_RE.test(n) || n === "default" || n === TT_POLICY) return { ok: false, error: "trustedTypes: недопустимое имя «" + n.slice(0, 40) + "»" };
        if (names.indexOf(n) === -1) names.push(n);
    }
    return { ok: true, names: names };
}

module.exports = { TT_POLICY, namesOf, add, strip, toAdd, missing, checkNames };
