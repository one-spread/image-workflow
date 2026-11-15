# Community directory review fix — 2026-11-15

Goal: find why Image Workflow does not pass the community.obsidian.md automated review and prepare 1.3.2.

- [x] Reproduce the review pipeline locally: `npm ci` (npm 10 and 11), `npm run build`, compare with 1.3.1 release assets → byte-identical; attestations exist for all three assets.
- [x] Lint with `eslint-plugin-obsidianmd` 0.6.0 using the scanner's ignore list instead of the repo's own ignores.
  - Found one error-level finding: `tests-image-editor.mjs:120` `no-console`. The repo ignored `tests-*.mjs` locally, but the scanner only skips `tests/` and `*.test.*`, so this root file was scanned as plugin code.
- [x] Move it to `tests/image-editor.test.mjs` and update the `test` script and ESLint ignores.
- [x] Add a README Disclosures section (network use for remote images, clipboard, no files outside the vault, no accounts/ads/telemetry), required by Obsidian developer policies.
- [x] Update `eslint-plugin-obsidianmd` to ^0.6.0.
- [x] Bump to 1.3.2 (manifest, package, lock, versions). `main.js` is unchanged by the bump.
- [ ] After merge: tag `1.3.2`, let the release workflow publish, then run the review again on community.obsidian.md and check the dashboard.

Unverified: the dashboard's actual error text was not available, so the cause above is the most likely candidate found locally, not a confirmed one.
