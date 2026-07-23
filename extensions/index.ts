import {
  type ExtensionAPI,
  CONFIG_DIR_NAME,
  CURRENT_SESSION_VERSION,
  type SessionHeader,
  type SessionEntry,
  parseSessionEntries,
} from "@earendil-works/pi-coding-agent";
import { getSetting } from "@juanibiapina/pi-extension-settings";
import type { SettingDefinition } from "@juanibiapina/pi-extension-settings";
import { Type } from "typebox";
import { mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const EXTENSION_NAME = "auditor";
const IMPORT_CUSTOM_TYPE = "auditor_session_import";
let pendingImportPath: string | null = null;

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

async function readSessionEntries(filePath: string): Promise<SessionEntry[]> {
  try {
    const content = await readFile(filePath, "utf-8");
    const entries = parseSessionEntries(content);
    return entries.filter((e): e is SessionEntry => e.type !== "session");
  } catch {
    return [];
  }
}

function formatEntryForImport(entry: SessionEntry): string | null {
  if (entry.type === "message" && entry.message) {
    const msg = entry.message;
    const timestamp = entry.timestamp;
    const role = msg.role;

    if (role === "user") {
      const text = textFromMessage(msg);
      return `[${timestamp}] user: ${text}`;
    }

    if (role === "assistant") {
      const text = textFromMessage(msg);
      const model = msg.model ? ` (${msg.model})` : "";
      return `[${timestamp}] assistant${model}: ${text}`;
    }

    if (role === "toolResult") {
      const text = textFromMessage(msg);
      const toolName = msg.toolName || "tool";
      return `[${timestamp}] toolResult (${toolName}): ${text}`;
    }
  }

  if (entry.type === "thinking_level_change") {
    return `[${entry.timestamp}] thinking level: ${entry.thinkingLevel}`;
  }

  if (entry.type === "model_change") {
    return `[${entry.timestamp}] model: ${entry.provider}/${entry.modelId}`;
  }

  if (entry.type === "compaction") {
    return `[${entry.timestamp}] [compaction] ${entry.summary.substring(0, 100)}...`;
  }

  return null;
}

function formatHistoryForImport(entries: SessionEntry[]): string {
  const lines = entries
    .map(formatEntryForImport)
    .filter((line): line is string => line !== null);

  if (lines.length === 0) return "";

  return `Previous session history:\n\n${lines.join("\n\n")}`;
}

async function exportSession(ctx: any) {
  const exportPath = join(ctx.cwd, ".session.jsonl");

  try {

    const existingEntries = await readSessionEntries(exportPath);
    const existingIds = new Set(existingEntries.map((e) => e.id));

    const branchEntries = ctx.sessionManager.getBranch();

    // Find entries not already in the file
    const newEntries: SessionEntry[] = [];
    for (const entry of branchEntries) {
      if (existingIds.has(entry.id)) continue;
      // Skip our own import entries to prevent feedback loops
      if (entry.type === "custom_message" && entry.customType === IMPORT_CUSTOM_TYPE) continue;
      newEntries.push(entry);
    }

    if (newEntries.length === 0) {
      console.log(`[${EXTENSION_NAME}] no new entries to export`);
      return;
    }

    if (existingEntries.length === 0) {
      // File is new or empty — write header + all branch entries
      const header: SessionHeader = {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: ctx.sessionManager.getSessionId(),
        timestamp: new Date().toISOString(),
        cwd: ctx.sessionManager.getCwd(),
      };
      const lines: string[] = [JSON.stringify(header)];
      let prevId: string | null = null;
      for (const entry of branchEntries) {
        const linear = { ...entry, parentId: prevId };
        lines.push(JSON.stringify(linear));
        prevId = entry.id;
      }
      await writeFile(exportPath, lines.join("\n") + "\n", "utf-8");
      console.log(`[${EXTENSION_NAME}] exported session to ${exportPath}`);
    } else {
      // File exists — append only new entries
      const lines = newEntries.map((e) => JSON.stringify(e));
      await appendFile(exportPath, lines.join("\n") + "\n", "utf-8");
      console.log(`[${EXTENSION_NAME}] appended ${newEntries.length} entries to ${exportPath}`);
    }
  } catch (error) {
    console.error(`[${EXTENSION_NAME}] failed to export session:`, error);
  }
}

export default function (pi: ExtensionAPI) {
  let intervalId: ReturnType<typeof setInterval> | undefined;

  // ── Register extension settings ────────────────────────────────────────────
  pi.events.emit("pi-extension-settings:register", {
    name: EXTENSION_NAME,
    settings: [
      {
        id: "autoExportInterval",
        label: "Auto-export interval",
        description: "Minutes between background session exports (0 = disabled)",
        defaultValue: "5",
        values: ["0", "5", "10", "30", "60"],
      } satisfies SettingDefinition,
    ],
  });

  // ── Session start: stage import for first turn + start periodic export timer ──
  pi.on("session_start", (_event, ctx) => {
    // Stage import for the first turn if this is a fresh session
    if (ctx.sessionManager.getEntries().length === 0) {
      const importPath = join(ctx.cwd, ".session.jsonl");
      if (existsSync(importPath)) {
        pendingImportPath = importPath;
        if (ctx.hasUI) {
          ctx.ui.setStatus("auditor", "history ready");
        }
      }
    }

    const minutes = parseInt(getSetting(EXTENSION_NAME, "autoExportInterval", "5"), 10);
    if (minutes > 0) {
      intervalId = setInterval(() => {
        exportSession(ctx);
      }, minutes * 60 * 1000);
    }
  });

  // ── Before agent start: inject history on the first turn ───────────────────
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!pendingImportPath) return;

    const path = pendingImportPath;
    pendingImportPath = null; // clear so it only fires once

    try {
      const fileEntries = await readSessionEntries(path);
      if (fileEntries.length === 0) {
        if (ctx.hasUI) {
          ctx.ui.setStatus("auditor", undefined);
        }
        return;
      }

      const historyText = formatHistoryForImport(fileEntries);
      if (!historyText) {
        if (ctx.hasUI) {
          ctx.ui.setStatus("auditor", undefined);
        }
        return;
      }

      console.log(`[${EXTENSION_NAME}] imported ${fileEntries.length} entries from ${path}`);

      if (ctx.hasUI) {
        ctx.ui.setStatus("auditor", "history loaded");
      }

      return {
        message: {
          customType: IMPORT_CUSTOM_TYPE,
          content: historyText,
          display: false,
          details: {},
        },
      };
    } catch (error) {
      console.error(`[${EXTENSION_NAME}] failed to import session:`, error);
      if (ctx.hasUI) {
        ctx.ui.setStatus("auditor", undefined);
      }
    }
  });

  // ── Session shutdown: clear timer + final export ───────────────────────────
  pi.on("session_shutdown", async (event, ctx) => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = undefined;
    }
    if (event.reason === "quit") {
      await exportSession(ctx);
    }
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
