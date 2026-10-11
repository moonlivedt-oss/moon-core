// ============================================================
//  «Доктор» Moon Core — модель без vscode: по снимку состояния решает, что не так и какой
//  кнопкой это чинится. Страницу рисует lib/doctor.js, тесты гоняют эту часть.
//
//  Снимок (собирает doctor.js):
//    { vscode, ext, shells: inject.status(), bridge: bridge.status(), timing, modules: {found, allowed,
//      dev, pending, dups}, design: {rules, settings, active, dirty}, snippets: {total, on, errors, jsPending},
//      check: summarize()|null, recovery, speed: {regression, slowExt, freezes}|null }
//  Проблема: { level: "error"|"warn"|"info", title, detail, fix?: команда страницы, fixLabel? }
// ============================================================
"use strict";

const ACTIONS = ["inject", "remove", "reload", "check", "heal", "log", "modules", "moduleDev", "recovery", "design", "refresh", "jsReview", "report", "permissions", "export",
    "safe", "fixAll", "backups", "gallery", "legacy", "modulesSetting", "speed"];
// Починки, которые «Починить всё» выполняет сама, по порядку. Перезагрузка окна — последней и с вопросом.
const AUTO_FIXES = ["inject", "heal", "jsReview"];
const SLOW_MODULE_MS = 1500, SLOW_RUNTIME_MS = 400;

const base = (f) => String(f || "").split(/[\\/]/).slice(-3).join("/");

function problems(s) {
    const out = [];
    const add = (level, title, detail, fix, fixLabel) => out.push({ level: level, title: title, detail: detail || "", fix: fix || "", fixLabel: fixLabel || "" });
    const shells = Array.isArray(s.shells) ? s.shells : [];
    if (s.safe) add("warn", "Включён безопасный режим", "Сниппеты, правки конструктора, эффекты и модули отключены во всех окнах. Ничего не удалено.", "safe", "Выйти из режима");
    if (!shells.length) add("error", "Оболочка VS Code не найдена", "Не нашёлся workbench.html в папке VS Code — внедрение невозможно.");
    const injected = shells.filter((x) => x.injected);
    if (shells.length && !injected.length) add("warn", "Moon Core не внедрён", "Конструктор, сниппеты и модули не работают, пока рантайм не встроен в оболочку.", "inject", "Внедрить");
    shells.forEach((x) => {
        if (x.error) add("error", "Оболочка недоступна: " + base(x.file), x.error);
        if (!x.injected) return;
        if (!x.current) add("warn", "Рантайм в оболочке устарел", base(x.file) + ": версия блока " + (x.version || "?") + ". Новая версия Moon Core или модулей ещё не встроена.", "inject", "Обновить");
        if (x.checksum === false) add("warn", "VS Code пишет «установка повреждена»", "Хэш оболочки в product.json не сходится" + (x.trusted === false ? ": в оболочке чужие вставки без одобрения (" + (x.foreign || []).join(", ") + ")" : "") + ".", "inject", "Внедрить заново");
        if (x.blockOk === false) add("warn", "Блок Moon Core изменён снаружи", "Кто-то правил блок в " + base(x.file) + ". Внедрение перепишет его.", "inject", "Переписать");
        if (x.legacy) add("info", "Следы старого загрузчика", "В оболочке остались пустые метки или скрипт-значок (ведёрко в статусбаре) выключенного Custom CSS and JS Loader. Безвредны, но их можно убрать.", "legacy", "Убрать следы");
        const d = x.deep;
        if (d && d.want) {
            if (d.want.di && !d.diSupported) add("warn", "Сервисы окна недоступны в этой версии VS Code", "Место для крючка в бандле не найдено: VS Code переписал этот код. Остальное Moon Core работает.");
            else if (d.want.webview && d.webviewSupported === false) add("info", "Стили webview не применены", "Файл-основа webview изменён другой программой или устроен иначе в этой версии VS Code — Moon Core его не трогает.");
            else if (x.injected && !d.ok) add("warn", "Глубокая интеграция не совпадает с настройками", "Включил или выключил её, или VS Code обновился и стёр патчи. Внедрение приведёт всё в порядок.", "inject", "Внедрить");
        }
    });
    // Файлы установки VS Code (lib/vs-files.js): что изменено не Moon Core, следы других загрузчиков.
    const f = s.files;
    if (f) {
        if (f.missing && f.missing.length) add("error", "Не хватает файлов VS Code: " + f.missing.length, f.missing.join(", ") + ". Переустанови VS Code поверх — настройки и расширения сохранятся.");
        if (f.shellNoCsp) add("warn", "В оболочке VS Code нет политики безопасности CSP", "Её удалил другой загрузчик (так делает Custom CSS and JS Loader), и без заводского файла её не вернуть. Вернётся сама со следующим обновлением VS Code или при переустановке поверх — Moon Core после этого встроится заново сам. Не включай после этого старый загрузчик: он удалит её снова.");
        else if (f.foreign && f.foreign.length) add("info", "Файлы VS Code изменены не только Moon Core: " + f.foreign.length, f.foreign.join(", ") + ". Если это твои загрузчики — всё в порядке; если нет — переустанови VS Code поверх.");
        if (f.webviewCspOff) add("warn", "В основе webview отключена защита CSP", "Другая программа (обычно Custom UI Style) стёрла в файле-основе webview имя политики безопасности: страницы расширений работают, но основа осталась без защиты от постороннего скрипта. Вернуть: выключить правки той программы её же командой или переустановить VS Code поверх.");
        else if (f.webview === "foreign") add("info", "Основа webview изменена другой программой", "Хэш её скрипта не сходится с тем, что записан в самом файле. Если страницы расширений или превью Markdown открываются пустыми — причина в этом; чинится переустановкой VS Code поверх или средствами той программы.");
        const left = f.leftovers || [];
        if (left.length) {
            const mb = Math.round(left.reduce((n, x) => n + (x.size || 0), 0) / 1024 / 102.4) / 10;
            const owners = Array.from(new Set(left.map((x) => x.owner || "неизвестно")));
            add("info", "В папке VS Code лежат файлы других загрузчиков: " + left.length + " (" + mb + " МБ)", owners.join(", ") + ". VS Code они не мешают; убирать их стоит средствами тех расширений.");
        }
        if (f.backupPristine === false) add("info", "Бэкап оболочки снят с уже изменённого файла", "Когда Moon Core встраивался впервые, в оболочке уже были чужие правки. «Убрать из VS Code» вернёт оболочку к тому состоянию, а не к заводскому.");
    }
    const b = s.bridge || {};
    if (!b.running) add("error", "Мост не поднят", "Окно не может связаться с расширением. Подробности — в журнале.", "log", "Журнал");
    else if (injected.length && !b.streams) add("warn", "Окно не на связи", "Рантайм встроен, но ни одно окно не подключилось. Перезагрузи окно после внедрения.", "reload", "Перезагрузить окно");
    const t = s.timing;
    if (t && t.failed && t.failed.length) add("error", "Модуль не выполнился: " + t.failed.join(", "), "Файл модуля не прошёл проверку целостности, пропал или был изменён. Moon Core переписал файлы — нужна перезагрузка окна.", "reload", "Перезагрузить окно");
    if (t && t.skipped && t.skipped.length) add("warn", "Пропущено защитой запуска: " + t.skipped.join(", "), "В прошлый раз окно не запустилось на этом модуле. Перезагрузи окно, чтобы попробовать снова.", "reload", "Перезагрузить окно");
    // Медленный запуск: окно VS Code ждёт каждый модуль, прежде чем дорисоваться.
    const slow = t && t.modules ? Object.keys(t.modules).filter((k) => t.modules[k] >= SLOW_MODULE_MS) : [];
    if (slow.length) add("warn", "Модуль замедляет запуск окна: " + slow.map((k) => k + " (" + Math.round(t.modules[k]) + " мс)").join(", "), "Модуль выполняется при каждом открытии окна. Его можно выключить или сделать ленивым («lazy» в манифесте).", "modules", "Модули");
    if (t && typeof t.runtime === "number" && t.runtime >= SLOW_RUNTIME_MS) add("info", "Рантайм Moon Core запускался " + Math.round(t.runtime) + " мс", "Обычно это десятки миллисекунд. Много JS-сниппетов или тяжёлый сниппет — посмотри вкладку Performance в DevTools (метки mooncore:*).");
    const stale = (Array.isArray(s.windows) ? s.windows : []).filter((w) => w && w.stale).length;
    if (stale) add("warn", "Окон со старым рантаймом: " + stale, "Расширение обновилось, а эти окна ещё работают на прежней версии рантайма. Перезагрузи каждое такое окно.", "reload", "Перезагрузить это окно");
    const noisy = (Array.isArray(s.errors) ? s.errors : []).filter((e) => e && e.n >= 20);
    if (noisy.length) add("warn", "Часто падает: " + noisy.map((e) => e.source + " (" + e.n + ")").join(", "), "Ошибки этого источника идут одна за другой — подробности в журнале.", "log", "Журнал");
    if (b.dropped) add("info", "Отключено зависших окон: " + b.dropped, "Окно не читало события моста (стояло в отладчике или зависло) — хост отключил его, чтобы не копить память. Окно переподключится само.");
    const m = s.modules || {};
    // Один id в папке из moonCore.modules и в установленном расширении: работает копия из папки
    // (так задумано для разработки), но если папка осталась от прошлого, модуль не обновится
    // вместе с расширением — об этом стоит знать.
    (Array.isArray(m.dups) ? m.dups : []).slice(0, 4).forEach((d) => add("info", "Модуль «" + d.id + "» найден дважды",
        "Работает версия из источника «" + d.used + "», а «" + d.skipped + "» пропускается. Если папка в moonCore.modules больше не нужна для разработки, убери её — тогда модуль будет обновляться вместе с расширением.",
        "modulesSetting", "Открыть настройку"));
    if (m.pending && m.pending.length) add("warn", "Код модулей изменился и ждёт одобрения: " + m.pending.join(", "), "В оболочке пока прежняя одобренная версия.", "modules", "Модули");
    const sn = s.snippets || {};
    if (sn.jsPending && sn.jsPending.length) add("warn", "JS-сниппеты ждут одобрения: " + sn.jsPending.join(", "), "Их изменили не из VS Code — они не запускаются, пока не одобришь.", "jsReview", "Проверить");
    if (sn.errors && sn.errors.length) add("warn", "Сниппеты с ошибками: " + sn.errors.map((e) => e.id).join(", "), sn.errors.map((e) => e.id + ": " + e.error).join("; "));
    const c = s.check;
    if (c) {
        if (c.heals && c.heals.length) add("warn", "Сломанные правки можно починить: " + c.heals.length, "Moon Core нашёл по отпечаткам, куда переехали элементы: " + c.heals.slice(0, 5).map((h) => h.label || h.from).join(", ") + (c.heals.length > 5 ? " и др." : "") + ".", "heal", "Починить");
        const unhealed = (c.deadUser || []).length - (c.heals ? c.heals.length : 0);
        if (unhealed > 0) add("info", "Правил без совпадений: " + unhealed, "Элемент может быть просто не показан сейчас (закрыта панель). Список — в журнале после проверки.", "log", "Журнал");
    }
    // Скорость VS Code (lib/ext/speed.js): замедление запуска, дорогие расширения, подвисания окон.
    const sp = s.speed;
    if (sp) {
        const sec = (ms) => (Math.round(ms / 100) / 10).toString().replace(".", ",") + " с";
        if (sp.regression) add("warn", "VS Code запускался медленнее обычного: " + sec(sp.regression.last) + " вместо " + sec(sp.regression.median),
            "Часто после обновления VS Code или расширения. «Скорость VS Code» покажет, какой этап и какое расширение подорожали.", "speed", "Что тормозит");
        if (sp.slowExt && sp.slowExt.length) add("info", "Дорогие на старте расширения: " + sp.slowExt.map((e) => e.id + " (" + sec(e.avg) + ")").join(", "),
            "Среднее время активации по нескольким запускам. Их можно выключить для папок, где они не нужны, или вынести в отдельный процесс.", "speed", "Скорость VS Code");
        if (sp.freezes) add("info", "Окна подвисали: " + sp.freezes, "Главный поток окна вставал больше чем на секунду или много раз дольше 200 мс. Чаще всего виновато расширение — «Скорость VS Code» и «Запущенные расширения» помогут найти какое.", "speed", "Скорость VS Code");
    }
    const d = s.design || {};
    if (d.active && d.dirty) add("info", "Профиль «" + d.active + "» изменён после применения", "Сохрани изменения в конструкторе (вкладка «Профили»), иначе профиль по контексту их не тронет, а переключение профиля их заменит.", "design", "Конструктор");
    return out;
}

/** Общая оценка: худший уровень среди проблем. */
function verdict(list) {
    if (list.some((p) => p.level === "error")) return "error";
    if (list.some((p) => p.level === "warn")) return "warn";
    return "ok";
}

/** Что «Починить всё» сделает для списка проблем: { fixes: [действия по порядку], reload: нужна ли перезагрузка окна }. */
function autoPlan(list) {
    const fixes = AUTO_FIXES.filter((f) => (list || []).some((p) => p.fix === f));
    return { fixes: fixes, reload: (list || []).some((p) => p.fix === "reload") };
}

module.exports = { problems, verdict, autoPlan, ACTIONS, AUTO_FIXES, SLOW_MODULE_MS, SLOW_RUNTIME_MS };
