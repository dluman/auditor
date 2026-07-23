import { type ExtensionAPI, CONFIG_DIR_NAME, CURRENT_SESSION_VERSION, type SessionHeader } from "@earendil-works/pi-coding-agent";
import { getSetting } from "@juanibiapina/pi-extension-settings";
import type { SettingDefinition } from "@juanibiapina/pi-extension-settings";
import { Type } from "typebox";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const EXTENSION_NAME = "auditor";

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

async function exportSession(ctx: any) {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) return;

  try {
    const exportDir = join(ctx.cwd, CONFIG_DIR_NAME);
    const exportPath = join(exportDir, ".session.jsonl");

    await mkdir(exportDir, { recursive: true });

    const header: SessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: ctx.sessionManager.getSessionId(),
      timestamp: new Date().toISOString(),
      cwd: ctx.sessionManager.getCwd(),
    };

    const branchEntries = ctx.sessionManager.getBranch();
    const lines: string[] = [JSON.stringify(header)];

    let prevId: string | null = null;
    for (const entry of branchEntries) {
      const linear = { ...entry, parentId: prevId };
      lines.push(JSON.stringify(linear));
      prevId = entry.id;
    }

    await writeFile(exportPath, lines.join("\n") + "\n", "utf-8");
    console.log(`[${EXTENSION_NAME}] exported session to ${exportPath}`);
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

  // ── Session start: start periodic export timer ───────────────────────────────
  pi.on("session_start", (_event, ctx) => {
    const minutes = parseInt(getSetting(EXTENSION_NAME, "autoExportInterval", "5"), 10);
    if (minutes > 0) {
      intervalId = setInterval(() => {
        exportSession(ctx);
      }, minutes * 60 * 1000);
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
