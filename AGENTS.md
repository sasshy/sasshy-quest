# SASSHY QUEST Development Guide

## Scope

- Production app: `https://sasshy.github.io/sasshy-quest/v2/`
- Source of truth: `v2-src/`
- GitHub Pages output: `v2/`
- The root single-file app is legacy. Do not add features there unless the user explicitly asks for a legacy fix.

## Working style

Keep the instruction stack small and bias toward completing the user's requested task.

- The user's explicit instructions take precedence over project workflow guidance and skill guidance, except where a higher-priority safety or data-integrity rule applies.
- Treat requests for action as instructions to do the work. Do not stop at acknowledging capability, proposing a plan, or offering to continue; persist until the intended task is complete within the available environment.
- Infer routine details from the request, nearby code, and existing conventions. Ask a question only when missing information could materially change the result, cause data loss, or trigger an external action the user did not request.
- Do not introduce approval pauses for reversible work, read-only inspection, reviews, or ordinary fixes already authorized by the user's request. When approval is genuinely required, first prepare the concrete result or decision point that can safely be reviewed.
- Prefer the smallest change that fully solves the task. Do not refactor unrelated code while fixing a focused issue.
- Default to a single agent. Do not spawn or delegate to subagents for ordinary code search, file reading, small edits, tests, or documentation. Use subagents only when the user explicitly asks, or when there are multiple genuinely independent workstreams and parallelism is likely to materially improve the result.
- Load or follow only skills relevant to the current task. Do not invoke skills "just in case." If a skill or instruction file would force a confirmation, block requested work, or conflict with the user's intent, identify the exact file and rule instead of silently stopping.
- Keep progress/final reports concise. Report what changed, verification performed, and any real unresolved risk.

## Product invariants

Reliability and low cognitive load are more important than clever automation.

1. Never replace the complete task collection during ordinary sync.
2. Store local edits first, then sync records individually.
3. A failed sync must not delete or roll back local data.
4. Destructive actions must remain recoverable through history or trash.
5. Prefer visible, deterministic controls over fragile drag-only interaction.
6. Keep the UI quiet and focused; hide unused controls instead of adding noise.
7. Preserve desktop and iPhone/PWA usability when an interaction is changed.

## Architecture

- React + TypeScript + Vite
- IndexedDB through Dexie for device-local data
- Supabase for record-by-record Mac/iPhone sync
- FullCalendar for day/week/month views
- Web Speech and Web Push for timer guidance and background notifications
- GitHub Pages deployment from the built `v2/` directory

Task, memo, session, history, and outbox records are separate. Do not reintroduce whole-state last-write-wins syncing or collection replacement.

## Context loading

At the start of a task, read this file first, then inspect only the context needed for that task.

- Read `WINDOWS_HANDOFF.md` only for Windows setup, cross-device handoff, or Windows publishing questions.
- Read `v2-src/README.md` when architecture, deployment, Supabase, push, or ChatGPT task-management context is relevant.
- In a mutable local checkout, inspect `git status` before editing so existing work is preserved. Inspect recent commits only when history is relevant to the requested change.
- Do not reset, discard, or overwrite unrelated existing changes.

## Validation proportional to risk

Run the minimum meaningful verification for the change. Do not repeat broad checks after they have passed unless new changes, failures, or unresolved concerns justify it.

- Documentation/instruction-only change: review the diff; runtime tests are normally unnecessary.
- Small isolated logic change: run the closest relevant test(s), plus TypeScript/build checks when they can catch integration errors.
- Sync, storage, auth, service worker, migration, or other data-sensitive change: run the relevant tests and `pnpm test` + `pnpm build` before release.
- UI interaction/layout change: verify the affected desktop and iPhone-width behavior. Do not require screenshots for non-UI changes.
- Do not add tests that merely mirror a reversible, low-impact implementation. Add tests when they protect meaningful behavior or a regression boundary.

Commands run from `v2-src/` when needed:

```bash
pnpm install
pnpm test
pnpm build
```

## Release and publishing

Do not deploy, push, or publish merely to complete a local implementation unless the user requested that external action.

For an actual release, build from `v2-src/`, replace generated `v2/assets/` with `v2-src/dist/assets/`, copy the other `dist/` files into `v2/`, remove stale hashed assets, and keep source plus built output together. Bump the package version and `v2-src/public/sw.js` cache name when the release requires a version bump.

Before publishing a runtime change, complete the validation appropriate to its risk and verify only the user-visible/sync-sensitive interactions touched by that change.

## Secrets and access boundaries

Never commit or paste secrets into repository documentation, including:

- Supabase publishable/service-role credentials
- SASSHY sync keys
- ChatGPT task-management bearer tokens
- VAPID private keys

Use existing browser settings or Supabase project secrets. The ChatGPT task-management Edge Function may access tasks only; do not broaden it to memos, timer history, or sync settings without explicit user approval.
