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
        rpc<T = Json>(method: string, body?: Json): Promise<RpcResult<T>>;
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
    }

    interface NativeApi {
        /** Элемент статусбара VS Code от имени модуля; dispose: true — убрать. */
        statusItem(id: string, props: { text?: string; tooltip?: string; side?: "left" | "right"; priority?: number; name?: string;
            hidden?: boolean; dispose?: boolean; warning?: boolean; error?: boolean }): Promise<RpcResult<null>>;
        /** Уведомление; результат — нажатая кнопка или null. */
        notify(text: string, opts?: { kind?: "info" | "warning" | "error"; buttons?: string[] }): Promise<RpcResult<string | null>>;
        /** Выбор из списка VS Code; результат — value (или label) выбранного, массив при many. */
        quickPick(items: (string | { label: string; description?: string; detail?: string; value?: Json })[], opts?: { placeholder?: string; many?: boolean }): Promise<RpcResult<Json>>;
        /** Строка ввода; null — отменили. */
        input(prompt: string, value?: string): Promise<RpcResult<string | null>>;
        /** Открыть файл в редакторе (абсолютный путь). */
        open(path: string, opts?: { preview?: boolean }): Promise<RpcResult<null>>;
        /** Прочитать настройку VS Code. */
        config(key: string): Promise<RpcResult<Json>>;
        /** Контекст окна: язык активного файла, ветка, папка, вид темы. */
        context(): Promise<RpcResult<{ lang: string; branch: string; folder: string; theme: string }>>;
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
        /** Короткий устойчивый CSS-селектор для элемента интерфейса. */
        selectorFor(el: Element): string;
        /** Сервисы окна (глубокая интеграция). */
        readonly services: { available(): boolean; get<T = any>(name: string): T | null; names(): string[] };
        startPick(): void;
        startDesign(): void;
        stopDesign(): void;
        stopPick(): void;
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
        publish(event: string, data?: Json, opts?: { scope?: "all" | "window" }): void;
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
    }
}

interface Window {
    __MOONCORE__?: MoonCore.WindowApi;
}
