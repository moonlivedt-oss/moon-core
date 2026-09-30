// ============================================================
//  Ключи globalState Moon Core — в одном месте, с описанием.
//
//  Раньше строки ключей были разбросаны по восьми файлам: легко опечататься, трудно понять,
//  что именно хранит расширение. Здесь же видно, какие ключи — разрешения пользователя (их
//  снимает команда «Отозвать все разрешения»), а какие — служебные отметки.
//  Модуль без vscode.
// ============================================================
"use strict";

const K = {
    // ---- разрешения пользователя (grant: true — снимаются «Отозвать все разрешения»)
    ALLOWED_COMMANDS: "mooncore.allowedCommands",           // [id] команд VS Code, разрешённых окну «всегда»
    JS_APPROVED: "mooncore.snippets.approvedJs",            // id -> sha256 одобренного кода JS-сниппета
    MODULES_ALLOWED: "mooncore.modules.allowed",            // id модуля -> источник
    MODULES_DENIED: "mooncore.modules.denied",              // id модуля -> источник (явный запрет)
    MODULES_CODE: "mooncore.modules.approvedCode",          // id -> { sha, source } одобренного кода
    MODULES_TRUST: "mooncore.modules.trustUpdates",         // id -> источник, обновления без вопроса
    MODULES_CAPS: "mooncore.modules.caps",                  // id -> { source, caps } одобренные права модуля
    PROJECT_PROFILES: "mooncore.projectProfiles",           // папка -> { sha, ok, at } ответ про .vscode/mooncore.json
    SHELL_TRUSTED: "mooncore.shellTrusted",                 // файл оболочки -> sha чистой оболочки
    AUDIT: "mooncore.audit",                                // журнал решений о разрешениях (lib/audit.js)
    // ---- служебные отметки
    CHECKED_VERSION: "mooncore.checkedVersion",
    LEGACY_ASKED_FOR: "mooncore.legacyAskedFor",
    AUTO_TRIED_FOR: "mooncore.autoTriedFor",
    PROMPTED_FOR: "mooncore.promptedFor",
    SHELL_ASKED: "mooncore.shellAsked",
    BLOCK_WRITTEN: "mooncore.blockWritten",
    WANT_INJECTED: "mooncore.wantInjected",
    SRI_OFF_FOR: "mooncore.sriUnsupportedFor",
    UI_INLINE_FOR: "mooncore.uiInlineFor",
    SAFE_MODE: "mooncore.safeMode",                          // true — безопасный режим (без сниппетов, правок и модулей)
    SEEN_VERSION: "mooncore.seenVersion",                    // версия расширения, о которой уже рассказали «Что нового»
};

/** Ключи-разрешения: их сбрасывает «Отозвать все разрешения» (журнал остаётся — в нём сам отзыв). */
const GRANTS = [K.ALLOWED_COMMANDS, K.JS_APPROVED, K.MODULES_ALLOWED, K.MODULES_DENIED, K.MODULES_CODE, K.MODULES_TRUST, K.MODULES_CAPS, K.PROJECT_PROFILES, K.SHELL_TRUSTED];

module.exports = Object.assign({ GRANTS }, K);
