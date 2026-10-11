    // ---------------------------------------------------------------------------
    //  Скорость VS Code: метки старта окна (code/* ставит сам VS Code, mooncore:* — мы),
    //  подвисания окна (Long Tasks API) и память JS окна. Хост собирает из них страницу
    //  «Скорость VS Code» и историю запусков. Только чтение: в работу окна ничего не вмешивается.
    // ---------------------------------------------------------------------------
    // Только этапы верхнего уровня (code/willX, code/didX) и свои: вложенных меток (чат, агенты,
    // восстановление по шагам) в VS Code 1.140 так много, что под лимитом терялись поздние
    // ключевые — didStartWorkbench и didLoadExtensions (поймал прогон в настоящем VS Code).
    var PERF_MARK_RE = /^(code\/(will|did)[A-Za-z]{2,60}|mooncore:[\w-]{1,40})$/;
    /** Метки окна: имя -> мс от начала загрузки окна (каждая — первое значение, не больше 120). */
    function vsMarks() {
        var out = {}, n = 0;
        try {
            var list = window.performance && performance.getEntriesByType ? performance.getEntriesByType("mark") : [];
            for (var i = 0; i < list.length && n < 120; i++) {
                var m = list[i];
                if (m && PERF_MARK_RE.test(m.name) && out[m.name] == null) { out[m.name] = Math.round(m.startTime); n++; }
            }
        } catch (e) {}
        return out;
    }
    // Подвисание — задача главного потока дольше FREEZE_MS (Long Tasks сообщает о задачах от 50 мс).
    // buffered: true — и те, что были до подписки (старт окна).
    var FREEZE_MS = 200;
    var freezes = { n: 0, ms: 0, max: 0 };
    function onLongTasks(entries) {
        for (var i = 0; i < entries.length; i++) {
            var d = Math.round(entries[i] && entries[i].duration || 0);
            if (d >= FREEZE_MS) { freezes.n++; freezes.ms += d; if (d > freezes.max) freezes.max = d; }
        }
    }
    try {
        if (typeof PerformanceObserver === "function") {
            new PerformanceObserver(function (list) { try { onLongTasks(list.getEntries()); } catch (e) {} }).observe({ type: "longtask", buffered: true });
        }
    } catch (e) {}
    /** Сводка для хоста: подвисания, память JS окна (МБ), сколько секунд окно открыто. */
    function perfInfo() {
        var heap = 0;
        try { if (window.performance && performance.memory) heap = Math.round(performance.memory.usedJSHeapSize / 1048576); } catch (e) {}
        return { freezes: freezes.n, freezeMs: freezes.ms, freezeMax: freezes.max, heapMb: heap, up: Math.round(now() / 1000) };
    }
