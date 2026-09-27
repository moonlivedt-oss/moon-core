// ============================================================
//  Статусбар «Moon», меню по клику и диагностика в журнал (её же копирует Доктор).
// ============================================================
"use strict";

const vscode = require("vscode");
const inject = require("../inject");
const MH = require("../module-host");
const { log, showLog } = require("../log");

/** Статусбар: состояние внедрения и связи + меню команд по клику. */
function createStatus(context, host) {
    const item = vscode.window.createStatusBarItem("moonCore.status", vscode.StatusBarAlignment.Right, 90);
    item.name = "Moon Core";
    item.command = "moonCore.menu";
    let last = "";
    const update = () => {
        const st = inject.status(context);          // кэшируется по времени изменения файлов
        const injected = st.length && st.every((s) => s.injected);
        const b = host.bridge.status();
        const pending = (host.jsPending || []).length;
        // Своя иконка (полумесяц), не $(paintcan): ведёрко похоже на значок Custom CSS and JS.
        const text = (injected ? "$(color-mode)" : "$(warning)") + " Moon" + (b.streams ? "" : " $(debug-disconnect)");
        const tooltip = "Moon Core\n" +
            "Оболочка: " + (injected ? "внедрено" : "не внедрено") + "\n" +
            "Окон на связи: " + b.streams + "\n" +
            "Сниппетов включено: " + host.state.snippets.length + " из " + host.list.length + "\n" +
            (pending ? "JS-сниппетов ждут одобрения: " + pending + "\n" : "") +
            "\nКлик — меню: конструктор, профили, починка";
        const key = text + "|" + tooltip + "|" + !!injected;
        if (key === last) return;                    // не дёргать статусбар без изменений
        last = key;
        item.text = text;
        item.tooltip = tooltip;
        item.backgroundColor = injected ? undefined : new vscode.ThemeColor("statusBarItem.warningBackground");
    };
    update();
    const t = setInterval(update, 5000);
    context.subscriptions.push(item, { dispose: () => clearInterval(t) }, host.onChange(update));
    item.show();
}

/**
 * Меню по клику на «Moon» в статусбаре. Три раздела: чтобы просто настроить вид хватает первого,
 * второй — когда что-то не работает, третий — для тех, кто пишет свои стили, скрипты и модули.
 */
async function menu() {
    const sep = (label) => ({ label: label, kind: vscode.QuickPickItemKind.Separator });
    const items = [
        sep("Настроить вид"),
        { label: "$(layout) Конструктор", description: "кликни по элементу окна — убрать, увеличить, перекрасить", cmd: "moonCore.design" },
        { label: "$(symbol-color) Профили вида", description: "готовые наборы: Минимал, Только код, Крупный и свои", cmd: "moonCore.profile" },
        { label: "$(inspect) Пипетка", description: "навести на элемент и скрыть его одним кликом", cmd: "moonCore.pick" },
        { label: "$(discard) Вернуть исходный вид", description: "снять все изменения конструктора", cmd: "moonCore.designReset" },
        { label: "$(export) Сохранить вид в файл", description: "чтобы перенести на другой компьютер", cmd: "moonCore.exportAll" },
        { label: "$(desktop-download) Загрузить вид из файла", cmd: "moonCore.importAll" },
        { label: "$(sync) Загрузить вид из синхронизации", description: "если включена moonCore.sync", cmd: "moonCore.syncPull" },
        { label: "$(root-folder) Сохранить вид в проект", description: "вид будет включаться в этой папке", cmd: "moonCore.saveProjectProfile" },
        sep("Если что-то не работает"),
        { label: "$(heart) Доктор", description: "что не так и кнопки починки — начни с него", cmd: "moonCore.doctor" },
        { label: "$(checklist) Проверить элементы", description: "какие правки перестали работать после обновления VS Code", cmd: "moonCore.checkSelectors" },
        { label: "$(plug) Внедрить в VS Code", description: "нужно после установки и после обновления VS Code", cmd: "moonCore.inject" },
        { label: "$(window) Вид окна", description: "прозрачность, акрил, поверх всех окон", cmd: "moonCore.windowLook" },
        { label: "$(rocket) Глубокая интеграция", description: "сервисы окна и главный процесс VS Code", cmd: "moonCore.deep" },
        { label: "$(trash) Убрать из VS Code", description: "вернуть VS Code как было до Moon Core", cmd: "moonCore.remove" },
        sep("Для разработчиков"),
        { label: "$(new-file) Новый CSS-сниппет", description: "свои стили в файле", cmd: "moonCore.newCss" },
        { label: "$(symbol-event) Новый JS-сниппет", description: "свой скрипт в окне VS Code", cmd: "moonCore.newJs" },
        { label: "$(folder-opened) Папка сниппетов", cmd: "moonCore.openFolder" },
        { label: "$(refresh) Перезапустить сниппеты", cmd: "moonCore.reloadSnippets" },
        { label: "$(extensions) Модули", description: "какие модули встраивать вместе с Moon Core", cmd: "moonCore.modules" },
        { label: "$(new-folder) Создать модуль", description: "папка с заготовкой и типами", cmd: "moonCore.newModule" },
        { label: "$(debug-restart) Режим разработки модуля", description: "правка кода модуля сразу перезапускает его", cmd: "moonCore.moduleDev" },
        { label: "$(pulse) Диагностика в журнал", cmd: "moonCore.status" },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: "Moon Core: что сделать?", matchOnDescription: true });
    if (pick) await vscode.commands.executeCommand(pick.cmd);
}

/** Строки диагностики: оболочки, запуск окна, мост, конструктор, модули, сниппеты. */
function diagnosticLines(context, host) {
    const st = inject.status(context);
    const b = host.bridge.status();
    const lines = [
        "=== Moon Core: диагностика ===",
        "VS Code " + vscode.version + " (" + process.platform + "), расширение " + (context.extension.packageJSON.version || "?"),
        "Оболочек найдено: " + st.length,
    ];
    st.forEach((s) => lines.push("  " + s.file + "\n    внедрено: " + (s.injected ? "да" : "нет") +
        (s.injected ? ", рантайм " + (s.current ? "актуален" : "устарел") + ", версия блока " + (s.version || "?") : "") +
        (s.checksum === true ? ", хэш в product.json сходится" : s.checksum === false ? ", хэш в product.json НЕ сходится (баннер «повреждено»)" : "") +
        (s.legacy ? ", есть пустые метки Custom CSS" : "") +
        (s.error ? ", ошибка: " + s.error : "")));
    const tm = host.lastTiming;
    if (tm) {
        lines.push("Запуск окна (" + new Date(tm.at).toLocaleTimeString() + "): рантайм " + (tm.runtime != null ? tm.runtime + " мс" : "?") +
            Object.keys(tm.modules).map((k) => ", " + k + " " + tm.modules[k] + " мс").join("") +
            (tm.skipped.length ? "; пропущено защитой запуска: " + tm.skipped.join(", ") : "") +
            (tm.failed && tm.failed.length ? "; не выполнились: " + tm.failed.join(", ") : ""));
    } else lines.push("Запуск окна: данных ещё нет (появятся через несколько секунд после загрузки окна)");
    let uiLine = "";
    try {
        uiLine = inject.lazyUi(context) ? "грузится при первом открытии конструктора (" + inject.uiChunk(context).name + " в хранилище)"
            : "встроен в оболочку целиком" + (vscode.workspace.getConfiguration("moonCore").get("lazyUi", true) ? " (этот VS Code не дал загрузить его отдельно)" : " (moonCore.lazyUi выключена)");
    } catch (e) { uiLine = "не определить: " + e.message; }
    lines.push("Интерфейс окна (конструктор, пипетка): " + uiLine);
    lines.push("Аварийное восстановление (если VS Code не открывается): " + inject.recoveryPath(context));
    lines.push("Мост: " + (b.running ? "127.0.0.1:" + b.port : "не поднят") + ", окон на связи: " + b.streams +
        ", запросов: " + b.requests + (b.rejected ? ", отклонено по лимиту: " + b.rejected : "") +
        (b.lastSeen ? ", последний " + new Date(b.lastSeen).toLocaleTimeString() : ""));
    const ps = host.engine.summary();
    lines.push("Конструктор: правил " + Object.keys(host.design.rules).length + ", настроек " + Object.keys(host.design.settings).length +
        ", профилей своих " + ps.list.filter((p) => !p.builtin).length + (ps.active ? ", активный «" + ps.active + "»" + (ps.dirty ? " (изменён)" : "") : ""));
    const found = MH.discover(), on = MH.allowed(context, found);
    lines.push("Модулей найдено: " + found.length + ", разрешено: " + on.length +
        (st.length && st[0].modules && st[0].modules.length ? ", в оболочке: " + st[0].modules.join(", ") : ""));
    found.forEach((m) => lines.push("  " + m.id + (m.version ? " " + m.version : "") + " — " + MH.sourceTitle(m) +
        (on.indexOf(m) !== -1 ? "" : " (не разрешён)") + "\n    скрипт: " + m.script));
    lines.push("Сниппетов: " + host.list.length + ", включено: " + host.state.snippets.length + ", rev " + host.state.rev);
    lines.push("Папка: " + host.dir);
    return lines;
}

/** Команда «Диагностика в журнал». */
function diagnostics(context, host) {
    log("");
    diagnosticLines(context, host).forEach((l) => log(l));
    showLog();
}

module.exports = { createStatus, menu, diagnostics, diagnosticLines };
