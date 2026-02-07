import type { RefObject } from "react";
import { useCallback } from "react";
import { useNewAgentShortcut } from "./useNewAgentShortcut";
import type { DebugEntry, WorkspaceInfo } from "../../../types";
import type { AppLocale } from "../../../utils/locale";

type Params = {
  activeWorkspace: WorkspaceInfo | null;
  isCompact: boolean;
  addWorkspace: () => Promise<WorkspaceInfo | null>;
  addWorkspaceFromPath: (path: string) => Promise<WorkspaceInfo | null>;
  setActiveThreadId: (threadId: string | null, workspaceId: string) => void;
  setActiveTab: (tab: "projects" | "codex" | "git" | "log") => void;
  exitDiffView: () => void;
  selectWorkspace: (workspaceId: string) => void;
  onStartNewAgentDraft: (workspaceId: string) => void;
  openWorktreePrompt: (workspace: WorkspaceInfo) => void;
  openClonePrompt: (workspace: WorkspaceInfo) => void;
  composerInputRef: RefObject<HTMLTextAreaElement | null>;
  onDebug: (entry: DebugEntry) => void;
  locale: AppLocale;
};

export function useWorkspaceActions({
  activeWorkspace,
  isCompact,
  addWorkspace,
  addWorkspaceFromPath,
  setActiveThreadId,
  setActiveTab,
  exitDiffView,
  selectWorkspace,
  onStartNewAgentDraft,
  openWorktreePrompt,
  openClonePrompt,
  composerInputRef,
  onDebug,
  locale,
}: Params) {
  const handleWorkspaceAdded = useCallback(
    (workspace: WorkspaceInfo) => {
      setActiveThreadId(null, workspace.id);
      if (isCompact) {
        setActiveTab("codex");
      }
    },
    [isCompact, setActiveTab, setActiveThreadId],
  );

  const handleAddWorkspace = useCallback(async () => {
    try {
      const workspace = await addWorkspace();
      if (workspace) {
        handleWorkspaceAdded(workspace);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onDebug({
        id: `${Date.now()}-client-add-workspace-error`,
        timestamp: Date.now(),
        source: "error",
        label: "workspace/add error",
        payload: message,
      });
      alert(locale === "zh-CN" ? `\u6dfb\u52a0\u5de5\u4f5c\u533a\u5931\u8d25\u3002\n\n${message}` : `Failed to add workspace.\n\n${message}`);
    }
  }, [addWorkspace, handleWorkspaceAdded, locale, onDebug]);

  const handleAddWorkspaceFromPath = useCallback(
    async (path: string) => {
      try {
        const workspace = await addWorkspaceFromPath(path);
        if (workspace) {
          handleWorkspaceAdded(workspace);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onDebug({
          id: `${Date.now()}-client-add-workspace-error`,
          timestamp: Date.now(),
          source: "error",
          label: "workspace/add error",
          payload: message,
        });
        alert(locale === "zh-CN" ? `\u6dfb\u52a0\u5de5\u4f5c\u533a\u5931\u8d25\u3002\n\n${message}` : `Failed to add workspace.\n\n${message}`);
      }
    },
    [addWorkspaceFromPath, handleWorkspaceAdded, locale, onDebug],
  );

  const handleAddAgent = useCallback(
    async (workspace: WorkspaceInfo) => {
      exitDiffView();
      selectWorkspace(workspace.id);
      setActiveThreadId(null, workspace.id);
      onStartNewAgentDraft(workspace.id);
      if (isCompact) {
        setActiveTab("codex");
      }
      setTimeout(() => composerInputRef.current?.focus(), 0);
    },
    [
      composerInputRef,
      exitDiffView,
      isCompact,
      onStartNewAgentDraft,
      selectWorkspace,
      setActiveThreadId,
      setActiveTab,
    ],
  );

  const handleAddWorktreeAgent = useCallback(
    async (workspace: WorkspaceInfo) => {
      exitDiffView();
      openWorktreePrompt(workspace);
    },
    [exitDiffView, openWorktreePrompt],
  );

  const handleAddCloneAgent = useCallback(
    async (workspace: WorkspaceInfo) => {
      exitDiffView();
      openClonePrompt(workspace);
    },
    [exitDiffView, openClonePrompt],
  );

  useNewAgentShortcut({
    isEnabled: Boolean(activeWorkspace),
    onTrigger: () => {
      if (activeWorkspace) {
        void handleAddAgent(activeWorkspace);
      }
    },
  });

  return {
    handleAddWorkspace,
    handleAddWorkspaceFromPath,
    handleAddAgent,
    handleAddWorktreeAgent,
    handleAddCloneAgent,
  };
}
