# Human setup — Mission Control

Prerequisites only a human can do. Batch these up front so an AFK run isn't paged mid-issue. This is a **local desktop tool**, so there are no OAuth clients, API tokens, webhooks, or third-party app registrations — the list is short and all local.

## Toolchain (needed from issue 01 onward)

- [ ] **Node 22** on PATH. You use nvm; ensure the default is 22 (`nvm alias default 22`) so non-interactive shells get it too. Unblocks: 01 and everything after.
- [ ] **git** on PATH (worktree support — any modern git). Unblocks: 07, 08.

## Claude Code CLI (needed once Runs actually spawn — issue 03 onward)

- [ ] **`claude` CLI installed and authenticated** on this machine. Mission Control's PTY Session Manager spawns real interactive `claude` sessions, so the binary must be on PATH and already logged in (run `claude` once in a terminal and complete auth). Unblocks: 03, 06, 09, 10.
- [ ] If `claude` is not on the default PATH, note its absolute path — Mission Control will need a setting pointing at the binary. Config var name (in the app's local config, not a secret): `CLAUDE_BIN` (defaults to `claude` on PATH). Unblocks: 03.

## Not required

No `.env` secrets, no cloud credentials, no ports to open externally — the app is local-only and drives your already-authenticated local `claude`. If that changes (e.g. a hosted mode), revisit this file.
