// ============================================================
//  Проверка селекторов — чистая часть без vscode (её гоняют тесты).
//
//  Окно отвечает списком групп { id, rules: [{ selector, label?, found }] }:
//    - "<имя>.css"  — CSS-сниппет;
//    - "~design"    — правки конструктора;
//    - "~catalog"   — элементы каталога Moon Core (что умеет находить конструктор).
//  Главный режим отказа после обновления VS Code — переименованный класс в вёрстке: ошибки
//  нет, правило просто молча перестаёт что-либо находить. Здесь это сводится в отчёт.
// ============================================================
"use strict";

const P = require("./protocol");
const D = require("./design");

const HOW = { alt: "запасной селектор", catalog: "каталог", search: "по признакам элемента" };

const clip = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001F]/g, " ").slice(0, n);

const GROUP_TITLES = { "~design": "Правки конструктора", "~catalog": "Каталог Moon Core" };
function groupTitle(id) { return GROUP_TITLES[id] || "Сниппет " + id; }

/**
 * Свести ответ окна.
 * Возвращает { lines, user: {total, dead}, catalog: {total, dead}, deadUser: [{group, selector, label}], heals }.
 * heals — замены для сломанных правок конструктора, которые окно нашло по отпечатку элемента:
 * [{ from, to, how, label, fp }] (применяются операцией renameRule после согласия).
 * user — то, что сделал сам пользователь (сниппеты и правки конструктора): об этом стоит
 * предупреждать; catalog — наш каталог: его поломка важна разработчику, пользователю — в журнал.
 */
function summarize(results) {
    const out = { lines: [], user: { total: 0, dead: 0 }, catalog: { total: 0, dead: 0 }, deadUser: [], heals: [], catalogPrints: {}, catalogHeals: [] };
    (Array.isArray(results) ? results : []).slice(0, P.MAX_SNIPPETS + 2).forEach((r) => {
        if (!r || typeof r !== "object") return;
        const id = clip(r.id, 80);
        const rules = Array.isArray(r.rules) ? r.rules.slice(0, 2000).filter((x) => x && typeof x === "object") : [];
        const bad = rules.filter((x) => !x.found);
        if (id === "~catalog") rules.forEach((x) => { const fp = x.found && D.cleanFp(x.fp); if (fp && /^\w{1,40}$/.test(String(x.id))) out.catalogPrints[x.id] = fp; });
        const bucket = id === "~catalog" ? out.catalog : out.user;
        bucket.total += rules.length;
        bucket.dead += bad.length;
        out.lines.push(groupTitle(id) + ": правил " + rules.length + (bad.length ? ", не находят ничего: " + bad.length : ", все на месте"));
        bad.forEach((x) => {
            const label = clip(x.label, 80);
            out.lines.push("    " + (label ? label + " — " : "") + clip(x.selector, 300));
            if (id !== "~catalog") out.deadUser.push({ group: id, selector: clip(x.selector, 300), label: label });
            if (id === "~catalog" && x.heal && typeof x.heal === "object") {
                const to = D.cleanSelector(x.heal.to);
                if (to && HOW[x.heal.how]) {
                    out.catalogHeals.push({ id: clip(x.id, 40), label: label, from: clip(x.selector, 300), to: to, how: x.heal.how });
                    out.lines.push("      новый селектор по отпечатку: " + to);
                }
            }
            const h = id === "~design" && x.heal && typeof x.heal === "object" ? x.heal : null;
            const from = D.cleanSelector(x.selector), to = h ? D.cleanSelector(h.to) : "";
            if (h && from && to && to !== from && HOW[h.how]) {
                out.heals.push({ from: from, to: to, how: h.how, label: label, fp: D.cleanFp(h.fp) });
                out.lines.push("      замена (" + HOW[h.how] + "): " + to);
            }
        });
    });
    return out;
}

module.exports = { summarize, groupTitle, HOW };
