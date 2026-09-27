// ============================================================
//  Хост: перенос вида между машинами — экспорт/импорт пакета и Settings Sync.
//  Методы подмешиваются в класс Host (lib/host.js), this — хост.
// ============================================================
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");
const S = require("./snippets");
const B = require("./bundle");
const { MAX_PROFILES } = require("./engine");
const { log } = require("./log");
const { metaFile, writeAtomic } = require("./storage");

class TransferPart {
    // ---------------- перенос между машинами ----------------

    /** Пакет со всем, что настроено в Moon Core на этой машине (lib/bundle.js). */
    exportBundle(opts) {
        this.engine.load();
        return B.makeBundle({ design: this.engine.design, profiles: this.engine.profiles, snippets: this.list }, opts);
    }

    localSource() { this.engine.load(); return { design: this.engine.design, profiles: this.engine.profiles, snippets: this.list }; }

    /**
     * Применить проверенный пакет (parseBundle(...).bundle): сниппеты записать (одноимённые
     * перезаписываются), профили добавить (одноимённые заменяются), конструктор привести к пакету.
     */
    async importBundle(b, confirmed) {
        if (b.snippets) {
            const meta = S.readMeta(metaFile(this.context));
            const off = new Set(meta.disabled);
            for (const s of b.snippets) {
                writeAtomic(this.fileOf(s.id), s.code);
                if (s.enabled) off.delete(s.id); else off.add(s.id);
                // JS из пакета запускается сразу, только если пакет загрузили с подтверждением
                // (ты видел список). Тихое восстановление из синхронизации — спросит отдельно.
                if (confirmed && S.kindOf(s.id) === "js") await this.approveJs(s.id, s.code);
            }
            S.writeMeta(metaFile(this.context), { disabled: Array.from(off) });
        }
        this.engine.load();
        Object.keys(b.profiles.list).forEach((n) => {
            if (this.engine.profiles.list[n] || Object.keys(this.engine.profiles.list).length < MAX_PROFILES) this.engine.profiles.list[n] = b.profiles.list[n];
        });
        this.engine.saveProfiles();
        const ops = B.designOps(b);
        const errors = [];
        for (let i = 0; i < ops.length; i += 200) {
            const r = await this.onDesign({ ops: ops.slice(i, i + 200) });
            if (r && !r.ok && r.error) errors.push(r.error);
        }
        // clearAll сбрасывает активный профиль — возвращаем тот, что был в пакете.
        this.engine.load();
        this.engine.profiles.active = b.profiles.active;
        this.engine.saveProfiles();
        this.rebuild();
        return { ok: !errors.length, error: errors.join("; ") };
    }

    /** Команда «Экспорт вида в файл». */
    async exportCommand() {
        const uri = await vscode.window.showSaveDialog({ filters: { "Moon Core": ["json"] }, saveLabel: "Сохранить", defaultUri: vscode.Uri.file(path.join(os.homedir(), "moon-core-bundle.json")) });
        if (!uri) return;
        const b = this.exportBundle();
        fs.writeFileSync(uri.fsPath, JSON.stringify(b, null, 2), "utf8");
        const p = B.parseBundle(b).bundle;
        vscode.window.showInformationMessage("Moon Core: сохранено (" + B.describe(p) + ").");
    }

    /** Команда «Импорт вида из файла». */
    async importCommand() {
        const pick = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { "Moon Core": ["json"] }, openLabel: "Импортировать" });
        if (!pick || !pick[0]) return;
        let text = "";
        try {
            if (fs.statSync(pick[0].fsPath).size > B.MAX_BUNDLE) throw new Error("файл больше " + (B.MAX_BUNDLE >> 20) + " МБ");
            text = fs.readFileSync(pick[0].fsPath, "utf8");
        } catch (e) { vscode.window.showErrorMessage("Moon Core: не удалось прочитать файл (" + e.message + ")"); return; }
        await this.confirmAndImport(B.parseBundle(text), "файла");
    }

    async confirmAndImport(parsed, from) {
        if (!parsed.ok) { vscode.window.showErrorMessage("Moon Core: " + parsed.error); return false; }
        const b = parsed.bundle;
        const clash = (b.snippets || []).filter((s) => fs.existsSync(this.fileOf(s.id))).map((s) => s.id);
        const js = (b.snippets || []).filter((s) => S.kindOf(s.id) === "js").map((s) => s.id);
        const detail = "В пакете: " + B.describe(b) + "." +
            (js.length ? "\nJS-сниппеты выполняются в окне VS Code с полным доступом: " + js.slice(0, 10).join(", ") + ". Загружай только свой пакет." : "") +
            "\nТекущие правки конструктора заменятся, настройки VS Code из них вернутся к исходным." +
            (clash.length ? "\nПерезапишутся сниппеты: " + clash.slice(0, 10).join(", ") + (clash.length > 10 ? " и ещё " + (clash.length - 10) : "") + "." : "") +
            (parsed.dropped ? "\nОтброшено проверкой: " + parsed.dropped + "." : "");
        const ok = await vscode.window.showWarningMessage("Moon Core: загрузить вид из " + from + "?", { modal: true, detail: detail }, "Загрузить");
        if (ok !== "Загрузить") return false;
        const r = await this.importBundle(b, true);
        if (r.ok) vscode.window.showInformationMessage("Moon Core: вид загружен (" + B.describe(b) + ").");
        else vscode.window.showWarningMessage("Moon Core: вид загружен с ошибками: " + r.error);
        return true;
    }

    // Синхронизация через настройку moonCore.syncData: её переносит Settings Sync.
    syncEnabled() { return vscode.workspace.getConfiguration("moonCore").get("sync", false) === true; }

    scheduleSyncOut() {
        if (!this.syncEnabled()) return;
        clearTimeout(this.syncTimer);
        this.syncTimer = setTimeout(() => this.syncOut().catch((e) => log("синхронизация", e)), 3000);
    }

    /** Положить пакет в настройку, если он отличается от того, что там уже есть. */
    async syncOut() {
        if (!this.syncEnabled() || this.syncImporting) return;
        let b = this.exportBundle();
        if (JSON.stringify(b).length > B.MAX_SYNC) {
            b = this.exportBundle({ snippets: false });
            log("синхронизация: сниппеты не влезают в настройку (больше " + (B.MAX_SYNC >> 10) + " КБ) — синхронизируются только конструктор и профили");
        }
        if (JSON.stringify(b).length > B.MAX_SYNC) { log("синхронизация: вид больше " + (B.MAX_SYNC >> 10) + " КБ — пропущено"); return; }
        const conf = vscode.workspace.getConfiguration("moonCore");
        const cur = B.parseBundle(conf.get("syncData"));
        const mine = B.parseBundle(b);
        if (cur.ok && B.contentKey(cur.bundle) === B.contentKey(mine.bundle)) return;
        await conf.update("syncData", b, vscode.ConfigurationTarget.Global);
    }

    /**
     * Взять вид из настройки. auto — при запуске: молча и только если на этой машине пусто;
     * иначе (команда или пришли новые данные) — с подтверждением.
     */
    async syncIn(auto) {
        const raw = vscode.workspace.getConfiguration("moonCore").get("syncData");
        if (!raw) { if (!auto) vscode.window.showInformationMessage("Moon Core: в синхронизации пока пусто. Включи moonCore.sync на машине, где вид настроен."); return; }
        const parsed = B.parseBundle(raw);
        if (!parsed.ok) { log("синхронизация: " + parsed.error); return; }
        const local = B.parseBundle(this.exportBundle());
        if (local.ok && B.contentKey(local.bundle) === B.contentKey(parsed.bundle)) { if (!auto) vscode.window.showInformationMessage("Moon Core: вид уже совпадает с синхронизацией."); return; }
        this.syncImporting = true;
        try {
            if (auto && B.isEmptyLocal(this.localSource())) {
                await this.importBundle(parsed.bundle);
                vscode.window.showInformationMessage("Moon Core: вид восстановлен из синхронизации (" + B.describe(parsed.bundle) + ").");
            } else if (!auto) {
                await this.confirmAndImport(parsed, "синхронизации");
            }
        } finally { this.syncImporting = false; }
    }

    notifySyncChanged() {
        clearTimeout(this.syncNotifyTimer);
        this.syncNotifyTimer = setTimeout(async () => {
            const parsed = B.parseBundle(vscode.workspace.getConfiguration("moonCore").get("syncData"));
            const local = B.parseBundle(this.exportBundle());
            if (!parsed.ok || (local.ok && B.contentKey(local.bundle) === B.contentKey(parsed.bundle))) return;
            if (!(vscode.window.state && vscode.window.state.focused)) return;   // спросит окно в фокусе
            const pick = await vscode.window.showInformationMessage("Moon Core: пришёл вид с другой машины (" + B.describe(parsed.bundle) + "). Загрузить?", "Загрузить", "Не сейчас");
            if (pick === "Загрузить") { this.syncImporting = true; try { await this.importBundle(parsed.bundle); } finally { this.syncImporting = false; } }
        }, 1500);
    }
}

module.exports = { Part: TransferPart };
