// ============================================================
//  Внедрение: запись с правами администратора и аварийное восстановление.
//
//  VS Code в Program Files: писать туда может только администратор. Данные кладём во временную
//  папку, а сам скрипт передаём в командной строке (-EncodedCommand), а не файлом: подменить его
//  до подтверждения UAC нельзя. В скрипт вшиты SHA-256 каждого файла; повышенный процесс читает
//  байты, сверяет хэш и пишет ИМЕННО эти байты (lib/elevate.js).
//
//  Если после внедрения VS Code не открывается, команду «Убрать» не запустить. Рядом с данными
//  расширения лежит скрипт: он запускает хук удаления (uninstall.js) самим Code.exe в режиме
//  Node. Пути меняются с каждой версией расширения и VS Code — обновляем при каждом внедрении.
// ============================================================
"use strict";

const fs = require("fs");
const os = require("os");
const cp = require("child_process");
const path = require("path");
const { elevatedScript } = require("../elevate");

const MAX_ENCODED = 30000;   // длина командной строки Windows — около 32 тыс. символов

function execPlanElevated(ops) {
    if (process.platform !== "win32") return Promise.resolve({ ok: false, error: "только Windows" });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mooncore-elev-"));
    const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} };
    let script;
    try { script = elevatedScript(ops, tmp); } catch (e) { cleanup(); return Promise.resolve({ ok: false, error: e.message }); }
    const enc = Buffer.from(script, "utf16le").toString("base64");
    if (enc.length > MAX_ENCODED) { cleanup(); return Promise.resolve({ ok: false, error: "слишком много файлов для одного запроса прав" }); }
    const cmd = "$p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','" + enc + "'; exit $p.ExitCode";
    return new Promise((resolve) => {
        cp.execFile("powershell.exe", ["-NoProfile", "-Command", cmd], { windowsHide: true }, (err) => {
            cleanup();
            resolve(err ? { ok: false, error: "отменено или не удалось (" + (err.code != null ? "код " + err.code : err.message) + ")" } : { ok: true });
        });
    });
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

module.exports = { execPlanElevated, verifyPlan, recoveryPath, writeRecovery };
