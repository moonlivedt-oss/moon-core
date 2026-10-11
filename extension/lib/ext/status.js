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
        const safe = host.safeMode();
        const stale = host.windowsInfo().filter((w) => w.stale).length;
        // Своя иконка (полумесяц), не $(paintcan): ведёрко похоже на значок Custom CSS and JS.
        const text = (safe ? "$(shield)" : injected ? "$(color-mode)" : "$(warning)") + " Moon" + (safe ? ": безопасный режим" : "") + (b.streams ? "" : " $(debug-disconnect)");
        const ps = host.engine.summary();
        // Подсказка со ссылками: из неё можно сразу открыть нужное, не заходя в меню.
        const lines = [
            "**Moon Core**" + (safe ? " — безопасный режим" : ""), "",
            (injected ? "$(pass) Встроен в VS Code" : "$(warning) Не встроен — [встроить](command:moonCore.inject)") + " | окон на связи: " + b.streams,
            "Вид: " + (ps.active ? "профиль «" + ps.active.replace(/[\[\]()*_`\\]/g, "") + "»" + (ps.dirty ? " (изменён)" : "") : "правок " + host.engine.editCount()) +
                " | сниппетов " + host.state.snippets.length + " из " + host.list.length,
        ];
        if (safe) lines.push("$(shield) Сниппеты, правки и модули отключены — [выйти из безопасного режима](command:moonCore.safeMode)");
        if (pending) lines.push("$(warning) JS-сниппетов ждут одобрения: " + pending);
        if (stale) lines.push("$(warning) Окон со старым рантаймом: " + stale + " — [перезагрузить это окно](command:workbench.action.reloadWindow)");
        lines.push("", "[Конструктор](command:moonCore.design) | [Профили](command:moonCore.profile) | [Галерея](command:moonCore.gallery) | [Доктор](command:moonCore.doctor) | [Скорость](command:moonCore.speed)", "", "Клик — всё меню");
        const tooltip = lines.join("\n\n").replace(/\n\n\n\n/g, "\n\n");
        const key = text + "|" + tooltip + "|" + !!injected;
        if (key === last) return;                    // не дёргать статусбар без изменений
        last = key;
        item.text = text;
        const md = new vscode.MarkdownString(tooltip, true);
        // Ссылки-команды — только эти: подсказка не должна уметь больше, чем меню.
        md.isTrusted = { enabledCommands: ["moonCore.inject", "moonCore.safeMode", "moonCore.design", "moonCore.profile", "moonCore.gallery", "moonCore.doctor", "moonCore.speed", "workbench.action.reloadWindow"] };
        item.tooltip = md;
        item.backgroundColor = injected && !safe ? undefined : new vscode.ThemeColor("statusBarItem.warningBackground");
    };
    update();
    // Опрос — только у окна в фокусе: статусбар фоновых окон никто не видит, а у каждого окна
    // свой хост и свой таймер. Окно получило фокус — сразу свежее состояние.
    const focused = () => !vscode.window.state || vscode.window.state.focused !== false;
    const t = setInterval(() => { if (focused()) update(); }, 5000);
    context.subscriptions.push(item, { dispose: () => clearInterval(t) }, host.onChange(update),
        vscode.window.onDidChangeWindowState((s) => { if (s && s.focused) update(); }));
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
        { label: "$(sparkle) Галерея стилей", description: "готовые улучшения вида — включаются галочками", cmd: "moonCore.gallery" },
        { label: "$(discard) Отменить последнюю правку", description: "шаг назад в конструкторе", cmd: "moonCore.undo" },
        { label: "$(redo) Вернуть отменённую правку", cmd: "moonCore.redo" },
        { label: "$(discard) Вернуть исходный вид", description: "снять все изменения конструктора", cmd: "moonCore.designReset" },
        { label: "$(history) Восстановить сниппеты из копии", description: "версии, перезаписанные при загрузке вида", cmd: "moonCore.restoreSnippets" },
        { label: "$(history) Восстановить вид из резервной копии", description: "копии делаются сами перед профилем, сбросом и загрузкой", cmd: "moonCore.restoreBackup" },
        { label: "$(arrow-right) Следующий профиль", description: "переключить вид по кругу", cmd: "moonCore.profileNext" },
        { label: "$(copy) Скопировать вид в буфер", description: "правки и профили текстом — переслать или вставить на другом компьютере", cmd: "moonCore.copyLook" },
        { label: "$(clippy) Вставить вид из буфера", cmd: "moonCore.pasteLook" },
        { label: "$(export) Сохранить вид в файл", description: "чтобы перенести на другой компьютер", cmd: "moonCore.exportAll" },
        { label: "$(desktop-download) Загрузить вид из файла", cmd: "moonCore.importAll" },
        { label: "$(sync) Загрузить вид из синхронизации", description: "если включена moonCore.sync", cmd: "moonCore.syncPull" },
        { label: "$(root-folder) Сохранить вид в проект", description: "вид будет включаться в этой папке", cmd: "moonCore.saveProjectProfile" },
        sep("Если что-то не работает"),
        { label: "$(heart) Доктор", description: "что не так и кнопки починки — начни с него", cmd: "moonCore.doctor" },
        { label: "$(dashboard) Скорость VS Code", description: "что тормозит запуск: расширения, тяжёлые папки, настройки", cmd: "moonCore.speed" },
        { label: "$(shield) Безопасный режим", description: "временно отключить сниппеты, правки и модули — ничего не удаляя", cmd: "moonCore.safeMode" },
        { label: "$(checklist) Проверить элементы", description: "какие правки перестали работать после обновления VS Code", cmd: "moonCore.checkSelectors" },
        { label: "$(plug) Внедрить в VS Code", description: "нужно после установки и после обновления VS Code", cmd: "moonCore.inject" },
        { label: "$(window) Вид окна", description: "прозрачность, акрил, поверх всех окон", cmd: "moonCore.windowLook" },
        { label: "$(browser) Стили внутри webview", description: "свой CSS для страниц расширений и превью Markdown", cmd: "moonCore.webviewStyles" },
        { label: "$(rocket) Глубокая интеграция", description: "сервисы окна и главный процесс VS Code", cmd: "moonCore.deep" },
        { label: "$(trash) Убрать из VS Code", description: "вернуть VS Code как было до Moon Core", cmd: "moonCore.remove" },
        sep("Для разработчиков"),
        { label: "$(new-file) Новый CSS-сниппет", description: "свои стили в файле", cmd: "moonCore.newCss" },
        { label: "$(symbol-event) Новый JS-сниппет", description: "свой скрипт в окне VS Code", cmd: "moonCore.newJs" },
        { label: "$(folder-opened) Папка сниппетов", cmd: "moonCore.openFolder" },
        { label: "$(cloud-download) Перенести из Custom CSS and JS Loader", description: "файлы старого загрузчика — в сниппеты", cmd: "moonCore.importCustomCss" },
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
