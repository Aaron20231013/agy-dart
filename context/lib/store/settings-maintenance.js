import fs from "node:fs";
import { getConfigSnapshot, getEffectiveConfig } from "../config.js";
import {
  DEFAULT_ACTIVE_CATEGORIES,
  DEFAULT_CUTOFF_BYTES,
  DEFAULT_EXEMPT_EXTENSIONS,
  FILE_CATEGORIES
} from "./schema.js";

export const STAR_PROMPT_META_KEY = "star_prompt";
export const CACHE_AUDIT_PASSED_META_KEY = "cache_audit:passed_at";
export const STAR_PROMPT_STATES = Object.freeze(["pending", "clicked", "dismissed", "copied_cli"]);
export const STAR_PROMPT_TERMINAL_STATES = Object.freeze(["clicked", "dismissed", "copied_cli"]);
export const STAR_PROMPT_MIN_SAVED_BYTES = 100 * 1024;
export const STAR_PROMPT_MIN_SESSIONS = 3;

export function normalizeStarPromptState(raw) {
  const defaults = {
    state: "pending",
    triggeredAt: null,
    resolvedAt: null,
    milestoneSavedBytes: 0
  };
  let obj = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return { ...defaults };
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return { ...defaults };
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ...defaults };
  }
  let src = obj;
  if (Object.prototype.hasOwnProperty.call(obj, "starPrompt")) {
    src =
      obj.starPrompt && typeof obj.starPrompt === "object" && !Array.isArray(obj.starPrompt)
        ? obj.starPrompt
        : null;
  }
  if (!src || typeof src !== "object" || Array.isArray(src)) {
    return { ...defaults };
  }
  const state =
    typeof src.state === "string" && STAR_PROMPT_STATES.includes(src.state) ? src.state : "pending";
  const normIso = (v) => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t && t.length <= 64 ? t : null;
  };
  let milestoneSavedBytes = 0;
  const rawBytes = src.milestoneSavedBytes;
  if (typeof rawBytes === "number" || (typeof rawBytes === "string" && rawBytes.trim() !== "")) {
    const n = Number(rawBytes);
    if (Number.isFinite(n) && n >= 0) {
      milestoneSavedBytes = Math.floor(n);
    }
  }
  return {
    state,
    triggeredAt: normIso(src.triggeredAt),
    resolvedAt: normIso(src.resolvedAt),
    milestoneSavedBytes
  };
}

export class SettingsMaintenanceMethods {
  /** Calculate token savings & statistics */
  getStats(sessionId, options = {}) {
    this.open();
    const sid = sessionId || "default";
    const sinceTs = options.sinceTs || null;
    const sinceIso = sinceTs ? new Date(sinceTs).toISOString() : null;

    let eventStats;
    let sourceStats;
    let unrecordedSources;

    if (sid === "all" || sid === "lifetime") {
      eventStats = this.db.prepare(`
        SELECT
          COUNT(*) AS total_calls,
          SUM(MAX(sandbox_bytes, bytes, returned_bytes)) AS total_raw_bytes,
          SUM(returned_bytes) AS total_returned_bytes,
          SUM(MAX(0, MAX(sandbox_bytes, bytes, returned_bytes) - returned_bytes)) AS total_kept_out_bytes
        FROM events
        WHERE COALESCE(key, '') != 'dedup_bypass'
      `).get();

      sourceStats = this.db.prepare(`
        SELECT
          COUNT(*) AS total_sources,
          SUM(bytes_total) AS total_source_bytes,
          SUM(chunk_count) AS total_chunks
        FROM sources
      `).get();

      unrecordedSources = this.db.prepare(`
        SELECT COALESCE(SUM(bytes_total), 0) AS unrecorded_source_bytes
        FROM sources s
        WHERE s.kind NOT IN ('execution', 'batch', 'tool_output', 'exec')
          AND NOT EXISTS (
            SELECT 1 FROM events e
            WHERE e.tool = 'ctx_index'
              AND e.sandbox_bytes = s.bytes_total
          )
      `).get();
    } else if (sid === "app" && sinceIso) {
      eventStats = this.db.prepare(`
        SELECT
          COUNT(*) AS total_calls,
          SUM(MAX(sandbox_bytes, bytes, returned_bytes)) AS total_raw_bytes,
          SUM(returned_bytes) AS total_returned_bytes,
          SUM(MAX(0, MAX(sandbox_bytes, bytes, returned_bytes) - returned_bytes)) AS total_kept_out_bytes
        FROM events
        WHERE created_at >= ? AND COALESCE(key, '') != 'dedup_bypass'
      `).get(sinceIso);

      sourceStats = this.db.prepare(`
        SELECT
          COUNT(*) AS total_sources,
          SUM(bytes_total) AS total_source_bytes,
          SUM(chunk_count) AS total_chunks
        FROM sources
        WHERE created_at >= ? OR created_ts >= ?
      `).get(sinceIso, sinceTs);

      unrecordedSources = this.db.prepare(`
        SELECT COALESCE(SUM(bytes_total), 0) AS unrecorded_source_bytes
        FROM sources s
        WHERE (created_at >= ? OR created_ts >= ?)
          AND s.kind NOT IN ('execution', 'batch', 'tool_output', 'exec')
          AND NOT EXISTS (
            SELECT 1 FROM events e
            WHERE e.tool = 'ctx_index'
              AND e.sandbox_bytes = s.bytes_total
          )
      `).get(sinceIso, sinceTs);
    } else {
      eventStats = this.db.prepare(`
        SELECT
          COUNT(*) AS total_calls,
          SUM(MAX(sandbox_bytes, bytes, returned_bytes)) AS total_raw_bytes,
          SUM(returned_bytes) AS total_returned_bytes,
          SUM(MAX(0, MAX(sandbox_bytes, bytes, returned_bytes) - returned_bytes)) AS total_kept_out_bytes
        FROM events
        WHERE session_id = ? AND COALESCE(key, '') != 'dedup_bypass'
      `).get(sid);

      sourceStats = this.db.prepare(`
        SELECT
          COUNT(*) AS total_sources,
          SUM(bytes_total) AS total_source_bytes,
          SUM(chunk_count) AS total_chunks
        FROM sources
        WHERE session_id = ?
      `).get(sid);

      unrecordedSources = this.db.prepare(`
        SELECT COALESCE(SUM(bytes_total), 0) AS unrecorded_source_bytes
        FROM sources s
        WHERE s.session_id = ?
          AND s.kind NOT IN ('execution', 'batch', 'tool_output', 'exec')
          AND NOT EXISTS (
            SELECT 1 FROM events e
            WHERE e.session_id = s.session_id
              AND e.tool = 'ctx_index'
              AND e.sandbox_bytes = s.bytes_total
          )
      `).get(sid);
    }

    const unrecordedBytes = unrecordedSources?.unrecorded_source_bytes || 0;
    const totalRawBytes = (eventStats?.total_raw_bytes || 0) + unrecordedBytes;
    const totalReturnedBytes = eventStats?.total_returned_bytes || 0;
    const keptOutBytes = (eventStats?.total_kept_out_bytes || 0) + unrecordedBytes;
    const savingsPercent = totalRawBytes > 0 ? Number(((keptOutBytes / totalRawBytes) * 100).toFixed(1)) : 0;
    const tokensKeptOut = Math.round(keptOutBytes / 4);

    let breakdownRows = [];
    try {
      if (sid === "all" || sid === "lifetime") {
        breakdownRows = this.db.prepare(`
          SELECT kind, COUNT(*) AS cnt,
            COALESCE(SUM(MAX(0, MAX(sandbox_bytes, bytes, returned_bytes) - returned_bytes)), 0) AS saved_bytes
          FROM events WHERE COALESCE(key, '') != 'dedup_bypass' GROUP BY kind
        `).all();
      } else if (sid === "app" && sinceIso) {
        breakdownRows = this.db.prepare(`
          SELECT kind, COUNT(*) AS cnt,
            COALESCE(SUM(MAX(0, MAX(sandbox_bytes, bytes, returned_bytes) - returned_bytes)), 0) AS saved_bytes
          FROM events WHERE created_at >= ? AND COALESCE(key, '') != 'dedup_bypass' GROUP BY kind
        `).all(sinceIso);
      } else {
        breakdownRows = this.db.prepare(`
          SELECT kind, COUNT(*) AS cnt,
            COALESCE(SUM(MAX(0, MAX(sandbox_bytes, bytes, returned_bytes) - returned_bytes)), 0) AS saved_bytes
          FROM events WHERE session_id = ? AND COALESCE(key, '') != 'dedup_bypass' GROUP BY kind
        `).all(sid);
      }
    } catch {}

    const breakdown = {
      interceptions: 0,
      cliFilters: 0,
      dedups: 0,
      executions: 0,
      indexes: 0,
      cliFilterSavedBytes: 0,
      dedupSavedBytes: 0
    };
    for (const row of breakdownRows) {
      if (row.kind === "interception") breakdown.interceptions = row.cnt;
      else if (row.kind === "cli_filter") {
        breakdown.cliFilters = row.cnt;
        breakdown.cliFilterSavedBytes = row.saved_bytes || 0;
      } else if (row.kind === "dedup") {
        breakdown.dedups = row.cnt;
        breakdown.dedupSavedBytes = row.saved_bytes || 0;
      } else if (row.kind === "execution" || row.kind === "batch") {
        breakdown.executions += row.cnt;
      } else if (row.kind === "index") {
        breakdown.indexes = row.cnt;
      }
    }

    return {
      sessionId: sid,
      calls: eventStats?.total_calls || 0,
      totalRawBytes,
      totalReturnedBytes,
      keptOutBytes,
      savingsPercent,
      tokensKeptOut,
      sourcesCount: sourceStats?.total_sources || 0,
      chunksCount: sourceStats?.total_chunks || 0,
      breakdown
    };
  }

  /**
   * Quantify per-feature telemetry ROI from `events` + `ghost_interceptions`
   * so low-value or unused features can be measured objectively.
   */
  getFeatureRoi(sessionId, options = {}) {
    this.open();
    const sid = sessionId || "default";
    const sinceTs = Number.isFinite(options.sinceTs) ? options.sinceTs : null;
    const sinceIso = sinceTs !== null ? new Date(sinceTs).toISOString() : null;

    let rows = [];
    try {
      const baseSql = `
        SELECT kind, COALESCE(key, '') AS key, COUNT(*) AS cnt,
          COALESCE(SUM(MAX(sandbox_bytes, bytes, returned_bytes)), 0) AS raw_bytes,
          COALESCE(SUM(returned_bytes), 0) AS returned_bytes,
          COALESCE(SUM(MAX(0, MAX(sandbox_bytes, bytes, returned_bytes) - returned_bytes)), 0) AS saved_bytes
        FROM events
      `;
      if (sid === "all" || sid === "lifetime") {
        rows = this.db.prepare(`${baseSql} GROUP BY kind, COALESCE(key, '')`).all();
      } else if (sid === "app" && sinceIso) {
        rows = this.db.prepare(`${baseSql} WHERE created_at >= ? GROUP BY kind, COALESCE(key, '')`).all(sinceIso);
      } else {
        rows = this.db.prepare(`${baseSql} WHERE session_id = ? GROUP BY kind, COALESCE(key, '')`).all(sid);
      }
    } catch {}

    const buckets = {
      cli_filter: { calls: 0, rawBytes: 0, returnedBytes: 0, savedBytes: 0 },
      read_dedup: { calls: 0, rawBytes: 0, returnedBytes: 0, savedBytes: 0 },
      diff_read: { calls: 0, rawBytes: 0, returnedBytes: 0, savedBytes: 0 },
      large_file_guard: { calls: 0, rawBytes: 0, returnedBytes: 0, savedBytes: 0 },
      sandbox_execute: { calls: 0, rawBytes: 0, returnedBytes: 0, savedBytes: 0 },
      fts_index: { calls: 0, rawBytes: 0, returnedBytes: 0, savedBytes: 0 }
    };

    const add = (name, r) => {
      const b = buckets[name];
      b.calls += Number(r.cnt || 0);
      b.rawBytes += Number(r.raw_bytes || 0);
      b.returnedBytes += Number(r.returned_bytes || 0);
      b.savedBytes += Number(r.saved_bytes || 0);
    };

    let dedupBypasses = 0;
    for (const r of rows) {
      if (r.kind === "cli_filter") add("cli_filter", r);
      else if (r.kind === "dedup" && r.key === "dedup_bypass") dedupBypasses += Number(r.cnt || 0);
      else if (r.kind === "dedup" && r.key === "modified_diff") add("diff_read", r);
      else if (r.kind === "dedup") add("read_dedup", r);
      else if (r.kind === "interception") add("large_file_guard", r);
      else if (r.kind === "execution" || r.kind === "batch") add("sandbox_execute", r);
      else if (r.kind === "index") add("fts_index", r);
    }

    const ghost = this.getGhostStats(sid, sinceTs !== null ? { sinceTs } : {});
    const features = {};
    for (const [name, b] of Object.entries(buckets)) {
      const estTokensSaved = Math.round(b.savedBytes / 4);
      const avgSavedBytesPerCall = b.calls > 0 ? Math.round(b.savedBytes / b.calls) : 0;
      const reductionPct = b.rawBytes > 0 ? Number(((b.savedBytes / b.rawBytes) * 100).toFixed(1)) : 0;
      const status =
        b.calls === 0
          ? "unused"
          : estTokensSaved >= 1000 || reductionPct >= 50
            ? "high_roi"
            : "active";
      features[name] = {
        calls: b.calls,
        savedBytes: b.savedBytes,
        estTokensSaved,
        avgSavedBytesPerCall,
        reductionPct,
        status,
        ...(name === "read_dedup"
          ? {
              bypasses: dedupBypasses,
              bypassRate: b.calls > 0 ? Number((dedupBypasses / b.calls).toFixed(4)) : 0
            }
          : {}),
        ...(name === "large_file_guard"
          ? { evictionEfficiency: ghost.evictionEfficiency, ghostRecalls: ghost.ghostRecalls }
          : {})
      };
    }

    return {
      sessionId: sid,
      features
    };
  }

  /** Purge stored data */
  purge({ scope = "session", sessionId, worktree, sinceTs, olderThanDays = 14, vacuum = false } = {}) {
    this.open();
    if (scope === "stale") {
      return this.pruneByTtl({ maxAgeDays: olderThanDays, vacuum });
    }

    if (scope === "all" || scope === "lifetime") {
      this._withWriteTx(() => {
        this.db.exec(`
          DELETE FROM chunks;
          DELETE FROM chunks_tri;
          DELETE FROM sources;
          DELETE FROM events;
          DELETE FROM file_reads;
          DELETE FROM file_snapshots;
          DELETE FROM repo_cache;
          DELETE FROM outline_cache;
          DELETE FROM ghost_interceptions;
          DELETE FROM session_checkpoints;
          DELETE FROM meta WHERE key LIKE 'large_read_confirm:%' OR key LIKE 'sensitive_read_confirm:%' OR key LIKE 'watchdog_lease:%';
        `);
      });
      try {
        this.db.exec("VACUUM;");
      } catch {
        // Best-effort VACUUM: ignore transient SQLITE_BUSY from concurrent readers
      }
      return { ok: true, purged: "all" };
    }

    if (scope === "app") {
      if (sinceTs === null || sinceTs === undefined || typeof sinceTs === "boolean" || (typeof sinceTs === "string" && sinceTs.trim() === "") || !Number.isFinite(Number(sinceTs))) {
        throw new Error("purge({ scope: 'app' }) requires a finite 'sinceTs' timestamp");
      }
      const sinceNum = Number(sinceTs);
      const sinceIso = new Date(sinceNum).toISOString();
      const count = this._withWriteTx(() => {
        const sourceIds = this.db
          .prepare("SELECT id FROM sources WHERE created_at >= ? OR created_ts >= ?")
          .all(sinceIso, sinceNum)
          .map((r) => r.id);
        for (let i = 0; i < sourceIds.length; i += 400) {
          const batch = sourceIds.slice(i, i + 400);
          const placeholders = batch.map(() => "?").join(",");
          this.db.prepare(`DELETE FROM chunks WHERE source_id IN (${placeholders})`).run(...batch);
          this.db.prepare(`DELETE FROM chunks_tri WHERE source_id IN (${placeholders})`).run(...batch);
        }
        this.db.prepare("DELETE FROM sources WHERE created_at >= ? OR created_ts >= ?").run(sinceIso, sinceNum);
        this.db.prepare("DELETE FROM events WHERE created_at >= ?").run(sinceIso);
        this.db.prepare("DELETE FROM file_reads WHERE read_ts >= ?").run(sinceNum);
        this.db.prepare("DELETE FROM file_snapshots WHERE updated_ts >= ?").run(sinceNum);
        this.db.prepare("DELETE FROM ghost_interceptions WHERE blocked_ts >= ?").run(sinceNum);
        this.db.prepare("DELETE FROM session_checkpoints WHERE updated_ts >= ?").run(sinceNum);
        return sourceIds.length;
      });
      return { ok: true, purged: "app", count };
    }

    if (scope === "worktree") {
      if (typeof worktree !== "string" || !worktree.trim()) {
        throw new Error("purge({ scope: 'worktree' }) requires a non-empty 'worktree' path");
      }
      this._withWriteTx(() => {
        const sourceIds = this.db
          .prepare("SELECT id FROM sources WHERE worktree = ?")
          .all(worktree)
          .map((r) => r.id);
        for (let i = 0; i < sourceIds.length; i += 400) {
          const batch = sourceIds.slice(i, i + 400);
          const placeholders = batch.map(() => "?").join(",");
          this.db.prepare(`DELETE FROM chunks WHERE source_id IN (${placeholders})`).run(...batch);
          this.db.prepare(`DELETE FROM chunks_tri WHERE source_id IN (${placeholders})`).run(...batch);
        }
        this.db.prepare("DELETE FROM chunks WHERE worktree = ?").run(worktree);
        this.db.prepare("DELETE FROM sources WHERE worktree = ?").run(worktree);
        this.db.prepare("DELETE FROM events WHERE worktree = ?").run(worktree);
        this.db.prepare("DELETE FROM session_checkpoints WHERE worktree = ?").run(worktree);
      });
      return { ok: true, purged: "worktree", worktree };
    }

    if (scope === "session" || scope === "conversation") {
      const sid = sessionId || "default";
      this._withWriteTx(() => {
        this.db.prepare("DELETE FROM chunks WHERE session_id = ?").run(sid);
        this.db.prepare("DELETE FROM chunks_tri WHERE session_id = ?").run(sid);
        this.db.prepare("DELETE FROM sources WHERE session_id = ?").run(sid);
        this.db.prepare("DELETE FROM events WHERE session_id = ?").run(sid);
        this.db.prepare("DELETE FROM file_reads WHERE session_id = ?").run(sid);
        this.db.prepare("DELETE FROM file_snapshots WHERE session_id = ?").run(sid);
        this.db.prepare("DELETE FROM ghost_interceptions WHERE session_id = ?").run(sid);
        this.db.prepare("DELETE FROM session_checkpoints WHERE session_id = ?").run(sid);
        const escSid = String(sid).replace(/[\\%_]/g, "\\$&");
        this.db
          .prepare(
            "DELETE FROM meta WHERE key = ? OR key LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\'"
          )
          .run(
            `watchdog_lease:${sid}`,
            `large_read_confirm:conv:${escSid}:%`,
            `large_read_confirm:sub:${escSid}:%`,
            `sensitive_read_confirm:${escSid}:%`,
            `sensitive_read_confirm:conv:${escSid}:%`,
            `sensitive_read_confirm:sub:${escSid}:%`
          );
      });
      return { ok: true, purged: "session", sessionId: sid };
    }

    throw new Error(`Invalid purge scope: '${String(scope)}'`);
  }

  /** Run diagnostic checks */
  doctor() {
    try {
      this.open();
      const versionRow = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
      const sqliteRow = this.db.prepare("SELECT sqlite_version() AS v").get();
      const ftsCheck = this.db.prepare("SELECT count(*) as cnt FROM chunks").get();
      const srcCheck = this.db.prepare("SELECT count(*) as cnt FROM sources").get();
      const evCheck = this.db.prepare("SELECT count(*) as cnt FROM events").get();
      const readsCheck = this.db.prepare("SELECT count(*) as cnt FROM file_reads").get();
      const snapsCheck = this.db.prepare("SELECT count(*) as cnt FROM file_snapshots").get();
      const outlineCheck = this.db.prepare("SELECT count(*) as cnt FROM outline_cache").get();
      const lastMaint = this.getMeta("last_maintenance_ts", null);
      const stat = fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath) : null;
      const walPath = `${this.dbPath}-wal`;
      const walStat = fs.existsSync(walPath) ? fs.statSync(walPath) : null;

      return {
        status: "HEALTHY",
        allOk: true,
        dbPath: this.dbPath,
        dbSizeBytes: stat ? stat.size : 0,
        walSizeBytes: walStat ? walStat.size : 0,
        schemaVersion: versionRow ? versionRow.value : "unknown",
        totalChunksIndexed: ftsCheck ? ftsCheck.cnt : 0,
        totalSources: srcCheck ? srcCheck.cnt : 0,
        totalEvents: evCheck ? evCheck.cnt : 0,
        trackedFileReads: readsCheck ? readsCheck.cnt : 0,
        trackedFileSnapshots: snapsCheck ? snapsCheck.cnt : 0,
        cachedOutlines: outlineCheck ? outlineCheck.cnt : 0,
        lastMaintenanceAt: lastMaint ? new Date(Number(lastMaint)).toISOString() : null,
        sqliteVersion: sqliteRow && sqliteRow.v ? String(sqliteRow.v) : "unknown"
      };
    } catch (err) {
      return {
        status: "ERROR",
        allOk: false,
        error: String(err && err.message ? err.message : err)
      };
    }
  }

  /** Read a key from meta table */
  getMeta(key, defaultValue = null) {
    this.open();
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? row.value : defaultValue;
  }

  /** Write a key-value pair to meta table */
  setMeta(key, value) {
    this.open();
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(key, String(value));
  }

  /** Delete a key from meta table */
  deleteMeta(key) {
    this.open();
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  }

  /** List meta rows matching an exact key prefix (safe LIKE escaping) */
  listMetaByPrefix(prefix) {
    if (!prefix || typeof prefix !== "string") return [];
    this.open();
    const esc = prefix.replace(/[\\%_]/g, "\\$&");
    return this.db
      .prepare("SELECT key, value FROM meta WHERE key LIKE ? ESCAPE '\\' ORDER BY key ASC")
      .all(`${esc}%`);
  }

  /** Delete all meta rows matching an exact key prefix (safe LIKE escaping) */
  deleteMetaByPrefix(prefix) {
    if (!prefix || typeof prefix !== "string") return 0;
    this.open();
    const esc = prefix.replace(/[\\%_]/g, "\\$&");
    const res = this.db
      .prepare("DELETE FROM meta WHERE key LIKE ? ESCAPE '\\'")
      .run(`${esc}%`);
    return res.changes || 0;
  }

  /** Read a timestamped meta value with optional TTL enforcement (backward compatible with 2-arg calls) */
  getTimedMeta(key, defaultValue = null, maxAgeMs = 0) {
    const raw = this.getMeta(key, null);
    if (raw === null) return defaultValue;
    const enforceTtl = Number.isFinite(maxAgeMs) && maxAgeMs > 0;
    if (raw.startsWith("{")) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && "v" in parsed) {
          if (enforceTtl) {
            const ts = Number(parsed.ts);
            if (!Number.isFinite(ts) || ts <= 0 || Date.now() - ts > maxAgeMs) {
              try {
                this.deleteMeta(key);
              } catch {}
              return defaultValue;
            }
          }
          return parsed.v;
        }
      } catch {}
    }
    if (enforceTtl) {
      // Plain legacy string or corrupted entry lacks a valid timestamp -> treat as expired
      try {
        this.deleteMeta(key);
      } catch {}
      return defaultValue;
    }
    return raw;
  }

  /** Write a timestamped meta value so pruneByTtl can evict stale per-session entries */
  setTimedMeta(key, value) {
    this.setMeta(key, JSON.stringify({ v: String(value), ts: Date.now() }));
  }

  /** Clear all session-level overrides so new sessions start with lifetime defaults */
  clearSessionOverrides() {
    this.open();
    this.db.prepare("DELETE FROM meta WHERE key LIKE '%:session:app' OR key LIKE '%:session:default'").run();
  }

  /** Check if a session or conversation has an explicit cutoff override */
  hasCutoffOverride(sessionId) {
    if (!sessionId || sessionId === "all" || sessionId === "lifetime") return false;
    this.open();
    return this.getMeta(`cutoff:session:${sessionId}`) !== null;
  }

  /** Get active cutoff in bytes along with provenance ("sqlite:session"|"sqlite:app"|"env"|"config"|"sqlite:user"|"sqlite:installer_default"|"default") */
  getCutoffInfo(sessionId = null) {
    this.open();
    const parseMetaCutoff = (raw) => {
      if (raw === null || raw === undefined) return null;
      const parsed = parseInt(raw, 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    };
    // 1. Session/Conversation override
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      const sessionCutoff = parseMetaCutoff(this.getMeta(`cutoff:session:${sessionId}`));
      if (sessionCutoff !== null) {
        return { cutoffBytes: sessionCutoff, source: "sqlite:session" };
      }
      // If checking a conversation, fall back to the app session cutoff if set
      if (sessionId !== "app") {
        const appCutoff = parseMetaCutoff(this.getMeta("cutoff:session:app"));
        if (appCutoff !== null) {
          return { cutoffBytes: appCutoff, source: "sqlite:app" };
        }
      }
    }

    // 2. Unified config / env override if explicitly set
    const cfgSnap = getConfigSnapshot();
    const cfgMaxRead = cfgSnap.values.maxReadBytes;
    if (cfgMaxRead !== null && cfgMaxRead !== undefined && Number.isFinite(Number(cfgMaxRead))) {
      return {
        cutoffBytes: Math.max(0, Math.floor(Number(cfgMaxRead))),
        source: cfgSnap.sources.maxReadBytes === "env" ? "env" : "config"
      };
    }

    // 3. Saved global setting in SQLite
    const globalCutoff = parseMetaCutoff(this.getMeta("cutoff:global"));
    if (globalCutoff !== null) {
      const metaSrc = this.getMeta("cutoff:source", null);
      return {
        cutoffBytes: globalCutoff,
        source: metaSrc === "installer_default" ? "sqlite:installer_default" : "sqlite:user"
      };
    }

    // 4. Default 45 KiB (46,080 B — aligns with Antigravity read_file host cap & <= 800-line window)
    return { cutoffBytes: DEFAULT_CUTOFF_BYTES, source: "default" };
  }

  /** Get active cutoff in bytes (0 = none/disabled) */
  getCutoff(sessionId = null) {
    return this.getCutoffInfo(sessionId).cutoffBytes;
  }

  /** Set cutoff in bytes (0 = none/disabled) */
  setCutoff(bytes, sessionId = null, options = {}) {
    this.open();
    const val = parseInt(bytes, 10);
    const numVal = Number.isNaN(val) ? DEFAULT_CUTOFF_BYTES : Math.max(0, val);
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      this.setMeta(`cutoff:session:${sessionId}`, numVal);
    } else {
      this.setMeta("cutoff:global", numVal);
      this.setMeta("cutoff:source", options?.source === "installer_default" ? "installer_default" : "user");
      // When changing cutoff in lifetime, clear session-level and default overrides
      // so new sessions and new conversations inherit this global setting as their default.
      this.deleteMeta("cutoff:session:app");
      this.deleteMeta("cutoff:session:default");
    }
    return numVal;
  }

  /** Internal helper to recompute and save the combined exempt_ext list */
  _recomputeExemptExtensions(sessionId = null) {
    const activeCats = this.getExemptCategories(sessionId);
    const customs = this.getCustomExemptExtensions(sessionId);
    const combined = new Set(customs);
    for (const catId of activeCats) {
      const cat = FILE_CATEGORIES[catId];
      if (cat && Array.isArray(cat.extensions)) {
        for (const ext of cat.extensions) {
          combined.add(ext);
        }
      }
    }
    const cleanList = Array.from(combined);
    const serialized = JSON.stringify(cleanList);
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      this.setMeta(`exempt_ext:session:${sessionId}`, serialized);
    } else {
      this.setMeta("exempt_ext:global", serialized);
      this.deleteMeta("exempt_ext:session:app");
      this.deleteMeta("exempt_ext:session:default");
    }
    return cleanList;
  }

  /** Get list of active category IDs */
  getExemptCategories(sessionId = null) {
    this.open();
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      const raw = this.getMeta(`exempt_categories:session:${sessionId}`);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed;
        } catch {}
      }
      if (sessionId !== "app") {
        const appRaw = this.getMeta("exempt_categories:session:app");
        if (appRaw) {
          try {
            const parsed = JSON.parse(appRaw);
            if (Array.isArray(parsed)) return parsed;
          } catch {}
        }
      }
    }
    const globalRaw = this.getMeta("exempt_categories:global");
    if (globalRaw) {
      try {
        const parsed = JSON.parse(globalRaw);
        if (Array.isArray(parsed)) return parsed;
      } catch {}
    }
    return [...DEFAULT_ACTIVE_CATEGORIES];
  }

  /** Set list of active category IDs */
  setExemptCategories(categories, sessionId = null) {
    this.open();
    const cleanList = Array.isArray(categories)
      ? Array.from(new Set(categories.map(c => String(c).trim().toLowerCase()).filter(c => FILE_CATEGORIES[c])))
      : [...DEFAULT_ACTIVE_CATEGORIES];
    const serialized = JSON.stringify(cleanList);
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      this.setMeta(`exempt_categories:session:${sessionId}`, serialized);
    } else {
      this.setMeta("exempt_categories:global", serialized);
      this.deleteMeta("exempt_categories:session:app");
      this.deleteMeta("exempt_categories:session:default");
    }
    this._recomputeExemptExtensions(sessionId);
    return cleanList;
  }

  /** Toggle an exempt category on or off */
  toggleExemptCategory(categoryId, enabled = null, sessionId = null) {
    const active = this.getExemptCategories(sessionId);
    const cat = String(categoryId || "").trim().toLowerCase();
    if (!FILE_CATEGORIES[cat]) return active;

    const isCurrentlyActive = active.includes(cat);
    const shouldEnable = enabled !== null ? Boolean(enabled) : !isCurrentlyActive;

    let updated;
    if (shouldEnable && !isCurrentlyActive) {
      updated = [...active, cat];
    } else if (!shouldEnable && isCurrentlyActive) {
      updated = active.filter(c => c !== cat);
    } else {
      return active;
    }
    return this.setExemptCategories(updated, sessionId);
  }

  /** Get custom file extensions (explicitly added by user) */
  getCustomExemptExtensions(sessionId = null) {
    this.open();
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      const raw = this.getMeta(`custom_exempt_ext:session:${sessionId}`);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed;
        } catch {}
      }
      if (sessionId !== "app") {
        const appRaw = this.getMeta("custom_exempt_ext:session:app");
        if (appRaw) {
          try {
            const parsed = JSON.parse(appRaw);
            if (Array.isArray(parsed)) return parsed;
          } catch {}
        }
      }
    }
    const globalRaw = this.getMeta("custom_exempt_ext:global");
    if (globalRaw) {
      try {
        const parsed = JSON.parse(globalRaw);
        if (Array.isArray(parsed)) return parsed;
      } catch {}
    }
    return [];
  }

  /** Sanitize a custom file extension to safe dotted token (blocks HTML/whitespace/path-sep injection) */
  _sanitizeCustomExtension(raw) {
    const clean = String(raw || "").trim().toLowerCase();
    if (!clean) return "";
    const formatted = clean.startsWith(".") ? clean : `.${clean}`;
    if (!/^\.[a-z0-9][a-z0-9._+-]{0,31}$/i.test(formatted)) return "";
    return formatted;
  }

  /** Set custom file extensions */
  setCustomExemptExtensions(extensions, sessionId = null) {
    this.open();
    const cleanList = Array.from(
      new Set(
        (Array.isArray(extensions) ? extensions : [])
          .map((ext) => this._sanitizeCustomExtension(ext))
          .filter(Boolean)
      )
    );
    const serialized = JSON.stringify(cleanList);
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      this.setMeta(`custom_exempt_ext:session:${sessionId}`, serialized);
    } else {
      this.setMeta("custom_exempt_ext:global", serialized);
      this.deleteMeta("custom_exempt_ext:session:app");
      this.deleteMeta("custom_exempt_ext:session:default");
    }
    this._recomputeExemptExtensions(sessionId);
    return cleanList;
  }

  /** Add custom file extension */
  addCustomExemptExtension(ext, sessionId = null) {
    const list = this.getCustomExemptExtensions(sessionId);
    const formatted = this._sanitizeCustomExtension(ext);
    if (!formatted) return list;
    if (!list.includes(formatted)) {
      list.push(formatted);
      this.setCustomExemptExtensions(list, sessionId);
    }
    return list;
  }

  /** Remove custom file extension */
  removeCustomExemptExtension(ext, sessionId = null) {
    const list = this.getCustomExemptExtensions(sessionId);
    const cleanExt = String(ext || "").trim().toLowerCase();
    if (!cleanExt) return list;
    const formatted = cleanExt.startsWith(".") ? cleanExt : `.${cleanExt}`;
    const filtered = list.filter((e) => e !== formatted);
    this.setCustomExemptExtensions(filtered, sessionId);
    return filtered;
  }

  /** Get list of file extensions exempt from the read_file size cutoff */
  getExemptExtensions(sessionId = null) {
    this.open();
    // Scope precedence: session:<sid> -> session:app -> global.
    // Only honor a legacy raw `exempt_ext:<scope>` key if that highest-precedence scope has
    // NO structured `exempt_categories`/`custom_exempt_ext` keys; otherwise compute dynamically
    // from getExemptCategories(sid) U getCustomExemptExtensions(sid) so global category updates
    // are never shadowed by stale cached session `exempt_ext` snapshots.
    const scopes = [];
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      scopes.push(`session:${sessionId}`);
      if (sessionId !== "app") {
        scopes.push("session:app");
      }
    }
    scopes.push("global");

    for (const sc of scopes) {
      const hasCats = this.getMeta(`exempt_categories:${sc}`) !== null;
      const hasCustom = this.getMeta(`custom_exempt_ext:${sc}`) !== null;
      if (hasCats || hasCustom) {
        break;
      }
      const rawExt = this.getMeta(`exempt_ext:${sc}`);
      if (rawExt !== null) {
        try {
          const parsed = JSON.parse(rawExt);
          if (Array.isArray(parsed)) return parsed;
        } catch {}
      }
    }

    const activeCats = this.getExemptCategories(sessionId);
    const customs = this.getCustomExemptExtensions(sessionId);
    const combined = new Set(customs);
    for (const catId of activeCats) {
      const cat = FILE_CATEGORIES[catId];
      if (cat && Array.isArray(cat.extensions)) {
        for (const ext of cat.extensions) {
          combined.add(ext);
        }
      }
    }
    return Array.from(combined);
  }

  /** Set list of file extensions exempt from the size cutoff */
  setExemptExtensions(extensions, sessionId = null) {
    this.open();
    if (extensions === null) {
      this.setExemptCategories(null, sessionId);
      this.setCustomExemptExtensions([], sessionId);
      return this.getExemptExtensions(sessionId);
    }
    const cleanList = Array.from(
      new Set(
        (Array.isArray(extensions) ? extensions : [])
          .map((ext) => String(ext || "").trim().toLowerCase())
          .filter(Boolean)
          .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`))
      )
    );
    const activeCats = [];
    for (const [catId, catObj] of Object.entries(FILE_CATEGORIES)) {
      if (Array.isArray(catObj.extensions) && catObj.extensions.length > 0 && catObj.extensions.every((e) => cleanList.includes(e))) {
        activeCats.push(catId);
      }
    }
    const allCatExts = new Set(activeCats.flatMap((c) => FILE_CATEGORIES[c]?.extensions || []));
    const customs = cleanList.filter((e) => !allCatExts.has(e));

    this.setExemptCategories(activeCats, sessionId);
    this.setCustomExemptExtensions(customs, sessionId);
    return this.getExemptExtensions(sessionId);
  }

  /** Add an exempt file extension */
  addExemptExtension(ext, sessionId = null) {
    this.addCustomExemptExtension(ext, sessionId);
    return this.getExemptExtensions(sessionId);
  }

  /** Remove an exempt file extension */
  removeExemptExtension(ext, sessionId = null) {
    this.removeCustomExemptExtension(ext, sessionId);
    return this.getExemptExtensions(sessionId);
  }

  /** Check if protection is paused (true = paused, false = active) */
  isPaused(sessionId = null) {
    this.open();
    // 1. Session/Conversation override
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      const sessionPaused = this.getMeta(`paused:session:${sessionId}`);
      if (sessionPaused !== null) {
        return sessionPaused === "true" || sessionPaused === "1";
      }
      // If checking a conversation, fall back to the app session paused state if set
      if (sessionId !== "app") {
        const appPaused = this.getMeta("paused:session:app");
        if (appPaused !== null) {
          return appPaused === "true" || appPaused === "1";
        }
      }
    }
    // 2. Global paused setting
    const globalPaused = this.getMeta("paused:global");
    if (globalPaused !== null) {
      return globalPaused === "true" || globalPaused === "1";
    }
    return false;
  }

  /** Set protection paused state (true = paused, false = active) */
  setPaused(paused, sessionId = null) {
    this.open();
    const boolVal = Boolean(paused && paused !== "false" && paused !== "0");
    const strVal = boolVal ? "true" : "false";
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      this.setMeta(`paused:session:${sessionId}`, strVal);
    } else {
      this.setMeta("paused:global", strVal);
      this.deleteMeta("paused:session:app");
      this.deleteMeta("paused:session:default");
    }
    return boolVal;
  }

  /** Check if transparent PreToolUse CLI output filtering is enabled */
  isCliFilterEnabled(sessionId = null) {
    if (!getEffectiveConfig().cliFilter) return false;
    this.open();
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      const sVal = this.getMeta(`cli_filter:session:${sessionId}`);
      if (sVal !== null) return sVal !== "false" && sVal !== "0";
      if (sessionId !== "app") {
        const aVal = this.getMeta("cli_filter:session:app");
        if (aVal !== null) return aVal !== "false" && aVal !== "0";
      }
    }
    const gVal = this.getMeta("cli_filter:global");
    if (gVal !== null) return gVal !== "false" && gVal !== "0";
    return true;
  }

  /** Enable or disable transparent PreToolUse CLI output filtering */
  setCliFilterEnabled(enabled, sessionId = null) {
    this.open();
    const boolVal = Boolean(enabled && enabled !== "false" && enabled !== "0");
    const strVal = boolVal ? "true" : "false";
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      this.setMeta(`cli_filter:session:${sessionId}`, strVal);
    } else {
      this.setMeta("cli_filter:global", strVal);
      this.deleteMeta("cli_filter:session:app");
      this.deleteMeta("cli_filter:session:default");
    }
    return boolVal;
  }

  /** Check if session-level unchanged read_file deduplication is enabled */
  isReadDedupEnabled(sessionId = null) {
    if (!getEffectiveConfig().readDedup) return false;
    this.open();
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      const sVal = this.getMeta(`read_dedup:session:${sessionId}`);
      if (sVal !== null) return sVal !== "false" && sVal !== "0";
      if (sessionId !== "app") {
        const aVal = this.getMeta("read_dedup:session:app");
        if (aVal !== null) return aVal !== "false" && aVal !== "0";
      }
    }
    const gVal = this.getMeta("read_dedup:global");
    if (gVal !== null) return gVal !== "false" && gVal !== "0";
    return true;
  }

  /** Enable or disable session-level unchanged read_file deduplication */
  setReadDedupEnabled(enabled, sessionId = null) {
    this.open();
    const boolVal = Boolean(enabled && enabled !== "false" && enabled !== "0");
    const strVal = boolVal ? "true" : "false";
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      this.setMeta(`read_dedup:session:${sessionId}`, strVal);
    } else {
      this.setMeta("read_dedup:global", strVal);
      this.deleteMeta("read_dedup:session:app");
      this.deleteMeta("read_dedup:session:default");
    }
    return boolVal;
  }

  /** Check if Sidecar Stall Watchdog is enabled (env > sqlite toggle > config > default true) */
  isWatchdogEnabled() {
    const snap = getConfigSnapshot();
    if (snap.sources.stallWatchdog === "env") {
      return Boolean(snap.values.stallWatchdog);
    }
    this.open();
    const raw = this.getMeta("watchdog:enabled", null);
    if (raw !== null) {
      return raw !== "false" && raw !== "0";
    }
    return Boolean(snap.values.stallWatchdog);
  }

  /** Enable or disable Sidecar Stall Watchdog in SQLite meta */
  setWatchdogEnabled(enabled) {
    this.open();
    const boolVal = Boolean(enabled && enabled !== "false" && enabled !== "0");
    this.setMeta("watchdog:enabled", boolVal ? "true" : "false");
    return boolVal;
  }

  /** Check if opt-in desktop stall notifications are enabled (default OFF; env > sqlite toggle > config) */
  isWatchdogDesktopNotifyEnabled() {
    const snap = getConfigSnapshot();
    if (snap.sources.watchdogDesktopNotify === "env") {
      return Boolean(snap.values.watchdogDesktopNotify);
    }
    this.open();
    const raw = this.getMeta("watchdog:desktop_notify", null);
    if (raw !== null) {
      return raw === "true" || raw === "1";
    }
    return Boolean(snap.values.watchdogDesktopNotify);
  }

  /** Enable or disable opt-in desktop stall notifications in SQLite meta */
  setWatchdogDesktopNotifyEnabled(enabled) {
    this.open();
    const boolVal = Boolean(enabled && enabled !== "false" && enabled !== "0");
    this.setMeta("watchdog:desktop_notify", boolVal ? "true" : "false");
    return boolVal;
  }

  /** Check if opt-in high-context KV-cache TTL expiry desktop alerts are enabled (default OFF; env > sqlite > config) */
  isTtlDesktopNotifyEnabled() {
    const snap = getConfigSnapshot();
    if (snap.sources.ttlDesktopNotify === "env") {
      return Boolean(snap.values.ttlDesktopNotify);
    }
    this.open();
    const raw = this.getMeta("cache:ttl_desktop_notify", null);
    if (raw !== null) {
      return raw === "true" || raw === "1";
    }
    return Boolean(snap.values.ttlDesktopNotify);
  }

  /** Enable or disable opt-in high-context KV-cache TTL expiry desktop alerts in SQLite meta */
  setTtlDesktopNotifyEnabled(enabled) {
    this.open();
    const boolVal = Boolean(enabled && enabled !== "false" && enabled !== "0");
    this.setMeta("cache:ttl_desktop_notify", boolVal ? "true" : "false");
    return boolVal;
  }

  /** Read cross-session empirical TTL calibration ring buffer for a single model profile */
  getModelTtlCalibration(profileId, nowMs = Date.now()) {
    if (typeof profileId !== "string") return null;
    const cleanId = profileId.trim();
    if (!cleanId || cleanId.length > 64 || !/^[A-Za-z0-9._-]+$/.test(cleanId)) return null;
    this.open();
    const raw = this.getMeta(`ttl_calibration:v1:${cleanId}`, null);
    if (!raw || typeof raw !== "string") return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      const maxAgeMs = 14 * 24 * 3600 * 1000;
      const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
      const updatedTs = Number.isFinite(parsed.updatedTs) ? Math.floor(parsed.updatedTs) : 0;
      if (updatedTs > 0 && safeNow - updatedTs > maxAgeMs) return null;
      const filterSamples = (arr, minSec) => {
        if (!Array.isArray(arr)) return [];
        const out = [];
        for (const item of arr) {
          if (!item || typeof item !== "object") continue;
          const gapSec = Number(item.gapSec);
          const atMs = Number.isFinite(item.atMs) ? Math.floor(item.atMs) : 0;
          if (!Number.isFinite(gapSec) || gapSec < minSec || gapSec > 14400) continue;
          if (atMs > 0 && safeNow - atMs > maxAgeMs) continue;
          out.push({
            gapSec: Math.round(gapSec),
            atMs,
            conv: typeof item.conv === "string" ? item.conv.slice(0, 96) : ""
          });
        }
        return out.slice(-20);
      };
      return {
        v: 1,
        profileId: cleanId,
        warm: filterSamples(parsed.warm, 180),
        cold: filterSamples(parsed.cold, 120),
        seen1hWrite: Boolean(parsed.seen1hWrite),
        updatedTs
      };
    } catch {
      return null;
    }
  }

  /** Read all fresh (<=14d) cross-session empirical TTL calibration records keyed by profileId */
  getAllModelTtlCalibrations(nowMs = Date.now()) {
    this.open();
    const out = {};
    try {
      const rows = this.db
        .prepare("SELECT key, value FROM meta WHERE key LIKE 'ttl_calibration:v1:%' ORDER BY key ASC")
        .all();
      const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
      const maxAgeMs = 14 * 24 * 3600 * 1000;
      for (const row of rows || []) {
        if (!row || typeof row.key !== "string" || typeof row.value !== "string") continue;
        const pid = row.key.slice("ttl_calibration:v1:".length).trim();
        if (!pid || pid.length > 64 || !/^[A-Za-z0-9._-]+$/.test(pid)) continue;
        try {
          const parsed = JSON.parse(row.value);
          if (!parsed || typeof parsed !== "object") continue;
          const updatedTs = Number.isFinite(parsed.updatedTs) ? Math.floor(parsed.updatedTs) : 0;
          if (updatedTs > 0 && safeNow - updatedTs > maxAgeMs) continue;
          const filterSamples = (arr, minSec) => {
            if (!Array.isArray(arr)) return [];
            const list = [];
            for (const item of arr) {
              if (!item || typeof item !== "object") continue;
              const gapSec = Number(item.gapSec);
              const atMs = Number.isFinite(item.atMs) ? Math.floor(item.atMs) : 0;
              if (!Number.isFinite(gapSec) || gapSec < minSec || gapSec > 14400) continue;
              if (atMs > 0 && safeNow - atMs > maxAgeMs) continue;
              list.push({
                gapSec: Math.round(gapSec),
                atMs,
                conv: typeof item.conv === "string" ? item.conv.slice(0, 96) : ""
              });
            }
            return list.slice(-20);
          };
          const warm = filterSamples(parsed.warm, 180);
          const cold = filterSamples(parsed.cold, 120);
          const seen1hWrite = Boolean(parsed.seen1hWrite);
          if (warm.length > 0 || cold.length > 0 || seen1hWrite) {
            out[pid] = {
              v: 1,
              profileId: pid,
              warm,
              cold,
              seen1hWrite,
              updatedTs
            };
          }
        } catch {}
      }
    } catch {}
    return out;
  }

  /** Append deduplicated warm/cold TTL observations into bounded (<=20 each) SQLite meta ring buffers */
  recordModelTtlObservations(observations, convId = "", nowMs = Date.now()) {
    if (!observations || typeof observations !== "object") return { updatedProfiles: 0 };
    this.open();
    const safeNow = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
    const safeConv =
      typeof convId === "string" ? convId.trim().replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 96) : "";
    const maxAgeMs = 14 * 24 * 3600 * 1000;
    let updatedProfiles = 0;

    for (const [rawPid, obs] of Object.entries(observations)) {
      if (!obs || typeof obs !== "object") continue;
      const pid = String(obs.profileId || rawPid || "").trim();
      if (!pid || pid.length > 64 || !/^[A-Za-z0-9._-]+$/.test(pid)) continue;

      const existing = this.getModelTtlCalibration(pid, safeNow) || {
        v: 1,
        profileId: pid,
        warm: [],
        cold: [],
        seen1hWrite: false,
        updatedTs: 0
      };

      const mergeRing = (prevList, incomingList, minSec) => {
        const merged = [];
        const seen = new Set();
        let addedNew = false;
        for (const item of prevList) {
          if (item.atMs > 0 && safeNow - item.atMs > maxAgeMs) continue;
          const k = `${item.conv || ""}:${item.atMs}:${item.gapSec}`;
          if (seen.has(k)) continue;
          seen.add(k);
          merged.push(item);
        }
        for (const rawItem of Array.isArray(incomingList) ? incomingList : []) {
          if (!rawItem || typeof rawItem !== "object") continue;
          const gapSec = Number(rawItem.gapSec);
          if (!Number.isFinite(gapSec) || gapSec < minSec || gapSec > 14400) continue;
          const roundedGap = Math.round(gapSec);
          const atMs = Number.isFinite(rawItem.atMs) && rawItem.atMs > 0 ? Math.floor(rawItem.atMs) : safeNow;
          if (safeNow - atMs > maxAgeMs) continue;
          const itemConv =
            typeof rawItem.conv === "string" && rawItem.conv.trim()
              ? rawItem.conv.trim().replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 96)
              : safeConv;
          const k = `${itemConv}:${atMs}:${roundedGap}`;
          if (seen.has(k)) continue;
          seen.add(k);
          addedNew = true;
          merged.push({ gapSec: roundedGap, atMs, conv: itemConv });
        }
        merged.sort((a, b) => a.atMs - b.atMs);
        return { list: merged.slice(-20), addedNew };
      };

      const warmRes = mergeRing(existing.warm, obs.warm, 180);
      const coldRes = mergeRing(existing.cold, obs.cold, 120);
      const next1h = Boolean(existing.seen1hWrite || obs.seen1hWrite);
      const changed = warmRes.addedNew || coldRes.addedNew || next1h !== existing.seen1hWrite;
      if (!changed) continue;

      const record = {
        v: 1,
        profileId: pid,
        warm: warmRes.list,
        cold: coldRes.list,
        seen1hWrite: next1h,
        updatedTs: safeNow
      };
      this.setMeta(`ttl_calibration:v1:${pid}`, JSON.stringify(record));
      updatedProfiles += 1;
    }

    return { updatedProfiles };
  }

  /** Read normalized one-time GitHub Star milestone prompt state from SQLite meta */
  getStarPromptState() {
    this.open();
    return normalizeStarPromptState(this.getMeta(STAR_PROMPT_META_KEY, null));
  }

  /** Count distinct non-sentinel sessions across recorded events and sources */
  getDistinctSessionCount() {
    this.open();
    const row = this.db
      .prepare(`
        SELECT COUNT(DISTINCT sid) AS cnt FROM (
          SELECT session_id AS sid FROM events
          WHERE session_id IS NOT NULL AND TRIM(session_id) != ''
            AND session_id NOT IN ('all', 'lifetime', 'app')
            AND COALESCE(key, '') != 'dedup_bypass'
          UNION
          SELECT session_id AS sid FROM sources
          WHERE session_id IS NOT NULL AND TRIM(session_id) != ''
            AND session_id NOT IN ('all', 'lifetime', 'app')
        )
      `)
      .get();
    const cnt = Number(row?.cnt || 0);
    return Number.isFinite(cnt) && cnt >= 0 ? Math.floor(cnt) : 0;
  }

  /** Record a passing cache:audit run in SQLite meta */
  recordCacheAuditPassed(atIso = new Date().toISOString()) {
    this.open();
    this.setMeta(CACHE_AUDIT_PASSED_META_KEY, String(atIso));
  }

  /** Check whether cache:audit has passed at least once */
  hasCacheAuditPassed() {
    this.open();
    return Boolean(this.getMeta(CACHE_AUDIT_PASSED_META_KEY, null));
  }

  /** Evaluate whether the one-time GitHub Star milestone banner should be shown */
  evaluateStarPrompt({ markTriggered = false, nowIso = null } = {}) {
    this.open();
    const current = this.getStarPromptState();
    const lifetimeStats = this.getStats("all");
    const lifetimeSavedBytes = Math.max(0, Math.floor(Number(lifetimeStats?.keptOutBytes || 0)));
    const lifetimeTokensSaved = Math.max(
      0,
      Math.floor(Number(lifetimeStats?.tokensKeptOut ?? Math.round(lifetimeSavedBytes / 4)))
    );
    const sessionCount = this.getDistinctSessionCount();
    const cacheAuditPassed = this.hasCacheAuditPassed();
    const savingsMilestoneMet =
      lifetimeSavedBytes >= STAR_PROMPT_MIN_SAVED_BYTES && sessionCount >= STAR_PROMPT_MIN_SESSIONS;
    const milestoneReached = savingsMilestoneMet || cacheAuditPassed;
    const triggerReason = savingsMilestoneMet
      ? "savings_milestone"
      : (cacheAuditPassed ? "cache_audit" : null);
    const shouldShow = current.state === "pending" && milestoneReached;

    let effective = current;
    if (shouldShow && markTriggered && !current.triggeredAt) {
      const next = {
        state: "pending",
        triggeredAt:
          typeof nowIso === "string" && nowIso.trim() ? nowIso.trim() : new Date().toISOString(),
        resolvedAt: null,
        milestoneSavedBytes: Math.max(current.milestoneSavedBytes, lifetimeSavedBytes)
      };
      this.setMeta(STAR_PROMPT_META_KEY, JSON.stringify(next));
      effective = next;
    }

    return {
      state: effective.state,
      triggeredAt: effective.triggeredAt,
      resolvedAt: effective.resolvedAt,
      milestoneSavedBytes: effective.milestoneSavedBytes,
      shouldShow,
      triggerReason,
      lifetimeSavedBytes,
      lifetimeTokensSaved,
      sessionCount,
      cacheAuditPassed,
      thresholds: {
        minSavedBytes: STAR_PROMPT_MIN_SAVED_BYTES,
        minSessions: STAR_PROMPT_MIN_SESSIONS
      }
    };
  }

  /** Persist a terminal starPrompt state ('clicked' | 'dismissed' | 'copied_cli') permanently */
  setStarPromptState(nextState, { nowIso = null } = {}) {
    if (typeof nextState !== "string" || !STAR_PROMPT_TERMINAL_STATES.includes(nextState)) {
      return {
        ok: false,
        error: "Invalid 'state' value: expected 'clicked', 'dismissed', or 'copied_cli'"
      };
    }
    this.open();
    const current = this.getStarPromptState();
    if (current.state !== "pending") {
      return { ok: true, starPrompt: current, alreadyResolved: true };
    }
    const ts = typeof nowIso === "string" && nowIso.trim() ? nowIso.trim() : new Date().toISOString();
    const lifetimeStats = this.getStats("all");
    const lifetimeSavedBytes = Math.max(0, Math.floor(Number(lifetimeStats?.keptOutBytes || 0)));
    const saved = {
      state: nextState,
      triggeredAt: current.triggeredAt || ts,
      resolvedAt: ts,
      milestoneSavedBytes: Math.max(current.milestoneSavedBytes, lifetimeSavedBytes)
    };
    this.setMeta(STAR_PROMPT_META_KEY, JSON.stringify(saved));
    return { ok: true, starPrompt: saved, alreadyResolved: false };
  }

  /**
   * TTL-based database maintenance & optional VACUUM (inspired by antigravity-panel).
   * Keeps ~/.agy-dart/context.db lean across months of heavy usage.
   */
  pruneByTtl({ maxAgeDays = 14, vacuum = false } = {}) {
    this.open();
    const rawStr = maxAgeDays === null || maxAgeDays === undefined ? "" : String(maxAgeDays).trim();
    const parsedDays = rawStr === "" ? NaN : Number(rawStr);
    const days = Number.isFinite(parsedDays) && parsedDays >= 0 ? parsedDays : 14;
    const now = Date.now();
    const cutoffTs = now - days * 24 * 3600 * 1000;
    const cutoffIso = new Date(cutoffTs).toISOString();
    const readsCutoffTs = now - 24 * 3600 * 1000;
    const repoCacheCutoffTs = now - 30 * 24 * 3600 * 1000;

    const getDiskSize = () => {
      let total = 0;
      try { total += fs.statSync(this.dbPath).size; } catch {}
      try { total += fs.statSync(`${this.dbPath}-wal`).size; } catch {}
      return total;
    };

    const bytesBefore = getDiskSize();
    const txStats = this._withWriteTx(() => {
      const staleSources = this.db
        .prepare("SELECT id FROM sources WHERE accessed_ts < ?")
        .all(cutoffTs)
        .map((r) => r.id);

      // Batch deletes in groups of 400 to stay safely below SQLite's SQLITE_MAX_VARIABLE_NUMBER limit
      for (let i = 0; i < staleSources.length; i += 400) {
        const batch = staleSources.slice(i, i + 400);
        const placeholders = batch.map(() => "?").join(",");
        this.db.prepare(`DELETE FROM chunks WHERE source_id IN (${placeholders})`).run(...batch);
        this.db.prepare(`DELETE FROM chunks_tri WHERE source_id IN (${placeholders})`).run(...batch);
        this.db.prepare(`DELETE FROM sources WHERE id IN (${placeholders})`).run(...batch);
      }

      const evRes = this.db.prepare("DELETE FROM events WHERE created_at < ?").run(cutoffIso);
      const readRes = this.db.prepare("DELETE FROM file_reads WHERE read_ts < ?").run(readsCutoffTs);
      const snapRes = this.db.prepare("DELETE FROM file_snapshots WHERE updated_ts < ?").run(readsCutoffTs);
      const ghostRes = this.db.prepare("DELETE FROM ghost_interceptions WHERE blocked_ts < ?").run(cutoffTs);
      const cpRes = this.db.prepare("DELETE FROM session_checkpoints WHERE updated_ts < ?").run(cutoffTs);
      const outlineRes = this.db.prepare("DELETE FROM outline_cache WHERE updated_ts < ?").run(cutoffTs);
      this.db.prepare("DELETE FROM repo_cache WHERE updated_ts < ?").run(repoCacheCutoffTs);

      // Prune stale per-session PreInvocation alert/compaction/sensitive-file/large-read-confirm/watchdog meta keys so meta stays bounded
      try {
        const confirmCutoffTs = now - 10 * 60 * 1000;
        const leaseCutoffTs = Math.min(cutoffTs, now - 24 * 3600 * 1000);
        const metaRows = this.db
          .prepare(
            "SELECT key, value FROM meta WHERE key LIKE 'cache_alert:%' OR key LIKE 'compact_invalidated:%' OR key LIKE 'sensitive_read_confirm:%' OR key LIKE 'large_read_confirm:%' OR key LIKE 'conv_turn_seq:%' OR key LIKE 'watchdog_lease:%' OR key LIKE 'ttl_calibration:%'"
          )
          .all();
        const delMetaStmt = this.db.prepare("DELETE FROM meta WHERE key = ?");
        for (const row of metaRows) {
          let entryTs = 0;
          if (typeof row.value === "string" && row.value.startsWith("{")) {
            try {
              const p = JSON.parse(row.value);
              if (p && Number.isFinite(p.updatedTs)) entryTs = p.updatedTs;
              else if (p && Number.isFinite(p.ts)) entryTs = p.ts;
            } catch {}
          }
          const isShortConfirm =
            row.key.startsWith("large_read_confirm:") || row.key.startsWith("sensitive_read_confirm:");
          const isWatchdogLease = row.key.startsWith("watchdog_lease:");
          if (isShortConfirm) {
            if (entryTs <= 0 || entryTs < confirmCutoffTs) {
              delMetaStmt.run(row.key);
            }
          } else if (isWatchdogLease) {
            if (entryTs <= 0 || entryTs < (days === 0 ? cutoffTs : leaseCutoffTs)) {
              delMetaStmt.run(row.key);
            }
          } else if (entryTs > 0 && entryTs < cutoffTs) {
            delMetaStmt.run(row.key);
          }
        }
      } catch {}

      this.db
        .prepare("INSERT INTO meta(key, value) VALUES ('last_maintenance_ts', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(now));

      return {
        deletedSources: staleSources.length,
        deletedEvents: evRes.changes || 0,
        deletedFileReads: readRes.changes || 0,
        deletedFileSnapshots: snapRes.changes || 0,
        deletedGhostInterceptions: ghostRes.changes || 0,
        deletedCheckpoints: cpRes.changes || 0,
        deletedOutlineCache: outlineRes.changes || 0
      };
    });

    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {}

    let vacuumed = false;
    if (vacuum) {
      try {
        this.db.exec("VACUUM;");
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        vacuumed = true;
      } catch {}
    }

    const bytesAfter = getDiskSize();

    return {
      ok: true,
      purged: "stale",
      maxAgeDays: days,
      ...txStats,
      bytesBefore,
      bytesAfter,
      reclaimedBytes: Math.max(0, bytesBefore - bytesAfter),
      vacuumed
    };
  }

  /** Lightweight daily auto-maintenance hook (at most once per 24h, fail-open) */
  maybeRunDailyMaintenance(maxAgeDays = 14) {
    try {
      this.open();
      const last = Number(this.getMeta("last_maintenance_ts", "0") || "0");
      if (Date.now() - last < 24 * 3600 * 1000) return null;
      return this.pruneByTtl({ maxAgeDays, vacuum: false });
    } catch {
      return null;
    }
  }

  /**
   * Automatic LRU pruning: limits the number of indexed sources and chunks
   * to avoid unbounded database expansion.
   */
  pruneStaleSources({ maxSourcesPerSession = 50, maxTotalSources = 200 } = {}) {
    this.open();
    try {
      const deleteSourceIds = (ids) => {
        if (!ids || ids.length === 0) return;
        this._withWriteTx(() => {
          for (let i = 0; i < ids.length; i += 400) {
            const batch = ids.slice(i, i + 400);
            const placeholders = batch.map(() => "?").join(",");
            this.db.prepare(`DELETE FROM chunks WHERE source_id IN (${placeholders})`).run(...batch);
            this.db.prepare(`DELETE FROM chunks_tri WHERE source_id IN (${placeholders})`).run(...batch);
            this.db.prepare(`DELETE FROM sources WHERE id IN (${placeholders})`).run(...batch);
          }
        });
      };

      // 1. Prune sources exceeding per-session cap (LRU by accessed_ts)
      const excessSessionSources = this.db
        .prepare(`
          SELECT id FROM sources
          WHERE id NOT IN (
            SELECT id FROM sources s2
            WHERE s2.session_id = sources.session_id
            ORDER BY s2.accessed_ts DESC, s2.created_ts DESC
            LIMIT ?
          )
        `)
        .all(maxSourcesPerSession);

      if (excessSessionSources.length > 0) {
        deleteSourceIds(excessSessionSources.map((r) => r.id));
      }

      // 2. Prune global total sources if over cap (LRU by accessed_ts)
      const totalCountRow = this.db.prepare("SELECT count(*) as count FROM sources").get();
      if (totalCountRow && totalCountRow.count > maxTotalSources) {
        const deleteCount = totalCountRow.count - maxTotalSources;
        const oldest = this.db
          .prepare("SELECT id FROM sources ORDER BY accessed_ts ASC, created_ts ASC LIMIT ?")
          .all(deleteCount);

        if (oldest.length > 0) {
          deleteSourceIds(oldest.map((r) => r.id));
        }
      }
    } catch {
      // Best-effort auto-prune
    }
  }
}
