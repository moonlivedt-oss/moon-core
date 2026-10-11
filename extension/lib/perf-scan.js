// ============================================================
//  «Скорость VS Code»: тяжёлые папки в открытом проекте — без vscode.
//
//  Ищет папки, которые VS Code зря держит под слежением (зависимости, виртуальные окружения,
//  кэши сборки). Обход асинхронный и с бюджетом: на огромном монорепозитории он остановится,
//  а не подвесит процесс расширений. Неоднозначные имена (build, target, vendor) считаются
//  тяжёлыми, только если рядом лежит файл, выдающий их назначение (CMakeLists.txt, Cargo.toml...).
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const HEAVY = [
    { name: "node_modules" }, { name: "bower_components" }, { name: ".pnpm-store" },
    { name: ".venv" }, { name: "venv", inside: "pyvenv.cfg" }, { name: ".tox" }, { name: ".mypy_cache" }, { name: ".pytest_cache" },
    { name: ".gradle" }, { name: ".next" }, { name: ".nuxt" }, { name: ".turbo" }, { name: ".parcel-cache" }, { name: ".angular" }, { name: ".svelte-kit" },
    { name: ".dart_tool" }, { name: ".vscode-test" },
    { name: "target", sibling: ["Cargo.toml", "pom.xml"] },
    { name: "build", sibling: ["CMakeLists.txt", "build.gradle", "build.gradle.kts", "pubspec.yaml"] },
    { name: "vendor", sibling: ["composer.json", "go.mod"] },
    { name: "Pods", sibling: ["Podfile"] },
];
const SKIP = new Set([".git", ".hg", ".svn"]);
const BY_NAME = new Map(HEAVY.map((h) => [h.name, h]));

async function readDir(dir) { try { return await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return []; } }
async function exists(f) { try { await fs.promises.access(f); return true; } catch (e) { return false; } }

/** Примерное число файлов в папке (обход до cap штук). */
async function countFiles(dir, cap) {
    let n = 0, dirs = 0;
    const stack = [dir];
    while (stack.length && n < cap && dirs++ < cap) {
        const cur = stack.pop();
        for (const d of await readDir(cur)) {
            if (d.isDirectory()) { if (!d.isSymbolicLink()) stack.push(path.join(cur, d.name)); }
            else if (++n >= cap) break;
        }
    }
    return n;
}

/** Подходит ли папка name в каталоге parent (с его списком names) под тяжёлую. */
async function heavyRule(parent, name, names) {
    const h = BY_NAME.get(name);
    if (!h) return null;
    if (h.sibling && !h.sibling.some((f) => names.has(f))) return null;
    if (h.inside && !(await exists(path.join(parent, name, h.inside)))) return null;
    return h;
}

/**
 * Тяжёлые папки в корнях roots: [{ root, rel, name, pattern, files, capped }] по убыванию files.
 * opts: { maxDepth (4), budget — сколько каталогов можно открыть (3000), cap — потолок счёта файлов (5000) }.
 */
async function scanHeavy(roots, opts) {
    const o = Object.assign({ maxDepth: 4, budget: 3000, cap: 5000 }, opts || {});
    const out = [];
    let budget = o.budget;
    for (const root of (roots || []).slice(0, 8)) {
        const queue = [{ dir: root, depth: 0 }];
        while (queue.length && budget > 0) {
            const cur = queue.shift();
            budget--;
            const list = await readDir(cur.dir);
            const names = new Set(list.map((d) => d.name));
            for (const d of list) {
                if (!d.isDirectory() || d.isSymbolicLink() || SKIP.has(d.name)) continue;
                const full = path.join(cur.dir, d.name);
                const rule = await heavyRule(cur.dir, d.name, names);
                if (rule) {
                    const files = await countFiles(full, o.cap);
                    out.push({ root: root, rel: path.relative(root, full).split(path.sep).join("/"), name: d.name, pattern: "**/" + d.name + "/**", files: files, capped: files >= o.cap });
                } else if (cur.depth + 1 < o.maxDepth) queue.push({ dir: full, depth: cur.depth + 1 });
            }
        }
    }
    return out.sort((a, b) => b.files - a.files);
}

module.exports = { scanHeavy, countFiles, HEAVY };
