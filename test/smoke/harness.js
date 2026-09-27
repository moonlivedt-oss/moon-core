// Общий ремень смоук-тестов: очередь тестов, временная папка, общие модули и помощники.
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const EXT = path.join(__dirname, "..", "..", "extension");
const W = require(path.join(EXT, "lib", "wb-patch"));
const S = require(path.join(EXT, "lib", "snippets"));
const P = require(path.join(EXT, "lib", "protocol"));
const { createBridge, readHosts } = require(path.join(EXT, "lib", "bridge"));

const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mooncore-test-"));

const BASE_HTML = [
    "<!DOCTYPE html><html><head>",
    "<meta charset=\"utf-8\" />",
    "<!-- !! VSCODE-CUSTOM-CSS-START !! --><script>/*custom-css*/</script><!-- !! VSCODE-CUSTOM-CSS-END !! -->",
    "<!-- CPPDOCS-WINDOW-START -->\n<script>/*cppdocs*/</script>\n<!-- CPPDOCS-WINDOW-END -->",
    "</head><body></body></html>",
].join("\n");
const CSP = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'self' 'nonce-OTHER123'; style-src 'self' 'unsafe-inline'; connect-src 'self'\">";

const D = require(path.join(EXT, "lib", "design"));
const C = require(path.join(EXT, "lib", "catalog"));
const { DesignEngine } = require(path.join(EXT, "lib", "engine"));
const M = require(path.join(EXT, "lib", "modules"));
const K = require(path.join(EXT, "lib", "checks"));
const CMD = require(path.join(EXT, "lib", "commands"));
const B = require(path.join(EXT, "lib", "bundle"));
const AP = require(path.join(EXT, "lib", "autoprofile"));
const D2 = require(path.join(EXT, "lib", "design"));
const E2 = require(path.join(EXT, "lib", "engine"));

function makeEngine(user) {
    const dir = fs.mkdtempSync(path.join(TMP, "eng-"));
    return new DesignEngine({
        designFile: path.join(dir, "design.json"),
        profilesFile: path.join(dir, "profiles.json"),
        config: {
            globalValue: (k) => user[k],
            update: async (k, v) => { if (v === undefined) delete user[k]; else user[k] = v; },
        },
    });
}

function request(port, opts, body) {
    return new Promise((resolve, reject) => {
        const req = http.request(Object.assign({ host: "127.0.0.1", port: port, agent: false }, opts), (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
        });
        req.on("error", reject);
        if (body != null) req.write(body);
        req.end();
    });
}

function makeModuleDir(name, manifest, files) {
    const dir = path.join(TMP, "mod-" + name);
    fs.mkdirSync(dir, { recursive: true });
    Object.keys(files || {}).forEach((f) => {
        fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        fs.writeFileSync(path.join(dir, f), files[f], "utf8");
    });
    if (manifest) fs.writeFileSync(path.join(dir, M.MODULE_FILE), JSON.stringify(manifest), "utf8");
    return dir;
}


/**
 * Выполнить fn с заглушкой модуля vscode: любое обращение к API возвращает ту же заглушку.
 * Для частей, которым vscode нужен только при загрузке (host, inject, doctor).
 */
function withVscode(fn) {
    const Module = require("module");
    const any = new Proxy(function () {}, { get: (t, k) => (k === "then" ? undefined : k === Symbol.toPrimitive ? () => "" : any), apply: () => any, construct: () => any });
    const orig = Module._resolveFilename;
    Module._resolveFilename = function (req) { return req === "vscode" ? "vscode" : orig.apply(this, arguments); };
    require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: any };
    const done = () => { Module._resolveFilename = orig; delete require.cache.vscode; };
    let r;
    try { r = fn(any); } catch (e) { done(); throw e; }
    if (r && typeof r.then === "function") return r.then((v) => { done(); return v; }, (e) => { done(); throw e; });
    done();
    return r;
}

/** Выполнить все тесты по очереди и выйти с кодом 1, если что-то упало. */
async function run() {
    let passed = 0, failed = 0;
    for (const t of queue) {
        try { await t.fn(); passed++; console.log("  ok   " + t.name); }
        catch (e) { failed++; console.log("  FAIL " + t.name + "\n       " + (e && e.stack || e)); }
    }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
    console.log("\n" + passed + " passed, " + failed + " failed");
    process.exit(failed ? 1 : 0);
}

module.exports = { test, run, withVscode, assert, fs, os, path, http, EXT, TMP, W, S, P, createBridge, readHosts, D, C, DesignEngine, M, K, CMD, B, AP, D2, E2,
    BASE_HTML, CSP, request, makeEngine, makeModuleDir };
