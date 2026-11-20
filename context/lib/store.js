import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_ACTIVE_CATEGORIES,
  DEFAULT_EXEMPT_EXTENSIONS,
  DEFAULT_FILE_READ_MAX_AGE_MS,
  FILE_CATEGORIES,
  MAX_CHUNK_BYTES,
  MAX_OUTLINE_CACHE_DB_ENTRIES,
  MAX_OUTLINE_JSON_BYTES,
  MAX_SNAPSHOTS_PER_SESSION,
  MAX_SNAPSHOT_BYTES,
  RRF_K,
  SNIPPET_MAX_BYTES,
  STATE_BUDGET,
  SchemaMethods,
  getDefaultDbPath,
  sanitizeFtsQuery,
  sanitizeTrigramQuery,
  truncateUtf8Bytes
} from "./store/schema.js";
import { FtsMethods } from "./store/fts.js";
import { CheckpointMethods } from "./store/checkpoints.js";
import { ReadMethods } from "./store/reads.js";
import { SettingsMaintenanceMethods } from "./store/settings-maintenance.js";

export {
  DEFAULT_ACTIVE_CATEGORIES,
  DEFAULT_EXEMPT_EXTENSIONS,
  DEFAULT_FILE_READ_MAX_AGE_MS,
  FILE_CATEGORIES,
  MAX_CHUNK_BYTES,
  MAX_OUTLINE_CACHE_DB_ENTRIES,
  MAX_OUTLINE_JSON_BYTES,
  MAX_SNAPSHOTS_PER_SESSION,
  MAX_SNAPSHOT_BYTES,
  RRF_K,
  SNIPPET_MAX_BYTES,
  STATE_BUDGET,
  getDefaultDbPath,
  sanitizeFtsQuery,
  sanitizeTrigramQuery,
  truncateUtf8Bytes
};

function attachPrototypeMethods(TargetClass, ...MixinClasses) {
  for (const Mixin of MixinClasses) {
    for (const key of Object.getOwnPropertyNames(Mixin.prototype)) {
      if (key === "constructor") continue;
      const desc = Object.getOwnPropertyDescriptor(Mixin.prototype, key);
      if (desc) Object.defineProperty(TargetClass.prototype, key, desc);
    }
  }
}

export class ContextModeStore {
  constructor(optionsOrDbPath) {
    if (typeof optionsOrDbPath === "string" && optionsOrDbPath.trim()) {
      this.dbPath = optionsOrDbPath.trim();
    } else if (optionsOrDbPath && typeof optionsOrDbPath.dbPath === "string" && optionsOrDbPath.dbPath.trim()) {
      this.dbPath = optionsOrDbPath.dbPath.trim();
    } else {
      this.dbPath = getDefaultDbPath();
    }
    this.db = null;
    this.sourceCounter = 0;
  }

  /** Open or initialize SQLite database */
  open() {
    if (this.db) return this.db;
    const dbDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    this.db = new DatabaseSync(this.dbPath);
    this.initSchema();
    return this.db;
  }

  close() {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // ignore close error
      }
      this.db = null;
    }
  }

  /** Retry helper for transient SQLITE_BUSY / database-locked contention across parallel hooks */
  _withBusyRetry(fn, maxAttempts = 5) {
    let lastErr;
    const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return fn();
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message || err || "");
        const isBusy = err?.code === "ERR_SQLITE_ERROR" && /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(msg);
        if (!isBusy || attempt === maxAttempts - 1) throw err;
        try {
          Atomics.wait(sleepBuf, 0, 0, 20 * (attempt + 1));
        } catch {}
      }
    }
    throw lastErr;
  }
}

attachPrototypeMethods(
  ContextModeStore,
  SchemaMethods,
  FtsMethods,
  CheckpointMethods,
  ReadMethods,
  SettingsMaintenanceMethods
);
