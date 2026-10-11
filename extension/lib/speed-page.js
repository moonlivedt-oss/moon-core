// ============================================================
//  Страница «Скорость VS Code» — вёрстка без vscode (модель собирает lib/ext/speed.js).
//
//  Модель: { vscode, last, stats, regression, history: [{ at, ready, extensions }], windows:
//  [{ win, perf, own }], exts: [{ id, name, load, activate, total, kind, builtin, avg, n }],
//  advice: [...], applied: [{ id, key, title }], self: { activate, runtime, modules },
//  heavy, scanning, perfFile }
// ============================================================
"use strict";

const PM = require("./perf-model");

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
const sec = (ms) => ms == null ? "—" : ms >= 1000 ? (Math.round(ms / 100) / 10).toString().replace(".", ",") + " с" : Math.round(ms) + " мс";
const ACTIONS = ["refresh", "apply", "revert", "ext", "export", "reveal", "runtime", "process", "startup", "reload", "scan"];

function bar(ms, max, cls) {
    const w = max > 0 && ms > 0 ? Math.max(1, Math.round(ms / max * 100)) : 0;
    return "<div class='bar " + (cls || "") + "'><i style='width:" + w + "%'></i></div>";
}

function startSection(m) {
    const last = m.last;
    if (!last) return "<p class=muted>Замеров ещё нет: они появятся после следующего открытия окна (рантайм Moon Core присылает метки VS Code через 25 с после старта).</p>";
    const st = m.stats || {};
    const cmp = (v, med) => med == null || v == null ? "" : " <small>(обычно " + esc(sec(med)) + ")</small>";
    const phases = (last.phasesList || []);
    const max = Math.max.apply(null, [1].concat(phases.map((p) => p.ms)));
    const rows = phases.map((p) => "<tr><th>" + esc(p.label) + "</th><td class=num>" + esc(sec(p.ms)) + "</td><td>" + bar(p.ms, max, p.ms >= 1500 ? "warn" : "") + "</td></tr>").join("");
    const hist = (m.history || []).slice(-20);
    const hmax = Math.max.apply(null, [1].concat(hist.map((x) => x.extensions || x.ready || 0)));
    const spark = hist.length > 1 ? "<div class=spark title='Последние запуски: когда поднялись расширения'>" + hist.map((x) => {
        const v = x.extensions || x.ready || 0;
        return "<i style='height:" + Math.max(2, Math.round(v / hmax * 40)) + "px' title='" + esc(new Date(x.at).toLocaleString("ru-RU")) + ": " + esc(sec(v)) + "'></i>";
    }).join("") + "</div>" : "";
    return "<div class=kpis>" +
        "<div class=kpi><b>" + esc(sec(last.ready)) + "</b><span>интерфейс отрисован" + cmp(last.ready, st.readyMedian) + "</span></div>" +
        "<div class=kpi><b>" + esc(sec(last.extensions)) + "</b><span>расширения поднялись" + cmp(last.extensions, st.extensionsMedian) + "</span></div>" +
        "<div class=kpi><b>" + esc(st.n || 0) + "</b><span>запусков в истории</span></div></div>" + spark +
        (rows ? "<table class=phases>" + rows + "</table>" : "");
}

function windowsSection(m) {
    const w = (m.windows || []).filter((x) => x.perf);
    if (!w.length) return "<p class=muted>Окна ещё не прислали пульс (раз в минуту).</p>";
    return "<table><tr><th>Окно</th><th>Подвисаний дольше 200 мс</th><th>Самое долгое</th><th>Память JS</th><th>Открыто</th></tr>" + w.map((x) => {
        const p = x.perf;
        return "<tr" + (PM.freezeBad(p) ? " class=hot" : "") + "><td>" + (x.own ? "это окно" : "<code>" + esc(x.win.slice(0, 6)) + "</code>") + "</td><td class=num>" + esc(p.freezes) + (p.freezes ? " (" + esc(sec(p.freezeMs)) + ")" : "") +
            "</td><td class=num>" + esc(sec(p.freezeMax || null)) + "</td><td class=num>" + esc(p.heapMb ? p.heapMb + " МБ" : "—") + "</td><td class=num>" + esc(Math.round((p.up || 0) / 60)) + " мин</td></tr>";
    }).join("") + "</table>";
}

function extSection(m) {
    const list = (m.exts || []).filter((e) => e.total > 0 || e.avg > 0).slice(0, 30);
    if (!list.length) return "<p class=muted>VS Code не прислал меток активации (процесс расширений ещё стартует).</p>";
    const max = Math.max.apply(null, [1].concat(list.map((e) => e.total)));
    return "<table class=exts><tr><th>Расширение</th><th class=num>Код</th><th class=num>activate()</th><th>Сейчас</th><th class=num>В среднем</th><th>Когда включается</th><th></th></tr>" + list.map((e) => {
        const eager = PM.EAGER.indexOf(e.kind) !== -1;
        return "<tr" + (e.total >= 1000 ? " class=hot" : "") + "><td>" + esc(e.name || e.id) + (e.builtin ? " <span class=tag>встроенное</span>" : "") + "<br><small>" + esc(e.id) + "</small></td>" +
            "<td class=num>" + esc(sec(e.load)) + "</td><td class=num>" + esc(sec(e.activate)) + "</td><td>" + bar(e.total, max, e.total >= 1000 ? "warn" : "") + "</td>" +
            "<td class=num>" + (e.n ? esc(sec(e.avg)) + " <small>×" + esc(e.n) + "</small>" : "—") + "</td>" +
            "<td>" + (eager ? "<b>" + esc(PM.KIND_TITLE[e.kind]) + "</b>" : esc(PM.KIND_TITLE[e.kind] || "")) + "</td>" +
            "<td>" + (e.builtin ? "" : "<button class=sec data-cmd=ext data-arg='" + esc(e.id) + "'>Страница</button>") + "</td></tr>";
    }).join("") + "</table><p class=muted>«Код» — загрузка файлов расширения, «activate()» — его запуск. Включается «при старте» — работает в каждом окне, даже если сегодня не нужно: такие удобнее выключить для этой папки на странице расширения (Отключить → для рабочей области) или запускать VS Code через лаунчер со стеками.</p>";
}

function adviceSection(m) {
    const a = (m.advice || []).map((x) => "<div class=prob><div class=pt>" + esc(x.title) + "</div><div class=pd>" + esc(x.why) +
        "<br><small><code>" + esc(x.key) + "</code> — " + (x.target === "workspace" ? "в настройки этой папки (.vscode/settings.json)" : "в настройки пользователя") + "</small></div>" +
        "<button data-cmd=apply data-arg='" + esc(x.id) + "'>Применить</button></div>").join("");
    const done = (m.applied || []).map((x) => "<div class='prob ok'><div class=pt>Применено: " + esc(x.title || x.key) + "</div><div class=pd><code>" + esc(x.key) + "</code></div>" +
        "<button class=sec data-cmd=revert data-arg='" + esc(x.id) + "'>Вернуть как было</button></div>").join("");
    const scan = m.scanning ? "<p class=muted>Ищу тяжёлые папки в проекте...</p>" : "";
    return scan + (a || done ? a + done : "<div class='prob ok'><div class=pt>Советов нет</div><div class=pd>Явных тормозов в настройках не видно. Советы строятся по фактам: тяжёлые папки в проекте, долгое восстановление редакторов, медленные расширения в нескольких запусках.</div></div>");
}

function render(m, nonce) {
    const r = m.regression;
    const head = r ? "<div class='verdict warn'>Последний запуск медленнее обычного: " + esc(sec(r.last)) + " вместо " + esc(sec(r.median)) + "</div>" : "";
    const self = m.self || {};
    return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Moon Core: Скорость VS Code</title>
<style nonce="${nonce}">
body{font:13px/1.5 var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px 22px;max-width:1040px}
h1{font-size:18px;margin:0 0 4px} h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;opacity:.7;margin:22px 0 8px}
.verdict{display:inline-block;padding:2px 10px;border-radius:10px;font-weight:600;margin:4px 0 10px;background:color-mix(in srgb,var(--vscode-editorWarning-foreground,#d29922) 25%,transparent)}
.muted,small{opacity:.7} code{opacity:.8}
.bar{height:8px;min-width:80px;background:color-mix(in srgb,var(--vscode-foreground) 8%,transparent);border-radius:4px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--vscode-progressBar-background,#0e70c0)} .bar.warn i{background:var(--vscode-editorWarning-foreground,#d29922)}
.kpis{display:flex;gap:12px;flex-wrap:wrap;margin:6px 0 10px} .kpi{padding:8px 14px;border-radius:6px;background:color-mix(in srgb,var(--vscode-foreground) 5%,transparent);min-width:150px}
.kpi b{display:block;font-size:20px} .kpi span{opacity:.75}
.spark{display:flex;align-items:flex-end;gap:3px;height:42px;margin:4px 0 12px} .spark i{width:10px;background:var(--vscode-progressBar-background,#0e70c0);border-radius:2px 2px 0 0;opacity:.8}
table{border-collapse:collapse;width:100%} th{text-align:left;font-weight:500;opacity:.75;padding:4px 12px 4px 0;vertical-align:top} td{padding:4px 12px 4px 0;vertical-align:top}
.phases th{width:220px} .num{text-align:right;white-space:nowrap} tr.hot td:first-child{border-left:3px solid var(--vscode-editorWarning-foreground,#d29922);padding-left:6px}
.prob{border-left:3px solid var(--vscode-focusBorder);padding:8px 12px;margin:8px 0;background:color-mix(in srgb,var(--vscode-foreground) 5%,transparent);border-radius:0 6px 6px 0}
.prob.ok{border-color:var(--vscode-testing-iconPassed,#3fb950)} .pt{font-weight:600} .pd{opacity:.85;margin:2px 0 6px}
.tag{font-size:11px;padding:0 6px;border-radius:8px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
button{font:inherit;padding:3px 12px;border-radius:4px;border:1px solid var(--vscode-button-border,transparent);background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}
button.sec{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)} button:disabled{opacity:.5;cursor:default}
.tools{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
</style></head><body>
<h1>Moon Core: Скорость VS Code</h1>
${head}
<div class=tools><button data-cmd=refresh class=sec>Обновить</button><button data-cmd=scan class=sec>Искать тяжёлые папки</button>
<button data-cmd=runtime class=sec title="Встроенный список VS Code: время активации и профилирование">Запущенные расширения</button>
<button data-cmd=process class=sec title="Память и процессор по процессам VS Code">Процессы</button>
<button data-cmd=startup class=sec title="Отчёт VS Code о последнем запуске">Отчёт VS Code о старте</button>
<button data-cmd=export class=sec title="JSON с замерами — для VS Code Launcher и разбора">Сохранить замеры</button></div>
<h2>Запуск окна</h2>${startSection(m)}
<h2>Советы</h2>${adviceSection(m)}
<h2>Расширения этого окна</h2>${extSection(m)}
<h2>Подвисания и память окон</h2>${windowsSection(m)}
<h2>Сам Moon Core</h2><table>
<tr><th>Активация расширения</th><td>${esc(sec(self.activate))}</td></tr>
<tr><th>Рантайм в окне до старта интерфейса</th><td>${esc(sec(self.runtime))}${self.modules ? " + модули " + esc(sec(self.modules)) : ""}</td></tr>
<tr><th>Файл замеров</th><td><code>${esc(m.perfFile || "")}</code> <button class=sec data-cmd=reveal>Показать</button><br><small>Поле <code>export</code> (схема moon-core/perf@1) читают внешние программы, например VS Code Launcher: средняя стоимость каждого расширения на старте.</small></td></tr>
</table>
<script nonce="${nonce}">
const vs = acquireVsCodeApi();
document.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-cmd]");
  if (!b) return;
  b.disabled = true;
  vs.postMessage({ cmd: b.dataset.cmd, arg: b.dataset.arg || "" });
});
</script></body></html>`;
}

module.exports = { render, ACTIONS, sec };
