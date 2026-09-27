// ============================================================
//  Сниппеты — обычные файлы *.css и *.js в globalStorage/snippets.
//
//  Их правят в обычном редакторе VS Code (подсветка, автодополнение CSS), а хост:
//    - собирает включённые в состояние mooncore-state.json (окно читает его при старте);
//    - рассылает состояние по мосту при любом изменении папки (любое окно VS Code);
//    - пока CSS-файл не сохранён, шлёт «превью» — правка видна сразу, на каждый символ.
//  Выключенные сниппеты перечислены в mooncore-snippets.json.
//
//  Модуль без vscode: только файлы (его гоняют смоук-тесты).
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const P = require("./protocol");
const { writeAtomic } = require("./storage");

const ID_RE = /^[A-Za-z0-9][\w.-]{0,63}\.(css|js)$/;

function validId(id) { return typeof id === "string" && ID_RE.test(id) && id.indexOf("..") === -1; }
function kindOf(id) { return /\.js$/i.test(id) ? "js" : "css"; }

function readMeta(file) {
    try {
        const o = JSON.parse(fs.readFileSync(file, "utf8"));
        const disabled = Array.isArray(o && o.disabled) ? o.disabled.filter(validId) : [];
        return { disabled: disabled };
    } catch (e) { return { disabled: [] }; }
}

function writeMeta(file, meta) {
    const disabled = Array.from(new Set((meta.disabled || []).filter(validId))).sort();
    writeAtomic(file, JSON.stringify({ disabled: disabled }, null, 2));
}

/** Все сниппеты папки: [{id, kind, enabled, size, file, code, error}]. Порядок — по имени. */
function listSnippets(dir, meta) {
    const off = new Set((meta && meta.disabled) || []);
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return []; }
    const out = [];
    names.filter(validId).sort((a, b) => a.localeCompare(b)).slice(0, P.MAX_SNIPPETS).forEach((id) => {
        const file = path.join(dir, id);
        let st;
        try { st = fs.lstatSync(file); } catch (e) { return; }
        if (!st.isFile()) return;                     // симлинки и папки не разворачиваем
        const item = { id: id, kind: kindOf(id), enabled: !off.has(id), size: st.size, file: file, code: "", error: "" };
        if (st.size > P.MAX_SNIPPET) item.error = "больше " + Math.round(P.MAX_SNIPPET / 1024) + " КБ — пропущен";
        else {
            try { item.code = fs.readFileSync(file, "utf8").replace(/^﻿/, ""); }
            catch (e) { item.error = "не читается: " + (e.code || e.message); }
        }
        out.push(item);
    });
    return out;
}

/** Состояние для окна: включённые сниппеты + дополнительные поля (конструктор). rev — отпечаток всего. */
function buildState(list, extra) {
    const snippets = list.filter((s) => s.enabled && !s.error).map((s) => ({ id: s.id, kind: s.kind, code: s.code }));
    const body = Object.assign({ snippets: snippets }, extra || {});
    const rev = crypto.createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 16);
    return Object.assign({ v: P.VERSION, rev: rev }, body);
}

/** Записать состояние, только если оно изменилось. true — записали. */
function writeState(file, state) {
    let prev = "";
    try { prev = fs.readFileSync(file, "utf8"); } catch (e) {}
    const next = JSON.stringify(state);
    if (prev === next) return false;
    writeAtomic(file, next);
    return true;
}

/** Свободное имя вида base.css, base-2.css, ... */
function freeId(dir, base, ext) {
    const clean = String(base || "snippet").toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 50) || "snippet";
    for (let i = 1; i < 1000; i++) {
        const id = clean + (i === 1 ? "" : "-" + i) + "." + ext;
        if (!fs.existsSync(path.join(dir, id))) return id;
    }
    return clean + "-" + Date.now() + "." + ext;
}

module.exports = { validId, kindOf, readMeta, writeMeta, listSnippets, buildState, writeState, freeId };
