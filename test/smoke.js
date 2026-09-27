// Смоук-тесты Moon Core без VS Code. Тесты лежат в test/smoke/*.test.js по темам, общий ремень —
// test/smoke/harness.js. Запуск: node test/smoke.js (или npm test).
"use strict";

const fs = require("fs");
const path = require("path");
const { run } = require("./smoke/harness");

const DIR = path.join(__dirname, "smoke");
fs.readdirSync(DIR).filter((f) => /\.test\.js$/.test(f)).sort().forEach((f) => require(path.join(DIR, f)));
run();
