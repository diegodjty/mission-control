/**
 * Preload — the trust boundary. Exposes a narrow, typed `window.mc` surface to
 * the renderer via contextBridge; the renderer never gets `ipcRenderer` or
 * node APIs directly.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IpcChannel,
  type AttentionMarkSeenResult,
  type AttentionSnapshot,
  type NavigateAttentionMessage,
  type BacklogChangedMessage,
  type BacklogLoadRequest,
  type BacklogLoadResult,
  type BacklogWatchRequest,
  type AfkScanRequest,
  type AfkScanResult,
  type AfkDiscardRequest,
  type AfkDiscardResult,
  type DrainJournalRequest,
  type DrainJournalResult,
  type IsolationApplyRequest,
  type IsolationApplyResult,
  type LauncherListResult,
  type OnboardingCreateRequest,
  type OnboardingCreateResult,
  type ProjectGridResult,
  type ProjectRemoveRequest,
  type ProjectRemoveResult,
  type RepoRegisterRequest,
  type RepoRegisterResult,
  type PlanningChangedMessage,
  type PlanningDocReadRequest,
  type PlanningDocReadResult,
  type PlanningWatchRequest,
  type QuickFixCreateRequest,
  type QuickFixCreateResult,
  type IssueFileReadRequest,
  type IssueFileReadResult,
  type IssueFileEditRequest,
  type IssueFileDeleteRequest,
  type IssueFileWriteResult,
  type ChecklistStateGetRequest,
  type ChecklistStateToggleRequest,
  type ChecklistStateResult,
  type IssueStatusObserveRequest,
  type IssueStatusObserveResult,
  type MainCommitRequest,
  type MainCommitResult,
  type WorktreeCommitRequest,
  type WorktreeCommitResult,
  type MergeRunsRequest,
  type MergeRunsResult,
  type MergeAbortRequest,
  type MergeAbortResult,
  type MissionControlApi,
  type ProjectActionResult,
  type ProjectListResult,
  type ProjectOpenRequest,
  type ProjectSwitchRequest,
  type ProjectTransitionRequest,
  type ProjectPickFolderResult,
  type ReceiptCapturedMessage,
  type ReceiptWatchRequest,
  type RunLogLoadRequest,
  type RunLogLoadResult,
  type WindowOpenRequest,
  type WindowOpenResult,
  type PtyDataMessage,
  type PtyExitMessage,
  type PtyKillMessage,
  type PtyResizeMessage,
  type PtySpawnRequest,
  type PtySpawnResult,
  type PtyWriteMessage,
  type RunSessionCapturedMessage,
  type RunFeedUpdateMessage,
} from '../shared/ipc-contract';

const api: MissionControlApi = {
  loadBacklog: (req: BacklogLoadRequest): Promise<BacklogLoadResult> =>
    ipcRenderer.invoke(IpcChannel.BacklogLoad, req),

  watchBacklog: (req: BacklogWatchRequest): void => {
    ipcRenderer.send(IpcChannel.BacklogWatch, req);
  },

  onBacklogChanged: (listener: (msg: BacklogChangedMessage) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, msg: BacklogChangedMessage): void => listener(msg);
    ipcRenderer.on(IpcChannel.BacklogChanged, handler);
    return () => ipcRenderer.removeListener(IpcChannel.BacklogChanged, handler);
  },

  observeIssueStatus: (
    req: IssueStatusObserveRequest,
  ): Promise<IssueStatusObserveResult> =>
    ipcRenderer.invoke(IpcChannel.IssueStatusObserve, req),

  commitFinishedMain: (req: MainCommitRequest): Promise<MainCommitResult> =>
    ipcRenderer.invoke(IpcChannel.MainCommit, req),

  commitFinishedWorktree: (
    req: WorktreeCommitRequest,
  ): Promise<WorktreeCommitResult> =>
    ipcRenderer.invoke(IpcChannel.WorktreeCommit, req),

  scanAfkRuns: (req: AfkScanRequest): Promise<AfkScanResult> =>
    ipcRenderer.invoke(IpcChannel.AfkScan, req),

  discardAfkRun: (req: AfkDiscardRequest): Promise<AfkDiscardResult> =>
    ipcRenderer.invoke(IpcChannel.AfkDiscard, req),

  applyIsolation: (req: IsolationApplyRequest): Promise<IsolationApplyResult> =>
    ipcRenderer.invoke(IpcChannel.IsolationApply, req),

  mergeRuns: (req: MergeRunsRequest): Promise<MergeRunsResult> =>
    ipcRenderer.invoke(IpcChannel.MergeRuns, req),

  abortMerge: (req: MergeAbortRequest): Promise<MergeAbortResult> =>
    ipcRenderer.invoke(IpcChannel.MergeAbort, req),

  openProject: (req: ProjectOpenRequest): Promise<ProjectActionResult> =>
    ipcRenderer.invoke(IpcChannel.ProjectOpen, req),

  switchProject: (req: ProjectSwitchRequest): Promise<ProjectActionResult> =>
    ipcRenderer.invoke(IpcChannel.ProjectSwitch, req),

  transitionProject: (req: ProjectTransitionRequest): Promise<ProjectActionResult> =>
    ipcRenderer.invoke(IpcChannel.ProjectTransition, req),

  listProjects: (): Promise<ProjectListResult> =>
    ipcRenderer.invoke(IpcChannel.ProjectList),

  pickProjectFolder: (): Promise<ProjectPickFolderResult> =>
    ipcRenderer.invoke(IpcChannel.ProjectPickFolder),

  openWindow: (req: WindowOpenRequest): Promise<WindowOpenResult> =>
    ipcRenderer.invoke(IpcChannel.WindowOpen, req),

  onProjectRegistryChanged: (listener: () => void): (() => void) => {
    const handler = (): void => listener();
    ipcRenderer.on(IpcChannel.ProjectRegistryChanged, handler);
    return () => ipcRenderer.removeListener(IpcChannel.ProjectRegistryChanged, handler);
  },

  loadRunLog: (req: RunLogLoadRequest): Promise<RunLogLoadResult> =>
    ipcRenderer.invoke(IpcChannel.RunLogLoad, req),

  watchReceipts: (req: ReceiptWatchRequest): void => {
    ipcRenderer.send(IpcChannel.ReceiptWatch, req);
  },

  onReceiptCaptured: (
    listener: (msg: ReceiptCapturedMessage) => void,
  ): (() => void) => {
    const handler = (_e: IpcRendererEvent, msg: ReceiptCapturedMessage): void => listener(msg);
    ipcRenderer.on(IpcChannel.ReceiptCaptured, handler);
    return () => ipcRenderer.removeListener(IpcChannel.ReceiptCaptured, handler);
  },

  writeDrainJournal: (req: DrainJournalRequest): Promise<DrainJournalResult> =>
    ipcRenderer.invoke(IpcChannel.DrainJournal, req),

  listAttention: (): Promise<AttentionSnapshot> =>
    ipcRenderer.invoke(IpcChannel.AttentionList),

  onAttentionChanged: (listener: (msg: AttentionSnapshot) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, msg: AttentionSnapshot): void => listener(msg);
    ipcRenderer.on(IpcChannel.AttentionChanged, handler);
    return () => ipcRenderer.removeListener(IpcChannel.AttentionChanged, handler);
  },

  markAttentionSeen: (): Promise<AttentionMarkSeenResult> =>
    ipcRenderer.invoke(IpcChannel.AttentionMarkSeen),

  onNavigateAttention: (
    listener: (msg: NavigateAttentionMessage) => void,
  ): (() => void) => {
    const handler = (_e: IpcRendererEvent, msg: NavigateAttentionMessage): void => listener(msg);
    ipcRenderer.on(IpcChannel.NavigateAttention, handler);
    return () => ipcRenderer.removeListener(IpcChannel.NavigateAttention, handler);
  },

  listLauncherProjects: (): Promise<LauncherListResult> =>
    ipcRenderer.invoke(IpcChannel.LauncherList),

  listProjectCards: (): Promise<ProjectGridResult> =>
    ipcRenderer.invoke(IpcChannel.ProjectGrid),

  createQuickFix: (req: QuickFixCreateRequest): Promise<QuickFixCreateResult> =>
    ipcRenderer.invoke(IpcChannel.QuickFixCreate, req),

  createProject: (req: OnboardingCreateRequest): Promise<OnboardingCreateResult> =>
    ipcRenderer.invoke(IpcChannel.OnboardingCreate, req),

  removeProject: (req: ProjectRemoveRequest): Promise<ProjectRemoveResult> =>
    ipcRenderer.invoke(IpcChannel.ProjectRemove, req),

  registerRepo: (req: RepoRegisterRequest): Promise<RepoRegisterResult> =>
    ipcRenderer.invoke(IpcChannel.RepoRegister, req),

  readIssueFile: (req: IssueFileReadRequest): Promise<IssueFileReadResult> =>
    ipcRenderer.invoke(IpcChannel.IssueFileRead, req),

  editIssueFile: (req: IssueFileEditRequest): Promise<IssueFileWriteResult> =>
    ipcRenderer.invoke(IpcChannel.IssueFileEdit, req),

  deleteIssueFile: (req: IssueFileDeleteRequest): Promise<IssueFileWriteResult> =>
    ipcRenderer.invoke(IpcChannel.IssueFileDelete, req),

  getChecklistState: (req: ChecklistStateGetRequest): Promise<ChecklistStateResult> =>
    ipcRenderer.invoke(IpcChannel.ChecklistStateGet, req),

  toggleChecklistItem: (req: ChecklistStateToggleRequest): Promise<ChecklistStateResult> =>
    ipcRenderer.invoke(IpcChannel.ChecklistStateToggle, req),

  watchPlanning: (req: PlanningWatchRequest): void => {
    ipcRenderer.send(IpcChannel.PlanningWatch, req);
  },

  onPlanningChanged: (listener: (msg: PlanningChangedMessage) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, msg: PlanningChangedMessage): void => listener(msg);
    ipcRenderer.on(IpcChannel.PlanningChanged, handler);
    return () => ipcRenderer.removeListener(IpcChannel.PlanningChanged, handler);
  },

  readPlanningDoc: (req: PlanningDocReadRequest): Promise<PlanningDocReadResult> =>
    ipcRenderer.invoke(IpcChannel.PlanningDocRead, req),

  spawnPty: (req: PtySpawnRequest): Promise<PtySpawnResult> =>
    ipcRenderer.invoke(IpcChannel.PtySpawn, req),

  writePty: (msg: PtyWriteMessage): void => {
    ipcRenderer.send(IpcChannel.PtyWrite, msg);
  },

  resizePty: (msg: PtyResizeMessage): void => {
    ipcRenderer.send(IpcChannel.PtyResize, msg);
  },

  killPty: (msg: PtyKillMessage): void => {
    ipcRenderer.send(IpcChannel.PtyKill, msg);
  },

  onPtyData: (listener: (msg: PtyDataMessage) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, msg: PtyDataMessage): void => listener(msg);
    ipcRenderer.on(IpcChannel.PtyData, handler);
    return () => ipcRenderer.removeListener(IpcChannel.PtyData, handler);
  },

  onPtyExit: (listener: (msg: PtyExitMessage) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, msg: PtyExitMessage): void => listener(msg);
    ipcRenderer.on(IpcChannel.PtyExit, handler);
    return () => ipcRenderer.removeListener(IpcChannel.PtyExit, handler);
  },

  onRunSessionCaptured: (
    listener: (msg: RunSessionCapturedMessage) => void,
  ): (() => void) => {
    const handler = (_e: IpcRendererEvent, msg: RunSessionCapturedMessage): void => listener(msg);
    ipcRenderer.on(IpcChannel.RunSessionCaptured, handler);
    return () => ipcRenderer.removeListener(IpcChannel.RunSessionCaptured, handler);
  },

  onRunFeedUpdate: (
    listener: (msg: RunFeedUpdateMessage) => void,
  ): (() => void) => {
    const handler = (_e: IpcRendererEvent, msg: RunFeedUpdateMessage): void => listener(msg);
    ipcRenderer.on(IpcChannel.RunFeedUpdate, handler);
    return () => ipcRenderer.removeListener(IpcChannel.RunFeedUpdate, handler);
  },
};

contextBridge.exposeInMainWorld('mc', api);
