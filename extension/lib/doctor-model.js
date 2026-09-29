// ============================================================
//  «Доктор» Moon Core — модель без vscode: по снимку состояния решает, что не так и какой
//  кнопкой это чинится. Страницу рисует lib/doctor.js, тесты гоняют эту часть.
//
//  Снимок (собирает doctor.js):
//    { vscode, ext, shells: inject.status(), bridge: bridge.status(), timing, modules: {found, allowed,
//      dev, pending}, design: {rules, settings, active, dirty}, snippets: {total, on, errors, jsPending},
//      check: summarize()|null, recovery }
//  Проблема: { level: "error"|"warn"|"info", title, detail, fix?: команда страницы, fixLabel? }
// ============================================================
"use strict";

const ACTIONS = ["inject", "remove", "reload", "check", "heal", "log", "modules", "moduleDev", "recovery", "design", "refresh", "jsReview", "report", "permissions", "export"];

const base = (f) => String(f || "").split(/[\\/]/).slice(-3).join("/");

function problems(s) {
    const out = [];
    const add = (level, title, detail, fix, fixLabel) => out.push({ level: level, title: title, detail: detail || "", fix: fix || "", fixLabel: fixLabel || "" });
    const shells = Array.isArray(s.shells) ? s.shells : [];
    if (!shells.length) add("error", "Оболочка VS Code не найдена", "Не нашёлся workbench.html в папке VS Code — внедрение невозможно.");
    const injected = shells.filter((x) => x.injected);
    if (shells.length && !injected.length) add("warn", "Moon Core не внедрён", "Конструктор, сниппеты и модули не работают, пока рантайм не встроен в оболочку.", "inject", "Внедрить");
    shells.forEach((x) => {
        if (x.error) add("error", "Оболочка недоступна: " + base(x.file), x.error);
        if (!x.injected) return;
        if (!x.current) add("warn", "Рантайм в оболочке устарел", base(x.file) + ": версия блока " + (x.version || "?") + ". Новая версия Moon Core или модулей ещё не встроена.", "inject", "Обновить");
        if (x.checksum === false) add("warn", "VS Code пишет «установка повреждена»", "Хэш оболочки в product.json не сходится" + (x.trusted === false ? ": в оболочке чужие вставки без одобрения (" + (x.foreign || []).join(", ") + ")" : "") + ".", "inject", "Внедрить заново");
        if (x.blockOk === false) add("warn", "Блок Moon Core изменён снаружи", "Кто-то правил блок в " + base(x.file) + ". Внедрение перепишет его.", "inject", "Переписать");
        if (x.legacy) add("info", "Следы старого загрузчика", "Пустые метки Custom CSS and JS в оболочке — безвредны.");
        const d = x.deep;
        if (d && d.want) {
            if (d.want.di && !d.diSupported) add("warn", "Сервисы окна недоступны в этой версии VS Code", "Место для крючка в бандле не найдено: VS Code переписал этот код. Остальное Moon Core работает.");
            else if (x.injected && !d.ok) add("warn", "Глубокая интеграция не совпадает с настройками", "Включил или выключил её, или VS Code обновился и стёр патчи. Внедрение приведёт всё в порядок.", "inject", "Внедрить");
        }
    });
    const b = s.bridge || {};
    if (!b.running) add("error", "Мост не поднят", "Окно не может связаться с расширением. Подробности — в журнале.", "log", "Журнал");
    else if (injected.length && !b.streams) add("warn", "Окно не на связи", "Рантайм встроен, но ни одно окно не подключилось. Перезагрузи окно после внедрения.", "reload", "Перезагрузить окно");
    const t = s.timing;
    if (t && t.failed && t.failed.length) add("error", "Модуль не выполнился: " + t.failed.join(", "), "Файл модуля не прошёл проверку целостности, пропал или был изменён. Moon Core переписал файлы — нужна перезагрузка окна.", "reload", "Перезагрузить окно");
    if (t && t.skipped && t.skipped.length) add("warn", "Пропущено защитой запуска: " + t.skipped.join(", "), "В прошлый раз окно не запустилось на этом модуле. Перезагрузи окно, чтобы попробовать снова.", "reload", "Перезагрузить окно");
    const noisy = (Array.isArray(s.errors) ? s.errors : []).filter((e) => e && e.n >= 20);
    if (noisy.length) add("warn", "Часто падает: " + noisy.map((e) => e.source + " (" + e.n + ")").join(", "), "Ошибки этого источника идут одна за другой — подробности в журнале.", "log", "Журнал");
    if (b.dropped) add("info", "Отключено зависших окон: " + b.dropped, "Окно не читало события моста (стояло в отладчике или зависло) — хост отключил его, чтобы не копить память. Окно переподключится само.");
    const m = s.modules || {};
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

module.exports = { problems, verdict, ACTIONS };
