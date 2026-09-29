// ============================================================
//  Moon Core — платформа кастомизации и внедрения в интерфейс VS Code.
//
//  Расширение (хост) + рантайм, впечатанный в оболочку VS Code (workbench.html):
//    - lib/inject/      — внедрение/снятие рантайма, автообновление после апдейтов VS Code;
//    - lib/bridge.js    — мост окно <-> хост (HTTP на 127.0.0.1 + SSE);
//    - lib/host.js      — сниппеты CSS/JS, живой предпросмотр, пипетка, конструктор, проверки;
//    - lib/modules.js   — модули: чужие рантаймы, которые Moon Core впечатывает своим блоком;
//    - lib/ext/         — статусбар и меню, дерево сниппетов, вид окна, слежение за модулями;
//    - runtime/         — то, что исполняется в окне VS Code.
//  Здесь — только активация и регистрация команд.
// ============================================================
"use strict";

const vscode = require("vscode");
const { Host } = require("./lib/host");
const inject = require("./lib/inject");
const MH = require("./lib/module-host");
const path = require("path");
const { openDoctor, exportDiagnostics } = require("./lib/doctor");
const { log, showLog, disposeLog, setLogFile } = require("./lib/log");
const { storageDir } = require("./lib/storage");
const { showPermissions, revokeAll } = require("./lib/ext/permissions");
const { createStatus, menu, diagnostics } = require("./lib/ext/status");
const { createSnippetView } = require("./lib/ext/snippet-tree");
const { writeMainConf, mainStatus, deepCommand, windowLookCommand } = require("./lib/ext/window-look");
const { watchModules } = require("./lib/ext/module-watch");

let host = null;

/** id сниппета из аргумента команды (элемент дерева или строка). Непроверенный id — "". */
function idOf(arg) { return host.snippetId(arg && typeof arg === "object" ? arg.id : arg); }

// Настройки, меняющие то, КАК записана оболочка: после их смены блок переписывается сразу.
const REWRITE_KEYS = ["moonCore.moduleFiles", "moonCore.injectSessions", "moonCore.fixChecksum", "moonCore.moduleIntegrity", "moonCore.deepHooks", "moonCore.mainProcess", "moonCore.lazyUi"];

/** API для других расширений: vscode.extensions.getExtension("moonlivedt.moon-core").activate(). Типы — types/mooncore.d.ts. */
function makeApi(context) {
    const api = {
        apiVersion: 1,
        /** Помощник модуля в хосте: publish(event, data, {scope}), onRequest(fn), active. */
        module: (id) => host.modules.api(id),
        /** Интерфейс от имени расширения: ui("Моё расширение").button({ zone, icon, label, command | onClick }). */
        ui: (owner) => host.uiApi(owner || "расширение"),
    };
    // Прогон в настоящем VS Code (test/e2e): тестам нужен доступ к внутренностям без диалогов.
    if (context.extensionMode === vscode.ExtensionMode.Test) api._test = { host: host, context: context, inject: inject, moduleHost: MH };
    return api;
}

function registerCommands(context, refreshModules) {
    const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
    reg("moonCore.menu", menu);
    reg("moonCore.inject", () => inject.injectCommand(context));
    reg("moonCore.remove", () => inject.removeCommand(context));
    reg("moonCore.status", () => diagnostics(context, host));
    reg("moonCore.showLog", () => showLog());
    reg("moonCore.pick", () => host.pick());
    reg("moonCore.design", () => host.toggleDesign());
    reg("moonCore.designReset", () => host.resetDesign());
    reg("moonCore.profile", () => host.pickProfile());
    reg("moonCore.modules", async () => { if (await MH.pickCommand(context)) await refreshModules(false); });
    reg("moonCore.moduleDev", async () => {
        const on = await MH.pickDev(context);
        if (on === null) return;
        await refreshModules(false);
        vscode.window.setStatusBarMessage("Moon Core: режим разработки — " + (on.map((m) => m.name).join(", ") || "выключен"), 5000);
    });
    reg("moonCore.newModule", async () => {
        const made = await MH.createModule(context);
        if (!made) return;
        const pick = await vscode.window.showInformationMessage("Moon Core: модуль «" + made.id + "» создан и добавлен в moonCore.modules. Разрешить его и встроить можно командой «Модули»; для работы над кодом — «Режим разработки модуля».", "Модули");
        if (pick) await vscode.commands.executeCommand("moonCore.modules");
    });
    reg("moonCore.saveProjectProfile", () => host.saveProjectProfile());
    // Служебная (не в палитре): клик по элементу статусбара, который модуль создал через шлюз.
    context.subscriptions.push(vscode.commands.registerCommand("moonCore._nativeClick", (mod, item) => host.nativeClick(String(mod), String(item))));
    reg("moonCore.doctor", () => openDoctor(context, host));
    reg("moonCore.moduleCommands", () => host.pickModuleCommand(false));
    reg("moonCore.moduleCommandsHere", () => host.pickModuleCommand(true));
    reg("moonCore.exportDiagnostics", () => exportDiagnostics(context, host));
    reg("moonCore.permissions", () => showPermissions(context, host));
    reg("moonCore.revokeAll", () => revokeAll(context, host));
    reg("moonCore.deep", () => deepCommand());
    reg("moonCore.windowLook", () => windowLookCommand());
    reg("moonCore.exportAll", () => host.exportCommand());
    reg("moonCore.importAll", () => host.importCommand());
    reg("moonCore.syncPull", () => host.syncIn(false));
    reg("moonCore.checkSelectors", () => host.checkSelectors());
    reg("moonCore.reloadSnippets", () => host.reloadAll());
    reg("moonCore.newCss", () => host.create("css"));
    reg("moonCore.newJs", () => host.create("js"));
    reg("moonCore.openSnippet", (s) => { const id = idOf(s); if (id) return host.open(id); return undefined; });
    reg("moonCore.deleteSnippet", (s) => { const id = idOf(s); if (id) return host.remove(id); return undefined; });
    reg("moonCore.toggleSnippet", (s) => { const id = idOf(s); if (id) host.setEnabled(id, !host.isEnabled(id)); });
    reg("moonCore.openFolder", () => vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(host.dir)));
}

function activate(context) {
    try {
        // Журнал и в файл: Output пропадает с окном, а файл нужен, когда VS Code не открылся.
        setLogFile(path.join(storageDir(context), "mooncore.log"));
        host = new Host(context);
        createSnippetView(context, host);
        const refreshModules = watchModules(context, host);
        registerCommands(context, refreshModules);

        writeMainConf(context);
        host.mainStatus = () => mainStatus(context);
        host.onModulesFailed = (ids) => inject.onModulesFailed(context, ids);
        host.onUiFailed = (body) => inject.onUiFailed(context, body);
        host.devModuleCode = (id) => MH.devCode(context, id);
        host.moduleCodeFor = (id) => { const s = inject.moduleSet(context).scripts.find((x) => x.id === id); return s ? s.code : null; };
        createStatus(context, host);
        host.modules.setModules(MH.allowed(context));
        // Свои модули (фон, окно документации) разрешаются до внедрения: тогда первое же
        // внедрение приносит их в оболочку, и перезагрузка нужна одна.
        MH.autoAllowOwn(context)
            .catch((e) => log("свои модули", e))
            .then(() => { host.modules.setModules(MH.allowed(context)); return inject.checkOnActivate(context); })
            .then(() => refreshModules(true))
            .catch((e) => log("проверка внедрения", e));
        host.autoCheckAfterUpdate().catch((e) => log("проверка после обновления VS Code", e));
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("moonCore.window")) writeMainConf(context);
            if (!REWRITE_KEYS.some((k) => e.affectsConfiguration(k))) return;
            if (!inject.status(context).some((s) => s.injected) && !e.affectsConfiguration("moonCore.injectSessions")) return;
            inject.injectCommand(context).catch((er) => log("перевнедрение после смены настройки", er));
        }));
        if (host.syncEnabled()) host.syncIn(true).catch((e) => log("синхронизация", e));
        host.watchContext();
        host.watchVs();
        log("Moon Core активирован");
        return makeApi(context);
    } catch (e) {
        log("активация", e);
        vscode.window.showErrorMessage("Moon Core не запустился: " + (e && e.message || e), "Журнал").then((p) => { if (p) showLog(); });
        return undefined;
    }
}

function deactivate() {
    // Хост и всё остальное уходят через context.subscriptions (мост отписывается из файла адресов).
    host = null;
    disposeLog();
}

module.exports = { activate, deactivate };
