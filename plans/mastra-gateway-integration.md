# Plan: Power OpenClaw's LLM Gateway with Mastra

**Status:** Draft — awaiting review (Audit 2 blockers applied 2026-02-28)
**Branch target:** `main`
**Scope:** Replace the `@mariozechner/pi-*` LLM execution stack with Mastra as the AI gateway engine. No TUI changes. No session format migration. Existing JSONL session files are preserved as-is.

---

## 1. Executive Summary

OpenClaw currently uses the `@mariozechner/pi-coding-agent` / `@mariozechner/pi-ai` / `@mariozechner/pi-agent-core` stack as its embedded LLM execution engine. This plan replaces that stack with [Mastra](https://mastra.ai) v1.8.0 — a production-ready TypeScript AI framework built on the Vercel AI SDK — as the new LLM gateway.

**Key constraint:** The existing JSONL session file format, TUI, and all channel integrations are **unchanged**. The swap is purely at the LLM execution layer: how OpenClaw calls providers, streams responses, and executes tools.

The approach is a **feature-flagged adapter layer**: a new `src/agents/mastra/` module implements the same internal contracts as the pi stack. A config flag `agents.gateway = "pi" | "mastra"` selects the path. Once parity is confirmed, `"mastra"` becomes the default.

---

## 2. What Mastra Provides (Verified from v1.8.0 package)

Mastra v1.8.0 exports:

| Import path | Key exports |
|---|---|
| `@mastra/core/agent` | `Agent` class with `.stream()` and `.generate()` |
| `@mastra/core/tools` | `createTool`, `ToolAction`, `VercelTool` |
| `@mastra/core/llm` | `CoreMessage`, `MastraModelConfig`, `LanguageModel` |

### 2.1 Agent API

```typescript
import { Agent } from "@mastra/core/agent";

const agent = new Agent({
  id: "openclaw-agent",
  name: "OpenClaw Agent",
  instructions: systemPrompt,          // string | SystemMessage
  model: {                             // MastraModelConfig
    id: "anthropic/claude-opus-4-5",   // ModelRouterModelId string
    // OR: LanguageModelV1 from @ai-sdk/anthropic
    // OR: OpenAICompatibleConfig { id: "provider/model", url, apiKey }
  },
  tools: { readFile, writeFile },      // Record<string, ToolAction>
});

// Streaming (returns MastraModelOutput)
const output = await agent.stream(messages);
// output.textStream: ReadableStream<string>
// output.fullStream: ReadableStream<ChunkType>  — includes tool-call/tool-result events
// output.toolCalls: Promise<ToolCallChunk[]>
// output.toolResults: Promise<ToolResultChunk[]>

// Non-streaming (for compaction)
const result = await agent.generate(messages);
// result.text: string
// result.toolCalls, result.toolResults, result.usage
```

### 2.2 Model Configuration

`MastraModelConfig` accepts three forms:

1. **`ModelRouterModelId`** — string like `"anthropic/claude-opus-4-5"` (uses Mastra's built-in model router)
2. **`LanguageModelV1`** — direct `@ai-sdk/*` provider instance (e.g. `anthropic("claude-opus-4-5")`)
3. **`OpenAICompatibleConfig`** — `{ id: "provider/model", url, apiKey, headers }` for custom endpoints

Form 3 is the key to supporting all of OpenClaw's existing providers without needing separate `@ai-sdk/*` packages for each.

### 2.3 Tool API

```typescript
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const readFileTool = createTool({
  id: "read_file",
  description: "Read a file",
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ context }) => {
    return fs.readFile(context.path, "utf-8");
  },
});
```

Tools use **Zod schemas**. OpenClaw tools use **TypeBox schemas**. The adapter converts TypeBox → Zod.

### 2.4 Message Format

Mastra uses `CoreMessage[]` from the Vercel AI SDK (ai-sdk v4 compatible):

```typescript
type CoreMessage =
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | AssistantContentPart[] }
  | { role: "tool"; content: ToolResultPart[] }
  | { role: "system"; content: string }
```

OpenClaw's `AgentMessage` (from pi-agent-core) uses the same role names with compatible content shapes. The adapter converts between them.

---

## 3. Current Architecture

### 3.1 The pi-coding-agent Execution Path

```
Channel message
  → src/gateway/server-methods/chat.ts
    → src/agents/pi-embedded-runner/run.ts  (runEmbeddedPiAgent)
      → src/agents/pi-embedded-runner/run/attempt.ts  (runEmbeddedAttempt)
        → @mariozechner/pi-coding-agent  createAgentSession()
          → @mariozechner/pi-ai  streamSimple()
            → Provider API
```

### 3.2 pi Stack Packages and Roles

| Package | Role in OpenClaw |
|---|---|
| [`@mariozechner/pi-agent-core`](package.json:163) | Types: `AgentMessage`, `AgentTool`, `AgentToolResult`, `StreamFn`, `ThinkingLevel` |
| [`@mariozechner/pi-ai`](package.json:164) | Provider HTTP clients: `streamSimple`, `completeSimple`, `getModel`, `Model<Api>`, OAuth helpers |
| [`@mariozechner/pi-coding-agent`](package.json:165) | Session + agent orchestration: `SessionManager`, `createAgentSession`, `DefaultResourceLoader`, `SettingsManager`, `codingTools`, `generateSummary`, `estimateTokens` |

### 3.3 Files That Import pi Packages (Integration Surface)

**Core execution path — must be adapted:**
- [`src/agents/pi-embedded-runner/run/attempt.ts`](src/agents/pi-embedded-runner/run/attempt.ts:711) — `createAgentSession`, `SessionManager`, `streamSimple`
- [`src/agents/pi-embedded-runner/compact.ts`](src/agents/pi-embedded-runner/compact.ts:572) — same, for compaction loop
- [`src/agents/pi-embedded-runner/model.ts`](src/agents/pi-embedded-runner/model.ts:42) — `AuthStorage`, `ModelRegistry`, `Model<Api>`
- [`src/agents/pi-embedded-runner/extra-params.ts`](src/agents/pi-embedded-runner/extra-params.ts:154) — `StreamFn`, `streamSimple` wrapping
- [`src/agents/pi-embedded-runner/extensions.ts`](src/agents/pi-embedded-runner/extensions.ts:31) — `ExtensionFactory`, `SessionManager`
- [`src/agents/pi-embedded-runner/google.ts`](src/agents/pi-embedded-runner/google.ts:387) — `SessionManager` (Google-specific sanitization)
- [`src/agents/pi-embedded-runner/tool-result-truncation.ts`](src/agents/pi-embedded-runner/tool-result-truncation.ts:164) — `SessionManager`
- [`src/agents/pi-embedded-runner/system-prompt.ts`](src/agents/pi-embedded-runner/system-prompt.ts:1) — `AgentSession`
- [`src/agents/pi-model-discovery.ts`](src/agents/pi-model-discovery.ts:1) — `AuthStorage`, `ModelRegistry`
- [`src/agents/model-auth.ts`](src/agents/model-auth.ts:1) — `getEnvApiKey`, `Model<Api>`
- [`src/agents/model-compat.ts`](src/agents/model-compat.ts:1) — `Model<Api>`
- [`src/agents/model-forward-compat.ts`](src/agents/model-forward-compat.ts:1) — `Model<Api>`, `ModelRegistry`
- [`src/agents/compaction.ts`](src/agents/compaction.ts:1) — `generateSummary`, `estimateTokens`, `ExtensionContext`
- [`src/agents/pi-tools.ts`](src/agents/pi-tools.ts:1) — `codingTools`, `createReadTool`, `readTool`
- [`src/agents/pi-tools.read.ts`](src/agents/pi-tools.read.ts:1) — `createEditTool`, `createReadTool`, `createWriteTool`
- [`src/agents/pi-project-settings.ts`](src/agents/pi-project-settings.ts:1) — `SettingsManager`
- [`src/agents/session-tool-result-guard.ts`](src/agents/session-tool-result-guard.ts:1) — `SessionManager`
- [`src/agents/session-tool-result-guard-wrapper.ts`](src/agents/session-tool-result-guard-wrapper.ts:1) — `SessionManager`
- [`src/agents/pi-embedded-subscribe.ts`](src/agents/pi-embedded-subscribe.ts:1) — `AgentMessage`
- [`src/agents/ollama-stream.ts`](src/agents/ollama-stream.ts:1) — `StreamFn`, `createAssistantMessageEventStream`
- [`src/agents/anthropic-payload-log.ts`](src/agents/anthropic-payload-log.ts:1) — `AgentMessage`, `StreamFn`, `Model<Api>`
- [`src/agents/skills/workspace.ts`](src/agents/skills/workspace.ts:1) — `loadSkillsFromDir`, `Skill`
- [`src/agents/skills/bundled-context.ts`](src/agents/skills/bundled-context.ts:1) — `loadSkillsFromDir`
- [`src/agents/pi-extensions/compaction-safeguard.ts`](src/agents/pi-extensions/compaction-safeguard.ts:1) — `ExtensionAPI`, `FileOperations`
- [`src/agents/pi-extensions/context-pruning/extension.ts`](src/agents/pi-extensions/context-pruning/extension.ts:1) — `ExtensionAPI`, `ExtensionContext`

**Auth path — types only, no execution change needed:**
- [`src/agents/auth-profiles/oauth.ts`](src/agents/auth-profiles/oauth.ts:1) — `OAuthCredentials`, `OAuthProvider` (pi-ai types)
- [`src/agents/auth-profiles/store.ts`](src/agents/auth-profiles/store.ts:1) — `OAuthCredentials`
- [`src/agents/auth-profiles/types.ts`](src/agents/auth-profiles/types.ts:1) — `OAuthCredentials`
- [`src/agents/cli-credentials.ts`](src/agents/cli-credentials.ts:1) — `OAuthCredentials`, `OAuthProvider`
- [`src/agents/chutes-oauth.ts`](src/agents/chutes-oauth.ts:1) — `OAuthCredentials`

---

## 4. Adapter Layer Design

### 4.1 New Module: `src/agents/mastra/`

```
src/agents/mastra/
  index.ts                      — public re-exports
  types.ts                      — internal shared types
  message-adapter.ts            — AgentMessage[] ↔ CoreMessage[]
  tool-adapter.ts               — AgentTool (TypeBox) → ToolAction (Zod/Mastra)
  model-config.ts               — OpenClaw ModelProviderConfig → MastraModelConfig (with @ai-sdk/anthropic branch)
  agent-runner.ts               — replaces createAgentSession + runEmbeddedAttempt inner loop
  mastra-event-feed.ts          — MastraEventFeed and MastraSessionEvent types [Blocker 1]
  subscribe-mastra-session.ts   — subscribeMastraSession() — new function replacing subscribeEmbeddedPiSession [Blocker 1]
  stream-subscriber.ts          — internal Mastra fullStream → MastraSessionEvent translator
  compaction.ts                 — full compaction with JSONL write-back [Blocker 4]
  session-manager-compat.ts     — thin SessionManager-compatible wrapper (reads/writes JSONL)
```

### 4.2 Message Adapter

`AgentMessage` (pi-agent-core) → `CoreMessage` (Vercel AI SDK):

```typescript
// src/agents/mastra/message-adapter.ts

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { CoreMessage } from "@mastra/core/llm";

export function toCoreMessages(messages: AgentMessage[]): CoreMessage[] {
  return messages.map((msg) => {
    if (msg.role === "user") {
      return { role: "user", content: normalizeUserContent(msg.content) };
    }
    if (msg.role === "assistant") {
      return { role: "assistant", content: normalizeAssistantContent(msg.content) };
    }
    if (msg.role === "tool") {
      return { role: "tool", content: normalizeToolContent(msg.content) };
    }
    // system messages are handled separately as agent instructions
    return { role: "user", content: String(msg.content) };
  });
}

export function fromCoreMessages(messages: CoreMessage[]): AgentMessage[] {
  // Reverse mapping for persisting Mastra responses back to JSONL session files
  // ...
}
```

### 4.3 Tool Adapter

OpenClaw tools use TypeBox schemas. Mastra tools use Zod schemas. The adapter converts:

```typescript
// src/agents/mastra/tool-adapter.ts

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { typeboxToZod } from "./typebox-to-zod.js";

export function adaptToolForMastra(tool: AgentTool): ReturnType<typeof createTool> {
  return createTool({
    id: tool.name,
    description: tool.description,
    inputSchema: typeboxToZod(tool.parameters),
    execute: async ({ context }) => {
      const result = await tool.execute(context);
      return typeof result === "string" ? result : JSON.stringify(result);
    },
  });
}
```

TypeBox → Zod conversion handles the common subset used by OpenClaw tools:
- `Type.Object` → `z.object`
- `Type.String` → `z.string`
- `Type.Number` → `z.number`
- `Type.Boolean` → `z.boolean`
- `Type.Array` → `z.array`
- `Type.Optional` → `.optional()`
- `Type.Union` → `z.union` (note: tool schemas avoid `anyOf` per AGENTS.md guardrails)

### 4.4 Model Config Adapter

Maps OpenClaw's `ModelProviderConfig` + `ModelApi` to Mastra's `MastraModelConfig`:

```typescript
// src/agents/mastra/model-config.ts

import { createAnthropic } from "@ai-sdk/anthropic";
import type { MastraModelConfig, OpenAICompatibleConfig } from "@mastra/core/llm";
import type { ModelApi } from "../../config/types.models.js";

// [Blocker 6] Anthropic uses a completely different wire format from OpenAI:
// - Different tool schema shape (input_schema vs function.parameters)
// - Different content block format (typed blocks vs strings)
// - Required anthropic-version header
// - Different streaming event format
// OpenAICompatibleConfig CANNOT be used for anthropic-messages.
export function toMastraModelConfig(params: {
  provider: string;
  modelId: string;
  modelApi: ModelApi;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}): MastraModelConfig {
  switch (params.modelApi) {
    case "anthropic-messages": {
      // Must use @ai-sdk/anthropic — NOT OpenAICompatibleConfig.
      // For standard API keys (sk-ant-api03-*): pass as apiKey (sent as x-api-key).
      // For OAuth tokens (sk-ant-oat-*): pass via headers as Authorization: Bearer.
      const isOAuthToken = params.apiKey?.startsWith("sk-ant-oat-");
      const provider = createAnthropic({
        apiKey: isOAuthToken ? undefined : params.apiKey,
        baseURL: params.baseUrl,
        headers: isOAuthToken
          ? {
              "Authorization": `Bearer ${params.apiKey}`,
              "anthropic-version": "2023-06-01",
              ...params.headers,
            }
          : params.headers,
      });
      return provider(params.modelId);
    }

    case "openai-completions":
    case "openai-responses":
    case "openai-codex-responses":
    case "ollama":
    case "github-copilot": {
      // These are genuinely OpenAI-compatible
      const config: OpenAICompatibleConfig = {
        id: `${params.provider}/${params.modelId}`,
        url: resolveProviderBaseUrl(params.modelApi, params.baseUrl),
        apiKey: params.apiKey,
        headers: params.headers,
      };
      return config;
    }

    case "google-generative-ai": {
      // @ai-sdk/google handles Google OAuth and API key auth
      const { google } = await import("@ai-sdk/google");
      return google(params.modelId);
    }

    case "bedrock-converse-stream": {
      // @ai-sdk/amazon-bedrock handles AWS SigV4 signing
      const { bedrock } = await import("@ai-sdk/amazon-bedrock");
      return bedrock(params.modelId);
    }

    default: {
      // Fallback for unknown providers: attempt OpenAI-compatible
      const config: OpenAICompatibleConfig = {
        id: `${params.provider}/${params.modelId}`,
        url: params.baseUrl,
        apiKey: params.apiKey,
        headers: params.headers,
      };
      return config;
    }
  }
}

function resolveProviderBaseUrl(api: ModelApi, customBaseUrl?: string): string | undefined {
  if (customBaseUrl) return customBaseUrl;
  switch (api) {
    case "openai-completions":
    case "openai-responses":
    case "openai-codex-responses": return "https://api.openai.com/v1";
    case "ollama": return "http://localhost:11434/v1";
    case "github-copilot": return "https://api.githubcopilot.com";
    default: return undefined;
  }
}
```

**Important:** Anthropic's API is **not** OpenAI-compatible. The wire format differs in tool schema shape, content block format, required headers, and streaming event format. `@ai-sdk/anthropic` must be used for `anthropic-messages`. For providers that need native SDK support (Bedrock with AWS SigV4, Google OAuth), we use the corresponding `@ai-sdk/*` package directly as a `LanguageModelV1`. For genuinely OpenAI-compatible providers (OpenAI, Ollama, GitHub Copilot, OpenRouter), `OpenAICompatibleConfig` is sufficient.

### 4.5 Agent Runner

The core replacement for `createAgentSession` + the inner agent loop in `runEmbeddedAttempt`:

```typescript
// src/agents/mastra/agent-runner.ts

import { Agent } from "@mastra/core/agent";
import type { CoreMessage } from "@mastra/core/llm";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { toCoreMessages, fromCoreMessages } from "./message-adapter.js";
import { adaptToolForMastra } from "./tool-adapter.js";
import { toMastraModelConfig } from "./model-config.js";

export async function runMastraAgent(params: {
  provider: string;
  modelId: string;
  modelApi: ModelApi;
  baseUrl?: string;
  // [Blocker 3] apiKey must be resolved via resolveModelAuthMode() + getApiKeyForModel()
  // BEFORE calling runMastraAgent. The caller (attempt.ts) is responsible for auth resolution.
  // Do NOT pass Model<Api> here — extract the resolved apiKey and headers first.
  apiKey?: string;
  headers?: Record<string, string>;
  systemPrompt: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  thinkLevel?: ThinkLevel;
  config?: OpenClawConfig;
  signal?: AbortSignal;
}): Promise<MastraRunResult> {
  // [Blocker 5] Validate unsupported extension modes before starting
  const compactionMode = params.config?.agents?.defaults?.compaction?.mode;
  const contextPruningMode = params.config?.agents?.defaults?.contextPruning?.mode;
  if (compactionMode === "safeguard") {
    throw new ConfigurationError(
      "agents.defaults.compaction.mode = 'safeguard' is not supported with gateway = 'mastra'. " +
      "Use gateway = 'pi' for compaction safeguard support, or set compaction.mode = 'default'."
    );
  }
  if (contextPruningMode === "cache-ttl") {
    throw new ConfigurationError(
      "agents.defaults.contextPruning.mode = 'cache-ttl' is not supported with gateway = 'mastra'."
    );
  }

  const mastraTools = Object.fromEntries(
    params.tools.map((t) => [t.name, adaptToolForMastra(t)])
  );

  const agent = new Agent({
    id: `openclaw-${params.provider}-${params.modelId}`,
    name: "OpenClaw Agent",
    instructions: params.systemPrompt,
    model: toMastraModelConfig({
      provider: params.provider,
      modelId: params.modelId,
      modelApi: params.modelApi,
      baseUrl: params.baseUrl,
      apiKey: params.apiKey,
      headers: params.headers,
    }),
    tools: mastraTools,
  });

  const coreMessages = toCoreMessages(params.messages);

  // [Blocker 7] maxSteps: pi path has no hard step limit. Use 200 as a safety ceiling.
  // Most agents finish in <50 steps; complex refactoring tasks can exceed 100.
  // Document: gateway = "mastra" will truncate agents that exceed maxSteps.
  // For agents requiring unlimited tool call loops, use gateway = "pi" until
  // Mastra-native compaction is implemented (Phase 2).
  const output = await agent.stream(coreMessages, {
    maxSteps: params.config?.agents?.defaults?.maxSteps ?? 200,
    providerOptions: toMastraProviderOptions(params.thinkLevel, params.provider),
  });

  // Emit events via subscribeMastraSession (see subscribe-mastra-session.ts)
  // The fullStream is passed to subscribeMastraSession, not consumed inline here.
  return { stream: output };
}
```

### 4.6 Session Manager Compatibility

The existing `SessionManager` from pi-coding-agent reads/writes JSONL files. The Mastra path **keeps the same JSONL files** — no migration needed. The `session-manager-compat.ts` module wraps the existing JSONL read/write logic (already in `src/agents/pi-embedded-runner/session-manager-init.ts` and related files) to provide the same interface to the Mastra runner.

This means:
- Session files remain at `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
- Format is unchanged
- The Mastra runner reads history from JSONL, converts to `CoreMessage[]`, runs the agent, then writes the new messages back to JSONL

### 4.7 Compaction Adapter

The current compaction uses `generateSummary` from pi-coding-agent. The Mastra adapter uses `agent.generate()`.

**[Blocker 4]** The plan must specify the full compaction path, not just `mastraGenerateSummary`. Compaction requires:
1. Generating the summary text via `agent.generate()`
2. Determining `firstKeptMessageIndex` — the index of the first message to keep after compaction
3. Acquiring the session write lock before modifying the JSONL file
4. Writing the compacted messages back to the JSONL session file atomically
5. Releasing the write lock

```typescript
// src/agents/mastra/compaction.ts

export async function mastraCompact(params: {
  sessionId: string;
  sessionFilePath: string;
  messages: AgentMessage[];
  model: MastraModelConfig;
  compactionPrompt: string;
  sessionWriteLock: SessionWriteLock;  // same lock used by pi path
}): Promise<{ compactedMessages: AgentMessage[]; summaryText: string }> {
  // Step 1: Generate summary using agent.generate() (non-streaming)
  const agent = new Agent({
    id: "openclaw-compaction",
    name: "Compaction Agent",
    instructions: params.compactionPrompt,
    model: params.model,
    tools: {},
  });
  const result = await agent.generate(toCoreMessages(params.messages));
  const summaryText = result.text;

  // Step 2: Determine firstKeptMessageIndex
  // Keep the last N messages that fit within the context window after compaction.
  // This mirrors the pi path's compaction logic in compact.ts.
  const firstKeptMessageIndex = resolveFirstKeptMessageIndex(params.messages);

  // Step 3: Build compacted message list
  // [summary as user message] + [kept messages from firstKeptMessageIndex onward]
  const summaryMessage: AgentMessage = {
    role: "user",
    content: `[Conversation summary]\n${summaryText}`,
  };
  const keptMessages = params.messages.slice(firstKeptMessageIndex);
  const compactedMessages = [summaryMessage, ...keptMessages];

  // Step 4: Acquire write lock and write back to JSONL
  await params.sessionWriteLock.withLock(async () => {
    await writeSessionMessagesToJsonl(params.sessionFilePath, compactedMessages);
  });

  return { compactedMessages, summaryText };
}

export function mastraEstimateTokens(text: string): number {
  // Simple character-based estimate: ~4 chars per token (GPT-4 average)
  // Mastra's js-tiktoken dependency can be used for precise counting if needed
  return Math.ceil(text.length / 4);
}
```

**Note:** `resolveFirstKeptMessageIndex` and `writeSessionMessagesToJsonl` are shared utilities from `src/agents/pi-embedded-runner/` — the Mastra compaction path reuses the same JSONL write logic as the pi path to ensure format consistency.

---

## 5. Provider Support Matrix

All 8 `ModelApi` values in [`src/config/types.models.ts`](src/config/types.models.ts:3) are supported:

| `ModelApi` | Mastra approach | Notes |
|---|---|---|
| `anthropic-messages` | `@ai-sdk/anthropic` `LanguageModelV1` | **NOT OpenAI-compatible** — different wire format, tool schema, content blocks, required headers [Blocker 6] |
| `openai-completions` | `OpenAICompatibleConfig` | Direct OpenAI endpoint |
| `openai-responses` | `OpenAICompatibleConfig` | Responses API endpoint |
| `openai-codex-responses` | `OpenAICompatibleConfig` | Codex endpoint |
| `google-generative-ai` | `@ai-sdk/google` `LanguageModelV1` | Google requires native SDK for auth |
| `bedrock-converse-stream` | `@ai-sdk/amazon-bedrock` `LanguageModelV1` | AWS SigV4 requires native SDK |
| `ollama` | `OpenAICompatibleConfig` with Ollama base URL | Ollama exposes OpenAI-compatible API |
| `github-copilot` | `OpenAICompatibleConfig` with Copilot base URL | Token-based auth via headers |

**New dependencies required:**
- `@mastra/core` — core framework (already has `@ai-sdk/provider-v5` and `@ai-sdk/provider-v6` bundled)
- `@ai-sdk/anthropic` — for Anthropic (native wire format required — NOT OpenAI-compatible) [Blocker 6]
- `@ai-sdk/google` — for Google Generative AI (native auth)
- `@ai-sdk/amazon-bedrock` — for Bedrock (AWS SigV4)
- `ai` — Vercel AI SDK core (peer dep of `@mastra/core`)

**No new dependencies needed for:** OpenAI, Ollama, GitHub Copilot, OpenRouter, and other genuinely OpenAI-compatible providers.

---

## 6. Feature Flag and Wiring

### 6.1 Config Schema Change

Add `agents.gateway` to the config:

```typescript
// src/config/types.agents.ts (addition)
gateway?: "pi" | "mastra";
```

Default: `"pi"` (no behavior change for existing users).

### 6.2 Wiring in `runEmbeddedAttempt`

The flag is checked in [`src/agents/pi-embedded-runner/run/attempt.ts`](src/agents/pi-embedded-runner/run/attempt.ts:711):

```typescript
// In runEmbeddedAttempt, after model resolution:
const usesMastra = params.config?.agents?.defaults?.gateway === "mastra";

if (usesMastra) {
  // [Blocker 3] Auth must be resolved BEFORE calling runMastraAgent.
  // resolveModelAuthMode() + getApiKeyForModel() extract the apiKey and headers
  // from the Model<Api> object. Do NOT pass Model<Api> to runMastraAgent.
  const authMode = resolveModelAuthMode(params.model);
  const { apiKey, headers } = await getApiKeyForModel(params.model, authMode);

  // [Blocker 2] lastAssistant must be constructed from Mastra output, not from AgentSession.
  // buildLastAssistantFromMastra() converts the final CoreMessage[] from the Mastra run
  // into the AssistantMessage shape expected by the rest of the pi-embedded-runner.
  const mastraResult = await runMastraAgent({
    ...params,
    apiKey,
    headers,
  });
  const lastAssistant = buildLastAssistantFromMastra(mastraResult);
  return { lastAssistant, ...mastraResult };
} else {
  // existing pi-coding-agent path unchanged
  ({ session } = await createAgentSession({ ... }));
  // ...
}
```

**[Blocker 1]** `subscribeEmbeddedPiSession` **cannot** be reused for the Mastra path. It calls `params.session.subscribe(handler)` directly on an `AgentSession` object from pi-coding-agent, and uses `session.isCompacting`, `session.abortCompaction()`, `session.steer()`, `session.prompt()`, `session.abort()`, `session.dispose()`, and `session.agent.replaceMessages()`. None of these exist on a Mastra agent.

Instead, `subscribeMastraSession()` in `src/agents/mastra/subscribe-mastra-session.ts` provides the same output contract (same `assistantTexts`, `toolMetas`, compaction events) by consuming the Mastra `fullStream` via `MastraEventFeed`.

---

## 7. Thinking / Reasoning Support

OpenClaw has deep `thinkLevel` support across providers. Mastra exposes `providerOptions` in `AgentStreamOptions`:

```typescript
const output = await agent.stream(messages, {
  providerOptions: {
    anthropic: { thinking: { type: "enabled", budgetTokens: 8000 } },
    // OR for OpenAI:
    openai: { reasoningEffort: "high" },
  },
});
```

The `toMastraStreamOptions` helper in `src/agents/mastra/model-config.ts` maps OpenClaw's `ThinkLevel` to the correct `providerOptions` shape per provider.

---

## 8. Streaming Event Compatibility

**[Blocker 1 — CORRECTED]** `subscribeEmbeddedPiSession` in [`src/agents/pi-embedded-subscribe.ts`](src/agents/pi-embedded-subscribe.ts:1) **cannot be reused** for the Mastra path. It directly calls `params.session.subscribe(handler)` on an `AgentSession` object from pi-coding-agent, and uses 11 members of `AgentSession` that do not exist on a Mastra agent (`isCompacting`, `abortCompaction()`, `steer()`, `prompt()`, `abort()`, `dispose()`, `agent.replaceMessages()`, etc.).

Instead, a new `subscribeMastraSession()` function in `src/agents/mastra/subscribe-mastra-session.ts` provides the **same output contract** as `subscribeEmbeddedPiSession` by consuming the Mastra `fullStream` via `MastraEventFeed`:

The `stream-subscriber.ts` module translates Mastra's `fullStream` chunks into `MastraSessionEvent` objects:

| Mastra chunk type | MastraSessionEvent equivalent |
|---|---|
| `text-delta` | `{ type: "text", text: delta }` |
| `tool-call` | `{ type: "toolCall", name, input }` |
| `tool-result` | `{ type: "toolResult", name, result }` |
| `finish` | `{ type: "finish", finishReason, usage }` |
| `error` | `{ type: "error", error }` |

`subscribeMastraSession()` consumes `MastraSessionEvent` objects and produces the same `assistantTexts`, `toolMetas`, and compaction events as `subscribeEmbeddedPiSession`. All downstream consumers (Telegram, Discord, Slack, etc.) are **unchanged** — they call `subscribeMastraSession` instead of `subscribeEmbeddedPiSession` when `gateway = "mastra"`.

---

## 9. Files Changed

### 9.1 New Files

| File | Purpose |
|---|---|
| `src/agents/mastra/index.ts` | Public re-exports |
| `src/agents/mastra/types.ts` | Internal types |
| `src/agents/mastra/message-adapter.ts` | `AgentMessage[]` ↔ `CoreMessage[]` |
| `src/agents/mastra/tool-adapter.ts` | `AgentTool` → Mastra `ToolAction` |
| `src/agents/mastra/typebox-to-zod.ts` | TypeBox schema → Zod schema converter |
| `src/agents/mastra/model-config.ts` | `ModelProviderConfig` → `MastraModelConfig` (with `@ai-sdk/anthropic` branch) |
| `src/agents/mastra/agent-runner.ts` | Main Mastra execution loop |
| `src/agents/mastra/mastra-event-feed.ts` | `MastraEventFeed` and `MastraSessionEvent` types [Blocker 1] |
| `src/agents/mastra/subscribe-mastra-session.ts` | `subscribeMastraSession()` — replaces `subscribeEmbeddedPiSession` for Mastra path [Blocker 1] |
| `src/agents/mastra/stream-subscriber.ts` | Internal Mastra `fullStream` → `MastraSessionEvent` translator |
| `src/agents/mastra/compaction.ts` | `mastraCompact()` with full JSONL write-back [Blocker 4] |
| `src/agents/mastra/session-manager-compat.ts` | JSONL read/write wrapper for Mastra path |
| `src/agents/mastra/message-adapter.test.ts` | Unit tests |
| `src/agents/mastra/tool-adapter.test.ts` | Unit tests |
| `src/agents/mastra/typebox-to-zod.test.ts` | Unit tests |
| `src/agents/mastra/model-config.test.ts` | Unit tests |
| `src/agents/mastra/agent-runner.test.ts` | Integration tests (mocked provider) |
| `src/agents/mastra/subscribe-mastra-session.test.ts` | Unit tests: text streaming, tool calls, compaction events, abort, messaging tool tracking [Blocker 1] |

### 9.2 Modified Files

| File | Change |
|---|---|
| [`src/agents/pi-embedded-runner/run/attempt.ts`](src/agents/pi-embedded-runner/run/attempt.ts:711) | Add `if (usesMastra)` branch; resolve auth via `resolveModelAuthMode` + `getApiKeyForModel` before calling `runMastraAgent`; add config validation for unsupported extension modes [Blockers 2, 3, 5] |
| [`src/agents/pi-embedded-runner/run/types.ts`](src/agents/pi-embedded-runner/run/types.ts:1) | Add `buildLastAssistantFromMastra()` — constructs `AssistantMessage` from Mastra `CoreMessage[]` output [Blocker 2] |
| [`src/agents/pi-embedded-runner/compact.ts`](src/agents/pi-embedded-runner/compact.ts:572) | Add Mastra branch for compaction using `mastraCompact()` (full JSONL write-back) [Blocker 4] |
| [`src/config/types.agents.ts`](src/config/types.agents.ts:1) | Add `gateway?: "pi" \| "mastra"` |
| [`src/config/zod-schema.agent-defaults.ts`](src/config/zod-schema.agent-defaults.ts:1) | Add Zod validation for `gateway` |
| [`src/config/schema.ts`](src/config/schema.ts:1) | Add schema help text for `agents.defaults.gateway` |
| `package.json` | Add `@mastra/core`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/amazon-bedrock`, `ai` [Blocker 6] |

### 9.3 Unchanged Files

Everything else: all channel files, routing, CLI, gateway HTTP/WS server, session key management, auth profiles, TUI, extensions, plugins.

---

## 10. Dependency Changes

### 10.1 New Dependencies

```json
{
  "@mastra/core": "1.8.0",
  "@ai-sdk/anthropic": "^1.2.0",
  "@ai-sdk/google": "^1.2.0",
  "@ai-sdk/amazon-bedrock": "^1.2.0",
  "ai": "^4.3.0"
}
```

> Per AGENTS.md: `@mastra/core` must use exact version `1.8.0` since it will be in `pnpm.patchedDependencies` if any patches are needed. `@ai-sdk/anthropic`, `@ai-sdk/google`, and `@ai-sdk/amazon-bedrock` can use `^` since they are not patched.
>
> **[Blocker 6]** `@ai-sdk/anthropic` is required because Anthropic's API is NOT OpenAI-compatible. The wire format differs in tool schema shape, content block format, required headers (`anthropic-version`), and streaming event format. `OpenAICompatibleConfig` will return HTTP 400 errors when used with `api.anthropic.com`.

### 10.2 Removed Dependencies (Phase 2 — after parity confirmed)

```json
{
  "@mariozechner/pi-agent-core": "removed",
  "@mariozechner/pi-ai": "removed",
  "@mariozechner/pi-coding-agent": "removed"
}
```

> `@mariozechner/pi-tui` is used by the TUI — **not removed in this PR**.

---

## 11. Migration Strategy

### Phase 1 — Adapter Layer (this PR)

1. Add Mastra dependencies
2. Create `src/agents/mastra/` adapter modules
3. Add `agents.gateway` config flag (default: `"pi"`)
4. Wire flag in `runEmbeddedAttempt` and `compact.ts`
5. Write unit + integration tests
6. All existing tests pass (gateway = "pi" default)

### Phase 2 — Parity Validation

1. Enable `gateway = "mastra"` in CI live-test environment
2. Run `pnpm test:live` against Anthropic, OpenAI, Google, Bedrock, Ollama
3. Fix any gaps found

### Phase 3 — Flip Default

1. Change default `agents.gateway` to `"mastra"`
2. Keep `"pi"` as deprecated fallback
3. Update CHANGELOG

### Phase 4 — Remove pi Stack

1. Remove `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`
2. Delete pi-specific adapter code
3. Remove `gateway = "pi"` option

---

## 12. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Mastra `fullStream` event shape differs from pi-agent-core `AgentEvent` | High | High | `subscribeMastraSession()` + `MastraEventFeed` provide same output contract [Blocker 1] |
| TypeBox → Zod conversion loses schema fidelity for complex tool schemas | Medium | Medium | Comprehensive unit tests; fallback to `z.unknown()` for unsupported types |
| Anthropic API not OpenAI-compatible — wire format, tool schema, headers differ | **High** | **High** | Use `@ai-sdk/anthropic` for `anthropic-messages`; detect OAuth tokens by `sk-ant-oat-*` prefix [Blocker 6] |
| Google/Bedrock native auth not supported via `OpenAICompatibleConfig` | High | High | Use `@ai-sdk/google` / `@ai-sdk/amazon-bedrock` for these providers (already in plan) |
| `thinkLevel` / extended thinking not exposed via `OpenAICompatibleConfig` | Medium | Medium | Use `providerOptions` in `AgentStreamOptions`; map per-provider in `toMastraStreamOptions` |
| `lastAssistant` type mismatch — Mastra returns `CoreMessage[]` not `AssistantMessage` | High | High | `buildLastAssistantFromMastra()` constructs `AssistantMessage` from Mastra output [Blocker 2] |
| Auth resolution broken — `Model<Api>` not passed to `runMastraAgent` | High | High | Resolve auth via `resolveModelAuthMode()` + `getApiKeyForModel()` before calling `runMastraAgent` [Blocker 3] |
| Compaction incomplete — JSONL write-back missing | High | High | `mastraCompact()` acquires write lock and writes back to JSONL atomically [Blocker 4] |
| `compaction.mode = "safeguard"` silently broken in Mastra path | High | Medium | Throw `ConfigurationError` for unsupported extension modes [Blocker 5] |
| `maxSteps: 50` truncates long-running agents silently | High | High | Default `maxSteps: 200`; document behavioral difference in CHANGELOG [Blocker 7] |
| Mastra v1.8.0 has breaking changes in a future patch | Low | Low | Pin exact version `1.8.0`; upgrade deliberately |
| Session JSONL files become inconsistent if Mastra path crashes mid-write | Low | Medium | Wrap JSONL writes in the same atomic write pattern used by pi-coding-agent |

---

## 13. Implementation Sequence (22 Steps)

```
Phase 1 — Adapter Layer
  1.  Add @mastra/core@1.8.0, @ai-sdk/anthropic, @ai-sdk/google, @ai-sdk/amazon-bedrock, ai to package.json [Blocker 6]
  2.  Create src/agents/mastra/types.ts
  3.  Create src/agents/mastra/typebox-to-zod.ts + unit tests
  4.  Create src/agents/mastra/message-adapter.ts + unit tests
  5.  Create src/agents/mastra/tool-adapter.ts + unit tests
  6.  Create src/agents/mastra/model-config.ts + unit tests (including @ai-sdk/anthropic branch and OAuth token detection) [Blocker 6]
  7.  Create src/agents/mastra/stream-subscriber.ts (internal fullStream → MastraSessionEvent translator)
  7a. Create src/agents/mastra/mastra-event-feed.ts — MastraEventFeed and MastraSessionEvent types [Blocker 1]
  7b. Create src/agents/mastra/subscribe-mastra-session.ts — full subscribeMastraSession() implementation [Blocker 1]
  7c. Write unit tests for subscribeMastraSession() covering: text streaming, tool calls, compaction events, abort, messaging tool tracking [Blocker 1]
  8.  Create src/agents/mastra/session-manager-compat.ts
  9.  Create src/agents/mastra/compaction.ts + unit tests [Blocker 4]
  9a. Specify compaction prompt format and firstKeptMessageIndex resolution logic [Blocker 4]
  9b. Specify JSONL write-back after mastraCompact() returns [Blocker 4]
  9c. Verify session write lock is acquired/released in Mastra compaction branch [Blocker 4]
  10. Create src/agents/mastra/agent-runner.ts + integration tests (mocked provider)
  11. Create src/agents/mastra/index.ts

Phase 2 — Config Schema
  12. Add agents.gateway to src/config/types.agents.ts
  13. Add Zod validation to src/config/zod-schema.agent-defaults.ts
  14. Add schema help text to src/config/schema.ts

Phase 3 — Wire the Flag
  15. Modify src/agents/pi-embedded-runner/run/attempt.ts — add Mastra branch with auth resolution and config validation [Blockers 2, 3, 5]
  15a. Add buildLastAssistantFromMastra() to src/agents/pi-embedded-runner/run/types.ts [Blocker 2]
  15b. Add config validation in attempt.ts Mastra branch: error on compaction.mode = "safeguard" and contextPruning.mode = "cache-ttl" [Blocker 5]
  16. Modify src/agents/pi-embedded-runner/compact.ts — add Mastra compaction branch using mastraCompact() [Blocker 4]

Phase 4 — Validate
  17. pnpm test — all existing tests pass (gateway = "pi" default)
  18. pnpm test with gateway = "mastra" — new adapter tests pass
  19. pnpm build — no TypeScript errors
  20. pnpm check — lint/format clean

Phase 5 — PR
  21. Update CHANGELOG.md (document maxSteps behavioral difference vs pi path) [Blocker 7]
  22. Update PR description with test results
```

---

## 14. Architecture Diagram

```mermaid
graph TD
    A[Channel Message] --> B[gateway/server-methods/chat.ts]
    B --> C[pi-embedded-runner/run.ts]
    C --> D[pi-embedded-runner/run/attempt.ts]
    D --> E{agents.gateway config}
    E -->|pi - current default| F[pi-coding-agent createAgentSession]
    E -->|mastra - new| G[mastra/agent-runner.ts runMastraAgent]
    F --> H[subscribeEmbeddedPiSession - uses AgentSession directly]
    G --> I[Auth resolution via resolveModelAuthMode + getApiKeyForModel]
    I --> J{modelApi}
    J -->|anthropic-messages| K[@ai-sdk/anthropic LanguageModelV1 - Blocker 6]
    J -->|openai-compatible| L[OpenAICompatibleConfig]
    J -->|google-generative-ai| M[@ai-sdk/google LanguageModelV1]
    J -->|bedrock-converse-stream| N[@ai-sdk/amazon-bedrock LanguageModelV1]
    G --> O[mastra/subscribe-mastra-session.ts subscribeMastraSession - NEW - Blocker 1]
    H --> P[assistantTexts + toolMetas + compaction]
    O --> P
    P --> Q[Channel delivery - unchanged]
    D --> R[JSONL session file - SessionManager]
    G --> S[JSONL session file - mastraCompact writes back - Blocker 4]
    G --> T{compaction.mode}
    T -->|safeguard| U[ConfigurationError - not supported in Mastra path - Blocker 5]
    T -->|default| V[maxSteps ceiling 200 - document behavioral difference - Blocker 7]
```

---

## 15. Resolved Implementation Details

These were potential open questions; all three are resolved by inspecting the Mastra v1.8.0 package source directly.

### 15.1 Anthropic OAuth tokens (`sk-ant-oat-*`) — **`@ai-sdk/anthropic` required regardless of token type**

**[Blocker 6 — CORRECTED]** The previous analysis was partially correct about the auth header but wrong about the wire format.

`OpenAICompatibleConfig` does send `Authorization: Bearer <apiKey>` which is correct for OAuth tokens. However, Anthropic's API uses a completely different wire format from OpenAI:

| Aspect | OpenAI format | Anthropic format |
|---|---|---|
| Tool schema | `{ type: "function", function: { name, parameters } }` | `{ name, description, input_schema }` |
| Tool call in response | `{ tool_calls: [{ function: { name, arguments: string } }] }` | `{ content: [{ type: "tool_use", name, input: object }] }` |
| Tool result | `{ role: "tool", tool_call_id, content: string }` | `{ role: "user", content: [{ type: "tool_result", tool_use_id }] }` |
| Required headers | `Authorization: Bearer` | `x-api-key` AND `anthropic-version: 2023-06-01` |
| Streaming | `data: {"choices": [{"delta": {"content": "..."}}]}` | `data: {"type": "content_block_delta", ...}` |

Sending OpenAI-format requests to `api.anthropic.com/v1/messages` returns HTTP 400 errors. **`@ai-sdk/anthropic` is required for `anthropic-messages`** regardless of whether the token is a standard API key or an OAuth token.

For OAuth tokens (`sk-ant-oat-*`), `@ai-sdk/anthropic` v1.x supports Bearer auth via the `headers` option:

```typescript
const provider = createAnthropic({
  headers: {
    "Authorization": `Bearer ${oauthToken}`,
    "anthropic-version": "2023-06-01",
  },
});
```

The `model-config.ts` detects OAuth tokens by the `sk-ant-oat-*` prefix and switches to Bearer auth automatically.

### 15.2 Partial tool result streaming — **Supported natively**

Verified from `stream/types.d.ts`: Mastra's `fullStream` emits these tool-related chunk types:

```
tool-call-input-streaming-start  — tool call begins, args streaming starts
tool-call-delta                  — partial tool call args delta
tool-call-input-streaming-end    — tool call args complete
tool-call                        — final tool call (name + complete args)
tool-result                      — final tool result (after execution)
```

Tool call input streaming is supported. Tool results are emitted as final (not partial) — same behavior as pi-agent-core. This is a feature that works out of the box, not a dependency to add.

### 15.3 `maxSteps` default — **A required configuration with behavioral difference from pi path**

**[Blocker 7 — CORRECTED]** Verified from Mastra source: `maxSteps` defaults to `5`. The current pi-coding-agent loop runs until the model stops calling tools (no hard limit). **The adapter must set `maxSteps` explicitly** to avoid cutting off tool loops prematurely.

The default of `50` is **insufficient** for complex tasks. The pi path has no hard step limit — agents doing large codebase refactoring can exceed 100 tool calls. `maxSteps: 50` would silently truncate these agents with no error indication.

```typescript
// In agent-runner.ts
const output = await agent.stream(coreMessages, {
  // 200 is a safety ceiling, not a target — most agents finish in <50 steps
  // but complex refactoring tasks can exceed 100. The pi path has no equivalent limit.
  maxSteps: params.config?.agents?.defaults?.maxSteps ?? 200,
  providerOptions: toMastraProviderOptions(params.thinkLevel, params.provider),
});
```

**Behavioral difference that must be documented in CHANGELOG:**
> `gateway = "mastra"` with `maxSteps` set to any finite value will truncate agents that exceed that step count. The pi path has no equivalent limit. For agents that require unlimited tool call loops (e.g., large codebase refactoring), use `gateway = "pi"` until Mastra-native compaction is implemented (Phase 2).

Configurable via `agents.defaults.maxSteps` in the OpenClaw config (field already exists).

---

## 16. References

- [Mastra v1.8.0 on npm](https://www.npmjs.com/package/@mastra/core/v/1.8.0)
- [Mastra documentation](https://mastra.ai/docs)
- [Vercel AI SDK CoreMessage types](https://sdk.vercel.ai/docs/reference/ai-sdk-core/core-message)
- [`src/agents/pi-embedded-runner/run/attempt.ts`](src/agents/pi-embedded-runner/run/attempt.ts) — current agent loop
- [`src/config/types.models.ts`](src/config/types.models.ts) — ModelApi enum
- [`src/agents/pi-embedded-subscribe.ts`](src/agents/pi-embedded-subscribe.ts) — stream consumer (unchanged)
