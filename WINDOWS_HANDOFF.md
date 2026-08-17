# SASSHY QUEST: Windows Codex handoff

## What transfers automatically

- The application source and release history transfer through GitHub.
- SASSHY task data transfers through the app's Supabase sync after the same
  URL, publishable key, and sync key are configured in the browser/PWA.
- A local Codex chat should not be treated as the only project memory. Durable
  rules and current architecture are stored in this repository.

## First setup on Windows

1. Install the ChatGPT desktop app for Windows and sign in with the same
   ChatGPT account used on Mac.
2. Install Git and Node.js LTS. Enable Corepack so `pnpm` is available.
3. Clone the repository in PowerShell:

```powershell
git clone https://github.com/sasshy/sasshy-quest.git
cd sasshy-quest
```

4. In Codex, open the cloned `sasshy-quest` folder as the local project.
5. Start a new Codex chat with this message:

```text
AGENTS.md、WINDOWS_HANDOFF.md、v2-src/README.mdを読んで、
git statusと直近5コミットを確認してください。
SASSHY QUEST v2の続きとして、既存データを消さない方針を最優先にしてください。
```

6. Verify the project:

```powershell
cd v2-src
corepack enable
pnpm install
pnpm test
pnpm build
```

## Using SASSHY on the Windows PC

Use the production URL:

`https://sasshy.github.io/sasshy-quest/v2/`

Open Settings and enter the same Supabase URL, publishable key, and sync key as
the Mac/iPhone installation. Do not send those values in a Codex chat or commit
them to Git. Turn on automatic sync and use `今すぐ同期` once. Confirm that the
task counts and several recent task titles match before editing on Windows.

## Current release state

- Current release: v2.5.0
- Latest feature: reliable daily task reordering shared by Today and Calendar
- Today view has up/down controls for deterministic mobile reordering.
- Calendar day view has a matching task-order panel.
- Reordering timed adjacent tasks swaps their start times and queues sync.
- Tests at v2.5.0: 40 passing

## Important history

The legacy v71 HTML app suffered from old-device overwrites and unstable
timeline behavior. v2 was created specifically to avoid those failure modes.
Do not port old whole-document synchronization or merge logic into v2.

Current v2 stability principles:

- IndexedDB is the immediate local source of truth.
- Sync is record-by-record through an outbox.
- Local edits survive network failures.
- Task completion time and scheduled calendar time remain separate.
- Deletes go to recoverable trash/history.
- Calendar interactions pause automatic sync while manipulation is active.

## Publishing from Windows

Do not edit `v2/` by hand. Edit `v2-src/`, run tests and build, copy the build
output into `v2/`, remove old hashed assets, and commit both source and output.
Push to `main` only after desktop/mobile verification. GitHub Pages publishes
the `v2/` directory.

## If the old Mac chat is not visible

That is not a blocker. The Git repository, this handoff, and `AGENTS.md` contain
the durable context. Ask the Windows Codex to inspect commit history before
making changes. The Mac can still be used to add a new note here whenever a
decision needs to be preserved for both computers.
