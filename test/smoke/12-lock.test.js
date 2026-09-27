// Смоук-тесты Moon Core: межпроцессная блокировка записи оболочки.
"use strict";
const { test, withVscode, assert, fs, path, EXT, TMP } = require("./harness");
const cp = require("child_process");

const LK = require(path.join(EXT, "lib", "inject", "lock"));

test("блокировка: взять, занято, снять; брошенная (мёртвый pid, старая, пустая) снимается", () => {
    const dir = fs.mkdtempSync(path.join(TMP, "lock-"));
    const f = LK.lockPath(dir);
    const off = LK.acquire(f);
    assert.strictEqual(typeof off, "function");
    assert.strictEqual(LK.acquire(f), null, "второй раз — занято");
    assert.deepStrictEqual(LK.withLock(f, () => 1), { busy: true });
    off();
    assert.ok(!fs.existsSync(f));
    assert.strictEqual(LK.withLock(f, () => 42), 42);
    assert.ok(!fs.existsSync(f), "withLock снимает за собой");
    assert.throws(() => LK.withLock(f, () => { throw new Error("x"); }), /x/);
    assert.ok(!fs.existsSync(f), "и при ошибке");

    fs.writeFileSync(f, JSON.stringify({ pid: 2147483600, at: Date.now() }));
    const a = LK.acquire(f); assert.ok(a, "процесс-владелец умер"); a();
    fs.writeFileSync(f, JSON.stringify({ pid: process.pid, at: Date.now() - LK.STALE_MS - 1000 }));
    const b = LK.acquire(f); assert.ok(b, "слишком старая"); b();
    fs.writeFileSync(f, "");
    assert.strictEqual(LK.acquire(f), null, "пустой свежий файл — владелец ещё пишет pid");
    const old = new Date(Date.now() - 10000); fs.utimesSync(f, old, old);
    const c = LK.acquire(f); assert.ok(c, "пустой старый — брошен"); c();
    assert.deepStrictEqual(fs.readdirSync(dir), [], "хвостов .stale нет");
});

// Дочерний процесс: взять блокировку (ждать, пока свободна), n раз прибавить к счётчику
// без атомарности (прочитать — пауза — записать) и снять. Без блокировки прибавки теряются.
const CHILD = `
const LK = require(process.argv[2]);
const fs = require("fs");
const [file, counter, n] = [process.argv[3], process.argv[4], +process.argv[5]];
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let done = 0;
while (done < n) {
    const off = LK.acquire(file);
    if (!off) { sleep(2); continue; }
    const v = +fs.readFileSync(counter, "utf8");
    sleep(1);
    fs.writeFileSync(counter, String(v + 1));
    off();
    done++;
}
`;

test("блокировка: два настоящих процесса не теряют записи друг друга", async () => {
    const dir = fs.mkdtempSync(path.join(TMP, "race-"));
    const script = path.join(dir, "child.js"), counter = path.join(dir, "n.txt"), f = LK.lockPath(dir);
    fs.writeFileSync(script, CHILD);
    fs.writeFileSync(counter, "0");
    const run = () => new Promise((resolve, reject) => {
        const p = cp.spawn(process.execPath, [script, path.join(EXT, "lib", "inject", "lock.js"), f, counter, "40"], { stdio: ["ignore", "ignore", "pipe"] });
        let err = ""; p.stderr.on("data", (d) => { err += d; });
        p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("код " + code + ": " + err))));
    });
    await Promise.all([run(), run()]);
    assert.strictEqual(fs.readFileSync(counter, "utf8"), "80");
    assert.ok(!fs.existsSync(f));
});

test("блокировка: ожидание освобождения другим процессом", async () => {
    const dir = fs.mkdtempSync(path.join(TMP, "wait-"));
    const f = LK.lockPath(dir);
    const holder = cp.spawn(process.execPath, ["-e",
        "const LK=require(process.argv[1]);const off=LK.acquire(process.argv[2]);process.stdout.write('held');setTimeout(()=>{off();process.exit(0)},300)",
        path.join(EXT, "lib", "inject", "lock.js"), f], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((r) => holder.stdout.once("data", r));
    assert.strictEqual(LK.acquire(f), null, "держит другой процесс");
    const t0 = Date.now();
    assert.strictEqual(await LK.waitFree(f, 5000), true);
    assert.ok(Date.now() - t0 >= 150, "дождались, а не проскочили");
    const off = LK.acquire(f); assert.ok(off); off();
    assert.strictEqual(await LK.waitFree(f, 10), true, "свободно — сразу");
});

test("внедрение: пока оболочку пишет другое окно — «busy», без чтения и записи", () => withVscode(() => {
    const PL = require(path.join(EXT, "lib", "inject", "plan"));
    const dir = fs.mkdtempSync(path.join(TMP, "busy-"));
    const ctx = { globalStorageUri: { fsPath: dir } };
    // Держит «другое окно»: живой процесс — родитель этого теста.
    fs.writeFileSync(LK.lockPath(dir), JSON.stringify({ pid: process.ppid, at: Date.now() }));
    assert.strictEqual(LK.fileStale(LK.lockPath(dir)), false);
    assert.deepStrictEqual(PL.inject(ctx), { ok: false, done: 0, reason: "busy" });
    assert.strictEqual(PL.remove(ctx).busy, true);
    fs.unlinkSync(LK.lockPath(dir));
    assert.strictEqual(PL.lockFileOf(null), null, "без контекста (хук удаления) — без блокировки");
}));
