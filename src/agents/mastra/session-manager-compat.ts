/**
 * Session manager compatibility layer for the Mastra gateway path.
 *
 * The existing pi-coding-agent SessionManager reads/writes JSONL session files.
 * The Mastra path keeps the SAME JSONL files — no migration needed.
 *
 * This module provides helpers to:
 *   1. Read existing session history from JSONL files (using the existing pi SessionManager)
 *   2. Append new messages from a Mastra run back to the JSONL file
 *
 * This preserves full backward compatibility: sessions started on the pi path
 * can be continued on the Mastra path and vice versa.
 */

import type { CoreMessage } from "@mastra/core/llm";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { fromCoreMessage } from "./message-adapter.js";

const log = createSubsystemLogger("mastra/session-compat");

/**
 * Read existing session messages from a JSONL session file.
 * Returns the raw AgentMessage array from the pi SessionManager.
 */
export async function readSessionMessages(sessionFile: string): Promise<unknown[]> {
  try {
    // Dynamically import pi-coding-agent SessionManager to read the JSONL file.
    // This keeps the Mastra path compatible with existing session files.
    const { SessionManager } = await import("@mariozechner/pi-coding-agent");
    const sm = SessionManager.open(sessionFile);
    const branch = sm.getBranch();
    return branch.map((entry: { message?: unknown }) => entry.message).filter(Boolean);
  } catch (err) {
    // Session file doesn't exist yet — start fresh
    if ((err as { code?: string }).code === "ENOENT") {
      return [];
    }
    log.warn(`failed to read session file ${sessionFile}: ${String(err)}`);
    return [];
  }
}

/**
 * Append new messages from a Mastra run to the JSONL session file.
 * Converts CoreMessage[] back to AgentMessage format and appends via pi SessionManager.
 */
export async function appendMastraMessages(
  sessionFile: string,
  newMessages: CoreMessage[],
): Promise<void> {
  if (newMessages.length === 0) {
    return;
  }

  try {
    const { SessionManager } = await import("@mariozechner/pi-coding-agent");
    const sm = SessionManager.open(sessionFile);

    for (const coreMsg of newMessages) {
      const agentMsg = fromCoreMessage(coreMsg);
      if (!agentMsg) {
        continue;
      }
      try {
        sm.appendMessage(agentMsg as Parameters<typeof sm.appendMessage>[0]);
      } catch (appendErr) {
        log.warn(`failed to append message to session: ${String(appendErr)}`);
      }
    }
  } catch (err) {
    log.warn(`failed to open session file for append ${sessionFile}: ${String(err)}`);
  }
}
