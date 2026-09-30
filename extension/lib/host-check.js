// ============================================================
//  Хост: проверка селекторов и самолечение правил конструктора после обновлений VS Code.
//  Методы подмешиваются в класс Host (lib/host.js), this — хост.
// ============================================================
"use strict";

const vscode = require("vscode");
const crypto = require("crypto");
const K = require("./checks");
const { log, showLog } = require("./log");
const KEYS = require("./keys");
const VF = require("./vs-files");

const CHECK_TIMEOUT_MS = 3000;

class CheckPart {
    /** Спросить окно: какие селекторы (сниппеты, правки конструктора, каталог) ничего не находят. */
    async runCheck(opts) {
        if (!this.bridge.status().streams) return null;
        const reqId = crypto.randomBytes(8).toString("hex");
        const answer = await new Promise((resolve) => {
            const t = setTimeout(() => { this.pending.delete(reqId); resolve(null); }, CHECK_TIMEOUT_MS);
            this.pending.set(reqId, (b) => { clearTimeout(t); this.pending.delete(reqId); resolve(b); });
            this.bridge.broadcast("check", { reqId: reqId, host: this.hostRef(), prints: opts && opts.prints ? opts.prints : undefined });
        });
        const summary = answer && Array.isArray(answer.results) ? K.summarize(answer.results) : null;
        // Что «точно сломано»: класса из селектора нет в файлах этой версии VS Code (lib/vs-files.js).
        if (summary && vscode.env && vscode.env.appRoot) { try { VF.annotateCheck(summary, vscode.env.appRoot); } catch (e) { log("проверка по файлам VS Code", e); } }
        // Подсказки в редакторе CSS-сниппетов (lib/ext/extras.js): что сейчас ничего не находит.
        if (summary && typeof this.onCheckDone === "function") { try { this.onCheckDone(summary); } catch (e) { log("подсказки проверки", e); } }
        return summary;
    }

    /** Команда «Проверить селекторы». */
    async checkSelectors() {
        if (!this.bridge.status().streams) { vscode.window.showWarningMessage("Moon Core: окно не подключено к мосту."); return; }
        const s = await this.runCheck();
        if (!s) { vscode.window.showWarningMessage("Moon Core: окно не ответило на проверку."); return; }
        ["", "=== Проверка селекторов ==="].concat(s.lines).forEach((l) => log(l));
        const total = s.user.total + s.catalog.total, dead = s.user.dead + s.catalog.dead;
        const msg = dead ? "Moon Core: из " + total + " селекторов ничего не находят " + dead + " (список в журнале)." +
            (s.gone ? " Точно сломаны — такого класса в этой версии VS Code больше нет: " + s.gone + "." : "") + " Остальные могут быть нормой: элемент просто сейчас не показан."
            : "Moon Core: все " + total + " селекторов находят элементы.";
        const fix = s.heals.length ? "Починить (" + s.heals.length + ")" : null;
        const pick = await (dead ? vscode.window.showWarningMessage(msg, ...[fix, "Журнал"].filter(Boolean)) : vscode.window.showInformationMessage(msg));
        if (pick === "Журнал") showLog();
        else if (pick && pick === fix) await this.offerHeals(s.heals);
    }

    /**
     * Самолечение: окно нашло по отпечаткам, куда переехали элементы сломанных правок.
     * Пользователь отмечает замены; принятые правила переезжают на новый селектор (и в профилях).
     * Найденные «по признакам» по умолчанию не отмечены: там угадывание, пусть решит человек.
     * Возвращает число принятых замен.
     */
    async offerHeals(heals) {
        if (!heals || !heals.length) return 0;
        const items = heals.map((h) => ({
            label: h.label || "правка конструктора", description: K.HOW[h.how] || h.how,
            detail: h.from + "   →   " + h.to, picked: h.how !== "search", heal: h,
        }));
        const pick = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: "Куда переехали элементы сломанных правок — отметь замены, которые принять" });
        if (!pick || !pick.length) return 0;
        const r = await this.onDesign({ ops: pick.map((p) => ({ op: "renameRule", from: p.heal.from, to: p.heal.to, fp: p.heal.fp || undefined })) });
        pick.forEach((p) => log("самолечение: " + p.heal.from + " -> " + p.heal.to + " (" + (K.HOW[p.heal.how] || p.heal.how) + ")"));
        if (r.ok) vscode.window.setStatusBarMessage("Moon Core: правок починено: " + pick.length, 5000);
        else vscode.window.showWarningMessage("Moon Core: " + r.error);
        return pick.length;
    }

    /**
     * После обновления VS Code — проверить всё самому, один раз на версию. Переименованный класс
     * в вёрстке не даёт ошибки: правило конструктора или сниппет просто молча перестаёт работать.
     * Проверяет хост окна в фокусе (окон может быть несколько, хватит одного отчёта).
     */
    async autoCheckAfterUpdate() {
        const KEY = KEYS.CHECKED_VERSION;
        const gs = this.context.globalState;
        const ver = vscode.version;
        const last = gs.get(KEY);
        if (last === ver) return;
        if (!last) { await gs.update(KEY, ver); return; }        // первый запуск: сравнивать не с чем
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        let ready = false;
        for (let i = 0; i < 90 && !ready; i++) {
            ready = this.bridge.status().streams > 0 && !!(vscode.window.state && vscode.window.state.focused);
            if (!ready) await sleep(1000);
        }
        if (!ready || gs.get(KEY) === ver) return;                // другое окно успело проверить
        await sleep(4000);                                        // дать воркбенчу дорисоваться
        const s = await this.runCheck();
        if (!s) return;                                           // попробуем при следующем запуске
        await gs.update(KEY, ver);
        ["", "=== VS Code обновился: " + last + " -> " + ver + ", проверка селекторов ==="].concat(s.lines).forEach((l) => log(l));
        if (s.catalog.dead) log("Каталог: элементов без совпадений " + s.catalog.dead + " из " + s.catalog.total + " (часть может быть просто не показана).");
        if (!s.user.dead) {
            vscode.window.setStatusBarMessage("Moon Core: VS Code " + ver + " — все " + s.user.total + " правил на месте", 6000);
            return;
        }
        const fix = s.heals.length ? "Починить (" + s.heals.length + ")" : null;
        const pick = await vscode.window.showWarningMessage(
            "Moon Core: VS Code обновился до " + ver + ". Из " + s.user.total + " правил (сниппеты и конструктор) ничего не находят " + s.user.dead +
            ": вероятно, VS Code переименовал элементы." + (fix ? " Для " + s.heals.length + " из них Moon Core нашёл, куда элемент переехал." : " Часть может быть нормой, если элемент сейчас не показан."),
            ...[fix, "Журнал", "Конструктор"].filter(Boolean));
        if (pick && pick === fix) await this.offerHeals(s.heals);
        if (pick === "Журнал") showLog();
        if (pick === "Конструктор") this.toggleDesign();
    }
}

module.exports = { Part: CheckPart };
