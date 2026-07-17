/**
 * Pure spawn-env builder (issue 136) — the environment a Worker (Run) PTY is
 * spawned with, derived from the inherited process environment.
 *
 * Mission Control's own process frequently runs under `NODE_ENV=production` (a
 * packaged Electron build sets it), and a spawned Worker inherits that env. But
 * under production a bare `npm install`/`npm ci` PRUNES devDependencies — which
 * is exactly where the toolchain lives (vitest, tsc, electron-vite, the Radix/
 * React types) — so a Worker's own install guts the very deps its build and test
 * commands need, and the Run fails in a way that looks like a code problem. The
 * human worked around it by hand every drain (prefixing npm with
 * `NODE_ENV=development`).
 *
 * Forcing `NODE_ENV=development` for every Worker spawn makes any install a
 * Worker still runs keep devDeps. Paired with worktree `node_modules`
 * provisioning (same issue), most Runs need no install at all — but the two are
 * belt-and-braces: provisioning removes the need to install, this removes the
 * hazard when one happens anyway.
 *
 * Pure and deterministic (a plain object transform, no node-pty/Electron
 * imports) so it is unit-tested in isolation; the PTY Session Manager adapter
 * applies it at the real spawn. Mirrors the `resolve-shell`/`resolve-run-command`
 * split: the decision is here and tested, the I/O edge just consumes it.
 */
export type EnvLike = Record<string, string | undefined>;

/**
 * The environment for a Worker/Run spawn: the inherited env with `NODE_ENV`
 * forced to `development`. Unconditional — it overrides an inherited
 * `production` (the case that breaks installs) and is a harmless no-op change
 * when `NODE_ENV` was already development or unset. Every other variable
 * (`PATH`, `HOME`, `CLAUDE_BIN`, …) is carried through untouched, and the input
 * object is never mutated (a fresh object is returned).
 */
export function buildWorkerSpawnEnv(base: EnvLike): EnvLike {
  return { ...base, NODE_ENV: 'development' };
}
