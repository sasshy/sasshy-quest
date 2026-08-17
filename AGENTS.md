# SASSHY QUEST Development Guide

## Current product

- Production app: `https://sasshy.github.io/sasshy-quest/v2/`
- Source of truth: `v2-src/`
- GitHub Pages output: `v2/`
- Current release: v2.5.0
- Repository: `https://github.com/sasshy/sasshy-quest`

The old single-file application at the repository root is legacy. Do not add
new features to it unless the user explicitly asks for a legacy fix.

## Product priorities

The owner has ADHD and uses the app on Mac Chrome and iPhone PWA. Reliability
is more important than clever automation.

1. Never replace the complete task collection during ordinary sync.
2. Store local edits first, then sync records individually.
3. A failed sync must not delete or roll back local data.
4. Destructive actions must remain recoverable through history or trash.
5. Prefer visible, deterministic controls over fragile drag-only interaction.
6. Keep the UI quiet and focused; hide unused controls instead of adding noise.
7. Test both desktop and iPhone-width layouts for interaction changes.

## Architecture

- React + TypeScript + Vite
- IndexedDB through Dexie for device-local data
- Supabase for record-by-record Mac/iPhone sync
- FullCalendar for day/week/month views
- Web Speech and Web Push for timer guidance and background notifications
- GitHub Pages deployment from the built `v2/` directory

Task, memo, session, history, and outbox records are separate. Do not reintroduce
whole-state last-write-wins syncing or collection replacement.

## Development workflow

Run commands from `v2-src/`:

```bash
pnpm install
pnpm test
pnpm build
```

After a successful build, replace the generated contents of `v2/assets/` with
`v2-src/dist/assets/`, and copy the other files from `v2-src/dist/` into `v2/`.
Remove stale hashed assets before committing. Bump both the package version and
the cache name in `v2-src/public/sw.js` for a release.

Before publishing:

1. Run tests and TypeScript/build checks.
2. Inspect desktop and iPhone-width screenshots.
3. Verify task creation, editing, completion, reordering, and sync-sensitive
   interactions touched by the change.
4. Commit source and built output together.
5. Push `main`, then confirm the new hashed assets and Service Worker are live.

## Secrets and data

Never commit or paste these into documentation:

- Supabase publishable key
- Supabase service-role key
- SASSHY sync key
- ChatGPT task-management bearer token
- VAPID private key

Use the existing browser settings or Supabase project secrets. The ChatGPT task
management Edge Function may access tasks only; do not broaden it to memos,
timer history, or sync settings without explicit approval.

## Start of a new Codex chat

Read these files first:

1. `AGENTS.md`
2. `WINDOWS_HANDOFF.md`
3. `v2-src/README.md`

Then run `git status`, inspect recent commits, and work with existing changes
instead of resetting them.
