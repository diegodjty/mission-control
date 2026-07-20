import { vi } from 'vitest';
import type { MissionControlApi, ProjectView } from '../../../../shared/ipc-contract';

/**
 * A fully-typed `window.mc` double for the App.tsx harness (issue 184): every
 * method resolves with a safe empty/no-op default so the component never
 * throws on an un-exercised path, and any test can override just the calls it
 * cares about via `Object.assign(bridge, { methodName: vi.fn(...) })`.
 */
export function createMockBridge(): MissionControlApi {
  return {
    loadBacklog: vi.fn().mockResolvedValue({ backlog: null, projectPath: '' }),
    watchBacklog: vi.fn(),
    onBacklogChanged: vi.fn().mockReturnValue(() => {}),
    observeIssueStatus: vi.fn().mockResolvedValue({ status: null }),
    commitFinishedMain: vi.fn().mockResolvedValue({ committed: false }),
    commitFinishedWorktree: vi.fn().mockResolvedValue({ committed: false, error: null }),
    scanAfkRuns: vi.fn().mockResolvedValue({
      branches: [],
      midMerge: false,
      previews: [],
      previewNote: null,
      staleBuildNote: null,
    }),
    discardAfkRun: vi.fn().mockResolvedValue({ ok: true }),
    applyIsolation: vi.fn().mockResolvedValue({
      parallel: false,
      placements: [],
      queuedIssueIds: [],
      nonGitRoots: [],
    }),
    mergeRuns: vi.fn().mockResolvedValue({ ok: true, conflicted: false, mergedSlugs: [] }),
    abortMerge: vi.fn().mockResolvedValue({ ok: true, error: null }),
    openProject: vi.fn().mockResolvedValue({
      ok: true,
      error: null,
      activeProjectKey: null,
      projects: [],
    }),
    switchProject: vi.fn().mockResolvedValue({
      ok: true,
      error: null,
      activeProjectKey: null,
      projects: [],
    }),
    transitionProject: vi.fn().mockResolvedValue({
      ok: true,
      error: null,
      activeProjectKey: null,
      projects: [],
    }),
    listProjects: vi.fn().mockResolvedValue({ projects: [], activeProjectKey: null, pendingOpen: null }),
    pickProjectFolder: vi.fn().mockResolvedValue({ path: null }),
    openWindow: vi.fn().mockResolvedValue({ ok: true }),
    onProjectRegistryChanged: vi.fn().mockReturnValue(() => {}),
    loadRunLog: vi.fn().mockResolvedValue({ records: [] }),
    loadJournals: vi.fn().mockResolvedValue({ files: [] }),
    watchReceipts: vi.fn(),
    onReceiptCaptured: vi.fn().mockReturnValue(() => {}),
    writeDrainJournal: vi.fn().mockResolvedValue({
      written: false,
      path: null,
      fileName: null,
      error: null,
      offerDebrief: false,
    }),
    listAttention: vi.fn().mockResolvedValue({ workbenchRoot: '', items: [], notes: [] }),
    onAttentionChanged: vi.fn().mockReturnValue(() => {}),
    markAttentionSeen: vi.fn().mockResolvedValue({ lastSeen: {} }),
    onNavigateAttention: vi.fn().mockReturnValue(() => {}),
    listLauncherProjects: vi.fn().mockResolvedValue({ projects: [] }),
    listProjectCards: vi.fn().mockResolvedValue({ cards: [] }),
    createQuickFix: vi.fn().mockResolvedValue({ ok: true, errors: [] }),
    createProject: vi.fn().mockResolvedValue({ ok: true, errors: [] }),
    removeProject: vi.fn().mockResolvedValue({ ok: true, error: null }),
    registerRepo: vi.fn().mockResolvedValue({ ok: true, key: null, errors: [] }),
    timeoutSalvageVerify: vi.fn().mockResolvedValue({ ok: true, output: '', passed: false }),
    timeoutSalvageComplete: vi.fn().mockResolvedValue({ ok: true, error: null }),
    timeoutSalvageDiscard: vi.fn().mockResolvedValue({ ok: true, error: null }),
    gitInit: vi.fn().mockResolvedValue({ ok: true, error: null }),
    getGitBranchStatus: vi
      .fn()
      .mockResolvedValue({ branch: 'main', detached: false, protectedBranch: false }),
    listGitBranches: vi.fn().mockResolvedValue({ branches: [] }),
    createGitBranch: vi.fn().mockResolvedValue({ ok: true, error: null }),
    switchGitBranch: vi.fn().mockResolvedValue({ ok: true, error: null }),
    readIssueFile: vi.fn().mockResolvedValue({ content: null }),
    editIssueFile: vi.fn().mockResolvedValue({ ok: true, error: null }),
    deleteIssueFile: vi.fn().mockResolvedValue({ ok: true, error: null }),
    getChecklistState: vi.fn().mockResolvedValue({ checked: [] }),
    toggleChecklistItem: vi.fn().mockResolvedValue({ checked: [] }),
    watchPlanning: vi.fn(),
    onPlanningChanged: vi.fn().mockReturnValue(() => {}),
    readPlanningDoc: vi.fn().mockResolvedValue({ content: null }),
    watchDocs: vi.fn(),
    onDocsChanged: vi.fn().mockReturnValue(() => {}),
    readDoc: vi.fn().mockResolvedValue({ content: null }),
    readCuratorReport: vi.fn().mockResolvedValue({ content: null }),
    markCuratorReportSeen: vi.fn().mockResolvedValue({ ok: true }),
    readCoreProposal: vi.fn().mockResolvedValue({ current: null, proposed: null }),
    acceptCoreProposal: vi.fn().mockResolvedValue({ ok: true, error: null }),
    dismissCoreProposal: vi.fn().mockResolvedValue({ ok: true, error: null }),
    spawnPty: vi.fn().mockResolvedValue({ sessionId: 'test-session' }),
    writePty: vi.fn(),
    resizePty: vi.fn(),
    killPty: vi.fn(),
    onPtyData: vi.fn().mockReturnValue(() => {}),
    onPtyExit: vi.fn().mockReturnValue(() => {}),
    onRunSessionCaptured: vi.fn().mockReturnValue(() => {}),
    onRunFeedUpdate: vi.fn().mockReturnValue(() => {}),
  } as unknown as MissionControlApi;
}

/** A minimal legacy `ProjectView` — the default repo IS the key (issue 71). */
export function legacyProject(overrides: Partial<ProjectView> = {}): ProjectView {
  const path = overrides.key ?? '/repo/test-project';
  return {
    key: path,
    kind: 'legacy',
    label: 'test-project',
    issuesRoot: `${path}/issues`,
    completionsRoot: `${path}/issues/completions`,
    defaultRepoPath: path,
    repos: {},
    plannedRepoKeys: [],
    notUnderGit: false,
    ...overrides,
  } as ProjectView;
}
