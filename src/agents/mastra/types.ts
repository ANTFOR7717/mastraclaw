/**
 * Internal types for the Mastra gateway adapter layer.
 *
 * These types bridge OpenClaw's internal pi-agent-core types with Mastra's
 * CoreMessage / ToolAction types from the Vercel AI SDK.
 */

import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { ModelApi } from "../../config/types.models.js";

/** Result returned by runMastraAgent after a complete agent run. */
export type MastraRunResult = {
  /** Final assistant text (all steps concatenated). */
  text: string;
  /** Whether the run was aborted. */
  aborted: boolean;
  /** Whether the run timed out. */
  timedOut: boolean;
  /** Error from the run, if any. */
  error?: unknown;
  /** Tool calls made during the run. */
  toolCalls: Array<{ toolName: string; args: unknown }>;
  /** Tool results from the run. */
  toolResults: Array<{ toolName: string; result: unknown }>;
  /** Token usage (last step). */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
};

/** Parameters for resolving a Mastra model config from OpenClaw provider config. */
export type MastraModelParams = {
  provider: string;
  modelId: string;
  modelApi: ModelApi;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
};

/** Parameters for running the Mastra agent. */
export type MastraAgentRunParams = {
  provider: string;
  modelId: string;
  modelApi: ModelApi;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  systemPrompt: string;
  /** Serialized history messages (pi-agent-core AgentMessage format). */
  historyMessages: unknown[];
  /** The new user prompt text. */
  prompt: string;
  /** Optional image attachments for the prompt. */
  images?: Array<{ data: string; mimeType: string }>;
  /** Tools available to the agent. */
  tools: unknown[];
  /** Thinking level for reasoning models. */
  thinkLevel?: ThinkLevel;
  /** Max tool loop steps (default: 50). */
  maxSteps?: number;
  /** Abort signal for cancellation. */
  abortSignal?: AbortSignal;
  /** Called for each text delta from the model. */
  onTextDelta?: (text: string) => void;
  /** Called when a tool call starts. */
  onToolCall?: (toolName: string, args: unknown) => void;
  /** Called when a tool result is available. */
  onToolResult?: (toolName: string, result: unknown) => void;
};
