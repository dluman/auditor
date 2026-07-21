import { createStorage, type Storage } from "unstorage";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { mkdir, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface StoreEntry {
  key: string;
  timestamp: string;
  value: unknown;
}

/**
 * Create a write-only, append-only unstorage driver backed by a JSONL dotfile.
 *
 * - `setItem` appends a new JSON line containing an array of prompt events.
 * - Read, list, and delete operations are no-ops, preserving write-only semantics.
 */
function jsonlDriver(filePath: string) {
  return {
    name: "jsonl",
    options: {},
    async hasItem() {
      return false;
    },
    async getItem() {
      return null;
    },
    async getKeys() {
      return [];
    },
    async removeItem() {
      // write-only: ignore
    },
    async setItem(_key: string, value: string) {
      // unstorage passes the serialized JSON string to the driver.
      // Each prompt is stored as a single JSON array on its own line.
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, value + "\n", "utf-8");
    },
    async getMeta() {
      return {};
    },
    async setMeta() {
      // write-only: ignore
    },
    async removeMeta() {
      // write-only: ignore
    },
    async clear() {
      // write-only: ignore
    },
  };
}

/**
 * A write-only, append-only key/value store backed by a JSONL dotfile.
 *
 * The store is implemented as a thin wrapper around `unstorage` with a custom
 * JSONL driver, so the backend can be swapped later without changing callers.
 *
 * - New entries are appended; existing entries are never read, updated, or deleted.
 * - The store path defaults to a hidden file inside the Pi config directory for
 *   the current working directory.
 */
export class WriteOnlyKVStore {
  readonly path: string;
  private storage: Storage;

  constructor(filePath: string) {
    this.path = filePath;
    this.storage = createStorage({ driver: jsonlDriver(filePath) });
  }

  static defaultFor(): WriteOnlyKVStore {
    const baseDir = process.env.PI_CODING_AGENT_DIR ?? process.cwd();
    const agentDir = join(baseDir, CONFIG_DIR_NAME);
    // Consistent dotfile name inside the Pi config directory.
    const filePath = join(agentDir, ".sessions");
    return new WriteOnlyKVStore(filePath);
  }

  async write(entries: StoreEntry[]): Promise<void> {
    // unstorage accepts null | string | number | boolean | object.
    await this.storage.setItem("group", entries as any);
  }
}
