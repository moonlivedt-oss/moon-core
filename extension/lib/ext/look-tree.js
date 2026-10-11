// ============================================================
//  Дерево «Вид» в боковой панели Moon Core: состояние, профили вида (клик — применить) и
//  быстрые действия. Всё, что нужно, чтобы поменять вид, не открывая палитру команд.
// ============================================================
"use strict";

const vscode = require("vscode");
const inject = require("../inject");

const ACTIONS = [
    ["Конструктор", "кликни по элементу окна — убрать, увеличить, перекрасить", "layout", "moonCore.design"],
    ["Галерея стилей", "готовые улучшения вида галочками", "sparkle", "moonCore.gallery"],
    ["Отменить правку", "", "discard", "moonCore.undo"],
    ["Вернуть правку", "", "redo", "moonCore.redo"],
    ["Резервные копии вида", "вернуть вид, каким он был раньше", "history", "moonCore.restoreBackup"],
    ["Доктор", "что не так и как починить", "heart", "moonCore.doctor"],
    ["Скорость VS Code", "что тормозит запуск: расширения, папки, настройки", "dashboard", "moonCore.speed"],
];

class LookTree {
    constructor(context, host) {
        this.context = context;
        this.host = host;
        this._em = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._em.event;
        this._sub = host.onChange(() => this._em.fire());
    }

    getTreeItem(n) {
        const item = new vscode.TreeItem(n.label, n.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        if (n.description) item.description = n.description;
        if (n.tooltip) item.tooltip = n.tooltip;
        if (n.icon) item.iconPath = new vscode.ThemeIcon(n.icon, n.color ? new vscode.ThemeColor(n.color) : undefined);
        if (n.command) item.command = { command: n.command, title: n.label, arguments: n.args || [] };
        if (n.context) item.contextValue = n.context;
        return item;
    }

    getChildren(n) {
        if (n) return n.children || [];
        return [this.stateNode(), this.profilesNode(), { label: "Действия", children: ACTIONS.map((a) => ({ label: a[0], description: a[1], icon: a[2], command: a[3] })) }];
    }

    stateNode() {
        const h = this.host;
        let st = [];
        try { st = inject.status(this.context); } catch (e) {}
        const injected = st.length > 0 && st.every((s) => s.injected), current = injected && st.every((s) => s.current);
        const streams = h.bridge.status().streams;
        const safe = h.safeMode();
        const edits = h.engine.editCount();
        const items = [
            injected ? { label: current ? "Встроен в VS Code" : "Встроен, рантайм устарел", icon: current ? "pass" : "warning", color: current ? "testing.iconPassed" : "editorWarning.foreground", command: current ? undefined : "moonCore.inject", description: current ? "" : "нажми, чтобы обновить" }
                : { label: "Не встроен в VS Code", description: "нажми, чтобы встроить", icon: "warning", color: "editorWarning.foreground", command: "moonCore.inject" },
            { label: streams ? "Окон на связи: " + streams : "Окно не на связи", icon: streams ? "plug" : "debug-disconnect", description: streams ? "" : "перезагрузи окно", command: streams ? undefined : "workbench.action.reloadWindow" },
            { label: "Правок конструктора: " + edits, icon: "edit", description: "сниппетов включено " + h.state.snippets.length + " из " + h.list.length },
        ];
        if (safe) items.unshift({ label: "Безопасный режим включён", description: "нажми, чтобы выйти", icon: "shield", color: "editorWarning.foreground", command: "moonCore.safeMode", tooltip: "Сниппеты, правки конструктора и модули отключены во всех окнах" });
        return { label: "Состояние", children: items };
    }

    profilesNode() {
        const sum = this.host.engine.summary();
        const none = !sum.active && !this.host.engine.editCount();
        const items = [{ label: "Исходный вид VS Code", description: none ? "сейчас" : "сбросить всё", icon: none ? "check" : "discard", command: "moonCore.applyProfile", args: [""], tooltip: "Без правок Moon Core: всё как до установки" }]
            .concat(sum.list.map((p) => {
                const on = p.name === sum.active;
                return {
                    label: p.name, icon: on ? "check" : p.builtin ? "symbol-color" : "account", context: "profile",
                    description: (on ? (sum.dirty ? "сейчас, изменён" : "сейчас") : p.builtin ? "встроенный" : "свой"),
                    tooltip: p.note || ("элементов: " + p.rules + ", настроек: " + p.settings + (p.colors ? ", цветов: " + p.colors : "")),
                    command: "moonCore.applyProfile", args: [p.name],
                };
            }));
        return { label: "Профили вида", description: "клик — применить", children: items };
    }

    dispose() { try { this._sub.dispose(); } catch (e) {} this._em.dispose(); }
}

function createLookView(context, host) {
    const tree = new LookTree(context, host);
    const view = vscode.window.createTreeView("moonCore.look", { treeDataProvider: tree, showCollapseAll: false });
    context.subscriptions.push(view, tree);
    return view;
}

module.exports = { LookTree, createLookView };
