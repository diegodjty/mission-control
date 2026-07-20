import { describe, it, expect } from 'vitest';
import { buildBacklog, parseActivePrd, type RawFile } from './backlog-model';

const CONFIG = `# AFK project config

## Active PRD

\`docs/PRD.md\` — the Mission Control PRD.

## Repo

Single Electron repo.
`;

function issue(name: string, content: string): RawFile {
  return { name, content };
}

describe('parseActivePrd', () => {
  it('extracts the backtick-quoted PRD path from the Active PRD section', () => {
    expect(parseActivePrd(CONFIG)).toBe('docs/PRD.md');
  });

  it('returns null when there is no CONFIG content', () => {
    expect(parseActivePrd(null)).toBeNull();
  });

  it('returns null when there is no Active PRD section', () => {
    expect(parseActivePrd('# Something\n\nno prd here')).toBeNull();
  });
});

describe('buildBacklog — status and identity', () => {
  it('parses id, slug, status and sorts issues numerically', () => {
    const files = [
      issue('10-batch-qa.md', '---\nstatus: open\ndepends_on: [1]\n---\n\n# 10 — QA'),
      issue('02-map.md', '---\nstatus: wip\ndepends_on: [1]\n---\n\n# 02 — Map'),
      issue('01-skeleton.md', '---\nstatus: done\ndepends_on: []\n---\n\n# 01 — Skeleton'),
    ];
    const { issues } = buildBacklog(files, CONFIG);
    expect(issues.map((i) => i.id)).toEqual([1, 2, 10]);
    expect(issues.map((i) => i.status)).toEqual(['done', 'wip', 'open']);
    expect(issues[0].slug).toBe('skeleton');
    expect(issues[0].fileName).toBe('01-skeleton.md');
  });

  it('ignores non-issue files like CONFIG.md and HUMAN-SETUP.md', () => {
    const files = [
      issue('CONFIG.md', '# config'),
      issue('HUMAN-SETUP.md', '# setup'),
      issue('01-skeleton.md', '---\nstatus: done\ndepends_on: []\n---\n\n# 01 — Skeleton'),
    ];
    const { issues } = buildBacklog(files, CONFIG);
    expect(issues).toHaveLength(1);
    expect(issues[0].id).toBe(1);
  });

  it('extracts the level-1 heading as the title, falling back to the slug', () => {
    const files = [
      issue('03-run-issue.md', '---\nstatus: open\ndepends_on: [2]\n---\n\n# 03 — Run one issue in a Pane'),
      issue('04-no-heading.md', '---\nstatus: open\ndepends_on: []\n---\n\nbody with no heading'),
    ];
    const { issues } = buildBacklog(files, CONFIG);
    expect(issues[0].title).toBe('03 — Run one issue in a Pane');
    expect(issues[1].title).toBe('no-heading');
  });

  it('keeps the full markdown body available for the detail view', () => {
    const body = '# 01 — Skeleton\n\n## What to build\n\nThe thinnest spine.';
    const files = [issue('01-skeleton.md', `---\nstatus: done\ndepends_on: []\n---\n\n${body}`)];
    const { issues } = buildBacklog(files, CONFIG);
    expect(issues[0].body).toBe(body);
  });
});

describe('buildBacklog — dependencies', () => {
  it('parses depends_on lists of numbers', () => {
    const files = [
      issue('10-qa.md', '---\nstatus: open\ndepends_on: [1, 2, 3, 4]\n---\n\n# 10 — QA'),
    ];
    const { issues } = buildBacklog(files, CONFIG);
    expect(issues[0].dependsOn).toEqual([1, 2, 3, 4]);
  });

  it('parses an empty depends_on list', () => {
    const files = [
      issue('01-skeleton.md', '---\nstatus: done\ndepends_on: []\n---\n\n# 01 — Skeleton'),
    ];
    const { issues } = buildBacklog(files, CONFIG);
    expect(issues[0].dependsOn).toEqual([]);
  });
});

describe('buildBacklog — HITL detection', () => {
  it('detects HITL via frontmatter hitl: true', () => {
    const files = [
      issue('10-qa.md', '---\nstatus: open\ndepends_on: []\nhitl: true\n---\n\n# 10 — QA'),
    ];
    expect(buildBacklog(files, CONFIG).issues[0].hitl).toBe(true);
  });

  it('detects HITL via (HITL) in the top-level heading', () => {
    const files = [
      issue('10-qa.md', '---\nstatus: open\ndepends_on: []\n---\n\n# 10 — Batch QA walkthrough (HITL)'),
    ];
    expect(buildBacklog(files, CONFIG).issues[0].hitl).toBe(true);
  });

  it('is not HITL when neither marker is present', () => {
    const files = [
      issue('02-map.md', '---\nstatus: open\ndepends_on: [1]\n---\n\n# 02 — Map'),
    ];
    expect(buildBacklog(files, CONFIG).issues[0].hitl).toBe(false);
  });
});

describe('buildBacklog — in-batch vs. standalone classification', () => {
  it('marks an issue in-batch when its Parent matches the active PRD', () => {
    const files = [
      issue(
        '02-map.md',
        '---\nstatus: open\ndepends_on: [1]\n---\n\n# 02 — Map\n\n## Parent\n\n`docs/PRD.md` — Mission Control.',
      ),
    ];
    const { issues } = buildBacklog(files, CONFIG);
    expect(issues[0].parent).toBe('docs/PRD.md');
    expect(issues[0].inBatch).toBe(true);
    expect(issues[0].standalone).toBe(false);
  });

  it('marks an issue standalone when it has no Parent section', () => {
    const files = [
      issue(
        '20-bugfix.md',
        '---\nstatus: open\ndepends_on: []\n---\n\n# 20 — Fix a bug\n\n## Source\n\nCall triage 2026-07-01.',
      ),
    ];
    const { issues } = buildBacklog(files, CONFIG);
    expect(issues[0].standalone).toBe(true);
    expect(issues[0].inBatch).toBe(false);
    expect(issues[0].parent).toBeNull();
    expect(issues[0].source).toBe('Call triage 2026-07-01.');
  });

  it('marks an issue out-of-batch when its Parent points to a different PRD', () => {
    const files = [
      issue(
        '30-other.md',
        '---\nstatus: open\ndepends_on: []\n---\n\n# 30 — Other feature\n\n## Parent\n\n`docs/OTHER-PRD.md` — something else.',
      ),
    ];
    const { issues } = buildBacklog(files, CONFIG);
    expect(issues[0].parent).toBe('docs/OTHER-PRD.md');
    expect(issues[0].inBatch).toBe(false);
    expect(issues[0].standalone).toBe(false);
  });

  it('treats everything as not-in-batch when there is no active PRD', () => {
    const files = [
      issue(
        '02-map.md',
        '---\nstatus: open\ndepends_on: [1]\n---\n\n# 02 — Map\n\n## Parent\n\n`docs/PRD.md` — Mission Control.',
      ),
    ];
    const { issues } = buildBacklog(files, null);
    expect(issues[0].inBatch).toBe(false);
    expect(issues[0].standalone).toBe(false);
  });
});

describe('buildBacklog — issue repo targeting (issue 72, ADR-0015)', () => {
  it('parses the repo: frontmatter key', () => {
    const files = [
      issue(
        '05-worker.md',
        '---\nstatus: open\ndepends_on: []\nrepo: api\n---\n\n# 05 — Worker\n',
      ),
    ];
    const { issues } = buildBacklog(files, CONFIG);
    expect(issues[0].repoKey).toBe('api');
  });

  it('unquotes a quoted repo value', () => {
    const files = [
      issue('06-x.md', "---\nstatus: open\nrepo: 'web'\n---\n\n# 06 — X\n"),
    ];
    expect(buildBacklog(files, CONFIG).issues[0].repoKey).toBe('web');
  });

  it('defaults repoKey to null when the key is absent or empty', () => {
    const files = [
      issue('07-a.md', '---\nstatus: open\n---\n\n# 07 — A\n'),
      issue('08-b.md', '---\nstatus: open\nrepo:\n---\n\n# 08 — B\n'),
    ];
    const { issues } = buildBacklog(files, CONFIG);
    expect(issues[0].repoKey).toBeNull();
    expect(issues[1].repoKey).toBeNull();
  });

  it('ignores a repo: line in the body (prose, not a declaration)', () => {
    const files = [
      issue(
        '09-c.md',
        '---\nstatus: open\n---\n\n# 09 — C\n\nThe CONFIG maps\nrepo: api\nto a path.\n',
      ),
    ];
    expect(buildBacklog(files, CONFIG).issues[0].repoKey).toBeNull();
  });
});

describe('buildBacklog — per-issue model tier (issue 154)', () => {
  it('parses a known model: tier from frontmatter', () => {
    const files = [
      issue('05-w.md', '---\nstatus: open\ndepends_on: []\nmodel: haiku\n---\n\n# 05 — W\n'),
    ];
    expect(buildBacklog(files, CONFIG).issues[0].model).toBe('haiku');
  });

  it('degrades an unknown or absent model: to null (= the CONFIG default)', () => {
    const files = [
      issue('06-x.md', '---\nstatus: open\nmodel: turbo\n---\n\n# 06 — X\n'),
      issue('07-y.md', '---\nstatus: open\n---\n\n# 07 — Y\n'),
    ];
    const { issues } = buildBacklog(files, CONFIG);
    expect(issues[0].model).toBeNull();
    expect(issues[1].model).toBeNull();
  });
});

describe('buildBacklog — per-issue effort level (issue 155)', () => {
  it('parses a known effort: level from frontmatter', () => {
    const files = [
      issue('05-w.md', '---\nstatus: open\ndepends_on: []\neffort: max\n---\n\n# 05 — W\n'),
    ];
    expect(buildBacklog(files, CONFIG).issues[0].effort).toBe('max');
  });

  it('degrades an unknown or absent effort: to null (= CONFIG override / tier default)', () => {
    const files = [
      issue('06-x.md', '---\nstatus: open\neffort: turbo\n---\n\n# 06 — X\n'),
      issue('07-y.md', '---\nstatus: open\n---\n\n# 07 — Y\n'),
    ];
    const { issues } = buildBacklog(files, CONFIG);
    expect(issues[0].effort).toBeNull();
    expect(issues[1].effort).toBeNull();
  });
});

describe('buildBacklog — per-issue run_timeout override (issue 170)', () => {
  it('parses a valid run_timeout: override from frontmatter, in minutes', () => {
    const files = [
      issue('05-w.md', '---\nstatus: open\ndepends_on: []\nrun_timeout: 90\n---\n\n# 05 — W\n'),
    ];
    expect(buildBacklog(files, CONFIG).issues[0].runTimeoutMinutes).toBe(90);
  });

  it('degrades a malformed or absent run_timeout: to null (= the CONFIG default, effort-scaled)', () => {
    const files = [
      issue('06-x.md', '---\nstatus: open\nrun_timeout: soon\n---\n\n# 06 — X\n'),
      issue('07-y.md', '---\nstatus: open\n---\n\n# 07 — Y\n'),
    ];
    const { issues } = buildBacklog(files, CONFIG);
    expect(issues[0].runTimeoutMinutes).toBeNull();
    expect(issues[1].runTimeoutMinutes).toBeNull();
  });
});

describe('buildBacklog — drain-worker tiering from CONFIG (issues 154/155)', () => {
  it('reads worker_model / escalation_ceiling / worker_effort from the CONFIG frontmatter', () => {
    const config = `---\nrepos:\n  a: /x\ndefault_repo: a\nworker_model: haiku\nescalation_ceiling: fable\nworker_effort: high\n---\n\n# proj CONFIG\n`;
    const backlog = buildBacklog([], config);
    expect(backlog.workerModel).toBe('haiku');
    expect(backlog.escalationCeiling).toBe('fable');
    expect(backlog.workerEffort).toBe('high');
  });

  it('falls back to defaults when unset (sonnet / opus / null = derive effort from tier)', () => {
    // The suite's CONFIG has no frontmatter tiering keys at all.
    const backlog = buildBacklog([], CONFIG);
    expect(backlog.workerModel).toBe('sonnet');
    expect(backlog.escalationCeiling).toBe('opus');
    expect(backlog.workerEffort).toBeNull();
  });
});
