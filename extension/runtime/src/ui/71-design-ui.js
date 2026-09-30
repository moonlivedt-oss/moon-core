    // ---- стили интерфейса конструктора
    var DES_CSS = [
        "[data-mooncore-ui=design]{position:fixed;right:12px;top:44px;width:340px;max-height:calc(100vh - 110px);overflow:auto;z-index:" + (Z + 2) + ";",
        "  box-sizing:border-box;padding:0 0 10px;border-radius:10px;font:12px/1.45 var(--vscode-font-family,sans-serif);",
        "  background:var(--vscode-editorWidget-background,#1e1e2e);color:var(--vscode-editorWidget-foreground,#cdd6f4);",
        "  border:1px solid var(--vscode-focusBorder,#89b4fa);box-shadow:0 12px 40px rgba(0,0,0,.45);}",
        "[data-mooncore-ui=design] *{box-sizing:border-box;}",
        "[data-mooncore-ui=design] .mc-h{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:8px;padding:10px 12px 8px;background:inherit;border-bottom:1px solid var(--vscode-widget-border,#313244);}",
        "[data-mooncore-ui=design] .mc-title{flex:1;font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
        "[data-mooncore-ui=design] .mc-tabs{display:flex;gap:4px;padding:8px 12px 0;}",
        "[data-mooncore-ui=design] .mc-tab{flex:1;padding:5px 0;border-radius:6px;border:1px solid transparent;background:none;color:inherit;font:inherit;cursor:pointer;opacity:.75;}",
        "[data-mooncore-ui=design] .mc-tab.on{opacity:1;border-color:var(--vscode-focusBorder,#89b4fa);background:color-mix(in srgb,var(--vscode-focusBorder,#89b4fa) 14%,transparent);}",
        "[data-mooncore-ui=design] .mc-sec{margin:10px 12px 0;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--vscode-foreground,#cdd6f4) 5%,transparent);}",
        "[data-mooncore-ui=design] .mc-sec h4{margin:0 0 6px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;opacity:.7;}",
        "[data-mooncore-ui=design] .mc-note{font-size:11px;opacity:.65;margin:2px 0 6px;}",
        "[data-mooncore-ui=design] .mc-row{display:flex;align-items:center;gap:6px;min-height:26px;}",
        "[data-mooncore-ui=design] .mc-row>label{flex:0 0 118px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
        "[data-mooncore-ui=design] .mc-row.set>label{color:var(--vscode-textLink-foreground,#89b4fa);}",
        "[data-mooncore-ui=design] .mc-ctl{flex:1;display:flex;align-items:center;gap:6px;min-width:0;}",
        "[data-mooncore-ui=design] input[type=range]{flex:1;min-width:0;accent-color:var(--vscode-focusBorder,#89b4fa);}",
        "[data-mooncore-ui=design] input[type=number],[data-mooncore-ui=design] input[type=text],[data-mooncore-ui=design] select{font:inherit;color:var(--vscode-input-foreground,#cdd6f4);background:var(--vscode-input-background,#11111b);border:1px solid var(--vscode-input-border,#45475a);border-radius:4px;padding:2px 5px;min-width:0;}",
        "[data-mooncore-ui=design] input[type=number]{width:58px;flex:0 0 58px;}",
        "[data-mooncore-ui=design] input[type=text],[data-mooncore-ui=design] select{flex:1;}",
        "[data-mooncore-ui=design] input[type=color]{width:34px;height:22px;padding:0;border:1px solid var(--vscode-input-border,#45475a);border-radius:4px;background:none;}",
        "[data-mooncore-ui=design] input[type=checkbox]{accent-color:var(--vscode-focusBorder,#89b4fa);}",
        "[data-mooncore-ui=design] .mc-x{flex:0 0 auto;width:20px;height:20px;border:none;border-radius:4px;background:none;color:inherit;opacity:.6;cursor:pointer;font:inherit;}",
        "[data-mooncore-ui=design] .mc-x:hover{opacity:1;background:color-mix(in srgb,var(--vscode-foreground,#cdd6f4) 12%,transparent);}",
        "[data-mooncore-ui=design] .mc-x.hid{visibility:hidden;}",
        "[data-mooncore-ui=design] .mc-btn{font:inherit;padding:4px 10px;border-radius:5px;cursor:pointer;color:inherit;background:transparent;border:1px solid var(--vscode-button-border,var(--vscode-focusBorder,#89b4fa));}",
        "[data-mooncore-ui=design] .mc-btn.pri{background:var(--vscode-button-background,#89b4fa);color:var(--vscode-button-foreground,#11111b);}",
        "[data-mooncore-ui=design] .mc-btn.danger{border-color:var(--vscode-errorForeground,#f38ba8);color:var(--vscode-errorForeground,#f38ba8);}",
        "[data-mooncore-ui=design] .mc-btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;}",
        "[data-mooncore-ui=design] .mc-sel{width:100%;font:11px var(--vscode-editor-font-family,monospace)!important;}",
        "[data-mooncore-ui=design] .mc-count{font-size:11px;opacity:.7;}",
        "[data-mooncore-ui=design] .mc-alt{margin-top:6px;}",
        "[data-mooncore-ui=design] .mc-drag{cursor:grab;opacity:.45;padding:0 2px;user-select:none;}",
        "[data-mooncore-ui=design] .mc-map:hover .mc-drag{opacity:.9;}",
        "[data-mooncore-ui=design] .mc-map.drop-before{box-shadow:inset 0 2px 0 var(--vscode-focusBorder,#89b4fa);}",
        "[data-mooncore-ui=design] .mc-map.drop-after{box-shadow:inset 0 -2px 0 var(--vscode-focusBorder,#89b4fa);}",
        "[data-mooncore-ui=design] .mc-count.bad{color:var(--vscode-errorForeground,#f38ba8);opacity:1;}",
        "[data-mooncore-ui=design] details>summary{cursor:pointer;opacity:.8;margin:2px 0 6px;}",
        "[data-mooncore-ui=design] .mc-card{margin:8px 12px 0;padding:8px 10px;border-radius:8px;border:1px solid var(--vscode-widget-border,#313244);}",
        "[data-mooncore-ui=design] .mc-card .mc-cap{font-weight:600;}",
        "[data-mooncore-ui=design] .mc-card code{display:block;font:10.5px var(--vscode-editor-font-family,monospace);opacity:.6;word-break:break-all;margin:2px 0 4px;}",
        "[data-mooncore-ui=design] .mc-line{display:flex;align-items:center;gap:6px;min-height:22px;}",
        "[data-mooncore-ui=design] .mc-line span{flex:1;}",
        "[data-mooncore-ui=design] .mc-empty{margin:14px 12px 4px;opacity:.7;}",
        "[data-mooncore-ui=design] .mc-tab{font-size:11.5px;}",
        "[data-mooncore-ui=design] .mc-pad{margin:10px 12px 0;}",
        "[data-mooncore-ui=design] .mc-map{display:flex;align-items:center;gap:7px;min-height:26px;}",
        "[data-mooncore-ui=design] .mc-map-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
        "[data-mooncore-ui=design] .mc-map-name small{opacity:.55;}",
        "[data-mooncore-ui=design] .mc-map.off .mc-map-name{opacity:.55;}",
        "[data-mooncore-ui=design] .mc-map.hidden-el .mc-map-name{text-decoration:line-through;opacity:.6;}",
        "[data-mooncore-ui=design] .mc-btn.mc-mini{padding:1px 8px;font-size:11px;opacity:.8;}",
        "[data-mooncore-ui=design] .mc-map:not(:hover) .mc-mini{opacity:.35;}",
        "[data-mooncore-ui=design] .mc-list{margin:0 0 4px 22px;padding-left:8px;border-left:1px solid var(--vscode-widget-border,#313244);}",
        "[data-mooncore-ui=design] .mc-sub{min-height:22px;font-size:11.5px;}",
        "[data-mooncore-ui=design] .mc-prof{margin-top:8px;padding:8px 10px;border-radius:8px;border:1px solid var(--vscode-widget-border,#313244);}",
        "[data-mooncore-ui=design] .mc-prof.on{border-color:var(--vscode-focusBorder,#89b4fa);}",
        "[data-mooncore-ui=design] .mc-prof-h{display:flex;align-items:center;gap:8px;}",
        "[data-mooncore-ui=design] .mc-prof-h small{opacity:.6;}",
        "[data-mooncore-ui=design] .mc-prof-h .mc-now{opacity:1;color:var(--vscode-textLink-foreground,#89b4fa);}",
        "[data-mooncore-ui=design-bar]{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);z-index:" + (Z + 2) + ";display:flex;align-items:center;gap:10px;",
        "  padding:6px 8px 6px 14px;border-radius:8px;font:12px/1.4 var(--vscode-font-family,sans-serif);",
        "  background:var(--vscode-focusBorder,#89b4fa);color:var(--vscode-button-foreground,#11111b);box-shadow:0 6px 24px rgba(0,0,0,.35);}",
        "[data-mooncore-ui=design-bar] button{font:inherit;padding:3px 10px;border-radius:5px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;white-space:nowrap;}",
        "[data-mooncore-ui=design-bar]{max-width:calc(100vw - 24px);box-sizing:border-box;}",
        "[data-mooncore-ui=design-bar] button:hover{background:color-mix(in srgb,currentColor 16%,transparent);}",
        "[data-mooncore-ui=design] .mc-search{display:block;width:calc(100% - 24px);margin:8px 12px 0;padding:4px 8px!important;}",
        "[data-mooncore-ui=design] .mc-btn:hover{background:color-mix(in srgb,var(--vscode-focusBorder,#89b4fa) 16%,transparent);}",
        "[data-mooncore-ui=design] .mc-btn.pri:hover{filter:brightness(1.12);}",
        "[data-mooncore-ui=design] .mc-tab:hover{opacity:1;}",
        "[data-mooncore-ui=design] button:focus-visible,[data-mooncore-ui=design] input:focus-visible,[data-mooncore-ui=design] select:focus-visible,[data-mooncore-ui=design-bar] button:focus-visible{outline:1px solid var(--vscode-focusBorder,#89b4fa);outline-offset:1px;}",
        "[data-mooncore-ui=design]::-webkit-scrollbar{width:8px;}",
        "[data-mooncore-ui=design]::-webkit-scrollbar-thumb{border-radius:4px;background:color-mix(in srgb,var(--vscode-foreground,#cdd6f4) 22%,transparent);}",
        "[data-mooncore-ui=design] .mc-swatches{display:flex;flex-wrap:wrap;gap:4px;margin:2px 0 6px;}",
        "[data-mooncore-ui=design] .mc-sw{width:18px;height:18px;padding:0;border-radius:4px;border:1px solid var(--vscode-input-border,#45475a);cursor:pointer;}",
        "[data-mooncore-ui=design] .mc-sw:hover{transform:scale(1.18);}",
        "[data-mooncore-ui=design] .mc-card.off{opacity:.55;}",
        "[data-mooncore-ui=design] .mc-icons{display:flex;flex-wrap:wrap;gap:3px;max-height:150px;overflow:auto;margin-bottom:4px;}",
        "[data-mooncore-ui=design] .mc-ico{width:26px;height:26px;padding:0;border-radius:5px;border:1px solid transparent;background:none;color:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;}",
        "[data-mooncore-ui=design] .mc-ico:hover,[data-mooncore-ui=design] .mc-ico.on{border-color:var(--vscode-focusBorder,#89b4fa);background:color-mix(in srgb,var(--vscode-focusBorder,#89b4fa) 14%,transparent);}",
        "@keyframes mc-in{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}",
        "@keyframes mc-bar-in{from{opacity:0;transform:translate(-50%,8px);}to{opacity:1;transform:translate(-50%,0);}}",
        "@media (prefers-reduced-motion:no-preference){[data-mooncore-ui=design]{animation:mc-in .16s ease-out;}[data-mooncore-ui=design-bar]{animation:mc-bar-in .16s ease-out;}",
        "  [data-mooncore-ui=design] .mc-btn,[data-mooncore-ui=design] .mc-tab,[data-mooncore-ui=design] .mc-x{transition:background-color .12s ease,opacity .12s ease,border-color .12s ease;}}",
    ].join("\n");

    function h(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }
    function btn(text, cls, fn, title) {
        var b = h("button", "mc-btn" + (cls ? " " + cls : ""), text);
        b.type = "button";
        if (title) b.title = title;
        b.addEventListener("click", function (e) { e.preventDefault(); fn(e); });
        return b;
    }
    function xBtn(visible, fn, title) {
        var b = h("button", "mc-x" + (visible ? "" : " hid"), "×");
        b.type = "button";
        b.title = title || "Вернуть как было";
        b.addEventListener("click", function (e) { e.preventDefault(); fn(); });
        return b;
    }
