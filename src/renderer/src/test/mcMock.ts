import { vi } from 'vitest';
import type { MissionControlApi } from '../../../shared/ipc-contract';

/**
 * A fully-stubbed `window.mc` bridge (every method a `vi.fn()`), with benign
 * defaults so a fresh App mount doesn't reject/throw on IPC calls it hasn't
 * been told to care about. Tests override individual methods with
 * `mockResolvedValueOnce`/`mockResolvedValue` for the behavior under test.
 */
export function createMcMock(): MissionControlApi {
  return {
    loadBacklog: vi.fn().mockResolvedValue({ backlog: null, projectPath: '' }),
    watchBacklog: vi.fn(),
    onBacklogChanged: vi.fn().mockReturnValue(() => {}),
    observeIssueStatus: vi.fn().mockResolvedValue({ status: null }),
    commitFinishedMain: vi.fn().mockResolvedValue({ adopted: [] }),
    commitFinishedWorktree: vi.fn().mockResolvedValue({ committed: false, error: null }),
    scanAfkRuns: vi.fn().mockResolvedValue({
      branches: [],
      midMerge: false,
      previews: [],
      previewNote: null,
      staleBuildNote: null,
    }),
    discardAfkRun: vi.fn().mockResolvedValue({ ok: true }),
    applyIsolation: vi
      .fn()
      .mockResolvedValue({ placements: [], queuedIssueIds: [], nonGitRoots: [] }),
    mergeRuns: vi.fn().mockResolvedValue({
      ok: true,
      conflicted: false,
      merged: [],
      message: 'Merged.',
      output: '',
    }),
    abortMerge: vi.fn().mockResolvedValue({ ok: true }),
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
    writeDrainJournal: vi.fn().mockResolvedValue({ offerDebrief: false }),
    notifyScheduledDrainSkipped: vi.fn().mockResolvedValue({ notified: false }),
    listAttention: vi.fn().mockResolvedValue({ workbenchRoot: '', items: [], notes: [] }),
    onAttentionChanged: vi.fn().mockReturnValue(() => {}),
    markAttentionSeen: vi.fn().mockResolvedValue({ ok: true }),
    onNavigateAttention: vi.fn().mockReturnValue(() => {}),
    listLauncherProjects: vi.fn().mockResolvedValue({ projects: [] }),
    listProjectCards: vi.fn().mockResolvedValue({ cards: [] }),
    createQuickFix: vi.fn().mockResolvedValue({ ok: true }),
    createProject: vi.fn().mockResolvedValue({ ok: true }),
    removeProject: vi.fn().mockResolvedValue({ ok: true, projects: [] }),
    registerRepo: vi.fn().mockResolvedValue({ ok: true, errors: [], key: null }),
    timeoutSalvageVerify: vi.fn().mockResolvedValue({ ok: true }),
    timeoutSalvageComplete: vi.fn().mockResolvedValue({ ok: true }),
    timeoutSalvageDiscard: vi.fn().mockResolvedValue({ ok: true }),
    gitInit: vi.fn().mockResolvedValue({ ok: true }),
    getGitBranchStatus: vi
      .fn()
      .mockResolvedValue({ branch: 'afk-work', detached: false, protectedBranch: false }),
    listGitBranches: vi.fn().mockResolvedValue({ branches: [] }),
    createGitBranch: vi.fn().mockResolvedValue({ ok: true }),
    switchGitBranch: vi.fn().mockResolvedValue({ ok: true }),
    readIssueFile: vi.fn().mockResolvedValue({ content: null }),
    editIssueFile: vi.fn().mockResolvedValue({ ok: true }),
    deleteIssueFile: vi.fn().mockResolvedValue({ ok: true }),
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
    readCoreProposal: vi.fn().mockResolvedValue({ content: null }),
    acceptCoreProposal: vi.fn().mockResolvedValue({ ok: true }),
    dismissCoreProposal: vi.fn().mockResolvedValue({ ok: true }),
    spawnPty: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
    writePty: vi.fn(),
    resizePty: vi.fn(),
    killPty: vi.fn(),
    onPtyData: vi.fn().mockReturnValue(() => {}),
    onPtyExit: vi.fn().mockReturnValue(() => {}),
    onRunSessionCaptured: vi.fn().mockReturnValue(() => {}),
    onRunFeedUpdate: vi.fn().mockReturnValue(() => {}),
  } as unknown as MissionControlApi;
}
