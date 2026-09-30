// ============================================================
//  «Доктор» Moon Core: всё состояние на одной странице (webview) и кнопки починки.
//  Что считать проблемой — lib/doctor-model.js; здесь сбор снимка, страница и действия.
// ============================================================
"use strict";

const vscode = require("vscode");
const crypto = require("crypto");
const inject = require("./inject");
const MH = require("./module-host");
const DM = require("./doctor-model");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { log, showLog, recentLog, redact, logFilePath, flushFile } = require("./log");
const PM = require("./ext/permissions");
const { diagnosticLines } = require("./ext/status");
const VU = require("./ext/vs-files-ui");

let panel = null;

/** Снимок состояния для модели и страницы. */
function snapshot(context, host, check) {
    const found = MH.discover(), allowedList = MH.allowed(context, found);
    let pending = [];
    try { pending = (inject.moduleSet(context).pending || []).map((p) => p.module.id); } catch (e) {}
    const ps = host.engine.summary();
    return {
        vscode: vscode.version,
        ext: String(context.extension.packageJSON.version || "?"),
        shells: inject.status(context),
        bridge: host.bridge.status(),
        timing: host.lastTiming || null,
        modules: {
            found: found.map((m) => ({ id: m.id, name: m.name, version: m.version, source: MH.sourceTitle(m), allowed: allowedList.indexOf(m) !== -1, dev: MH.isDev(m) })),
            pending: pending,
        },
        design: { rules: Object.keys(host.design.rules).length, settings: Object.keys(host.design.settings).length, active: ps.active, dirty: ps.dirty, profiles: ps.list.filter((p) => !p.builtin).length },
        snippets: {
            total: host.list.length, on: host.state.snippets.length,
            errors: host.list.filter((s) => s.error).map((s) => ({ id: s.id, error: s.error })),
            jsPending: (host.jsPending || []).map((s) => s.id),
        },
        check: check || null,
        recovery: inject.recoveryPath(context),
        errors: typeof host.errorTop === "function" ? host.errorTop(8) : [],
        permissions: PM.summary(context),
        files: VU.filesSummary(false),
        windows: typeof host.windowsInfo === "function" ? host.windowsInfo() : [],
        safe: typeof host.safeMode === "function" ? host.safeMode() : false,
        history: host.engine.history ? host.engine.history.summary() : { undo: 0, redo: 0 },
        logFile: logFilePath(),
    };
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);

function render(s, list, nonce, busy) {
    const v = DM.verdict(list);
    const head = { ok: "Всё в порядке", warn: "Есть что поправить", error: "Есть поломки" }[v];
    const row = (k, val) => "<tr><th>" + esc(k) + "</th><td>" + val + "</td></tr>";
    const yes = (b, t, f) => b ? "<span class=ok>" + esc(t) + "</span>" : "<span class=bad>" + esc(f) + "</span>";
    const shells = s.shells.map((x) => row(x.file.split(/[\\/]/).slice(-2).join("/"),
        yes(x.injected, "внедрено", "не внедрено") + (x.injected ? ", рантайм " + yes(x.current, "актуален", "устарел") : "") +
        (x.checksum === true ? ", хэш сходится" : x.checksum === false ? ", " + yes(false, "", "хэш не сходится") : "") +
        (x.modules && x.modules.length ? "<br><small>модули в оболочке: " + esc(x.modules.join(", ")) + "</small>" : "") +
        (x.deep ? "<br><small>сервисы окна: " + (x.deep.di ? "включены" : x.deep.diSupported ? "выключены" : "не поддерживаются") + ", главный процесс: " + (x.deep.main ? "включён" : "выключен") +
            ", стили webview: " + (x.deep.webview ? "вписаны" : x.deep.want && x.deep.want.webview ? (x.deep.webviewSupported === false ? "файл не тронут" : "нет сниппетов webview*.css") : "выключены") + "</small>" : ""))).join("");
    const b = s.bridge;
    const t = s.timing;
    const timing = t ? "рантайм " + esc(t.runtime) + " мс" + Object.keys(t.modules).map((k) => ", " + esc(k) + " " + esc(t.modules[k]) + " мс").join("") +
        (t.stages && Object.keys(t.stages).length ? "<br><small>этапы: " + Object.keys(t.stages).sort((a, c) => t.stages[a] - t.stages[c]).map((k) => esc(k) + " " + esc(t.stages[k]) + " мс").join(", ") + "</small>" : "") : "данных ещё нет";
    const errs = (s.errors || []).length ? s.errors.map((e) => esc(e.source) + " — " + esc(e.n)).join(", ") : "ошибок окна не было";
    const methods = b.byMethod ? Object.keys(b.byMethod).sort((x, y) => b.byMethod[y] - b.byMethod[x]).slice(0, 6).map((k) => esc(k) + " " + esc(b.byMethod[k])).join(", ") : "";
    const mods = s.modules.found.length ? s.modules.found.map((m) => "<li><b>" + esc(m.name) + "</b> <code>" + esc(m.id) + "</code> " + esc(m.version || "") +
        " — " + esc(m.source) + (m.allowed ? "" : " <span class=bad>не разрешён</span>") + (m.dev ? " <span class=tag>разработка</span>" : "") + "</li>").join("") : "<li>модулей нет</li>";
    const c = s.check;
    const checkLine = c ? "правил пользователя " + c.user.total + ", без совпадений " + c.user.dead + "; каталог " + c.catalog.total + " / " + c.catalog.dead +
        (c.heals.length ? "; можно починить: " + c.heals.length : "") : busy ? "проверяю..." : (b.streams ? "не проверялось" : "нужна связь с окном");
    const probs = list.length ? list.map((p) => "<div class='prob " + p.level + "'><div class=pt>" + esc(p.title) + "</div>" +
        (p.detail ? "<div class=pd>" + esc(p.detail) + "</div>" : "") +
        (p.fix ? "<button data-cmd='" + esc(p.fix) + "'>" + esc(p.fixLabel || "Починить") + "</button>" : "") + "</div>").join("")
        : "<div class='prob ok'><div class=pt>Проблем не найдено</div></div>";
    const plan = DM.autoPlan(list);
    const fixAll = plan.fixes.length + (plan.reload ? 1 : 0) >= 2 ? "<button data-cmd=fixAll title=\"По очереди: " + esc(plan.fixes.concat(plan.reload ? ["reload"] : []).join(", ")) + "\">Починить всё</button>" : "";
    const wins = Array.isArray(s.windows) ? s.windows : [];
    const fl = s.files;
    const filesRow = !fl ? "" : row("Файлы VS Code", "проверено " + esc(fl.total) + ": исходных " + esc(fl.total - fl.foreign.length - fl.mooncore.length - fl.missing.length) +
        ", изменено Moon Core " + esc(fl.mooncore.length) + (fl.foreign.length ? ", " + yes(false, "", "изменено не только Moon Core: " + fl.foreign.length) : "") +
        "<br><small>основа webview: " + esc({ clean: "исходная", mooncore: "со стилями Moon Core", foreign: fl.webviewCspOff ? "защита CSP отключена другой программой" : "изменена другой программой", missing: "не найдена" }[fl.webview] || fl.webview) +
        (fl.leftovers.length ? "; файлов других загрузчиков: " + esc(fl.leftovers.length) : "") + "</small>");
    return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Moon Core: Доктор</title>
<style nonce="${nonce}">
body{font:13px/1.5 var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px 22px;max-width:980px}
h1{font-size:18px;margin:0 0 4px} h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;opacity:.7;margin:22px 0 8px}
.verdict{display:inline-block;padding:2px 10px;border-radius:10px;font-weight:600;margin-bottom:10px}
.verdict.ok{background:color-mix(in srgb,var(--vscode-testing-iconPassed,#3fb950) 25%,transparent)}
.verdict.warn{background:color-mix(in srgb,var(--vscode-editorWarning-foreground,#d29922) 25%,transparent)}
.verdict.error{background:color-mix(in srgb,var(--vscode-errorForeground,#f85149) 25%,transparent)}
.prob{border-left:3px solid var(--vscode-focusBorder);padding:8px 12px;margin:8px 0;background:color-mix(in srgb,var(--vscode-foreground) 5%,transparent);border-radius:0 6px 6px 0}
.prob.error{border-color:var(--vscode-errorForeground,#f85149)} .prob.warn{border-color:var(--vscode-editorWarning-foreground,#d29922)} .prob.ok{border-color:var(--vscode-testing-iconPassed,#3fb950)}
.pt{font-weight:600} .pd{opacity:.8;margin:2px 0 6px}
button{font:inherit;padding:3px 12px;border-radius:4px;border:1px solid var(--vscode-button-border,transparent);background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}
button.sec{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button:hover{filter:brightness(1.1)} button:disabled{opacity:.5;cursor:default}
table{border-collapse:collapse;width:100%} th{text-align:left;font-weight:500;opacity:.7;padding:4px 16px 4px 0;vertical-align:top;white-space:nowrap;width:1%} td{padding:4px 0;word-break:break-word}
.ok{color:var(--vscode-testing-iconPassed,#3fb950)} .bad{color:var(--vscode-errorForeground,#f85149)}
.tag{font-size:11px;padding:0 6px;border-radius:8px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
code,small{opacity:.75} ul{margin:0;padding-left:18px} .bar{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
</style></head><body>
<h1>Moon Core: Доктор</h1>
<div class="verdict ${v}">${esc(head)}</div>
<div class=bar>
${fixAll}<button data-cmd=refresh class=sec>Обновить</button><button data-cmd=check class=sec>Проверить селекторы</button>
<button data-cmd=inject class=sec>Внедрить заново</button><button data-cmd=modules class=sec>Модули</button>
<button data-cmd=moduleDev class=sec>Режим разработки</button><button data-cmd=log class=sec>Журнал</button>
<button data-cmd=report class=sec title="Диагностика и последние строки журнала — без имени пользователя и токенов">Скопировать отчёт</button>
<button data-cmd=export class=sec title="Отчёт, снимок состояния и копии оболочки — в папку для разбора без доступа к машине">Экспорт в файл</button>
</div>
<h2>Что не так</h2>${probs}
<h2>Оболочка VS Code</h2><table>${row("VS Code / Moon Core", esc(s.vscode) + " / " + esc(s.ext))}${shells}
${filesRow}
${row("Аварийное восстановление", "<code>" + esc(s.recovery) + "</code> <button data-cmd=recovery class=sec>Показать</button>")}</table>
<h2>Связь и запуск</h2><table>
${row("Мост", b.running ? "127.0.0.1:" + esc(b.port) + ", окон на связи: " + esc(b.streams) + ", запросов: " + esc(b.requests) : yes(false, "", "не поднят"))}
${row("Окна", wins.length ? "на связи " + wins.length + (wins.some((w) => w.stale) ? ", " + yes(false, "", "со старым рантаймом: " + wins.filter((w) => w.stale).length) : ", рантайм у всех актуален") : "пульса ещё не было")}
${row("Время запуска окна", timing)}
${row("Ошибки окна", errs)}
${row("Запросы по методам", methods || "—")}${b.rejected || b.dropped ? row("Отклонено", "по лимиту " + esc(b.rejected || 0) + ", зависших окон отключено " + esc(b.dropped || 0)) : ""}
${row("Проверка селекторов", esc(checkLine))}</table>
<h2>Вид</h2><table>
${row("Конструктор", "правил " + s.design.rules + ", настроек VS Code " + s.design.settings + (s.design.active ? ", профиль «" + esc(s.design.active) + "»" + (s.design.dirty ? " (изменён)" : "") : ""))}
${row("Свои профили", esc(s.design.profiles))}
${row("История и копии", "можно отменить шагов: " + esc(s.history ? s.history.undo : 0) + " <button data-cmd=backups class=sec>Резервные копии вида</button> <button data-cmd=gallery class=sec>Галерея стилей</button>")}
${row("Сниппеты", "включено " + s.snippets.on + " из " + s.snippets.total)}
${row("Разрешения", esc(s.permissions || "") + " <button data-cmd=permissions class=sec>Журнал разрешений</button>")}
${row("Файл журнала", "<code>" + esc(s.logFile || "выключен") + "</code>")}</table>
<h2>Модули</h2><ul>${mods}</ul>
<script nonce="${nonce}">
const vs = acquireVsCodeApi();
document.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-cmd]");
  if (!b) return;
  b.disabled = true;
  vs.postMessage({ cmd: b.dataset.cmd });
});
</script></body></html>`;
}

/** Отчёт для issue: диагностика, проблемы Доктора и хвост журнала (всё уже без домашней папки и токенов). */
function reportText(context, host, lastCheck) {
    const s = snapshot(context, host, lastCheck);
    const probs = DM.problems(s).map((p) => "  [" + p.level + "] " + p.title + (p.detail ? " — " + p.detail : ""));
    return [].concat(
        diagnosticLines(context, host),
        ["", "=== Доктор: " + DM.verdict(DM.problems(s)) + " ==="], probs.length ? probs : ["  проблем нет"],
        ["", "=== Журнал (последние строки) ==="], recentLog(80),
    ).map((l) => redact(l)).join("\n");
}

/**
 * Экспорт диагностики в папку: отчёт, снимок состояния (JSON), журнал из файла и копии оболочек
 * (без нашего блока нет смысла — оболочка как есть, с блоком). Для разбора проблемы без доступа
 * к машине: папку можно заархивировать и приложить к issue. Имя пользователя и токены вырезаны.
 */
async function exportDiagnostics(context, host, lastCheck) {
    const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Сохранить диагностику сюда", defaultUri: vscode.Uri.file(os.homedir()) });
    if (!pick || !pick[0]) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dir = path.join(pick[0].fsPath, "moon-core-diagnostics-" + stamp);
    fs.mkdirSync(dir, { recursive: true });
    const put = (name, text) => fs.writeFileSync(path.join(dir, name), redact(text), "utf8");
    put("report.txt", reportText(context, host, lastCheck));
    put("snapshot.json", JSON.stringify(snapshot(context, host, lastCheck), null, 2));
    flushFile();
    [logFilePath(), logFilePath() && logFilePath() + ".1"].filter(Boolean).forEach((f, i) => {
        try { put(i ? "mooncore.log.1" : "mooncore.log", fs.readFileSync(f, "utf8")); } catch (e) {}
    });
    (inject.status(context) || []).forEach((x, i) => {
        try { put("shell-" + i + "-" + path.basename(x.file), fs.readFileSync(x.file, "utf8")); } catch (e) {}
    });
    log("диагностика сохранена: " + dir);
    const r = await vscode.window.showInformationMessage("Moon Core: диагностика сохранена (без имени пользователя и токенов).", "Открыть папку");
    if (r) await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(path.join(dir, "report.txt")));
    return dir;
}

const NONCE_MARK = "__MOONCORE_NONCE__";

async function openDoctor(context, host) {
    let lastCheck = null, busy = false, lastHtml = "";
    // Страница пересобирается раз в 5 с, но в webview уходит только если что-то поменялось:
    // иначе сбрасывались бы прокрутка и нажатые кнопки.
    const show = (force) => {
        if (!panel) return;
        const s = snapshot(context, host, lastCheck);
        const html = render(s, DM.problems(s), NONCE_MARK, busy);
        if (!force && html === lastHtml) return;
        lastHtml = html;
        panel.webview.html = html.split(NONCE_MARK).join(crypto.randomBytes(16).toString("base64").replace(/[^A-Za-z0-9]/g, ""));
    };
    const check = async () => {
        busy = true; show();
        try { lastCheck = await host.runCheck(); } catch (e) { log("доктор: проверка", e); }
        busy = false; show();
    };
    if (panel) { panel.reveal(); show(true); return; }
    panel = vscode.window.createWebviewPanel("moonCore.doctor", "Moon Core: Доктор", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: false });
    panel.onDidDispose(() => { panel = null; clearInterval(timer); }, null, context.subscriptions);
    const timer = setInterval(() => { if (panel && panel.visible && !busy) show(); }, 5000);
    panel.webview.onDidReceiveMessage(async (msg) => {
        const cmd = msg && DM.ACTIONS.indexOf(msg.cmd) !== -1 ? msg.cmd : "";
        try {
            if (cmd === "refresh" || cmd === "inject" || cmd === "remove") VU.resetFilesSummary();
            if (cmd === "inject") await inject.injectCommand(context);
            else if (cmd === "remove") await inject.removeCommand(context);
            else if (cmd === "reload") await vscode.commands.executeCommand("workbench.action.reloadWindow");
            else if (cmd === "check") await check();
            else if (cmd === "heal") { if (lastCheck && lastCheck.heals.length) await host.offerHeals(lastCheck.heals); await check(); }
            else if (cmd === "log") showLog();
            else if (cmd === "modules") await vscode.commands.executeCommand("moonCore.modules");
            else if (cmd === "moduleDev") await vscode.commands.executeCommand("moonCore.moduleDev");
            else if (cmd === "recovery") await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(inject.recoveryPath(context)));
            else if (cmd === "design") host.toggleDesign();
            else if (cmd === "jsReview") { host.jsAsked = new Set(); await host.askJsPending(); }
            else if (cmd === "permissions") await PM.showPermissions(context, host);
            else if (cmd === "safe") await host.safeModeCommand();
            else if (cmd === "legacy") {
                try { inject.cleanLegacy(inject.status(context), context); VU.resetFilesSummary(); vscode.window.setStatusBarMessage("Moon Core: следы старого загрузчика убраны — значок-ведёрко исчезнет после перезагрузки окна", 5000); }
                catch (e) { log("следы старого загрузчика", e); vscode.window.showWarningMessage("Moon Core: не удалось убрать метки (" + e.message + "). Если VS Code стоит в Program Files — помогут «Внедрить заново» с правами администратора."); }
            }
            else if (cmd === "backups") await host.restoreBackupCommand();
            else if (cmd === "gallery") await vscode.commands.executeCommand("moonCore.gallery");
            else if (cmd === "fixAll") {
                const s0 = snapshot(context, host, lastCheck);
                const plan = DM.autoPlan(DM.problems(s0));
                for (const f of plan.fixes) {
                    log("доктор: починить всё — " + f);
                    if (f === "inject") await inject.injectCommand(context);
                    else if (f === "heal" && lastCheck && lastCheck.heals.length) await host.offerHeals(lastCheck.heals);
                    else if (f === "jsReview") { host.jsAsked = new Set(); await host.askJsPending(); }
                }
                if (plan.reload && !plan.fixes.includes("inject")) {
                    const pick = await vscode.window.showInformationMessage("Moon Core: осталось перезагрузить окно.", "Перезагрузить окно");
                    if (pick) await vscode.commands.executeCommand("workbench.action.reloadWindow");
                }
            }
            else if (cmd === "export") await exportDiagnostics(context, host, lastCheck);
            else if (cmd === "report") {
                await vscode.env.clipboard.writeText(reportText(context, host, lastCheck));
                vscode.window.setStatusBarMessage("Moon Core: отчёт скопирован — вставь его в issue", 5000);
            }
        } catch (e) { log("доктор: " + cmd, e); }
        show(true);                                     // нажатая кнопка снова активна
    });
    show();
    if (host.bridge.status().streams) check();
}

module.exports = { openDoctor, snapshot, render, reportText, exportDiagnostics };
