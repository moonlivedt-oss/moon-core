// ============================================================
//  Сборка рантайма окна: extension/runtime/src/*.js (ядро) и src/ui/*.js (интерфейс).
//
//  Рантайм впечатывается в оболочку VS Code без зависимостей, поэтому сборка — простая склейка
//  частей по порядку имён внутри одной обёртки (function () { ... })(). Части — не
//  самостоятельные модули, а куски тела этой функции: общие переменные видны всем.
//
//  Три файла:
//    mooncore-runtime.js — полный: ядро + интерфейс одной функцией (встраивается целиком, если
//                          ленивая загрузка выключена или VS Code не дал её сделать; его гоняют тесты);
//    mooncore-core.js    — ядро + загрузчик интерфейса (встраивается в оболочку по умолчанию);
//    mooncore-ui.js      — чанк интерфейса: загрузчик вычисляет его прямым eval внутри ядра.
//
//  node scripts/build-runtime.js          — собрать
//  node scripts/build-runtime.js --check  — проверить, что собранные файлы совпадают с исходниками
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const RT = path.join(__dirname, "..", "extension", "runtime");
const SRC = path.join(RT, "src");
const UI_DIR = path.join(SRC, "ui");
const LOADER = "65-ui-loader.js";
const OUT = path.join(RT, "mooncore-runtime.js");
const OUT_CORE = path.join(RT, "mooncore-core.js");
const OUT_UI = path.join(RT, "mooncore-ui.js");
// Заглушки ядра, через которые оно зовёт интерфейс (65-ui-loader.js), и то, что возвращает
// чанк интерфейса, — один и тот же список (тест сверяет).
const UI_EXPORTS = ["startPick", "stopPick", "toggleDesign", "startDesign", "stopDesign", "renderPanel", "clearColorPreview"];

const HEAD = [
    "// ============================================================",
    "//  Moon Core — рантайм в окне VS Code (впечатан в workbench.html).",
    "//  СОБРАН из runtime/src/*.js (node scripts/build-runtime.js) — правь исходники, не этот файл.",
    "//",
    "//  Что делает:",
    "//    - применяет CSS-сниппеты (<style> в <head>, самолечение, если VS Code их снёс);",
    "//    - выполняет JS-сниппеты с помощником mc (всё созданное через него убирается само);",
    "//    - слушает мост расширения (SSE) — новые версии сниппетов, живой предпросмотр CSS,",
    "//      пипетку и проверку селекторов;",
    "//    - пипетка: подсветка элемента под курсором, колесо — родитель/потомок, клик — меню",
    "//      действий (стиль в CSS / скрыть / копировать селектор);",
    "//    - конструктор: панель свойств, ручки на элементе, порядок мышкой, карта, профили.",
    "//",
    "//  Node здесь нет (песочница оболочки): читаем файлы хранилища по vscode-file://,",
    "//  пишем и зовём команды через HTTP-мост на 127.0.0.1.",
    "// ============================================================",
    "(function () {",
    "    \"use strict\";",
    "    if (window.__MOONCORE__) return;",
    "",
].join("\n");
const TAIL = "})();\n";

const UI_HEAD = [
    "// ============================================================",
    "//  Moon Core — интерфейс окна: конструктор и пипетка. Чанк для ленивой загрузки.",
    "//  СОБРАН из runtime/src/ui/*.js (node scripts/build-runtime.js) — правь исходники, не этот файл.",
    "//  Сам по себе не запускается: его вычисляет прямым eval загрузчик в mooncore-core.js",
    "//  (runtime/src/65-ui-loader.js), поэтому код видит переменные рантайма.",
    "// ============================================================",
    "",
].join("\n");

const read = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n").replace(/\n*$/, "\n");
const list = (dir) => fs.readdirSync(dir).filter((f) => /^\d\d-[\w-]+\.js$/.test(f)).map((f) => path.join(dir, f));
const byName = (a, b) => (path.basename(a) < path.basename(b) ? -1 : path.basename(a) > path.basename(b) ? 1 : 0);

function build() {
    const core = list(SRC).filter((f) => path.basename(f) !== LOADER);
    const ui = list(UI_DIR).sort(byName);
    const full = HEAD + "\n" + core.concat(ui).sort(byName).map(read).join("\n") + TAIL;
    const lazy = HEAD + "\n" + core.concat([path.join(SRC, LOADER)]).sort(byName).map(read).join("\n") + TAIL;
    const chunk = UI_HEAD + ui.map(read).join("\n") +
        "    ({ " + UI_EXPORTS.map((n) => n + ": " + n).join(", ") + " });\n//# sourceURL=mooncore-ui.js\n";
    return { full: full, core: lazy, ui: chunk };
}

const OUTS = { full: OUT, core: OUT_CORE, ui: OUT_UI };

if (require.main === module) {
    const out = build();
    new Function(out.full); new Function(out.core); new Function(out.ui);   // парсятся
    const kb = (s) => Math.round(s.length / 1024) + " КБ";
    const sizes = "полный " + kb(out.full) + ", ядро " + kb(out.core) + ", интерфейс " + kb(out.ui);
    if (process.argv.includes("--check")) {
        const stale = Object.keys(OUTS).filter((k) => { try { return fs.readFileSync(OUTS[k], "utf8") !== out[k]; } catch (e) { return true; } });
        if (stale.length) { console.error("рантайм устарел (" + stale.map((k) => path.basename(OUTS[k])).join(", ") + "): запусти node scripts/build-runtime.js"); process.exit(1); }
        console.log("рантайм собран актуально: " + sizes);
    } else {
        Object.keys(OUTS).forEach((k) => fs.writeFileSync(OUTS[k], out[k], "utf8"));
        console.log("рантайм собран: " + sizes);
    }
}

module.exports = { build, OUT, OUT_CORE, OUT_UI, SRC, UI_DIR, UI_EXPORTS };
