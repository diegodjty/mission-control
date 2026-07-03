---
status: done
depends_on: [9, 14]
---

# 19 — Open a Project via a native folder picker (browse, not just paste)

## Source

User request (2026-07-03): opening a Project currently requires copy-pasting the repo path into the text field. The user wants to click to browse for the folder — while keeping the ability to paste a path too (either/or).

## What to build

Add a **Browse…** control next to the repo-path input in the Project bar that opens the **native OS directory chooser** (Electron `dialog.showOpenDialog` with `properties: ['openDirectory']`, run in the main process and exposed over IPC). Choosing a folder populates the repo-path field (so the existing **Open here** and **Open in new Window** actions then act on it), or opens it directly — pick the cleaner UX, but the manual text field must remain so paste still works. The picker should default to a sensible starting directory (e.g. the last-used location or the user's home) and do nothing gracefully if the dialog is cancelled.

Wire it so browsing works for both flows the bar already supports: opening a Project in the current Window and opening one in a new Window.

## Acceptance criteria

- [ ] A Browse control in the Project bar opens the native OS folder picker.
- [ ] Choosing a folder leads to that repo being opened (directly, or by populating the path field then using Open here / Open in new Window).
- [ ] The existing text field still works — a pasted/typed path opens as before (either/or preserved).
- [ ] Cancelling the picker does nothing (no error, no empty-path open).
- [ ] Browsing works for both "open in this Window" and "open in new Window".
- [ ] The picker invocation is a thin main-process IPC handler (Electron `dialog`); any pure logic (e.g. resolving the chosen path) is unit-tested. The dialog itself verifies via type-check + build + the batch QA walkthrough.

## Blocked by

- 9
- 14
