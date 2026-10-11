// Тесты рантайма: «Скорость VS Code» в окне — метки старта, подвисания, пульс; таймеры в
// скрытом окне и быстрое первое подключение к мосту.
"use strict";

const assert = require("assert");

/** performance окна с метками VS Code и памятью; PerformanceObserver, которому можно подать задачи. */
function perfExtra() {
    const t0 = Date.now();
    const obs = { cb: null, opts: null };
    const marks = [
        { name: "code/timeOrigin", startTime: 0 },
        { name: "code/willStartWorkbench", startTime: 900 },
    ].concat(Array.from({ length: 150 }, (_, i) => ({ name: "code/chat/step" + i, startTime: 1000 + i }))).concat([
        // Вложенных меток (чат, агенты) в VS Code 1.140 больше лимита: ключевые после них не должны теряться.
        { name: "code/didStartWorkbench", startTime: 1500 },
        { name: "code/didStartWorkbench", startTime: 9999 },          // повтор — берётся первое значение
        { name: "chrome-internal", startTime: 5 },                    // чужие метки не нужны хосту
        { name: "code/willLoadExtensions", startTime: 1600 },
        { name: "code/didLoadExtensions", startTime: 3100.6 },
    ]);
    return {
        obs: obs,
        extra: {
            performance: {
                now: () => Date.now() - t0, mark() {},
                getEntriesByType: (type) => (type === "mark" ? marks : []),
                memory: { usedJSHeapSize: 300 * 1048576 },
            },
            PerformanceObserver: function (cb) { obs.cb = cb; this.observe = (o) => { obs.opts = o; }; },
        },
    };
}

module.exports = function (test, h) {
    const { makeWindow, baseBoot, tick } = h;

    test("скорость: метки VS Code (этапы code/willX|didX и mooncore:*, первое значение, вложенные не теряют ключевые), подвисания от 200 мс, память", async () => {
        const p = perfExtra();
        const t = makeWindow(baseBoot(), {}, { extra: p.extra });
        assert.strictEqual(JSON.stringify(p.obs.opts), JSON.stringify({ type: "longtask", buffered: true }), "подписка на долгие задачи с буфером старта");
        p.obs.cb({ getEntries: () => [{ duration: 250 }, { duration: 60 }, { duration: 1200.4 }] });
        const r = t.mc._perf();
        assert.strictEqual(r.marks["code/didStartWorkbench"], 1500);
        assert.strictEqual(r.marks["code/didLoadExtensions"], 3101);
        assert.ok(!("chrome-internal" in r.marks));
        assert.ok(!Object.keys(r.marks).some((k) => k.indexOf("code/chat/") === 0), "вложенные метки не шлются");
        assert.strictEqual(r.info.freezes, 2, "задача 60 мс — не подвисание");
        assert.strictEqual(r.info.freezeMax, 1200);
        assert.strictEqual(r.info.freezeMs, 1450);
        assert.strictEqual(r.info.heapMb, 300);
    });

    test("скорость: время запуска уходит с id окна, метками и сводкой; пульс несёт сводку подвисаний", async () => {
        const p = perfExtra();
        const t = makeWindow(baseBoot(), {}, { extra: p.extra });
        await tick(5);
        const hello = t.calls.find((c) => c.method === "hello");
        assert.ok(hello && hello.body.perf && typeof hello.body.perf.freezes === "number", "пульс со сводкой");
        t.fireWindow("load");
        await tick(4300);
        const c = t.calls.find((x) => x.method === "timing");
        assert.ok(c, "timing отправлен");
        assert.ok(/^[0-9a-f]{16}$/.test(c.body.win), "id окна");
        assert.strictEqual(c.body.vs["code/didLoadExtensions"], 3101);
        assert.strictEqual(c.body.final, false, "первая отправка — не полная");
        assert.strictEqual(c.body.perf.heapMb, 300);
    });

    test("мост: пока хостов нет — адреса читаются часто с нарастающей паузой; скрытое окно с хостом — реже", async () => {
        const t = makeWindow(baseBoot({ testHosts: [] }));
        const d = [t.mc._hostDelay(), t.mc._hostDelay(), t.mc._hostDelay()];
        assert.ok(d[0] < 1000 && d[0] < d[1] && d[1] < d[2], "нарастает: " + d.join(", "));
        for (let i = 0; i < 30; i++) t.mc._hostDelay();
        assert.strictEqual(t.mc._hostDelay(), 5000, "не реже раза в 5 с");

        const u = makeWindow(baseBoot());
        await tick(5);
        assert.strictEqual(u.mc._hostDelay(), 5000, "хост на связи, окно видно — раз в 5 с");
        u.w.document.hidden = true;
        assert.strictEqual(u.mc._hostDelay(), 15000, "окно скрыто — раз в 15 с");
        u.w.document.hidden = false;
        u.mc._onVisible();                                    // показ окна: догоняет без исключений
        assert.strictEqual(u.mc._hostDelay(), 5000);
    });
};
