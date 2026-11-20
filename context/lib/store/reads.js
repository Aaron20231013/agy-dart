import { createHash } from "node:crypto";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  DEFAULT_FILE_READ_MAX_AGE_MS,
  MAX_SNAPSHOTS_PER_SESSION,
  MAX_SNAPSHOT_BYTES
} from "./schema.js";

export class ReadMethods {
  /** Normalize absolute file paths consistently across OSes for dedup/invalidation */
  _normalizeTrackPath(filePath) {
    if (!filePath) return "";
    const resolved = path.resolve(String(filePath)).replace(/\\/g, "/");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  /** Return monotonic per-conversation read/tool sequence counter (used for diff-read turn-gap freshness) */
  getConversationTurnSeq(sessionId) {
    this.open();
    const sid = sessionId || "default";
    const raw = this.getTimedMeta(`conv_turn_seq:${sid}`, "0");
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }

  /** Increment and return monotonic per-conversation sequence counter */
  bumpConversationTurnSeq(sessionId) {
    this.open();
    const sid = sessionId || "default";
    return this._withBusyRetry(() => {
      const next = this.getConversationTurnSeq(sid) + 1;
      this.setTimedMeta(`conv_turn_seq:${sid}`, String(next));
      return next;
    });
  }

  /**
   * Look up whether an unchanged file range was already read in this session.
   * Returns the covering row ({ start_line, end_line, byte_est, read_ts, bypass_armed }) or null.
   */
  findDuplicateRead({
    sessionId,
    filePath,
    startLine = 1,
    endLine = null,
    mtimeMs,
    fileSize,
    maxAgeMs = DEFAULT_FILE_READ_MAX_AGE_MS
  }) {
    this.open();
    const sid = sessionId || "default";
    const norm = this._normalizeTrackPath(filePath);
    if (!norm) return null;

    const reqStart = Number.isFinite(startLine) && startLine > 0 ? startLine : 1;
    const reqEnd = Number.isFinite(endLine) && endLine > 0 ? endLine : -1; // -1 == EOF
    const hasCutoff = Number.isFinite(maxAgeMs) && maxAgeMs > 0;
    const minTs = hasCutoff ? Date.now() - maxAgeMs : 0;

    const rows = this.db
      .prepare(`
        SELECT start_line, end_line, mtime_ms, file_size, byte_est, read_ts, bypass_armed
        FROM file_reads
        WHERE session_id = ? AND file_path = ?
      `)
      .all(sid, norm);

    let fallbackMatch = null;
    for (const row of rows) {
      if (Math.abs(Number(row.mtime_ms) - Number(mtimeMs)) > 1 || Number(row.file_size) !== Number(fileSize)) {
        continue;
      }
      if (hasCutoff && Number(row.read_ts) < minTs) continue;
      const coversStart = Number(row.start_line) <= reqStart;
      const coversEnd = Number(row.end_line) === -1 || (reqEnd !== -1 && Number(row.end_line) >= reqEnd);
      if (coversStart && coversEnd) {
        // Prioritize any armed covering row so a 2-strike retry ALWAYS succeeds even when multiple covering rows exist
        if (Number(row.bypass_armed) === 1) {
          return row;
        }
        if (!fallbackMatch || (Number(row.start_line) === reqStart && Number(row.end_line) === reqEnd)) {
          fallbackMatch = row;
        }
      }
    }
    return fallbackMatch;
  }

  /** Arm the 2-strike bypass flag on a matched file_reads entry so an immediate retry succeeds */
  armReadBypass({ sessionId, filePath, startLine, endLine }) {
    this.open();
    const sid = sessionId || "default";
    const norm = this._normalizeTrackPath(filePath);
    if (!norm) return;
    this._withBusyRetry(() => {
      this.db
        .prepare(`
          UPDATE file_reads SET bypass_armed = 1
          WHERE session_id = ? AND file_path = ? AND start_line = ? AND end_line = ?
        `)
        .run(sid, norm, startLine, endLine);
    });
  }

  /** Record an allowed file read in the session read tracker */
  recordFileRead({ sessionId, filePath, startLine = 1, endLine = null, mtimeMs, fileSize, byteEst = 0 }) {
    this.open();
    const sid = sessionId || "default";
    const norm = this._normalizeTrackPath(filePath);
    if (!norm) return;
    const reqStart = Number.isFinite(startLine) && startLine > 0 ? startLine : 1;
    const reqEnd = Number.isFinite(endLine) && endLine > 0 ? endLine : -1;
    const now = Date.now();

    this._withBusyRetry(() => {
      // Evict stale versions of this file in this session
      this.db
        .prepare(`
          DELETE FROM file_reads
          WHERE session_id = ? AND file_path = ? AND (ABS(mtime_ms - ?) > 1 OR file_size != ?)
        `)
        .run(sid, norm, mtimeMs, fileSize);

      // Consume any armed 2-strike bypass across all covering rows for this file so superset rows don't stay bypassed forever
      this.db
        .prepare(`
          UPDATE file_reads SET bypass_armed = 0
          WHERE session_id = ? AND file_path = ? AND bypass_armed != 0
        `)
        .run(sid, norm);

      this.db
        .prepare(`
          INSERT INTO file_reads (session_id, file_path, start_line, end_line, mtime_ms, file_size, byte_est, read_ts, bypass_armed)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
          ON CONFLICT(session_id, file_path, start_line, end_line) DO UPDATE SET
            mtime_ms = excluded.mtime_ms,
            file_size = excluded.file_size,
            byte_est = excluded.byte_est,
            read_ts = excluded.read_ts,
            bypass_armed = 0
        `)
        .run(sid, norm, reqStart, reqEnd, mtimeMs, fileSize, byteEst, now);
    });
  }

  /**
   * Invalidate tracked file reads for one file (after edit, keeping file_snapshots as diff baseline)
   * or an entire session (after compaction / ctx_resume, clearing BOTH file_reads and file_snapshots).
   */
  invalidateFileReads(sessionId, filePath = null) {
    this.open();
    const sid = sessionId || "default";
    return this._withBusyRetry(() => {
      if (filePath) {
        const norm = this._normalizeTrackPath(filePath);
        if (!norm) return 0;
        const res = this.db
          .prepare("DELETE FROM file_reads WHERE session_id = ? AND file_path = ?")
          .run(sid, norm);
        return res.changes || 0;
      }
      const res = this.db.prepare("DELETE FROM file_reads WHERE session_id = ?").run(sid);
      this.db.prepare("DELETE FROM file_snapshots WHERE session_id = ?").run(sid);
      return res.changes || 0;
    });
  }

  /**
   * Save a gzip-compressed baseline snapshot of a text range (<= 256 KB) for compact
   * unified-diff re-reads when the file is later modified in the same session.
   * Enforces per-session LRU cap so SQLite stays lean.
   */
  saveFileSnapshot({
    sessionId,
    filePath,
    startLine = 1,
    endLine = null,
    sha256 = null,
    mtimeMs = 0,
    fileSize = 0,
    content,
    bypassArmed = 0,
    fullReadTs = null,
    fullReadSeq = null,
    maxSnapshotsPerSession = MAX_SNAPSHOTS_PER_SESSION
  }) {
    this.open();
    const sid = sessionId || "default";
    const norm = this._normalizeTrackPath(filePath);
    if (!norm || typeof content !== "string") {
      return { saved: false, reason: "invalid" };
    }
    const rawBytes = Buffer.byteLength(content, "utf8");
    if (rawBytes > MAX_SNAPSHOT_BYTES) {
      return { saved: false, reason: "too_large", rawBytes };
    }
    const reqStart = Number.isFinite(startLine) && startLine > 0 ? Math.floor(startLine) : 1;
    const reqEnd = Number.isFinite(endLine) && endLine > 0 ? Math.floor(endLine) : -1;
    const digest = sha256 || createHash("sha256").update(content, "utf8").digest("hex");
    const contentGz = gzipSync(Buffer.from(content, "utf8"), { level: 1 });
    const now = Date.now();
    const armed = bypassArmed ? 1 : 0;
    const effFullReadTs = Number.isFinite(fullReadTs) && fullReadTs > 0 ? Math.floor(fullReadTs) : now;
    const effFullReadSeq =
      Number.isFinite(fullReadSeq) && fullReadSeq >= 0
        ? Math.floor(fullReadSeq)
        : this.getConversationTurnSeq(sid);
    const cap = Number.isFinite(maxSnapshotsPerSession) && maxSnapshotsPerSession > 0
      ? Math.floor(maxSnapshotsPerSession)
      : MAX_SNAPSHOTS_PER_SESSION;

    this._withBusyRetry(() => {
      // Evict strictly covered older subset snapshots so a newer superset read is never shadowed
      this.db
        .prepare(`
          DELETE FROM file_snapshots
          WHERE session_id = ? AND file_path = ?
            AND start_line >= ?
            AND (? = -1 OR (end_line != -1 AND end_line <= ?))
            AND NOT (start_line = ? AND end_line = ?)
        `)
        .run(sid, norm, reqStart, reqEnd, reqEnd, reqStart, reqEnd);

      this.db
        .prepare(`
          INSERT INTO file_snapshots (
            session_id, file_path, start_line, end_line, sha256, mtime_ms, file_size, raw_bytes, content_gz, updated_ts, bypass_armed, full_read_ts, full_read_seq
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id, file_path, start_line, end_line) DO UPDATE SET
            sha256 = excluded.sha256,
            mtime_ms = excluded.mtime_ms,
            file_size = excluded.file_size,
            raw_bytes = excluded.raw_bytes,
            content_gz = excluded.content_gz,
            updated_ts = excluded.updated_ts,
            bypass_armed = excluded.bypass_armed,
            full_read_ts = excluded.full_read_ts,
            full_read_seq = excluded.full_read_seq
        `)
        .run(sid, norm, reqStart, reqEnd, digest, mtimeMs, fileSize, rawBytes, contentGz, now, armed, effFullReadTs, effFullReadSeq);

      // Enforce bounded per-session LRU snapshot cap
      const countRow = this.db
        .prepare("SELECT COUNT(*) AS cnt FROM file_snapshots WHERE session_id = ?")
        .get(sid);
      if (countRow && countRow.cnt > cap) {
        const excess = countRow.cnt - cap;
        this.db
          .prepare(`
            DELETE FROM file_snapshots
            WHERE rowid IN (
              SELECT rowid FROM file_snapshots
              WHERE session_id = ?
              ORDER BY updated_ts ASC, rowid ASC
              LIMIT ?
            )
          `)
          .run(sid, excess);
      }
    });

    return {
      saved: true,
      sha256: digest,
      rawBytes,
      compressedBytes: contentGz.length,
      startLine: reqStart,
      endLine: reqEnd
    };
  }

  /**
   * Look up the freshest exact or covering file snapshot for `[startLine..endLine]`.
   * Returns decompressed `{ start_line, end_line, sha256, mtime_ms, file_size, raw_bytes, updated_ts, bypass_armed, content, isExactRange }` or null.
   */
  findFileSnapshot({
    sessionId,
    filePath,
    startLine = 1,
    endLine = null,
    maxAgeMs = DEFAULT_FILE_READ_MAX_AGE_MS
  }) {
    this.open();
    const sid = sessionId || "default";
    const norm = this._normalizeTrackPath(filePath);
    if (!norm) return null;

    const reqStart = Number.isFinite(startLine) && startLine > 0 ? Math.floor(startLine) : 1;
    const reqEnd = Number.isFinite(endLine) && endLine > 0 ? Math.floor(endLine) : -1;
    const hasCutoff = Number.isFinite(maxAgeMs) && maxAgeMs > 0;
    const minTs = hasCutoff ? Date.now() - maxAgeMs : 0;

    const rows = this.db
      .prepare(`
        SELECT start_line, end_line, sha256, mtime_ms, file_size, raw_bytes, content_gz, updated_ts, bypass_armed, full_read_ts, full_read_seq
        FROM file_snapshots
        WHERE session_id = ? AND file_path = ?
      `)
      .all(sid, norm);

    const candidates = [];
    for (const row of rows) {
      if (hasCutoff && Number(row.updated_ts) < minTs) continue;
      const coversStart = Number(row.start_line) <= reqStart;
      const coversEnd = Number(row.end_line) === -1 || (reqEnd !== -1 && Number(row.end_line) >= reqEnd);
      if (coversStart && coversEnd) {
        candidates.push(row);
      }
    }
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      const tsDiff = Number(b.updated_ts) - Number(a.updated_ts);
      if (tsDiff !== 0) return tsDiff;
      const aExact = Number(a.start_line) === reqStart && Number(a.end_line) === reqEnd ? 1 : 0;
      const bExact = Number(b.start_line) === reqStart && Number(b.end_line) === reqEnd ? 1 : 0;
      if (bExact !== aExact) return bExact - aExact;
      const armedDiff = Number(b.bypass_armed) - Number(a.bypass_armed);
      if (armedDiff !== 0) return armedDiff;
      const aSpan = Number(a.end_line) === -1 ? Number.MAX_SAFE_INTEGER : Number(a.end_line) - Number(a.start_line);
      const bSpan = Number(b.end_line) === -1 ? Number.MAX_SAFE_INTEGER : Number(b.end_line) - Number(b.start_line);
      return aSpan - bSpan;
    });

    for (const row of candidates) {
      try {
        const content = gunzipSync(row.content_gz).toString("utf8");
        return {
          start_line: Number(row.start_line),
          end_line: Number(row.end_line),
          sha256: row.sha256,
          mtime_ms: Number(row.mtime_ms),
          file_size: Number(row.file_size),
          raw_bytes: Number(row.raw_bytes),
          updated_ts: Number(row.updated_ts),
          bypass_armed: Number(row.bypass_armed),
          full_read_ts: Number(row.full_read_ts || row.updated_ts || 0),
          full_read_seq: Number(row.full_read_seq || 0),
          content,
          isExactRange: Number(row.start_line) === reqStart && Number(row.end_line) === reqEnd
        };
      } catch {
        // Skip corrupt compressed snapshot fail-open
      }
    }
    return null;
  }

  /** Arm or clear the 2-strike full-file bypass flag on a stored file_snapshots row */
  armSnapshotBypass({ sessionId, filePath, startLine = 1, endLine = null, armed = 1 }) {
    this.open();
    const sid = sessionId || "default";
    const norm = this._normalizeTrackPath(filePath);
    if (!norm) return 0;
    const reqStart = Number.isFinite(startLine) && startLine > 0 ? Math.floor(startLine) : 1;
    const reqEnd = Number.isFinite(endLine) && endLine > 0 ? Math.floor(endLine) : -1;
    const flag = armed ? 1 : 0;
    return this._withBusyRetry(() => {
      const res = this.db
        .prepare(`
          UPDATE file_snapshots SET bypass_armed = ?
          WHERE session_id = ? AND file_path = ? AND start_line = ? AND end_line = ?
        `)
        .run(flag, sid, norm, reqStart, reqEnd);
      return res.changes || 0;
    });
  }

  /** Clear stored file snapshots for one file or an entire session */
  clearFileSnapshots(sessionId, filePath = null) {
    this.open();
    const sid = sessionId || "default";
    return this._withBusyRetry(() => {
      if (filePath) {
        const norm = this._normalizeTrackPath(filePath);
        if (!norm) return 0;
        const res = this.db
          .prepare("DELETE FROM file_snapshots WHERE session_id = ? AND file_path = ?")
          .run(sid, norm);
        return res.changes || 0;
      }
      const res = this.db.prepare("DELETE FROM file_snapshots WHERE session_id = ?").run(sid);
      return res.changes || 0;
    });
  }

  /** Record a large-file interception in the Ghost Registry to track subsequent paged recalls */
  recordGhostInterception({ sessionId, filePath, fileSize = 0, cutoffBytes = 16384 }) {
    this.open();
    const sid = sessionId || "default";
    const norm = this._normalizeTrackPath(filePath);
    if (!norm) return;
    const now = Date.now();
    this.db
      .prepare(`
        INSERT INTO ghost_interceptions (session_id, file_path, file_size, cutoff_bytes, blocked_ts, recall_reads, recall_bytes)
        VALUES (?, ?, ?, ?, ?, 0, 0)
        ON CONFLICT(session_id, file_path) DO UPDATE SET
          file_size = excluded.file_size,
          cutoff_bytes = excluded.cutoff_bytes,
          blocked_ts = excluded.blocked_ts
      `)
      .run(
        sid,
        norm,
        Math.max(0, Math.round(Number(fileSize) || 0)),
        Math.max(0, Math.round(Number(cutoffBytes) || 0)),
        now
      );
  }

  /** Check if a file has an active Ghost Registry interception row for this session */
  hasGhostInterception(sessionId, filePath) {
    this.open();
    const sid = sessionId || "default";
    const norm = this._normalizeTrackPath(filePath);
    if (!norm) return false;
    const row = this.db
      .prepare("SELECT 1 FROM ghost_interceptions WHERE session_id = ? AND file_path = ? LIMIT 1")
      .get(sid, norm);
    return Boolean(row);
  }

  /** Record a subsequent paged read against a previously intercepted file (no-op if never blocked) */
  recordGhostRecall({ sessionId, filePath, bytesRead = 0 }) {
    this.open();
    const sid = sessionId || "default";
    const norm = this._normalizeTrackPath(filePath);
    if (!norm) return 0;
    const addBytes = Math.max(0, Math.round(Number(bytesRead) || 0));
    const res = this.db
      .prepare(`
        UPDATE ghost_interceptions
        SET recall_reads = recall_reads + 1,
            recall_bytes = recall_bytes + ?
        WHERE session_id = ? AND file_path = ?
      `)
      .run(addBytes, sid, norm);
    return res.changes || 0;
  }

  /** Compute Ghost Registry eviction efficiency and threshold tuning advice */
  getGhostStats(sessionId, options = {}) {
    this.open();
    const sid = sessionId || "default";
    const sinceTs = Number.isFinite(options.sinceTs) ? options.sinceTs : null;

    let row;
    if (sid === "all" || sid === "lifetime") {
      row = this.db
        .prepare(`
          SELECT
            COUNT(*) AS total_blocked,
            COALESCE(SUM(CASE WHEN recall_reads >= 2 AND file_size > 0 AND recall_bytes >= file_size * 0.7 THEN 1 ELSE 0 END), 0) AS ghost_recalls
          FROM ghost_interceptions
        `)
        .get();
    } else if (sid === "app" && sinceTs !== null) {
      row = this.db
        .prepare(`
          SELECT
            COUNT(*) AS total_blocked,
            COALESCE(SUM(CASE WHEN recall_reads >= 2 AND file_size > 0 AND recall_bytes >= file_size * 0.7 THEN 1 ELSE 0 END), 0) AS ghost_recalls
          FROM ghost_interceptions
          WHERE blocked_ts >= ?
        `)
        .get(sinceTs);
    } else {
      row = this.db
        .prepare(`
          SELECT
            COUNT(*) AS total_blocked,
            COALESCE(SUM(CASE WHEN recall_reads >= 2 AND file_size > 0 AND recall_bytes >= file_size * 0.7 THEN 1 ELSE 0 END), 0) AS ghost_recalls
          FROM ghost_interceptions
          WHERE session_id = ?
        `)
        .get(sid);
    }

    const totalBlocked = Number(row?.total_blocked || 0);
    const ghostRecalls = Number(row?.ghost_recalls || 0);
    const evictionEfficiency = totalBlocked > 0 ? Number((1 - ghostRecalls / totalBlocked).toFixed(4)) : 1;
    const currentCutoff = this.getCutoff(sid === "all" || sid === "lifetime" ? null : sid);
    const recommendation =
      totalBlocked >= 3 && evictionEfficiency < 0.65 && currentCutoff > 0 && currentCutoff < 32768
        ? "Cutoff may be too tight for this repo; consider switching to 32 KB (fast-32k)."
        : null;

    return {
      totalBlocked,
      ghostRecalls,
      evictionEfficiency,
      currentCutoff,
      recommendation
    };
  }
}
