// ============================================================
//  Прогон Moon Core в настоящем VS Code (без зависимостей).
//
//  node test/e2e/run.js            — скачать VS Code stable (один раз, в .vscode-test/) и прогнать
//  MOONCORE_E2E_VSCODE=<путь к Code.exe / code>  — взять уже распакованную копию
//
//  Всё происходит в отдельной копии VS Code со своими user-data и extensions: твой VS Code и его
//  оболочка не трогаются. Три запуска (фазы из test/e2e/suite.js):
//    inject -> window -> remove. Второй запуск — это и есть «перезагрузка окна после внедрения».
//  Отчёт каждой фазы: .vscode-test/e2e-report-<фаза>.json, сводка — в консоль.
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const CACHE = path.join(ROOT, ".vscode-test");
const EXT = path.join(ROOT, "extension");
const SUITE = path.join(__dirname, "suite.js");
const MODULE = path.join(__dirname, "module");
const MODULE_LAZY = path.join(__dirname, "module-lazy");
const WORKSPACE = path.join(__dirname, "workspace");
const PHASES = ["inject", "window", "remove"];
const PHASE_TIMEOUT_MS = 180000;

// Платформа -> сборка на update.code.visualstudio.com и путь к исполняемому файлу внутри.
function target() {
    const a = process.arch === "arm64" ? "arm64" : "x64";
    if (process.platform === "win32") return { build: "win32-" + a + "-archive", exe: "Code.exe" };
    if (process.platform === "darwin") return { build: "darwin-universal", exe: "Visual Studio Code.app/Contents/MacOS/Electron" };
    return { build: "linux-" + a, exe: "VSCode-linux-" + a + "/code" };
}

function getJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { "User-Agent": "moon-core-e2e" } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); resolve(getJson(new URL(res.headers.location, url).href)); return; }
            if (res.statusCode !== 200) { res.resume(); reject(new Error(url + ": HTTP " + res.statusCode)); return; }
            let s = ""; res.setEncoding("utf8");
            res.on("data", (c) => { s += c; });
            res.on("end", () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
        }).on("error", reject);
    });
}

function download(url, file) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { "User-Agent": "moon-core-e2e" } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); resolve(download(new URL(res.headers.location, url).href, file)); return; }
            if (res.statusCode !== 200) { res.resume(); reject(new Error(url + ": HTTP " + res.statusCode)); return; }
            const total = +res.headers["content-length"] || 0;
            let got = 0, shown = -1;
            const out = fs.createWriteStream(file);
            const hash = crypto.createHash("sha256");
            res.on("data", (c) => {
                got += c.length; hash.update(c);
                const pct = total ? Math.floor(got * 100 / total) : -1;
                if (pct !== shown && pct % 10 === 0) { shown = pct; process.stdout.write("  скачано " + pct + "%\r"); }
            });
            res.pipe(out);
            out.on("finish", () => { process.stdout.write("\n"); resolve(hash.digest("hex")); });
            out.on("error", reject);
        }).on("error", reject);
    });
}

/** Путь к исполняемому файлу VS Code: из переменной или скачанная копия (кэш в .vscode-test). */
async function vscodeExe() {
    if (process.env.MOONCORE_E2E_VSCODE) return process.env.MOONCORE_E2E_VSCODE;
    const t = target();
    const info = await getJson("https://update.code.visualstudio.com/api/update/" + t.build + "/stable/latest");
    const dir = path.join(CACHE, "vscode-" + t.build + "-" + info.productVersion);
    const exe = path.join(dir, t.exe);
    if (fs.existsSync(exe)) return exe;
    fs.mkdirSync(dir, { recursive: true });
    const archive = path.join(CACHE, path.basename(new URL(info.url).pathname));
    const fileSha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
    if (!(fs.existsSync(archive) && info.sha256hash && fileSha(archive) === info.sha256hash)) {
        console.log("Скачиваю VS Code " + info.productVersion + " (" + t.build + ")...");
        const sha = await download(info.url, archive);
        if (info.sha256hash && sha !== info.sha256hash) { fs.unlinkSync(archive); throw new Error("sha256 архива не совпал с опубликованным: " + sha); }
    }
    console.log("Распаковываю...");
    // На Windows — системный tar (bsdtar, умеет zip); tar из Git Bash принимает «D:» за имя хоста.
    const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
    const r = spawnSync(tar, ["-xf", archive, "-C", dir], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("tar не распаковал " + archive);
    fs.unlinkSync(archive);
    if (!fs.existsSync(exe)) throw new Error("после распаковки нет " + exe);
    return exe;
}

function writeSettings(userData) {
    const dir = path.join(userData, "User");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
        "moonCore.modules": [MODULE, MODULE_LAZY],
        "moonCore.autoReinject": false,
        // Фазы внедряют сами через _test: самовнедрение при первом запуске им только мешает.
        "moonCore.autoInject": false,
        // Глубокая интеграция: крючок сервисов окна в бандле и главный процесс (вид окна).
        "moonCore.deepHooks": true,
        "moonCore.mainProcess": true,
        // Стили внутри webview: сниппет webview*.css кладёт сама фаза (test/e2e/webview-steps.js).
        "moonCore.webviewStyles": true,
        "moonCore.window": { opacity: 0.95, alwaysOnTop: false, material: "none" },
        "workbench.startupEditor": "none",
        "window.restoreWindows": "none",
        "update.mode": "none",
        "extensions.autoCheckUpdates": false,
        "extensions.autoUpdate": false,
        "telemetry.telemetryLevel": "off",
        "security.workspace.trust.enabled": false,
        "workbench.tips.enabled": false,
    }, null, 2), "utf8");
}

function runPhase(exe, phase, userData, extDir) {
    return new Promise((resolve) => {
        const args = [
            WORKSPACE,
            "--extensionDevelopmentPath=" + EXT,
            "--extensionTestsPath=" + SUITE,
            "--user-data-dir=" + userData,
            "--extensions-dir=" + extDir,
            "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", "--new-window",
        ];
        const env = Object.assign({}, process.env, { MOONCORE_E2E_PHASE: phase, MOONCORE_E2E_OUT: CACHE, MOONCORE_LOG_FILE: path.join(CACHE, "e2e-log-" + phase + ".txt") });
        delete env.ELECTRON_RUN_AS_NODE;
        delete env.VSCODE_IPC_HOOK_CLI;                    // запуск из терминала VS Code: иначе уйдёт в уже открытый VS Code
        const p = spawn(exe, args, { env: env, stdio: ["ignore", "pipe", "pipe"] });
        let tail = "";
        const keep = (b) => { tail = (tail + b.toString()).slice(-6000); if (process.env.MOONCORE_E2E_VERBOSE) process.stdout.write(b); };
        p.stdout.on("data", keep); p.stderr.on("data", keep);
        const timer = setTimeout(() => { tail += "\n[таймаут фазы]"; try { p.kill(); } catch (e) {} }, PHASE_TIMEOUT_MS);
        p.on("close", (code) => { clearTimeout(timer); resolve({ code: code, tail: tail }); });
    });
}

(async () => {
    fs.mkdirSync(CACHE, { recursive: true });
    const exe = await vscodeExe();
    // Каждый прогон — с чистого профиля: согласия и globalState прошлого раза не мешают. Папка —
    // новая (старую может ещё держать антивирус или индексатор); прошлые убираются по возможности.
    fs.readdirSync(CACHE).filter((d) => /^user-data/.test(d)).forEach((d) => { try { fs.rmSync(path.join(CACHE, d), { recursive: true, force: true }); } catch (e) {} });
    const userData = path.join(CACHE, "user-data-" + Date.now().toString(36)), extDir = path.join(CACHE, "extensions");
    writeSettings(userData);
    fs.mkdirSync(extDir, { recursive: true });
    console.log("VS Code: " + exe);
    let bad = 0;
    for (const phase of PHASES) {
        const rep = path.join(CACHE, "e2e-report-" + phase + ".json");
        try { fs.unlinkSync(rep); } catch (e) {}
        try { fs.unlinkSync(path.join(CACHE, "e2e-log-" + phase + ".txt")); } catch (e) {}
        const r = await runPhase(exe, phase, userData, extDir);
        let report = null;
        try { report = JSON.parse(fs.readFileSync(rep, "utf8")); } catch (e) {}
        console.log("\n== фаза " + phase + (report ? " (VS Code " + report.vscode + ")" : "") + ": код выхода " + r.code);
        if (!report) { bad++; console.log("  отчёта нет — вывод VS Code:\n" + r.tail); break; }
        report.steps.forEach((s) => {
            console.log("  " + (s.ok ? "ok  " : "FAIL") + " " + s.name + (s.ok || s.info == null ? "" : "\n       " + JSON.stringify(s.info).slice(0, 600)));
            if (!s.ok) bad++;
        });
        (report.catalog || []).forEach((l) => console.log("       " + l));
        (report.catalogHeals || []).forEach((h) => console.log("       обновить каталог: " + h.label + " (" + h.id + "): " + h.from + " -> " + h.to));
        if (r.code !== 0 && !report.steps.some((s) => !s.ok)) { bad++; console.log("  VS Code вышел с кодом " + r.code + ":\n" + r.tail); }
        if (report.steps.some((s) => !s.ok) && phase === "inject") break;   // без внедрения дальше нечего проверять
    }
    console.log("\ne2e: " + (bad ? "есть провалы (" + bad + ")" : "всё прошло"));
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("e2e: " + (e && e.stack || e)); process.exit(1); });
