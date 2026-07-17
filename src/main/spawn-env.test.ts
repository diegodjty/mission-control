import { describe, it, expect } from 'vitest';
import { buildWorkerSpawnEnv } from './spawn-env';

describe('buildWorkerSpawnEnv', () => {
  it('sets NODE_ENV=development for a Worker spawn', () => {
    expect(buildWorkerSpawnEnv({}).NODE_ENV).toBe('development');
  });

  it('OVERRIDES an inherited NODE_ENV=production (the install-pruning case)', () => {
    // The exact hazard: MC packaged under production, a Worker inherits it, a
    // bare `npm install` then prunes devDeps. The builder forces development.
    expect(buildWorkerSpawnEnv({ NODE_ENV: 'production' }).NODE_ENV).toBe('development');
  });

  it('carries every other variable through untouched', () => {
    const base = { PATH: '/usr/bin', HOME: '/Users/dev', CLAUDE_BIN: '/opt/claude' };
    const env = buildWorkerSpawnEnv(base);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/Users/dev');
    expect(env.CLAUDE_BIN).toBe('/opt/claude');
    expect(env.NODE_ENV).toBe('development');
  });

  it('does not mutate the input env (returns a fresh object)', () => {
    const base: Record<string, string | undefined> = { NODE_ENV: 'production' };
    const env = buildWorkerSpawnEnv(base);
    expect(base.NODE_ENV).toBe('production'); // input untouched
    expect(env).not.toBe(base); // a new object
  });
});
