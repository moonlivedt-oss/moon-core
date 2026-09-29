// Смоук-тесты Moon Core: запись с правами администратора без PowerShell.
// На ПК, где политика запрещает запуск PowerShell, spawn бросал EPERM синхронно, и VS Code
// показывал «A system error occurred (spawn EPERM)» ещё до окна UAC.
"use strict";
const { test, assert, fs, path, EXT, TMP } = require("./harness");
const cp = require("child_process");

const E = require(path.join(EXT, "lib", "elevate"));
const EL = require(path.join(EXT, "lib", "inject", "elevated"));

/** Выполнить задание так, как это сделал бы повышенный run.cmd: Node + загрузчик из командной строки. */
function runJob(job) {
    const text = fs.readFileSync(job.cmd, "utf8");
    const m = text.match(/-e "([^"]+)" "%~dp0apply\.js" ([0-9a-f]{64}) "%~dp0job\.json" ([0-9a-f]{64})/);
    assert.ok(m, "в run.cmd загрузчик и оба хэша");
    return cp.spawnSync(process.execPath, ["-e", m[1], path.join(job.dir, "apply.js"), m[2], path.join(job.dir, "job.json"), m[3]]).status;
}
function targets(name) {
    const dir = path.join(TMP, "Пользователь " + name, "Program Files");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "workbench.html"), "OLD");
    fs.writeFileSync(path.join(dir, "mooncore-mod-x.js"), "x");
    return dir;
}
const plan = (dir) => [
    { file: path.join(dir, "workbench.html"), data: "НОВОЕ" },
    { file: path.join(dir, "mooncore-mod-y.js"), data: "y" },
    { file: path.join(dir, "mooncore-mod-x.js"), remove: true },
];

test("задание: пишет всё и удаляет лишнее; в run.cmd нет кириллицы путей", () => {
    const dir = targets("ok");
    const job = E.prepareJob(plan(dir), path.join(TMP, "Пользователь ok", "globalStorage"), "C:\\Program Files\\Microsoft VS Code\\Code.exe");
    assert.ok(!/Пользователь/.test(fs.readFileSync(job.cmd, "utf8")), "пути задания — через %~dp0");
    assert.strictEqual(runJob(job), 0);
    assert.deepStrictEqual(E.readResult(job).ok, true);
    assert.strictEqual(fs.readFileSync(path.join(dir, "workbench.html"), "utf8"), "НОВОЕ");
    assert.ok(fs.existsSync(path.join(dir, "mooncore-mod-y.js")) && !fs.existsSync(path.join(dir, "mooncore-mod-x.js")));
    if (process.platform === "win32") {
        // Настоящий run.cmd (cmd.exe, chcp 65001, %~dp0 в папке с кириллицей); вместо VS Code — Node.
        const dir2 = targets("cmd");
        const job2 = E.prepareJob(plan(dir2), path.join(TMP, "Пользователь cmd", "globalStorage"), process.execPath);
        assert.strictEqual(cp.spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", job2.cmd, "auto"]).status, 0);
        assert.strictEqual(fs.readFileSync(path.join(dir2, "workbench.html"), "utf8"), "НОВОЕ");
    }
});

test("задание: подменённые данные или код — не пишется ничего", () => {
    const dir = targets("tamper");
    const base = path.join(TMP, "Пользователь tamper", "globalStorage");
    const j1 = E.prepareJob(plan(dir), base, "Code.exe");
    fs.writeFileSync(path.join(j1.dir, "f1"), "чужое");
    assert.strictEqual(runJob(j1), 1);
    assert.strictEqual(E.readResult(j1).ok, false);
    assert.strictEqual(fs.readFileSync(path.join(dir, "workbench.html"), "utf8"), "OLD", "до записи сверяется всё");
    assert.ok(fs.existsSync(path.join(dir, "mooncore-mod-x.js")));
    const j2 = E.prepareJob(plan(dir), base, "Code.exe");
    fs.appendFileSync(path.join(j2.dir, "apply.js"), "\n// правка");
    assert.strictEqual(runJob(j2), 90, "загрузчик не исполняет изменённый apply.js");
    const j3 = E.prepareJob(plan(dir), base, "Code.exe");
    const jf = path.join(j3.dir, "job.json");
    fs.writeFileSync(jf, fs.readFileSync(jf, "utf8").replace("workbench.html", "evil.html"));
    assert.strictEqual(runJob(j3), 1);
    assert.ok(!fs.existsSync(path.join(dir, "evil.html")));
});

/** execPlanElevated с подменённым запуском процессов: calls[i] — что вернуть на i-й запуск. */
async function withSpawn(calls, fn) {
    const orig = cp.execFile, plat = Object.getOwnPropertyDescriptor(process, "platform");
    let i = 0;
    const seen = [];
    cp.execFile = (file, args, opts, cb) => {
        const c = calls[i++] || {};
        seen.push(path.basename(file));
        if (c.throw) { const e = new Error("spawn " + c.throw); e.code = c.throw; throw e; }
        setImmediate(() => cb(c.code ? Object.assign(new Error("exit"), { code: c.code }) : null, "", ""));
    };
    Object.defineProperty(process, "platform", { value: "win32" });
    try { return await fn(seen); } finally { cp.execFile = orig; Object.defineProperty(process, "platform", plat); }
}

test("права: PowerShell запрещён (синхронный EPERM) — не падаем, идём дальше по цепочке", async () => {
    const base = path.join(TMP, "elev-chain");
    // PowerShell запрещён, wscript тоже — задание для ручного запуска.
    await withSpawn([{ throw: "EPERM" }, { throw: "EPERM" }], async (seen) => {
        const r = await EL.execPlanElevated(plan(targets("m1")), base, "Code.exe");
        assert.ok(r.manual && fs.existsSync(r.job.cmd), JSON.stringify(r));
        assert.deepStrictEqual(seen, ["powershell.exe", "wscript.exe"]);
        EL.dropJob(r.job);
    });
    // PowerShell запрещён, wscript запросил права — ждём result.json (его пишет повышенный run.cmd).
    const dir = targets("m2");
    await withSpawn([{ throw: "EPERM" }, { code: 0 }], async () => {
        const r = await EL.execPlanElevated(plan(dir), base, "Code.exe");
        assert.ok(r.pending, JSON.stringify(r));
        runJob(r.job);
        const w = await EL.waitResult(r.job, 5000);
        assert.ok(w.ok, JSON.stringify(w));
        assert.strictEqual(fs.readFileSync(path.join(dir, "workbench.html"), "utf8"), "НОВОЕ");
        assert.ok(!fs.existsSync(r.job.dir), "папка задания убрана");
    });
    // «Нет» в окне UAC (PowerShell и wscript) — отменено, без ручного пути.
    await withSpawn([{ code: 1223 }], async () => { assert.ok((await EL.execPlanElevated(plan(targets("c1")), base, "Code.exe")).cancelled); });
    await withSpawn([{ throw: "EPERM" }, { code: 1223 }], async () => { assert.ok((await EL.execPlanElevated(plan(targets("c2")), base, "Code.exe")).cancelled); });
    // Ждать можно перестать.
    await withSpawn([{ throw: "EPERM" }, { code: 0 }], async () => {
        const r = await EL.execPlanElevated(plan(targets("s1")), base, "Code.exe");
        assert.ok((await EL.waitResult(r.job, 5000, () => true)).cancelled);
        EL.dropJob(r.job);
    });
});
