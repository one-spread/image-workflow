# Obsidian Best Practices Review Plan

## Overview

- Task: Review Image Workflow changes against Obsidian plugin best practices
- Date: 2026-06-16
- Scope: Review only; no implementation unless separately approved
- Target repo: /Users/das/Documents/dev/_1sp/image-workflow

## Goal / KPI

- Identify any best-practice violations or residual risks before release.
- Prioritize findings by user impact and Obsidian review risk.

## Deliverables

- Code-review style findings in chat.
- Source-backed notes from official Obsidian docs.

## Scope

- Review main.ts, styles.css, manifest/package metadata, and built asset posture.
- Compare against official Obsidian plugin guidelines and load-time guidance.

## Non-Scope

- No code changes.
- No release/push/tag work.

## Requirements

- Findings first, ordered by severity.
- Use concrete file/line references.
- Separate confirmed findings from residual risks.

## Priority

- P0: Obsidian review blockers or runtime regressions.
- P1: Best-practice issues likely to be flagged.
- P2: Maintainability or release hygiene.

## Task Breakdown

1. Read repo instructions and diff.
2. Verify official Obsidian guidance.
3. Review code against guidance.
4. Summarize findings and verification status.

## Facts / Hypotheses / Opinions

### Facts

- Current repo has uncommitted 1.2.5 changes.
- Official Obsidian docs recommend using requestUrl over fetch, Plugin.loadData/saveData for plugin data, avoiding hardcoded styling where possible, keeping onload light, and production/minified main.js for release.

### Hypotheses

- The biggest remaining review risk is repository/release hygiene rather than runtime flicker.

### Opinions

- Treat main.js in repo as acceptable only if this repo intentionally keeps built release assets in Git.

## Review Criteria

- Obsidian API usage follows current official guidance.
- Runtime cleanup is automatic or explicit.
- Startup path is lightweight.
- Styling is scoped and not overriding core UI.
- Release metadata is consistent.

## Completion Criteria

- Review has concrete findings or explicitly says no high-severity issues found.

## Review Result

### Findings

- P1: Adapter API is still used for vault image binary reads. Prefer Vault API where a TFile can be resolved.
- P1: README does not have an explicit privacy/security disclosure for remote image fetches and vault image reads used for clipboard embedding.
- P2: main.js is tracked/modified in the repository, while Obsidian's checklist recommends release assets only. This may be an intentional repo convention, but it is a review hygiene risk.
- P2: main.ts is large and would benefit from module split after the bugfix ships.

### Positive Checks

- No fetch/axios usage remains; remote requests use requestUrl.
- Plugin data uses loadData/saveData.
- DOM listeners are registered through registerDomEvent.
- onload is lightweight and only performs settings load, event/command/settings registrations.
- Plugin UI styling is scoped through plugin CSS classes; flicker fix avoids direct runtime style writes for overlay positioning.
- Version metadata is aligned at 1.2.5.
- Verification build passed with npm run build.

### Sources

- Official Obsidian plugin self-critique checklist.
- Official Obsidian plugin load-time guide.
