// ============================================================
//  Скрипт записи с правами администратора (без vscode — его проверяют тесты).
//  elevatedScript(ops, tmp): данные кладутся во временную папку, а в текст скрипта вшиваются
//  SHA-256 каждого файла. Скрипт идёт в -EncodedCommand (не файлом), сначала сверяет все хэши,
//  потом пишет ровно проверенные байты.
// ============================================================
"use strict";
const fs = require("fs");
const path = require("path");

function psq(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
function elevatedScript(ops, tmp) {
    const items = [], removes = [];
    ops.forEach((op, i) => {
        if (op.remove) { removes.push("if (Test-Path -LiteralPath " + psq(op.file) + ") { Remove-Item -LiteralPath " + psq(op.file) + " -Force }"); return; }
        const src = path.join(tmp, "f" + i), buf = Buffer.from(op.data, "utf8");
        fs.writeFileSync(src, buf);
        const hex = require("crypto").createHash("sha256").update(buf).digest("hex");
        items.push("@{s=" + psq(src) + ";d=" + psq(op.file) + ";h=" + psq(hex) + "}");
    });
    // Сначала читаем и сверяем ВСЁ (байты остаются в памяти), потом пишем именно эти байты:
    // несовпадение хоть в одном файле — не записано ничего.
    return [
        "$ErrorActionPreference = 'Stop'",
        "$items = @(" + items.join(",") + ")",
        "$sha = [Security.Cryptography.SHA256]::Create()",
        "foreach ($it in $items) {",
        "  $it.b = [IO.File]::ReadAllBytes($it.s)",
        "  $h = [BitConverter]::ToString($sha.ComputeHash($it.b)).Replace('-', '').ToLower()",
        "  if ($h -ne $it.h) { throw ('hash mismatch: ' + $it.d) }",
        "}",
        "foreach ($it in $items) { $t = $it.d + '.mooncore-tmp'; [IO.File]::WriteAllBytes($t, $it.b); Move-Item -LiteralPath $t -Destination $it.d -Force }",
    ].concat(removes).join("\r\n");
}

module.exports = { psq, elevatedScript };
