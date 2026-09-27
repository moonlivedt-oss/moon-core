<div align="center">

[Русский](README.md) · **English**

<img src="extension/media/icon.svg" alt="Moon Core logo" width="96">

# Moon Core

### Reshape the VS Code interface: click any element to hide, resize or recolor it

UI designer · look profiles · live CSS/JS snippets · element picker · modules · zero dependencies

[![CI](https://github.com/moonlivedt-oss/moon-core/actions/workflows/ci.yml/badge.svg)](https://github.com/moonlivedt-oss/moon-core/actions/workflows/ci.yml)
![version](https://img.shields.io/badge/version-0.1.0-cba6f7)
![vscode](https://img.shields.io/badge/VS%20Code-%5E1.85-007ACC?logo=visualstudiocode&logoColor=white)
![tests](https://img.shields.io/badge/tests-107%20ok-a6e3a1)
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

Restart VS Code and agree to inject Moon Core into the shell (or run `Moon Core: Внедрить в VS Code`),
then reload the window. The designer is the button on the Moon Core panel or
`Moon Core: Конструктор интерфейса`.

> Moon Core is distributed as its own `.vsix`, not via the Marketplace: it patches VS Code's own
> files, which the Marketplace does not allow. See [SECURITY.md](SECURITY.md) for details and risks.

## What it is

A customization platform for the VS Code interface. It is an extension (the host) plus a runtime
injected into the editor shell (`workbench.html`). That lets Moon Core do what the extension API
cannot — change any element of the interface — while keeping full access to the API: commands,
files and the editor.

## Features

| Feature | What it does |
|---|---|
| **Designer** | Hover an element to see what it is, click to edit it: hide, opacity, background, radius, zoom, padding, size, font and color. If VS Code has a setting for the element (minimap, breadcrumbs, tabs, activity bar...), it is shown first. Every change is listed on the "Changes" tab and can be undone; settings return to their original values. |
| **On-element handles** | Drag the frame of the selected element to change width, height, zoom, padding, or its order among siblings. |
| **Theme colors** | Change the theme color that paints an element via `workbench.colorCustomizations`, and code colors via `editor.tokenColorCustomizations`. |
| **Conditions** | Limit any change to a language, branch, project, or light/dark theme. |
| **Profiles** | Save the whole look as a profile; built-ins: Minimal, Code only, Large. Profiles can switch automatically by language, folder, branch, theme or time of day, or come with a project in `.vscode/mooncore.json` (applied only after you agree). |
| **Self-healing** | After a VS Code update, broken selectors are detected and re-bound by fingerprint; the injection is offered again. |
| **Snippets** | Plain `.css` and `.js` files. Unsaved CSS is previewed live on every keystroke. JS snippets get the `mc` helper (`watch`, `el`, `mount`, `css`, `on`, `every`, `command`, `toast`). |
| **Picker** | `Ctrl+Alt+Shift+C`: point at an element to hide it, copy its selector or start a CSS rule. |
| **Modules** | Other extensions (or folders) can ship a runtime that Moon Core injects with its own block: events, requests, a data file, profile integration, hot reload in dev mode. Typed API in `extension/types/mooncore.d.ts`. |
| **Transfer** | Export/import the whole look to a file, or sync it via Settings Sync (`moonCore.sync`). |
| **Doctor** | One page with the full state and fix buttons; copies a sanitized report for issues. |

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

## Development

```bash
npm run build     # after editing extension/runtime/src/
npm test          # build check, smoke tests, window runtime tests
npm run e2e       # real VS Code in .vscode-test/ (downloads it once)
node test/serve.js  # http://localhost:8792/test/fixture.html — runtime on a mock UI with a real bridge
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE) © moonlivedt
