// Тесты ленивой загрузки интерфейса окна: ядро (mooncore-core.js) + чанк (mooncore-ui.js).
// Окно читает чанк из «хранилища» (XHR-заглушка), сверяет SHA-256 и вычисляет прямым eval.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const RT = path.join(__dirname, "..", "..", "extension", "runtime");
const UI_CODE = fs.readFileSync(path.join(RT, "mooncore-ui.js"), "utf8");
const UI_SHA = crypto.createHash("sha256").update(UI_CODE, "utf8").digest("hex");
const TOK = "c".repeat(48);
const VF = "vscode-file://vscode-app/C:/store/";

module.exports = function (test, K) {
    const { makeWindow, baseBoot, tick, P } = K;

    /** Окно ленивой сборки с одним хостом (адрес — из файла хранилища, как в VS Code). */
    function lazyWindow(uiText, uiSha, extra) {
        const files = { [VF + "bridge.json"]: JSON.stringify({ v: P.VERSION, hosts: [{ port: 1003, token: TOK, pid: 1 }] }) };
        if (uiText != null) files[VF + "mooncore-ui-x.js"] = uiText;
        const boot = baseBoot({ testHosts: undefined, bridgeUrl: "file:///C:/store/bridge.json", ui: { url: "file:///C:/store/mooncore-ui-x.js", sha: uiSha || UI_SHA } });
        return makeWindow(boot, null, { runtime: "core", files: files, protocol: "vscode-file:", extra: extra });
    }
    const errors = (t) => t.calls.filter((c) => c.method === "log").map((c) => c.body.where + ": " + c.body.msg);
    const panel = (t) => t.body.children.find((c) => c.getAttribute("data-mooncore-ui") === "design");

    test("ленивый интерфейс: до первого открытия его нет, открытие грузит чанк, все вкладки и пипетка работают", async () => {
        const t = lazyWindow(UI_CODE);
        await tick(250);
        assert.strictEqual(t.mc.info().ui, "lazy");
        assert.ok(!panel(t), "панели нет");
        t.mc.applyState({ rev: "r1", snippets: [], design: { rules: { ".part.sidebar": { label: "Сайдбар", props: { opacity: 0.5 } } }, settings: {} } });
        t.mc.startDesign();
        assert.ok(!panel(t), "чанк читается асинхронно");
        await tick(50);
        assert.strictEqual(t.mc.info().ui, "loaded");
        const p = panel(t);
        assert.ok(p, "панель конструктора открылась");
        // Каждая вкладка рисуется кодом чанка, который берёт состояние ядра (DS, CATALOG, des...).
        const tabs = p.querySelectorAll(".mc-tab");
        assert.ok(tabs.length >= 4, "вкладки: " + tabs.length);
        for (let i = 0; i < tabs.length; i++) {
            const tab = panel(t).querySelectorAll(".mc-tab")[i];
            tab.listeners.click[0]({ preventDefault() {} });
        }
        t.mc.stopDesign();
        assert.ok(!panel(t), "закрылась");
        t.mc.startPick();
        assert.ok(t.body.children.some((c) => c.getAttribute("data-mooncore-ui") === "pick"), "пипетка из того же чанка");
        t.mc.stopPick();
        assert.deepStrictEqual(errors(t), [], "ни одной ошибки в журнал");
        assert.strictEqual(t.calls.filter((c) => c.method === "uiFailed").length, 0);
    });

    test("ленивый интерфейс: политика Trusted Types «mooncore» создаётся при старте и пропускает только сверенный чанк", async () => {
        const policies = [];
        const tt = { createPolicy: (name, rules) => { const p = { name: name, createScript: (x) => rules.createScript(x), passed: [] }; policies.push(p); return p; } };
        const t = lazyWindow(UI_CODE, null, { trustedTypes: tt });
        assert.deepStrictEqual(policies.map((p) => p.name), ["mooncore"], "создана сразу, до открытия конструктора");
        assert.throws(() => policies[0].createScript("alert(1)"), /непроверенный код/, "чужой код через политику не пройдёт");
        await tick(250);
        t.mc.startDesign();
        await tick(50);
        assert.strictEqual(t.mc.info().ui, "loaded", "сверенный чанк прошёл через политику");
        assert.throws(() => policies[0].createScript(UI_CODE), /непроверенный код/, "и после загрузки ворота снова закрыты");
        t.mc.stopDesign();
    });

    test("ленивый интерфейс: чужой файл (SHA не совпал) не выполняется — хост узнаёт, окно просит перезагрузку", async () => {
        const evil = "window.__EVIL__ = 1; ({ startDesign: function () {} });";
        const t = lazyWindow(evil);
        t.handlers["1003"] = (m) => (m === "uiFailed" ? { ok: true, again: false } : { ok: true });
        await tick(250);
        t.mc.startDesign();
        await tick(50);
        assert.strictEqual(t.w.__EVIL__, undefined, "код не выполнен");
        const f = t.calls.filter((c) => c.method === "uiFailed");
        assert.deepStrictEqual(f.map((c) => [c.body.reason, c.body.sha]), [["sha", UI_SHA]]);
        assert.strictEqual(t.mc.info().ui, "lazy");
        assert.ok(t.body.children.some((c) => /перезагрузи окно/.test(c.textContent)), "подсказка в окне");
    });

    test("ленивый интерфейс: файла нет — хост пишет его и отвечает again, окно загружает со второй попытки", async () => {
        const t = lazyWindow(null);
        t.handlers["1003"] = (m) => {
            if (m !== "uiFailed") return { ok: true };
            t.files[VF + "mooncore-ui-x.js"] = UI_CODE;          // хост переписал файл
            return { ok: true, again: true };
        };
        await tick(250);
        t.mc.startDesign();
        await tick(80);
        assert.strictEqual(t.calls.filter((c) => c.method === "uiFailed").length, 1);
        assert.strictEqual(t.mc.info().ui, "loaded");
        assert.ok(panel(t), "открытие, запрошенное до загрузки, выполнено после неё");
        t.mc.stopDesign();
    });

    test("ленивый интерфейс: пока конструктор закрыт, ядро не зовёт чанк (правки применяются стилем ядра)", async () => {
        const t = lazyWindow(UI_CODE);
        await tick(250);
        t.mc.applyState({ rev: "r2", snippets: [], design: { rules: { ".part.statusbar": { label: "С", props: { hide: true } } }, settings: {} } });
        const des = t.styles().find((s) => s.getAttribute("data-mooncore") === "~design");
        assert.ok(des && /display: none !important/.test(des.textContent));
        t.mc.stopDesign(); t.mc.stopPick();                    // заглушки без загруженного чанка — тишина
        assert.strictEqual(t.mc.info().ui, "lazy");
        assert.deepStrictEqual(errors(t), []);
    });
};
