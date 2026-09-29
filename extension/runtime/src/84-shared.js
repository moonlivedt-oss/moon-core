    // ---------------------------------------------------------------------------
    //  Общая шина модулей одного окна: mc.share("accent", "#89b4fa") в одном модуле и
    //  mc.shared("accent", fn) в другом. Значение — JSON (до 64 КБ), у каждого ключа есть автор
    //  (id модуля): подписчик получает (value, from). Выключенный модуль забирает свои значения.
    //  Договорённости о ключах — в types/mooncore.d.ts (SharedKeys).
    // ---------------------------------------------------------------------------
    var SHARED = {};         // key -> { value, from }
    var sharedSubs = {};     // key -> [fn]
    var SHARED_KEY_RE = /^[a-z][\w.-]{0,63}$/i;
    var SHARED_MAX = 65536;

    function sharedFire(key) {
        var rec = SHARED[key];
        (sharedSubs[key] || []).slice().forEach(function (fn) {
            try { fn(rec ? JSON.parse(JSON.stringify(rec.value)) : undefined, rec ? rec.from : ""); } catch (e) { report("общая шина: " + key, e); }
        });
    }

    /** Записать значение (undefined — убрать). true — принято. */
    function shareValue(from, key, value) {
        if (!SHARED_KEY_RE.test(String(key))) return false;
        if (value === undefined) {
            if (!SHARED[key]) return true;
            delete SHARED[key];
            sharedFire(key);
            return true;
        }
        var text;
        try { text = JSON.stringify(value); } catch (e) { return false; }
        if (text === undefined || text.length > SHARED_MAX) return false;
        if (SHARED[key] && SHARED[key].from === from && JSON.stringify(SHARED[key].value) === text) return true;
        SHARED[key] = { value: JSON.parse(text), from: from };
        sharedFire(key);
        return true;
    }

    /** Подписка: fn(value, from). Текущее значение — сразу (асинхронно). Возвращает отписку. */
    function sharedOn(key, fn) {
        if (!SHARED_KEY_RE.test(String(key)) || typeof fn !== "function") return function () {};
        var list = (sharedSubs[key] = sharedSubs[key] || []);
        list.push(fn);
        if (SHARED[key]) setTimeout(function () {
            var rec = SHARED[key];
            if (rec && list.indexOf(fn) !== -1) { try { fn(JSON.parse(JSON.stringify(rec.value)), rec.from); } catch (e) { report("общая шина: " + key, e); } }
        }, 0);
        return function () { var i = list.indexOf(fn); if (i !== -1) list.splice(i, 1); };
    }

    function sharedGet(key) {
        var rec = SHARED[key];
        return rec ? { value: JSON.parse(JSON.stringify(rec.value)), from: rec.from } : undefined;
    }

    /** Модуль выключен — его значения уходят (подписчики получают undefined). */
    function sharedDrop(from) {
        Object.keys(SHARED).forEach(function (k) { if (SHARED[k].from === from) { delete SHARED[k]; sharedFire(k); } });
    }
