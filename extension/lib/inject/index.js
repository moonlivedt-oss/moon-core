// ============================================================
//  Внедрение рантайма в оболочку VS Code (workbench.html).
//
//  Рантайм и boot-данные впечатываются ИНЛАЙНОМ: оболочка отдаётся по vscode-file:// и
//  внешние <script src=file://...> блокирует (урок cpp-docs-panel 3.4.0). После обновления
//  VS Code оболочка пересоздаётся без нашего блока — при активации расширение это замечает.
//
//  Части:
//    ui-file.js   — какой рантайм встраивать; файл интерфейса окна для ленивой загрузки;
//    lock.js      — межпроцессная блокировка записи оболочки;
//    shell.js     — что в оболочке: файлы, модули, статус (с кэшем), доверие, контрольные суммы;
//    plan.js      — план записи и его выполнение «всё или ничего»;
//    deep-plan.js — глубокие патчи (сервисы окна, главный процесс) в плане;
//    elevated.js  — запись с правами администратора, скрипт аварийного восстановления;
//    flows.js     — команды и сценарии с вопросами пользователю.
// ============================================================
"use strict";

const SH = require("./shell");
const PL = require("./plan");
const DPL = require("./deep-plan");
const EL = require("./elevated");
const FL = require("./flows");
const UF = require("./ui-file");

module.exports = {
    // команды и сценарии
    injectCommand: FL.injectCommand, removeCommand: FL.removeCommand, checkOnActivate: FL.checkOnActivate,
    syncModules: FL.syncModules, onModulesFailed: FL.onModulesFailed, onUiFailed: FL.onUiFailed,
    // состояние
    status: SH.status, workbenchFiles: SH.workbenchFiles, moduleSet: SH.moduleSet, bootData: SH.bootData, appRootOf: SH.appRootOf,
    deepState: DPL.deepState, deepFiles: DPL.deepFiles,
    // запись
    cleanLegacy: PL.cleanLegacy,
    inject: FL.injectNow, injectShared: FL.injectShared, remove: PL.remove, planInject: PL.planInject, planRemove: PL.planRemove, execPlan: PL.execPlan,
    recoveryPath: EL.recoveryPath, writeRecovery: EL.writeRecovery,
    lazyUi: UF.lazyOn, uiChunk: UF.uiChunk,
};
