// Content block types within assistant messages
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  // Plain text, or an array of nested content parts (text/image blocks)
  content: string | unknown[];
  is_error?: boolean;
}

// Pasted screenshots and attached files inside user messages
export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

export interface DocumentBlock {
  type: "document";
  source: { type: "base64"; media_type: string; data: string };
}

// Emitted mid-message when the harness switches models (e.g. refusal fallback)
export interface FallbackBlock {
  type: "fallback";
  from?: { model?: string };
  to?: { model?: string };
}

export type ContentBlock =
  | ThinkingBlock
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | DocumentBlock
  | FallbackBlock;

// Usage / token tracking
export interface CacheCreationDetail {
  ephemeral_5m_input_tokens: number;
  ephemeral_1h_input_tokens: number;
}

export interface UsageData {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  cache_creation?: CacheCreationDetail;
  service_tier?: string;
}

// Why the prompt cache was invalidated for this request (newer Claude Code)
export interface CacheMissReason {
  type?: string;
  cache_missed_input_tokens?: number;
}

export interface MessageDiagnostics {
  cache_miss_reason?: CacheMissReason;
  [key: string]: unknown;
}

// The inner message object on assistant/user events
export interface AssistantMessage {
  model?: string;
  id?: string;
  type: "message";
  role: "assistant";
  content: ContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: UsageData;
  diagnostics?: MessageDiagnostics;
}

export interface UserMessage {
  role: "user";
  content: string | ContentBlock[];
}

// Top-level JSONL event types
export interface UserEvent {
  type: "user";
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  message: UserMessage;
  isSidechain: boolean;
  cwd: string;
  version?: string;
  gitBranch?: string;
  thinkingMetadata?: { maxThinkingTokens: number };
  permissionMode?: string;
  toolUseResult?: ToolUseResultMeta;
  sourceToolAssistantUUID?: string;
  slug?: string;
  todos?: unknown[];
}

export interface ToolUseResultMeta {
  stdout?: string;
  stderr?: string;
  interrupted?: boolean;
  isImage?: boolean;
  filenames?: string[];
  durationMs?: number;
  numFiles?: number;
  truncated?: boolean;
}

export interface AssistantEvent {
  type: "assistant";
  uuid: string;
  parentUuid: string;
  sessionId: string;
  timestamp: string;
  message: AssistantMessage;
  requestId?: string;
  isSidechain: boolean;
  cwd: string;
  version?: string;
  gitBranch?: string;
  slug?: string;
  agentId?: string;
  effort?: string;
  // Synthetic assistant messages describing API failures (rate limits, auth)
  isApiErrorMessage?: boolean;
  error?: string;
  apiErrorStatus?: number | null;
  errorDetails?: unknown;
  // Which skill/agent/MCP tool produced this turn
  attributionAgent?: string;
  attributionSkill?: string;
  attributionMcpServer?: string;
  attributionMcpTool?: string;
}

export interface CompactMetadata {
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
  cumulativeDroppedTokens?: number;
  durationMs?: number;
}

export interface SystemEvent {
  type: "system";
  uuid: string;
  parentUuid: string | null;
  logicalParentUuid?: string | null;
  sessionId?: string;
  timestamp: string;
  subtype?: string;
  content?: string;
  level?: string;
  isSidechain: boolean;
  isMeta?: boolean;
  agentId?: string;
  compactMetadata?: CompactMetadata;
  durationMs?: number;
  messageCount?: number;
}

export interface ProgressEvent {
  type: "progress";
  uuid: string;
  parentUuid: string | null;
  sessionId?: string;
  timestamp: string;
  data: {
    type: string;
    hookEvent?: string;
    hookName?: string;
    command?: string;
  };
  parentToolUseID?: string;
  toolUseID?: string;
  isSidechain: boolean;
}

export interface FileHistorySnapshot {
  type: "file-history-snapshot";
  messageId: string;
  snapshot: {
    messageId: string;
    trackedFileBackups: Record<string, unknown>;
    timestamp: string;
  };
  isSnapshotUpdate: boolean;
}

// Newer Claude Code versions emit hook outcomes, skill listings, plan-mode
// transitions, file references, etc. as top-level "attachment" events. The
// inner attachment payload is keyed by `attachment.type` (the subtype).
export interface AttachmentPayload {
  type: string;
  [key: string]: unknown;
}

export interface AttachmentEvent {
  type: "attachment";
  uuid: string;
  parentUuid: string | null;
  sessionId?: string;
  timestamp: string;
  attachment: AttachmentPayload;
  isSidechain: boolean;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  userType?: string;
  entrypoint?: string;
  slug?: string;
  agentId?: string;
}

// Sidecar records without uuid/parentUuid. `ai-title`, `agent-name`, and
// `last-prompt` carry session naming; `mode`/`permission-mode` record mode
// switches; `queue-operation` records queued prompts and task notifications;
// `pr-link`/`frame-link` record PRs and published artifacts.
export interface AiTitleEvent {
  type: "ai-title";
  aiTitle: string;
  sessionId: string;
}

export interface AgentNameEvent {
  type: "agent-name";
  agentName: string;
  sessionId: string;
}

export interface LastPromptEvent {
  type: "last-prompt";
  lastPrompt: string;
  leafUuid?: string;
  sessionId: string;
}

export interface ModeEvent {
  type: "mode";
  mode: string;
  sessionId: string;
}

export interface PermissionModeEvent {
  type: "permission-mode";
  permissionMode: string;
  sessionId: string;
}

export interface QueueOperationEvent {
  type: "queue-operation";
  operation: string;
  timestamp: string;
  sessionId: string;
  content?: string;
}

export interface PrLinkEvent {
  type: "pr-link";
  sessionId: string;
  prNumber?: number;
  prUrl?: string;
  prRepository?: string;
  timestamp: string;
}

export interface FrameLinkEvent {
  type: "frame-link";
  sessionId: string;
  path?: string;
  frameUrl?: string;
  title?: string;
  timestamp: string;
}

export interface FileHistoryDelta {
  type: "file-history-delta";
  messageId: string;
  snapshotMessageId?: string;
  trackingPath?: string;
  backup?: Record<string, unknown>;
  timestamp: string;
}

export type SessionEvent =
  | UserEvent
  | AssistantEvent
  | SystemEvent
  | ProgressEvent
  | AttachmentEvent
  | FileHistorySnapshot
  | AiTitleEvent
  | AgentNameEvent
  | LastPromptEvent
  | ModeEvent
  | PermissionModeEvent
  | QueueOperationEvent
  | PrLinkEvent
  | FrameLinkEvent
  | FileHistoryDelta;

// Tool call paired with its result
export interface ToolPair {
  toolUse: ToolUseBlock;
  toolResult: ToolResultBlock | null;
  assistantTimestamp: string;
  resultTimestamp: string | null;
  assistantUuid: string;
  resultUuid: string | null;
}

// Analysis output types

export interface TimelineEntry {
  type: "thinking" | "tool_use" | "tool_result" | "text";
  timestamp: string;
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  isError?: boolean;
  ctxSpikeTokens?: number;
  assistantTurnId?: string;
}

export interface ToolStats {
  name: string;
  count: number;
  successes: number;
  failures: number;
  avgDurationMs: number | null;
  attributedInputTokens: number;
  attributedCacheCreationTokens: number;
  attributedCacheReadTokens: number;
  attributedOutputTokens: number;
  attributedTotalTokens: number;
}

export interface FileAccess {
  path: string;
  reads: number;
  writes: number;
  edits: number;
}

export interface ToolPattern {
  sequence: string[];
  count: number;
}

export interface TokenTurn {
  turnIndex: number;
  timestamp: string;
  scopeId?: string;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface CompactionEvent {
  afterTurnIndex: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensFreed: number;
}

export interface SkillFileImpact {
  filePath: string;
  type: "claude-md" | "skill" | "config";
  estimatedTokens: number;
  cacheCreationSpike: number;
}

// An inline image extracted from message or tool-result content
export interface InlineImage {
  mediaType: string;
  data: string;
}

export interface NetworkRequestEntry {
  toolUseId: string;
  toolName: string;
  scopeId: string;
  linkedSubagentId: string | null;
  startTimestamp: string;
  endTimestamp: string | null;
  timeMs: number | null;
  ctxSpikeTokens: number;
  isError: boolean;
  toolInput: Record<string, unknown>;
  toolResultContent: string | null;
}

export type NetworkEventKind =
  | "tool_use"
  | "user_message"
  | "assistant_text"
  | "thinking"
  | "hook"
  | "system"
  | "compaction"
  | "attachment";

export interface NetworkTimelineEvent {
  id: string;
  kind: NetworkEventKind;
  timestamp: string;
  scopeId: string;
  // Short label for table display
  summary: string;
  // Full content for detail panel
  content: string;
  // Tool-specific (kind === "tool_use")
  toolName?: string;
  toolUseId?: string;
  linkedSubagentId?: string | null;
  timeMs?: number | null;
  ctxSpikeTokens?: number;
  isError?: boolean;
  toolInput?: Record<string, unknown>;
  toolResultContent?: string | null;
  // Tool result-specific
  toolUseResult?: Record<string, unknown>;
  // Progress-specific
  hookEvent?: string;
  hookName?: string;
  progressType?: string;
  // Assistant-specific: token usage
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  // Streaming: groups events from the same API request
  requestId?: string;
  // Assistant-specific: request metadata
  model?: string;
  effort?: string;
  attributionSkill?: string;
  attributionAgent?: string;
  attributionMcpServer?: string;
  // Why the prompt cache missed on this request (explains Ctx+ spikes)
  cacheMissReason?: { type: string; tokens?: number };
  // API errors surfaced as synthetic assistant messages
  apiError?: string;
  apiErrorStatus?: number | null;
  // Images extracted from user messages / tool results
  images?: InlineImage[];
  toolResultImages?: InlineImage[];
  // System-specific
  subtype?: string;
  durationMs?: number;
  // Extra structured payload for system rows (refusal fallback, stop hooks, links)
  systemData?: Record<string, unknown>;
  // Compaction-specific
  compactTrigger?: string;
  preTokens?: number;
  postTokens?: number;
  droppedTokens?: number;
  // Attachment-specific
  attachmentType?: string;
  attachmentData?: Record<string, unknown>;
  // Hook-specific (richer fields from attachment-shaped hook events)
  hookCommand?: string;
  hookStdout?: string;
  hookStderr?: string;
  hookExitCode?: number;
}

export interface NetworkAgentScope {
  id: string;
  label: string;
  requests: NetworkRequestEntry[];
  events: NetworkTimelineEvent[];
}
