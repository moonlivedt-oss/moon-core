// ============================================================
//  Дерево «Сниппеты» в боковой панели Moon Core: флажок — включить/выключить, клик — открыть.
// ============================================================
"use strict";

const vscode = require("vscode");

function fmtSize(n) { return n < 1024 ? n + " Б" : (n / 1024).toFixed(1) + " КБ"; }

class SnippetTree {
    constructor(host) {
        this.host = host;
        this._em = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._em.event;
        this._sub = host.onChange(() => this._em.fire());
    }
    getTreeItem(s) {
        const item = new vscode.TreeItem(s.id, vscode.TreeItemCollapsibleState.None);
        item.checkboxState = s.enabled ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
        const pending = (this.host.jsPending || []).some((p) => p.id === s.id);
        item.description = s.error ? s.error : (s.kind === "js" ? "JS" : "CSS") + " · " + fmtSize(s.size) + (pending ? " · ждёт одобрения" : "");
        item.tooltip = s.file;
        item.iconPath = new vscode.ThemeIcon(s.error || pending ? "warning" : s.kind === "js" ? "symbol-event" : "symbol-color");
        item.contextValue = "snippet";
        item.resourceUri = vscode.Uri.file(s.file);
        item.command = { command: "moonCore.openSnippet", title: "Открыть", arguments: [s] };
        return item;
    }
    getChildren() { return this.host.list; }
    dispose() { try { this._sub.dispose(); } catch (e) {} this._em.dispose(); }
}

/** Дерево в панели + переключение флажками. */
function createSnippetView(context, host) {
    const tree = new SnippetTree(host);
    const view = vscode.window.createTreeView("moonCore.snippets", { treeDataProvider: tree, showCollapseAll: false });
    view.onDidChangeCheckboxState((e) => {
        e.items.forEach(([s, state]) => host.setEnabled(s.id, state === vscode.TreeItemCheckboxState.Checked));
    });
    context.subscriptions.push(view, tree);
    return view;
}

module.exports = { SnippetTree, createSnippetView, fmtSize };
