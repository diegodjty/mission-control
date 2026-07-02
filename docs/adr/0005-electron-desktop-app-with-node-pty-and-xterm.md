# Electron desktop app: Node main process + React renderer + node-pty + xterm.js

Mission Control is an **Electron** desktop app. The **main process** (Node) is the single backend/coordinator from ADR-0004 — it owns the `node-pty` sessions that run `claude`, the state store, and the worktree/merge lifecycle. Each **Project Window** is a **renderer process** running a **React + TypeScript** UI, with **xterm.js** rendering the live Panes. Main ↔ renderer communicate over Electron **IPC**; the terminal byte stream flows node-pty ↔ xterm.js.

## Considered Options

- **Local web app** (Node server + React UI opened in browser windows) — lightest to build, multi-window for free from the browser. Rejected as v1 because the user wants a genuine desktop-app feel (own window/icon/menus, no server-then-browser dance), which is a first-class requirement here.
- **Electron** (chosen) — real desktop app; same node-pty + xterm.js stack as VS Code; Node main process makes PTY spawning first-class; no new language.
- **Tauri** — rejected: Rust backend, which the user doesn't write, and `node-pty` doesn't run in it (would force a Rust PTY crate or a Node sidecar). Its bundle-size advantage doesn't outweigh that friction for a personal tool.

## Consequences

- Backend language is **Node/TypeScript**, not Django — the terminal-embedding ecosystem is Node, and this unifies the stack end-to-end. (Django familiarity was the pull toward the wrong choice.)
- Introduces Electron's **main/renderer/IPC** model as the one real learning curve: PTY spawning, state, and worktree/merge logic live in **main**; UI lives in **renderers**. Be deliberate about which code runs where.
- The main process being the single coordinator is a clean fit for "one backend, many windows" — each Project is its own `BrowserWindow`.
- Bundle size / memory (~Chromium) accepted as irrelevant for a personal, local dev tool. No code-signing needed for personal use.
