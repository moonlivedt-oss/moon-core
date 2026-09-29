// ============================================================
//  Хост: сниппеты CSS/JS — одобрение JS, живой предпросмотр, создание и удаление.
//  Методы подмешиваются в класс Host (lib/host.js), this — хост.
// ============================================================
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const P = require("./protocol");
const S = require("./snippets");
const W = require("./wb-patch");
const { metaFile } = require("./storage");
const KEYS = require("./keys");
const AU = require("./audit");

const JS_OK_KEY = KEYS.JS_APPROVED; // id -> sha256 одобренного кода JS-сниппета

class SnippetsPart {
    // ---------------- одобрение JS-сниппетов ----------------
    // JS-сниппет выполняется в окне VS Code с полным доступом к интерфейсу. Поэтому запускается
    // только код, который ты видел: сохранённый в редакторе VS Code, созданный командой или
    // загруженный после подтверждения. Изменение файла снаружи (другая программа, синхронизация
    // без подтверждения) — сниппет не запускается, пока не одобришь. Хранится sha256 кода.
    approvedJs() { const v = this.context.globalState.get(JS_OK_KEY); return v && typeof v === "object" && !Array.isArray(v) ? Object.assign({}, v) : null; }
    async approveJs(id, code) {
        const m = this.approvedJs() || {};
        m[id] = W.sha256(code);
        await this.context.globalState.update(JS_OK_KEY, m);
    }
    /** Сниппеты, которые можно запускать: CSS — всегда, JS — только одобренный код. */
    runnable(list) {
        let ok = this.approvedJs();
        if (!ok) {
            // Первый запуск: одобренного нет. Раньше всё, что уже лежало в папке, одобрялось молча —
            // и JS, подложенный до установки (или после сброса хранилища), запускался без вопроса.
            // Теперь чистая карта: сниппеты, созданные в VS Code, одобряются при создании и сохранении.
            ok = {};
            this.context.globalState.update(JS_OK_KEY, ok);
        }
        this.jsPending = list.filter((s) => s.kind === "js" && !s.error && s.enabled && ok[s.id] !== W.sha256(s.code));
        if (this.jsPending.length) this.askJsPending();
        return list.filter((s) => this.jsPending.indexOf(s) === -1);
    }
    async askJsPending() {
        if (this.jsAsking) return;
        this.jsAsking = true;
        try {
            for (const s of this.jsPending.slice()) {
                const key = s.id + ":" + W.sha256(s.code);
                if (this.jsAsked && this.jsAsked.has(key)) continue;
                (this.jsAsked = this.jsAsked || new Set()).add(key);
                const pick = await vscode.window.showWarningMessage(
                    "Moon Core: JS-сниппет «" + s.id + "» не одобрен: его изменили не из VS Code (другая программа, синхронизация) " +
                    "или он появился до установки. Он выполняется в окне VS Code с полным доступом. Запустить этот код?",
                    "Открыть и проверить", "Запустить", "Не запускать");
                if (pick === "Запустить" || pick === "Не запускать") AU.record(this.context.globalState, "js", s.id, pick === "Запустить" ? "allow" : "deny").catch(() => {});
                if (pick === "Запустить") { await this.approveJs(s.id, s.code); this.rebuild(); }
                else if (pick === "Открыть и проверить") await this.open(s.id);
            }
        } finally { this.jsAsking = false; }
    }

    /** Проверенный id сниппета (имя файла в папке сниппетов) или "". Команды принимают аргументы
     *  от кого угодно (в том числе mc.command из окна) — путь вида ../x в папку не выпускаем. */
    snippetId(v) { const id = String(v == null ? "" : v); return S.validId(id) ? id : ""; }

    snippetIdOf(doc) {
        if (!doc || doc.uri.scheme !== "file") return "";
        const f = doc.uri.fsPath;
        // Регистр пути не важен только там, где его не различает файловая система.
        const same = process.platform === "win32" || process.platform === "darwin"
            ? path.dirname(f).toLowerCase() === this.dir.toLowerCase() : path.dirname(f) === this.dir;
        if (!same) return "";
        const id = path.basename(f);
        return S.validId(id) ? id : "";
    }

    /** Живой предпросмотр: несохранённый CSS уходит в окно через 120 мс после последней правки. */
    onDocChange(doc) {
        const id = this.snippetIdOf(doc);
        if (!id || S.kindOf(id) !== "css") return;
        if (!vscode.workspace.getConfiguration("moonCore").get("livePreview", true)) return;
        clearTimeout(this.previewTimers.get(id));
        this.previewTimers.set(id, setTimeout(() => {
            this.sendPreview(id, doc.isDirty ? doc.getText().slice(0, P.MAX_SNIPPET) : null);
        }, 120));
    }

    sendPreview(id, code) { this.bridge.broadcast("preview", { id: id, code: code }); }

    isEnabled(id) { return !S.readMeta(metaFile(this.context)).disabled.includes(id); }

    setEnabled(id, on) {
        if (!S.validId(String(id))) return;
        const meta = S.readMeta(metaFile(this.context));
        const set = new Set(meta.disabled);
        if (on) set.delete(id); else set.add(id);
        S.writeMeta(metaFile(this.context), { disabled: Array.from(set) });
        this.rebuild();
    }

    fileOf(id) {
        if (!S.validId(String(id))) throw new Error("Moon Core: недопустимое имя сниппета");
        return path.join(this.dir, id);
    }

    /** Дописать текст в сниппет через редактор (правка видна в открытом буфере, превью работает). */
    async appendViaEditor(id, text, opts) {
        const o = opts || {};
        const file = this.fileOf(id);
        if (!fs.existsSync(file)) fs.writeFileSync(file, "", "utf8");
        if (!this.isEnabled(id)) this.setEnabled(id, true);
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        const end = doc.lineAt(doc.lineCount - 1).range.end;
        const prefix = doc.getText().trim() ? (/\n\s*$/.test(doc.getText()) ? "\n" : "\n\n") : "";
        const edit = new vscode.WorkspaceEdit();
        edit.insert(doc.uri, end, prefix + text);
        await vscode.workspace.applyEdit(edit);
        if (o.save) await doc.save();
        if (o.reveal) {
            const ed = await vscode.window.showTextDocument(doc, { preview: false });
            if (typeof o.cursorFromEnd === "number") {
                const line = Math.max(0, doc.lineCount - 1 - o.cursorFromEnd);
                const pos = doc.lineAt(line).range.end;
                ed.selection = new vscode.Selection(pos, pos);
                ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            }
        }
    }

    async open(id) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.fileOf(id)));
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    async create(kind) {
        const name = await vscode.window.showInputBox({
            prompt: kind === "js" ? "Имя JS-сниппета (выполняется в окне VS Code)" : "Имя CSS-сниппета",
            value: kind === "js" ? "my-script" : "my-style",
            validateInput: (v) => /^[A-Za-z0-9][\w.-]{0,50}$/.test(v) ? null : "Латиница, цифры, - _ .",
        });
        if (!name) return;
        const id = S.freeId(this.dir, name.replace(/\.(css|js)$/i, ""), kind);
        fs.writeFileSync(this.fileOf(id), kind === "js" ? JS_TEMPLATE : CSS_TEMPLATE, "utf8");
        if (kind === "js") await this.approveJs(id, JS_TEMPLATE);
        this.rebuild();
        await this.open(id);
    }

    async remove(id) {
        const pick = await vscode.window.showWarningMessage("Удалить сниппет " + id + "? Он уйдёт в корзину.", { modal: true }, "Удалить");
        if (pick !== "Удалить") return;
        await vscode.workspace.fs.delete(vscode.Uri.file(this.fileOf(id)), { useTrash: true });
        this.rebuild();
    }
}

const CSS_TEMPLATE = [
    "/* CSS-сниппет Moon Core.",
    "   Применяется ко всему окну VS Code. Пока файл не сохранён — правка видна сразу (живой",
    "   предпросмотр), после сохранения — остаётся насовсем.",
    "   Селектор нужного элемента проще всего взять пипеткой: Ctrl+Alt+Shift+C. */",
    "",
    "",
].join("\n");

const JS_TEMPLATE = [
    "// JS-сниппет Moon Core: выполняется в окне VS Code после сохранения.",
    "// Переменная mc — помощник, всё созданное через него убирается само при правке/выключении:",
    "//   mc.watch(selector, el => {...})  — для каждого (и будущего) элемента по селектору",
    "//   mc.el(tag, props, children)      — создать элемент",
    "//   mc.mount(parent, node)           — вставить узел (уберётся при выгрузке)",
    "//   mc.css(text)                     — добавить стиль",
    "//   mc.on(target, event, fn)         — подписка",
    "//   mc.every(ms, fn)                 — таймер",
    "//   mc.command(id, ...args)          — выполнить команду VS Code (Promise)",
    "//   mc.toast(text)                   — короткое сообщение",
    "//   mc.onDispose(fn)                 — своя уборка",
    "",
    "// Пример: кнопка в статусбаре, открывающая терминал.",
    "// mc.watch('.statusbar .right-items', (bar) => {",
    "//     const btn = mc.el('div', { className: 'statusbar-item', textContent: 'TERM', title: 'Терминал' });",
    "//     btn.style.cursor = 'pointer';",
    "//     mc.on(btn, 'click', () => mc.command('workbench.action.terminal.toggleTerminal'));",
    "//     mc.mount(bar, btn);",
    "// });",
    "",
].join("\n");

module.exports = { Part: SnippetsPart, CSS_TEMPLATE, JS_TEMPLATE };
