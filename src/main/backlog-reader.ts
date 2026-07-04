/**
 * Backlog Reader — the file-I/O adapter for the pure Backlog Model.
 *
 * Given a Project's resolved **issues root** (in-workbench or in-repo — the
 * project-identity layer decides which, issue 71), it reads that directory's
 * `*.md` files and `CONFIG.md` off disk, then hands the raw contents to the
 * pure `buildBacklog` (in `src/shared`). All the parsing/classification logic
 * lives in the pure module; this file is just the thin I/O edge.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildBacklog, type Backlog, type RawFile } from '../shared/backlog-model';

/** Read an issues directory (the resolved issues root) into a backlog. */
export async function readBacklogAt(issuesDir: string): Promise<Backlog> {
  const entries = await readdir(issuesDir, { withFileTypes: true });
  const files: RawFile[] = [];
  let configContent: string | null = null;

  await Promise.all(
    entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map(async (e) => {
        const content = await readFile(join(issuesDir, e.name), 'utf8');
        if (e.name === 'CONFIG.md') {
          configContent = content;
        } else {
          files.push({ name: e.name, content });
        }
      }),
  );

  return buildBacklog(files, configContent);
}

/**
 * Legacy-layout convenience: read `<projectPath>/issues/`. Kept for the many
 * callers (git adapters' tests, the e2e harness) that address a plain repo;
 * identity-aware callers resolve the issues root and use `readBacklogAt`.
 */
export async function readBacklog(projectPath: string): Promise<Backlog> {
  return readBacklogAt(join(projectPath, 'issues'));
}
