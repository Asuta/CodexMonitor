import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up";
import LayoutGrid from "lucide-react/dist/esm/icons/layout-grid";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal";
import Mic from "lucide-react/dist/esm/icons/mic";
import Keyboard from "lucide-react/dist/esm/icons/keyboard";
import Stethoscope from "lucide-react/dist/esm/icons/stethoscope";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import TerminalSquare from "lucide-react/dist/esm/icons/terminal-square";
import FileText from "lucide-react/dist/esm/icons/file-text";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import X from "lucide-react/dist/esm/icons/x";
import FlaskConical from "lucide-react/dist/esm/icons/flask-conical";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import Layers from "lucide-react/dist/esm/icons/layers";
import type {
  AppSettings,
  CodexDoctorResult,
  DictationModelStatus,
  WorkspaceSettings,
  OpenAppTarget,
  WorkspaceGroup,
  WorkspaceInfo,
} from "../../../types";
import { formatDownloadSize } from "../../../utils/formatting";
import {
  fileManagerName,
  isMacPlatform,
  isWindowsPlatform,
  openInFileManagerLabel,
} from "../../../utils/platformPaths";
import {
  buildShortcutValue,
  formatShortcut,
  getDefaultInterruptShortcut,
} from "../../../utils/shortcuts";
import { clampUiScale } from "../../../utils/uiScale";
import { getCodexConfigPath } from "../../../services/tauri";
import { pushErrorToast } from "../../../services/toasts";
import {
  DEFAULT_CODE_FONT_FAMILY,
  DEFAULT_UI_FONT_FAMILY,
  CODE_FONT_SIZE_DEFAULT,
  CODE_FONT_SIZE_MAX,
  CODE_FONT_SIZE_MIN,
  clampCodeFontSize,
  normalizeFontFamily,
} from "../../../utils/fonts";
import { DEFAULT_OPEN_APP_ID, OPEN_APP_STORAGE_KEY } from "../../app/constants";
import { GENERIC_APP_ICON, getKnownOpenAppIcon } from "../../app/utils/openAppIcons";
import { useGlobalAgentsMd } from "../hooks/useGlobalAgentsMd";
import { useGlobalCodexConfigToml } from "../hooks/useGlobalCodexConfigToml";
import { FileEditorCard } from "../../shared/components/FileEditorCard";
import type { AppLocale } from "../../../utils/locale";

const DICTATION_MODELS = [
  { id: "tiny", label: "Tiny", size: "75 MB", note: "Fastest, least accurate." },
  { id: "base", label: "Base", size: "142 MB", note: "Balanced default." },
  { id: "small", label: "Small", size: "466 MB", note: "Better accuracy." },
  { id: "medium", label: "Medium", size: "1.5 GB", note: "High accuracy." },
  { id: "large-v3", label: "Large V3", size: "3.0 GB", note: "Best accuracy, heavy download." },
];

type ComposerPreset = AppSettings["composerEditorPreset"];

type ComposerPresetSettings = Pick<
  AppSettings,
  | "composerFenceExpandOnSpace"
  | "composerFenceExpandOnEnter"
  | "composerFenceLanguageTags"
  | "composerFenceWrapSelection"
  | "composerFenceAutoWrapPasteMultiline"
  | "composerFenceAutoWrapPasteCodeLike"
  | "composerListContinuation"
  | "composerCodeBlockCopyUseModifier"
>;

const COMPOSER_PRESET_LABELS: Record<ComposerPreset, string> = {
  default: "Default (no helpers)",
  helpful: "Helpful",
  smart: "Smart",
};

const COMPOSER_PRESET_CONFIGS: Record<ComposerPreset, ComposerPresetSettings> = {
  default: {
    composerFenceExpandOnSpace: false,
    composerFenceExpandOnEnter: false,
    composerFenceLanguageTags: false,
    composerFenceWrapSelection: false,
    composerFenceAutoWrapPasteMultiline: false,
    composerFenceAutoWrapPasteCodeLike: false,
    composerListContinuation: false,
    composerCodeBlockCopyUseModifier: false,
  },
  helpful: {
    composerFenceExpandOnSpace: true,
    composerFenceExpandOnEnter: false,
    composerFenceLanguageTags: true,
    composerFenceWrapSelection: true,
    composerFenceAutoWrapPasteMultiline: true,
    composerFenceAutoWrapPasteCodeLike: false,
    composerListContinuation: true,
    composerCodeBlockCopyUseModifier: false,
  },
  smart: {
    composerFenceExpandOnSpace: true,
    composerFenceExpandOnEnter: false,
    composerFenceLanguageTags: true,
    composerFenceWrapSelection: true,
    composerFenceAutoWrapPasteMultiline: true,
    composerFenceAutoWrapPasteCodeLike: true,
    composerListContinuation: true,
    composerCodeBlockCopyUseModifier: false,
  },
};

const normalizeOverrideValue = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const normalizeWorktreeSetupScript = (
  value: string | null | undefined,
): string | null => {
  const next = value ?? "";
  return next.trim().length > 0 ? next : null;
};

const buildWorkspaceOverrideDrafts = (
  projects: WorkspaceInfo[],
  prev: Record<string, string>,
  getValue: (workspace: WorkspaceInfo) => string | null | undefined,
): Record<string, string> => {
  const next: Record<string, string> = {};
  projects.forEach((workspace) => {
    const existing = prev[workspace.id];
    next[workspace.id] = existing ?? getValue(workspace) ?? "";
  });
  return next;
};

export type SettingsViewProps = {
  workspaceGroups: WorkspaceGroup[];
  groupedWorkspaces: Array<{
    id: string | null;
    name: string;
    workspaces: WorkspaceInfo[];
  }>;
  ungroupedLabel: string;
  onClose: () => void;
  onMoveWorkspace: (id: string, direction: "up" | "down") => void;
  onDeleteWorkspace: (id: string) => void;
  onCreateWorkspaceGroup: (name: string) => Promise<WorkspaceGroup | null>;
  onRenameWorkspaceGroup: (id: string, name: string) => Promise<boolean | null>;
  onMoveWorkspaceGroup: (id: string, direction: "up" | "down") => Promise<boolean | null>;
  onDeleteWorkspaceGroup: (id: string) => Promise<boolean | null>;
  onAssignWorkspaceGroup: (
    workspaceId: string,
    groupId: string | null,
  ) => Promise<boolean | null>;
  reduceTransparency: boolean;
  onToggleTransparency: (value: boolean) => void;
  appSettings: AppSettings;
  openAppIconById: Record<string, string>;
  onUpdateAppSettings: (next: AppSettings) => Promise<void>;
  onRunDoctor: (
    codexBin: string | null,
    codexArgs: string | null,
  ) => Promise<CodexDoctorResult>;
  onUpdateWorkspaceCodexBin: (id: string, codexBin: string | null) => Promise<void>;
  onUpdateWorkspaceSettings: (
    id: string,
    settings: Partial<WorkspaceSettings>,
  ) => Promise<void>;
  scaleShortcutTitle: string;
  scaleShortcutText: string;
  onTestNotificationSound: () => void;
  onTestSystemNotification: () => void;
  dictationModelStatus?: DictationModelStatus | null;
  onDownloadDictationModel?: () => void;
  onCancelDictationDownload?: () => void;
  onRemoveDictationModel?: () => void;
  initialSection?: CodexSection;
  locale?: AppLocale;
  onLocaleChange?: (locale: AppLocale) => void;
};

type SettingsSection =
  | "projects"
  | "environments"
  | "display"
  | "composer"
  | "dictation"
  | "shortcuts"
  | "open-apps"
  | "git";
type CodexSection = SettingsSection | "codex" | "features";
type ShortcutSettingKey =
  | "composerModelShortcut"
  | "composerAccessShortcut"
  | "composerReasoningShortcut"
  | "composerCollaborationShortcut"
  | "interruptShortcut"
  | "newAgentShortcut"
  | "newWorktreeAgentShortcut"
  | "newCloneAgentShortcut"
  | "archiveThreadShortcut"
  | "toggleProjectsSidebarShortcut"
  | "toggleGitSidebarShortcut"
  | "branchSwitcherShortcut"
  | "toggleDebugPanelShortcut"
  | "toggleTerminalShortcut"
  | "cycleAgentNextShortcut"
  | "cycleAgentPrevShortcut"
  | "cycleWorkspaceNextShortcut"
  | "cycleWorkspacePrevShortcut";
type ShortcutDraftKey =
  | "model"
  | "access"
  | "reasoning"
  | "collaboration"
  | "interrupt"
  | "newAgent"
  | "newWorktreeAgent"
  | "newCloneAgent"
  | "archiveThread"
  | "projectsSidebar"
  | "gitSidebar"
  | "branchSwitcher"
  | "debugPanel"
  | "terminal"
  | "cycleAgentNext"
  | "cycleAgentPrev"
  | "cycleWorkspaceNext"
  | "cycleWorkspacePrev";

type OpenAppDraft = OpenAppTarget & { argsText: string };

const shortcutDraftKeyBySetting: Record<ShortcutSettingKey, ShortcutDraftKey> = {
  composerModelShortcut: "model",
  composerAccessShortcut: "access",
  composerReasoningShortcut: "reasoning",
  composerCollaborationShortcut: "collaboration",
  interruptShortcut: "interrupt",
  newAgentShortcut: "newAgent",
  newWorktreeAgentShortcut: "newWorktreeAgent",
  newCloneAgentShortcut: "newCloneAgent",
  archiveThreadShortcut: "archiveThread",
  toggleProjectsSidebarShortcut: "projectsSidebar",
  toggleGitSidebarShortcut: "gitSidebar",
  branchSwitcherShortcut: "branchSwitcher",
  toggleDebugPanelShortcut: "debugPanel",
  toggleTerminalShortcut: "terminal",
  cycleAgentNextShortcut: "cycleAgentNext",
  cycleAgentPrevShortcut: "cycleAgentPrev",
  cycleWorkspaceNextShortcut: "cycleWorkspaceNext",
  cycleWorkspacePrevShortcut: "cycleWorkspacePrev",
};

const buildOpenAppDrafts = (targets: OpenAppTarget[]): OpenAppDraft[] =>
  targets.map((target) => ({
    ...target,
    argsText: target.args.join(" "),
  }));

const isOpenAppLabelValid = (label: string) => label.trim().length > 0;

const isOpenAppDraftComplete = (draft: OpenAppDraft) => {
  if (!isOpenAppLabelValid(draft.label)) {
    return false;
  }
  if (draft.kind === "app") {
    return Boolean(draft.appName?.trim());
  }
  if (draft.kind === "command") {
    return Boolean(draft.command?.trim());
  }
  return true;
};

const isOpenAppTargetComplete = (target: OpenAppTarget) => {
  if (!isOpenAppLabelValid(target.label)) {
    return false;
  }
  if (target.kind === "app") {
    return Boolean(target.appName?.trim());
  }
  if (target.kind === "command") {
    return Boolean(target.command?.trim());
  }
  return true;
};

const createOpenAppId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `open-app-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

export function SettingsView({
  workspaceGroups,
  groupedWorkspaces,
  ungroupedLabel,
  onClose,
  onMoveWorkspace,
  onDeleteWorkspace,
  onCreateWorkspaceGroup,
  onRenameWorkspaceGroup,
  onMoveWorkspaceGroup,
  onDeleteWorkspaceGroup,
  onAssignWorkspaceGroup,
  reduceTransparency,
  onToggleTransparency,
  appSettings,
  openAppIconById,
  onUpdateAppSettings,
  onRunDoctor,
  onUpdateWorkspaceCodexBin,
  onUpdateWorkspaceSettings,
  scaleShortcutTitle,
  scaleShortcutText,
  onTestNotificationSound,
  onTestSystemNotification,
  dictationModelStatus,
  onDownloadDictationModel,
  onCancelDictationDownload,
  onRemoveDictationModel,
  initialSection,
  locale = "en",
  onLocaleChange,
}: SettingsViewProps) {
  const isZh = locale === "zh-CN";
  const t = (en: string, zh: string) => (isZh ? zh : en);
  const settingsWindowRef = useRef<HTMLDivElement | null>(null);
  const originalTextRef = useRef<WeakMap<Text, string>>(new WeakMap());
  const originalAttrRef = useRef<WeakMap<Element, Map<string, string>>>(new WeakMap());
  const settingsTranslations = useMemo(
    () =>
      new Map<string, string>([
        ["Settings", "\u8bbe\u7f6e"],
        ["Close settings", "\u5173\u95ed\u8bbe\u7f6e"],
        ["Projects", "\u9879\u76ee"],
        ["Environments", "\u73af\u5883"],
        ["Display & Sound", "\u663e\u793a\u4e0e\u58f0\u97f3"],
        ["Composer", "\u8f93\u5165\u7f16\u8f91"],
        ["Dictation", "\u8bed\u97f3\u8f93\u5165"],
        ["Shortcuts", "\u5feb\u6377\u952e"],
        ["Open in", "\u6253\u5f00\u65b9\u5f0f"],
        ["Features", "\u529f\u80fd\u7279\u6027"],
        ["Language", "\u8bed\u8a00"],
        ["Group related workspaces and reorder projects within each group.", "\u5c06\u76f8\u5173\u5de5\u4f5c\u533a\u5206\u7ec4\uff0c\u5e76\u5728\u6bcf\u4e2a\u5206\u7ec4\u5185\u8c03\u6574\u9879\u76ee\u987a\u5e8f\u3002"],
        ["Create group labels for related repositories.", "\u4e3a\u76f8\u5173\u4ed3\u5e93\u521b\u5efa\u5206\u7ec4\u6807\u7b7e\u3002"],
        ["New group name", "\u65b0\u5206\u7ec4\u540d\u79f0"],
        ["No projects yet.", "\u6682\u65e0\u9879\u76ee\u3002"],
        ["Project", "\u9879\u76ee"],
        ["Setup script", "\u521d\u59cb\u5316\u811a\u672c"],
        ["Configure per-project setup scripts that run after worktree creation.", "\u914d\u7f6e\u6bcf\u4e2a\u9879\u76ee\u5728\u521b\u5efa\u5de5\u4f5c\u6811\u540e\u8fd0\u884c\u7684\u521d\u59cb\u5316\u811a\u672c\u3002"],
        ["Runs once in a dedicated terminal after each new worktree is created.", "\u6bcf\u6b21\u65b0\u5efa\u5de5\u4f5c\u6811\u540e\uff0c\u4f1a\u5728\u72ec\u7acb\u7ec8\u7aef\u4e2d\u6267\u884c\u4e00\u6b21\u3002"],
        ["Tune visuals and audio alerts to your preferences.", "\u6309\u4f60\u7684\u504f\u597d\u8c03\u6574\u754c\u9762\u663e\u793a\u548c\u63d0\u793a\u97f3\u3002"],
        ["Display", "\u663e\u793a"],
        ["Adjust how the window renders backgrounds and effects.", "\u8c03\u6574\u7a97\u53e3\u80cc\u666f\u4e0e\u89c6\u89c9\u6548\u679c\u7684\u663e\u793a\u65b9\u5f0f\u3002"],
        ["Theme", "\u4e3b\u9898"],
        ["System", "\u8ddf\u968f\u7cfb\u7edf"],
        ["Dark", "\u6df1\u8272"],
        ["Light", "\u6d45\u8272"],
        ["Scale", "\u7f29\u653e"],
        ["Copy", "\u590d\u5236"],
        ["Reset", "\u91cd\u7f6e"],
        ["Save", "\u4fdd\u5b58"],
        ["Saving...", "\u4fdd\u5b58\u4e2d..."],
        ["Cancel", "\u53d6\u6d88"],
        ["Apply", "\u5e94\u7528"],
        ["Browse", "\u6d4f\u89c8"],
        ["Download", "\u4e0b\u8f7d"],
        ["Remove", "\u79fb\u9664"],
        ["Run doctor", "\u8fd0\u884c\u8bca\u65ad"],
        ["Copy failed", "\u590d\u5236\u5931\u8d25"],
        ["Clipboard access is unavailable in this environment. Copy the script manually instead.", "\u5f53\u524d\u73af\u5883\u65e0\u6cd5\u8bbf\u95ee\u526a\u8d34\u677f\uff0c\u8bf7\u624b\u52a8\u590d\u5236\u811a\u672c\u3002"],
        ["Enable microphone dictation with on-device transcription.", "启用本地转写的麦克风语音输入。"],
        ["Enable dictation", "启用语音输入"],
        ["Downloads the selected Whisper model on first use.", "首次使用时会下载所选 Whisper 模型。"],
        ["Dictation model", "语音模型"],
        ["Preferred dictation language", "首选语音识别语言"],
        ["Auto-detect only", "仅自动检测"],
        ["Auto-detect stays on; this nudges the decoder toward your preference.", "保持自动检测开启；这会让解码器更倾向你的语言偏好。"],
        ["Hold-to-dictate key", "按住说话快捷键"],
        ["Hold the key to start dictation, release to stop and process.", "按住按键开始输入，松开后停止并处理。"],
        ["Model status", "模型状态"],
        ["Model not downloaded yet.", "模型尚未下载。"],
        ["Download model", "下载模型"],
        ["Model downloaded and ready.", "模型已下载，可以使用。"],
        ["Model removed.", "模型已移除。"],
        ["Downloading model...", "正在下载模型..."],
        ["Balanced default.", "均衡默认。"],
        ["Fastest, least accurate.", "速度最快，准确率较低。"],
        ["Better accuracy.", "更高准确率。"],
        ["High accuracy.", "高准确率。"],
        ["Best accuracy, heavy download.", "最佳准确率，下载较大。"],
        ["English", "英语"],
        ["Chinese", "中文"],
        ["Japanese", "日语"],
        ["Korean", "韩语"],
        ["French", "法语"],
        ["German", "德语"],
        ["Spanish", "西班牙语"],
        ["Portuguese", "葡萄牙语"],
        ["Italian", "意大利语"],
        ["Russian", "俄语"],
        ["Hindi", "印地语"],
        ["Arabic", "阿拉伯语"],
        ["Turkish", "土耳其语"],
        ["Vietnamese", "越南语"],
        ["Thai", "泰语"],
        ["Polish", "波兰语"],
        ["Dutch", "荷兰语"],
        ["Ukrainian", "乌克兰语"],
        ["Indonesian", "印尼语"],
        ["Czech", "捷克语"],
        ["Romanian", "罗马尼亚语"],
        ["Hungarian", "匈牙利语"],
        ["Swedish", "瑞典语"],
        ["Norwegian", "挪威语"],
        ["Danish", "丹麦语"],
        ["Finnish", "芬兰语"],
        ["Hebrew", "希伯来语"],
        ["Greek", "希腊语"],
        ["Catalan", "加泰罗尼亚语"],
        ["Malay", "马来语"],
        ["Downloads", "下载"],
        ["Download size:", "下载大小："],
        ["Hold key", "按键"],
        ["Alt", "Alt"],
        ["Ctrl", "Ctrl"],
        ["Shift", "Shift"],
        ["Meta", "Meta"],
        ["No hold key", "不使用按住键"],
        ["Could not access microphone.", "无法访问麦克风。"],
        ["Codex", "Codex"],
        ["Loading?", "加载中?"],
        ["Not found", "未找到"],
        ["Not set", "未设置"],
        ["Delete", "删除"],
        ["Delete project", "删除项目"],
        ["Delete group", "删除分组"],
        ["Delete Group", "删除分组"],
        ["Create", "创建"],
        ["Move up", "上移"],
        ["Move down", "下移"],
        ["Move group up", "分组上移"],
        ["Move group down", "分组下移"],
        ["Move project up", "项目上移"],
        ["Move project down", "项目下移"],
        ["Remote backend host", "远程后端主机"],
        ["Remote backend token", "远程后端令牌"],
        ["Token (optional)", "令牌（可选）"],
        ["Interface scale", "界面缩放"],
        ["Windows", "Windows"],
        ["Personality", "个性风格"],
        ["Friendly", "友好"],
        ["Pragmatic", "务实"],
        ["Default (no helpers)", "默认（无辅助）"],
        ["Helpful", "帮助型"],
        ["Smart", "智能"],
        ["Type shortcut", "输入快捷键"],
        ["File", "文件"],
        ["Panels", "面板"],
        ["Navigation", "导航"],
        ["Option", "选项"],
        ["Label", "标签"],
        ["App name", "应用名称"],
        ["Command", "命令"],
        ["Args", "参数"],
        ["App name required", "请填写应用名称"],
        ["Label required", "请填写标签"],
        ["Command required", "请填写命令"],
        ["Complete required fields", "请先填写必填项"],
        ["New App", "新增应用"],
        ["Remove app", "移除应用"],
        ["Apps open via `open -a` with optional args.", "应用通过 `open -a` 方式打开，可附加参数。"],
        ["Apps run as an executable with optional args.", "应用以可执行文件方式运行，可附加参数。"],
        ["Global AGENTS.md", "全局 AGENTS.md"],
        ["Global config.toml", "全局 config.toml"],
        ["Truncated", "已截断"],
        ["Unable to open config.", "无法打开配置。"],
        ["Could not access microphone.", "无法访问麦克风。"],
        ["Ready for dictation.", "语音输入已就绪。"],
        ["Download error.", "下载失败。"],
        ["Downloads", "下载"],
        ["Download size:", "下载大小："],
        ["No hold key", "不使用按住键"],
        ["Hold key", "按键"],
        ["default", "默认"],
        ["running", "运行中"],
        ["failed", "失败"],
        ["ready", "已就绪"],
        ["done", "已完成"],
        ["true", "是"],
        ["false", "否"],
        ["No groups yet.", "尚无群组。"],
        ["Add group", "新增分组"],
        ["Choose?", "\u9009\u62e9\u2026"],
        ["Assign projects to groups and adjust their order.", "将项目分配给组并调整其顺序。"],
        ["Copies folder", "复制文件夹"],
        ["Adjusts code and diff text size.", "调整代码和差异文本大小。"],
        ["Control notification audio alerts.", "控制通知音频警报。"],
        ["Test sound", "测试声音"],
        ["Test notification", "测试提醒"],
        ["Control helpers and formatting behavior inside the message editor.", "在消息编辑器中控制助手和格式化行为。"],
        ["Choose a starting point and fine-tune the toggles below.", "选择一个起点并微调下面的切换开关。"],
        ["Preset", "\u9884\u8bbe"],
        ["Presets update the toggles below. Customize any setting after selecting.", "预设值更新下面的切换开关。选择后自定义任何设置。"],
        ["Typing ``` then Space inserts a fenced block.", "键入“” ，然后Space插入一个带围栏的块。"],
        ["Use Enter to expand ``` lines when enabled.", "启用后，使用Enter扩展“”行。"],
        ["Allows ```lang + Space to include a language.", "允许`` `lang + Space包含语言。"],
        ["Wraps selected text when creating a fence.", "创建围栏时环绕所选文本。"],
        ["Wraps multi-line paste inside a fenced block.", "将多行粘贴包裹在围栏块内。"],
        ["Wraps long single-line code snippets on paste.", "在粘贴时包装长单行代码片段。"],
        ["Continues numbered and bulleted lists when the line has content.", "当行有内容时，继续编号和项目符号列表。"],
        ["Copy blocks without fences", "复制没有围栏的块"],
        ["Display what is left instead of what is used.", "显示剩下的内容，而不是使用的内容。"],
        ["Show remaining Codex limits", "\u663e\u793a Codex \u5269\u4f59\u9650\u989d"],
        ["Off", "\u5173\u95ed"],
        ["Cancel download", "不再下载"],
        ["Remove model", "移除模型"],
        ["Customize keyboard shortcuts for file actions, composer, panels, and navigation.", "自定义文件操作、撰写器、面板和导航的键盘快捷方式。"],
        ["Create agents and worktrees from the keyboard.", "从键盘创建座席和工作树。"],
        ["Toggle sidebars and panels.", "切换侧边栏和面板。"],
        ["Cycle between model, access, reasoning, and collaboration modes.", "在模型、访问、推理和协作模式之间循环。"],
        ["Cycle between agents and workspaces.", "在代理和工作区之间循环。"],
        ["Customize the Open in menu shown in the title bar and file previews.", "自定义标题栏和文件预览中显示的“打开方式”菜单。"],
        ["Add app", "添加应用程序"],
        ["Commands receive the selected path as the final argument.", "命令接收所选路径作为最终参数。"],
        ["Manage how diffs are loaded in the Git sidebar.", "管理差异在Git侧边栏中的加载方式。"],
        ["Make viewing git diff faster.", "使查看git diff更快。"],
        ["Hides whitespace-only changes in local and commit diffs.", "在本地和提交差异中隐藏仅限空白的更改。"],
        ["Configure the Codex CLI used by CodexMonitor and validate the install.", "配置CodexMonitor使用的Codex CLI并验证安装。"],
        ["Leave empty to use the system PATH resolution.", "留空以使用系统路径分辨率。"],
        ["Extra flags passed before ", "之前传递的额外标记 "],
        [". Use quotes for values with spaces.", "。对带空格的值使用引号。"],
        ["Default access mode", "\u9ed8\u8ba4\u8bbf\u95ee\u6a21\u5f0f"],
        ["Read only", "只读"],
        ["On-request", "请求"],
        ["Full access", "完全访问"],
        ["Review mode", "\u5ba1\u67e5\u6a21\u5f0f"],
        ["Inline (same thread)", "\u5185\u8054\uff08\u540c\u4e00\u7ebf\u7a0b\uff09"],
        ["Detached (new review thread)", "\u5206\u79bb\uff08\u65b0\u5ba1\u67e5\u7ebf\u7a0b\uff09"],
        ["Choose whether ", "选择是否 "],
        ["runs in the current thread or a detached review thread.", "在当前线程或分离的评论线程中运行。"],
        ["Backend mode", "后端模式"],
        ["Local (default)", "\u672c\u5730\uff08\u9ed8\u8ba4\uff09"],
        ["Remote (daemon)", "远程（守护程序）"],
        ["Remote backend", "远程后端"],
        ["Remote mode connects to a separate daemon running the backend on another machine (e.g. WSL2/Linux).", "远程模式连接到另一台机器上运行后端的单独守护程序（例如WSL2/Linux ）。"],
        ["Start the daemon separately and point CodexMonitor to it (host:port + token).", "单独启动守护程序，并将CodexMonitor指向它（主机：端口+令牌）。"],
        ["Manage stable and experimental Codex features.", "管理稳定和实验性的Codex功能。"],
        ["Feature settings are stored in the default CODEX_HOME config.toml.", "功能设置存储在默认的CODEX_HOME config.toml中。"],
        ["Workspace overrides are not updated.", "工作区覆盖未更新。"],
        ["Open the Codex config in ", "\u5728\u4ee5\u4e0b\u8def\u5f84\u6253\u5f00 Codex \u914d\u7f6e\uff1a"],
        ["Stable Features", "稳定的功能"],
        ["Production-ready features enabled by default.", "默认情况下启用生产就绪功能。"],
        ["Collaboration modes", "协作模式"],
        ["Enable collaboration mode presets (Code, Plan).", "启用协作模式预设（代码、计划）。"],
        ["Choose Codex communication style (writes top-level ", "选择Codex沟通风格（写入顶级 "],
        ["in config.toml).", "在config.toml中）。"],
        ["Steer mode", "转向模式"],
        ["Send messages immediately. Use Tab to queue while a run is active.", "立即发送消息。在运行处于活动状态时，使用Tab排队。"],
        ["Background terminal", "后台终端"],
        ["Run long-running terminal commands in the background.", "在后台运行长时间运行的终端命令。"],
        ["Experimental Features", "实验性功能"],
        ["Preview features that may change or be removed.", "预览可能更改或删除的功能。"],
        ["Enable multi-agent collaboration tools in Codex.", "在Codex中启用多代理协作工具。"],
        ["Enable ChatGPT apps/connectors and the ", "\u542f\u7528 ChatGPT \u5e94\u7528/\u8fde\u63a5\u5668\uff0c\u4ee5\u53ca "],
        ["command.", "\u547d\u4ee4\u3002"],
        ["Config file", "配置文件"],
        ["Reduce transparency", "減少透明"],
        ["Notification sounds", "通知音效"],
        ["System notifications", "系统通知"],
        ["Code font family", "代码字体系列"],
        ["Code font size", "代码字体大小"],
        ["UI font family", "UI字体"],
        ["Workspace overrides", "工作区覆盖"],
        ["Dim", "暗光"],
        ["Stored at ", "储存在 "],
        ["Add global instructions for Codex agents?", "添加针对Codex代理的全局说明？"],
        ["Edit the global Codex config.toml?", "编辑全局Codex config.toml ？"],
        ["CODEX_HOME override", "CODEX_HOME覆盖"],
        ["Codex args override", "Codex参数覆盖"],
        ["Codex binary override", "Codex二进制覆盖"],
        ["Applies to all UI text. Leave empty to use the default system font stack.", "适用于所有UI文本。留空以使用默认系统字体堆栈。"],
        ["Applies to git diffs and other mono-spaced readouts.", "适用于git diffs和其他单间距读数。"],
        ["Archive active thread", "存档活动线程"],
        ["Auto-wrap code-like single lines", "自动换行，类似于单行代码"],
        ["Auto-wrap multi-line paste", "自动包装多行粘贴"],
        ["Branch switcher", "分支切换器"],
        ["Choose whether", "\u9009\u62e9\u662f\u5426"],
        ["Choose...", "\u9009\u62e9\u2026"],
        ["Code fences", "代码围栏"],
        ["Continue lists on Shift+Enter", "在Shift + Enter上继续列表"],
        ["Cycle access mode", "循环访问模式"],
        ["Cycle collaboration mode", "循环协作模式"],
        ["Cycle model", "\u5faa\u73af\u6a21\u578b"],
        ["Cycle reasoning mode", "循环推理模式"],
        ["Default Codex args", "默认Codex参数"],
        ["Default Codex path", "默认Codex路径"],
        ["Expand fences on Enter", "在Enter键上展开围栏"],
        ["Expand fences on Space", "\u6309 Space \u5c55\u5f00\u56f4\u680f"],
        ["Extra flags passed before", "之前传递的额外标记"],
        ["Ignore whitespace changes", "忽略空格更改"],
        ["New Agent", "\u65b0\u5efa Agent"],
        ["New Clone Agent", "新建克隆代理"],
        ["New Worktree Agent", "新建工作树代理"],
        ["Next agent", "\u4e0b\u4e00\u4e2a Agent"],
        ["Next workspace", "下一个工作区"],
        ["Play a sound when a long-running agent finishes while the window is unfocused.", "当窗口未对焦时，长时间运行的代理结束时播放声音。"],
        ["Preload git diffs", "预加载git diffs"],
        ["Previous agent", "\u4e0a\u4e00\u4e2a Agent"],
        ["Previous workspace", "先前的工作区"],
        ["Show a system notification when a long-running agent finishes while the window is unfocused.", "当窗口未聚焦时，长时间运行的座席完成时显示系统通知。"],
        ["Stop active run", "停止活动运行"],
        ["Stored at", "储存在"],
        ["Support language tags", "\u652f\u6301\u8bed\u8a00\u6807\u7b7e"],
        ["Toggle debug panel", "切换调试面板"],
        ["Toggle git sidebar", "切换git侧边栏"],
        ["Toggle projects sidebar", "切换项目侧边栏"],
        ["Toggle terminal panel", "\u5207\u6362\u7ec8\u7aef\u9762\u677f"],
        ["Use solid surfaces instead of glass.", "使用实心表面代替玻璃。"],
        ["Wrap selection in fences", "用栅栏包裹所选内容"],
        ["Clear", "\u6e05\u9664"],
        ["Choose\u2026", "\u9009\u62e9\u2026"],
        ["Add global instructions for Codex agents\u2026", "\u4e3a Codex agents \u6dfb\u52a0\u5168\u5c40\u8bf4\u660e\u2026"],
        ["Edit the global Codex config.toml\u2026", "\u7f16\u8f91\u5168\u5c40 Codex config.toml\u2026"],
        ["Git", "Git"],
      ]),
    [],
  );

  const translateValue = useCallback(
    (value: string) => {
      let output = value;
      settingsTranslations.forEach((zh, en) => {
        output = output.split(en).join(zh);
      });
      return output;
    },
    [settingsTranslations],
  );

  const [activeSection, setActiveSection] = useState<CodexSection>("projects");

  useEffect(() => {
    const root = settingsWindowRef.current;
    if (!root) {
      return;
    }

    const blocked = new Set(["SCRIPT", "STYLE"]);

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const textNode = node as Text;
      const parent = textNode.parentElement;
      const tagName = parent?.tagName ?? "";
      if (!blocked.has(tagName)) {
        const original = originalTextRef.current.get(textNode) ?? (textNode.nodeValue ?? "");
        if (!originalTextRef.current.has(textNode)) {
          originalTextRef.current.set(textNode, original);
        }
        textNode.nodeValue = isZh ? translateValue(original) : original;
      }
      node = walker.nextNode();
    }

    const attrs = ["placeholder", "title", "aria-label"] as const;
    root.querySelectorAll<HTMLElement>("*").forEach((el) => {
      let attrMap = originalAttrRef.current.get(el);
      if (!attrMap) {
        attrMap = new Map<string, string>();
        originalAttrRef.current.set(el, attrMap);
      }
      attrs.forEach((attr) => {
        const current = el.getAttribute(attr);
        if (current == null) {
          return;
        }
        if (!attrMap!.has(attr)) {
          attrMap!.set(attr, current);
        }
        const original = attrMap!.get(attr) ?? current;
        el.setAttribute(attr, isZh ? translateValue(original) : original);
      });
    });
    }, [activeSection, isZh, translateValue]);
  const [environmentWorkspaceId, setEnvironmentWorkspaceId] = useState<string | null>(
    null,
  );
  const [environmentDraftScript, setEnvironmentDraftScript] = useState("");
  const [environmentSavedScript, setEnvironmentSavedScript] = useState<string | null>(
    null,
  );
  const [environmentLoadedWorkspaceId, setEnvironmentLoadedWorkspaceId] = useState<
    string | null
  >(null);
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [environmentSaving, setEnvironmentSaving] = useState(false);
  const [codexPathDraft, setCodexPathDraft] = useState(appSettings.codexBin ?? "");
  const [codexArgsDraft, setCodexArgsDraft] = useState(appSettings.codexArgs ?? "");
  const [remoteHostDraft, setRemoteHostDraft] = useState(appSettings.remoteBackendHost);
  const [remoteTokenDraft, setRemoteTokenDraft] = useState(appSettings.remoteBackendToken ?? "");
  const [scaleDraft, setScaleDraft] = useState(
    `${Math.round(clampUiScale(appSettings.uiScale) * 100)}%`,
  );
  const [uiFontDraft, setUiFontDraft] = useState(appSettings.uiFontFamily);
  const [codeFontDraft, setCodeFontDraft] = useState(appSettings.codeFontFamily);
  const [codeFontSizeDraft, setCodeFontSizeDraft] = useState(appSettings.codeFontSize);
  const [codexBinOverrideDrafts, setCodexBinOverrideDrafts] = useState<
    Record<string, string>
  >({});
  const [codexHomeOverrideDrafts, setCodexHomeOverrideDrafts] = useState<
    Record<string, string>
  >({});
  const [codexArgsOverrideDrafts, setCodexArgsOverrideDrafts] = useState<
    Record<string, string>
  >({});
  const [groupDrafts, setGroupDrafts] = useState<Record<string, string>>({});
  const [newGroupName, setNewGroupName] = useState("");
  const [groupError, setGroupError] = useState<string | null>(null);
  const [openAppDrafts, setOpenAppDrafts] = useState<OpenAppDraft[]>(() =>
    buildOpenAppDrafts(appSettings.openAppTargets),
  );
  const [openAppSelectedId, setOpenAppSelectedId] = useState(
    appSettings.selectedOpenAppId,
  );
  const [doctorState, setDoctorState] = useState<{
    status: "idle" | "running" | "done";
    result: CodexDoctorResult | null;
  }>({ status: "idle", result: null });
  const {
    content: globalAgentsContent,
    exists: globalAgentsExists,
    truncated: globalAgentsTruncated,
    isLoading: globalAgentsLoading,
    isSaving: globalAgentsSaving,
    error: globalAgentsError,
    isDirty: globalAgentsDirty,
    setContent: setGlobalAgentsContent,
    refresh: refreshGlobalAgents,
    save: saveGlobalAgents,
  } = useGlobalAgentsMd();
  const {
    content: globalConfigContent,
    exists: globalConfigExists,
    truncated: globalConfigTruncated,
    isLoading: globalConfigLoading,
    isSaving: globalConfigSaving,
    error: globalConfigError,
    isDirty: globalConfigDirty,
    setContent: setGlobalConfigContent,
    refresh: refreshGlobalConfig,
    save: saveGlobalConfig,
  } = useGlobalCodexConfigToml();
  const [openConfigError, setOpenConfigError] = useState<string | null>(null);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [shortcutDrafts, setShortcutDrafts] = useState({
    model: appSettings.composerModelShortcut ?? "",
    access: appSettings.composerAccessShortcut ?? "",
    reasoning: appSettings.composerReasoningShortcut ?? "",
    collaboration: appSettings.composerCollaborationShortcut ?? "",
    interrupt: appSettings.interruptShortcut ?? "",
    newAgent: appSettings.newAgentShortcut ?? "",
    newWorktreeAgent: appSettings.newWorktreeAgentShortcut ?? "",
    newCloneAgent: appSettings.newCloneAgentShortcut ?? "",
    archiveThread: appSettings.archiveThreadShortcut ?? "",
    projectsSidebar: appSettings.toggleProjectsSidebarShortcut ?? "",
    gitSidebar: appSettings.toggleGitSidebarShortcut ?? "",
    branchSwitcher: appSettings.branchSwitcherShortcut ?? "",
    debugPanel: appSettings.toggleDebugPanelShortcut ?? "",
    terminal: appSettings.toggleTerminalShortcut ?? "",
    cycleAgentNext: appSettings.cycleAgentNextShortcut ?? "",
    cycleAgentPrev: appSettings.cycleAgentPrevShortcut ?? "",
    cycleWorkspaceNext: appSettings.cycleWorkspaceNextShortcut ?? "",
    cycleWorkspacePrev: appSettings.cycleWorkspacePrevShortcut ?? "",
  });
  const dictationReady = dictationModelStatus?.state === "ready";
  const dictationProgress = dictationModelStatus?.progress ?? null;
  const globalAgentsStatus = globalAgentsLoading
    ? "Loading…"
    : globalAgentsSaving
      ? "Saving…"
      : globalAgentsExists
        ? ""
        : "Not found";
  const globalAgentsMetaParts: string[] = [];
  if (globalAgentsStatus) {
    globalAgentsMetaParts.push(globalAgentsStatus);
  }
  if (globalAgentsTruncated) {
    globalAgentsMetaParts.push("Truncated");
  }
  const globalAgentsMeta = globalAgentsMetaParts.join(" · ");
  const globalAgentsSaveLabel = globalAgentsExists ? "Save" : "Create";
  const globalAgentsSaveDisabled = globalAgentsLoading || globalAgentsSaving || !globalAgentsDirty;
  const globalAgentsRefreshDisabled = globalAgentsLoading || globalAgentsSaving;
  const globalConfigStatus = globalConfigLoading
    ? "Loading…"
    : globalConfigSaving
      ? "Saving…"
      : globalConfigExists
        ? ""
        : "Not found";
  const globalConfigMetaParts: string[] = [];
  if (globalConfigStatus) {
    globalConfigMetaParts.push(globalConfigStatus);
  }
  if (globalConfigTruncated) {
    globalConfigMetaParts.push("Truncated");
  }
  const globalConfigMeta = globalConfigMetaParts.join(" · ");
  const globalConfigSaveLabel = globalConfigExists ? "Save" : "Create";
  const globalConfigSaveDisabled = globalConfigLoading || globalConfigSaving || !globalConfigDirty;
  const globalConfigRefreshDisabled = globalConfigLoading || globalConfigSaving;
  const optionKeyLabel = isMacPlatform() ? "Option" : "Alt";
  const metaKeyLabel = isMacPlatform()
    ? "Command"
    : isWindowsPlatform()
      ? "Windows"
      : "Meta";
  const selectedDictationModel = useMemo(() => {
    return (
      DICTATION_MODELS.find(
        (model) => model.id === appSettings.dictationModelId,
      ) ?? DICTATION_MODELS[1]
    );
  }, [appSettings.dictationModelId]);

  const projects = useMemo(
    () => groupedWorkspaces.flatMap((group) => group.workspaces),
    [groupedWorkspaces],
  );
  const mainWorkspaces = useMemo(
    () => projects.filter((workspace) => (workspace.kind ?? "main") !== "worktree"),
    [projects],
  );
  const environmentWorkspace = useMemo(() => {
    if (mainWorkspaces.length === 0) {
      return null;
    }
    if (environmentWorkspaceId) {
      const found = mainWorkspaces.find((workspace) => workspace.id === environmentWorkspaceId);
      if (found) {
        return found;
      }
    }
    return mainWorkspaces[0] ?? null;
  }, [environmentWorkspaceId, mainWorkspaces]);
  const environmentSavedScriptFromWorkspace = useMemo(() => {
    return normalizeWorktreeSetupScript(environmentWorkspace?.settings.worktreeSetupScript);
  }, [environmentWorkspace?.settings.worktreeSetupScript]);
  const environmentDraftNormalized = useMemo(() => {
    return normalizeWorktreeSetupScript(environmentDraftScript);
  }, [environmentDraftScript]);
  const environmentDirty = environmentDraftNormalized !== environmentSavedScript;
  const hasCodexHomeOverrides = useMemo(
    () => projects.some((workspace) => workspace.settings.codexHome != null),
    [projects],
  );

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      onClose();
    };

    const handleCloseShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w") {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleEscape);
    window.addEventListener("keydown", handleCloseShortcut);
    return () => {
      window.removeEventListener("keydown", handleEscape);
      window.removeEventListener("keydown", handleCloseShortcut);
    };
  }, [onClose]);

  useEffect(() => {
    setCodexPathDraft(appSettings.codexBin ?? "");
  }, [appSettings.codexBin]);

  useEffect(() => {
    setCodexArgsDraft(appSettings.codexArgs ?? "");
  }, [appSettings.codexArgs]);

  useEffect(() => {
    setRemoteHostDraft(appSettings.remoteBackendHost);
  }, [appSettings.remoteBackendHost]);

  useEffect(() => {
    setRemoteTokenDraft(appSettings.remoteBackendToken ?? "");
  }, [appSettings.remoteBackendToken]);

  useEffect(() => {
    setScaleDraft(`${Math.round(clampUiScale(appSettings.uiScale) * 100)}%`);
  }, [appSettings.uiScale]);

  useEffect(() => {
    setUiFontDraft(appSettings.uiFontFamily);
  }, [appSettings.uiFontFamily]);

  useEffect(() => {
    setCodeFontDraft(appSettings.codeFontFamily);
  }, [appSettings.codeFontFamily]);

  useEffect(() => {
    setCodeFontSizeDraft(appSettings.codeFontSize);
  }, [appSettings.codeFontSize]);

  useEffect(() => {
    setOpenAppDrafts(buildOpenAppDrafts(appSettings.openAppTargets));
    setOpenAppSelectedId(appSettings.selectedOpenAppId);
  }, [appSettings.openAppTargets, appSettings.selectedOpenAppId]);

  useEffect(() => {
    setShortcutDrafts({
      model: appSettings.composerModelShortcut ?? "",
      access: appSettings.composerAccessShortcut ?? "",
      reasoning: appSettings.composerReasoningShortcut ?? "",
      collaboration: appSettings.composerCollaborationShortcut ?? "",
      interrupt: appSettings.interruptShortcut ?? "",
      newAgent: appSettings.newAgentShortcut ?? "",
      newWorktreeAgent: appSettings.newWorktreeAgentShortcut ?? "",
      newCloneAgent: appSettings.newCloneAgentShortcut ?? "",
      archiveThread: appSettings.archiveThreadShortcut ?? "",
      projectsSidebar: appSettings.toggleProjectsSidebarShortcut ?? "",
      gitSidebar: appSettings.toggleGitSidebarShortcut ?? "",
      branchSwitcher: appSettings.branchSwitcherShortcut ?? "",
      debugPanel: appSettings.toggleDebugPanelShortcut ?? "",
      terminal: appSettings.toggleTerminalShortcut ?? "",
      cycleAgentNext: appSettings.cycleAgentNextShortcut ?? "",
      cycleAgentPrev: appSettings.cycleAgentPrevShortcut ?? "",
      cycleWorkspaceNext: appSettings.cycleWorkspaceNextShortcut ?? "",
      cycleWorkspacePrev: appSettings.cycleWorkspacePrevShortcut ?? "",
    });
  }, [
    appSettings.composerAccessShortcut,
    appSettings.composerModelShortcut,
    appSettings.composerReasoningShortcut,
    appSettings.composerCollaborationShortcut,
    appSettings.interruptShortcut,
    appSettings.newAgentShortcut,
    appSettings.newWorktreeAgentShortcut,
    appSettings.newCloneAgentShortcut,
    appSettings.archiveThreadShortcut,
    appSettings.toggleProjectsSidebarShortcut,
    appSettings.toggleGitSidebarShortcut,
    appSettings.branchSwitcherShortcut,
    appSettings.toggleDebugPanelShortcut,
    appSettings.toggleTerminalShortcut,
    appSettings.cycleAgentNextShortcut,
    appSettings.cycleAgentPrevShortcut,
    appSettings.cycleWorkspaceNextShortcut,
    appSettings.cycleWorkspacePrevShortcut,
  ]);

  const handleOpenConfig = useCallback(async () => {
    setOpenConfigError(null);
    try {
      const configPath = await getCodexConfigPath();
      await revealItemInDir(configPath);
    } catch (error) {
      setOpenConfigError(
        error instanceof Error ? error.message : "Unable to open config.",
      );
    }
  }, []);

  useEffect(() => {
    setCodexBinOverrideDrafts((prev) =>
      buildWorkspaceOverrideDrafts(
        projects,
        prev,
        (workspace) => workspace.codex_bin ?? null,
      ),
    );
    setCodexHomeOverrideDrafts((prev) =>
      buildWorkspaceOverrideDrafts(
        projects,
        prev,
        (workspace) => workspace.settings.codexHome ?? null,
      ),
    );
    setCodexArgsOverrideDrafts((prev) =>
      buildWorkspaceOverrideDrafts(
        projects,
        prev,
        (workspace) => workspace.settings.codexArgs ?? null,
      ),
    );
  }, [projects]);

  useEffect(() => {
    setGroupDrafts((prev) => {
      const next: Record<string, string> = {};
      workspaceGroups.forEach((group) => {
        next[group.id] = prev[group.id] ?? group.name;
      });
      return next;
    });
  }, [workspaceGroups]);

  useEffect(() => {
    if (initialSection) {
      setActiveSection(initialSection);
    }
  }, [initialSection]);

  useEffect(() => {
    if (!environmentWorkspace) {
      setEnvironmentWorkspaceId(null);
      setEnvironmentLoadedWorkspaceId(null);
      setEnvironmentSavedScript(null);
      setEnvironmentDraftScript("");
      setEnvironmentError(null);
      setEnvironmentSaving(false);
      return;
    }

    if (environmentWorkspaceId !== environmentWorkspace.id) {
      setEnvironmentWorkspaceId(environmentWorkspace.id);
    }
  }, [environmentWorkspace, environmentWorkspaceId]);

  useEffect(() => {
    if (!environmentWorkspace) {
      return;
    }

    if (environmentLoadedWorkspaceId !== environmentWorkspace.id) {
      setEnvironmentLoadedWorkspaceId(environmentWorkspace.id);
      setEnvironmentSavedScript(environmentSavedScriptFromWorkspace);
      setEnvironmentDraftScript(environmentSavedScriptFromWorkspace ?? "");
      setEnvironmentError(null);
      return;
    }

    if (!environmentDirty && environmentSavedScript !== environmentSavedScriptFromWorkspace) {
      setEnvironmentSavedScript(environmentSavedScriptFromWorkspace);
      setEnvironmentDraftScript(environmentSavedScriptFromWorkspace ?? "");
      setEnvironmentError(null);
    }
  }, [
    environmentDirty,
    environmentLoadedWorkspaceId,
    environmentSavedScript,
    environmentSavedScriptFromWorkspace,
    environmentWorkspace,
  ]);

  const nextCodexBin = codexPathDraft.trim() ? codexPathDraft.trim() : null;
  const nextCodexArgs = codexArgsDraft.trim() ? codexArgsDraft.trim() : null;
  const codexDirty =
    nextCodexBin !== (appSettings.codexBin ?? null) ||
    nextCodexArgs !== (appSettings.codexArgs ?? null);

  const trimmedScale = scaleDraft.trim();
  const parsedPercent = trimmedScale
    ? Number(trimmedScale.replace("%", ""))
    : Number.NaN;
  const parsedScale = Number.isFinite(parsedPercent) ? parsedPercent / 100 : null;

  const handleSaveCodexSettings = async () => {
    setIsSavingSettings(true);
    try {
      await onUpdateAppSettings({
        ...appSettings,
        codexBin: nextCodexBin,
        codexArgs: nextCodexArgs,
      });
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleCommitRemoteHost = async () => {
    const nextHost = remoteHostDraft.trim() || "127.0.0.1:4732";
    setRemoteHostDraft(nextHost);
    if (nextHost === appSettings.remoteBackendHost) {
      return;
    }
    await onUpdateAppSettings({
      ...appSettings,
      remoteBackendHost: nextHost,
    });
  };

  const handleCommitRemoteToken = async () => {
    const nextToken = remoteTokenDraft.trim() ? remoteTokenDraft.trim() : null;
    setRemoteTokenDraft(nextToken ?? "");
    if (nextToken === appSettings.remoteBackendToken) {
      return;
    }
    await onUpdateAppSettings({
      ...appSettings,
      remoteBackendToken: nextToken,
    });
  };

  const handleCommitScale = async () => {
    if (parsedScale === null) {
      setScaleDraft(`${Math.round(clampUiScale(appSettings.uiScale) * 100)}%`);
      return;
    }
    const nextScale = clampUiScale(parsedScale);
    setScaleDraft(`${Math.round(nextScale * 100)}%`);
    if (nextScale === appSettings.uiScale) {
      return;
    }
    await onUpdateAppSettings({
      ...appSettings,
      uiScale: nextScale,
    });
  };

  const handleResetScale = async () => {
    if (appSettings.uiScale === 1) {
      setScaleDraft("100%");
      return;
    }
    setScaleDraft("100%");
    await onUpdateAppSettings({
      ...appSettings,
      uiScale: 1,
    });
  };

  const handleCommitUiFont = async () => {
    const nextFont = normalizeFontFamily(
      uiFontDraft,
      DEFAULT_UI_FONT_FAMILY,
    );
    setUiFontDraft(nextFont);
    if (nextFont === appSettings.uiFontFamily) {
      return;
    }
    await onUpdateAppSettings({
      ...appSettings,
      uiFontFamily: nextFont,
    });
  };

  const handleCommitCodeFont = async () => {
    const nextFont = normalizeFontFamily(
      codeFontDraft,
      DEFAULT_CODE_FONT_FAMILY,
    );
    setCodeFontDraft(nextFont);
    if (nextFont === appSettings.codeFontFamily) {
      return;
    }
    await onUpdateAppSettings({
      ...appSettings,
      codeFontFamily: nextFont,
    });
  };

  const handleCommitCodeFontSize = async (nextSize: number) => {
    const clampedSize = clampCodeFontSize(nextSize);
    setCodeFontSizeDraft(clampedSize);
    if (clampedSize === appSettings.codeFontSize) {
      return;
    }
    await onUpdateAppSettings({
      ...appSettings,
      codeFontSize: clampedSize,
    });
  };

  const normalizeOpenAppTargets = useCallback(
    (drafts: OpenAppDraft[]): OpenAppTarget[] =>
      drafts.map(({ argsText, ...target }) => ({
        ...target,
        label: target.label.trim(),
        appName: (target.appName?.trim() ?? "") || null,
        command: (target.command?.trim() ?? "") || null,
        args: argsText.trim() ? argsText.trim().split(/\s+/) : [],
      })),
    [],
  );

  const handleCommitOpenApps = useCallback(
    async (drafts: OpenAppDraft[], selectedId = openAppSelectedId) => {
      const nextTargets = normalizeOpenAppTargets(drafts);
      const resolvedSelectedId = nextTargets.find(
        (target) => target.id === selectedId && isOpenAppTargetComplete(target),
      )?.id;
      const firstCompleteId = nextTargets.find(isOpenAppTargetComplete)?.id;
      const nextSelectedId =
        resolvedSelectedId ??
        firstCompleteId ??
        nextTargets[0]?.id ??
        DEFAULT_OPEN_APP_ID;
      setOpenAppDrafts(buildOpenAppDrafts(nextTargets));
      setOpenAppSelectedId(nextSelectedId);
      await onUpdateAppSettings({
        ...appSettings,
        openAppTargets: nextTargets,
        selectedOpenAppId: nextSelectedId,
      });
    },
    [
      appSettings,
      normalizeOpenAppTargets,
      onUpdateAppSettings,
      openAppSelectedId,
    ],
  );

  const handleOpenAppDraftChange = (
    index: number,
    updates: Partial<OpenAppDraft>,
  ) => {
    setOpenAppDrafts((prev) => {
      const next = [...prev];
      const current = next[index];
      if (!current) {
        return prev;
      }
      next[index] = { ...current, ...updates };
      return next;
    });
  };

  const handleOpenAppKindChange = (index: number, kind: OpenAppTarget["kind"]) => {
    setOpenAppDrafts((prev) => {
      const next = [...prev];
      const current = next[index];
      if (!current) {
        return prev;
      }
      next[index] = {
        ...current,
        kind,
        appName: kind === "app" ? current.appName ?? "" : null,
        command: kind === "command" ? current.command ?? "" : null,
        argsText: kind === "finder" ? "" : current.argsText,
      };
      void handleCommitOpenApps(next);
      return next;
    });
  };

  const handleMoveOpenApp = (index: number, direction: "up" | "down") => {
    const nextIndex = direction === "up" ? index - 1 : index + 1;
    if (nextIndex < 0 || nextIndex >= openAppDrafts.length) {
      return;
    }
    const next = [...openAppDrafts];
    const [moved] = next.splice(index, 1);
    next.splice(nextIndex, 0, moved);
    setOpenAppDrafts(next);
    void handleCommitOpenApps(next);
  };

  const handleDeleteOpenApp = (index: number) => {
    if (openAppDrafts.length <= 1) {
      return;
    }
    const removed = openAppDrafts[index];
    const next = openAppDrafts.filter((_, draftIndex) => draftIndex !== index);
    const nextSelected =
      removed?.id === openAppSelectedId ? next[0]?.id ?? DEFAULT_OPEN_APP_ID : openAppSelectedId;
    setOpenAppDrafts(next);
    void handleCommitOpenApps(next, nextSelected);
  };

  const handleAddOpenApp = () => {
    const newTarget: OpenAppDraft = {
      id: createOpenAppId(),
      label: "New App",
      kind: "app",
      appName: "",
      command: null,
      args: [],
      argsText: "",
    };
    const next = [...openAppDrafts, newTarget];
    setOpenAppDrafts(next);
    void handleCommitOpenApps(next, newTarget.id);
  };

  const handleSelectOpenAppDefault = (id: string) => {
    const selectedTarget = openAppDrafts.find((target) => target.id === id);
    if (selectedTarget && !isOpenAppDraftComplete(selectedTarget)) {
      return;
    }
    setOpenAppSelectedId(id);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(OPEN_APP_STORAGE_KEY, id);
    }
    void handleCommitOpenApps(openAppDrafts, id);
  };

  const handleComposerPresetChange = (preset: ComposerPreset) => {
    const config = COMPOSER_PRESET_CONFIGS[preset];
    void onUpdateAppSettings({
      ...appSettings,
      composerEditorPreset: preset,
      ...config,
    });
  };

  const handleBrowseCodex = async () => {
    const selection = await open({ multiple: false, directory: false });
    if (!selection || Array.isArray(selection)) {
      return;
    }
    setCodexPathDraft(selection);
  };

  const handleRunDoctor = async () => {
    setDoctorState({ status: "running", result: null });
    try {
      const result = await onRunDoctor(nextCodexBin, nextCodexArgs);
      setDoctorState({ status: "done", result });
    } catch (error) {
      setDoctorState({
        status: "done",
        result: {
          ok: false,
          codexBin: nextCodexBin,
          version: null,
          appServerOk: false,
          details: error instanceof Error ? error.message : String(error),
          path: null,
          nodeOk: false,
          nodeVersion: null,
          nodeDetails: null,
        },
      });
    }
  };

  const updateShortcut = async (key: ShortcutSettingKey, value: string | null) => {
    const draftKey = shortcutDraftKeyBySetting[key];
    setShortcutDrafts((prev) => ({
      ...prev,
      [draftKey]: value ?? "",
    }));
    await onUpdateAppSettings({
      ...appSettings,
      [key]: value,
    });
  };

  const handleShortcutKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
    key: ShortcutSettingKey,
  ) => {
    if (event.key === "Tab" && key !== "composerCollaborationShortcut") {
      return;
    }
    if (event.key === "Tab" && !event.shiftKey) {
      return;
    }
    event.preventDefault();
    if (event.key === "Backspace" || event.key === "Delete") {
      void updateShortcut(key, null);
      return;
    }
    const value = buildShortcutValue(event.nativeEvent);
    if (!value) {
      return;
    }
    void updateShortcut(key, value);
  };

  const handleSaveEnvironmentSetup = async () => {
    if (!environmentWorkspace || environmentSaving) {
      return;
    }
    const nextScript = environmentDraftNormalized;
    setEnvironmentSaving(true);
    setEnvironmentError(null);
    try {
      await onUpdateWorkspaceSettings(environmentWorkspace.id, {
        worktreeSetupScript: nextScript,
      });
      setEnvironmentSavedScript(nextScript);
      setEnvironmentDraftScript(nextScript ?? "");
    } catch (error) {
      setEnvironmentError(error instanceof Error ? error.message : String(error));
    } finally {
      setEnvironmentSaving(false);
    }
  };

  const trimmedGroupName = newGroupName.trim();
  const canCreateGroup = Boolean(trimmedGroupName);

  const handleCreateGroup = async () => {
    setGroupError(null);
    try {
      const created = await onCreateWorkspaceGroup(newGroupName);
      if (created) {
        setNewGroupName("");
      }
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleRenameGroup = async (group: WorkspaceGroup) => {
    const draft = groupDrafts[group.id] ?? "";
    const trimmed = draft.trim();
    if (!trimmed || trimmed === group.name) {
      setGroupDrafts((prev) => ({
        ...prev,
        [group.id]: group.name,
      }));
      return;
    }
    setGroupError(null);
    try {
      await onRenameWorkspaceGroup(group.id, trimmed);
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : String(error));
      setGroupDrafts((prev) => ({
        ...prev,
        [group.id]: group.name,
      }));
    }
  };

  const updateGroupCopiesFolder = async (
    groupId: string,
    copiesFolder: string | null,
  ) => {
    setGroupError(null);
    try {
      await onUpdateAppSettings({
        ...appSettings,
        workspaceGroups: appSettings.workspaceGroups.map((entry) =>
          entry.id === groupId ? { ...entry, copiesFolder } : entry,
        ),
      });
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleChooseGroupCopiesFolder = async (group: WorkspaceGroup) => {
    const selection = await open({ multiple: false, directory: true });
    if (!selection || Array.isArray(selection)) {
      return;
    }
    await updateGroupCopiesFolder(group.id, selection);
  };

  const handleClearGroupCopiesFolder = async (group: WorkspaceGroup) => {
    if (!group.copiesFolder) {
      return;
    }
    await updateGroupCopiesFolder(group.id, null);
  };

  const handleDeleteGroup = async (group: WorkspaceGroup) => {
    const groupProjects =
      groupedWorkspaces.find((entry) => entry.id === group.id)?.workspaces ?? [];
    const detail =
      groupProjects.length > 0
        ? `\n\nProjects in this group will move to "${ungroupedLabel}".`
        : "";
    const confirmed = await ask(
      `Delete "${group.name}"?${detail}`,
      {
        title: "Delete Group",
        kind: "warning",
        okLabel: "Delete",
        cancelLabel: "Cancel",
      },
    );
    if (!confirmed) {
      return;
    }
    setGroupError(null);
    try {
      await onDeleteWorkspaceGroup(group.id);
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true">
      <div className="settings-backdrop" onClick={onClose} />
      <div className="settings-window" ref={settingsWindowRef}>
        <div className="settings-titlebar">
          <div className="settings-title">{t("Settings", "\u8bbe\u7f6e")}</div>
          <button
            type="button"
            className="ghost icon-button settings-close"
            onClick={onClose}
            aria-label={t("Close settings", "\u5173\u95ed\u8bbe\u7f6e")}
          >
            <X aria-hidden />
          </button>
        </div>
        <div className="settings-body">
          <aside className="settings-sidebar">
            <button
              type="button"
              className={`settings-nav ${activeSection === "projects" ? "active" : ""}`}
              onClick={() => setActiveSection("projects")}
            >
              <LayoutGrid aria-hidden />
              {t("Projects", "\u9879\u76ee")}
            </button>
            <button
              type="button"
              className={`settings-nav ${activeSection === "environments" ? "active" : ""}`}
              onClick={() => setActiveSection("environments")}
            >
              <Layers aria-hidden />
              {t("Environments", "\u73af\u5883") }
            </button>
            <button
              type="button"
              className={`settings-nav ${activeSection === "display" ? "active" : ""}`}
              onClick={() => setActiveSection("display")}
            >
              <SlidersHorizontal aria-hidden />
              {t("Display & Sound", "\u663e\u793a\u4e0e\u58f0\u97f3")}
            </button>
            <button
              type="button"
              className={`settings-nav ${activeSection === "composer" ? "active" : ""}`}
              onClick={() => setActiveSection("composer")}
            >
              <FileText aria-hidden />
              {t("Composer", "\u8f93\u5165\u7f16\u8f91")}
            </button>
            <button
              type="button"
              className={`settings-nav ${activeSection === "dictation" ? "active" : ""}`}
              onClick={() => setActiveSection("dictation")}
            >
              <Mic aria-hidden />
              {t("Dictation", "\u8bed\u97f3\u8f93\u5165")}
            </button>
            <button
              type="button"
              className={`settings-nav ${activeSection === "shortcuts" ? "active" : ""}`}
              onClick={() => setActiveSection("shortcuts")}
            >
              <Keyboard aria-hidden />
              {t("Shortcuts", "\u5feb\u6377\u952e")}
            </button>
            <button
              type="button"
              className={`settings-nav ${activeSection === "open-apps" ? "active" : ""}`}
              onClick={() => setActiveSection("open-apps")}
            >
              <ExternalLink aria-hidden />
              {t("Open in", "\u6253\u5f00\u65b9\u5f0f")}
            </button>
            <button
              type="button"
              className={`settings-nav ${activeSection === "git" ? "active" : ""}`}
              onClick={() => setActiveSection("git")}
            >
              <GitBranch aria-hidden />
              {t("Git", "Git")}
            </button>
            <button
              type="button"
              className={`settings-nav ${activeSection === "codex" ? "active" : ""}`}
              onClick={() => setActiveSection("codex")}
            >
              <TerminalSquare aria-hidden />
              {t("Codex", "Codex")}
            </button>
            <button
              type="button"
              className={`settings-nav ${activeSection === "features" ? "active" : ""}`}
              onClick={() => setActiveSection("features")}
            >
              <FlaskConical aria-hidden />
              {t("Features", "\u529f\u80fd\u7279\u6027")}
            </button>
            <div className="settings-language-switcher">
              <label htmlFor="settings-language-select">{t("Language", "\u8bed\u8a00")}</label>
              <select
                id="settings-language-select"
                value={locale}
                onChange={(event) => onLocaleChange?.(event.target.value as AppLocale)}
              >
                <option value="en">English</option>
                <option value="zh-CN">{"中文"}</option>
              </select>
            </div>
          </aside>
          <div className="settings-content">
            {activeSection === "projects" && (
              <section className="settings-section">
                <div className="settings-section-title">{t("Projects", "\u9879\u76ee")}</div>
                <div className="settings-section-subtitle">
                  {t("Group related workspaces and reorder projects within each group.", "\u5c06\u76f8\u5173\u5de5\u4f5c\u533a\u5206\u7ec4\uff0c\u5e76\u5728\u6bcf\u4e2a\u5206\u7ec4\u5185\u8c03\u6574\u9879\u76ee\u987a\u5e8f\u3002")}
                </div>
                <div className="settings-subsection-title">{t("Groups", "\u5206\u7ec4")}</div>
                <div className="settings-subsection-subtitle">
                  {t("Create group labels for related repositories.", "\u4e3a\u76f8\u5173\u4ed3\u5e93\u521b\u5efa\u5206\u7ec4\u6807\u7b7e\u3002")}
                </div>
                <div className="settings-groups">
                  <div className="settings-group-create">
                    <input
                      className="settings-input settings-input--compact"
                      value={newGroupName}
                      placeholder={t("New group name", "\u65b0\u5206\u7ec4\u540d\u79f0")}
                      onChange={(event) => setNewGroupName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && canCreateGroup) {
                          event.preventDefault();
                          void handleCreateGroup();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() => {
                        void handleCreateGroup();
                      }}
                      disabled={!canCreateGroup}
                    >
                      Add group
                    </button>
                  </div>
                  {groupError && <div className="settings-group-error">{groupError}</div>}
                  {workspaceGroups.length > 0 ? (
                    <div className="settings-group-list">
                      {workspaceGroups.map((group, index) => (
                        <div key={group.id} className="settings-group-row">
                          <div className="settings-group-fields">
                            <input
                              className="settings-input settings-input--compact"
                              value={groupDrafts[group.id] ?? group.name}
                              onChange={(event) =>
                                setGroupDrafts((prev) => ({
                                  ...prev,
                                  [group.id]: event.target.value,
                                }))
                              }
                              onBlur={() => {
                                void handleRenameGroup(group);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  void handleRenameGroup(group);
                                }
                              }}
                            />
                            <div className="settings-group-copies">
                              <div className="settings-group-copies-label">
                                Copies folder
                              </div>
                              <div className="settings-group-copies-row">
                                <div
                                  className={`settings-group-copies-path${
                                    group.copiesFolder ? "" : " empty"
                                  }`}
                                  title={group.copiesFolder ?? ""}
                                >
                                  {group.copiesFolder ?? "Not set"}
                                </div>
                                <button
                                  type="button"
                                  className="ghost settings-button-compact"
                                  onClick={() => {
                                    void handleChooseGroupCopiesFolder(group);
                                  }}
                                >
                                  Choose…
                                </button>
                                <button
                                  type="button"
                                  className="ghost settings-button-compact"
                                  onClick={() => {
                                    void handleClearGroupCopiesFolder(group);
                                  }}
                                  disabled={!group.copiesFolder}
                                >
                                  Clear
                                </button>
                              </div>
                            </div>
                          </div>
                          <div className="settings-group-actions">
                            <button
                              type="button"
                              className="ghost icon-button"
                              onClick={() => {
                                void onMoveWorkspaceGroup(group.id, "up");
                              }}
                              disabled={index === 0}
                              aria-label="Move group up"
                            >
                              <ChevronUp aria-hidden />
                            </button>
                            <button
                              type="button"
                              className="ghost icon-button"
                              onClick={() => {
                                void onMoveWorkspaceGroup(group.id, "down");
                              }}
                              disabled={index === workspaceGroups.length - 1}
                              aria-label="Move group down"
                            >
                              <ChevronDown aria-hidden />
                            </button>
                            <button
                              type="button"
                              className="ghost icon-button"
                              onClick={() => {
                                void handleDeleteGroup(group);
                              }}
                              aria-label="Delete group"
                            >
                              <Trash2 aria-hidden />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="settings-empty">No groups yet.</div>
                  )}
                </div>
                <div className="settings-subsection-title">Projects</div>
                <div className="settings-subsection-subtitle">
                  Assign projects to groups and adjust their order.
                </div>
                <div className="settings-projects">
                  {groupedWorkspaces.map((group) => (
                    <div key={group.id ?? "ungrouped"} className="settings-project-group">
                      <div className="settings-project-group-label">{group.name}</div>
                      {group.workspaces.map((workspace, index) => {
                        const groupValue =
                          workspaceGroups.some(
                            (entry) => entry.id === workspace.settings.groupId,
                          )
                            ? workspace.settings.groupId ?? ""
                            : "";
                        return (
                          <div key={workspace.id} className="settings-project-row">
                            <div className="settings-project-info">
                              <div className="settings-project-name">{workspace.name}</div>
                              <div className="settings-project-path">{workspace.path}</div>
                            </div>
                            <div className="settings-project-actions">
                              <select
                                className="settings-select settings-select--compact"
                                value={groupValue}
                                onChange={(event) => {
                                  const nextGroupId = event.target.value || null;
                                  void onAssignWorkspaceGroup(
                                    workspace.id,
                                    nextGroupId,
                                  );
                                }}
                              >
                                <option value="">{ungroupedLabel}</option>
                                {workspaceGroups.map((entry) => (
                                  <option key={entry.id} value={entry.id}>
                                    {entry.name}
                                  </option>
                                ))}
                              </select>
                              <button
                                type="button"
                                className="ghost icon-button"
                                onClick={() => onMoveWorkspace(workspace.id, "up")}
                                disabled={index === 0}
                                aria-label="Move project up"
                              >
                                <ChevronUp aria-hidden />
                              </button>
                              <button
                                type="button"
                                className="ghost icon-button"
                                onClick={() => onMoveWorkspace(workspace.id, "down")}
                                disabled={index === group.workspaces.length - 1}
                                aria-label="Move project down"
                              >
                                <ChevronDown aria-hidden />
                              </button>
                              <button
                                type="button"
                                className="ghost icon-button"
                                onClick={() => onDeleteWorkspace(workspace.id)}
                                aria-label="Delete project"
                              >
                                <Trash2 aria-hidden />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  {projects.length === 0 && (
                    <div className="settings-empty">{t("No projects yet.", "\u6682\u65e0\u9879\u76ee\u3002")}</div>
                  )}
                </div>
              </section>
            )}
            {activeSection === "environments" && (
              <section className="settings-section">
                <div className="settings-section-title">{t("Environments", "\u73af\u5883")}</div>
                <div className="settings-section-subtitle">
                  {t("Configure per-project setup scripts that run after worktree creation.", "\u914d\u7f6e\u6bcf\u4e2a\u9879\u76ee\u5728\u521b\u5efa\u5de5\u4f5c\u6811\u540e\u8fd0\u884c\u7684\u521d\u59cb\u5316\u811a\u672c\u3002")}
                </div>
                {mainWorkspaces.length === 0 ? (
                  <div className="settings-empty">{t("No projects yet.", "\u6682\u65e0\u9879\u76ee\u3002")}</div>
                ) : (
                  <>
                    <div className="settings-field">
                      <label
                        className="settings-field-label"
                        htmlFor="settings-environment-project"
                      >
                        {t("Project", "\u9879\u76ee")}
                      </label>
                      <select
                        id="settings-environment-project"
                        className="settings-select"
                        value={environmentWorkspace?.id ?? ""}
                        onChange={(event) => setEnvironmentWorkspaceId(event.target.value)}
                        disabled={environmentSaving}
                      >
                        {mainWorkspaces.map((workspace) => (
                          <option key={workspace.id} value={workspace.id}>
                            {workspace.name}
                          </option>
                        ))}
                      </select>
                      {environmentWorkspace ? (
                        <div className="settings-help">{environmentWorkspace.path}</div>
                      ) : null}
                    </div>

                    <div className="settings-field">
                      <div className="settings-field-label">{t("Setup script", "\u521d\u59cb\u5316\u811a\u672c")}</div>
                      <div className="settings-help">
                        {t("Runs once in a dedicated terminal after each new worktree is created.", "\u6bcf\u6b21\u65b0\u5efa\u5de5\u4f5c\u6811\u540e\uff0c\u4f1a\u5728\u72ec\u7acb\u7ec8\u7aef\u4e2d\u6267\u884c\u4e00\u6b21\u3002")}
                      </div>
                      {environmentError ? (
                        <div className="settings-agents-error">{environmentError}</div>
                      ) : null}
                      <textarea
                        className="settings-agents-textarea"
                        value={environmentDraftScript}
                        onChange={(event) => setEnvironmentDraftScript(event.target.value)}
                        placeholder="pnpm install"
                        spellCheck={false}
                        disabled={environmentSaving}
                      />
                      <div className="settings-field-actions">
                        <button
                          type="button"
                          className="ghost settings-button-compact"
                          onClick={() => {
                            const clipboard =
                              typeof navigator === "undefined" ? null : navigator.clipboard;
                            if (!clipboard?.writeText) {
                              pushErrorToast({
                                title: t("Copy failed", "\u590d\u5236\u5931\u8d25"),
                                message:
                                  t("Clipboard access is unavailable in this environment. Copy the script manually instead.", "\u5f53\u524d\u73af\u5883\u65e0\u6cd5\u8bbf\u95ee\u526a\u8d34\u677f\uff0c\u8bf7\u624b\u52a8\u590d\u5236\u811a\u672c\u3002"),
                              });
                              return;
                            }

                            void clipboard.writeText(environmentDraftScript).catch(() => {
                              pushErrorToast({
                                title: t("Copy failed", "\u590d\u5236\u5931\u8d25"),
                                message:
                                  t("Could not write to the clipboard. Copy the script manually instead.", "\u65e0\u6cd5\u5199\u5165\u526a\u8d34\u677f\uff0c\u8bf7\u624b\u52a8\u590d\u5236\u811a\u672c\u3002"),
                              });
                            });
                          }}
                          disabled={environmentSaving || environmentDraftScript.length === 0}
                        >
                          {t("Copy", "\u590d\u5236")}
                        </button>
                        <button
                          type="button"
                          className="ghost settings-button-compact"
                          onClick={() => setEnvironmentDraftScript(environmentSavedScript ?? "")}
                          disabled={environmentSaving || !environmentDirty}
                        >
                          {t("Reset", "\u91cd\u7f6e")}
                        </button>
                        <button
                          type="button"
                          className="primary settings-button-compact"
                          onClick={() => {
                            void handleSaveEnvironmentSetup();
                          }}
                          disabled={environmentSaving || !environmentDirty}
                        >
                          {environmentSaving ? t("Saving...", "\u4fdd\u5b58\u4e2d...") : t("Save", "\u4fdd\u5b58")}
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </section>
            )}
            {activeSection === "display" && (
              <section className="settings-section">
                <div className="settings-section-title">{t("Display & Sound", "\u663e\u793a\u4e0e\u58f0\u97f3")}</div>
                <div className="settings-section-subtitle">
                  {t("Tune visuals and audio alerts to your preferences.", "\u6309\u4f60\u7684\u504f\u597d\u8c03\u6574\u754c\u9762\u663e\u793a\u548c\u63d0\u793a\u97f3\u3002")}
                </div>
                <div className="settings-subsection-title">{t("Display", "\u663e\u793a")}</div>
                <div className="settings-subsection-subtitle">
                  {t("Adjust how the window renders backgrounds and effects.", "\u8c03\u6574\u7a97\u53e3\u80cc\u666f\u4e0e\u89c6\u89c9\u6548\u679c\u7684\u663e\u793a\u65b9\u5f0f\u3002")}
                </div>
                <div className="settings-field">
                  <label className="settings-field-label" htmlFor="theme-select">
                    {t("Theme", "\u4e3b\u9898")}
                  </label>
                  <select
                    id="theme-select"
                    className="settings-select"
                    value={appSettings.theme}
                    onChange={(event) =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        theme: event.target.value as AppSettings["theme"],
                      })
                    }
                  >
                    <option value="system">System</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                    <option value="dim">Dim</option>
                  </select>
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">
                      Show remaining Codex limits
                    </div>
                    <div className="settings-toggle-subtitle">
                      Display what is left instead of what is used.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${
                      appSettings.usageShowRemaining ? "on" : ""
                    }`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        usageShowRemaining: !appSettings.usageShowRemaining,
                      })
                    }
                    aria-pressed={appSettings.usageShowRemaining}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Reduce transparency</div>
                    <div className="settings-toggle-subtitle">
                      Use solid surfaces instead of glass.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${reduceTransparency ? "on" : ""}`}
                    onClick={() => onToggleTransparency(!reduceTransparency)}
                    aria-pressed={reduceTransparency}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-toggle-row settings-scale-row">
                  <div>
                    <div className="settings-toggle-title">Interface scale</div>
                    <div
                      className="settings-toggle-subtitle"
                      title={scaleShortcutTitle}
                    >
                      {scaleShortcutText}
                    </div>
                  </div>
                  <div className="settings-scale-controls">
                    <input
                      id="ui-scale"
                      type="text"
                      inputMode="decimal"
                      className="settings-input settings-input--scale"
                      value={scaleDraft}
                      aria-label="Interface scale"
                      onChange={(event) => setScaleDraft(event.target.value)}
                      onBlur={() => {
                        void handleCommitScale();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void handleCommitScale();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="ghost settings-scale-reset"
                      onClick={() => {
                        void handleResetScale();
                      }}
                    >
                      Reset
                    </button>
                  </div>
                </div>
                <div className="settings-field">
                  <label className="settings-field-label" htmlFor="ui-font-family">
                    UI font family
                  </label>
                  <div className="settings-field-row">
                    <input
                      id="ui-font-family"
                      type="text"
                      className="settings-input"
                      value={uiFontDraft}
                      onChange={(event) => setUiFontDraft(event.target.value)}
                      onBlur={() => {
                        void handleCommitUiFont();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void handleCommitUiFont();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() => {
                        setUiFontDraft(DEFAULT_UI_FONT_FAMILY);
                        void onUpdateAppSettings({
                          ...appSettings,
                          uiFontFamily: DEFAULT_UI_FONT_FAMILY,
                        });
                      }}
                    >
                      Reset
                    </button>
                  </div>
                  <div className="settings-help">
                    Applies to all UI text. Leave empty to use the default system font stack.
                  </div>
                </div>
                <div className="settings-field">
                  <label className="settings-field-label" htmlFor="code-font-family">
                    Code font family
                  </label>
                  <div className="settings-field-row">
                    <input
                      id="code-font-family"
                      type="text"
                      className="settings-input"
                      value={codeFontDraft}
                      onChange={(event) => setCodeFontDraft(event.target.value)}
                      onBlur={() => {
                        void handleCommitCodeFont();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void handleCommitCodeFont();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() => {
                        setCodeFontDraft(DEFAULT_CODE_FONT_FAMILY);
                        void onUpdateAppSettings({
                          ...appSettings,
                          codeFontFamily: DEFAULT_CODE_FONT_FAMILY,
                        });
                      }}
                    >
                      Reset
                    </button>
                  </div>
                  <div className="settings-help">
                    Applies to git diffs and other mono-spaced readouts.
                  </div>
                </div>
                <div className="settings-field">
                  <label className="settings-field-label" htmlFor="code-font-size">
                    Code font size
                  </label>
                  <div className="settings-field-row">
                    <input
                      id="code-font-size"
                      type="range"
                      min={CODE_FONT_SIZE_MIN}
                      max={CODE_FONT_SIZE_MAX}
                      step={1}
                      className="settings-input settings-input--range"
                      value={codeFontSizeDraft}
                      onChange={(event) => {
                        const nextValue = Number(event.target.value);
                        setCodeFontSizeDraft(nextValue);
                        void handleCommitCodeFontSize(nextValue);
                      }}
                    />
                    <div className="settings-scale-value">{codeFontSizeDraft}px</div>
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() => {
                        setCodeFontSizeDraft(CODE_FONT_SIZE_DEFAULT);
                        void handleCommitCodeFontSize(CODE_FONT_SIZE_DEFAULT);
                      }}
                    >
                      Reset
                    </button>
                  </div>
                  <div className="settings-help">
                    Adjusts code and diff text size.
                  </div>
                </div>
                <div className="settings-subsection-title">Sounds</div>
                <div className="settings-subsection-subtitle">
                  Control notification audio alerts.
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Notification sounds</div>
                    <div className="settings-toggle-subtitle">
                      Play a sound when a long-running agent finishes while the window is unfocused.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.notificationSoundsEnabled ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        notificationSoundsEnabled: !appSettings.notificationSoundsEnabled,
                      })
                    }
                    aria-pressed={appSettings.notificationSoundsEnabled}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">System notifications</div>
                    <div className="settings-toggle-subtitle">
                      Show a system notification when a long-running agent finishes while the window is unfocused.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.systemNotificationsEnabled ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        systemNotificationsEnabled: !appSettings.systemNotificationsEnabled,
                      })
                    }
                    aria-pressed={appSettings.systemNotificationsEnabled}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-sound-actions">
                  <button
                    type="button"
                    className="ghost settings-button-compact"
                    onClick={onTestNotificationSound}
                  >
                    Test sound
                  </button>
                  <button
                    type="button"
                    className="ghost settings-button-compact"
                    onClick={onTestSystemNotification}
                  >
                    Test notification
                  </button>
                </div>
              </section>
            )}
            {activeSection === "composer" && (
              <section className="settings-section">
                <div className="settings-section-title">{t("Composer", "\u8f93\u5165\u7f16\u8f91")}</div>
                <div className="settings-section-subtitle">
                  Control helpers and formatting behavior inside the message editor.
                </div>
                <div className="settings-subsection-title">Presets</div>
                <div className="settings-subsection-subtitle">
                  Choose a starting point and fine-tune the toggles below.
                </div>
                <div className="settings-field">
                  <label className="settings-field-label" htmlFor="composer-preset">
                    Preset
                  </label>
                  <select
                    id="composer-preset"
                    className="settings-select"
                    value={appSettings.composerEditorPreset}
                    onChange={(event) =>
                      handleComposerPresetChange(
                        event.target.value as ComposerPreset,
                      )
                    }
                  >
                    {Object.entries(COMPOSER_PRESET_LABELS).map(([preset, label]) => (
                      <option key={preset} value={preset}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <div className="settings-help">
                    Presets update the toggles below. Customize any setting after selecting.
                  </div>
                </div>
                <div className="settings-divider" />
                <div className="settings-subsection-title">Code fences</div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Expand fences on Space</div>
                    <div className="settings-toggle-subtitle">
                      Typing ``` then Space inserts a fenced block.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.composerFenceExpandOnSpace ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        composerFenceExpandOnSpace: !appSettings.composerFenceExpandOnSpace,
                      })
                    }
                    aria-pressed={appSettings.composerFenceExpandOnSpace}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Expand fences on Enter</div>
                    <div className="settings-toggle-subtitle">
                      Use Enter to expand ``` lines when enabled.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.composerFenceExpandOnEnter ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        composerFenceExpandOnEnter: !appSettings.composerFenceExpandOnEnter,
                      })
                    }
                    aria-pressed={appSettings.composerFenceExpandOnEnter}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Support language tags</div>
                    <div className="settings-toggle-subtitle">
                      Allows ```lang + Space to include a language.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.composerFenceLanguageTags ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        composerFenceLanguageTags: !appSettings.composerFenceLanguageTags,
                      })
                    }
                    aria-pressed={appSettings.composerFenceLanguageTags}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Wrap selection in fences</div>
                    <div className="settings-toggle-subtitle">
                      Wraps selected text when creating a fence.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.composerFenceWrapSelection ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        composerFenceWrapSelection: !appSettings.composerFenceWrapSelection,
                      })
                    }
                    aria-pressed={appSettings.composerFenceWrapSelection}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Copy blocks without fences</div>
                    <div className="settings-toggle-subtitle">
                      When enabled, Copy is plain text. Hold {optionKeyLabel} to include ``` fences.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.composerCodeBlockCopyUseModifier ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        composerCodeBlockCopyUseModifier:
                          !appSettings.composerCodeBlockCopyUseModifier,
                      })
                    }
                    aria-pressed={appSettings.composerCodeBlockCopyUseModifier}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-divider" />
                <div className="settings-subsection-title">Pasting</div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Auto-wrap multi-line paste</div>
                    <div className="settings-toggle-subtitle">
                      Wraps multi-line paste inside a fenced block.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.composerFenceAutoWrapPasteMultiline ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        composerFenceAutoWrapPasteMultiline:
                          !appSettings.composerFenceAutoWrapPasteMultiline,
                      })
                    }
                    aria-pressed={appSettings.composerFenceAutoWrapPasteMultiline}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Auto-wrap code-like single lines</div>
                    <div className="settings-toggle-subtitle">
                      Wraps long single-line code snippets on paste.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.composerFenceAutoWrapPasteCodeLike ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        composerFenceAutoWrapPasteCodeLike:
                          !appSettings.composerFenceAutoWrapPasteCodeLike,
                      })
                    }
                    aria-pressed={appSettings.composerFenceAutoWrapPasteCodeLike}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-divider" />
                <div className="settings-subsection-title">Lists</div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Continue lists on Shift+Enter</div>
                    <div className="settings-toggle-subtitle">
                      Continues numbered and bulleted lists when the line has content.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.composerListContinuation ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        composerListContinuation: !appSettings.composerListContinuation,
                      })
                    }
                    aria-pressed={appSettings.composerListContinuation}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
              </section>
            )}
            {activeSection === "dictation" && (
              <section className="settings-section">
                <div className="settings-section-title">{t("Dictation", "\u8bed\u97f3\u8f93\u5165")}</div>
                <div className="settings-section-subtitle">
                  Enable microphone dictation with on-device transcription.
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Enable dictation</div>
                    <div className="settings-toggle-subtitle">
                      Downloads the selected Whisper model on first use.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.dictationEnabled ? "on" : ""}`}
                    onClick={() => {
                      const nextEnabled = !appSettings.dictationEnabled;
                      void onUpdateAppSettings({
                        ...appSettings,
                        dictationEnabled: nextEnabled,
                      });
                      if (
                        !nextEnabled &&
                        dictationModelStatus?.state === "downloading" &&
                        onCancelDictationDownload
                      ) {
                        onCancelDictationDownload();
                      }
                      if (
                        nextEnabled &&
                        dictationModelStatus?.state === "missing" &&
                        onDownloadDictationModel
                      ) {
                        onDownloadDictationModel();
                      }
                    }}
                    aria-pressed={appSettings.dictationEnabled}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-field">
                  <label className="settings-field-label" htmlFor="dictation-model">
                    Dictation model
                  </label>
                  <select
                    id="dictation-model"
                    className="settings-select"
                    value={appSettings.dictationModelId}
                    onChange={(event) =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        dictationModelId: event.target.value,
                      })
                    }
                  >
                    {DICTATION_MODELS.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label} ({model.size})
                      </option>
                    ))}
                  </select>
                  <div className="settings-help">
                    {selectedDictationModel.note} Download size: {selectedDictationModel.size}.
                  </div>
                </div>
                <div className="settings-field">
                  <label className="settings-field-label" htmlFor="dictation-language">
                    Preferred dictation language
                  </label>
                  <select
                    id="dictation-language"
                    className="settings-select"
                    value={appSettings.dictationPreferredLanguage ?? ""}
                    onChange={(event) =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        dictationPreferredLanguage: event.target.value || null,
                      })
                    }
                  >
                    <option value="">Auto-detect only</option>
                    <option value="en">English</option>
                    <option value="es">Spanish</option>
                    <option value="fr">French</option>
                    <option value="de">German</option>
                    <option value="it">Italian</option>
                    <option value="pt">Portuguese</option>
                    <option value="nl">Dutch</option>
                    <option value="sv">Swedish</option>
                    <option value="no">Norwegian</option>
                    <option value="da">Danish</option>
                    <option value="fi">Finnish</option>
                    <option value="pl">Polish</option>
                    <option value="tr">Turkish</option>
                    <option value="ru">Russian</option>
                    <option value="uk">Ukrainian</option>
                    <option value="ja">Japanese</option>
                    <option value="ko">Korean</option>
                    <option value="zh">Chinese</option>
                  </select>
                  <div className="settings-help">
                    Auto-detect stays on; this nudges the decoder toward your preference.
                  </div>
                </div>
                <div className="settings-field">
                  <label className="settings-field-label" htmlFor="dictation-hold-key">
                    Hold-to-dictate key
                  </label>
                  <select
                    id="dictation-hold-key"
                    className="settings-select"
                    value={appSettings.dictationHoldKey ?? ""}
                    onChange={(event) =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        dictationHoldKey: event.target.value,
                      })
                    }
                  >
                    <option value="">Off</option>
                    <option value="alt">{optionKeyLabel}</option>
                    <option value="shift">Shift</option>
                    <option value="control">Control</option>
                    <option value="meta">{metaKeyLabel}</option>
                  </select>
                  <div className="settings-help">
                    Hold the key to start dictation, release to stop and process.
                  </div>
                </div>
                {dictationModelStatus && (
                  <div className="settings-field">
                    <div className="settings-field-label">
                      Model status ({selectedDictationModel.label})
                    </div>
                    <div className="settings-help">
                      {dictationModelStatus.state === "ready" && "Ready for dictation."}
                      {dictationModelStatus.state === "missing" && "Model not downloaded yet."}
                      {dictationModelStatus.state === "downloading" &&
                        "Downloading model..."}
                      {dictationModelStatus.state === "error" &&
                        (dictationModelStatus.error ?? "Download error.")}
                    </div>
                    {dictationProgress && (
                      <div className="settings-download-progress">
                        <div className="settings-download-bar">
                          <div
                            className="settings-download-fill"
                            style={{
                              width: dictationProgress.totalBytes
                                ? `${Math.min(
                                    100,
                                    (dictationProgress.downloadedBytes /
                                      dictationProgress.totalBytes) *
                                      100,
                                  )}%`
                                : "0%",
                            }}
                          />
                        </div>
                        <div className="settings-download-meta">
                          {formatDownloadSize(dictationProgress.downloadedBytes)}
                        </div>
                      </div>
                    )}
                    <div className="settings-field-actions">
                      {dictationModelStatus.state === "missing" && (
                        <button
                          type="button"
                          className="primary"
                          onClick={onDownloadDictationModel}
                          disabled={!onDownloadDictationModel}
                        >
                          Download model
                        </button>
                      )}
                      {dictationModelStatus.state === "downloading" && (
                        <button
                          type="button"
                          className="ghost settings-button-compact"
                          onClick={onCancelDictationDownload}
                          disabled={!onCancelDictationDownload}
                        >
                          Cancel download
                        </button>
                      )}
                      {dictationReady && (
                        <button
                          type="button"
                          className="ghost settings-button-compact"
                          onClick={onRemoveDictationModel}
                          disabled={!onRemoveDictationModel}
                        >
                          Remove model
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </section>
            )}
            {activeSection === "shortcuts" && (
              <section className="settings-section">
                <div className="settings-section-title">{t("Shortcuts", "\u5feb\u6377\u952e")}</div>
                <div className="settings-section-subtitle">
                  Customize keyboard shortcuts for file actions, composer, panels, and navigation.
                </div>
                <div className="settings-subsection-title">File</div>
                <div className="settings-subsection-subtitle">
                  Create agents and worktrees from the keyboard.
                </div>
                <div className="settings-field">
                  <div className="settings-field-label">New Agent</div>
                  <div className="settings-field-row">
                    <input
                      className="settings-input settings-input--shortcut"
                      value={formatShortcut(shortcutDrafts.newAgent)}
                      onKeyDown={(event) =>
                        handleShortcutKeyDown(event, "newAgentShortcut")
                      }
                      placeholder="Type shortcut"
                      readOnly
                    />
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() => void updateShortcut("newAgentShortcut", null)}
                    >
                      Clear
                    </button>
                  </div>
                  <div className="settings-help">
                    Default: {formatShortcut("cmd+n")}
                  </div>
                </div>
                <div className="settings-field">
                  <div className="settings-field-label">New Worktree Agent</div>
                  <div className="settings-field-row">
                    <input
                      className="settings-input settings-input--shortcut"
                      value={formatShortcut(shortcutDrafts.newWorktreeAgent)}
                      onKeyDown={(event) =>
                        handleShortcutKeyDown(event, "newWorktreeAgentShortcut")
                      }
                      placeholder="Type shortcut"
                      readOnly
                    />
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() => void updateShortcut("newWorktreeAgentShortcut", null)}
                    >
                      Clear
                    </button>
                  </div>
                  <div className="settings-help">
                    Default: {formatShortcut("cmd+shift+n")}
                  </div>
                </div>
                <div className="settings-field">
                  <div className="settings-field-label">New Clone Agent</div>
                  <div className="settings-field-row">
                    <input
                      className="settings-input settings-input--shortcut"
                      value={formatShortcut(shortcutDrafts.newCloneAgent)}
                      onKeyDown={(event) =>
                        handleShortcutKeyDown(event, "newCloneAgentShortcut")
                      }
                      placeholder="Type shortcut"
                      readOnly
                    />
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() => void updateShortcut("newCloneAgentShortcut", null)}
                    >
                      Clear
                    </button>
                  </div>
                  <div className="settings-help">
                    Default: {formatShortcut("cmd+alt+n")}
                  </div>
                </div>
                <div className="settings-field">
                  <div className="settings-field-label">Archive active thread</div>
                  <div className="settings-field-row">
                    <input
                      className="settings-input settings-input--shortcut"
                      value={formatShortcut(shortcutDrafts.archiveThread)}
                      onKeyDown={(event) =>
                        handleShortcutKeyDown(event, "archiveThreadShortcut")
                      }
                      placeholder="Type shortcut"
                      readOnly
                    />
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() => void updateShortcut("archiveThreadShortcut", null)}
                    >
                      Clear
                    </button>
                  </div>
                  <div className="settings-help">
                    Default:{" "}
                    {formatShortcut(isMacPlatform() ? "cmd+ctrl+a" : "ctrl+alt+a")}
                  </div>
                </div>
                <div className="settings-divider" />
                <div className="settings-subsection-title">Composer</div>
                <div className="settings-subsection-subtitle">
                  Cycle between model, access, reasoning, and collaboration modes.
                </div>
                <div className="settings-field">
                  <div className="settings-field-label">Cycle model</div>
                  <div className="settings-field-row">
                    <input
                      className="settings-input settings-input--shortcut"
                      value={formatShortcut(shortcutDrafts.model)}
                      onKeyDown={(event) =>
                        handleShortcutKeyDown(event, "composerModelShortcut")
                      }
                      placeholder="Type shortcut"
                      readOnly
                    />
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() => void updateShortcut("composerModelShortcut", null)}
                    >
                      Clear
                    </button>
                  </div>
                  <div className="settings-help">
                    Press a new shortcut while focused. Default: {formatShortcut("cmd+shift+m")}
                  </div>
                </div>
                <div className="settings-field">
                  <div className="settings-field-label">Cycle access mode</div>
                  <div className="settings-field-row">
                    <input
                      className="settings-input settings-input--shortcut"
                      value={formatShortcut(shortcutDrafts.access)}
                      onKeyDown={(event) =>
                        handleShortcutKeyDown(event, "composerAccessShortcut")
                      }
                      placeholder="Type shortcut"
                      readOnly
                    />
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() => void updateShortcut("composerAccessShortcut", null)}
                    >
                      Clear
                    </button>
                  </div>
                  <div className="settings-help">
                    Default: {formatShortcut("cmd+shift+a")}
                  </div>
                </div>
                <div className="settings-field">
                  <div className="settings-field-label">Cycle reasoning mode</div>
                  <div className="settings-field-row">
                    <input
                      className="settings-input settings-input--shortcut"
                      value={formatShortcut(shortcutDrafts.reasoning)}
                      onKeyDown={(event) =>
                        handleShortcutKeyDown(event, "composerReasoningShortcut")
                      }
                      placeholder="Type shortcut"
                      readOnly
                    />
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() => void updateShortcut("composerReasoningShortcut", null)}
                    >
                      Clear
                    </button>
                  </div>
                  <div className="settings-help">
                    Default: {formatShortcut("cmd+shift+r")}
                  </div>
                </div>
                <div className="settings-field">
                  <div className="settings-field-label">Cycle collaboration mode</div>
                  <div className="settings-field-row">
                    <input
                      className="settings-input settings-input--shortcut"
                      value={formatShortcut(shortcutDrafts.collaboration)}
                      onKeyDown={(event) =>
                        handleShortcutKeyDown(event, "composerCollaborationShortcut")
                      }
                      placeholder="Type shortcut"
                      readOnly
                    />
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() => void updateShortcut("composerCollaborationShortcut", null)}
                    >
                      Clear
                    </button>
                  </div>
                  <div className="settings-help">
                    Default: {formatShortcut("shift+tab")}
                  </div>
                </div>
                <div className="settings-field">
                  <div className="settings-field-label">Stop active run</div>
                  <div className="settings-field-row">
                    <input
                      className="settings-input settings-input--shortcut"
                      value={formatShortcut(shortcutDrafts.interrupt)}
                      onKeyDown={(event) =>
                        handleShortcutKeyDown(event, "interruptShortcut")
                      }
                      placeholder="Type shortcut"
                      readOnly
                    />
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() => void updateShortcut("interruptShortcut", null)}
                    >
                      Clear
                    </button>
                  </div>
                  <div className="settings-help">
                    Default: {formatShortcut(getDefaultInterruptShortcut())}
                  </div>
                </div>
                <div className="settings-divider" />
                <div className="settings-subsection-title">Panels</div>
                <div className="settings-subsection-subtitle">
                  Toggle sidebars and panels.
                </div>
                <div className="settings-field">
                  <div className="settings-field-label">Toggle projects sidebar</div>
                  <div className="settings-field-row">
                    <input
                      className="settings-input settings-input--shortcut"
                      value={formatShortcut(shortcutDrafts.projectsSidebar)}
                      onKeyDown={(event) =>
                        handleShortcutKeyDown(event, "toggleProjectsSidebarShortcut")
                      }
                      placeholder="Type shortcut"
                      readOnly
                    />
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() => void updateShortcut("toggleProjectsSidebarShortcut", null)}
                    >
                      Clear
                    </button>
                  </div>
                  <div className="settings-help">
                    Default: {formatShortcut("cmd+shift+p")}
                  </div>
                </div>
                <div className="settings-field">
                  <div className="settings-field-label">Toggle git sidebar</div>
                  <div className="settings-field-row">
                    <input
                      className="settings-input settings-input--shortcut"
                      value={formatShortcut(shortcutDrafts.gitSidebar)}
                      onKeyDown={(event) =>
                        handleShortcutKeyDown(event, "toggleGitSidebarShortcut")
                      }
                      placeholder="Type shortcut"
                      readOnly
                    />
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() => void updateShortcut("toggleGitSidebarShortcut", null)}
                    >
                      Clear
                    </button>
                  </div>
                  <div className="settings-help">
                    Default: {formatShortcut("cmd+shift+g")}
                  </div>
                </div>
                <div className="settings-field">
                  <div className="settings-field-label">Branch switcher</div>
                  <div className="settings-field-row">
                    <input
                      className="settings-input settings-input--shortcut"
                      value={formatShortcut(shortcutDrafts.branchSwitcher)}
                      onKeyDown={(event) =>
                        handleShortcutKeyDown(event, "branchSwitcherShortcut")
                      }
                      placeholder="Type shortcut"
                      readOnly
                    />
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() => void updateShortcut("branchSwitcherShortcut", null)}
                    >
                      Clear
                    </button>
                  </div>
                  <div className="settings-help">
                    Default: {formatShortcut("cmd+b")}
                  </div>
                </div>
                <div className="settings-field">
                  <div className="settings-field-label">Toggle debug panel</div>
                  <div className="settings-field-row">
                    <input
                      className="settings-input settings-input--shortcut"
                      value={formatShortcut(shortcutDrafts.debugPanel)}
                      onKeyDown={(event) =>
                        handleShortcutKeyDown(event, "toggleDebugPanelShortcut")
                      }
                      placeholder="Type shortcut"
                      readOnly
                    />
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() => void updateShortcut("toggleDebugPanelShortcut", null)}
                    >
                      Clear
                    </button>
                  </div>
                  <div className="settings-help">
                    Default: {formatShortcut("cmd+shift+d")}
                  </div>
                </div>
                <div className="settings-field">
                  <div className="settings-field-label">Toggle terminal panel</div>
                  <div className="settings-field-row">
                    <input
                      className="settings-input settings-input--shortcut"
                      value={formatShortcut(shortcutDrafts.terminal)}
                      onKeyDown={(event) =>
                        handleShortcutKeyDown(event, "toggleTerminalShortcut")
                      }
                      placeholder="Type shortcut"
                      readOnly
                    />
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() => void updateShortcut("toggleTerminalShortcut", null)}
                    >
                      Clear
                    </button>
                  </div>
                  <div className="settings-help">
                    Default: {formatShortcut("cmd+shift+t")}
                  </div>
                </div>
                <div className="settings-divider" />
                <div className="settings-subsection-title">Navigation</div>
                <div className="settings-subsection-subtitle">
                  Cycle between agents and workspaces.
                </div>
                <div className="settings-field">
                  <div className="settings-field-label">Next agent</div>
                  <div className="settings-field-row">
                    <input
                      className="settings-input settings-input--shortcut"
                      value={formatShortcut(shortcutDrafts.cycleAgentNext)}
                      onKeyDown={(event) =>
                        handleShortcutKeyDown(event, "cycleAgentNextShortcut")
                      }
                      placeholder="Type shortcut"
                      readOnly
                    />
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() => void updateShortcut("cycleAgentNextShortcut", null)}
                    >
                      Clear
                    </button>
                  </div>
                  <div className="settings-help">
                    Default:{" "}
                    {formatShortcut(
                      isMacPlatform() ? "cmd+ctrl+down" : "ctrl+alt+down",
                    )}
                  </div>
                </div>
                <div className="settings-field">
                  <div className="settings-field-label">Previous agent</div>
                  <div className="settings-field-row">
                    <input
                      className="settings-input settings-input--shortcut"
                      value={formatShortcut(shortcutDrafts.cycleAgentPrev)}
                      onKeyDown={(event) =>
                        handleShortcutKeyDown(event, "cycleAgentPrevShortcut")
                      }
                      placeholder="Type shortcut"
                      readOnly
                    />
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() => void updateShortcut("cycleAgentPrevShortcut", null)}
                    >
                      Clear
                    </button>
                  </div>
                  <div className="settings-help">
                    Default:{" "}
                    {formatShortcut(
                      isMacPlatform() ? "cmd+ctrl+up" : "ctrl+alt+up",
                    )}
                  </div>
                </div>
                <div className="settings-field">
                  <div className="settings-field-label">Next workspace</div>
                  <div className="settings-field-row">
                    <input
                      className="settings-input settings-input--shortcut"
                      value={formatShortcut(shortcutDrafts.cycleWorkspaceNext)}
                      onKeyDown={(event) =>
                        handleShortcutKeyDown(event, "cycleWorkspaceNextShortcut")
                      }
                      placeholder="Type shortcut"
                      readOnly
                    />
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() => void updateShortcut("cycleWorkspaceNextShortcut", null)}
                    >
                      Clear
                    </button>
                  </div>
                  <div className="settings-help">
                    Default:{" "}
                    {formatShortcut(
                      isMacPlatform()
                        ? "cmd+shift+down"
                        : "ctrl+alt+shift+down",
                    )}
                  </div>
                </div>
                <div className="settings-field">
                  <div className="settings-field-label">Previous workspace</div>
                  <div className="settings-field-row">
                    <input
                      className="settings-input settings-input--shortcut"
                      value={formatShortcut(shortcutDrafts.cycleWorkspacePrev)}
                      onKeyDown={(event) =>
                        handleShortcutKeyDown(event, "cycleWorkspacePrevShortcut")
                      }
                      placeholder="Type shortcut"
                      readOnly
                    />
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() => void updateShortcut("cycleWorkspacePrevShortcut", null)}
                    >
                      Clear
                    </button>
                  </div>
                  <div className="settings-help">
                    Default:{" "}
                    {formatShortcut(
                      isMacPlatform() ? "cmd+shift+up" : "ctrl+alt+shift+up",
                    )}
                  </div>
                </div>
              </section>
            )}
            {activeSection === "open-apps" && (
              <section className="settings-section">
                <div className="settings-section-title">{t("Open in", "\u6253\u5f00\u65b9\u5f0f")}</div>
                <div className="settings-section-subtitle">
                  Customize the Open in menu shown in the title bar and file previews.
                </div>
                <div className="settings-open-apps">
                  {openAppDrafts.map((target, index) => {
                    const iconSrc =
                      getKnownOpenAppIcon(target.id) ??
                      openAppIconById[target.id] ??
                      GENERIC_APP_ICON;
                    const labelValid = isOpenAppLabelValid(target.label);
                    const appNameValid =
                      target.kind !== "app" || Boolean(target.appName?.trim());
                    const commandValid =
                      target.kind !== "command" || Boolean(target.command?.trim());
                    const isComplete = labelValid && appNameValid && commandValid;
                    const incompleteHint = !labelValid
                      ? "Label required"
                      : target.kind === "app"
                        ? "App name required"
                        : target.kind === "command"
                          ? "Command required"
                          : "Complete required fields";
                    return (
                      <div
                        key={target.id}
                        className={`settings-open-app-row${
                          isComplete ? "" : " is-incomplete"
                        }`}
                      >
                        <div className="settings-open-app-icon-wrap" aria-hidden>
                          <img
                            className="settings-open-app-icon"
                            src={iconSrc}
                            alt=""
                            width={18}
                            height={18}
                          />
                        </div>
                        <div className="settings-open-app-fields">
                          <label className="settings-open-app-field settings-open-app-field--label">
                            <span className="settings-visually-hidden">Label</span>
                            <input
                              className="settings-input settings-input--compact settings-open-app-input settings-open-app-input--label"
                              value={target.label}
                              placeholder="Label"
                              onChange={(event) =>
                                handleOpenAppDraftChange(index, {
                                  label: event.target.value,
                                })
                              }
                              onBlur={() => {
                                void handleCommitOpenApps(openAppDrafts);
                              }}
                              aria-label={`Open app label ${index + 1}`}
                              data-invalid={!labelValid || undefined}
                            />
                          </label>
                          <label className="settings-open-app-field settings-open-app-field--type">
                            <span className="settings-visually-hidden">Type</span>
                            <select
                              className="settings-select settings-select--compact settings-open-app-kind"
                              value={target.kind}
                              onChange={(event) =>
                                handleOpenAppKindChange(
                                  index,
                                  event.target.value as OpenAppTarget["kind"],
                                )
                              }
                              aria-label={`Open app type ${index + 1}`}
                            >
                              <option value="app">App</option>
                              <option value="command">Command</option>
                              <option value="finder">{fileManagerName()}</option>
                            </select>
                          </label>
                          {target.kind === "app" && (
                            <label className="settings-open-app-field settings-open-app-field--appname">
                              <span className="settings-visually-hidden">App name</span>
                              <input
                                className="settings-input settings-input--compact settings-open-app-input settings-open-app-input--appname"
                                value={target.appName ?? ""}
                                placeholder="App name"
                                onChange={(event) =>
                                  handleOpenAppDraftChange(index, {
                                    appName: event.target.value,
                                  })
                                }
                                onBlur={() => {
                                  void handleCommitOpenApps(openAppDrafts);
                                }}
                                aria-label={`Open app name ${index + 1}`}
                                data-invalid={!appNameValid || undefined}
                              />
                            </label>
                          )}
                          {target.kind === "command" && (
                            <label className="settings-open-app-field settings-open-app-field--command">
                              <span className="settings-visually-hidden">Command</span>
                              <input
                                className="settings-input settings-input--compact settings-open-app-input settings-open-app-input--command"
                                value={target.command ?? ""}
                                placeholder="Command"
                                onChange={(event) =>
                                  handleOpenAppDraftChange(index, {
                                    command: event.target.value,
                                  })
                                }
                                onBlur={() => {
                                  void handleCommitOpenApps(openAppDrafts);
                                }}
                                aria-label={`Open app command ${index + 1}`}
                                data-invalid={!commandValid || undefined}
                              />
                            </label>
                          )}
                          {target.kind !== "finder" && (
                            <label className="settings-open-app-field settings-open-app-field--args">
                              <span className="settings-visually-hidden">Args</span>
                              <input
                                className="settings-input settings-input--compact settings-open-app-input settings-open-app-input--args"
                                value={target.argsText}
                                placeholder="Args"
                                onChange={(event) =>
                                  handleOpenAppDraftChange(index, {
                                    argsText: event.target.value,
                                  })
                                }
                                onBlur={() => {
                                  void handleCommitOpenApps(openAppDrafts);
                                }}
                                aria-label={`Open app args ${index + 1}`}
                              />
                            </label>
                          )}
                        </div>
                        <div className="settings-open-app-actions">
                          {!isComplete && (
                            <span
                              className="settings-open-app-status"
                              title={incompleteHint}
                              aria-label={incompleteHint}
                            >
                              Incomplete
                            </span>
                          )}
                          <label className="settings-open-app-default">
                            <input
                              type="radio"
                              name="open-app-default"
                              checked={target.id === openAppSelectedId}
                              onChange={() => handleSelectOpenAppDefault(target.id)}
                              disabled={!isComplete}
                            />
                            Default
                          </label>
                          <div className="settings-open-app-order">
                            <button
                              type="button"
                              className="ghost icon-button"
                              onClick={() => handleMoveOpenApp(index, "up")}
                              disabled={index === 0}
                              aria-label="Move up"
                            >
                              <ChevronUp aria-hidden />
                            </button>
                            <button
                              type="button"
                              className="ghost icon-button"
                              onClick={() => handleMoveOpenApp(index, "down")}
                              disabled={index === openAppDrafts.length - 1}
                              aria-label="Move down"
                            >
                              <ChevronDown aria-hidden />
                            </button>
                          </div>
                          <button
                            type="button"
                            className="ghost icon-button"
                            onClick={() => handleDeleteOpenApp(index)}
                            disabled={openAppDrafts.length <= 1}
                            aria-label="Remove app"
                            title="Remove app"
                          >
                            <Trash2 aria-hidden />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="settings-open-app-footer">
                  <button
                    type="button"
                    className="ghost"
                    onClick={handleAddOpenApp}
                  >
                    Add app
                  </button>
                  <div className="settings-help">
                    Commands receive the selected path as the final argument.{" "}
                    {isMacPlatform()
                      ? "Apps open via `open -a` with optional args."
                      : "Apps run as an executable with optional args."}
                  </div>
                </div>
              </section>
            )}
            {activeSection === "git" && (
              <section className="settings-section">
                <div className="settings-section-title">{t("Git", "Git")}</div>
                <div className="settings-section-subtitle">
                  Manage how diffs are loaded in the Git sidebar.
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Preload git diffs</div>
                    <div className="settings-toggle-subtitle">
                      Make viewing git diff faster.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.preloadGitDiffs ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        preloadGitDiffs: !appSettings.preloadGitDiffs,
                      })
                    }
                    aria-pressed={appSettings.preloadGitDiffs}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Ignore whitespace changes</div>
                    <div className="settings-toggle-subtitle">
                      Hides whitespace-only changes in local and commit diffs.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.gitDiffIgnoreWhitespaceChanges ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        gitDiffIgnoreWhitespaceChanges: !appSettings.gitDiffIgnoreWhitespaceChanges,
                      })
                    }
                    aria-pressed={appSettings.gitDiffIgnoreWhitespaceChanges}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
              </section>
            )}
            {activeSection === "codex" && (
              <section className="settings-section">
                <div className="settings-section-title">{t("Codex", "Codex")}</div>
                <div className="settings-section-subtitle">
                  Configure the Codex CLI used by CodexMonitor and validate the install.
                </div>
                <div className="settings-field">
                  <label className="settings-field-label" htmlFor="codex-path">
                    Default Codex path
                  </label>
                  <div className="settings-field-row">
                    <input
                      id="codex-path"
                      className="settings-input"
                      value={codexPathDraft}
                      placeholder="codex"
                      onChange={(event) => setCodexPathDraft(event.target.value)}
                    />
                    <button type="button" className="ghost" onClick={handleBrowseCodex}>
                      Browse
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => setCodexPathDraft("")}
                    >
                      Use PATH
                    </button>
                  </div>
                  <div className="settings-help">
                    Leave empty to use the system PATH resolution.
                  </div>
                  <label className="settings-field-label" htmlFor="codex-args">
                    Default Codex args
                  </label>
                  <div className="settings-field-row">
                    <input
                      id="codex-args"
                      className="settings-input"
                      value={codexArgsDraft}
                      placeholder="--profile personal"
                      onChange={(event) => setCodexArgsDraft(event.target.value)}
                    />
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => setCodexArgsDraft("")}
                    >
                      Clear
                    </button>
                  </div>
                  <div className="settings-help">
                    Extra flags passed before <code>app-server</code>. Use quotes for values with
                    spaces.
                  </div>
                <div className="settings-field-actions">
                  {codexDirty && (
                    <button
                      type="button"
                      className="primary"
                      onClick={handleSaveCodexSettings}
                      disabled={isSavingSettings}
                    >
                      {isSavingSettings ? "Saving..." : "Save"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="ghost settings-button-compact"
                    onClick={handleRunDoctor}
                    disabled={doctorState.status === "running"}
                  >
                    <Stethoscope aria-hidden />
                    {doctorState.status === "running" ? "Running..." : "Run doctor"}
                  </button>
                </div>

                {doctorState.result && (
                  <div
                    className={`settings-doctor ${doctorState.result.ok ? "ok" : "error"}`}
                  >
                    <div className="settings-doctor-title">
                      {doctorState.result.ok ? "Codex looks good" : "Codex issue detected"}
                    </div>
                    <div className="settings-doctor-body">
                      <div>
                        Version: {doctorState.result.version ?? "unknown"}
                      </div>
                      <div>
                        App-server: {doctorState.result.appServerOk ? "ok" : "failed"}
                      </div>
                      <div>
                        Node:{" "}
                        {doctorState.result.nodeOk
                          ? `ok (${doctorState.result.nodeVersion ?? "unknown"})`
                          : "missing"}
                      </div>
                      {doctorState.result.details && (
                        <div>{doctorState.result.details}</div>
                      )}
                      {doctorState.result.nodeDetails && (
                        <div>{doctorState.result.nodeDetails}</div>
                      )}
                      {doctorState.result.path && (
                        <div className="settings-doctor-path">
                          PATH: {doctorState.result.path}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

                <div className="settings-field">
                  <label className="settings-field-label" htmlFor="default-access">
                    Default access mode
                  </label>
                  <select
                    id="default-access"
                    className="settings-select"
                    value={appSettings.defaultAccessMode}
                    onChange={(event) =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        defaultAccessMode: event.target.value as AppSettings["defaultAccessMode"],
                      })
                    }
                  >
                    <option value="read-only">Read only</option>
                    <option value="current">On-request</option>
                    <option value="full-access">Full access</option>
                  </select>
                </div>
                <div className="settings-field">
                  <label className="settings-field-label" htmlFor="review-delivery">
                    Review mode
                  </label>
                  <select
                    id="review-delivery"
                    className="settings-select"
                    value={appSettings.reviewDeliveryMode}
                    onChange={(event) =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        reviewDeliveryMode:
                          event.target.value as AppSettings["reviewDeliveryMode"],
                      })
                    }
                  >
                    <option value="inline">Inline (same thread)</option>
                    <option value="detached">Detached (new review thread)</option>
                  </select>
                  <div className="settings-help">
                    Choose whether <code>/review</code> runs in the current thread or a detached
                    review thread.
                  </div>
                </div>

                <div className="settings-field">
                  <label className="settings-field-label" htmlFor="backend-mode">
                    Backend mode
                  </label>
                  <select
                    id="backend-mode"
                    className="settings-select"
                    value={appSettings.backendMode}
                    onChange={(event) =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        backendMode: event.target.value as AppSettings["backendMode"],
                      })
                    }
                  >
                    <option value="local">Local (default)</option>
                    <option value="remote">Remote (daemon)</option>
                  </select>
                  <div className="settings-help">
                    Remote mode connects to a separate daemon running the backend on another machine (e.g. WSL2/Linux).
                  </div>
                </div>

                {appSettings.backendMode === "remote" && (
                  <div className="settings-field">
                    <div className="settings-field-label">Remote backend</div>
                    <div className="settings-field-row">
                      <input
                        className="settings-input settings-input--compact"
                        value={remoteHostDraft}
                        placeholder="127.0.0.1:4732"
                        onChange={(event) => setRemoteHostDraft(event.target.value)}
                        onBlur={() => {
                          void handleCommitRemoteHost();
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void handleCommitRemoteHost();
                          }
                        }}
                        aria-label="Remote backend host"
                      />
                      <input
                        type="password"
                        className="settings-input settings-input--compact"
                        value={remoteTokenDraft}
                        placeholder="Token (optional)"
                        onChange={(event) => setRemoteTokenDraft(event.target.value)}
                        onBlur={() => {
                          void handleCommitRemoteToken();
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void handleCommitRemoteToken();
                          }
                        }}
                        aria-label="Remote backend token"
                      />
                    </div>
                    <div className="settings-help">
                      Start the daemon separately and point CodexMonitor to it (host:port + token).
                    </div>
                  </div>
                )}

                <FileEditorCard
                  title="Global AGENTS.md"
                  meta={globalAgentsMeta}
                  error={globalAgentsError}
                  value={globalAgentsContent}
                  placeholder="Add global instructions for Codex agents…"
                  disabled={globalAgentsLoading}
                  refreshDisabled={globalAgentsRefreshDisabled}
                  saveDisabled={globalAgentsSaveDisabled}
                  saveLabel={globalAgentsSaveLabel}
                  onChange={setGlobalAgentsContent}
                  onRefresh={() => {
                    void refreshGlobalAgents();
                  }}
                  onSave={() => {
                    void saveGlobalAgents();
                  }}
                  helpText={
                    <>
                      Stored at <code>~/.codex/AGENTS.md</code>.
                    </>
                  }
                  classNames={{
                    container: "settings-field settings-agents",
                    header: "settings-agents-header",
                    title: "settings-field-label",
                    actions: "settings-agents-actions",
                    meta: "settings-help settings-help-inline",
                    iconButton: "ghost settings-icon-button",
                    error: "settings-agents-error",
                    textarea: "settings-agents-textarea",
                    help: "settings-help",
                  }}
                />

                <FileEditorCard
                  title="Global config.toml"
                  meta={globalConfigMeta}
                  error={globalConfigError}
                  value={globalConfigContent}
                  placeholder="Edit the global Codex config.toml…"
                  disabled={globalConfigLoading}
                  refreshDisabled={globalConfigRefreshDisabled}
                  saveDisabled={globalConfigSaveDisabled}
                  saveLabel={globalConfigSaveLabel}
                  onChange={setGlobalConfigContent}
                  onRefresh={() => {
                    void refreshGlobalConfig();
                  }}
                  onSave={() => {
                    void saveGlobalConfig();
                  }}
                  helpText={
                    <>
                      Stored at <code>~/.codex/config.toml</code>.
                    </>
                  }
                  classNames={{
                    container: "settings-field settings-agents",
                    header: "settings-agents-header",
                    title: "settings-field-label",
                    actions: "settings-agents-actions",
                    meta: "settings-help settings-help-inline",
                    iconButton: "ghost settings-icon-button",
                    error: "settings-agents-error",
                    textarea: "settings-agents-textarea",
                    help: "settings-help",
                  }}
                />

                <div className="settings-field">
                  <div className="settings-field-label">Workspace overrides</div>
                  <div className="settings-overrides">
                    {projects.map((workspace) => (
                      <div key={workspace.id} className="settings-override-row">
                        <div className="settings-override-info">
                          <div className="settings-project-name">{workspace.name}</div>
                          <div className="settings-project-path">{workspace.path}</div>
                        </div>
                        <div className="settings-override-actions">
                          <div className="settings-override-field">
                            <input
                              className="settings-input settings-input--compact"
                              value={codexBinOverrideDrafts[workspace.id] ?? ""}
                              placeholder="Codex binary override"
                              onChange={(event) =>
                                setCodexBinOverrideDrafts((prev) => ({
                                  ...prev,
                                  [workspace.id]: event.target.value,
                                }))
                              }
                              onBlur={async () => {
                                const draft = codexBinOverrideDrafts[workspace.id] ?? "";
                                const nextValue = normalizeOverrideValue(draft);
                                if (nextValue === (workspace.codex_bin ?? null)) {
                                  return;
                                }
                                await onUpdateWorkspaceCodexBin(workspace.id, nextValue);
                              }}
                              aria-label={`Codex binary override for ${workspace.name}`}
                            />
                            <button
                              type="button"
                              className="ghost"
                              onClick={async () => {
                                setCodexBinOverrideDrafts((prev) => ({
                                  ...prev,
                                  [workspace.id]: "",
                                }));
                                await onUpdateWorkspaceCodexBin(workspace.id, null);
                              }}
                            >
                              Clear
                            </button>
                          </div>
                          <div className="settings-override-field">
                            <input
                              className="settings-input settings-input--compact"
                              value={codexHomeOverrideDrafts[workspace.id] ?? ""}
                              placeholder="CODEX_HOME override"
                              onChange={(event) =>
                                setCodexHomeOverrideDrafts((prev) => ({
                                  ...prev,
                                  [workspace.id]: event.target.value,
                                }))
                              }
                              onBlur={async () => {
                                const draft = codexHomeOverrideDrafts[workspace.id] ?? "";
                                const nextValue = normalizeOverrideValue(draft);
                                if (nextValue === (workspace.settings.codexHome ?? null)) {
                                  return;
                                }
                                await onUpdateWorkspaceSettings(workspace.id, {
                                  codexHome: nextValue,
                                });
                              }}
                              aria-label={`CODEX_HOME override for ${workspace.name}`}
                            />
                            <button
                              type="button"
                              className="ghost"
                              onClick={async () => {
                                setCodexHomeOverrideDrafts((prev) => ({
                                  ...prev,
                                  [workspace.id]: "",
                                }));
                                await onUpdateWorkspaceSettings(workspace.id, {
                                  codexHome: null,
                                });
                              }}
                            >
                              Clear
                            </button>
                          </div>
                          <div className="settings-override-field">
                            <input
                              className="settings-input settings-input--compact"
                              value={codexArgsOverrideDrafts[workspace.id] ?? ""}
                              placeholder="Codex args override"
                              onChange={(event) =>
                                setCodexArgsOverrideDrafts((prev) => ({
                                  ...prev,
                                  [workspace.id]: event.target.value,
                                }))
                              }
                              onBlur={async () => {
                                const draft = codexArgsOverrideDrafts[workspace.id] ?? "";
                                const nextValue = normalizeOverrideValue(draft);
                                if (nextValue === (workspace.settings.codexArgs ?? null)) {
                                  return;
                                }
                                await onUpdateWorkspaceSettings(workspace.id, {
                                  codexArgs: nextValue,
                                });
                              }}
                              aria-label={`Codex args override for ${workspace.name}`}
                            />
                            <button
                              type="button"
                              className="ghost"
                              onClick={async () => {
                                setCodexArgsOverrideDrafts((prev) => ({
                                  ...prev,
                                  [workspace.id]: "",
                                }));
                                await onUpdateWorkspaceSettings(workspace.id, {
                                  codexArgs: null,
                                });
                              }}
                            >
                              Clear
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                    {projects.length === 0 && (
                      <div className="settings-empty">{t("No projects yet.", "\u6682\u65e0\u9879\u76ee\u3002")}</div>
                    )}
                  </div>
                </div>

              </section>
            )}
            {activeSection === "features" && (
              <section className="settings-section">
                <div className="settings-section-title">{t("Features", "\u529f\u80fd\u7279\u6027")}</div>
                <div className="settings-section-subtitle">
                  Manage stable and experimental Codex features.
                </div>
                {hasCodexHomeOverrides && (
                  <div className="settings-help">
                    Feature settings are stored in the default CODEX_HOME config.toml.
                    <br />
                    Workspace overrides are not updated.
                  </div>
                )}
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Config file</div>
                    <div className="settings-toggle-subtitle">
                      Open the Codex config in {fileManagerName()}.
                    </div>
                  </div>
                  <button type="button" className="ghost" onClick={handleOpenConfig}>
                    {openInFileManagerLabel()}
                  </button>
                </div>
                {openConfigError && (
                  <div className="settings-help">{openConfigError}</div>
                )}
                <div className="settings-subsection-title">Stable Features</div>
                <div className="settings-subsection-subtitle">
                  Production-ready features enabled by default.
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Collaboration modes</div>
                    <div className="settings-toggle-subtitle">
                      Enable collaboration mode presets (Code, Plan).
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${
                      appSettings.collaborationModesEnabled ? "on" : ""
                    }`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        collaborationModesEnabled:
                          !appSettings.collaborationModesEnabled,
                      })
                    }
                    aria-pressed={appSettings.collaborationModesEnabled}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Personality</div>
                    <div className="settings-toggle-subtitle">
                      Choose Codex communication style (writes top-level{" "}
                      <code>personality</code> in config.toml).
                    </div>
                  </div>
                  <select
                    id="features-personality-select"
                    className="settings-select"
                    value={appSettings.personality}
                    onChange={(event) =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        personality: event.target.value as AppSettings["personality"],
                      })
                    }
                    aria-label="Personality"
                  >
                    <option value="friendly">Friendly</option>
                    <option value="pragmatic">Pragmatic</option>
                  </select>
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Steer mode</div>
                    <div className="settings-toggle-subtitle">
                      Send messages immediately. Use Tab to queue while a run is active.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.steerEnabled ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        steerEnabled: !appSettings.steerEnabled,
                      })
                    }
                    aria-pressed={appSettings.steerEnabled}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Background terminal</div>
                    <div className="settings-toggle-subtitle">
                      Run long-running terminal commands in the background.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.unifiedExecEnabled ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        unifiedExecEnabled: !appSettings.unifiedExecEnabled,
                      })
                    }
                    aria-pressed={appSettings.unifiedExecEnabled}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-subsection-title">Experimental Features</div>
                <div className="settings-subsection-subtitle">
                  Preview features that may change or be removed.
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Multi-agent</div>
                    <div className="settings-toggle-subtitle">
                      Enable multi-agent collaboration tools in Codex.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.experimentalCollabEnabled ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        experimentalCollabEnabled: !appSettings.experimentalCollabEnabled,
                      })
                    }
                    aria-pressed={appSettings.experimentalCollabEnabled}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Apps</div>
                    <div className="settings-toggle-subtitle">
                      Enable ChatGPT apps/connectors and the <code>/apps</code> command.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.experimentalAppsEnabled ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        experimentalAppsEnabled: !appSettings.experimentalAppsEnabled,
                      })
                    }
                    aria-pressed={appSettings.experimentalAppsEnabled}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
