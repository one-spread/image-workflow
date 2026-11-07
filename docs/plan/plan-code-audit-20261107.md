# Image Workflow code audit — 2026-11-07

User requested code inspection after the directory review failed. Do not send the prepared support request.

- [x] Inspect published source independently of the dashboard status.
- [x] Reproduce incorrect-MIME PNG private-data retention in clipboard fallbacks.
- [x] Fix PNG signature detection and editor disposal, including pending loads.
- [x] Run regression, official lint, type, browser and build checks; review changes.
- [ ] Publish a verified patch and record evidence in the existing vault note.

Do not claim these defects caused the directory scanner failure without evidence. Preserve data.json and the three pre-existing untracked plans.

Reviewed fixes: MIME/encoding-independent PNG private-data removal; unload and pending-load cleanup; save mutation lock; complete shape validation. Official lint/type check, 15 copy tests, editor regressions and real Chromium tests pass. Code, security and TypeScript reviews found no remaining blockers.
