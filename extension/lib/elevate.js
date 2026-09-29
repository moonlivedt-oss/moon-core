// ============================================================
//  Запись с правами администратора — без PowerShell (без vscode, его проверяют тесты).
//
//  Раньше повышенный процесс был PowerShell (-EncodedCommand). На ПК, где политика запрещает
//  запуск PowerShell, VS Code падал с «spawn EPERM» ещё до окна UAC. Теперь пишет сам VS Code:
//  его исполняемый файл (Program Files, пользователь его не подменит) в режиме Node.
//
//  prepareJob(ops, base, exe) кладёт в новую папку:
//    f0, f1, …    — байты для записи;
//    job.json     — куда писать, SHA-256 каждого файла, что удалить;
//    apply.js     — код записи (APPLY_CODE);
//    run.cmd      — запуск: VS Code как Node с коротким загрузчиком (BOOT) в командной строке.
//  Хэши apply.js и job.json вшиты в run.cmd, загрузчик сверяет их до исполнения, apply.js
//  сверяет каждый файл данных — и только потом пишет, всё или ничего (при сбое откат).
//  Итог — result.json рядом ({ ok, error }); его читает расширение.
//
//  run.cmd годится и для запуска вручную: «Запуск от имени администратора» по правой кнопке —
//  на случай, когда Windows не даёт запросить права автоматически.
// ============================================================
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// Загрузчик в командной строке: без символов, особых для cmd (кавычки, %, ^, &, |, <, >).
const BOOT = "const a=process.argv.slice(-4),fs=require('fs'),c=fs.readFileSync(a[0],'utf8');" +
    "if(require('crypto').createHash('sha256').update(c).digest('hex')!==a[1])process.exit(90);" +
    "global.MOONCORE_JOB=[a[2],a[3]];eval(c)";

// Сама запись. Исполняется повышенным процессом: сверить ВСЁ, потом писать; ошибка — откатить.
const APPLY_CODE = [
    "'use strict';",
    "(function () {",
    "  const fs = require('fs'), path = require('path'), crypto = require('crypto');",
    "  const jobFile = global.MOONCORE_JOB[0], jobHash = global.MOONCORE_JOB[1];",
    "  const dir = path.dirname(jobFile), out = path.join(dir, 'result.json');",
    "  const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');",
    "  const done = (ok, error) => {",
    "    try { fs.writeFileSync(out, JSON.stringify({ ok: ok, error: error || null, at: Date.now() })); } catch (e) {}",
    "    process.exit(ok ? 0 : 1);",
    "  };",
    "  try {",
    "    const raw = fs.readFileSync(jobFile);",
    "    if (hash(raw) !== jobHash) return done(false, 'job.json изменён');",
    "    const job = JSON.parse(raw.toString('utf8'));",
    "    const items = job.items.map((it) => {",
    "      const b = fs.readFileSync(path.join(dir, path.basename(it.s)));",
    "      if (hash(b) !== it.h) throw new Error('файл изменён: ' + it.d);",
    "      return { d: it.d, b: b };",
    "    });",
    "    const undo = [];",
    "    try {",
    "      items.forEach((it) => {",
    "        let prev = null; try { prev = fs.readFileSync(it.d); } catch (e) {}",
    "        const t = it.d + '.mooncore-tmp';",
    "        fs.writeFileSync(t, it.b); fs.renameSync(t, it.d);",
    "        undo.push({ d: it.d, prev: prev });",
    "      });",
    "      (job.removes || []).forEach((f) => {",
    "        let prev; try { prev = fs.readFileSync(f); } catch (e) { return; }",
    "        fs.unlinkSync(f); undo.push({ d: f, prev: prev });",
    "      });",
    "    } catch (e) {",
    "      undo.reverse().forEach((u) => { try { if (u.prev == null) fs.unlinkSync(u.d); else fs.writeFileSync(u.d, u.prev); } catch (x) {} });",
    "      throw e;",
    "    }",
    "    done(true);",
    "  } catch (e) { done(false, String(e && e.message || e)); }",
    "})();",
    "",
].join("\n");

/** Подготовить задание в новой папке внутри base. → { dir, cmd, result }. */
function prepareJob(ops, base, exe) {
    fs.mkdirSync(base, { recursive: true });
    const dir = fs.mkdtempSync(path.join(base, "elevate-"));
    const items = [], removes = [];
    ops.forEach((op, i) => {
        if (op.remove) { removes.push(op.file); return; }
        const buf = Buffer.from(op.data, "utf8"), name = "f" + i;
        fs.writeFileSync(path.join(dir, name), buf);
        items.push({ s: name, d: op.file, h: sha(buf) });
    });
    const job = Buffer.from(JSON.stringify({ items: items, removes: removes }, null, 1), "utf8");
    fs.writeFileSync(path.join(dir, "job.json"), job);
    fs.writeFileSync(path.join(dir, "apply.js"), APPLY_CODE, "utf8");
    // Пути к файлам задания — через %~dp0: в тексте .cmd нет кириллицы из имени пользователя.
    const text = [
        "@echo off",
        "chcp 65001 >nul",
        "rem Moon Core: запись в папку VS Code с правами администратора. Файл создан Moon Core;",
        "rem вручную: правая кнопка - Запуск от имени администратора.",
        "set \"ELECTRON_RUN_AS_NODE=1\"",
        "\"" + exe + "\" -e \"" + BOOT + "\" \"%~dp0apply.js\" " + sha(APPLY_CODE) + " \"%~dp0job.json\" " + sha(job),
        "set \"RC=%errorlevel%\"",
        "if /i \"%~1\"==\"auto\" exit /b %RC%",
        "echo.",
        "if \"%RC%\"==\"0\" echo Moon Core: готово. Вернитесь в VS Code.",
        "if not \"%RC%\"==\"0\" echo Moon Core: не получилось, код %RC%. Нужен запуск от имени администратора.",
        "pause",
        "exit /b %RC%",
        "",
    ].join("\r\n");
    fs.writeFileSync(path.join(dir, "run.cmd"), text, "utf8");
    return {
        dir: dir, cmd: path.join(dir, "run.cmd"), result: path.join(dir, "result.json"),
        exe: exe, apply: path.join(dir, "apply.js"), applySha: sha(APPLY_CODE), jobFile: path.join(dir, "job.json"), jobSha: sha(job),
    };
}

/**
 * Что запускать с правами администратора АВТОМАТИЧЕСКИ: системный cmd.exe и строка аргументов.
 * Не run.cmd: он лежит в папке пользователя, и любая программа пользователя могла бы подменить
 * его между подготовкой и согласием в окне UAC — и получить права администратора. Здесь всё,
 * что исполняется повышенно, либо системное (cmd.exe из System32, VS Code в Program Files),
 * либо сверяется по хэшу, переданному прямо в командной строке (apply.js, job.json, файлы).
 * run.cmd остаётся только для ручного запуска — его человек запускает сам.
 */
function elevatedCommand(job, env) {
    const e = env || process.env;
    const root = /^[A-Za-z]:\\[^"%]*$/.test(String(e.SystemRoot || "")) ? e.SystemRoot : "C:\\Windows";
    const q = (s) => "\"" + String(s).replace(/"/g, "") + "\"";
    const inner = "set \"ELECTRON_RUN_AS_NODE=1\" && " + q(job.exe) + " -e " + q(BOOT) + " " + q(job.apply) + " " + job.applySha + " " + q(job.jobFile) + " " + job.jobSha;
    return { shell: path.win32.join(root, "System32", "cmd.exe"), args: "/d /v:off /s /c \"" + inner + "\"" };
}

/** Итог задания: { ok, error } или null (ещё не выполнено). */
function readResult(job) {
    try { return JSON.parse(fs.readFileSync(job.result, "utf8")); } catch (e) { return null; }
}

// JScript для wscript.exe: попросить Windows запустить программу с правами администратора
// (ShellExecute «runas») — запасной путь, если PowerShell запрещён. Что запускать — из переменных
// окружения MOONCORE_SHELL / MOONCORE_ARGS (аргументы WScript теряют кавычки). Ошибку (в т.ч.
// «Нет» в окне UAC) ловим сами: иначе Windows Script Host покажет своё окно. 1223 — отменено.
const RUNAS_JS = [
    "var env = new ActiveXObject(\"WScript.Shell\").Environment(\"PROCESS\");",
    "try { new ActiveXObject(\"Shell.Application\").ShellExecute(env(\"MOONCORE_SHELL\"), env(\"MOONCORE_ARGS\"), \"\", \"runas\", 0); }",
    "catch (e) { WScript.Quit(1223); }",
    "",
].join("\r\n");

module.exports = { BOOT, APPLY_CODE, RUNAS_JS, prepareJob, readResult, elevatedCommand };
