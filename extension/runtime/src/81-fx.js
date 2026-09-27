    // ---------------------------------------------------------------------------
    //  Эффекты редактора: след за курсором, искры при наборе, свечение строки и курсора.
    //  Рисуются на одном прозрачном холсте поверх окна (клики сквозь него проходят); цикл
    //  анимации крутится, только пока эффект включён и есть что рисовать.
    // ---------------------------------------------------------------------------
    var FXSPEC = {};
    var fx = { canvas: null, ctx: null, raf: 0, trail: [], sparks: [], last: null, style: null, keyOn: false };

    function fxConf() { return DS.fx || {}; }
    function fxColor() {
        var f = fxConf();
        if (f.color) return f.color;
        var v = themeVars()["editorCursor-foreground"];
        return v && rgba(v) ? hex6(v) : "#89b4fa";
    }
    function fxCss() {
        var f = fxConf(), c = fxColor(), k = (f.intensity || 5);
        var out = [];
        if (f.lineGlow) out.push(".monaco-editor .view-overlays .current-line { box-shadow: 0 0 " + (4 + k * 2) + "px " + Math.round(k / 2) + "px " + c + "55 !important; border-radius: 3px; }");
        if (f.cursorGlow) out.push(".monaco-editor .cursors-layer .cursor { box-shadow: 0 0 " + (3 + k) + "px " + Math.max(1, Math.round(k / 3)) + "px " + c + " !important; }");
        return out.join("\n");
    }
    function cursorRect() {
        var c = null;
        try { c = document.querySelector(".monaco-editor.focused .cursors-layer .cursor") || document.querySelector(".monaco-editor .cursors-layer .cursor"); } catch (e) {}
        if (!c) return null;
        var r = c.getBoundingClientRect();
        return r.width || r.height ? r : null;
    }
    function ensureFxCanvas(on) {
        if (on && !fx.canvas && document.body) {
            var cv = document.createElement("canvas");
            cv.setAttribute("data-mooncore-ui", "fx");
            Object.assign(cv.style, { position: "fixed", left: "0", top: "0", width: "100vw", height: "100vh", pointerEvents: "none", zIndex: String(Z - 10) });
            document.body.appendChild(cv);
            fx.canvas = cv; fx.ctx = cv.getContext && cv.getContext("2d");
            fx.resize = function () {
                var d = window.devicePixelRatio || 1;
                cv.width = Math.round(window.innerWidth * d); cv.height = Math.round(window.innerHeight * d);
                if (fx.ctx) fx.ctx.setTransform(d, 0, 0, d, 0, 0);
            };
            fx.resize();
            window.addEventListener("resize", fx.resize);
        } else if (!on && fx.canvas) {
            window.removeEventListener("resize", fx.resize);
            fx.canvas.remove(); fx.canvas = fx.ctx = null;
            fx.trail = []; fx.sparks = [];
        }
    }
    function onFxKey(e) {
        var f = fxConf();
        if (!f.typingParticles || !e.target || !e.target.closest || !e.target.closest(".monaco-editor")) return;
        if (e.key.length !== 1 && e.key !== "Backspace" && e.key !== "Enter") return;
        setTimeout(function () {
            var r = cursorRect(); if (!r) return;
            var n = 3 + (f.intensity || 5);
            for (var i = 0; i < n; i++) {
                fx.sparks.push({ x: r.left, y: r.top + r.height / 2, vx: (Math.random() - 0.5) * 3.2, vy: -Math.random() * 2.8 - 0.6, life: 1, s: 1 + Math.random() * 2 });
            }
            if (fx.sparks.length > 400) fx.sparks.splice(0, fx.sparks.length - 400);
            fxLoop();
        }, 0);
    }
    function fxFrame() {
        fx.raf = 0;
        var f = fxConf(), g = fx.ctx;
        if (!g) return;
        var w = window.innerWidth, hgt = window.innerHeight, col = fxColor(), busy = false;
        g.clearRect(0, 0, w, hgt);
        if (f.cursorTrail) {
            var r = cursorRect();
            if (r) {
                var p = { x: r.left + 1, y: r.top, h: r.height, t: now() };
                if (!fx.last || fx.last.x !== p.x || fx.last.y !== p.y) fx.trail.push(p);
                fx.last = p;
            }
            var life = 120 + (f.intensity || 5) * 40, tNow = now();
            fx.trail = fx.trail.filter(function (q) { return tNow - q.t < life; });
            for (var i = 1; i < fx.trail.length; i++) {
                var a = fx.trail[i - 1], b = fx.trail[i], k = 1 - (tNow - b.t) / life;
                g.globalAlpha = Math.max(0, k * 0.8);
                g.strokeStyle = col; g.lineWidth = Math.max(1, b.h * 0.35 * k); g.lineCap = "round";
                g.beginPath(); g.moveTo(a.x, a.y + a.h / 2); g.lineTo(b.x, b.y + b.h / 2); g.stroke();
            }
            busy = busy || fx.trail.length > 1;
        }
        if (fx.sparks.length) {
            fx.sparks.forEach(function (s) { s.x += s.vx; s.y += s.vy; s.vy += 0.12; s.life -= 0.03; });
            fx.sparks = fx.sparks.filter(function (s) { return s.life > 0; });
            g.fillStyle = col;
            fx.sparks.forEach(function (s) { g.globalAlpha = Math.max(0, s.life); g.fillRect(s.x, s.y, s.s, s.s); });
            busy = true;
        }
        g.globalAlpha = 1;
        // След требует следить за курсором постоянно; без него — только пока летят искры.
        if (busy || f.cursorTrail) fx.raf = requestAnimationFrame(fxFrame);
    }
    function fxLoop() { if (!fx.raf && fx.canvas) fx.raf = requestAnimationFrame(fxFrame); }

    /** Применить текущие эффекты: стиль свечения, холст, слушатель набора. */
    function applyFx() {
        var f = fxConf();
        var css = fxCss();
        if (css && !fx.style) {
            fx.style = document.createElement("style");
            fx.style.setAttribute("data-mooncore", "~fx");
            if (NONCE) fx.style.setAttribute("nonce", NONCE);
        }
        if (fx.style) { if (fx.style.textContent !== css) fx.style.textContent = css; if (css && !fx.style.isConnected) headEl().appendChild(fx.style); if (!css) fx.style.remove(); }
        var need = !!(f.cursorTrail || f.typingParticles);
        ensureFxCanvas(need);
        if (need && !fx.keyOn) { window.addEventListener("keydown", onFxKey, true); fx.keyOn = true; }
        if (!need && fx.keyOn) { window.removeEventListener("keydown", onFxKey, true); fx.keyOn = false; }
        if (f.cursorTrail) fxLoop();
    }
