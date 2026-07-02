/**
 * Backlog Reader — the file-I/O adapter for the pure Backlog Model.
 *
 * Given a Project's repo path, it reads that repo's `issues/*.md` files and
 * `issues/CONFIG.md` off disk, then hands the raw contents to the pure
 * `buildBacklog` (in `src/shared`). All the parsing/classification logic lives
 * in the pure module; this file is just the thin I/O edge.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildBacklog, type Backlog, type RawFile } from '../shared/backlog-model';

/** Read `<projectPath>/issues/` and return the structured backlog. */
export async function readBacklog(projectPath: string): Promise<Backlog> {
  const issuesDir = join(projectPath, 'issues');

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
