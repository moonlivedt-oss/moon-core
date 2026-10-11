<div align="center">

[Русский](README.md) · **English**

<img src="extension/media/icon.svg" alt="Moon Core logo" width="96">

# Moon Core

### Reshape the VS Code interface: click any element to hide, resize or recolor it

UI designer · look profiles and a style gallery · live CSS/JS snippets<br>
undo and safe mode · element picker · modules · zero dependencies

[![CI](https://github.com/moonlivedt-oss/moon-core/actions/workflows/ci.yml/badge.svg)](https://github.com/moonlivedt-oss/moon-core/actions/workflows/ci.yml)
![version](https://img.shields.io/badge/version-0.1.0-cba6f7)
![vscode](https://img.shields.io/badge/VS%20Code-%5E1.85-007ACC?logo=visualstudiocode&logoColor=white)
![tests](https://img.shields.io/badge/tests-207%20ok-a6e3a1)
![deps](https://img.shields.io/badge/dependencies-0-brightgreen)
![license](https://img.shields.io/badge/license-MIT-green)

<sub>Own .vsix packer · one-command install · removal restores the VS Code shell byte for byte</sub>

</div>

---

> The interface of the extension (commands, panels, messages) is in Russian. The full
> documentation is in the [Russian README](README.md); this page is a short overview.

## Quick start

```bash
npm run package                                   # build dist/moon-core-<version>.vsix
code --install-extension dist/moon-core-0.1.0.vsix
```

Restart VS Code: on first launch Moon Core injects itself into the shell (it finds VS Code and
its own data folder by itself) and offers to reload the window. The designer is the button on the
Moon Core panel or `Moon Core: Конструктор интерфейса`.

Separately:

```bash
npm run build            # build the window runtime from extension/runtime/src/
npm test                 # all tests (207 checks, no VS Code needed)
npm run e2e              # run in a real VS Code (downloaded once into .vscode-test/)
```

Uninstall: `Moon Core: Убрать из VS Code`, then `Ctrl+Shift+X` → "Moon Core" → Uninstall.

> Moon Core is distributed as its own `.vsix`, not via the Marketplace: it patches VS Code's own
> files, which the Marketplace does not allow. See [SECURITY.md](SECURITY.md) for details and risks.

## What it is

A customization platform for the VS Code interface. It is an extension (the host) plus a runtime
injected into the editor shell (`workbench.html`). That lets Moon Core do what the extension API
cannot — change any element of the interface — while keeping full access to the API: commands,
files and the editor.

| | VS Code settings | Custom CSS and JS Loader | Moon Core |
|---|---|---|---|
| Change any element of the window | no (only what settings expose) | yes, by hand in CSS | **yes — click the element** |
| No code required | yes | no | **yes — designer, profiles, style gallery** |
| Undo | one setting at a time | no | **yes — up to 40 steps, look backups** |
| Live CSS preview | — | no (window reload) | **yes — on every keystroke** |
| "Installation is corrupt" banner | — | yes | **no — the shell checksum is recalculated** |
| After a VS Code update | — | re-enable by hand | **re-injects itself, heals changes by fingerprint** |
| When something breaks | — | edit files by hand | **kill switch, safe mode, Doctor, emergency restore** |
| External dependencies | — | — | **none (0 npm packages)** |

---

## Features

| Feature | What it does |
|---|---|
| **Designer** | Hover an element to see what it is, click to edit it: hide, opacity, background, radius, zoom, padding, size, font and color. If VS Code has a setting for the element (minimap, breadcrumbs, tabs, activity bar...), it is shown first. Every change is listed on the "Changes" tab and can be undone; settings return to their original values. |
| **On-element handles** | Drag the frame of the selected element to change width, height, zoom, padding, or its order among siblings. |
| **Theme colors** | Change the theme color that paints an element via `workbench.colorCustomizations`, and code colors via `editor.tokenColorCustomizations`. |
| **Conditions** | Limit any change to a language, branch, project, or light/dark theme. |
| **Undo and backups** | Undo / redo up to 40 steps (`Ctrl+Z` / `Ctrl+Y` in the designer); the look is backed up automatically before a profile, a reset or an import (12 latest copies). |
| **Kill switch and safe mode** | `Ctrl+Alt+Shift+Backspace` turns all Moon Core styles off in this window, with no connection to the extension needed. Safe mode (`Ctrl+Alt+Shift+F12`) disables snippets, changes, effects and modules in every window without deleting anything. The designer refuses to hide the window root, the editor area or its own UI. |
| **Style gallery** | 15 ready-made styles toggled with checkboxes, previewed live; each is a plain snippet file. |
| **Styles inside webviews** | Snippets named `webview*.css` reach extension pages and the Markdown preview (off by default). |
| **Profiles** | Save the whole look as a profile; built-ins: Minimal, Code only, Large, Zen, Presentation, Compact. Profiles can switch automatically by language, folder, branch, theme or time of day, or come with a project in `.vscode/mooncore.json` (applied only after you agree). |
| **Self-healing** | After a VS Code update, broken selectors are detected and re-bound by fingerprint; the injection is offered again. |
| **Snippets** | Plain `.css` and `.js` files. Unsaved CSS is previewed live on every keystroke. JS snippets get the `mc` helper (`watch`, `el`, `mount`, `css`, `on`, `every`, `command`, `toast`). |
| **Picker** | `Ctrl+Alt+Shift+C`: point at an element to hide it, copy its selector or start a CSS rule. |
| **Modules** | Other extensions (or folders) can ship a runtime that Moon Core injects with its own block: events, requests, a data file, profile integration, hot reload in dev mode. Typed API in `extension/types/mooncore.d.ts`. |
| **Transfer** | Export/import the whole look to a file, or sync it via Settings Sync (`moonCore.sync`). |
| **Doctor** | One page with the full state and fix buttons, including the integrity of VS Code's own files; copies a sanitized report for issues. |
| **VS Code speed** | What slows your startup: load and `activate()` time of every extension in this session (from VS Code's own extension-host performance marks), window startup phases, startup history with slowdown detection, main-thread freezes per window, heavy project folders, and fact-based setting advice with Apply / Revert. Measurements are kept in `mooncore-perf.json`; its `export` field (schema `moon-core/perf@1`) is meant for external tools such as VS Code Launcher. |

---

## How it works

- The extension injects its block between `<!-- MOONCORE-START -->` and `<!-- MOONCORE-END -->`
  and adds only its own nonce, bridge ports and Trusted Types policy to the CSP. Other loaders'
  blocks are left alone. The `product.json` checksum is recalculated, so there is no
  "installation is corrupt" banner; removal restores the original.
- The window reads `mooncore-state.json` at startup (styles are there before any connection), then
  connects to the bridge of every open VS Code window: HTTP on `127.0.0.1` with a random token and
  Server-Sent Events.
- Writes to the shell are all-or-nothing with rollback, guarded by a cross-process lock; if
  VS Code is in Program Files, one UAC-elevated write is offered instead of an error.
- If VS Code does not start after injection, close it and run `moon-core-restore.cmd` from the
  extension's data folder.

---

## FAQ / Troubleshooting

**A change hid something I need and I cannot reach the designer.**
`Ctrl+Alt+Shift+Backspace` is the kill switch: it turns all Moon Core styles off in this window.
Then use Undo in the designer or `Moon Core: Восстановить вид из резервной копии`.

**Is Moon Core to blame?**
Run `Moon Core: Безопасный режим` (`Ctrl+Alt+Shift+F12`). If the problem is still there, it is
not Moon Core.

**After a VS Code update my changes are gone.**
An update recreates the shell. Moon Core re-injects itself (`moonCore.autoReinject`); reload the
window. If VS Code renamed its classes, "Починить" in the Doctor re-binds the changes.

**VS Code does not start.**
Close it and run `moon-core-restore.cmd` from the extension's data folder
(`%APPDATA%\Code\User\globalStorage\moonlivedt.moon-core\`).

**Found a bug or have an idea.**
Open an [issue](https://github.com/moonlivedt-oss/moon-core/issues) (attach the Doctor report) or
go to [Discussions](https://github.com/moonlivedt-oss/moon-core/discussions).

---

## Build

No dependencies, no `npm install` — the scripts just call `node` (Node 22+).

```bash
npm run build            # build the window runtime from its parts
npm test                 # build check + smoke (159) + window runtime (48), no VS Code needed
npm run package          # build dist/moon-core-<version>.vsix
npm run e2e              # real VS Code in .vscode-test/ (downloads it once)
node test/serve.js       # http://localhost:8792/test/fixture.html — runtime on a mock UI with a real bridge
```

On every `push` / `pull request` to `main` GitHub Actions runs `npm test` on Windows and Linux
and builds the `.vsix`. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Privacy

Moon Core **makes no network requests** and collects no telemetry. The bridge between the window
and the extension listens on `127.0.0.1` only. Changes, profiles and snippets stay in the
extension's `globalStorage` on this machine; they travel through Settings Sync only if you turn
`moonCore.sync` on. Code reaches the window only after you have seen and approved it — see
[SECURITY.md](SECURITY.md).

---

## Limitations

- Installed from its own `.vsix`: the extension patches VS Code's files, which the Marketplace
  does not allow.
- The element catalog and selectors follow VS Code's markup: after an update some changes may
  stop matching (the selector check and "Починить" catch that).
- Deep integration relies on VS Code's internal API, which changes between versions; both parts
  are off by default.
- The interface of the extension is in Russian.

---

## History

All changes are in [CHANGELOG.md](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE).

---

<div align="center">
  <sub><b>Moon Core</b> — the VS Code interface your way: click an element, undo anything, zero dependencies.</sub>
  <br>
  <sub>Found a bug or have an idea? — <a href="https://github.com/moonlivedt-oss/moon-core/issues">Issues</a> · <a href="https://github.com/moonlivedt-oss/moon-core/discussions">Discussions</a></sub>
</div>
