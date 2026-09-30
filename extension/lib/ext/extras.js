// ============================================================
//  Мелкие удобства расширения:
//    - галерея готовых стилей (lib/gallery.js) — выбор галочками;
//    - применение профиля по имени (дерево «Вид», другие расширения);
//    - подсказки в редакторе CSS-сниппета: селектор, который сейчас ничего не находит,
//      подчёркнут после «Проверить элементы»;
//    - «Что нового» после обновления расширения;
//    - следующий профиль, вид через буфер обмена, переезд с Custom CSS and JS Loader.
// ============================================================
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const GL = require("../gallery");
const B = require("../bundle");
const LI = require("../legacy-import");
const S = require("../snippets");
const KEYS = require("../keys");
const { log } = require("../log");

/**
 * Команда «Галерея стилей». Стиль, на котором стоит курсор списка, виден в окне сразу — до
 * включения (предпросмотр уходит по мосту и снимается, когда список закрыт).
 */
function galleryCommand(host) {
    return new Promise((resolve) => {
        const have = GL.installed(host.dir);
        const qp = vscode.window.createQuickPick();
        qp.canSelectMany = true;
        qp.matchOnDescription = true;
        qp.placeholder = "Готовые стили — отметь нужные. Наведи стрелками: стиль сразу виден в окне. Каждый ляжет файлом в «Сниппеты».";
        const items = GL.STYLES.map((s) => ({ label: s.title, description: s.note, id: s.id }));
        qp.items = items;
        qp.selectedItems = items.filter((i) => have.has(i.id));
        const preview = (code) => { try { host.bridge.broadcast("preview", { id: GL.PREVIEW_ID, code: code }); } catch (e) {} };
        let accepted = false;
        qp.onDidChangeActive((active) => {
            const s = active && active[0] ? GL.STYLES.find((x) => x.id === active[0].id) : null;
            preview(s && !have.has(s.id) ? s.css : null);
        });
        qp.onDidAccept(() => {
            accepted = true;
            const pick = qp.selectedItems.map((p) => p.id);
            qp.hide();
            const r = GL.apply(host.dir, pick);
            // Снятый галочкой стиль мог быть выключен в дереве — включаем выбранные заново.
            pick.forEach((id) => { if (!host.isEnabled(GL.fileId(id))) host.setEnabled(GL.fileId(id), true); });
            host.rebuild();
            if (r.added.length || r.removed.length) {
                vscode.window.setStatusBarMessage("Moon Core: галерея — включено " + r.added.length + ", убрано " + r.removed.length, 5000);
                if (!host.bridge.status().streams) vscode.window.showWarningMessage("Moon Core: стили сохранены, но окно не на связи — они появятся после внедрения и перезагрузки окна.", "Доктор").then((p) => { if (p) vscode.commands.executeCommand("moonCore.doctor"); });
            }
            resolve(r);
        });
        qp.onDidHide(() => { preview(null); qp.dispose(); if (!accepted) resolve(null); });
        qp.show();
    });
}

/** Применить профиль по имени ("" — исходный вид). С подтверждением, если есть несохранённые правки. */
async function applyProfileCommand(host, name) {
    const sum = host.engine.summary();
    const n = String(name == null ? "" : name);
    if (n && !sum.list.some((p) => p.name === n)) { vscode.window.showWarningMessage("Moon Core: нет профиля «" + n.slice(0, 40) + "»"); return false; }
    const edits = host.engine.editCount();
    if (!n && !edits) return false;
    if (n === sum.active && !sum.dirty) return false;
    // Правки, которых нет ни в одном профиле, пропали бы молча — спросим (копия вида всё равно останется).
    if (edits && (!sum.active || sum.dirty)) {
        const ok = await vscode.window.showWarningMessage(n ? "Применить профиль «" + n + "»?" : "Вернуть исходный вид VS Code?", {
            modal: true, detail: "Текущие правки конструктора (" + edits + ") заменятся. Они сохранятся в резервной копии: «Moon Core: Восстановить вид из резервной копии».",
        }, "Применить");
        if (ok !== "Применить") return false;
    }
    const r = await host.onDesign({ ops: [n ? { op: "applyProfile", name: n } : { op: "clearAll" }] });
    if (!r.ok) vscode.window.showWarningMessage("Moon Core: " + r.error);
    else vscode.window.setStatusBarMessage("Moon Core: " + (n ? "профиль «" + n + "»" : "исходный вид"), 4000);
    return r.ok;
}

/** Где в тексте стоит селектор: [начало, конец] или null. Пробелы сравниваются без учёта количества. */
function findSelector(text, selector) {
    const at = text.indexOf(selector);
    if (at !== -1) return [at, at + selector.length];
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const parts = selector.trim().split(/\s+/).map(esc);
    try { const m = new RegExp(parts.join("\\s*")).exec(text); return m ? [m.index, m.index + m[0].length] : null; } catch (e) { return null; }
}

/**
 * Подсказки в CSS-сниппетах: после проверки селекторов те, что ничего не находят, подчёркнуты
 * в редакторе. Это не ошибка — элемент может быть просто не показан — поэтому уровень «сведения».
 */
function createSnippetDiagnostics(context, host) {
    const col = vscode.languages.createDiagnosticCollection("moonCore");
    context.subscriptions.push(col);
    host.onCheckDone = (summary) => {
        col.clear();
        const byFile = new Map();
        ((summary && summary.deadUser) || []).forEach((d) => {
            if (!S.validId(d.group) || S.kindOf(d.group) !== "css") return;
            if (!byFile.has(d.group)) byFile.set(d.group, []);
            byFile.get(d.group).push(d.selector);
        });
        byFile.forEach((sels, id) => {
            const file = path.join(host.dir, id);
            let text = "";
            try { text = fs.readFileSync(file, "utf8"); } catch (e) { return; }
            const lineAt = (off) => { const before = text.slice(0, off).split("\n"); return new vscode.Position(before.length - 1, before[before.length - 1].length); };
            const list = sels.slice(0, 100).map((sel) => {
                const hit = findSelector(text, sel);
                const range = hit ? new vscode.Range(lineAt(hit[0]), lineAt(hit[1])) : new vscode.Range(0, 0, 0, 1);
                const d = new vscode.Diagnostic(range, "Moon Core: селектор сейчас ничего не находит — элемент не показан или VS Code его переименовал: " + sel, vscode.DiagnosticSeverity.Information);
                d.source = "Moon Core";
                return d;
            });
            col.set(vscode.Uri.file(file), list);
        });
    };
    // Файл поправили — подсказки устарели до следующей проверки.
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => { if (host.snippetIdOf(doc)) col.delete(doc.uri); }));
    return col;
}

/** После обновления расширения — один раз сказать об этом и предложить список изменений. */
async function whatsNew(context) {
    const ver = String(context.extension.packageJSON.version || "");
    const seen = context.globalState.get(KEYS.SEEN_VERSION);
    if (!ver || seen === ver) return;
    await context.globalState.update(KEYS.SEEN_VERSION, ver);
    if (!seen) return;                                          // первая установка: рассказывать не о чем
    const file = path.join(context.extensionPath, "CHANGELOG.md");
    if (!fs.existsSync(file)) return;
    log("Moon Core обновлён: " + seen + " -> " + ver);
    const pick = await vscode.window.showInformationMessage("Moon Core обновлён до " + ver + ".", "Что нового");
    if (pick) { try { await vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.file(file)); } catch (e) { log("что нового", e); } }
}

/** Следующий (dir > 0) или предыдущий профиль по кругу: встроенные, затем свои. */
async function profileNextCommand(host, dir) {
    const sum = host.engine.summary();
    const names = sum.list.map((p) => p.name);
    if (!names.length) return false;
    const i = names.indexOf(sum.active);
    const next = names[(i + (dir < 0 ? -1 : 1) + names.length * 2 + (i === -1 && dir < 0 ? 1 : 0)) % names.length];
    return applyProfileCommand(host, next);
}

/** «Скопировать вид»: правки конструктора и профили — текстом в буфер обмена (без сниппетов). */
async function copyLookCommand(host) {
    const b = host.exportBundle({ snippets: false });
    await vscode.env.clipboard.writeText(JSON.stringify(b));
    vscode.window.setStatusBarMessage("Moon Core: вид скопирован (" + B.describe(B.parseBundle(b).bundle) + ") — вставь его командой «Вставить вид из буфера»", 6000);
    return true;
}

/** «Вставить вид из буфера»: тот же пакет, те же проверки и подтверждение, что при загрузке из файла. */
async function pasteLookCommand(host) {
    const text = String(await vscode.env.clipboard.readText() || "").trim();
    if (!text || text[0] !== "{") { vscode.window.showWarningMessage("Moon Core: в буфере обмена нет вида Moon Core. Скопируй его командой «Скопировать вид в буфер»."); return false; }
    return host.confirmAndImport(B.parseBundle(text), "буфера обмена");
}

/** Переезд с Custom CSS and JS Loader: файлы из vscode_custom_css.imports — в сниппеты Moon Core. */
async function importCustomCssCommand(host) {
    const imports = vscode.workspace.getConfiguration("vscode_custom_css").get("imports");
    if (!Array.isArray(imports) || !imports.length) {
        vscode.window.showInformationMessage("Moon Core: настройка vscode_custom_css.imports пуста — переносить из Custom CSS and JS Loader нечего.");
        return null;
    }
    const p = LI.plan(imports, (id) => fs.existsSync(path.join(host.dir, id)));
    if (!p.items.length) {
        vscode.window.showWarningMessage("Moon Core: из списка Custom CSS and JS Loader нечего взять (" + p.skipped.map((s) => s.why).join(", ") + ").");
        return p;
    }
    const js = p.items.filter((x) => x.kind === "js");
    const ok = await vscode.window.showInformationMessage("Перенести файлы Custom CSS and JS Loader в Moon Core?", {
        modal: true,
        detail: "Станут сниппетами: " + p.items.map((x) => path.basename(x.src) + " → " + x.id).join(", ") + "." +
            (js.length ? "\nJS-файлы (" + js.length + ") скопируются, но запустятся только после твоего одобрения." : "") +
            (p.skipped.length ? "\nПропущено: " + p.skipped.map((s) => s.entry + " (" + s.why + ")").join("; ") + "." : "") +
            "\nИсходные файлы и настройка старого расширения не меняются. После переноса старый загрузчик можно выключить — иначе стили применятся дважды.",
    }, "Перенести");
    if (ok !== "Перенести") return null;
    p.items.forEach((x) => fs.writeFileSync(path.join(host.dir, x.id), x.code, "utf8"));
    host.rebuild();
    log("перенос из Custom CSS and JS Loader: " + p.items.map((x) => x.id).join(", "));
    vscode.window.showInformationMessage("Moon Core: перенесено сниппетов: " + p.items.length + ". Они в панели Moon Core, раздел «Сниппеты».");
    return p;
}

module.exports = { galleryCommand, applyProfileCommand, createSnippetDiagnostics, whatsNew, findSelector,
    profileNextCommand, copyLookCommand, pasteLookCommand, importCustomCssCommand };
