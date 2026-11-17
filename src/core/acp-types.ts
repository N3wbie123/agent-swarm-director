/**
 * ASD Pure Agent Client Protocol (ACP) Types (src/core/acp-types.ts)
 *
 * Zero-dependency TypeScript definitions covering:
 * - ACP v1 stable wire schema (`protocolVersion: 1`):
 *   `initialize`, `session/new`, `session/load`, `session/set_model`,
 *   `session/set_config_option`, `session/prompt`, `session/cancel`,
 *   `session/update`, and `session/request_permission`.
 * - ACP v2 draft compatibility layer (`protocolVersion: 2`):
 *   Immediate ACK `session/prompt` + asynchronous state/upsert `session/update`
 *   notifications normalized into a single event-driven internal contract.
 *
 * Invariants:
 * - Strict Core Purity: ZERO imports from ../adapters, ../mcp, or ../cli.
 * - Zero external runtime or type dependencies.
 * - Erasable TypeScript only (no enum, no namespace, no parameter properties).
 */

import type { AgentRole, HarnessId } from "./types.ts";

// ============================================================================
// JSON-RPC 2.0 Wire Primitives
// ============================================================================

export type JsonRpcId = string | number;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: TParams;
}

export interface JsonRpcNotification<TParams = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: TParams;
}

export interface JsonRpcSuccessResponse<TResult = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: TResult;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse<TResult = unknown> =
  | JsonRpcSuccessResponse<TResult>
  | JsonRpcErrorResponse;

// ============================================================================
// ACP Protocol Versions & Handshake (`initialize`)
// ============================================================================

export type AcpProtocolVersion = 1 | 2 | number;

export interface AcpClientCapabilities {
  fs?: {
    readTextFile?: boolean;
    writeTextFile?: boolean;
  };
  terminal?: boolean;
  _meta?: Record<string, unknown>;
}

export interface AcpClientInfo {
  name: string;
  title?: string;
  version: string;
}

export interface AcpInitializeParams {
  protocolVersion: AcpProtocolVersion;
  clientCapabilities: AcpClientCapabilities;
  clientInfo?: AcpClientInfo;
}

export interface AcpAgentCapabilities {
  loadSession?: boolean;
  load_session?: boolean;
  promptCapabilities?: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  };
  sessionCapabilities?: Record<string, unknown>;
  session_capabilities?: Record<string, unknown>;
  mcpCapabilities?: {
    http?: boolean;
    sse?: boolean;
  };
  _meta?: Record<string, unknown>;
}

export interface AcpInitializeResult {
  protocolVersion: AcpProtocolVersion;
  agentCapabilities?: AcpAgentCapabilities;
  agentInfo?: {
    name: string;
    title?: string;
    version?: string;
  };
  authMethods?: Array<{
    id: string;
    name: string;
    description?: string;
  }>;
}

// ============================================================================
// ACP Session Management (`session/new`, `session/load`, `session/set_*`)
// ============================================================================

export interface AcpMcpServerSpec {
  name: string;
  command?: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
  type?: "stdio" | "http" | "sse";
  url?: string;
}

export interface AcpSessionNewParams {
  cwd: string;
  mcpServers: AcpMcpServerSpec[];
  _meta?: Record<string, unknown>;
}

export interface AcpSessionModelInfo {
  modelId: string;
  name?: string;
  description?: string;
}

export interface AcpSessionConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: Array<{
    value: string;
    name?: string;
    description?: string;
  }>;
}

export interface AcpSessionNewResult {
  sessionId: string;
  models?: {
    availableModels?: AcpSessionModelInfo[];
    currentModelId?: string;
  };
  modes?: {
    currentModeId?: string;
    availableModes?: Array<{
      id: string;
      name?: string;
      description?: string;
    }>;
  };
  configOptions?: AcpSessionConfigOption[];
  _meta?: Record<string, unknown>;
}

export interface AcpSessionLoadParams {
  sessionId: string;
  cwd: string;
  mcpServers: AcpMcpServerSpec[];
}

export interface AcpSessionSetModelParams {
  sessionId: string;
  modelId: string;
}

export interface AcpSessionSetConfigOptionParams {
  sessionId: string;
  configId: string;
  value: string;
}

// ============================================================================
// ACP Prompt, Streaming Updates & Cancellation (`session/prompt`, `session/update`)
// ============================================================================

export interface AcpTextContentBlock {
  type: "text";
  text: string;
}

export type AcpContentBlock =
  | AcpTextContentBlock
  | {
      type: string;
      text?: string;
      content?: unknown;
      [key: string]: unknown;
    };

export interface AcpSessionPromptParams {
  sessionId: string;
  prompt: AcpContentBlock[];
  _meta?: Record<string, unknown>;
}

export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled"
  | string;

export interface AcpSessionPromptResult {
  stopReason?: AcpStopReason;
  accepted?: boolean;
  state?: string;
  _meta?: Record<string, unknown>;
}

export interface AcpSessionCancelParams {
  sessionId: string;
}

export type AcpSessionUpdateKind =
  | "agent_message_chunk"
  | "agent_thought_chunk"
  | "user_message_chunk"
  | "tool_call"
  | "tool_call_update"
  | "plan"
  | "available_commands_update"
  | "current_mode_update"
  | "config_option_update"
  | "session_state"
  | "turn_complete"
  | string;

export interface AcpToolCallLocation {
  path: string;
  line?: number;
}

export interface AcpSessionUpdatePayload {
  sessionUpdate?: AcpSessionUpdateKind;
  type?: string;
  id?: string;
  state?: "working" | "idle" | string;
  stopReason?: AcpStopReason;
  content?: AcpContentBlock | AcpContentBlock[] | string;
  text?: string;
  delta?: string;
  toolCallId?: string;
  title?: string;
  kind?: "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other" | string;
  status?: "pending" | "in_progress" | "completed" | "failed" | string;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: AcpToolCallLocation[];
  [key: string]: unknown;
}

export interface AcpSessionUpdateParams {
  sessionId: string;
  update?: AcpSessionUpdatePayload;
  type?: string;
  state?: string;
  stopReason?: AcpStopReason;
  [key: string]: unknown;
}

// ============================================================================
// ACP Bidirectional Permission Gate (`session/request_permission`)
// ============================================================================

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export interface AcpRequestPermissionToolCall {
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  locations?: AcpToolCallLocation[];
  [key: string]: unknown;
}

export interface AcpRequestPermissionParams {
  sessionId: string;
  toolCall: AcpRequestPermissionToolCall;
  options: AcpPermissionOption[];
}

export type AcpRequestPermissionOutcome =
  | {
      outcome: "selected";
      optionId: string;
    }
  | {
      outcome: "cancelled";
    };

export interface AcpRequestPermissionResult {
  outcome: AcpRequestPermissionOutcome;
}

// ============================================================================
// Unified ASD Internal ACP Event & Execution Contracts (v1 + v2 Normalized)
// ============================================================================

export type AcpNormalizedEventCategory =
  | "text"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "permission"
  | "state";

export interface AcpNormalizedEvent {
  category: AcpNormalizedEventCategory;
  sessionId: string;
  text?: string;
  thinking?: string;
  toolCallId?: string;
  toolName?: string;
  toolKind?: string;
  toolInput?: string;
  toolOutput?: string;
  isError?: boolean;
  permissionDecision?: "allowed" | "denied";
  permissionReason?: string;
  stopReason?: AcpStopReason;
  timestamp: number;
}

export interface AcpPolicyContext {
  harness: HarnessId;
  role: AgentRole;
  cwd: string;
  allowedFiles: string[];
  metaPath?: string;
  env?: Record<string, string | undefined>;
}

export interface AcpTurnExecutionResult {
  exitCode: number;
  pid: number;
  sessionId: string | null;
  protocolVersion: number;
  stopReason: AcpStopReason | null;
  assistantText: string;
  timedOut: boolean;
  timeoutReason?: "idle" | "wall_clock";
  status: "done" | "failed";
  durationMs: number;
  errorSummary?: string;
}
