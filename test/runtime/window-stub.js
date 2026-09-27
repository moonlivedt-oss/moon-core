// Заглушка окна VS Code для тестов рантайма: мини-DOM, поддельные EventSource и fetch,
// два поддельных хоста (как два окна VS Code). Используется test/runtime.js.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT = path.join(__dirname, "..", "..", "extension");
const RUNTIME = fs.readFileSync(path.join(EXT, "runtime", "mooncore-runtime.js"), "utf8");
const P = require(path.join(EXT, "lib", "protocol"));
const D = require(path.join(EXT, "lib", "design"));
const C = require(path.join(EXT, "lib", "catalog"));

// ------------------------------------------------------------------ заглушка DOM
class El {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.nodeType = tag === "#text" ? 3 : 1;
        this.children = [];
        this.parentNode = null;
        this.attrs = {};
        this.classList = makeClassList(this);
        this.style = {};
        this._text = "";
        this.listeners = {};
    }
    get className() { return this.classList._list.join(" "); }
    set className(v) { this.classList._list = String(v).split(/\s+/).filter(Boolean); }
    get id() { return this.attrs.id || ""; }
    set id(v) { this.attrs.id = String(v); }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
    set textContent(v) { this._text = String(v); this.children = []; }
    get firstElementChild() { return this.children.find((c) => c.nodeType === 1) || null; }
    get nextElementSibling() {
        if (!this.parentNode) return null;
        const sib = this.parentNode.children;
        for (let i = sib.indexOf(this) + 1; i < sib.length; i++) if (sib[i].nodeType === 1) return sib[i];
        return null;
    }
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === DOC_ROOT; }
    setAttribute(k, v) { if (k === "class") this.className = v; else this.attrs[k] = String(v); }
    getAttribute(k) { return k === "class" ? this.className : (k in this.attrs ? this.attrs[k] : null); }
    hasAttribute(k) { return k in this.attrs; }
    removeAttribute(k) { delete this.attrs[k]; }
    appendChild(c) { return this.insertBefore(c, null); }
    insertBefore(c, before) {
        if (c.parentNode) c.remove();
        c.parentNode = this;
        const i = before ? this.children.indexOf(before) : -1;
        if (i === -1) this.children.push(c); else this.children.splice(i, 0, c);
        return c;
    }
    remove() { if (this.parentNode) { const p = this.parentNode; p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; } }
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
    removeEventListener(ev, fn) { const l = this.listeners[ev] || []; const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1); }
    closest() { return null; }
    contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
    querySelector(sel) { return query(this, sel)[0] || null; }
    querySelectorAll(sel) { return query(this, sel); }
}
function makeClassList(el) {
    return {
        _list: [],
        add(...c) { c.forEach((x) => { if (!this._list.includes(x)) this._list.push(x); }); },
        remove(...c) { this._list = this._list.filter((x) => !c.includes(x)); },
        contains(c) { return this._list.includes(c); },
        toggle(c, on) { if (on === undefined ? !this.contains(c) : on) this.add(c); else this.remove(c); },
        [Symbol.iterator]() { return this._list[Symbol.iterator](); },
        get length() { return this._list.length; },
    };
}
// Мини-селекторы: тег, .класс, #id, [атрибут], [атрибут="значение"], потомок через пробел.
function matchSimple(el, simple) {
    const m = simple.match(/^([a-z][\w-]*)?((?:[.#][\w-]+|\[[^\]]+\])*)$/i);
    if (!m) throw new Error("селектор не поддержан заглушкой: " + simple);
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    const parts = m[2].match(/[.#][\w-]+|\[[^\]]+\]/g) || [];
    return parts.every((p) => {
        if (p[0] === ".") return el.classList.contains(p.slice(1));
        if (p[0] === "#") return el.id === p.slice(1);
        const a = p.slice(1, -1).match(/^([\w-]+)(?:="?([^"]*)"?)?$/);
        return a && (a[2] === undefined ? el.hasAttribute(a[1]) : el.getAttribute(a[1]) === a[2]);
    });
}
function matches(el, sel) {
    const chain = sel.trim().split(/\s+/);
    if (!matchSimple(el, chain[chain.length - 1])) return false;
    let i = chain.length - 2, n = el.parentNode;
    while (i >= 0 && n && n.tagName) { if (matchSimple(n, chain[i])) i--; n = n.parentNode; }
    return i < 0;
}
function query(root, sel) {
    const out = [];
    const groups = sel.split(",").map((s) => s.trim());
    (function walk(n) { n.children.forEach((c) => { if (groups.some((g) => matches(c, g))) out.push(c); walk(c); }); })(root);
    return out;
}

let DOC_ROOT = null;

// ------------------------------------------------------------------ окно с рантаймом
/**
 * Окно с рантаймом. opts:
 *   runtime  — "full" (mooncore-runtime.js, по умолчанию) или "core" (ленивая сборка mooncore-core.js);
 *   files    — { "vscode-file://vscode-app/...": текст } — что окно прочтёт из хранилища (XHR);
 *   protocol — location.protocol ("vscode-file:" включает чтение файлов хранилища);
 *   extra    — дополнительные свойства window.
 */
function makeWindow(boot, storage, opts) {
    const o = opts || {};
    const files = o.files || {};
    const html = new El("html");
    DOC_ROOT = html;
    const head = html.appendChild(new El("head"));
    const body = html.appendChild(new El("body"));
    const wb = body.appendChild(new El("div")); wb.className = "monaco-workbench";
    const side = wb.appendChild(new El("div")); side.className = "part sidebar";
    const bar = wb.appendChild(new El("div")); bar.className = "part statusbar";

    const esList = [];
    class FakeES {
        constructor(url) { this.url = url; this.listeners = {}; this.readyState = 1; esList.push(this); setImmediate(() => this.onopen && this.onopen()); }
        addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
        close() { this.readyState = 2; }
        emit(ev, data) { (this.listeners[ev] || []).forEach((fn) => fn({ data: JSON.stringify(data) })); }
    }
    const calls = [];
    const handlers = {};   // port -> (method, body) => object
    const fetchFn = (url, opts) => {
        const m = /^http:\/\/127\.0\.0\.1:(\d+)\/rpc\/[0-9a-f]{48}\/(\w+)$/.exec(url);
        const body = opts && opts.body ? JSON.parse(opts.body) : null;
        calls.push({ port: m && +m[1], method: m && m[2], body: body });
        const h = m && handlers[m[1]];
        const out = h ? h(m[2], body) : { ok: true };
        return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(out) });
    };
    const winListeners = {};
    let focused = true;
    const timers = [];
    const w = {
        console: { log() {}, warn() {}, error() {} },
        document: {
            documentElement: html, head: head, body: body,
            currentScript: { nonce: "" },
            createElement: (t) => new El(t),
            createTextNode: (t) => { const n = new El("#text"); n._text = String(t); return n; },
            querySelector: (s) => html.querySelector(s),
            querySelectorAll: (s) => html.querySelectorAll(s),
            getElementById: (id) => html.querySelector("#" + id),
            addEventListener() {}, removeEventListener() {},
            hasFocus: () => focused,
        },
        location: { protocol: o.protocol || "http:" },
        XMLHttpRequest: function () {
            const x = this;
            x.open = (m, url, async) => { x.url = String(url).split("?")[0]; x.async = async !== false; };
            x.send = () => {
                const t = files[x.url];
                x.status = t == null ? 404 : 200; x.responseText = t == null ? "" : t;
                if (x.async) setImmediate(() => (t == null && x.onerror ? x.onerror() : x.onload && x.onload()));
            };
        },
        crypto: require("crypto").webcrypto, TextEncoder: TextEncoder, Uint8Array: Uint8Array, EvalError: EvalError,
        EventSource: FakeES,
        fetch: fetchFn,
        AbortController: function () { this.signal = {}; this.abort = () => {}; },
        MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
        WeakSet: WeakSet, Promise: Promise, JSON: JSON, Object: Object, Array: Array, Date: Date, Math: Math,
        setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref && t.unref(); timers.push(t); return t; },
        clearTimeout: clearTimeout,
        setInterval: () => 0, clearInterval: () => {},
        requestAnimationFrame: (fn) => setImmediate(fn), cancelAnimationFrame: () => {},
        getComputedStyle: () => ({ getPropertyValue: () => "" }),
        addEventListener: (ev, fn) => { (winListeners[ev] = winListeners[ev] || []).push(fn); },
        removeEventListener: () => {},
        __MOONCORE_BOOT__: boot,
    };
    if (storage) w.localStorage = {
        getItem: (k) => (k in storage ? storage[k] : null),
        setItem: (k, v) => { storage[k] = String(v); },
    };
    if (o.extra) Object.assign(w, o.extra);                  // свои свойства окна (например, trustedTypes)
    w.window = w;
    vm.createContext(w);
    const name = o.runtime === "core" ? "mooncore-core.js" : "mooncore-runtime.js";
    vm.runInContext(name === "mooncore-runtime.js" ? RUNTIME : fs.readFileSync(path.join(EXT, "runtime", name), "utf8"), w, { filename: name });
    return {
        w, head, body, side, bar, esList, calls, handlers,
        mc: w.__MOONCORE__, files,
        setFocus(v) { focused = v; },
        fireWindow(ev) { (winListeners[ev] || []).forEach((fn) => fn({})); },
        es(port) { return esList.filter((e) => e.url.indexOf("127.0.0.1:" + port + "/") !== -1).pop(); },
        styles() { return head.children.filter((c) => c.tagName === "STYLE"); },
    };
}

const TOKA = "a".repeat(48), TOKB = "b".repeat(48);
function baseBoot(extra) {
    return Object.assign({
        v: P.VERSION, version: "test", proto: P.PROTOCOL,
        state: { v: 1, rev: "r0", snippets: [], design: { rules: {}, settings: {} }, props: D.propsSpec(), catalog: C.CATALOG, zones: C.ZONES },
        testHosts: [{ port: 1001, token: TOKA }, { port: 1002, token: TOKB }],
        modules: [{ id: "mlbg", name: "MoonLight BG", version: "20", base: "http://localhost/m/", data: { v: 1, cfg: { mode: "3" } } }],
    }, extra || {});
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

module.exports = { El, makeWindow, baseBoot, tick, TOKA, TOKB, P, D, C, EXT };
