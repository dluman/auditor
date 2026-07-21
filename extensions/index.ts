import { type ExtensionAPI, CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WriteOnlyKVStore } from "./store";

const EXTENSION_NAME = "my-pi-extension";

function sanitizeContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part: any) => {
    if (part && part.type === "image") {
      return { type: "image", placeholder: true, source: part.source?.type ?? "unknown" };
    }
    return part;
  });
}

function textFromMessage(message: any): string {
  const content = sanitizeContent(message?.content);
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .filter((part: any) => part?.type === "text")
    .map((part: any) => part.text)
    .join("\n");
}

export default function (pi: ExtensionAPI) {
  const store = WriteOnlyKVStore.defaultFor();
  let sequence = 0;
  let currentGroup: Array<{ key: string; timestamp: string; value: { type: string; data: unknown } }> = [];

  async function flushGroup() {
    if (currentGroup.length === 0) return;
    try {
      await store.write(currentGroup);
    } catch (error) {
      // Write-only store failures must not interrupt the agent.
      console.error(`[${EXTENSION_NAME}] failed to write log group:`, error);
    }
    currentGroup = [];
  }

  async function log(type: string, data: unknown) {
    sequence++;
    const key = `${Date.now().toString(36)}-${sequence.toString(36).padStart(6, "0")}-${type}`;
    const entry = {
      key,
      timestamp: new Date().toISOString(),
      value: { type, data },
    };

    if (type === "agent_start") {
      if (currentGroup.length === 0) {
        currentGroup = [entry];
      } else {
        currentGroup.push(entry);
      }
    } else if (type === "agent_end") {
      currentGroup.push(entry);
      await flushGroup();
    } else {
      currentGroup.push(entry);
    }
  }

  // ── LLM interaction logging ────────────────────────────────────────────────

  pi.on("input", async (event) => {
    await log("input", {
      text: event.text,
      source: event.source,
      streamingBehavior: event.streamingBehavior,
    });
  });

  pi.on("agent_start", async () => {
    await log("agent_start", {});
  });

  pi.on("context", async (event) => {
    await log("context", {
      messageCount: event.messages.length,
      messages: event.messages.map((message: any) => ({
        role: message.role,
        text: textFromMessage(message),
      })),
    });
  });

  pi.on("before_provider_request", async (event) => {
    await log("before_provider_request", { payload: event.payload });
  });

  pi.on("after_provider_response", async (event) => {
    await log("after_provider_response", {
      status: event.status,
      headers: event.headers,
    });
  });

  pi.on("message_start", async (event) => {
    await log("message_start", {
      role: event.message.role,
      text: textFromMessage(event.message),
    });
  });

  pi.on("message_end", async (event) => {
    await log("message_end", {
      role: event.message.role,
      text: textFromMessage(event.message),
    });
  });

  pi.on("tool_execution_start", async (event) => {
    await log("tool_execution_start", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
    });
  });

  pi.on("tool_execution_end", async (event) => {
    await log("tool_execution_end", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: event.result,
      isError: event.isError,
    });
  });

  pi.on("agent_end", async (event) => {
    await log("agent_end", { messageCount: event.messages.length });
  });

  // ── Commands ───────────────────────────────────────────────────────────────

  pi.registerCommand("hello", {
    description: "Say hello from the extension",
    handler: async (args, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.notify(`Hello, ${args || "world"}!`, "info");
      }
    },
  });

  pi.registerCommand("log-path", {
    description: "Print the path of the write-only interaction log",
    handler: async (_args, ctx) => {
      const path = store.path;
      if (ctx.hasUI) {
        ctx.ui.notify(path, "info");
      }
      console.log(path);
    },
  });

  // ── Tools ──────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "greet",
    label: "Greet",
    description: "Greet someone by name",
    parameters: Type.Object({
      name: Type.String({ description: "Name to greet" }),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "create_patch_from_prompts",
    label: "Create Patch from Prompts",
    description: "Creates a JSON patch file containing recent session entries with timestamps, model names, and tool results.",
    parameters: Type.Object({
      filename: Type.String({ description: "The name of the patch file (e.g., conversation.json)" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const entries = ctx.sessionManager.getEntries();
      const patchData = entries
        .filter((entry: any) => entry.type === "message" && entry.message)
        .map((entry: any) => {
          const message = entry.message;
          const base = {
            id: entry.id,
            timestamp: entry.timestamp,
            role: message.role,
            text: textFromMessage(message),
          };

          if (message.role === "assistant") {
            return {
              ...base,
              model: message.model,
              provider: message.provider,
              api: message.api,
              stopReason: message.stopReason,
              usage: message.usage,
              errorMessage: message.errorMessage,
            };
          }

          if (message.role === "toolResult") {
            return {
              ...base,
              toolName: message.toolName,
              toolCallId: message.toolCallId,
              isError: message.isError,
              details: message.details,
            };
          }

          return base;
        });

      const patchContent = JSON.stringify(patchData, null, 2);
      const patchDir = join(ctx.cwd, CONFIG_DIR_NAME);
      const patchPath = join(patchDir, params.filename);

      await mkdir(patchDir, { recursive: true });
      await writeFile(patchPath, patchContent, "utf-8");

      return {
        content: [{ type: "text", text: `Successfully created patch file: ${patchPath}` }],
        details: {},
      };
    },
  });
}
