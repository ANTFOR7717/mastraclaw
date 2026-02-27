# Plan: Power OpenClaw's LLM Gateway with Mastra

**Status:** Draft — awaiting review  
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
  index.ts                  — public re-exports
  types.ts                  — internal shared types
  message-adapter.ts        — AgentMessage[] ↔ CoreMessage[]
  tool-adapter.ts           — AgentTool (TypeBox) → ToolAction (Zod/Mastra)
  model-config.ts           — OpenClaw ModelProviderConfig → MastraModelConfig
  agent-runner.ts           — replaces createAgentSession + runEmbeddedAttempt inner loop
  stream-subscriber.ts      — replaces subscribeEmbeddedPiSession for Mastra streams
  compaction.ts             — replaces generateSummary / estimateTokens
  session-manager-compat.ts — thin SessionManager-compatible wrapper (reads/writes JSONL)
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

import type { MastraModelConfig, OpenAICompatibleConfig } from "@mastra/core/llm";
import type { ModelApi } from "../../config/types.models.js";

export function toMastraModelConfig(params: {
  provider: string;
  modelId: string;
  modelApi: ModelApi;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}): MastraModelConfig {
  // Use OpenAICompatibleConfig for all providers — Mastra routes via the url/apiKey
  // This avoids needing separate @ai-sdk/* packages for each provider.
  const config: OpenAICompatibleConfig = {
    id: `${params.provider}/${params.modelId}`,
    url: resolveProviderBaseUrl(params.modelApi, params.baseUrl),
    apiKey: params.apiKey,
    headers: params.headers,
  };
  return config;
}

function resolveProviderBaseUrl(api: ModelApi, customBaseUrl?: string): string | undefined {
  if (customBaseUrl) return customBaseUrl;
  switch (api) {
    case "anthropic-messages": return "https://api.anthropic.com/v1";
    case "openai-completions":
    case "openai-responses":
    case "openai-codex-responses": return "https://api.openai.com/v1";
    case "google-generative-ai": return "https://generativelanguage.googleapis.com/v1beta";
    case "bedrock-converse-stream": return undefined; // AWS SDK handles this
    case "ollama": return "http://localhost:11434/v1";
    case "github-copilot": return "https://api.githubcopilot.com";
    default: return undefined;
  }
}
```

**Important:** For providers that need native SDK support (Bedrock with AWS SigV4, Google OAuth), we use the corresponding `@ai-sdk/*` package directly as a `LanguageModelV1`. For OpenAI-compatible providers (Anthropic, OpenAI, Ollama, OpenRouter, etc.), `OpenAICompatibleConfig` is sufficient.

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
  apiKey?: string;
  systemPrompt: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  thinkLevel?: ThinkLevel;
  onTextDelta: (text: string) => void;
  onToolCall: (name: string, input: unknown) => void;
  onToolResult: (name: string, result: unknown) => void;
  onFinish: (result: MastraRunResult) => void;
  signal?: AbortSignal;
}): Promise<MastraRunResult> {
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
    }),
    tools: mastraTools,
  });

  const coreMessages = toCoreMessages(params.messages);
  const output = await agent.stream(coreMessages);

  // Consume the stream and emit events compatible with subscribeEmbeddedPiSession
  for await (const chunk of output.fullStream) {
    if (chunk.type === "text-delta") {
      params.onTextDelta(chunk.textDelta);
    } else if (chunk.type === "tool-call") {
      params.onToolCall(chunk.toolName, chunk.args);
    } else if (chunk.type === "tool-result") {
      params.onToolResult(chunk.toolName, chunk.result);
    }
  }

  const finalText = await output.text;
  const toolCalls = await output.toolCalls;
  const toolResults = await output.toolResults;

  return { text: finalText, toolCalls, toolResults };
}
```

### 4.6 Session Manager Compatibility

The existing `SessionManager` from pi-coding-agent reads/writes JSONL files. The Mastra path **keeps the same JSONL files** — no migration needed. The `session-manager-compat.ts` module wraps the existing JSONL read/write logic (already in `src/agents/pi-embedded-runner/session-manager-init.ts` and related files) to provide the same interface to the Mastra runner.

This means:
- Session files remain at `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
- Format is unchanged
- The Mastra runner reads history from JSONL, converts to `CoreMessage[]`, runs the agent, then writes the new messages back to JSONL

### 4.7 Compaction Adapter

The current compaction uses `generateSummary` from pi-coding-agent. The Mastra adapter uses `agent.generate()`:

```typescript
// src/agents/mastra/compaction.ts

export async function mastraGenerateSummary(params: {
  messages: AgentMessage[];
  model: MastraModelConfig;
  systemPrompt: string;
}): Promise<string> {
  const agent = new Agent({
    id: "openclaw-compaction",
    name: "Compaction Agent",
    instructions: params.systemPrompt,
    model: params.model,
    tools: {},
  });

  const result = await agent.generate(toCoreMessages(params.messages));
  return result.text;
}

export function mastraEstimateTokens(text: string): number {
  // Simple character-based estimate: ~4 chars per token (GPT-4 average)
  // Mastra's js-tiktoken dependency can be used for precise counting if needed
  return Math.ceil(text.length / 4);
}
```

---

## 5. Provider Support Matrix

All 8 `ModelApi` values in [`src/config/types.models.ts`](src/config/types.models.ts:3) are supported:

| `ModelApi` | Mastra approach | Notes |
|---|---|---|
| `anthropic-messages` | `OpenAICompatibleConfig` with Anthropic base URL | Anthropic API is OpenAI-compatible for basic calls |
| `openai-completions` | `OpenAICompatibleConfig` | Direct OpenAI endpoint |
| `openai-responses` | `OpenAICompatibleConfig` | Responses API endpoint |
| `openai-codex-responses` | `OpenAICompatibleConfig` | Codex endpoint |
| `google-generative-ai` | `@ai-sdk/google` `LanguageModelV1` | Google requires native SDK for auth |
| `bedrock-converse-stream` | `@ai-sdk/amazon-bedrock` `LanguageModelV1` | AWS SigV4 requires native SDK |
| `ollama` | `OpenAICompatibleConfig` with Ollama base URL | Ollama exposes OpenAI-compatible API |
| `github-copilot` | `OpenAICompatibleConfig` with Copilot base URL | Token-based auth via headers |

**New dependencies required:**
- `@mastra/core` — core framework (already has `@ai-sdk/provider-v5` and `@ai-sdk/provider-v6` bundled)
- `@ai-sdk/google` — for Google Generative AI (native auth)
- `@ai-sdk/amazon-bedrock` — for Bedrock (AWS SigV4)
- `ai` — Vercel AI SDK core (peer dep of `@mastra/core`)

**No new dependencies needed for:** Anthropic, OpenAI, Ollama, GitHub Copilot, OpenRouter, and any other OpenAI-compatible provider.

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
  return runMastraAgent({ ...params, onTextDelta, onToolCall, onToolResult, onFinish });
} else {
  // existing pi-coding-agent path unchanged
  ({ session } = await createAgentSession({ ... }));
  // ...
}
```

The Mastra path emits the same events as the pi path so `subscribeEmbeddedPiSession` and all downstream consumers work without changes.

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

The existing `subscribeEmbeddedPiSession` in [`src/agents/pi-embedded-subscribe.ts`](src/agents/pi-embedded-subscribe.ts:1) consumes a stream of `AgentEvent` objects from pi-agent-core. The Mastra stream emits `ChunkType` events from the Vercel AI SDK.

The `stream-subscriber.ts` adapter translates Mastra's `fullStream` chunks into the same `AgentEvent` shape:

| Mastra chunk type | pi-agent-core AgentEvent equivalent |
|---|---|
| `text-delta` | `{ type: "text", text: delta }` |
| `tool-call` | `{ type: "toolCall", name, input }` |
| `tool-result` | `{ type: "toolResult", name, result }` |
| `finish` | `{ type: "finish", finishReason, usage }` |
| `error` | `{ type: "error", error }` |

This means `subscribeEmbeddedPiSession` and all its callers (Telegram, Discord, Slack, etc.) are **unchanged**.

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
| `src/agents/mastra/model-config.ts` | `ModelProviderConfig` → `MastraModelConfig` |
| `src/agents/mastra/agent-runner.ts` | Main Mastra execution loop |
| `src/agents/mastra/stream-subscriber.ts` | Mastra stream → `AgentEvent` adapter |
| `src/agents/mastra/compaction.ts` | `mastraGenerateSummary`, `mastraEstimateTokens` |
| `src/agents/mastra/session-manager-compat.ts` | JSONL read/write wrapper for Mastra path |
| `src/agents/mastra/message-adapter.test.ts` | Unit tests |
| `src/agents/mastra/tool-adapter.test.ts` | Unit tests |
| `src/agents/mastra/typebox-to-zod.test.ts` | Unit tests |
| `src/agents/mastra/model-config.test.ts` | Unit tests |
| `src/agents/mastra/agent-runner.test.ts` | Integration tests (mocked provider) |

### 9.2 Modified Files

| File | Change |
|---|---|
| [`src/agents/pi-embedded-runner/run/attempt.ts`](src/agents/pi-embedded-runner/run/attempt.ts:711) | Add `if (usesMastra)` branch; import `runMastraAgent` |
| [`src/agents/pi-embedded-runner/compact.ts`](src/agents/pi-embedded-runner/compact.ts:572) | Add Mastra branch for compaction using `mastraGenerateSummary` |
| [`src/config/types.agents.ts`](src/config/types.agents.ts:1) | Add `gateway?: "pi" \| "mastra"` |
| [`src/config/zod-schema.agent-defaults.ts`](src/config/zod-schema.agent-defaults.ts:1) | Add Zod validation for `gateway` |
| [`src/config/schema.ts`](src/config/schema.ts:1) | Add schema help text for `agents.defaults.gateway` |
| `package.json` | Add `@mastra/core`, `@ai-sdk/google`, `@ai-sdk/amazon-bedrock`, `ai` |

### 9.3 Unchanged Files

Everything else: all channel files, routing, CLI, gateway HTTP/WS server, session key management, auth profiles, TUI, extensions, plugins.

---

## 10. Dependency Changes

### 10.1 New Dependencies

```json
{
  "@mastra/core": "1.8.0",
  "@ai-sdk/google": "^1.2.0",
  "@ai-sdk/amazon-bedrock": "^1.2.0",
  "ai": "^4.3.0"
}
```

> Per AGENTS.md: `@mastra/core` must use exact version `1.8.0` since it will be in `pnpm.patchedDependencies` if any patches are needed. `@ai-sdk/google` and `@ai-sdk/amazon-bedrock` can use `^` since they are not patched.

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
| Mastra `fullStream` event shape differs from pi-agent-core `AgentEvent` | High | High | `stream-subscriber.ts` adapter normalizes events; unit-tested |
| TypeBox → Zod conversion loses schema fidelity for complex tool schemas | Medium | Medium | Comprehensive unit tests; fallback to `z.unknown()` for unsupported types |
| Anthropic OAuth tokens (`sk-ant-oat-*`) not supported via `OpenAICompatibleConfig` | Medium | High | Use `@ai-sdk/anthropic` directly for OAuth token auth; detect token type in `model-config.ts` |
| Google/Bedrock native auth not supported via `OpenAICompatibleConfig` | High | High | Use `@ai-sdk/google` / `@ai-sdk/amazon-bedrock` for these providers (already in plan) |
| `thinkLevel` / extended thinking not exposed via `OpenAICompatibleConfig` | Medium | Medium | Use `providerOptions` in `AgentStreamOptions`; map per-provider in `toMastraStreamOptions` |
| Mastra v1.8.0 has breaking changes in a future patch | Low | Low | Pin exact version `1.8.0`; upgrade deliberately |
| Session JSONL files become inconsistent if Mastra path crashes mid-write | Low | Medium | Wrap JSONL writes in the same atomic write pattern used by pi-coding-agent |

---

## 13. Implementation Sequence (22 Steps)

```
Phase 1 — Adapter Layer
  1.  Add @mastra/core@1.8.0, @ai-sdk/google, @ai-sdk/amazon-bedrock, ai to package.json
  2.  Create src/agents/mastra/types.ts
  3.  Create src/agents/mastra/typebox-to-zod.ts + unit tests
  4.  Create src/agents/mastra/message-adapter.ts + unit tests
  5.  Create src/agents/mastra/tool-adapter.ts + unit tests
  6.  Create src/agents/mastra/model-config.ts + unit tests
  7.  Create src/agents/mastra/stream-subscriber.ts + unit tests
  8.  Create src/agents/mastra/session-manager-compat.ts
  9.  Create src/agents/mastra/compaction.ts + unit tests
  10. Create src/agents/mastra/agent-runner.ts + integration tests (mocked provider)
  11. Create src/agents/mastra/index.ts

Phase 2 — Config Schema
  12. Add agents.gateway to src/config/types.agents.ts
  13. Add Zod validation to src/config/zod-schema.agent-defaults.ts
  14. Add schema help text to src/config/schema.ts

Phase 3 — Wire the Flag
  15. Modify src/agents/pi-embedded-runner/run/attempt.ts — add Mastra branch
  16. Modify src/agents/pi-embedded-runner/compact.ts — add Mastra compaction branch

Phase 4 — Validate
  17. pnpm test — all existing tests pass (gateway = "pi" default)
  18. pnpm test with gateway = "mastra" — new adapter tests pass
  19. pnpm build — no TypeScript errors
  20. pnpm check — lint/format clean

Phase 5 — PR
  21. Update CHANGELOG.md
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
    F --> H[pi-ai streamSimple]
    G --> I[Mastra Agent.stream]
    H --> J[Provider API]
    I --> K[MastraModelConfig]
    K -->|OpenAI-compatible| L[OpenAICompatibleConfig → Provider API]
    K -->|Google| M[@ai-sdk/google → Google API]
    K -->|Bedrock| N[@ai-sdk/amazon-bedrock → AWS API]
    G --> O[mastra/stream-subscriber.ts]
    O --> P[AgentEvent stream - same as pi path]
    P --> Q[subscribeEmbeddedPiSession - unchanged]
    Q --> R[Channel delivery - unchanged]
    D --> S[JSONL session file - unchanged format]
    G --> S
```

---

## 15. Open Questions

1. **Anthropic OAuth tokens:** Does `OpenAICompatibleConfig` support `Authorization: Bearer sk-ant-oat-*` headers, or does Anthropic's OAuth flow require the native `@ai-sdk/anthropic` package? If the latter, add `@ai-sdk/anthropic` to the dependency list and use it when `apiKey` starts with `sk-ant-oat-`.

2. **Tool result streaming:** pi-agent-core supports streaming tool results (partial results during execution). Does Mastra's `fullStream` expose partial tool results, or only final results? If only final, the streaming UX for long-running tools may differ.

3. **`maxSteps` for tool loops:** The current pi-coding-agent loop runs until the model stops calling tools. Mastra's `agent.stream()` has a `maxSteps` option. What should the default be? (Suggested: 50, matching typical pi-coding-agent behavior.)

---

## 16. References

- [Mastra v1.8.0 on npm](https://www.npmjs.com/package/@mastra/core/v/1.8.0)
- [Mastra documentation](https://mastra.ai/docs)
- [Vercel AI SDK CoreMessage types](https://sdk.vercel.ai/docs/reference/ai-sdk-core/core-message)
- [`src/agents/pi-embedded-runner/run/attempt.ts`](src/agents/pi-embedded-runner/run/attempt.ts) — current agent loop
- [`src/config/types.models.ts`](src/config/types.models.ts) — ModelApi enum
- [`src/agents/pi-embedded-subscribe.ts`](src/agents/pi-embedded-subscribe.ts) — stream consumer (unchanged)
