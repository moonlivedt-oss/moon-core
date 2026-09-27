// ============================================================
//  Упаковщик .vsix без зависимостей (vsce не нужен).
//  .vsix — это zip: [Content_Types].xml + extension.vsixmanifest + extension/<файлы>.
//  Запуск: node scripts/package-vsix.js  ->  dist/moon-core-<версия>.vsix
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const pkg = JSON.parse(fs.readFileSync(path.join(EXT, "package.json"), "utf8"));
const dev = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

if (dev.version !== pkg.version) {
    console.error("Версии расходятся: package.json " + dev.version + " / extension/package.json " + pkg.version);
    process.exit(1);
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------- файлы расширения
const SKIP = new Set(["runtime/src"]);
function walk(dir, rel, out) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
        if (d.name.startsWith(".")) return;
        const abs = path.join(dir, d.name), r = rel ? rel + "/" + d.name : d.name;
        if (SKIP.has(r)) return;                           // исходники рантайма: в пакет идёт собранный файл
        if (d.isDirectory()) walk(abs, r, out);
        else if (d.isFile()) out.push({ name: "extension/" + r, data: fs.readFileSync(abs) });
    });
    return out;
}
const files = walk(EXT, "", []);
const readme = path.join(ROOT, "README.md");
if (fs.existsSync(readme) && !files.some((f) => f.name.toLowerCase() === "extension/readme.md")) {
    files.push({ name: "extension/README.md", data: fs.readFileSync(readme) });
}
const changelog = path.join(ROOT, "CHANGELOG.md");
if (fs.existsSync(changelog)) files.push({ name: "extension/CHANGELOG.md", data: fs.readFileSync(changelog) });
const license = path.join(ROOT, "LICENSE");
if (fs.existsSync(license)) files.push({ name: "extension/LICENSE.txt", data: fs.readFileSync(license) });

const TYPES = { ".js": "application/javascript", ".json": "application/json", ".md": "text/markdown", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain", ".vsixmanifest": "text/xml" };
const exts = Array.from(new Set(files.map((f) => path.extname(f.name).toLowerCase()).concat([".vsixmanifest", ".json"])));
const contentTypes = '<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    exts.map((e) => '<Default Extension="' + e + '" ContentType="' + (TYPES[e] || "application/octet-stream") + '"/>').join("") + "</Types>\n";

const manifest = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">',
    "  <Metadata>",
    '    <Identity Language="en-US" Id="' + xml(pkg.name) + '" Version="' + xml(pkg.version) + '" Publisher="' + xml(pkg.publisher) + '" />',
    "    <DisplayName>" + xml(pkg.displayName) + "</DisplayName>",
    '    <Description xml:space="preserve">' + xml(pkg.description) + "</Description>",
    "    <Tags>" + xml((pkg.keywords || []).join(",")) + "</Tags>",
    "    <Categories>" + xml((pkg.categories || []).join(",")) + "</Categories>",
    "    <GalleryFlags>Public</GalleryFlags>",
    "    <Properties>",
    '      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="' + xml(pkg.engines.vscode) + '" />',
    '      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="' + xml((pkg.extensionKind || ["workspace"]).join(",")) + '" />',
    "    </Properties>",
    "  </Metadata>",
    '  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>',
    "  <Dependencies/>",
    "  <Assets>",
    '    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />',
    files.some((f) => f.name === "extension/README.md") ? '    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />' : "",
    files.some((f) => f.name === "extension/CHANGELOG.md") ? '    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />' : "",
    files.some((f) => f.name === "extension/LICENSE.txt") ? '    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />' : "",
    "  </Assets>",
    "</PackageManifest>",
    "",
].filter((l) => l !== "").join("\n");

const entries = [
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "extension.vsixmanifest", data: Buffer.from(manifest, "utf8") },
].concat(files);

// ---------- zip (deflate, UTF-8 имена, фиксированная метка времени — сборка воспроизводима)
const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1;
const local = [], central = [];
let offset = 0;
entries.forEach((e) => {
    const name = Buffer.from(e.name, "utf8");
    const comp = zlib.deflateRawSync(e.data, { level: 9 });
    const crc = zlib.crc32(e.data) >>> 0;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt16LE(DOS_TIME, 10); h.writeUInt16LE(DOS_DATE, 12); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(e.data.length, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    local.push(h, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(DOS_TIME, 12); c.writeUInt16LE(DOS_DATE, 14); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(e.data.length, 24); c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += h.length + name.length + comp.length;
});
const cdir = Buffer.concat(central);
const endRec = Buffer.alloc(22);
endRec.writeUInt32LE(0x06054b50, 0); endRec.writeUInt16LE(entries.length, 8); endRec.writeUInt16LE(entries.length, 10);
endRec.writeUInt32LE(cdir.length, 12); endRec.writeUInt32LE(offset, 16);
const zip = Buffer.concat(local.concat([cdir, endRec]));

const dist = path.join(ROOT, "dist");
fs.mkdirSync(dist, { recursive: true });
const out = path.join(dist, pkg.name + "-" + pkg.version + ".vsix");
fs.writeFileSync(out, zip);
console.log(path.relative(ROOT, out) + "  " + (zip.length / 1024).toFixed(1) + " КБ, файлов " + entries.length);
console.log("SHA-256 " + crypto.createHash("sha256").update(zip).digest("hex"));
