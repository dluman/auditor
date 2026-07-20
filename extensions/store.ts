import { createStorage, type Storage } from "unstorage";
import { mkdir, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface StoreEntry {
  key: string;
  timestamp: string;
  value: unknown;
}

/**
 * Create a write-only, append-only unstorage driver backed by a JSONL dotfile.
 *
 * - `setItem` appends a new JSON line `{ key, timestamp, value }`.
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
    async setItem(key: string, value: string) {
      // unstorage passes the serialized JSON string to the driver.
      const parsed = JSON.parse(value);
      const entry: StoreEntry = {
        key,
        timestamp: new Date().toISOString(),
        value: parsed,
      };
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, JSON.stringify(entry) + "\n", "utf-8");
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
 * - The store path defaults to a hidden file inside the Pi agent directory.
 */
export class WriteOnlyKVStore {
  readonly path: string;
  private storage: Storage;

  constructor(filePath: string) {
    this.path = filePath;
    this.storage = createStorage({ driver: jsonlDriver(filePath) });
  }

  static defaultFor(extensionName: string): WriteOnlyKVStore {
    const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    // Dotfile inside the already-hidden Pi agent directory.
    const filePath = join(agentDir, `.${extensionName}.jsonl`);
    return new WriteOnlyKVStore(filePath);
  }

  async write(key: string, value: unknown): Promise<void> {
    // unstorage accepts null | string | number | boolean | object.
    await this.storage.setItem(key, value as Record<string, unknown>);
  }
}
