// Тесты рантайма: этапы и бюджет времени старта, повтор горячей перезагрузки модуля.
"use strict";

const assert = require("assert");

// Бюджет старта рантайма в заглушке окна (мс). С запасом: ловит регресс «на порядок», а не шум.
const START_BUDGET_MS = 250;

module.exports = function (test, h) {
    const { makeWindow, baseBoot, tick } = h;

    test("старт: этапы (state, load) уходят хосту вместе со временем; рантайм укладывается в бюджет", async () => {
        const t = makeWindow(baseBoot(), {});
        t.fireWindow("load");
        await tick(4300);
        const c = t.calls.find((x) => x.method === "timing");
        assert.ok(c, "timing отправлен");
        const st = c.body.stages || {};
        assert.ok(typeof st.state === "number" && typeof st.load === "number", JSON.stringify(st));
        assert.ok(st.state <= st.load, "состояние читается раньше загрузки окна");
        assert.ok(c.body.runtime < START_BUDGET_MS, "рантайм стартовал за " + c.body.runtime + " мс (бюджет " + START_BUDGET_MS + ")");
    });

    test("режим разработки модуля: хост не отдал код — следующее событие с тем же sha пробует снова", async () => {
        const t = makeWindow(baseBoot());
        await tick(5);
        const m = t.mc.module("mlbg");
        let give = false;
        t.handlers["1001"] = (method) => (method === "moduleCode" ? (give ? { ok: true, code: "window.__hot2 = 1" } : { ok: false, error: "занят" }) : { ok: true });
        const sha = "d".repeat(64);
        t.es(1001).emit("moduleReload", { id: "mlbg", sha: sha });
        await tick(10);
        assert.strictEqual(m.hot, 0, "первый раз кода нет — модуль не перезапущен");
        give = true;
        t.es(1001).emit("moduleReload", { id: "mlbg", sha: sha });
        await tick(10);
        assert.strictEqual(t.calls.filter((c) => c.method === "moduleCode").length, 2, "вторая попытка с тем же sha");
        assert.strictEqual(m.hot, 1);
    });
};
