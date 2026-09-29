    // ---------------------------------------------------------------------------
    //  Trusted Types. В VS Code с CSP «require-trusted-types-for 'script'» строка не станет кодом
    //  (eval, <script>.textContent) и адресом скрипта (<script>.src) без политики из списка CSP.
    //  Moon Core вписывает туда «mooncore» при внедрении. Политика создаётся сразу при старте (имя
    //  не займёт чужой скрипт) и пропускает:
    //    - код — только ту строку, которую рантайм передал сам через trustedScript() (чанк
    //      интерфейса после сверки SHA-256, код модуля от хоста, JS-сниппет);
    //    - адрес — только файл модуля рядом с оболочкой (mooncore-mod-<id>.js).
    //  Нет Trusted Types (старый VS Code, стенд) — строки идут как есть.
    // ---------------------------------------------------------------------------
    var ttPolicy = null, ttScript = null;
    var TT_SRC_RE = /^mooncore-mod-[a-z0-9-]{2,32}\.js$/;
    try {
        if (window.trustedTypes && typeof window.trustedTypes.createPolicy === "function") {
            ttPolicy = window.trustedTypes.createPolicy("mooncore", {
                createScript: function (s) { if (s !== ttScript) throw new Error("Moon Core: непроверенный код"); return s; },
                createScriptURL: function (u) {
                    var base = typeof BOOT.moduleFileBase === "string" ? BOOT.moduleFileBase : "";
                    if (u.indexOf(base) !== 0 || !TT_SRC_RE.test(u.slice(base.length))) throw new Error("Moon Core: чужой адрес скрипта");
                    return u;
                },
            });
        }
    } catch (e) { ttPolicy = null; }   // имени нет в списке CSP — строки пойдут как есть
    function trustedScript(code) {
        if (!ttPolicy) return code;
        ttScript = code;
        try { return ttPolicy.createScript(code); } finally { ttScript = null; }
    }
    function trustedScriptUrl(u) { return ttPolicy ? ttPolicy.createScriptURL(u) : u; }
    /** Ошибка запрета кода из строки: CSP без unsafe-eval или Trusted Types. */
    function isCodeBlocked(e) {
        return (typeof EvalError === "function" && e instanceof EvalError) || /unsafe-eval|Content Security Policy|Trusted ?Type|TrustedScript/i.test(String(e && e.message || e));
    }
