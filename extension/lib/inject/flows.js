// ============================================================
//  Внедрение: сценарии с участием человека — команды «Внедрить» / «Убрать», проверка при
//  запуске, повторное внедрение после обновления VS Code, модули, права администратора.
// ============================================================
"use strict";

const vscode = require("vscode");
const path = require("path");
const MH = require("../module-host");
const { log } = require("../log");
const SH = require("./shell");
const PL = require("./plan");
const EL = require("./elevated");
const LK = require("./lock");
const UF = require("./ui-file");
const KEYS = require("../keys");
const AU = require("../audit");

const REASONS = {
    "no-workbench": "Не найден workbench.html в установке VS Code.",
    "no-runtime": "Не найден файл рантайма в папке расширения.",
    "denied": "Нет прав на запись в папку VS Code (обычно она в Program Files).",
    "error": "Не удалось записать оболочку VS Code — подробности в журнале.",
    "busy": "Оболочку сейчас записывает другое окно VS Code — попробуй через несколько секунд.",
};

/** Внедрить и обновить скрипт восстановления (синхронно; занято другим окном — reason "busy"). */
function injectNow(context) {
    return PL.inject(context, () => EL.writeRecovery(context));
}

/**
 * Внедрить с учётом других окон: если оболочку сейчас пишет другое окно, дождаться его и
 * посмотреть ещё раз — чаще всего оно уже сделало ровно то же самое (byOther), и второй
 * записи не нужно. Иначе — внедрить самим.
 */
async function injectShared(context) {
    const r = injectNow(context);
    if (r.reason !== "busy") return r;
    log("внедрение: оболочку пишет другое окно VS Code — жду его");
    await LK.waitFree(PL.lockFileOf(context), 20000);
    const st = SH.status(context);
    if (st.length && st.every((s) => s.injected && s.current)) {
        log("внедрение: другое окно уже обновило оболочку");
        return { ok: true, done: 0, byOther: true };
    }
    return injectNow(context);
}

async function askReload(text) {
    const pick = await vscode.window.showInformationMessage(text, "Перезагрузить окно");
    if (pick) await vscode.commands.executeCommand("workbench.action.reloadWindow");
}
function reloadText(prefix) {
    return prefix + (SH.fixChecksumOn() ? "" : " VS Code может написать, что установка «повреждена», — это ожидаемо для патча оболочки.") + " Перезагрузить окно?";
}

/** Спросить про чужие вставки в оболочке (раз на их содержимое). true — одобрили. */
async function askShellTrust(context, st) {
    const asked = SH.readMap(context, SH.SHELL_ASKED_KEY);
    const todo = st.filter((s) => s.injected && !s.trusted && asked[s.file] !== s.shellSha);
    if (!todo.length) return false;
    todo.forEach((s) => { asked[s.file] = s.shellSha; });
    await context.globalState.update(SH.SHELL_ASKED_KEY, asked);
    const names = Array.from(new Set([].concat.apply([], todo.map((s) => s.foreign)))).join(", ") || "неизвестные правки";
    const pick = await vscode.window.showWarningMessage(
        "Moon Core: оболочку VS Code изменил не только Moon Core (" + names + "). Если это твои загрузчики, " +
        "Moon Core может убрать баннер «установка повреждена». Если не знаешь, что это, — оставь баннер: " +
        "он предупреждает о вмешательстве в файлы редактора.",
        "Это мои — доверять", "Показать файл", "Оставить баннер");
    if (pick === "Показать файл") { await vscode.window.showTextDocument(vscode.Uri.file(todo[0].file), { preview: true }); return false; }
    if (pick !== "Это мои — доверять") return false;
    const ok = SH.readMap(context, SH.SHELL_OK_KEY);
    todo.forEach((s) => { ok[s.file] = s.shellSha; });
    await context.globalState.update(SH.SHELL_OK_KEY, ok);
    AU.record(context.globalState, "shell", "чужие вставки: " + names, "allow").catch(() => {});
    log("чужие вставки в оболочке одобрены: " + names);
    return true;
}

/** Ждать итога задания с полосой прогресса и кнопкой отмены. */
function waitElevated(job, ms, title) {
    if (!job) return Promise.resolve({ ok: false, error: "нет задания" });
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: title, cancellable: true },
        (p, token) => EL.waitResult(job, ms, () => token.isCancellationRequested));
}
/** Windows не дал запросить права сам (PowerShell и Windows Script Host запрещены политикой) —
 *  показать run.cmd: его можно запустить от имени администратора вручную. */
async function manualElevation(job, why) {
    if (!job) return { ok: false, error: "нет задания" };
    log("права администратора автоматически не запросить" + (why ? " (" + why + ")" : "") + " — предлагаю " + job.cmd);
    const pick = await vscode.window.showWarningMessage(
        "Moon Core: Windows не дал запросить права автоматически (запуск PowerShell запрещён на этом ПК). " +
        "Откроется папка: нажмите на run.cmd правой кнопкой — «Запуск от имени администратора» — и введите пароль администратора.",
        "Открыть папку", "Отмена");
    if (pick !== "Открыть папку") { EL.dropJob(job); return { ok: false, cancelled: true }; }
    try { await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(job.cmd)); } catch (e) {}
    const r = await waitElevated(job, 10 * 60000, "Moon Core: жду запуска run.cmd от имени администратора…");
    if (!r.ok) EL.dropJob(job);
    return r.timeout ? { ok: false, error: "run.cmd так и не запустили" } : r;
}
/** Как обойтись без администратора: VS Code «для пользователя». */
async function explainNoAdmin() {
    const pick = await vscode.window.showInformationMessage("Moon Core без прав администратора", {
        modal: true,
        detail: "Этот VS Code установлен для всех пользователей (в Program Files) — его файлы Windows разрешает менять только администратору, обойти это нельзя.\n\n" +
            "Без администратора: установите VS Code вариантом «User Installer» (на странице загрузки — User Installer). Он ставится в папку пользователя, прав администратора не просит ни при установке, ни Moon Core. Настройки и расширения сохранятся.\n\n" +
            "Окно документации C++ работает и без этого — во вкладке: F1 → «Документация C++: открыть окно во вкладке».",
    }, "Открыть страницу загрузки");
    if (pick) vscode.env.openExternal(vscode.Uri.parse("https://code.visualstudio.com/download"));
}

/** Нет прав — предложить записать с правами администратора (Windows). true — записали. */
async function offerElevation(context, ops, what) {
    if (process.platform !== "win32" || !ops || !ops.length) return false;
    const pick = await vscode.window.showWarningMessage(
        "Moon Core: нет прав на запись в папку VS Code — он установлен для всех пользователей. " + what + " с правами администратора? Windows спросит разрешение (или пароль администратора).",
        "С правами администратора", "Без администратора", "Отмена");
    if (pick === "Без администратора") { await explainNoAdmin(); return false; }
    if (pick !== "С правами администратора") return false;
    // Под блокировкой: пока Windows спрашивает разрешение, другое окно не начнёт свою запись.
    // Ожидание запуска без ожидания/вручную — тоже под блокировкой.
    const r = await LK.withLockAsync(PL.lockFileOf(context), async () => {
        let x = await EL.execPlanElevated(ops, context.globalStorageUri.fsPath, process.execPath);
        if (x.pending) {
            const job = x.job;
            x = await waitElevated(job, 180000, "Moon Core: подтвердите запрос прав администратора в окне Windows…");
            if (x.timeout) x = { manual: true, job: job };
        }
        if (x.manual) x = await manualElevation(x.job, x.why);
        return x;
    });
    SH.resetStatusCache();
    if (r.busy) { vscode.window.showWarningMessage("Moon Core: " + REASONS.busy); return false; }
    if (r.cancelled) { vscode.window.showInformationMessage("Moon Core: запрос прав отменён."); return false; }
    if (!r.ok) { vscode.window.showErrorMessage("Moon Core: не удалось (" + (r.error || "нет ответа") + ")"); return false; }
    // Итог проверяем сами (а не по «готово» из временной папки): каждый файл — то, что планировали.
    const bad = EL.verifyPlan(ops);
    if (bad.length) { vscode.window.showErrorMessage("Moon Core: после записи файлы не совпали с ожидаемыми: " + bad.map((o) => path.basename(o.file)).join(", ")); return false; }
    await SH.rememberBlocks(context, ops);
    return true;
}

/** Команда «Внедрить». done — начало вопроса о перезагрузке (по умолчанию «Moon Core внедрён.»). */
async function injectCommand(context, done) {
    const r = await injectShared(context);
    if (!r.ok) {
        if (r.reason === "denied" && r.plan && await offerElevation(context, r.plan.ops, "Внедрить")) {
            try { EL.writeRecovery(context); } catch (e) {}
        } else {
            vscode.window.showErrorMessage("Moon Core: " + (REASONS[r.reason] || r.reason) + (r.error ? " (" + r.error + ")" : ""));
            return false;
        }
    }
    log("внедрено в оболочку: " + (r.byOther ? "другим окном" : r.done || "с правами администратора"));
    await context.globalState.update(SH.WANT_KEY, true);
    const st = SH.status(context);
    if (await askShellTrust(context, st)) PL.healChecksum(SH.status(context), context);
    await askReload(reloadText(typeof done === "string" && done ? done : "Moon Core внедрён."));
    return true;
}

/** Команда «Убрать». */
async function removeCommand(context) {
    const r = PL.remove(context);
    if (context) await context.globalState.update(SH.WANT_KEY, false);
    if (!r.ok) {
        if (r.denied && await offerElevation(context, r.ops, "Снять")) { await askReload("Moon Core убран из оболочки VS Code. Перезагрузить окно?"); return; }
        vscode.window.showErrorMessage("Moon Core: не удалось снять блок (" + r.error + ")"); return;
    }
    log("снято из оболочки: " + r.done);
    await askReload(r.done ? "Moon Core убран из оболочки VS Code. Перезагрузить окно?" : "Moon Core и так не внедрён.");
}

/** Внедрить заново без вопроса (moonCore.autoReinject) или спросить с кнопкой «Всегда сам». */
async function reinjectFlow(context, question) {
    const conf = SH.conf();
    if (conf.get("autoReinject", true)) {
        const r = await injectShared(context);
        log("автовнедрение: " + JSON.stringify({ ok: r.ok, done: r.done, reason: r.reason }));
        if (r.ok) { await askReload("Moon Core снова встроен в VS Code после обновления. Перезагрузить окно?"); return; }
        if (r.reason === "denied" && r.plan && await offerElevation(context, r.plan.ops, "Внедрить")) { await askReload("Moon Core снова встроен. Перезагрузить окно?"); return; }
    }
    const pick = await vscode.window.showWarningMessage(question, "Внедрить", "Всегда внедрять сам", "Не сейчас", "Больше не нужен");
    if (pick === "Всегда внедрять сам") { await conf.update("autoReinject", true, vscode.ConfigurationTarget.Global); await injectCommand(context); }
    else if (pick === "Внедрить") await injectCommand(context);
    else if (pick === "Больше не нужен") await context.globalState.update(SH.WANT_KEY, false);
}

/** Пустые следы be5invis custom-css в оболочке — предложить убрать (один раз на версию VS Code). */
async function offerLegacyCleanup(context, st) {
    if (!st.some((s) => s.legacy)) return;
    const key = KEYS.LEGACY_ASKED_FOR;
    if (context.globalState.get(key) === vscode.version) return;
    await context.globalState.update(key, vscode.version);
    const pick = await vscode.window.showInformationMessage(
        "Moon Core: в оболочке VS Code остались пустые метки старого загрузчика Custom CSS and JS. Они ничего не делают. Убрать?",
        "Убрать", "Оставить");
    if (pick !== "Убрать") return;
    try { PL.cleanLegacy(st, context); log("следы старого загрузчика убраны"); }
    catch (e) { log("следы старого загрузчика", e); vscode.window.showErrorMessage("Moon Core: не удалось (" + e.message + ")"); }
}

/**
 * Первый запуск после установки: Moon Core ни разу не был в оболочке и никто не говорил, что
 * он не нужен (WANT_KEY не задан), — встроиться самому, без вопроса и без настройки. Пути
 * берутся из самой установки VS Code (appRoot) и globalStorage, так что у любого человека
 * всё находится само. Выключается moonCore.autoInject. Попытка — одна на версию VS Code:
 * не вышло (отменили запрос прав) — дальше обычный вопрос. true — сценарий отработал.
 */
async function firstInject(context) {
    if (context.globalState.get(SH.WANT_KEY) !== undefined || !SH.conf().get("autoInject", true)) return false;
    const key = KEYS.AUTO_TRIED_FOR;
    if (context.globalState.get(key) === vscode.version) return false;
    await context.globalState.update(key, vscode.version);
    log("первый запуск: встраиваюсь в оболочку VS Code сам (moonCore.autoInject)");
    const ok = await injectCommand(context, "Moon Core установлен и встроен в VS Code — осталось перезагрузить окно.");
    // Не вышло — вопрос «Внедрить?» в этой версии VS Code уже не нужен: ошибку только что показали.
    if (!ok) await context.globalState.update(KEYS.PROMPTED_FOR, vscode.version);
    return true;
}

/** При активации: VS Code обновился (блока нет) — встроить/спросить; рантайм устарел — обновить молча. */
async function checkOnActivate(context) {
    let st = SH.status(context);
    // Наш блок правили снаружи — сообщить и переписать (это признак вмешательства в оболочку).
    if (st.some((s) => s.injected && !s.blockOk)) {
        log("блок Moon Core в оболочке изменён не Moon Core — переписываю: " + st.filter((s) => !s.blockOk).map((s) => s.file).join(", "));
        vscode.window.showWarningMessage("Moon Core: кто-то изменил блок Moon Core в оболочке VS Code. Блок переписан заново — проверь, какие программы правят файлы VS Code.");
        const r0 = await injectShared(context);
        if (r0.ok) { await askReload("Moon Core восстановил свой блок в оболочке. Перезагрузить окно?"); return; }
        st = SH.status(context);
    }
    if (await askShellTrust(context, st)) { PL.healChecksum(SH.status(context), context); st = SH.status(context); }
    if (!st.length) { log("workbench.html не найден — внедрение недоступно"); return; }
    try { if (st.some((s) => s.injected)) EL.writeRecovery(context); } catch (e) { log("скрипт восстановления", e); }
    // Уже внедрён (в том числе версией без этого флага) — запоминаем, что Moon Core нужен.
    if (st.some((s) => s.injected) && !context.globalState.get(SH.WANT_KEY)) await context.globalState.update(SH.WANT_KEY, true);
    PL.healChecksum(st, context);
    offerLegacyCleanup(context, st).catch((e) => log("следы старого загрузчика", e));
    if (st.every((s) => s.injected && s.current)) return;
    if (st.some((s) => s.injected) && st.some((s) => !s.current) && SH.conf().get("autoUpdateInjection", true)) {
        const r = await injectShared(context);
        log("рантайм в оболочке обновлён: " + JSON.stringify({ ok: r.ok, done: r.done, reason: r.reason }));
        if (r.ok) await askReload("Moon Core обновил рантайм в оболочке VS Code. Перезагрузить окно, чтобы применить?");
        return;
    }
    // Блок был внедрён и пропал: VS Code обновился или оболочку перезаписал другой загрузчик.
    if (st.every((s) => !s.injected) && context.globalState.get(SH.WANT_KEY)) {
        await reinjectFlow(context, "Moon Core пропал из оболочки VS Code: её перезаписало обновление или другой загрузчик (Custom CSS, Custom UI Style). Внедрить снова?");
        return;
    }
    if (st.every((s) => !s.injected) && await firstInject(context)) return;
    if (st.every((s) => !s.injected)) {
        const key = KEYS.PROMPTED_FOR;
        const ver = vscode.version;
        if (context.globalState.get(key) === ver) return;   // спрашиваем один раз на версию VS Code
        const pick = await vscode.window.showInformationMessage(
            "Moon Core не внедрён в оболочку VS Code" + (context.globalState.get(key) ? " (VS Code обновился)" : "") + ". Внедрить?",
            "Внедрить", "Не сейчас");
        await context.globalState.update(key, ver);
        if (pick === "Внедрить") await injectCommand(context);
    }
}

/**
 * Модули поменялись (новый разрешён, выключен, пересобран рантайм): обновить блок, если
 * Moon Core уже внедрён. Не внедрён — ничего не делаем, модули попадут при внедрении.
 * askFirst — спросить про новые модули перед этим. opts.quiet — не предлагать перезагрузку
 * (режим разработки: окно уже перезапустило модуль горячо). Возвращает true, если блок переписан.
 */
async function syncModules(context, askFirst, opts) {
    if (askFirst) await MH.reviewNew(context);
    const pend = SH.moduleSet(context).pending;
    if (pend && pend.length && await MH.reviewChanged(context, pend)) SH.resetModuleCache();
    const st = SH.status(context);
    if (!st.length || !st.some((s) => s.injected) || st.every((s) => s.current)) return false;
    if (!SH.conf().get("autoUpdateInjection", true)) {
        log("модули изменились, но автообновление выключено — нужна команда «Внедрить»");
        return false;
    }
    const r = await injectShared(context);
    log("модули: блок в оболочке обновлён: " + JSON.stringify({ ok: r.ok, done: r.done, reason: r.reason }));
    if (r.ok && !(opts && opts.quiet)) await askReload("Moon Core: модули обновлены в оболочке VS Code. Перезагрузить окно, чтобы применить?");
    return r.ok;
}

let _failHandled = false;
/** Окно сообщило: файл модуля не выполнился. Переписать файлы; если стояла проверка целостности —
 *  значит, эта версия VS Code её не поддерживает (или файл подменили) — выключить её для этой версии. */
async function onModulesFailed(context, ids) {
    if (_failHandled || !ids || !ids.length) return;
    _failHandled = true;
    const sriOn = SH.conf().get("moduleIntegrity", true) && context.globalState.get(SH.SRI_OFF_KEY) !== vscode.version;
    if (sriOn) await context.globalState.update(SH.SRI_OFF_KEY, vscode.version);
    log("модули не загрузились: " + ids.join(", ") + (sriOn ? " — проверка целостности выключена для VS Code " + vscode.version + ", файлы переписаны" : " — файлы переписаны"));
    const r = await injectShared(context);
    if (r.ok) await askReload("Moon Core: модуль " + ids.join(", ") + " не загрузился " +
        (sriOn ? "(эта версия VS Code не поддерживает проверку целостности файлов модулей, либо файл был подменён)" : "(файл модуля отсутствовал или был изменён)") +
        ". Файлы записаны заново. Перезагрузить окно?");
}

let _uiInlined = false;
/**
 * Окно не смогло загрузить интерфейс (конструктор) отдельным файлом. body: { reason, sha }.
 *   missing/sha — файла нет или он другой: переписать; если окно ждёт ту же версию, что
 *                 у расширения, — пусть попробует ещё раз (again; не retry — тот у моста значит «спроси другой хост»), иначе окну нужна перезагрузка;
 *   eval/nocrypto — VS Code не даёт вычислить чанк: встраивать интерфейс целиком в этой версии.
 */
async function onUiFailed(context, body) {
    const reason = String(body && body.reason || "");
    log("интерфейс окна не загрузился: " + reason.slice(0, 20));
    if (reason === "missing" || reason === "sha") {
        let cur = null;
        try { cur = UF.ensureUiFile(context); } catch (e) { log("файл интерфейса окна", e); }
        return { ok: true, again: !!cur && String(body && body.sha || "") === cur.sha };
    }
    if ((reason === "eval" || reason === "nocrypto") && !_uiInlined) {
        _uiInlined = true;
        await UF.markInline(context);
        const r = await injectShared(context);
        log("интерфейс окна встроен в оболочку целиком (VS Code " + vscode.version + "): " + JSON.stringify({ ok: r.ok, reason: r.reason }));
        if (r.ok) askReload("Moon Core: этот VS Code не дал загрузить конструктор отдельным файлом — он встроен в оболочку. Перезагрузить окно?");
    }
    return { ok: true, again: false };
}

module.exports = { injectCommand, removeCommand, checkOnActivate, syncModules, onModulesFailed, onUiFailed, injectNow, injectShared, askReload };
