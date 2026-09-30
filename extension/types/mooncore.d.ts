// ============================================================
//  Moon Core — типы для авторов модулей (apiVersion 1).
//
//  В окне VS Code (рантайм модуля, JS с // @ts-check):
//      /// <reference path="./mooncore.d.ts" />
//      const mc = window.__MOONCORE__ && window.__MOONCORE__.module("my-mod");
//
//  В расширении-модуле (хост):
//      const api = await vscode.extensions.getExtension("moonlivedt.moon-core")?.activate();
//      const mod = (api as MoonCore.ExtensionApi).module("my-mod");
//
//  Файл лежит в расширении (types/mooncore.d.ts); команда «Moon Core: Создать модуль» кладёт
//  его копию в папку нового модуля.
// ============================================================

declare namespace MoonCore {
    /** Данные, которые можно передать через мост: только то, что переживает JSON. */
    type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

    /** Ответ запроса модуля к своему расширению. */
    interface RpcResult<T = Json> {
        ok: boolean;
        result?: T;
        error?: string;
    }

    /** Часть модуля в профиле вида Moon Core. */
    interface ProfileHooks<T extends object = { [key: string]: Json }> {
        /** Снимок состояния модуля — сохраняется в профиль (до 64 КБ JSON). */
        save(): T;
        /** Профиль применён (вручную или по контексту): вернуть состояние из снимка. */
        apply(part: T, profileName: string): void;
    }

    /** Помощник модуля в окне: window.__MOONCORE__.module(id). */
    interface ModuleApi {
        readonly id: string;
        readonly name: string;
        readonly version: string;
        /** Адрес папки ресурсов модуля (assets из манифеста) со слэшем на конце. */
        readonly base: string;
        /** Сколько раз модуль перезапущен горячей перезагрузкой (0 — обычный запуск окна). */
        readonly hot: number;
        /**
         * Подписка на событие своего расширения (mod.publish в хосте). Если значение уже есть,
         * fn получит его сразу (асинхронно). Возвращает отписку.
         */
        on<T = Json>(event: string, fn: (data: T) => void): () => void;
        /** Последнее значение события или undefined. */
        get<T = Json>(event: string): T | undefined;
        /** Запрос к своему расширению (обработчик mod.onRequest в хосте). */
        rpc<T = Json>(method: string, body?: Json, opts?: { timeoutMs?: number }): Promise<RpcResult<T>>;
        /** Ошибка модуля — в журнал Moon Core (Output «Moon Core»). */
        log(where: string, err?: unknown): void;
        /** Файл данных модуля: синхронно, прямо при старте окна. Объект или null. */
        data<T extends object = { [key: string]: Json }>(): T | null;
        /** Сохранить файл данных модуля (объект до 1 МБ JSON). Запись делает хост. */
        saveData(obj: object): Promise<{ ok: boolean; error?: string }>;
        /** Подключить модуль к профилям вида. false — если хуки не функции. */
        profile<T extends object>(hooks: ProfileHooks<T>): boolean;
        /**
         * Уборка перед горячей перезагрузкой (режим разработки): сними свои узлы, стили, таймеры и
         * флаг «уже запущен». Вызывается в обратном порядке регистрации.
         */
        onDispose(fn: () => void): void;
        /**
         * Настоящий API VS Code через хост своего окна — вместо подделок в вёрстке.
         * Клик по элементу статусбара приходит событием "nativeClick" ({ item }).
         */
        readonly vscode: NativeApi;
        /**
         * Сервис окна VS Code по имени (глубокая интеграция, moonCore.deepHooks) или null.
         * Это внутренний API VS Code: форма объекта меняется между версиями, проверяй наличие методов.
         */
        service<T = any>(name: string): T | null;
        /** Есть ли связь хотя бы с одним хостом Moon Core. */
        connected(): boolean;
        /** Части окна VS Code: видимость и размеры по вёрстке, переключение — командами VS Code (право layout). */
        readonly layout: LayoutApi;
        /** Команды модуля в «Moon Core: Команды модулей» и в контекстном меню редактора. */
        readonly commands: CommandsApi;
        /** Плавающее окно модуля (одно на id): перетаскивание, размер, прилипание, место запоминается. */
        window(opts?: WindowOptions): FloatingWindow;
        /** Общая шина модулей этого окна: записать значение (undefined — убрать). false — ключ или значение не годятся. */
        share(key: string, value: Json | undefined): boolean;
        /** Подписка на значение шины: fn(value, from — id модуля-автора). Текущее — сразу. Возвращает отписку. */
        shared<T = Json>(key: string, fn: (value: T | undefined, from: string) => void): () => void;
        sharedGet<T = Json>(key: string): { value: T; from: string } | undefined;
        /** Загрузить другой модуль (ленивый или выключенный раньше). */
        load(id: string): Promise<boolean>;
    }

    /** События VS Code для mc.vscode.on. Поля с пометкой «editor.read» приходят только с этим правом. */
    interface VsEvents {
        editor: { file: string; lang: string; scheme: string; /** расширение файла в нижнем регистре */ ext: string; dirty: boolean; lines: number; /** editor.read */ path?: string } | null;
        cursor: { line: number; col: number; selections: number; empty: boolean; /** editor.read */ word?: string; selection?: string; lineText?: string } | null;
        save: { file: string; lang: string; scheme: string; /** editor.read */ path?: string };
        diagnostics: { /** в активном файле */ errors: number; warnings: number; infos: number; /** по всему проекту */ totalErrors: number; totalWarnings: number; /** editor.read */ items?: { line: number; col: number; severity: number; message: string; source: string }[] };
        debug: { active: boolean; name: string; type: string };
        terminal: { count: number; active: string };
        task: { running: string[] };
        git: { branch: string; changes: number; /** «владелец/репо» из origin */ remote: string; /** первая папка проекта */ folder: string };
        theme: { kind: string; name: string };
    }

    /**
     * Договорённости о ключах общей шины (mc.share / mc.shared). Ключ — «<id модуля>.<имя>»,
     * пишет только этот модуль; остальные читают.
     */
    interface SharedKeys {
        /** Акцент текущего фона MoonLight BG. */
        "mlbg.accent": { hex: string; rgb: [number, number, number] };
        /** Текущий набор фона. */
        "mlbg.set": { index: number; name: string };
        /** Окно документации C++ открыто и какая статья в нём. */
        "cppdocs.view": { open: boolean; title: string };
    }

    /** Стиль подсветки кода: только #hex-цвета и значения из списков. */
    interface DecorationStyle {
        backgroundColor?: string; color?: string; borderColor?: string; outlineColor?: string;
        borderWidth?: number; borderStyle?: "solid" | "dashed" | "dotted"; borderRadius?: number;
        fontWeight?: "normal" | "bold" | "300" | "400" | "500" | "600" | "700"; fontStyle?: "normal" | "italic";
        textDecoration?: "none" | "underline" | "line-through" | "underline dotted" | "underline wavy" | "underline dashed";
        opacity?: number; isWholeLine?: boolean;
        overviewRulerColor?: string; overviewRulerLane?: "left" | "center" | "right" | "full";
        /** Надпись после текста строки (как подсказка). */
        after?: { contentText: string; color?: string; fontStyle?: "normal" | "italic" };
    }
    /** Диапазон в активном редакторе (строки и столбцы с 0; без end — до конца строки). */
    interface DecorationRange { line: number; start?: number; end?: number; hover?: string }

    type LayoutPart = "sidebar" | "panel" | "auxiliarybar" | "activitybar" | "statusbar" | "titlebar" | "editor" | "minimap";
    interface LayoutApi {
        visible(part: LayoutPart): boolean;
        sizes(): { [part: string]: { x: number; y: number; w: number; h: number; visible: boolean } };
        toggle(part: LayoutPart | "zen" | "maximizedPanel"): Promise<RpcResult<null>>;
        show(part: LayoutPart): Promise<RpcResult<null> & { changed?: boolean }>;
        hide(part: LayoutPart): Promise<RpcResult<null> & { changed?: boolean }>;
    }

    interface ModuleCommand {
        id: string;
        title: string;
        /** Языки файлов (languageId); пусто — любой файл. */
        langs?: string[];
        /** Показывать в контекстном меню редактора. */
        context?: boolean;
    }
    /** Контекст нажатия команды; слово, выделение и путь — с правом editor.read. */
    interface CommandContext { lang: string; line: number; word?: string; selection?: string; path?: string }
    interface CommandsApi {
        /** Объявить команды из окна (сверх манифеста). Возвращает число принятых. */
        register(list: ModuleCommand[]): number;
        on(id: string, fn: (ctx: CommandContext) => void): () => void;
    }

    interface WindowOptions {
        id?: string; title?: string; width?: number; height?: number; x?: number; y?: number;
        /** false — не показывать сразу. */
        show?: boolean;
        /** true — крестик прячет окно, а не закрывает его. */
        closeHides?: boolean;
        /** false — без внутренних отступов у body. */
        padding?: boolean;
    }
    interface FloatingWindow {
        readonly id: string;
        readonly el: HTMLElement;
        /** Сюда модуль кладёт содержимое (обычный DOM). */
        readonly body: HTMLElement;
        setTitle(t: string): FloatingWindow;
        show(): FloatingWindow;
        hide(): FloatingWindow;
        toggle(): FloatingWindow;
        isOpen(): boolean;
        dock(side: "left" | "right" | "top" | "bottom" | "center"): FloatingWindow;
        geometry(): { x: number; y: number; w: number; h: number };
        onClose(fn: () => void): FloatingWindow;
        close(): void;
    }

    interface NativeApi {
        /** Элемент статусбара VS Code от имени модуля; dispose: true — убрать. */
        statusItem(id: string, props: { text?: string; tooltip?: string; side?: "left" | "right"; priority?: number; name?: string;
            hidden?: boolean; dispose?: boolean; warning?: boolean; error?: boolean }): Promise<RpcResult<null>>;
        /** Уведомление, подписанное «[имя модуля]»; результат — нажатая кнопка или null. Не больше 10 в минуту. */
        notify(text: string, opts?: { kind?: "info" | "warning" | "error"; buttons?: string[] }): Promise<RpcResult<string | null>>;
        /** Выбор из списка VS Code; результат — value (или label) выбранного, массив при many.
         *  У модуля один вопрос за раз: пока открыт прежний, ответ { ok: false, busy: true }. */
        quickPick(items: (string | { label: string; description?: string; detail?: string; value?: Json })[], opts?: { placeholder?: string; many?: boolean }): Promise<RpcResult<Json>>;
        /** Строка ввода (заголовок — имя модуля); null — отменили. Один вопрос за раз, как у quickPick. */
        input(prompt: string, value?: string): Promise<RpcResult<string | null>>;
        /** Открыть файл в редакторе (абсолютный путь). Вне папок проекта, модуля и данных Moon Core —
         *  только после модального подтверждения пользователя. */
        open(path: string, opts?: { preview?: boolean }): Promise<RpcResult<null>>;
        /** Прочитать настройку VS Code. Настройки с секретами (token, password, apiKey, proxy...) не отдаются,
         *  у раздела они вырезаются. */
        config(key: string): Promise<RpcResult<Json>>;
        /** Контекст окна: язык активного файла, ветка, папка, вид темы. */
        context(): Promise<RpcResult<{ lang: string; branch: string; folder: string; theme: string }>>;
        /** Событие VS Code своего окна; текущее значение — сразу. Возвращает отписку. */
        on<K extends keyof VsEvents>(kind: K, fn: (data: VsEvents[K]) => void): () => void;
        last<K extends keyof VsEvents>(kind: K): VsEvents[K] | undefined;
        /** Код под курсором через языковой сервер (право editor.read). */
        symbol(what: "word" | "hover"): Promise<RpcResult<string>>;
        symbol(what: "definition"): Promise<RpcResult<{ path: string; line: number; col: number }[]>>;
        symbol(what: "symbols"): Promise<RpcResult<{ name: string; kind: number; detail: string; line: number; depth: number }[]>>;
        /** Подсветка в активном редакторе (право decorations); тот же key заменяет прежнюю. */
        decorate(key: string, style: DecorationStyle, ranges: DecorationRange[]): Promise<RpcResult<null> & { applied?: number }>;
        undecorate(key: string): Promise<RpcResult<null>>;
        /** Открытые вкладки по группам (пути — с правом editor.read). */
        tabs(): Promise<RpcResult<{ column: number; active: boolean; tabs: { label: string; active: boolean; dirty: boolean; pinned: boolean; path?: string }[] }[]>>;
    }

    /** Кнопка в интерфейсе от имени расширения (api.ui(owner).button). */
    interface UiButtonSpec {
        /** Латиница и цифры; уникален в пределах расширения (итоговый id кнопки выводится из владельца и этого id). */
        id: string;
        zone: "statusbar-left" | "statusbar-right" | "titlebar" | "editor";
        /** Имя значка codicon без $(): "rocket", "play"... */
        icon?: string;
        label?: string;
        tooltip?: string;
        /** Команда по клику. Необязательна, если задан onClick (тогда нужен icon или label). */
        command?: string;
        args?: Json[];
        order?: number;
        onClick?: () => void | Promise<void>;
    }
    interface UiApi {
        button(spec: UiButtonSpec): { id: string; dispose(): void };
    }

    /** window.__MOONCORE__ — рантайм Moon Core в окне VS Code. */
    interface WindowApi {
        readonly version: string;
        /** Помощник модуля; null — модуль с таким id не впечатан (не разрешён или выключен). */
        module(id: string): ModuleApi | null;
        /** Загрузить ленивый (или снова включить выключенный) модуль. */
        loadModule(id: string): Promise<boolean>;
        moduleState(id: string): { loaded: boolean; off: boolean; lazy: boolean } | null;
        /** Общая шина модулей — только чтение. */
        readonly shared: { get<T = Json>(key: string): { value: T; from: string } | undefined; on<T = Json>(key: string, fn: (value: T | undefined, from: string) => void): () => void };
        /** Короткий устойчивый CSS-селектор для элемента интерфейса. */
        selectorFor(el: Element): string;
        /** Сервисы окна (глубокая интеграция). */
        readonly services: { available(): boolean; get<T = any>(name: string): T | null; names(): string[] };
        startPick(): void;
        startDesign(): void;
        stopDesign(): void;
        stopPick(): void;
        /** «Стоп-кран»: выключить (true) или включить (false) все стили Moon Core в этом окне; без аргумента — переключить. */
        panic(on?: boolean): boolean;
        /** Состояние рантайма для отладки (DevTools). */
        info(): {
            rev: string;
            domReady: boolean;
            css: string[];
            js: string[];
            previews: string[];
            design: { rules: number; settings: number; on: boolean; queued: number };
            hosts: { port: number; open: boolean; own: boolean }[];
            modules: string[];
        };
    }

    /** Помощник модуля в расширении: api.module(id). */
    interface HostModuleApi {
        readonly id: string;
        /** Модуль найден и разрешён пользователем (иначе в окне его нет). */
        readonly active: boolean;
        /**
         * Событие модулю во всех окнах (до 256 КБ JSON). scope "window" — только окну этого хоста
         * (данные конкретного окна: ветка, открытый файл).
         */
        /** cache: false — разовое событие (клик, команда): новым окнам не повторяется. */
        publish(event: string, data?: Json, opts?: { scope?: "all" | "window"; cache?: boolean }): void;
        /** Обработчик запросов окна (mc.rpc). Один на модуль в этом хосте. */
        onRequest(fn: (method: string, body: Json) => Json | void | Promise<Json | void>): { dispose(): void };
        /** Файл данных модуля (его же окно читает при старте). */
        readData<T extends object = { [key: string]: Json }>(): T | null;
        writeData(data: object): void;
    }

    /** То, что возвращает activate() расширения Moon Core. */
    interface ExtensionApi {
        readonly apiVersion: 1;
        module(id: string): HostModuleApi;
        /** Интерфейс от имени расширения: owner — как подписать кнопки («от ...»). */
        ui(owner: string): UiApi;
    }

    /** Манифест модуля: mooncore-module.json в папке или moonCore.modules[] в package.json. */
    interface ModuleManifest {
        /** ^[a-z][a-z0-9-]{1,31}$ */
        id: string;
        name?: string;
        version?: string;
        /** Путь к рантайму относительно корня модуля (.js, до 4 МБ). */
        script: string;
        /** Папка ресурсов относительно корня (по умолчанию — сам корень). */
        assets?: string;
        /** Свои политики Trusted Types (до 4). */
        trustedTypes?: string[];
        /** Права сверх базовых: одобряет человек вместе с модулем. */
        capabilities?: ("editor.read" | "decorations" | "layout")[];
        /** Не грузить при старте окна: по команде, по mc.load / loadModule или через delay мс. */
        lazy?: boolean | { delay?: number };
        /** Команды модуля (палитра, контекстное меню редактора); ленивый модуль грузится по ним. */
        commands?: ModuleCommand[];
    }
}

interface Window {
    __MOONCORE__?: MoonCore.WindowApi;
}
