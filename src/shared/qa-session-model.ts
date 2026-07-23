/**
 * Guided QA session model (PURE) — issue 198.
 *
 * Turns issue 196's read-only structured `## QA Steps` render into an
 * interactive session: each step takes a per-step verdict (pass/fail) and an
 * optional free-text note, and the session as a whole derives a verdict from
 * its steps. State persists as a durable per-pass markdown artifact under the
 * project's Workbench `qa/` directory (`src/main/qa-session-store.ts` is the
 * fs edge) — the QA receipt on disk is the session's ONLY store, so quitting
 * and relaunching MC mid-session resumes exactly where the human left off
 * from the file alone. No userData involvement (unlike issue 156's ephemeral
 * tick-store, which this module never touches).
 *
 * PURE: no I/O, no runtime imports — unit-testable in isolation and safe to
 * share across main/renderer.
 */

/** One step's recorded verdict; `unset` means the human hasn't visited it yet. */
export type QaStepVerdict = 'unset' | 'pass' | 'fail';

/** One step's result: its verdict plus an optional free-text note. */
export interface QaStepResult {
  verdict: QaStepVerdict;
  /** Free-text note (e.g. "what I actually saw" on a fail), or null. */
  note: string | null;
}

/** The session-level verdict, derived from its steps. */
export type QaSessionVerdict = 'green' | 'failed' | 'in-progress';

/**
 * Derive the session verdict from its per-step results: any `fail` makes the
 * whole session `failed` (checked first — a single failed step outweighs any
 * number of passes); all steps `pass` (and at least one step exists) makes it
 * `green`; anything else — an empty step list, or at least one `unset` step
 * with no fail — is `in-progress`.
 */
export function deriveSessionVerdict(results: readonly QaStepResult[]): QaSessionVerdict {
  if (results.length === 0) return 'in-progress';
  if (results.some((r) => r.verdict === 'fail')) return 'failed';
  if (results.every((r) => r.verdict === 'pass')) return 'green';
  return 'in-progress';
}

/** A fresh, all-unset result for `stepCount` steps. */
export function freshResults(stepCount: number): QaStepResult[] {
  return Array.from({ length: Math.max(0, stepCount) }, () => ({
    verdict: 'unset' as const,
    note: null,
  }));
}

/**
 * Align a results array to `stepCount` (mirrors `checkedFlagsFor` in
 * `checklist-state-model.ts`): a step count change (the QA Steps block was
 * edited between sessions) must not crash or misalign — items beyond the
 * source array read as unset/no-note; a longer source array is truncated.
 */
export function alignResults(
  results: readonly QaStepResult[],
  stepCount: number,
): QaStepResult[] {
  return Array.from({ length: Math.max(0, stepCount) }, (_, i) => results[i] ?? { verdict: 'unset', note: null });
}

/**
 * Set one step's verdict and/or note and return a NEW results array (pure).
 * Out-of-range indexes are a no-op (return the input unchanged).
 */
export function setStepResult(
  results: readonly QaStepResult[],
  index: number,
  update: { verdict?: QaStepVerdict; note?: string | null },
): QaStepResult[] {
  if (index < 0 || index >= results.length) return [...results];
  const next = results.slice();
  const current = next[index];
  next[index] = {
    verdict: update.verdict ?? current.verdict,
    note: update.note !== undefined ? update.note : current.note,
  };
  return next;
}

/** The next pass number to write, given the pass numbers already on disk. */
export function nextPassNumber(existingPassNumbers: readonly number[]): number {
  if (existingPassNumbers.length === 0) return 1;
  return Math.max(...existingPassNumbers) + 1;
}

/** One parsed QA pass file's contents. */
export interface QaPass {
  /** The source issue's plain file name (e.g. `198-guided-...md`). */
  issue: string;
  pass: number;
  /** ISO timestamp the pass was started. */
  started: string;
  /** ISO timestamp the pass was decided (verdict != in-progress), or null. */
  finished: string | null;
  results: QaStepResult[];
  verdict: QaSessionVerdict;
}

/**
 * Decide the session to show for `stepCount` steps, given the passes already
 * on disk (any order): resume the latest pass verbatim (aligned to
 * `stepCount`) when it is still `in-progress`; otherwise (no passes yet, or
 * the latest is decided) start a fresh pass — `pass N+1` when a decided pass
 * exists, `pass 1` when there are none. Starting re-QA on a decided session
 * therefore creates the next pass and never touches a prior one (they are
 * never mutated here — the caller only ever writes the RETURNED pass).
 */
export function resumeOrStartSession(
  existingPasses: readonly QaPass[],
  issue: string,
  stepCount: number,
  startedIso: string,
): QaPass {
  const latest = existingPasses.reduce<QaPass | null>(
    (acc, p) => (acc === null || p.pass > acc.pass ? p : acc),
    null,
  );

  if (latest !== null && latest.verdict === 'in-progress') {
    const results = alignResults(latest.results, stepCount);
    return { ...latest, results, verdict: deriveSessionVerdict(results) };
  }

  const pass = nextPassNumber(existingPasses.map((p) => p.pass));
  return {
    issue,
    pass,
    started: startedIso,
    finished: null,
    results: freshResults(stepCount),
    verdict: 'in-progress',
  };
}

/**
 * Apply one step-result update to a pass and re-derive its verdict/`finished`
 * stamp (pure — the caller persists the returned pass). `finished` is set the
 * moment the session becomes decided (green/failed) and cleared back to null
 * if a later edit (e.g. flipping a fail back to pass) returns it to
 * `in-progress` — `finished` always means "verdict is currently decided".
 */
export function applyStepUpdate(
  pass: QaPass,
  index: number,
  update: { verdict?: QaStepVerdict; note?: string | null },
  nowIso: string,
): QaPass {
  const results = setStepResult(pass.results, index, update);
  const verdict = deriveSessionVerdict(results);
  return {
    ...pass,
    results,
    verdict,
    finished: verdict === 'in-progress' ? null : (pass.finished ?? nowIso),
  };
}

// ---------------------------------------------------------------------------
// Durable markdown artifact — the qa/ pass file's on-disk shape
// ---------------------------------------------------------------------------

const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n?/;
const STEP_HEADING = /(?:^|\n)##\s*Step\s+(\d+)\s*\n/g;
// `[ \t]*` (not `\s*`) around the label/colon, for the same reason as
// `frontmatterValue`: an empty field's `\s*` would swallow the newline and
// keep matching into the next step's heading/field.
const FIELD = /^[ \t]*-[ \t]*(verdict|note)[ \t]*:[ \t]*(.*)$/im;

function frontmatterValue(frontmatter: string, key: string): string | null {
  // `[ \t]*` (not `\s*`) after the colon: `\s` matches `\n`, which would let
  // an EMPTY value's separator swallow the whole next line (e.g. `finished: `
  // eating `verdict: in-progress` on the following line).
  const re = new RegExp(`^${key}[ \\t]*:[ \\t]*(.*)$`, 'm');
  const match = re.exec(frontmatter);
  if (!match) return null;
  const value = match[1].trim();
  return value.length > 0 ? value : null;
}

function isVerdict(value: string | null): value is QaStepVerdict {
  return value === 'unset' || value === 'pass' || value === 'fail';
}

function isSessionVerdict(value: string | null): value is QaSessionVerdict {
  return value === 'green' || value === 'failed' || value === 'in-progress';
}

/**
 * Serialize a pass to its durable markdown form: a frontmatter fence carrying
 * `issue`/`pass`/`started`/`finished`/`verdict`, then one `## Step N` section
 * per result with its `verdict`/`note` fields. Deterministic (stable field
 * order) so a re-write of the same pass is byte-identical.
 */
export function serializeQaPass(pass: QaPass): string {
  const frontmatter = [
    `issue: ${pass.issue}`,
    `pass: ${pass.pass}`,
    `started: ${pass.started}`,
    `finished: ${pass.finished ?? ''}`,
    `verdict: ${pass.verdict}`,
  ].join('\n');

  const steps = pass.results
    .map((r, i) => {
      const note = (r.note ?? '').replace(/\r?\n/g, ' ').trim();
      return `## Step ${i + 1}\n- verdict: ${r.verdict}\n- note: ${note}`;
    })
    .join('\n\n');

  return `---\n${frontmatter}\n---\n\n${steps}\n`;
}

/**
 * Parse a durable QA pass markdown file. Tolerant by contract — never
 * throws: a missing frontmatter fence, or a fence missing `issue`/`pass`/
 * `started`, yields `null` (an unreadable pass is simply skipped by the
 * store, never crashes a session). An unrecognised `verdict`/`finished`
 * degrades to the safe reading (`unset` step verdict, `in-progress` session,
 * `finished: null`) rather than guessing.
 */
export function parseQaPass(content: unknown): QaPass | null {
  if (typeof content !== 'string') return null;
  const fence = FRONTMATTER.exec(content);
  if (!fence) return null;

  const frontmatter = fence[1];
  const issue = frontmatterValue(frontmatter, 'issue');
  const passRaw = frontmatterValue(frontmatter, 'pass');
  const started = frontmatterValue(frontmatter, 'started');
  if (issue === null || passRaw === null || started === null) return null;
  const pass = Number(passRaw);
  if (!Number.isFinite(pass) || pass <= 0) return null;

  const finishedRaw = frontmatterValue(frontmatter, 'finished');
  const verdictRaw = frontmatterValue(frontmatter, 'verdict');

  const body = content.slice(fence[0].length);
  const starts: number[] = [];
  STEP_HEADING.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STEP_HEADING.exec(body)) !== null) starts.push(m.index + m[0].length);

  const results: QaStepResult[] = starts.map((start, i) => {
    const chunk = body.slice(start, i + 1 < starts.length ? starts[i + 1] : body.length);
    const lines = chunk.split('\n');
    let verdict: QaStepVerdict = 'unset';
    let note: string | null = null;
    for (const line of lines) {
      const field = FIELD.exec(line);
      if (!field) continue;
      if (field[1].toLowerCase() === 'verdict') {
        const v = field[2].trim();
        if (isVerdict(v)) verdict = v;
      } else {
        const n = field[2].trim();
        note = n.length > 0 ? n : null;
      }
    }
    return { verdict, note };
  });

  return {
    issue,
    pass,
    started,
    finished: finishedRaw,
    results,
    verdict: isSessionVerdict(verdictRaw) ? verdictRaw : deriveSessionVerdict(results),
  };
}

/**
 * The pass file's name under `qa/`: `<issue-file-stem>--pass-<N>.md`, so
 * listing/filtering an issue's passes is a simple prefix match and passes
 * sort lexically the same as numerically for any realistic pass count.
 */
export function qaPassFileName(issueFileName: string, pass: number): string {
  const stem = issueFileName.replace(/\.md$/i, '');
  return `${stem}--pass-${pass}.md`;
}

/** The `<issue-file-stem>--pass-` prefix every one of an issue's passes shares. */
export function qaPassFilePrefix(issueFileName: string): string {
  return `${issueFileName.replace(/\.md$/i, '')}--pass-`;
}
