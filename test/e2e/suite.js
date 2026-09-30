// ============================================================
//  Прогон Moon Core в настоящем VS Code — часть, которая исполняется ВНУТРИ VS Code
//  (--extensionTestsPath). Запускает её test/e2e/run.js три раза, фаза — в MOONCORE_E2E_PHASE:
//    inject — разрешить модуль-зонд и внедрить Moon Core в оболочку этой копии VS Code;
//    window — окно загрузилось уже с рантаймом: мост, модуль, конструктор, проверка селекторов;
//    remove — снять всё и убедиться, что оболочка и product.json вернулись к исходным.
//  Итог каждой фазы — JSON-отчёт рядом (e2e-report-<фаза>.json), его печатает run.js.
// ============================================================
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const PHASE = process.env.MOONCORE_E2E_PHASE || "";
const OUT = process.env.MOONCORE_E2E_OUT || "";
const MOD = "e2e-probe";
const LAZY = "e2e-lazy";

const WVS = require("./webview-steps");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, every) {
    const until = Date.now() + ms;
    for (;;) {
        let v;
        try { v = await fn(); } catch (e) { v = null; }
        if (v) return v;
        if (Date.now() > until) return null;
        await sleep(every || 250);
    }
}

exports.run = async function () {
    const report = { phase: PHASE, vscode: vscode.version, steps: [], at: new Date().toISOString() };
    let failed = false;
    const step = (name, ok, info) => {
        report.steps.push({ name: name, ok: !!ok, info: info === undefined ? null : info });
        if (!ok) failed = true;
        return !!ok;
    };
    // Ранний выход из main (return) не должен проглотить провал: итог решает флаг failed.
    const main = async () => {
        const ext = vscode.extensions.getExtension("moonlivedt.moon-core");
        if (!step("расширение найдено", !!ext)) return;
        const api = await ext.activate();
        const T = api && api._test;
        if (!step("активация (API для тестов)", !!(T && api.apiVersion === 1))) return;
        const { host, context, inject, moduleHost } = T;
        // Согласие на модуль-зонд — в каждой фазе: globalState тестовой копии VS Code не успевает
        // лечь на диск, когда VS Code закрывается сразу после прогона.
        const m = moduleHost.discover().find((x) => x.id === MOD);
        if (!step("модуль-зонд найден по настройке moonCore.modules", !!m)) return;
        const lz = moduleHost.discover().find((x) => x.id === LAZY);
        step("ленивый модуль-зонд найден, права и команда из манифеста", !!lz && lz.lazy && lz.caps.length === 2 && lz.commands.length === 1, lz && { lazy: lz.lazy, caps: lz.caps });
        await context.globalState.update("mooncore.modules.allowed", Object.assign({ [m.id]: m.source }, lz ? { [lz.id]: lz.source } : {}));
        if (lz) await moduleHost.approveCaps(context, lz, lz.caps);
        host.modules.setModules(moduleHost.allowed(context));

        if (PHASE === "inject") {
            WVS.prepare(host);
            const r = inject.inject(context);
            step("внедрение", r.ok, { done: r.done, reason: r.reason || null, error: r.error || null });
            const st = inject.status(context);
            step("блок в оболочке, рантайм актуален", st.length > 0 && st.every((s) => s.injected && s.current), st.map((s) => ({ file: path.basename(s.file), injected: s.injected, current: s.current })));
            step("модуль в блоке", st.every((s) => (s.modules || []).indexOf(MOD) !== -1));
            step("хэш в product.json пересчитан (нет «повреждена»)", st.every((s) => s.checksum === true), st.map((s) => s.checksum));
            step("файл модуля рядом с оболочкой", st.every((s) => fs.existsSync(path.join(path.dirname(s.file), "mooncore-mod-" + MOD + ".js"))));
            step("ленивый модуль: файл есть, а <script> на старте нет", st.every((s) => {
                const html = fs.readFileSync(s.file, "utf8");
                return fs.existsSync(path.join(path.dirname(s.file), "mooncore-mod-" + LAZY + ".js")) && html.indexOf('src="mooncore-mod-' + LAZY + '.js"') === -1 && (s.modules || []).indexOf(LAZY) !== -1;
            }));
            step("бэкап чистой оболочки", st.every((s) => fs.existsSync(s.file + ".mooncore-backup")));
            step("интерфейс окна — отдельным файлом в хранилище", inject.lazyUi(context) && fs.existsSync(path.join(context.globalStorageUri.fsPath, inject.uiChunk(context).name)));
            // Глубокая интеграция.
            const d = inject.deepState();
            step("сервисы окна: крючок в бандле", !!d && d.di === true, d);
            step("главный процесс: импорт в main.js и скрипт рядом", !!d && d.main === true);
            const df = inject.deepFiles();
            const W = require(path.join(ext.extensionPath, "lib", "wb-patch"));
            const prodText = fs.readFileSync(path.join(vscode.env.appRoot, "product.json"), "utf8");
            const key = W.checksumKey(df.out, df.bundle);
            step("хэш бандла в product.json пересчитан", W.checksumMatches(prodText, key, W.productChecksum(fs.readFileSync(df.bundle))) === true);
            step("бэкап бандла и main.js", fs.existsSync(df.bundle + ".mooncore-backup") && fs.existsSync(df.main + ".mooncore-backup"));
            WVS.afterInject(step, ext, inject, context);
        }

        if (PHASE === "window") {
            const files = await vscode.workspace.findFiles("sample.js", null, 1);
            if (files[0]) await vscode.window.showTextDocument(files[0]);
            const st = inject.status(context);
            step("оболочка внедрена (с прошлой фазы)", st.length > 0 && st.every((s) => s.injected));
            const streams = await waitFor(() => host.bridge.status().streams, 60000, 500);
            step("окно подключилось к мосту", streams > 0, { streams: streams, port: host.bridge.status().port });
            const data = await waitFor(() => { const d = host.modules.readData(MOD); return d && d.workbench ? d : null; }, 30000, 500);
            step("модуль выполнился в окне и видит воркбенч", !!data, data);
            const tm = await waitFor(() => host.lastTiming, 20000, 500);
            step("время запуска пришло, модуль не упал", !!tm && !(tm.failed || []).length && typeof tm.modules[MOD] === "number", tm);

            // Конструктор: правка -> CSS в окне. Окно отвечает зондом, что видит.
            const r = await host.onDesign({ ops: [{ op: "set", selector: ".part.statusbar", prop: "opacity", value: 0.5, label: "e2e" }] });
            step("правка конструктора записана", r.ok, r.error || null);
            await sleep(500);
            host.modules.api(MOD).publish("probe", { id: 1, selector: ".part.statusbar" });
            const probe = await waitFor(() => { const d = host.modules.readData(MOD); return d && d.probe && d.probe.id === 1 ? d.probe : null; }, 15000, 300);
            step("правка видна в настоящем окне (opacity статусбара 0.5)", !!probe && probe.found && probe.opacity === "0.5", probe);

            // Цвет темы, своя кнопка, контекст окна, шлюз к API VS Code.
            const rc = await host.onDesign({ ops: [
                { op: "color", key: "wb:statusBar.background", value: "#123456", label: "e2e" },
                { op: "button", button: { id: "be2e1", zone: "statusbar-right", command: "workbench.action.files.saveAll", icon: "beaker", label: "e2e", tooltip: "e2e" } },
            ] });
            step("цвет темы и кнопка записаны", rc.ok, rc.error || null);
            const cc = vscode.workspace.getConfiguration().inspect("workbench.colorCustomizations");
            step("цвет лёг в workbench.colorCustomizations", !!(cc && cc.globalValue && cc.globalValue["statusBar.background"] === "#123456"), cc && cc.globalValue);
            await sleep(1500);
            host.modules.api(MOD).publish("probe", { id: 2, selector: ".part.statusbar" });
            const p2 = await waitFor(() => { const d = host.modules.readData(MOD); return d && d.probe && d.probe.id === 2 ? d : null; }, 15000, 300);
            step("VS Code перекрасил статусбар (тема)", !!p2 && p2.probe.bg === "rgb(18, 52, 86)", p2 && p2.probe);
            step("своя кнопка в статусбаре", !!p2 && p2.probe.button === true);
            step("контекст окна: язык sample.js", !!p2 && p2.probe.lang === "javascript", p2 && p2.probe.lang);
            step("шлюз: элемент статусбара VS Code от модуля", !!p2 && p2.native === true && !!(host.nativeItems && host.nativeItems.has(MOD + "/probe")));
            step("сервисы окна: модуль получил statusbarService", !!p2 && p2.probe.svc === true, p2 && { svc: p2.probe.svc, names: p2.probe.svcCount });
            // Ленивый модуль: команда из палитры/меню грузит его файл (script src + integrity) и доходит до него.
            step("ленивый модуль до команды не загружен", !host.modules.readData(LAZY));
            const ed = vscode.window.activeTextEditor;
            if (ed) ed.selection = new vscode.Selection(1, 2, 1, 2);   // на слове «function»
            await host.invokeModuleCommand(LAZY, "ping");
            const lzd = await waitFor(() => { const d = host.modules.readData(LAZY); return d && d.ping && d.decorate !== undefined ? d : null; }, 20000, 300);
            let lzInfo = lzd;
            if (!lzd) {
                host.modules.api(MOD).publish("probeState", { id: 5, mod: LAZY, load: true });
                lzInfo = await waitFor(() => { const d = host.modules.readData(MOD); return d && d.modState && d.modState.id === 5 ? d.modState : null; }, 15000, 300);
                lzInfo = { probe: lzInfo, after: host.modules.readData(LAZY), bridge: host.bridge.status() };
            }
            step("ленивый модуль загрузился по команде и получил слово под курсором", !!lzd && !!lzd.ping.word && lzd.ping.lang === "javascript" && lzd.symbol === lzd.ping.word, lzInfo);
            step("подсветка кода от модуля (право decorations)", !!lzd && lzd.decorate === true);
            const ev = await waitFor(() => { const d = host.modules.readData(LAZY); return d && d.editor && d.editor.lang ? d.editor : null; }, 15000, 300);
            step("события VS Code: модуль знает активный файл", !!ev && ev.lang === "javascript" && ev.file === "sample.js" && !!ev.path, ev);
            step("команды модулей: ключ контекста для меню", (host.moduleCommands() || []).some((c) => c.mod === LAZY && c.id === "ping"));
            // Выключение без перезагрузки: хост сообщает новый список, окно убирает модуль.
            host.modules.setModules(moduleHost.allowed(context).filter((x) => x.id !== LAZY));
            host.broadcastModuleSet();
            host.modules.api(MOD).publish("probeState", { id: 4, mod: LAZY });
            const ps = await waitFor(() => { const d = host.modules.readData(MOD); return d && d.modState && d.modState.id === 4 ? d.modState : null; }, 15000, 300);
            step("модуль выключен в окне без перезагрузки", !!ps && ps.state && ps.state.off === true, ps);
            host.modules.setModules(moduleHost.allowed(context));
            host.broadcastModuleSet();
            // Ленивый интерфейс: окно грузит конструктор при первом открытии (чанк из хранилища, прямой eval).
            host.modules.api(MOD).publish("probeUi", { id: 3 });
            const pu = await waitFor(() => { const d = host.modules.readData(MOD); return d && d.ui && d.ui.id === 3 && d.ui.after ? d.ui : null; }, 15000, 300);
            step("конструктор: до открытия не загружен, открытие грузит его лениво", !!pu && pu.before === "lazy" && pu.after === "loaded" && pu.panel && pu.closed, pu);
            // Главный процесс пишет файл статуса рядом с настройками окна.
            const ms = await waitFor(() => { try { return JSON.parse(fs.readFileSync(path.join(context.globalStorageUri.fsPath, "mooncore-main-status.json"), "utf8")); } catch (e) { return null; } }, 15000, 500);
            step("главный процесс: скрипт работает и применил вид окна", !!ms && ms.ok && ms.windows >= 1 && ms.conf && ms.conf.opacity === 0.95, ms);

            // Проверка селекторов в настоящей вёрстке: что из каталога находится.
            // Отпечатки каталога: из прошлого прогона (test/e2e/catalog-prints.json) — чтобы для пропавших
            // элементов предложить новый селектор; свежие — обратно в файл для следующей версии VS Code.
            const printsFile = path.join(__dirname, "catalog-prints.json");
            let prints = {};
            try { prints = JSON.parse(fs.readFileSync(printsFile, "utf8")).prints || {}; } catch (e) {}
            const s = await host.runCheck({ prints: prints });
            step("проверка селекторов ответила", !!s, s ? { user: s.user, catalog: s.catalog } : null);
            if (s) {
                const merged = Object.assign({}, prints, s.catalogPrints);
                fs.writeFileSync(printsFile, JSON.stringify({ vscode: vscode.version, at: new Date().toISOString().slice(0, 10), prints: merged }, null, 2) + "\n", "utf8");
                step("отпечатки каталога сняты", Object.keys(s.catalogPrints).length > 10, { count: Object.keys(s.catalogPrints).length });
                report.catalogHeals = s.catalogHeals;
            }
            if (s) {
                report.catalog = s.lines.filter((l) => /^\s{4}/.test(l) || /Каталог/.test(l));
                step("каталог находит элементы в этой версии VS Code", s.catalog.total > 0 && s.catalog.dead < s.catalog.total / 2, s.catalog);
            }
            // Самолечение в настоящей вёрстке: правило «после переименования» ничего не находит,
            // а по отпечатку (запасной селектор и aria-label статусбара) окно находит элемент.
            await host.onDesign({ ops: [{ op: "set", selector: ".mooncore-e2e-renamed", prop: "opacity", value: 0.9, label: "e2e-heal",
                fp: { tag: "div", one: true, alts: ["#workbench\\.parts\\.statusbar"] } }] });
            const s2 = await host.runCheck();
            const heal = s2 && s2.heals.find((h) => h.from === ".mooncore-e2e-renamed");
            step("самолечение: замена найдена по отпечатку", !!heal && heal.how === "alt", heal || (s2 && s2.heals));
            if (heal) {
                await host.onDesign({ ops: [{ op: "renameRule", from: heal.from, to: heal.to }] });
                step("самолечение: правило переехало", !host.design.rules[".mooncore-e2e-renamed"] && !!host.design.rules[heal.to]);
            }

            // Доктор: снимок состояния собирается на настоящем окне, поломок нет.
            try {
                await vscode.commands.executeCommand("moonCore.doctor");
                const doc = require(path.join(ext.extensionPath, "lib", "doctor"));
                const DM = require(path.join(ext.extensionPath, "lib", "doctor-model"));
                const snap = doc.snapshot(context, host, s2);
                const list = DM.problems(snap);
                step("доктор: страница открылась, поломок нет", DM.verdict(list) !== "error", list.map((p) => p.level + ": " + p.title));
            } catch (e) { step("доктор", false, String(e && e.stack || e)); }
            try { await WVS.inWindow(step); } catch (e) { step("webview", false, String(e && e.stack || e)); }

            await host.onDesign({ ops: [{ op: "clearAll" }] });
            step("правки сброшены", !Object.keys(host.design.rules).length && !host.design.buttons.length);
            const cc2 = vscode.workspace.getConfiguration().inspect("workbench.colorCustomizations");
            step("цвет темы вернулся (настройка снята)", !(cc2 && cc2.globalValue && cc2.globalValue["statusBar.background"]), cc2 && cc2.globalValue);
        }

        if (PHASE === "remove") {
            const before = inject.status(context);
            const df = inject.deepFiles();
            const bundleBak = fs.existsSync(df.bundle + ".mooncore-backup") ? fs.readFileSync(df.bundle + ".mooncore-backup", "utf8") : null;
            const mainBak = fs.existsSync(df.main + ".mooncore-backup") ? fs.readFileSync(df.main + ".mooncore-backup", "utf8") : null;
            const wvBak = WVS.beforeRemove(inject);
            const r = inject.remove();
            step("снятие", r.ok, { done: r.done, error: r.error || null });
            const st = inject.status(context);
            step("блока в оболочке нет", st.every((s) => !s.injected));
            before.forEach((s) => {
                const bak = s.file + ".mooncore-backup";
                if (fs.existsSync(bak)) step("оболочка совпадает с исходной: " + path.basename(s.file), fs.readFileSync(s.file, "utf8") === fs.readFileSync(bak, "utf8"));
                step("файлы модулей убраны", !fs.readdirSync(path.dirname(s.file)).some((f) => /^mooncore-mod-/.test(f)));
            });
            const prod = path.join(vscode.env.appRoot, "product.json");
            if (fs.existsSync(prod + ".mooncore-backup")) {
                const a = JSON.parse(fs.readFileSync(prod, "utf8")).checksums || {}, b = JSON.parse(fs.readFileSync(prod + ".mooncore-backup", "utf8")).checksums || {};
                step("хэши в product.json исходные", JSON.stringify(a) === JSON.stringify(b));
            }
            step("хэш сходится (VS Code не скажет «повреждена»)", st.every((s) => s.checksum !== false), st.map((s) => s.checksum));
            step("бандл воркбенча совпадает с исходным", bundleBak != null && fs.readFileSync(df.bundle, "utf8") === bundleBak);
            WVS.afterRemove(step, ext, inject, wvBak);
            step("main.js совпадает с исходным, скрипта нет", mainBak != null && fs.readFileSync(df.main, "utf8") === mainBak && !fs.existsSync(df.mjs));
        }
    };
    try {
        await main();
    } catch (e) {
        step("исключение", false, String(e && e.stack || e));
    } finally {
        if (OUT) fs.writeFileSync(path.join(OUT, "e2e-report-" + PHASE + ".json"), JSON.stringify(report, null, 2), "utf8");
    }
    if (failed) throw new Error("e2e " + PHASE + ": есть проваленные шаги");
};
