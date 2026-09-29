// ============================================================
//  Внедрение: запись с правами администратора и аварийное восстановление.
//
//  VS Code в Program Files: писать туда может только администратор. Задание готовит lib/elevate.js
//  (данные + хэши + run.cmd, исполняет сам VS Code как Node). Права просим по очереди:
//    1) PowerShell Start-Process -Verb RunAs (ждём окончания);
//    2) PowerShell запрещён политикой («spawn EPERM») — wscript.exe + ShellExecute «runas»
//       (не ждёт: итог узнаём по result.json);
//    3) запрещено и это — { manual }: расширение покажет run.cmd для запуска вручную
//       («Запуск от имени администратора» по правой кнопке).
//
//  Если после внедрения VS Code не открывается, команду «Убрать» не запустить. Рядом с данными
//  расширения лежит скрипт: он запускает хук удаления (uninstall.js) самим Code.exe в режиме
//  Node. Пути меняются с каждой версией расширения и VS Code — обновляем при каждом внедрении.
// ============================================================
"use strict";

const fs = require("fs");
const cp = require("child_process");
const path = require("path");
const E = require("../elevate");

const DAY = 24 * 3600 * 1000;

/** Запустить процесс; ошибку запуска (EPERM — запрещено политикой) вернуть, а не бросить. */
function run(file, args, opts) {
    return new Promise((resolve) => {
        try {
            cp.execFile(file, args, Object.assign({ windowsHide: true }, opts || {}), (err, stdout, stderr) => {
                resolve({ spawnError: err && typeof err.code === "string" ? err.code : null, code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stderr: String(stderr || "") });
            });
        } catch (e) { resolve({ spawnError: (e && e.code) || "EPERM", code: 1, stderr: String(e && e.message || e) }); }
    });
}

/** Старые папки заданий (прерванные запросы) — убрать. */
function cleanupJobs(base) {
    try {
        fs.readdirSync(base).filter((n) => /^elevate-/.test(n)).forEach((n) => {
            const p = path.join(base, n);
            try { if (Date.now() - fs.statSync(p).mtimeMs > DAY) fs.rmSync(p, { recursive: true, force: true }); } catch (e) {}
        });
    } catch (e) {}
}
function dropJob(job) { try { fs.rmSync(job.dir, { recursive: true, force: true }); } catch (e) {} }

/**
 * Записать план с правами администратора. base — папка для задания (globalStorage), exe — VS Code.
 * → { ok } | { ok:false, cancelled } | { ok:false, error } | { ok:false, pending, job } | { ok:false, manual, job }
 */
async function execPlanElevated(ops, base, exe) {
    if (process.platform !== "win32") return { ok: false, error: "только Windows" };
    cleanupJobs(base);
    let job;
    try { job = E.prepareJob(ops, base, exe || process.execPath); } catch (e) { return { ok: false, error: e.message }; }
    // Повышенно запускается системный cmd.exe со строкой из E.elevatedCommand (не run.cmd из
    // папки пользователя — его могли бы подменить до согласия в окне UAC). Что запускать — через
    // переменные окружения: кириллица, пробелы и кавычки не ломают команду PowerShell и WScript.
    const cmd = E.elevatedCommand(job);
    const env = Object.assign({}, process.env, { MOONCORE_SHELL: cmd.shell, MOONCORE_ARGS: cmd.args });
    // 1) PowerShell.
    const ps = "try { $p = Start-Process -FilePath $env:MOONCORE_SHELL -ArgumentList $env:MOONCORE_ARGS -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop; exit $p.ExitCode } " +
        "catch { if ($_.Exception.NativeErrorCode -eq 1223) { exit 1223 } else { exit 2 } }";
    const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { env: env });
    const res = E.readResult(job);
    if (res) { dropJob(job); return res.ok ? { ok: true } : { ok: false, error: res.error || "не удалось" }; }
    if (!r.spawnError && r.code === 1223) { dropJob(job); return { ok: false, cancelled: true }; }   // «Нет» в окне UAC
    // 2) PowerShell запрещён или не справился — ShellExecute «runas» из Windows Script Host.
    const js = path.join(job.dir, "runas.js");
    try { fs.writeFileSync(js, E.RUNAS_JS, "utf8"); } catch (e) { return { ok: false, manual: true, job: job }; }
    const w = await run("wscript.exe", ["//nologo", "//E:JScript", js], { env: env });
    if (!w.spawnError && w.code === 0) return { ok: false, pending: true, job: job };
    if (!w.spawnError && w.code === 1223) { dropJob(job); return { ok: false, cancelled: true }; }
    // 3) Автоматически права не запросить — пусть человек запустит run.cmd сам.
    return { ok: false, manual: true, job: job, why: r.spawnError || w.spawnError || "" };
}

/** Ждать итога задания (запуск без ожидания или вручную). stop() → true — перестать ждать. */
async function waitResult(job, ms, stop) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        const res = E.readResult(job);
        if (res) { dropJob(job); return res.ok ? { ok: true } : { ok: false, error: res.error || "не удалось" }; }
        if (stop && stop()) return { ok: false, cancelled: true };
        await new Promise((r) => setTimeout(r, 700));
    }
    return { ok: false, timeout: true };
}

/** Совпадает ли каждый файл плана с тем, что планировали записать. Возвращает несовпавшие операции. */
function verifyPlan(ops) {
    return ops.filter((o) => {
        try { return o.remove ? fs.existsSync(o.file) : fs.readFileSync(o.file, "utf8") !== o.data; }
        catch (e) { return !o.remove; }
    });
}

function recoveryPath(context) {
    return path.join(context.globalStorageUri.fsPath, process.platform === "win32" ? "moon-core-restore.cmd" : "moon-core-restore.sh");
}

function writeRecovery(context) {
    const exe = process.execPath, hook = path.join(context.extensionPath, "uninstall.js");
    fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    const text = process.platform === "win32"
        ? ["@echo off", "chcp 65001 >nul",
           "echo Moon Core: снимаю блок из оболочки VS Code (закрой VS Code перед запуском).",
           "set ELECTRON_RUN_AS_NODE=1",
           "\"" + exe + "\" \"" + hook + "\"",
           "echo.", "echo Готово. Если написано «нет прав» — запусти этот файл от имени администратора.", "pause", ""].join("\r\n")
        : ["#!/bin/sh", "echo 'Moon Core: снимаю блок из оболочки VS Code (закрой VS Code перед запуском).'",
           "ELECTRON_RUN_AS_NODE=1 \"" + exe + "\" \"" + hook + "\"", ""].join("\n");
    const file = recoveryPath(context);
    let cur = null;
    try { cur = fs.readFileSync(file, "utf8"); } catch (e) {}
    if (cur !== text) fs.writeFileSync(file, text, "utf8");
    if (process.platform !== "win32") { try { fs.chmodSync(file, 0o755); } catch (e) {} }
}

module.exports = { execPlanElevated, waitResult, dropJob, verifyPlan, recoveryPath, writeRecovery };
