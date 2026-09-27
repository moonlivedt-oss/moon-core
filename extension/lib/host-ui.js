// ============================================================
//  Хост: интерфейс сверх CSS.
//    - выбор команды для своей кнопки (QuickPick VS Code; выбранная команда сразу разрешена);
//    - контекст окна для правил «только для...» (язык, ветка, проект, тема) — событие "ctx";
//    - шлюз к настоящему API VS Code для модулей (метод моста "native"): элементы статусбара,
//      уведомления, выбор из списка, ввод строки, открыть файл, прочитать настройку;
//    - кнопки от других расширений (API Moon Core ui.button) — в состоянии окна как uiButtons.
//  Методы подмешиваются в класс Host (lib/host.js), this — хост.
// ============================================================
"use strict";

const vscode = require("vscode");
const path = require("path");
const crypto = require("crypto");
const CMD = require("./commands");
const D = require("./design");
const { log } = require("./log");

const ALLOWED_STORE = "mooncore.allowedCommands";
const MOD_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const ITEM_ID_RE = /^[\w.-]{1,40}$/;
const clip = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001F]/g, " ").slice(0, n);

// Частые встроенные команды VS Code: у них нет заголовков в API, подписываем сами.
const BUILTIN = [
    ["workbench.action.terminal.toggleTerminal", "Терминал: показать / скрыть", "terminal"],
    ["workbench.action.toggleSidebarVisibility", "Боковая панель: показать / скрыть", "layout-sidebar-left"],
    ["workbench.action.togglePanel", "Нижняя панель: показать / скрыть", "layout-panel"],
    ["workbench.action.toggleZenMode", "Режим дзен", "screen-full"],
    ["workbench.action.toggleMaximizedPanel", "Развернуть нижнюю панель", "screen-full"],
    ["editor.action.formatDocument", "Форматировать документ", "symbol-namespace"],
    ["workbench.action.files.saveAll", "Сохранить всё", "save-all"],
    ["workbench.action.splitEditor", "Разделить редактор", "split-horizontal"],
    ["workbench.action.showCommands", "Палитра команд", "terminal-cmd"],
    ["workbench.action.openSettings", "Настройки", "settings-gear"],
    ["workbench.action.files.newUntitledFile", "Новый файл", "new-file"],
    ["workbench.action.moveEditorToNewWindow", "Редактор — в отдельное окно", "window"],
    ["workbench.action.copyEditorToNewWindow", "Копия редактора в новом окне", "window"],
    ["workbench.action.reloadWindow", "Перезагрузить окно", "refresh"],
    ["editor.action.toggleMinimap", "Миникарта: показать / скрыть", "map"],
    ["editor.action.toggleWordWrap", "Перенос строк", "word-wrap"],
    ["workbench.action.quickOpen", "Быстро открыть файл", "go-to-file"],
    ["workbench.view.explorer", "Проводник", "files"],
    ["workbench.view.search", "Поиск", "search"],
    ["workbench.view.scm", "Система контроля версий", "source-control"],
    ["workbench.action.debug.start", "Запустить отладку", "debug-alt"],
    ["workbench.action.tasks.runTask", "Запустить задачу", "play"],
    ["moonCore.design", "Moon Core: конструктор", "layout"],
    ["moonCore.profile", "Moon Core: профили вида", "symbol-color"],
];

class UIPart {
    // ---------------- своя кнопка: выбор команды ----------------

    /**
     * Окно просит выбрать команду для кнопки. Список показывает VS Code (не окно), поэтому
     * выбор — действие человека: команда сразу попадает в разрешённые для кнопок и сниппетов.
     */
    async pickCommandForButton() {
        const items = BUILTIN.map(([id, title, icon]) => ({ label: "$(" + icon + ") " + title, description: id, id: id, icon: icon, title: title }));
        const seen = new Set(BUILTIN.map((b) => b[0]));
        vscode.extensions.all.forEach((ext) => {
            const cmds = ext.packageJSON && ext.packageJSON.contributes && ext.packageJSON.contributes.commands;
            (Array.isArray(cmds) ? cmds : []).forEach((c) => {
                if (!c || typeof c.command !== "string" || seen.has(c.command) || !CMD.validCommand(c.command)) return;
                seen.add(c.command);
                const t = typeof c.title === "string" ? c.title : (c.title && c.title.value) || c.command;
                const cat = typeof c.category === "string" ? c.category : (c.category && c.category.value) || "";
                items.push({ label: (cat ? cat + ": " : "") + t, description: c.command, id: c.command, title: t, icon: "" });
            });
        });
        const all = await vscode.commands.getCommands(true);
        all.filter((id) => !seen.has(id) && CMD.validCommand(id) && !id.startsWith("_")).sort().forEach((id) => items.push({ label: id, id: id, title: id.split(".").pop(), icon: "" }));
        const pick = await vscode.window.showQuickPick(items, { placeHolder: "Команда для кнопки (начни печатать: терминал, формат, git...)", matchOnDescription: true });
        if (!pick) return { ok: false, cancelled: true };
        const list = CMD.cleanList(this.context.globalState.get(ALLOWED_STORE));
        if (list.indexOf(pick.id) === -1) await this.context.globalState.update(ALLOWED_STORE, list.concat([pick.id]));
        log("кнопка: выбрана команда " + pick.id + " (разрешена)");
        return { ok: true, command: pick.id, title: clip(pick.title, 40), icon: pick.icon || "" };
    }

    // ---------------- контекст окна для правил «только для...» ----------------

    ctxInfo() {
        const c = this.contextNow();
        return { lang: c.language, branch: c.branch, folder: c.folder, theme: c.theme };
    }
    /** Разослать контекст этого окна; окно применит его, только если хост — свой. */
    scheduleCtx() {
        clearTimeout(this.ctxTimer);
        this.ctxTimer = setTimeout(() => {
            const info = this.ctxInfo();
            const key = JSON.stringify(info);
            if (key === this.ctxLast && !this.ctxForce) return;
            this.ctxLast = key; this.ctxForce = false;
            this.bridge.broadcast("ctx", info);
        }, 200);
    }

    // ---------------- шлюз к API VS Code для модулей ----------------

    /**
     * Метод моста "native" { id (модуль), op, ... }. Модуль уже одобрен пользователем и
     * исполняется с правами интерфейса, поэтому шлюз даёт ему настоящие элементы VS Code вместо
     * подделок в вёрстке. Команды по-прежнему — через согласие (mc.command / метод command).
     */
    async onNative(body) {
        const id = String(body && body.id || "");
        if (!MOD_ID_RE.test(id) || !this.modules.has(id)) return { ok: false, error: "unknown module" };
        const op = String(body.op || "");
        try {
            if (op === "statusItem") return this.nativeStatusItem(id, body);
            if (op === "notify") {
                const kind = body.kind === "warning" ? "showWarningMessage" : body.kind === "error" ? "showErrorMessage" : "showInformationMessage";
                const buttons = (Array.isArray(body.buttons) ? body.buttons : []).slice(0, 4).map((b) => clip(b, 40)).filter(Boolean);
                const pick = await vscode.window[kind](clip(body.text, 1000), ...buttons);
                return { ok: true, result: pick || null };
            }
            if (op === "quickPick") {
                const items = (Array.isArray(body.items) ? body.items : []).slice(0, 500).map((x) => typeof x === "string"
                    ? { label: clip(x, 200) } : { label: clip(x && x.label, 200), description: clip(x && x.description, 200), detail: clip(x && x.detail, 300), value: x && x.value });
                const pick = await vscode.window.showQuickPick(items, { placeHolder: clip(body.placeholder, 200), canPickMany: body.many === true });
                if (!pick) return { ok: true, result: null };
                const out = (x) => (x.value !== undefined ? x.value : x.label);
                return { ok: true, result: Array.isArray(pick) ? pick.map(out) : out(pick) };
            }
            if (op === "input") {
                const v = await vscode.window.showInputBox({ prompt: clip(body.prompt, 300), value: clip(body.value, 2000), password: body.password === true });
                return { ok: true, result: v === undefined ? null : v };
            }
            if (op === "open") {
                const p = String(body.path || "");
                if (!path.isAbsolute(p)) return { ok: false, error: "нужен абсолютный путь" };
                await vscode.window.showTextDocument(vscode.Uri.file(p), { preview: body.preview !== false });
                return { ok: true };
            }
            if (op === "config") {
                const key = String(body.key || "");
                if (!/^[A-Za-z][\w.-]{0,120}$/.test(key)) return { ok: false, error: "bad key" };
                const v = vscode.workspace.getConfiguration().get(key);
                let safe = null;
                try { safe = v === undefined ? null : JSON.parse(JSON.stringify(v)); } catch (e) { safe = null; }
                return { ok: true, result: safe };
            }
            if (op === "context") return { ok: true, result: this.ctxInfo() };
            return { ok: false, error: "unknown op" };
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    }

    /** Настоящий элемент статусбара VS Code от имени модуля. Клик приходит модулю событием "nativeClick". */
    nativeStatusItem(modId, b) {
        const itemId = String(b.item || "");
        if (!ITEM_ID_RE.test(itemId)) return { ok: false, error: "bad item id" };
        if (!this.nativeItems) this.nativeItems = new Map();
        const key = modId + "/" + itemId;
        let it = this.nativeItems.get(key);
        if (b.dispose === true) { if (it) { it.dispose(); this.nativeItems.delete(key); } return { ok: true }; }
        if (!it) {
            if (this.nativeItems.size >= 64) return { ok: false, error: "слишком много элементов" };
            it = vscode.window.createStatusBarItem("moonCore.native." + key, b.side === "left" ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right, typeof b.priority === "number" ? b.priority : 50);
            it.name = clip(b.name || modId, 60);
            it.command = { command: "moonCore._nativeClick", title: "", arguments: [modId, itemId] };
            this.nativeItems.set(key, it);
            this.context.subscriptions.push(it);
        }
        it.text = clip(b.text, 120);
        it.tooltip = clip(b.tooltip, 500);
        it.backgroundColor = b.warning ? new vscode.ThemeColor("statusBarItem.warningBackground") : b.error ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
        if (b.hidden === true) it.hide(); else it.show();
        return { ok: true };
    }
    nativeClick(modId, itemId) {
        try { this.modules.publish(modId, "nativeClick", { item: itemId }, { scope: "window" }); } catch (e) { log("шлюз: клик", e); }
    }

    // ---------------- кнопки от других расширений ----------------

    /**
     * API Moon Core для расширений: ui.button({...}) — кнопка в интерфейсе от имени расширения.
     * id кнопки выводится из владельца и его id: у разных расширений одинаковый spec.id не
     * столкнётся, а та же кнопка из хостов разных окон — одна и та же (окно не задвоит её).
     */
    uiApi(owner) {
        const host = this;
        const who = clip(owner, 80) || "расширение";
        if (!this.uiButtons) this.uiButtons = new Map();
        return {
            button: (spec) => {
                const own = String(spec && spec.id || "").replace(/[^0-9a-z]/gi, "").toLowerCase().slice(0, 40);
                if (!own) throw new Error("Moon Core: у кнопки нужен id (латиница и цифры)");
                const id = "x" + crypto.createHash("sha1").update(who + "|" + own).digest("hex").slice(0, 12);
                const onClick = spec && typeof spec.onClick === "function" ? spec.onClick : null;
                const src = Object.assign({}, spec, { id: id });
                if (onClick && src.command === undefined) src.command = null;
                const b = D.cleanButton(src, { ext: true });
                if (!b) throw new Error("Moon Core: недопустимая кнопка (zone, command или onClick, icon или label)");
                if (!b.command && !onClick) throw new Error("Moon Core: кнопке нужна command или onClick");
                host.uiButtons.set(b.id, { button: Object.assign(b, { owner: who }), onClick: onClick });
                host.scheduleRebuild();
                return { id: b.id, dispose: () => { host.uiButtons.delete(b.id); host.scheduleRebuild(); } };
            },
        };
    }
    uiList() { return this.uiButtons ? Array.from(this.uiButtons.values()).map((x) => x.button) : []; }

    /** Клик по кнопке расширения: его обработчик или его команда (нажал человек — без вопроса). */
    async onUiClick(body) {
        const rec = this.uiButtons && this.uiButtons.get(String(body && body.id || ""));
        // Кнопку зарегистрировал хост другого окна — пусть окно спросит следующий хост.
        if (!rec) return { ok: false, retry: true, error: "нет такой кнопки" };
        try {
            if (rec.onClick) await rec.onClick();
            else await vscode.commands.executeCommand(rec.button.command, ...(rec.button.args || []));
            return { ok: true };
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    }
}

module.exports = { Part: UIPart, BUILTIN };
