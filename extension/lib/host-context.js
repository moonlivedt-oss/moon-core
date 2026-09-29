// ============================================================
//  Хост: профили по контексту и профиль проекта.
//    - moonCore.autoProfiles: язык, папка, ветка, тема, время суток (выбор — lib/autoprofile.js);
//    - .vscode/mooncore.json: вид, который едет с проектом (lib/project.js), — после согласия.
//  Методы подмешиваются в класс Host (lib/host.js), this — хост.
// ============================================================
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const AP = require("./autoprofile");
const PR = require("./project");
const { log } = require("./log");
const KEYS = require("./keys");
const AU = require("./audit");

const PROJECT_KEY = KEYS.PROJECT_PROFILES;   // путь папки -> { sha, ok } — ответ про файл проекта
const THEME_KINDS = { 1: "light", 2: "dark", 3: "highContrast", 4: "highContrastLight" };

/**
 * Ответов про проекты не больше MAX_PROJECTS: иначе карта в globalState растёт с каждой
 * открытой когда-либо папкой. Уходят самые старые (at — время ответа; старые записи без него).
 */
const MAX_PROJECTS = 200;
function capProjects(map) {
    const keys = Object.keys(map);
    if (keys.length <= MAX_PROJECTS) return map;
    const keep = keys.sort((a, b) => (Number(map[b].at) || 0) - (Number(map[a].at) || 0)).slice(0, MAX_PROJECTS);
    const out = {};
    keep.forEach((k) => { out[k] = map[k]; });
    return out;
}

class ContextPart {
    /** Контекст окна: язык активного файла, папка проекта, git-ветка, вид темы, минуты от полуночи. */
    contextNow() {
        const ed = vscode.window.activeTextEditor;
        const folder = (vscode.workspace.workspaceFolders || [])[0];
        let branch = "";
        try {
            const ext = vscode.extensions.getExtension("vscode.git");
            const api = ext && ext.isActive ? ext.exports.getAPI(1) : null;
            const repo = api && api.repositories.length ? (ed && api.getRepository(ed.document.uri)) || api.repositories[0] : null;
            branch = (repo && repo.state && repo.state.HEAD && repo.state.HEAD.name) || "";
        } catch (e) { branch = ""; }
        const theme = vscode.window.activeColorTheme ? THEME_KINDS[vscode.window.activeColorTheme.kind] || "" : "";
        const d = new Date();
        return { language: ed ? ed.document.languageId : "", folder: folder ? folder.name : "", branch: branch, theme: theme, minutes: d.getHours() * 60 + d.getMinutes() };
    }

    /**
     * Подобрать профиль под контекст. Профиль и настройки VS Code общие для всех окон, поэтому
     * решает окно в фокусе. Несохранённые правки не затираем: активный профиль «изменён» —
     * пропускаем (и один раз говорим об этом в статусбаре). Профиль проекта важнее правил.
     */
    scheduleAutoProfile() {
        clearTimeout(this.autoTimer);
        this.autoTimer = setTimeout(() => this.autoProfile().catch((e) => log("профиль по контексту", e)), 800);
    }

    async autoProfile() {
        if (!(vscode.window.state && vscode.window.state.focused)) return;
        const conf = vscode.workspace.getConfiguration("moonCore");
        const rules = conf.get("autoProfiles", []);
        const project = await this.projectTarget();
        if (!project && !AP.cleanRules(rules).length) return;
        const target = project || AP.pick(rules, this.contextNow(), conf.get("autoProfileDefault", ""));
        if (!target) return;
        const sum = this.engine.summary();
        if (!sum.list.some((p) => p.name === target)) { log("профиль по контексту: нет профиля «" + target + "»"); return; }
        if (sum.active === target && !sum.dirty) return;
        // Все виды правок: clearAll при включении профиля вернул бы и цвета темы, и кнопки, и эффекты.
        const hasEdits = this.engine.editCount() > 0;
        if ((sum.active && sum.dirty) || (!sum.active && hasEdits)) {
            if (this.autoSkipped !== target) {
                this.autoSkipped = target;
                vscode.window.setStatusBarMessage("Moon Core: профиль «" + target + "» не включён — есть несохранённые правки конструктора", 6000);
            }
            return;
        }
        this.autoSkipped = "";
        const r = await this.onDesign({ ops: [{ op: "applyProfile", name: target }] });
        if (r.ok) vscode.window.setStatusBarMessage("Moon Core: профиль «" + target + "»", 3000);
        else log("профиль по контексту «" + target + "»: " + r.error);
    }

    // ---------------- профиль проекта ----------------

    projectFolder() { return (vscode.workspace.workspaceFolders || []).find((f) => f.uri.scheme === "file") || null; }
    projectFile(folder) { return path.join(folder.uri.fsPath, ...PR.FILE.split("/")); }

    /**
     * Профиль, который просит проект (или ""). Первая встреча с файлом (или файл изменился) —
     * спрашиваем; «нет» запоминается для этого содержимого. Свой вид проекта хранится как
     * профиль «Проект <папка>» и обновляется, когда файл меняется (после согласия).
     */
    async projectTarget() {
        const folder = this.projectFolder();
        if (!folder) return "";
        // Недоверенная папка (Restricted Mode): файл из чужого репозитория даже не предлагаем —
        // вопрос «включить вид проекта?» там сам по себе приманка. Доверие дадут — спросим.
        if (vscode.workspace.isTrusted === false) return "";
        let text;
        try {
            const f = this.projectFile(folder);
            if (fs.statSync(f).size > PR.MAX_FILE) { log("профиль проекта: файл больше " + (PR.MAX_FILE >> 10) + " КБ"); return ""; }
            text = fs.readFileSync(f, "utf8");
        } catch (e) { return ""; }
        const parsed = PR.parse(text);
        if (!parsed.ok) {
            if (this.projectErr !== parsed.sha + parsed.error) { this.projectErr = parsed.sha + parsed.error; log("профиль проекта " + PR.FILE + ": " + parsed.error); }
            return "";
        }
        const key = folder.uri.fsPath.toLowerCase();
        const map = Object.assign({}, this.context.globalState.get(PROJECT_KEY) || {});
        let rec = map[key];
        if (!rec || rec.sha !== parsed.sha) {
            if (this.projectAsking) return "";
            this.projectAsking = true;
            let pick;
            try {
                pick = await vscode.window.showInformationMessage(
                    "Moon Core: проект «" + folder.name + "» предлагает свой вид интерфейса (" + PR.describe(parsed) + ")" +
                    (parsed.note ? ": " + parsed.note : "") + ". Включать его в этом проекте?",
                    "Включать", "Посмотреть файл", "Нет");
            } finally { this.projectAsking = false; }
            if (pick === "Посмотреть файл") { await vscode.window.showTextDocument(vscode.Uri.file(this.projectFile(folder))); return ""; }
            if (!pick) return "";                               // закрыли — спросим в следующий раз
            rec = map[key] = { sha: parsed.sha, ok: pick === "Включать", at: Date.now() };
            await this.context.globalState.update(PROJECT_KEY, capProjects(map));
            AU.record(this.context.globalState, "project", folder.name + " (" + PR.describe(parsed) + ")", rec.ok ? "allow" : "deny").catch(() => {});
            log("профиль проекта " + folder.name + ": " + (rec.ok ? "разрешён" : "отклонён"));
        }
        if (!rec.ok) return "";
        if (parsed.use) return parsed.use;
        const name = PR.profileName(folder.name);
        const cur = this.engine.profiles.list[name];
        if (!cur || JSON.stringify({ r: cur.rules, s: cur.settings }) !== JSON.stringify({ r: parsed.profile.rules, s: parsed.profile.settings })) {
            const sum = this.engine.summary();
            const wasClean = sum.active === name && !sum.dirty;
            const r = await this.onDesign({ ops: [{ op: "putProfile", name: name, profile: parsed.profile }] });
            if (!r.ok) { log("профиль проекта: " + r.error); return ""; }
            // Профиль проекта был включён и не правился — новое содержимое файла включаем сразу.
            if (wasClean) await this.onDesign({ ops: [{ op: "applyProfile", name: name }] });
        }
        return name;
    }

    /** Команда «Сохранить вид в проект»: текущие правки -> .vscode/mooncore.json первой папки. */
    async saveProjectProfile() {
        const folder = this.projectFolder();
        if (!folder) { vscode.window.showWarningMessage("Moon Core: открой папку проекта — вид сохраняется в её .vscode/mooncore.json."); return; }
        const n = Object.keys(this.design.rules).length + Object.keys(this.design.settings).length;
        if (!n) { vscode.window.showInformationMessage("Moon Core: правок конструктора нет — сохранять нечего."); return; }
        const file = this.projectFile(folder);
        if (fs.existsSync(file)) {
            const ok = await vscode.window.showWarningMessage("Moon Core: " + PR.FILE + " уже есть в проекте «" + folder.name + "». Перезаписать текущим видом?", { modal: true }, "Перезаписать");
            if (ok !== "Перезаписать") return;
        }
        const note = await vscode.window.showInputBox({ prompt: "Короткое описание вида проекта (необязательно)", value: "", validateInput: (v) => v.length > 120 ? "до 120 символов" : null });
        if (note === undefined) return;
        const text = PR.build(this.design, note);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text, "utf8");
        // Файл создан здесь и сейчас — согласие на него уже есть.
        const map = Object.assign({}, this.context.globalState.get(PROJECT_KEY) || {});
        map[folder.uri.fsPath.toLowerCase()] = { sha: PR.sha256(text), ok: true, at: Date.now() };
        await this.context.globalState.update(PROJECT_KEY, capProjects(map));
        await this.onDesign({ ops: [{ op: "putProfile", name: PR.profileName(folder.name), profile: PR.parse(text).profile }] });
        const pick = await vscode.window.showInformationMessage("Moon Core: вид сохранён в " + PR.FILE + " (правок: " + n + "). Файл можно закоммитить — у других он включится после их согласия.", "Открыть файл");
        if (pick) await vscode.window.showTextDocument(vscode.Uri.file(file));
    }

    watchContext() {
        const subs = this.context.subscriptions;
        const bump = () => { this.scheduleAutoProfile(); this.scheduleCtx(); };
        subs.push(vscode.window.onDidChangeActiveTextEditor(bump));
        subs.push(vscode.window.onDidChangeWindowState((s) => { if (s.focused) { this.ctxForce = true; bump(); } }));
        subs.push(vscode.workspace.onDidChangeWorkspaceFolders(bump));
        if (vscode.workspace.onDidGrantWorkspaceTrust) subs.push(vscode.workspace.onDidGrantWorkspaceTrust(bump));
        if (vscode.window.onDidChangeActiveColorTheme) subs.push(vscode.window.onDidChangeActiveColorTheme(bump));
        subs.push(vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("moonCore.autoProfiles") || e.affectsConfiguration("moonCore.autoProfileDefault")) { this.armTimeTimer(); bump(); }
        }));
        try {
            const w = vscode.workspace.createFileSystemWatcher("**/" + PR.FILE);
            subs.push(w, w.onDidChange(bump), w.onDidCreate(bump), w.onDidDelete(bump));
        } catch (e) { log("профиль проекта: слежение за файлом", e); }
        try {
            const ext = vscode.extensions.getExtension("vscode.git");
            const hook = () => {
                try {
                    const api = ext.exports.getAPI(1);
                    const git = () => { bump(); if (this.gitChanged) this.gitChanged(); };
                    subs.push(api.onDidOpenRepository((repo) => subs.push(repo.state.onDidChange(git))));
                    api.repositories.forEach((repo) => subs.push(repo.state.onDidChange(git)));
                    bump();
                } catch (e) { log("профиль по контексту: git", e); }
            };
            if (ext) { if (ext.isActive) hook(); else ext.activate().then(hook, () => {}); }
        } catch (e) {}
        subs.push({ dispose: () => clearInterval(this.timeTimer) });
        this.armTimeTimer();
        bump();
    }

    /** Правила по времени суток — перепроверять раз в минуту (только пока они есть). */
    armTimeTimer() {
        clearInterval(this.timeTimer);
        this.timeTimer = null;
        if (AP.usesTime(vscode.workspace.getConfiguration("moonCore").get("autoProfiles", []))) {
            this.timeTimer = setInterval(() => this.scheduleAutoProfile(), 60000);
        }
    }
}

module.exports = { Part: ContextPart, capProjects, MAX_PROJECTS };
