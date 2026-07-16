/**
 * CommandPalette (issue 124, ADR-0020) — the Cmd+K palette, built on the
 * Dialog primitive so it inherits the app's one overlay/focus-trap/Escape
 * behavior and returns focus to wherever the user was on close (Radix's
 * default close-autofocus). It renders whatever the pure `command-registry`
 * ranks and runs the highlighted command's thunk; it holds no authority of
 * its own — the thunks the parent supplies route through the same flows a
 * click would (project switch → interrupt guard, issue jump → the Map, etc.).
 *
 * Everything about matching, ranking, and arrow-key selection lives in
 * `command-registry`; this component is the thin keyboard + rendering shell
 * over that state machine.
 */
import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from './components';
import {
  openPalette,
  setQuery,
  moveActive,
  setActive,
  activeCommand,
  type Command,
  type CommandKind,
  type PaletteState,
} from '../../shared/command-registry';
import type { BadgeTone } from './components';

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The merged, ready-to-rank command set (built by the parent each render). */
  commands: Command[];
}

/** Each command kind's badge tone + label, matching the approved mock. */
const KIND_TONE: Record<CommandKind, BadgeTone> = {
  project: 'violet',
  view: 'teal',
  action: 'green',
  issue: 'amber',
};

export function CommandPalette({ open, onOpenChange, commands }: CommandPaletteProps): JSX.Element {
  const [state, setState] = useState<PaletteState>(() => openPalette(commands));
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Each open starts fresh: empty query, suggestion set, top row active. The
  // commands are re-read here so the palette always ranks the live set (a
  // Project that appeared, a Run that started) without stale snapshots.
  useEffect(() => {
    if (open) setState(openPalette(commands));
    // Re-seed only on the open edge; live typing re-ranks against `commands`
    // through the closures below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the highlighted row in view as the arrows move it.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [state.activeIndex, state.query]);

  const run = (command: Command | null): void => {
    if (!command || command.disabled) return;
    // Close first so focus returns to where the user was, THEN act — a command
    // that opens another dialog (a guarded project switch) then owns the focus.
    onOpenChange(false);
    command.run?.();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="ui-palette"
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          // Focus the query line, not the first result row.
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <DialogTitle className="ui-visually-hidden">Command palette</DialogTitle>
        <div className="palette__search">
          <svg
            className="palette__search-icon"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            className="palette__input"
            type="text"
            placeholder="Search projects, views, issues — or run a command"
            value={state.query}
            aria-label="Search projects, views, issues, or run a command"
            onChange={(e) => setState(setQuery(commands, e.target.value))}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setState((s) => moveActive(s, 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setState((s) => moveActive(s, -1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(activeCommand(state));
              }
            }}
          />
          <kbd className="palette__esc">esc</kbd>
        </div>

        <div className="palette__results" ref={listRef} role="listbox" aria-label="Commands">
          {state.query.trim() === '' && state.ranked.length > 0 && (
            <div className="palette__section">Suggestions</div>
          )}
          {state.ranked.map((r, i) => {
            const c = r.command;
            const isActive = i === state.activeIndex;
            return (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={isActive}
                data-active={isActive}
                className={`palette__row${c.disabled ? ' palette__row--disabled' : ''}`}
                onMouseMove={() => setState((s) => setActive(s, i))}
                onClick={() => run(c)}
                disabled={c.disabled}
              >
                <span className={`ui-badge ui-badge--${KIND_TONE[c.kind]} palette__kind`}>
                  {c.kind}
                </span>
                <span className="palette__title">{c.title}</span>
                {c.hint && <span className="palette__hint">{c.hint}</span>}
              </button>
            );
          })}
          {state.ranked.length === 0 && (
            <div className="palette__empty">No matches for “{state.query.trim()}”</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
