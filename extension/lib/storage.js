// Пути в globalStorage расширения. Хранилище общее для всех окон VS Code, а окно
// (оболочка) может читать его по vscode-file:// — поэтому всё, что нужно окну, лежит здесь.
"use strict";

const path = require("path");
const fs = require("fs");
const url = require("url");

/**
 * file:///-URL: прямые слэши, на Windows — третий слэш перед буквой диска. Спецсимволы пути
 * кодируются (pathToFileURL): «#», «?» и «%» в имени папки пользователя иначе ломали адрес —
 * окно не находило состояние, мост и конструктор.
 */
function fileUrl(p) {
    return url.pathToFileURL(path.resolve(p)).href;
}

function storageDir(context) {
    return (context.globalStorageUri && context.globalStorageUri.fsPath) || context.globalStoragePath;
}
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); return d; }

/** Список живых хостов моста (порт + токен), окно читает его, чтобы подключиться. */
function bridgeFile(context) { return path.join(storageDir(context), "mooncore-bridge.json"); }
/** Собранное состояние сниппетов: окно читает его при старте, до подключения к мосту. */
function stateFile(context) { return path.join(storageDir(context), "mooncore-state.json"); }
/** Папка сниппетов (*.css, *.js). */
function snippetsDir(context) { return path.join(storageDir(context), "snippets"); }
/** Изменения конструктора (правила CSS и настройки с исходными значениями). */
function designFile(context) { return path.join(storageDir(context), "mooncore-design.json"); }
/** Профили вида конструктора. */
function profilesFile(context) { return path.join(storageDir(context), "mooncore-profiles.json"); }
/** Файлы данных модулей: <id>.json. */
function modulesDataDir(context) { return path.join(storageDir(context), "modules"); }
/** Резервные копии вида (lib/backups.js). */
function backupsDir(context) { return path.join(storageDir(context), "backups"); }
/** Какие сниппеты выключены. */
function metaFile(context) { return path.join(storageDir(context), "mooncore-snippets.json"); }

/** Атомарная запись (временный файл + rename с повторами): окно никогда не прочтёт недописанный JSON. */
const { writeAtomic } = require("./fsx");

module.exports = { backupsDir, modulesDataDir, fileUrl, storageDir, ensureDir, bridgeFile, stateFile, snippetsDir, metaFile, designFile, profilesFile, writeAtomic };
