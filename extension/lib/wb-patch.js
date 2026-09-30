// ============================================================
//  Правка оболочки VS Code (workbench.html) — чистые функции без vscode.
//  Их используют и расширение (lib/inject/), и хук удаления (uninstall.js), который VS Code
//  запускает голым Node без API расширений.
//
//  Соседство: в той же оболочке живут блоки be5invis custom-css (VSCODE-CUSTOM-CSS) и
//  cpp-docs-panel (CPPDOCS-WINDOW). Мы трогаем ТОЛЬКО свой блок между MOONCORE-маркерами
//  и только свой nonce в CSP — чужие вставки остаются как были.
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const TT = require("./trusted-types");
const { writeAtomic } = require("./fsx");

const WB_START = "<!-- MOONCORE-START -->";
const WB_END = "<!-- MOONCORE-END -->";
const CSP_RE = /<meta\s+[^>]*Content-Security-Policy[^>]*>/i;
const TMP_EXT = ".mooncore-tmp";
const BAK_EXT = ".mooncore-backup";
// Рантаймы модулей лежат отдельными файлами рядом с оболочкой (тот же каталог = тот же origin
// vscode-file, их грузит обычный <script src>): оболочка остаётся лёгкой, а скрипт кэшируется.
const MOD_FILE_PREFIX = "mooncore-mod-";
// Мост слушает только порты из этого диапазона, и в CSP оболочки разрешаются ровно они, а не
// «любой порт на 127.0.0.1» (как было). Окон VS Code бывает несколько — у каждого свой порт.
const { BRIDGE_PORT_FIRST, BRIDGE_PORT_COUNT } = require("./protocol");
const BRIDGE_PORTS = Array.from({ length: BRIDGE_PORT_COUNT }, (_, i) => BRIDGE_PORT_FIRST + i);
const CONNECT_ADD = BRIDGE_PORTS.map((p) => " http://127.0.0.1:" + p).join("");
const CONNECT_OLD = " http://127.0.0.1:*";
const CPPDOCS_START = "<!-- CPPDOCS-WINDOW-START -->";

/** Экранировать </script, чтобы инлайн-<script> не закрылся на содержимом. */
function escapeScript(s) { return String(s).replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--"); }

/** JSON, безопасный внутри <script>: без </script, <!-- и разделителей строк U+2028/2029. */
function safeJson(v) {
    return JSON.stringify(v)
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e")
        .replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028")
        .replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");
}

function makeNonce() { return crypto.randomBytes(16).toString("base64").replace(/[^A-Za-z0-9]/g, ""); }
function sha256(s) { return crypto.createHash("sha256").update(String(s), "utf8").digest("hex"); }

function blockRe() {
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(esc(WB_START) + "[\\s\\S]*?" + esc(WB_END) + "\\n?");
}

/** Наш блок из HTML (или ""). */
function findBlock(html) { const m = String(html).match(blockRe()); return m ? m[0] : ""; }
function isInjected(html) { return findBlock(html) !== ""; }

/** Метаданные впечатанного блока: версия расширения и SHA рантайма (для автообновления). */
function blockInfo(html) {
    const b = findBlock(html);
    if (!b) return null;
    const ver = (b.match(/data-mooncore-version="([\w.+-]{1,40})"/) || [])[1] || "";
    const sha = (b.match(/data-mooncore-sha="([0-9a-f]{64})"/) || [])[1] || "";
    const nonce = (b.match(/nonce="([A-Za-z0-9]{8,64})"/) || [])[1] || "";
    const mods = (b.match(/data-mooncore-modules="([a-z0-9,-]{0,600})"/) || [])[1] || "";
    const tt = (b.match(/data-mooncore-tt="([a-z0-9,-]{0,600})"/) || [])[1] || "";
    return { version: ver, sha: sha, nonce: nonce, modules: mods ? mods.split(",") : [], tt: tt ? tt.split(",") : [] };
}

/**
 * Снять из CSP наши адреса моста (и прежний «любой порт»). Тот же «любой порт» пишет в CSP окно
 * cpp-docs-panel для своего моста: пока его блок в оболочке, этот адрес — его, не трогаем.
 */
function stripConnect(meta, html) {
    const out = meta.split(CONNECT_ADD).join("");
    return html && html.indexOf(CPPDOCS_START) !== -1 ? out : out.split(CONNECT_OLD).join("");
}
/** Снять из CSP только наш nonce (остальные — чужие, их не трогаем). */
function stripOurNonce(meta, nonce) {
    if (!nonce) return meta;
    return meta.split(" 'nonce-" + nonce + "'").join("");
}

/**
 * Добавить nonce в директиву, если он там нужен. По CSP2+ nonce в директиве ОТКЛЮЧАЕТ её
 * 'unsafe-inline': добавь мы nonce в style-src 'unsafe-inline', VS Code потерял бы свои
 * инлайн-стили (<style> тем и style-атрибуты). Где 'unsafe-inline' уже есть, nonce не нужен.
 */
function addNonce(meta, directive, nonce) {
    const re = directiveRe(directive);
    const m = re.exec(meta);
    if (!m) return null;
    if (/'unsafe-inline'/i.test(m[3])) return meta;
    return meta.replace(re, () => m[1] + m[2] + m[3] + " 'nonce-" + nonce + "'");
}

/**
 * Директива CSP целиком по имени: m[1] — разделитель перед ней, m[2] — имя, m[3] — значение.
 * Имя стоит отдельно: «trusted-types» не находится внутри «require-trusted-types-for», а
 * «script-src» — внутри «script-src-elem».
 */
function directiveRe(name) { return new RegExp("(^|[;\"'\\s])(" + name + ")(?=[\\s;\"]|$)([^;>\"]*)", "i"); }
// Trusted Types (политика «mooncore» и политики модулей) — в lib/trusted-types.js.
const TT_POLICY = TT.TT_POLICY;
const addTrustedType = TT.add, stripTrustedType = TT.strip, trustedTypesOf = TT.namesOf;
/** Политики модулей, которые нужно дописать в CSP этой оболочки (сравнение с чистой, без блока). */
function moduleTrustedTypes(html, names) { const m = stripBlock(html).match(CSP_RE); return TT.toAdd(m && m[0], names); }
/** Политики модулей, которых сейчас нет в CSP оболочки. */
function missingTrustedTypes(html, names) { const m = String(html).match(CSP_RE); return TT.missing(m && m[0], names); }

/** Впустить наш скрипт по nonce, не снимая CSP. Нет CSP-меты — ничего не навязываем. */
function armCsp(html, nonce, oldNonce, tt, oldTt) {
    const m = html.match(CSP_RE);
    if (!m) return html;
    // Политики модулей: прошлые добавки снимаем (модуль могли убрать), нынешние дописываем.
    let meta = addTrustedType(stripTrustedType(stripOurNonce(stripOurNonce(m[0], oldNonce), nonce), oldTt), tt);
    const withScript = addNonce(meta, "script-src", nonce);
    if (withScript != null) meta = withScript;
    else {
        // script-src нет: скрипты ограничивает default-src. Новая script-src — его копия плюс наш
        // nonce (одиночный nonce отрезал бы скрипты самого VS Code, а после снятия nonce пустая
        // «script-src;» запретила бы все). Нет и default-src — скрипты не ограничены, nonce не нужен.
        const dm = directiveRe("default-src").exec(meta);
        if (dm) {
            const base = dm[3].trim();
            const add = "script-src " + (base ? base + " " : "") + "'nonce-" + nonce + "'; ";
            meta = meta.replace(/(content\s*=\s*)(["'])/i, (x, a, q) => a + q + add);
            if (/'unsafe-inline'/i.test(base)) meta = meta.replace(" 'nonce-" + nonce + "'", "");
        }
    }
    meta = addNonce(meta, "style-src", nonce) || meta;
    meta = stripConnect(meta, html);
    const cm = directiveRe("connect-src").exec(meta);
    if (cm) meta = meta.replace(directiveRe("connect-src"), () => cm[1] + cm[2] + cm[3] + CONNECT_ADD);
    return html.replace(CSP_RE, () => meta);
}

/**
 * Отпечаток содержимого блока: рантайм плюс модули. Без модулей — ровно sha рантайма
 * (блоки прошлых версий остаются «актуальными», пока модулей нет).
 */
function blockSha(runtime, modules) {
    const list = Array.isArray(modules) ? modules : [];
    if (!list.length) return sha256(runtime);
    return sha256(sha256(runtime) + "|" + list.map((m) => m.id + (m.lazy ? "~lazy" : "") + ":" + sha256(m.code)).join(","));
}

const modId = (id) => String(id).replace(/[^a-z0-9-]/g, "");

/** Имя файла рантайма модуля рядом с оболочкой. */
function moduleFileName(id) { return MOD_FILE_PREFIX + modId(id) + ".js"; }
/** Файл модуля: первая строка — защита запуска (рантайм может попросить пропустить модуль,
 *  который в прошлый раз не дал окну стартовать). Остальное — код модуля как есть. */
function moduleFileContent(id, code) {
    const i = modId(id);
    return "if (window.__MOONCORE__ && window.__MOONCORE__._skip && window.__MOONCORE__._skip(\"" + i + "\")) " +
        "throw new Error(\"moon-core: модуль " + i + " пропущен защитой запуска\");\n" + String(code) + "\n";
}
/** Значение атрибута integrity для содержимого файла (SRI): sha256 в base64. */
function sriHash(content) { return "sha256-" + crypto.createHash("sha256").update(Buffer.from(String(content), "utf8")).digest("base64"); }
/** Метки начала/конца модуля: рантайм по ним считает время и понимает, на каком модуле встал запуск. */
function modMark(attr, fn, id) {
    return "<script" + attr + ">window.__MOONCORE__&&window.__MOONCORE__." + fn + "&&window.__MOONCORE__." + fn + "(\"" + modId(id) + "\")</script>\n";
}

/**
 * Блок для <head>: boot-данные, рантайм и рантаймы модулей — все с нашим nonce.
 * Модули идут ПОСЛЕ рантайма (им нужен window.__MOONCORE__), каждый в своём <script>:
 * ошибка одного модуля не мешает остальным.
 */
function buildBlock(boot, runtime, opts) {
    const o = opts || {};
    const nonce = o.nonce || "";
    const mods = Array.isArray(o.modules) ? o.modules : [];
    const attr = nonce ? ' nonce="' + nonce + '"' : "";
    const meta = ' data-mooncore-version="' + String(o.version || "0").replace(/[^\w.+-]/g, "") + '"' +
        ' data-mooncore-sha="' + blockSha(runtime, mods) + '"' +
        (mods.length ? ' data-mooncore-modules="' + mods.map((m) => modId(m.id)).join(",") + '"' : "") +
        // Политики Trusted Types модулей, которые МЫ дописали в CSP: при снятии уберём ровно их.
        (Array.isArray(o.trustedTypes) && o.trustedTypes.length ? ' data-mooncore-tt="' + o.trustedTypes.map(modId).join(",") + '"' : "");
    return WB_START + "\n" +
        "<script" + attr + meta + ">window.__MOONCORE_BOOT__ = " + safeJson(boot) + ";</script>\n" +
        "<script" + attr + ">\n" + escapeScript(runtime) + "\n</script>\n" +
        // Ленивый модуль с файлом рядом не грузится на старте: рантайм подключит файл сам (boot.modules[].lazy).
        mods.filter((m) => !(m.lazy && m.file)).map((m) => modMark(attr, "_modStart", m.id) +
            (m.file
                ? "<script" + attr + ' src="' + m.file + '"' + (m.integrity ? ' integrity="' + m.integrity + '"' : "") + ' data-mooncore-module="' + modId(m.id) + '"></script>\n'
                : "<script" + attr + ' data-mooncore-module="' + modId(m.id) + '">\n' + escapeScript(m.code) + "\n</script>\n") +
            modMark(attr, "_modDone", m.id)).join("") +
        WB_END + "\n";
}

/**
 * Проверка оболочки перед записью: before — что лежит на диске, after — что собираемся записать.
 * Внедрение меняет ровно две вещи — свой блок и CSP-мету. Если вне их изменилось что-то ещё,
 * блоков стало два или блок оказался не в <head>, писать нельзя: VS Code может не открыться.
 * Возвращает "" (всё в порядке) или причину.
 */
function shellProblem(before, after) {
    const n = (s, mark) => String(s).split(mark).length - 1;
    if (n(after, WB_START) !== 1 || n(after, WB_END) !== 1) return "в оболочке должен быть ровно один блок Moon Core";
    const start = after.indexOf(WB_START), end = after.indexOf(WB_END), head = after.lastIndexOf("</head>");
    if (start > end) return "метки блока Moon Core перепутаны";
    if (head === -1 || end > head) return "блок Moon Core оказался вне <head>";
    // Без блока и без CSP-меты оболочка должна остаться той же байт в байт.
    const rest = (s) => String(s).replace(blockRe(), "").replace(CSP_RE, "");
    if (rest(after) !== rest(before)) return "кроме блока Moon Core и CSP изменилось что-то ещё";
    if (n(after, "<meta") !== n(before, "<meta")) return "изменилось число meta-тегов";
    return "";
}

/** Вставить/обновить наш блок (идемпотентно). null — если в HTML нет </head>. */
function applyBlock(html, block) {
    html = html.replace(blockRe(), "");
    const idx = html.lastIndexOf("</head>");
    if (idx < 0) return null;
    return html.slice(0, idx) + block + html.slice(idx);
}

/**
 * Снять script-src, которую дописал armCsp (в CSP не было script-src — мы вставили в начало
 * копию default-src). Узнаём её по месту и содержимому: первая директива, значение ровно как у
 * default-src. Без этого после снятия оболочка отличалась бы от исходной (хэш, «повреждено»).
 */
function stripAddedScriptSrc(meta) {
    const re = /(content\s*=\s*)(["'])script-src([^;"]*);\s*/i;
    const m = re.exec(meta);
    const dm = directiveRe("default-src").exec(meta);
    if (!m || !dm || m[3].trim() !== dm[3].trim()) return meta;
    return meta.replace(re, (x, a, q) => a + q);
}

/** Убрать наш блок и наш nonce из CSP. */
function stripBlock(html) {
    const info = blockInfo(html);
    let out = html.replace(blockRe(), "");
    if (info && info.nonce) {
        const m = out.match(CSP_RE);
        if (m) out = out.replace(CSP_RE, () => stripAddedScriptSrc(stripTrustedType(stripConnect(stripOurNonce(m[0], info.nonce), out), info.tt)));
    }
    return out;
}

/** Атомарная запись оболочки: временный файл + rename; повторы переживают EBUSY/EPERM. */
function writeWorkbenchAtomic(file, data) { writeAtomic(file, data, TMP_EXT); }

/** Найти workbench.html под каталогом (обход до depth уровней, симлинки не разворачиваем). */
function findWorkbenchIn(dir, depth, withSessions) {
    const out = [];
    const walk = (d, lvl) => {
        if (lvl > depth) return;
        let items;
        try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const it of items) {
            const p = path.join(d, it.name);
            if (it.isDirectory() && !it.isSymbolicLink()) walk(p, lvl + 1);
            else if (it.name === "workbench.html" && isRealWorkbench(p)) out.push(p);
            else if (withSessions && it.name === "sessions.html" && isSessionsShell(p)) out.push(p);
        }
    };
    walk(dir, 0);
    return out;
}

/** Пишем только в настоящую оболочку десктопного VS Code, не в случайный workbench.html. */
function isRealWorkbench(f) { return /[\\/]electron-(browser|sandbox)[\\/]workbench[\\/]workbench\.html$/i.test(f); }
/** Оболочка окна агентских сессий (VS Code 1.121+): vs/sessions/electron-browser/sessions.html. */
function isSessionsShell(f) { return /[\\/]vs[\\/]sessions[\\/]electron-(browser|sandbox)[\\/]sessions\.html$/i.test(f); }

/** Снять наш блок из файла и убрать файлы модулей рядом. true — если что-то поменяли. */
function unpatchFile(f) {
    const html = fs.readFileSync(f, "utf8");
    removeModuleFiles(path.dirname(f), []);
    if (!isInjected(html)) return false;
    writeWorkbenchAtomic(f, stripBlock(html));
    return true;
}
/** Наши файлы модулей в каталоге оболочки, кроме keep (имена). */
function moduleFilesIn(dir, keep) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return []; }
    return names.filter((n) => n.indexOf(MOD_FILE_PREFIX) === 0 && /\.js$/.test(n) && (keep || []).indexOf(n) === -1).map((n) => path.join(dir, n));
}
function removeModuleFiles(dir, keep) {
    moduleFilesIn(dir, keep).forEach((f) => { try { fs.unlinkSync(f); } catch (e) {} });
}

// ------------------------------------------------------------------ контрольные суммы
// VS Code сверяет файлы оболочки с хэшами из product.json и после любого патча пишет
// «установка повреждена». Пересчитываем хэш своей оболочки (как «Fix VSCode Checksums»);
// исходный product.json один раз кладём рядом как .mooncore-backup и при снятии возвращаем
// из него исходное значение ровно этой записи.
const PRODUCT = "product.json";
/** Хэш в формате product.json: sha256, base64 без «=». */
function productChecksum(buf) { return crypto.createHash("sha256").update(buf).digest("base64").replace(/=+$/, ""); }
/** Ключ записи: путь файла относительно app/out со слэшами. */
function checksumKey(outDir, file) { return path.relative(outDir, file).split(path.sep).join("/"); }
/**
 * Новый текст product.json с хэшем key = sum. Формат файла сохраняем: меняем только значение
 * нужной записи. null — записи нет (эта сборка не проверяет файл) или хэш уже верный.
 */
function setChecksumText(text, key, sum) {
    let json;
    try { json = JSON.parse(text); } catch (e) { return null; }
    if (!json || !json.checksums || typeof json.checksums[key] !== "string") return null;
    if (json.checksums[key] === sum) return null;
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp('("' + esc + '"\\s*:\\s*")([^"]*)(")');
    if (!re.test(text)) return null;
    return text.replace(re, (m, a, b, c) => a + sum + c);
}
/** Записан ли для key в product.json именно этот хэш. null — записи нет. */
function checksumMatches(text, key, sum) {
    try { const j = JSON.parse(text); const v = j && j.checksums && j.checksums[key]; return typeof v === "string" ? v === sum : null; }
    catch (e) { return null; }
}
/**
 * Бэкап product.json (разобранный) или null. Бэкап от другой сборки VS Code (commit не совпал:
 * обновление заменило product.json, а наш файл рядом остался) не годится — в нём хэши старых
 * файлов, и «исходный» хэш из него сломал бы проверку новой сборки.
 */
function productBackup(prod) {
    try {
        const cur = JSON.parse(fs.readFileSync(prod, "utf8"));
        const bak = JSON.parse(fs.readFileSync(prod + BAK_EXT, "utf8"));
        return bak && cur && String(bak.commit || "") === String(cur.commit || "") ? bak : null;
    } catch (e) { return null; }
}

/** Вернуть исходный хэш записи key из бэкапа product.json. true — если что-то поменяли. */
function restoreChecksum(appRoot, key) {
    const prod = path.join(appRoot, PRODUCT);
    const b = productBackup(prod);
    const orig = b && b.checksums && b.checksums[key];
    if (typeof orig !== "string") return false;
    const next = setChecksumText(fs.readFileSync(prod, "utf8"), key, orig);
    if (next == null) return false;
    writeWorkbenchAtomic(prod, next);
    return true;
}

// ------------------------------------------------------------------ чужие вставки
// Что ещё, кроме Moon Core, дописано в оболочку: имена блоков по маркерам (<!-- X-START -->,
// <!-- !! VSCODE-CUSTOM-CSS-START !! --> с содержимым) и подключения Custom UI Style.
// Нужно, чтобы не «узаконить» чужое вмешательство пересчётом хэша, а сперва спросить.
function foreignBlocks(html) {
    html = String(html);
    const out = [];
    const re = /<!--\s*(?:!!\s*)?([A-Z][A-Z0-9-]{2,40}?)-START\s*(?:!!\s*)?-->([\s\S]*?)<!--\s*(?:!!\s*)?\1-END\s*(?:!!\s*)?-->/g;
    let m;
    while ((m = re.exec(html))) { if (m[1] !== "MOONCORE" && m[2].trim()) out.push(m[1]); }
    if (/<script[^>]+src="[^"]*external(\.module)?\.js"/i.test(html) || /custom-ui-style/i.test(html)) out.push("Custom UI Style");
    return out;
}

// ------------------------------------------------------------------ следы старых загрузчиков
// be5invis custom-css после «Disable» оставляет в оболочке пустую пару маркеров и комментарий
// SESSION-ID. Работе они не мешают, но путают (кажется, что загрузчик ещё стоит). Снимаем ТОЛЬКО
// пустые пары — блок с содержимым принадлежит живому загрузчику, его не трогаем.
const LEGACY_EMPTY_RE = /[ \t]*<!-- !! VSCODE-CUSTOM-CSS-START !! -->\s*<!-- !! VSCODE-CUSTOM-CSS-END !! -->\n?/g;
const LEGACY_SESSION_RE = /[ \t]*<!-- !! VSCODE-CUSTOM-CSS-SESSION-ID [^>]*!! -->\n?/g;
// Ещё один след того же загрузчика: скрипт-значок (ведёрко в статусбаре) — он стоит вне меток и
// остаётся после «Disable». Снимаем, только когда живого блока загрузчика в оболочке нет.
const LEGACY_INDICATOR_RE = /[ \t]*<script>(?:(?!<\/script>)[\s\S]){0,4000}?__CUSTOM_CSS_JS_INDICATOR_CLS(?:(?!<\/script>)[\s\S]){0,4000}?<\/script>\r?\n?/;
const legacyLive = (html) => html.replace(LEGACY_EMPTY_RE, "").indexOf("VSCODE-CUSTOM-CSS-START") !== -1;
function hasLegacyLeftovers(html) {
    html = String(html);
    LEGACY_EMPTY_RE.lastIndex = 0;
    return LEGACY_EMPTY_RE.test(html) || (LEGACY_INDICATOR_RE.test(html) && !legacyLive(html));
}
function stripLegacyLeftovers(html) {
    html = String(html);
    if (!hasLegacyLeftovers(html)) return html;
    if (!legacyLive(html)) html = html.replace(LEGACY_INDICATOR_RE, "");
    html = html.replace(LEGACY_EMPTY_RE, "");
    // Комментарий сессии нужен только непустому блоку: если блока не осталось — убираем и его.
    if (html.indexOf("VSCODE-CUSTOM-CSS-START") === -1) html = html.replace(LEGACY_SESSION_RE, "");
    return html;
}

module.exports = {
    WB_START, WB_END, TMP_EXT, BAK_EXT, escapeScript, safeJson, makeNonce, sha256, blockSha, findBlock, isInjected, blockInfo,
    armCsp, buildBlock, applyBlock, shellProblem, stripBlock, writeWorkbenchAtomic, findWorkbenchIn, isRealWorkbench, isSessionsShell, unpatchFile,
    MOD_FILE_PREFIX, moduleFileName, moduleFileContent, moduleFilesIn, removeModuleFiles, sriHash, foreignBlocks,
    BRIDGE_PORTS, CONNECT_ADD, TT_POLICY, addTrustedType, stripTrustedType, trustedTypesOf, moduleTrustedTypes, missingTrustedTypes,
    PRODUCT, productChecksum, checksumKey, setChecksumText, checksumMatches, productBackup, restoreChecksum,
    hasLegacyLeftovers, stripLegacyLeftovers,
};
