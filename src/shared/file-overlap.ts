/**
 * File-overlap footprint estimation (issue 171) — the input that lets the Run
 * Coordinator refuse to co-schedule two Runs that will collide on the same
 * file. Draining several eligible issues that all edit one god file (a shared
 * `App.tsx`-style module) at cap > 1 used to run them concurrently and only
 * surface the collision as a merge conflict at integration time — a surprise
 * the user could only avoid by tacit knowledge ("set cap 1 for this project").
 *
 * This module turns that tacit knowledge into a declared, estimated
 * **footprint** per issue and a pure overlap check `planDrain` consults before
 * filling a slot. Two footprint sources, both crude by design (v1):
 *
 *   - The project CONFIG's `hot_files` list — any issue whose body MENTIONS a
 *     hot file (the afk-issue-runner's own solo-mode overlap heuristic, lifted
 *     here so the decision is made once, at schedule time) is predicted to
 *     touch it.
 *   - An issue's own declared `touches:` frontmatter (globs) — a precise,
 *     hand-authored footprint that beats the body-scan guess.
 *
 * PURE: no I/O, no Electron. Reading CONFIG/issue frontmatter off disk happens
 * in the Backlog Model / its adapter; this module only estimates and compares.
 */
import type { BacklogIssue } from './backlog-model';

/** Strip a leading/trailing quote pair (`'...'` or `"..."`), if present. */
function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '');
}

/** Parse a `[a, b, c]`-style flow list into trimmed, unquoted strings. */
function parseFlowList(raw: string): string[] {
  const inner = raw.replace(/^\[/, '').replace(/\]$/, '').trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((part) => stripQuotes(part.trim()))
    .filter((s) => s.length > 0);
}

const CONFIG_FRONTMATTER = /^---\s*\n([\s\S]*?)\n---/;

/**
 * Parse the project CONFIG's `hot_files` list (issue 171): either a flow list
 * on the same line (`hot_files: [a, b]`) or a YAML block list of `- ` items
 * indented under the key — both styles already appear elsewhere in this
 * project's CONFIG.md (`repos:` is a block map, `depends_on:` is a flow list),
 * so both are accepted here rather than picking one and surprising the other.
 * Absent/unset ⇒ no hot files (no project opts into overlap-forced
 * serialization unless it declares one).
 */
export function parseHotFiles(configContent: string | null | undefined): string[] {
  const content = configContent ?? '';
  const fm = CONFIG_FRONTMATTER.exec(content);
  if (!fm) return [];
  const lines = fm[1].split('\n');
  const idx = lines.findIndex((l) => /^hot_files\s*:/.test(l));
  if (idx === -1) return [];
  const inline = lines[idx].replace(/^hot_files\s*:/, '').trim();
  if (inline.length > 0) return parseFlowList(inline);
  const items: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const match = /^\s*-\s*(.+)$/.exec(lines[i]);
    if (!match) break;
    items.push(stripQuotes(match[1].trim()));
  }
  return items;
}

/**
 * Whether an issue's body text MENTIONS a hot file — the crude "predicted to
 * touch it" signal (issue 171's simplest footprint source). Matches the full
 * path verbatim (the common case — an issue naming its target file), or the
 * file's base name at a word boundary (an issue that says "App.tsx" without
 * the full path). Deliberately crude: false positives just serialize two
 * issues that turn out disjoint, never the other way round.
 */
function mentionsPath(body: string, path: string): boolean {
  if (body.includes(path)) return true;
  const base = path.split('/').pop() ?? path;
  if (base === path) return false; // no path separator — already checked above
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(body);
}

/**
 * The estimated footprint MC predicts an issue will touch: its own declared
 * `touches:` globs (precise, hand-authored) unioned with any project hot file
 * its body mentions (the crude but immediate god-file catch). Deduped; order
 * is not meaningful.
 */
export function predictedFootprint(
  issue: Pick<BacklogIssue, 'touches' | 'body'>,
  hotFiles: readonly string[],
): string[] {
  const footprint = new Set<string>(issue.touches);
  for (const hotFile of hotFiles) {
    if (mentionsPath(issue.body, hotFile)) footprint.add(hotFile);
  }
  return [...footprint];
}

/** Turn a glob (`*` = any characters, including `/`) into a matching RegExp. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/** Whether `path` matches `pattern` (a glob, or a literal path with none). */
export function matchesGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

/**
 * The shared path/glob two footprints collide on, or null when they are
 * genuinely disjoint. Checked both directions so a literal hot-file path in
 * one footprint matches a glob in the other regardless of which side declared
 * which, plus an exact-string match for two identical entries (including two
 * identical globs).
 */
export function footprintOverlap(
  a: readonly string[],
  b: readonly string[],
): string | null {
  for (const pa of a) {
    for (const pb of b) {
      if (pa === pb) return pa;
      if (matchesGlob(pa, pb)) return pb;
      if (matchesGlob(pb, pa)) return pa;
    }
  }
  return null;
}

/**
 * The one-line note surfaced when overlap forces two issues to serialize
 * (issue 171) — "never silent", per the acceptance criteria. Always names the
 * lower issue id first regardless of scheduling order, so the same pair reads
 * identically wherever it's reported.
 */
export function overlapSerializationNote(
  issueId: number,
  blockingIssueId: number,
  path: string,
): string {
  const [lo, hi] = [issueId, blockingIssueId].sort((a, b) => a - b);
  return `${lo} and ${hi} both touch ${path} — running serially.`;
}
