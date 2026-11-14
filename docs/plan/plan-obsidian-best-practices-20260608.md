# Obsidian best practices pass

Date: 2026-06-08

## Goal

Refactor the plugin toward Obsidian plugin best practices rather than only matching review warnings.

## Source Guidance Checked

- Obsidian developer docs: `Component.registerDomEvent` for automatic cleanup.
- Obsidian pop-out window guide: prefer `element.doc`, `element.win`, and `element.instanceOf(...)`.
- Obsidian plugin guidelines: prefer CSS classes / CSS variables over inline plugin UI styles.
- Obsidian API docs: use `requestUrl` for HTTP requests.

## Scope

- Remove body-class cursor dependency and rely on plugin CSS being loaded only while the plugin is enabled.
- Use the originating element/document/window for overlay and rich-copy rendering instead of global active document/window where practical.
- Keep `MarkdownRenderer.render` on a short-lived `Component`, not the plugin instance.
- Keep release-review compatibility: no `fetch`, no `execCommand`, no direct plugin UI style assignment, no cross-window unsafe `instanceof`.
- Rebuild `main.js` and verify.

## Progress

- [x] Checked current Obsidian docs.
- [x] Created plan file.
- [x] Apply best-practice refactor.
- [x] Rebuild and verify.

## Verification

- Added missing `tslib` devDependency so the existing `importHelpers: true` TypeScript config works without overrides.
- `node node_modules/typescript/lib/tsc.js --noEmit` passed.
- `npm run build` passed and regenerated `main.js`.
- `npm audit --omit=dev` passed with 0 production vulnerabilities.
- `git diff --check` passed.
- Static scan no longer finds `fetch(`, `execCommand`, `instanceof HTMLImageElement`, `style.cssText`, direct `.style.`, `document.create*`, or `window.getSelection`.
- Remaining timer/animation calls are made through the relevant Obsidian window reference (`imgView.win`, `container.win`, or `doc.defaultView`), not the global window.
