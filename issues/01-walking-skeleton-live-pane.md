---
status: open
depends_on: []
---

# 01 — Walking skeleton: one live Pane

## Parent

`docs/PRD.md` — Mission Control.

## What to build

The thinnest end-to-end spine of the app: an Electron desktop app that boots, opens a single Project **Window**, and embeds one live **Pane** — an `xterm.js` terminal in the renderer, wired through the main process via `node-pty` to a real interactive process (a shell, or `claude` itself) that you can type into and get output from.

This proves the riskiest integration first: main-process PTY ↔ renderer `xterm.js` over Electron IPC. It establishes the **PTY Session Manager** (adapter: spawn/kill/pipe bytes) and the **IPC Contract** skeleton (typed messages main ↔ renderer), and sets the project's build toolchain and test runner for everything after.

Toolchain: use **electron-vite** with React + TypeScript unless there's a concrete reason not to; wire a unit-test runner (vitest) and `type-check` at the same time so later slices have them. Keep pure logic out of Electron-API-touching files so it stays importable and testable.

## Acceptance criteria

- [ ] `npm run dev` (or equivalent) launches the Electron app and opens a Window.
- [ ] The Window shows a terminal Pane rendered with `xterm.js`.
- [ ] Typing in the Pane reaches a real process via `node-pty` in the main process, and its output renders back — round-trip works.
- [ ] The process is spawned/piped/killed by a PTY Session Manager reachable only from the main process; the renderer talks to it over the IPC Contract, not directly.
- [ ] `npm run type-check` passes; `npm run test` runs (even if near-empty) and is wired for later slices.

## Blocked by

None - can start immediately.
