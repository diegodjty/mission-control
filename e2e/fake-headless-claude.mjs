// Fake headless `claude -p --output-format stream-json` Worker (issue 139) — a
// scripted, deterministic stand-in spawned as a REAL child process by the
// HeadlessSessionManager through the command-override seam (`MC_RUN_CMD=node
// <this>`), so the e2e exercises the genuine child-process edge with no LLM.
//
// It does exactly what a headless afk-issue-runner Worker does: emit a
// stream-json event stream (a `system`/`init` event that declares the
// session id, some assistant chatter, a terminal `result`), and perform the
// on-disk work its exit requires — claim flip (open → wip → done), a
// deliverable, and the Receipt written last (one save).
//
// Config rides env vars the test sets (the manager passes process.env through);
// the scoped prompt rides argv and is ignored here.
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const env = process.env;
const sessionId = env.MC_FAKE_SESSION_ID ?? 'sess-fake';
const issueFile = env.MC_FAKE_ISSUE_FILE ?? '';
const receiptPath = env.MC_FAKE_RECEIPT_PATH ?? '';
const deliverable = env.MC_FAKE_DELIVERABLE ?? '';
const slug = env.MC_FAKE_SLUG ?? 'issue';
const id = env.MC_FAKE_ID ?? '0';
const finished = env.MC_FAKE_FINISHED ?? '2026-07-17T00:00:00.000Z';
const outcome = env.MC_FAKE_OUTCOME ?? 'completed'; // completed | blocked | needs-verification
// Denial mode (issue 142): when set alongside outcome=blocked, the Worker hit a
// permission denial — it parks `blocked` with a Receipt that NAMES the denied
// action (the headless failure contract's producer half) instead of retrying it.
const deniedAction = env.MC_FAKE_DENIED_ACTION ?? '';
const writeReceipt = env.MC_FAKE_NO_RECEIPT !== '1';
// Take-over modes (issue 144):
//   HANG — declare the session id, then stay alive (a Run mid-flight); it does
//     NO on-disk work and never exits on its own, so the take-over test can kill
//     it and observe the child die. Killed via SIGTERM by the manager.
//   INTERROGATE — a post-mortem resume: emit a little chatter and exit, touching
//     NOTHING on disk (no claim flip, no Receipt) — the operator is just reading
//     the finished session back, so the backlog must be left exactly as it was.
const hang = env.MC_FAKE_HANG === '1';
const interrogate = env.MC_FAKE_INTERROGATE === '1';

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

// 1. The stream: the leading system/init event declares the session id; a
//    non-init event follows to prove the parser handles more than just init.
emit({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), tools: [] });
emit({
  type: 'assistant',
  session_id: sessionId,
  message: { role: 'assistant', content: [{ type: 'text', text: `Working ${slug}…` }] },
});
// A tool_use turn so the Feed model derives a live ACTIVITY line (issue 140):
// `Bash` with a command folds to `running npm test`. The renderer shows this
// while the Run is live; the e2e asserts main folded it and broadcast it.
emit({
  type: 'assistant',
  session_id: sessionId,
  message: {
    role: 'assistant',
    content: [
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'run tests' } },
    ],
  },
});

// HANG (issue 144): a Run caught mid-flight — session id declared, but it does
// no on-disk work and never exits. The take-over test kills it and watches the
// child die. The far-future timer keeps the event loop (and the process) alive.
if (hang) {
  setTimeout(() => {}, 3_600_000);
  // Do NOT fall through to the on-disk work or the terminal result.
} else if (interrogate) {
  // Post-mortem resume: touch nothing on disk; just read the session back and
  // exit cleanly, so the backlog is byte-identical before and after.
  emit({ type: 'result', subtype: 'success', session_id: sessionId, is_error: false, result: 'post-mortem read' });
} else {

// 2. The on-disk work. A blocked/park Worker leaves the claim `wip`; a completed
//    one flips through to `done` and writes a deliverable.
const setStatus = (status) => {
  if (!issueFile) return;
  const cur = readFileSync(issueFile, 'utf8');
  writeFileSync(issueFile, cur.replace(/status: (open|wip|done)/, `status: ${status}`));
};
setStatus('wip'); // claim
if (outcome === 'completed') {
  setStatus('done');
  if (deliverable) {
    mkdirSync(dirname(deliverable), { recursive: true });
    writeFileSync(deliverable, `deliverable for ${slug}\n`);
  }
}

// 3. The Receipt — one save, declaring the machine-facing outcome — then the
//    terminal result event. `claude -p` exits cleanly once the stream ends.
if (writeReceipt && receiptPath) {
  mkdirSync(dirname(receiptPath), { recursive: true });
  const label = `${String(id).padStart(2, '0')} — ${slug}`;
  const body =
    outcome === 'completed'
      ? `## Completed issue ${label}\n\n` +
        `**What changed** — the headless Worker completed ${slug}.\n\n` +
        `**Try it yourself** — read work/${slug}.txt.\n\n` +
        `**Verified** — read the deliverable back from disk.\n\n` +
        `**Bookkeeping** — files touched: work/${slug}.txt, issues/${slug}.md.\n\n` +
        `**Doc drift** — none.\n`
      : outcome === 'needs-verification'
        ? `## Ready for manual verification — issue ${id} — ${slug}\n\n` +
          `Steps:\n1. Open the surface this issue changed.\n2. Confirm by hand.\n`
        : deniedAction
          ? // Denial park (issue 142): first line NAMES the action so the attention
            // item (which shows the Receipt's first line) carries the denial too.
            `Permission denied: \`${deniedAction}\` — parked blocked, not retried.\n\n` +
            `No AFK-eligible work completable on issue ${id} — ${slug}. I stopped because the ` +
            `action \`${deniedAction}\` was denied; a permission denial is a park-blocked exit, so ` +
            `I recorded it here and did not retry the denied action. Grant the permission before ` +
            `running AFK again.\n`
          : `No AFK-eligible work completable on issue ${id} — ${slug}. I stopped because a ` +
            `dependency the issue says is done turned out not to be done in the code.\n`;
  writeFileSync(
    receiptPath,
    `---\nissue: ${id}\nslug: ${slug}\noutcome: ${outcome}\nfinished: ${finished}\n---\n${body}`,
  );
}

// The terminal result carries a `usage` payload VERBATIM (issue 143 consumes it;
// issue 140 asserts it survives the fold intact).
emit({
  type: 'result',
  subtype: 'success',
  session_id: sessionId,
  is_error: false,
  num_turns: 2,
  total_cost_usd: 0.01,
  result: `done ${slug}`,
  usage: { input_tokens: 1200, output_tokens: 340 },
});

}
// Let the process exit naturally so buffered stdout is fully flushed first.
