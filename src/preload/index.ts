/**
 * Preload — the trust boundary. Exposes a narrow, typed `window.mc` surface to
 * the renderer via contextBridge; the renderer never gets `ipcRenderer` or
 * node APIs directly.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IpcChannel,
  type BacklogChangedMessage,
  type BacklogLoadRequest,
  type BacklogLoadResult,
  type BacklogWatchRequest,
  type IsolationApplyRequest,
  type IsolationApplyResult,
  type IssueStatusObserveRequest,
  type IssueStatusObserveResult,
  type MergeRunsRequest,
  type MergeRunsResult,
  type MissionControlApi,
  type ProjectActionResult,
  type ProjectListResult,
  type ProjectOpenRequest,
  type ProjectSwitchRequest,
  type ProjectTransitionRequest,
  type WindowOpenRequest,
  type WindowOpenResult,
  type PtyDataMessage,
  type PtyExitMessage,
  type PtyKillMessage,
  type PtyResizeMessage,
  type PtySpawnRequest,
  type PtySpawnResult,
  type PtyWriteMessage,
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

  applyIsolation: (req: IsolationApplyRequest): Promise<IsolationApplyResult> =>
    ipcRenderer.invoke(IpcChannel.IsolationApply, req),

  mergeRuns: (req: MergeRunsRequest): Promise<MergeRunsResult> =>
    ipcRenderer.invoke(IpcChannel.MergeRuns, req),

  openProject: (req: ProjectOpenRequest): Promise<ProjectActionResult> =>
    ipcRenderer.invoke(IpcChannel.ProjectOpen, req),

  switchProject: (req: ProjectSwitchRequest): Promise<ProjectActionResult> =>
    ipcRenderer.invoke(IpcChannel.ProjectSwitch, req),

  transitionProject: (req: ProjectTransitionRequest): Promise<ProjectActionResult> =>
    ipcRenderer.invoke(IpcChannel.ProjectTransition, req),

  listProjects: (): Promise<ProjectListResult> =>
    ipcRenderer.invoke(IpcChannel.ProjectList),

  openWindow: (req: WindowOpenRequest): Promise<WindowOpenResult> =>
    ipcRenderer.invoke(IpcChannel.WindowOpen, req),

  onProjectRegistryChanged: (listener: () => void): (() => void) => {
    const handler = (): void => listener();
    ipcRenderer.on(IpcChannel.ProjectRegistryChanged, handler);
    return () => ipcRenderer.removeListener(IpcChannel.ProjectRegistryChanged, handler);
  },

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
};

contextBridge.exposeInMainWorld('mc', api);
