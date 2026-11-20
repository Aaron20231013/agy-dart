import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";

export const MAX_CHUNK_BYTES = 4096;
export const SNIPPET_MAX_BYTES = 800;
export const RRF_K = 60;
export const STATE_BUDGET = 2048;
export const MAX_SNAPSHOT_BYTES = 256 * 1024;
export const MAX_SNAPSHOTS_PER_SESSION = 64;
export const MAX_OUTLINE_CACHE_DB_ENTRIES = 512;
export const MAX_OUTLINE_JSON_BYTES = 128 * 1024;
export const DEFAULT_FILE_READ_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const FILE_CATEGORIES = {
  images: {
    id: "images",
    name: "Images",
    extensions: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".tiff", ".psd"]
  },
  documents: {
    id: "documents",
    name: "Documents",
    extensions: [".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".odt", ".rtf"]
  },
  code: {
    id: "code",
    name: "Source Code",
    extensions: [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".cs", ".html", ".css", ".json", ".yaml", ".yml", ".sql", ".sh", ".ps1"]
  },
  models3d: {
    id: "models3d",
    name: "3D Models",
    extensions: [".blend", ".fbx", ".obj", ".gltf", ".glb", ".stl", ".dae", ".3ds", ".step", ".iges"]
  },
  music: {
    id: "music",
    name: "Music",
    extensions: [".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a", ".wma", ".midi"]
  },
  video: {
    id: "video",
    name: "Video",
    extensions: [".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv", ".m4v"]
  },
  archives: {
    id: "archives",
    name: "Archives",
    extensions: [".zip", ".tar", ".gz", ".7z", ".rar", ".wasm"]
  }
};

export const DEFAULT_ACTIVE_CATEGORIES = ["images", "documents", "models3d", "music", "video", "archives"];

export const DEFAULT_EXEMPT_EXTENSIONS = Array.from(
  new Set(
    DEFAULT_ACTIVE_CATEGORIES.flatMap((catId) => FILE_CATEGORIES[catId]?.extensions || [])
  )
);

/** Truncate string strictly by UTF-8 byte length without splitting multi-byte chars */
export function truncateUtf8Bytes(text, maxBytes) {
  if (!text) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const sliced = Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes)).toString("utf8");
  return sliced.replace(/\uFFFD+$/, "");
}

/** Default path to context database (~/.agy-dart/context.db) */
export function getDefaultDbPath() {
  if (process.env.AGY_DART_DB_PATH && process.env.AGY_DART_DB_PATH.trim()) {
    return process.env.AGY_DART_DB_PATH.trim();
  }
  if (process.env.CONTEXT_MODE_DB_PATH && process.env.CONTEXT_MODE_DB_PATH.trim()) {
    return process.env.CONTEXT_MODE_DB_PATH.trim();
  }
  const dir = path.join(os.homedir(), ".agy-dart");
  return path.join(dir, "context.db");
}

/** Sanitize an input query string for safe FTS5 queries */
export function sanitizeFtsQuery(query) {
  if (!query || typeof query !== "string") return "";
  const cleaned = query.trim().replace(/[\x00-\x1f]/g, " ");
  const tokens = cleaned.match(/[a-zA-Z0-9_\u0080-\uffff]+/g);
  if (!tokens || tokens.length === 0) return "";
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

/** Sanitize query specifically for trigram index (must have at least 3 characters) */
export function sanitizeTrigramQuery(query) {
  if (!query || typeof query !== "string") return "";
  const tokens = query.match(/[a-zA-Z0-9_\u0080-\uffff]{3,}/g);
  if (!tokens || tokens.length === 0) return "";
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
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

  /** Initialize tables, FTS5 virtual tables, and indexes */
  initSchema() {
    if (!this.db) return;
    try {
      this.db.exec("PRAGMA busy_timeout = 5000;");
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA synchronous = NORMAL;");
    } catch {
      // Fallback if PRAGMA configuration is restricted
    }

    // Standard tables
    this._withBusyRetry(() => {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        worktree TEXT NOT NULL,
        agent TEXT NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        bytes_total INTEGER NOT NULL DEFAULT 0,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        created_ts INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        accessed_ts INTEGER NOT NULL,
        content_hash TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sources_session ON sources(session_id);
      CREATE INDEX IF NOT EXISTS idx_sources_worktree ON sources(worktree);

      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        worktree TEXT NOT NULL,
        agent TEXT NOT NULL,
        kind TEXT NOT NULL,
        tool TEXT,
        key TEXT,
        path TEXT,
        ok INTEGER NOT NULL DEFAULT 1,
        exit_code INTEGER,
        bytes INTEGER NOT NULL DEFAULT 0,
        body TEXT,
        turn INTEGER NOT NULL DEFAULT 0,
        sandbox_bytes INTEGER NOT NULL DEFAULT 0,
        returned_bytes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        accessed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_turn ON events(session_id, turn);

      CREATE TABLE IF NOT EXISTS file_reads (
        session_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        file_size INTEGER NOT NULL,
        byte_est INTEGER NOT NULL DEFAULT 0,
        read_ts INTEGER NOT NULL,
        bypass_armed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, file_path, start_line, end_line)
      );

      CREATE INDEX IF NOT EXISTS idx_file_reads_session_path ON file_reads(session_id, file_path);

      CREATE TABLE IF NOT EXISTS file_snapshots (
        session_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        file_size INTEGER NOT NULL,
        raw_bytes INTEGER NOT NULL DEFAULT 0,
        content_gz BLOB NOT NULL,
        updated_ts INTEGER NOT NULL,
        bypass_armed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, file_path, start_line, end_line)
      );

      CREATE INDEX IF NOT EXISTS idx_file_snapshots_session_path ON file_snapshots(session_id, file_path);

      CREATE TABLE IF NOT EXISTS repo_cache (
        workspace_dir TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_ts INTEGER NOT NULL,
        PRIMARY KEY (workspace_dir, head_sha, kind)
      );

      CREATE TABLE IF NOT EXISTS ghost_interceptions (
        session_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size INTEGER NOT NULL DEFAULT 0,
        cutoff_bytes INTEGER NOT NULL DEFAULT 16384,
        blocked_ts INTEGER NOT NULL,
        recall_reads INTEGER NOT NULL DEFAULT 0,
        recall_bytes INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, file_path)
      );

      CREATE INDEX IF NOT EXISTS idx_ghost_session ON ghost_interceptions(session_id);

      CREATE TABLE IF NOT EXISTS session_checkpoints (
        session_id TEXT PRIMARY KEY,
        worktree TEXT NOT NULL DEFAULT '',
        modified_files_json TEXT NOT NULL DEFAULT '[]',
        last_test_json TEXT,
        last_build_json TEXT,
        updated_ts INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_checkpoints_updated ON session_checkpoints(updated_ts);

      CREATE TABLE IF NOT EXISTS outline_cache (
        file_path TEXT PRIMARY KEY,
        mtime_ms REAL NOT NULL,
        file_size INTEGER NOT NULL,
        line_count INTEGER NOT NULL,
        symbols_json TEXT NOT NULL,
        updated_ts INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_outline_cache_updated ON outline_cache(updated_ts);
    `);

      // Idempotent schema upgrade: ensure sources.content_hash exists on legacy v2/v3 databases
      const sourceCols = this.db.prepare("PRAGMA table_info(sources)").all();
      if (!sourceCols.some((c) => c.name === "content_hash")) {
        try {
          this.db.exec("ALTER TABLE sources ADD COLUMN content_hash TEXT;");
        } catch (err) {
          if (!/duplicate column name/i.test(String(err?.message || ""))) throw err;
        }
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_sources_session_hash ON sources(session_id, content_hash);");
    });

    // Virtual FTS5 tables
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        source_id UNINDEXED,
        session_id UNINDEXED,
        worktree UNINDEXED,
        agent UNINDEXED,
        ord UNINDEXED,
        body,
        title,
        tokenize = 'porter unicode61 remove_diacritics 2'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_tri USING fts5(
        source_id UNINDEXED,
        session_id UNINDEXED,
        ord UNINDEXED,
        body,
        tokenize = 'trigram'
      );
    `);

    const versionRow = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (!versionRow) {
      this.db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '3')").run();
    } else if (versionRow.value !== "3") {
      this.db.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
    }
  }

  /** Safely split an oversized single line into <= maxBytes UTF-8 slices */
  _splitOversizedLine(line, maxBytes) {
    const parts = [];
    let buf = Buffer.from(line, "utf8");
    while (buf.length > maxBytes) {
      let cut = maxBytes;
      // Back up if we landed on a UTF-8 continuation byte (10xxxxxx)
      while (cut > 0 && (buf[cut] & 0xc0) === 0x80) {
        cut -= 1;
      }
      if (cut === 0) cut = maxBytes;
      parts.push(buf.subarray(0, cut).toString("utf8"));
      buf = buf.subarray(cut);
    }
    if (buf.length > 0) parts.push(buf.toString("utf8"));
    return parts;
  }

  /** Detect whether text/label should use heading-aware Markdown chunking */
  _isMarkdownContent(text, label = "") {
    if (/\.(?:md|mdx|markdown|mdown|mkd)$/i.test(String(label || "").trim())) {
      return true;
    }
    if (!text || typeof text !== "string") return false;
    const matches = text.match(/^#{1,6}\s+\S/gm);
    return Boolean(matches && matches.length >= 2);
  }

  /**
   * Heading-aware Markdown chunker (inspired by tobi/qmd MIT patterns):
   * preserves fenced code blocks, tracks heading breadcrumb stacks, and
   * breaks cleanly at heading/paragraph boundaries before byte budget limits.
   */
  chunkContentDetailed(text, maxBytes = MAX_CHUNK_BYTES, { label = "", isMarkdown = null } = {}) {
    if (!text) return [];
    const normalized = String(text).replace(/\r\n/g, "\n");
    const useMarkdown = isMarkdown !== null ? Boolean(isMarkdown) : this._isMarkdownContent(normalized, label);
    const lines = normalized.split("\n");

    if (!useMarkdown) {
      const results = [];
      let currentLines = [];
      let currentBytes = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineBytes = Buffer.byteLength(line, "utf8") + 1;

        if (lineBytes > maxBytes) {
          if (currentLines.length > 0) {
            results.push({ body: currentLines.join("\n"), title: label || "untitled" });
            currentLines = [];
            currentBytes = 0;
          }
          for (const slice of this._splitOversizedLine(line, maxBytes)) {
            results.push({ body: slice, title: label || "untitled" });
          }
          continue;
        }

        if (currentBytes + lineBytes > maxBytes && currentLines.length > 0) {
          results.push({ body: currentLines.join("\n"), title: label || "untitled" });
          currentLines = [line];
          currentBytes = lineBytes;
        } else {
          currentLines.push(line);
          currentBytes += lineBytes;
        }
      }
      if (currentLines.length > 0) {
        results.push({ body: currentLines.join("\n"), title: label || "untitled" });
      }
      return results;
    }

    // Markdown heading-aware + fenced-code-aware chunking
    const chunks = [];
    const headingStack = []; // [{ level, text }]
    let currentLines = [];
    let currentLineInFence = [];
    let currentBytes = 0;
    let currentHeadingPath = "";
    let inFence = false;
    let fenceChar = "";
    let fenceLen = 0;

    const formatTitle = (hPath) => {
      if (label && hPath) return `${label} :: ${hPath}`;
      return hPath || label || "untitled";
    };

    const flush = () => {
      if (currentLines.length === 0) return;
      const body = currentLines.join("\n").trimEnd();
      if (body.length > 0) {
        chunks.push({ body, title: formatTitle(currentHeadingPath) });
      }
      currentLines = [];
      currentLineInFence = [];
      currentBytes = 0;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fenceMatch = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
      if (fenceMatch) {
        const marker = fenceMatch[2];
        const rest = fenceMatch[3] || "";
        if (!inFence) {
          // CommonMark: backtick fence info string cannot contain backticks (prevents ```inline``` poisoning)
          if (marker[0] === "~" || !rest.includes("`")) {
            inFence = true;
            fenceChar = marker[0];
            fenceLen = marker.length;
          }
        } else if (marker[0] === fenceChar && marker.length >= fenceLen && rest.trim() === "") {
          inFence = false;
          fenceChar = "";
          fenceLen = 0;
        }
      }

      if (!inFence) {
        const headingMatch = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
        if (headingMatch) {
          const level = headingMatch[1].length;
          const headingText = headingMatch[2].trim();
          const prevLevel = headingStack.length > 0 ? headingStack[headingStack.length - 1].level : 0;
          const isSiblingOrAscent = prevLevel > 0 && level <= prevLevel;

          // Flush before sibling/higher-level headings (preserves distinct section titles even for short sections),
          // or before child headings once current intro chunk has meaningful content.
          if (
            currentLines.length > 0 &&
            (isSiblingOrAscent || currentBytes >= Math.min(512, Math.floor(maxBytes * 0.2)))
          ) {
            flush();
          }

          while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
            headingStack.pop();
          }
          headingStack.push({ level, text: headingText });
          currentHeadingPath = headingStack.map((h) => h.text).join(" > ");
        }
      }

      const lineBytes = Buffer.byteLength(line, "utf8") + 1;

      if (lineBytes > maxBytes) {
        flush();
        for (const slice of this._splitOversizedLine(line, maxBytes)) {
          chunks.push({ body: slice, title: formatTitle(currentHeadingPath) });
        }
        continue;
      }

      if (currentBytes + lineBytes > maxBytes && currentLines.length > 0) {
        // Try to break on a blank line strictly OUTSIDE any fenced code block
        let splitIdx = -1;
        if (!inFence) {
          for (let k = currentLines.length - 1; k >= Math.floor(currentLines.length * 0.5); k--) {
            if (!currentLineInFence[k] && currentLines[k].trim() === "") {
              splitIdx = k;
              break;
            }
          }
        }
        if (splitIdx > 0) {
          const headPart = currentLines.slice(0, splitIdx);
          const tailPart = currentLines.slice(splitIdx + 1);
          const tailFence = currentLineInFence.slice(splitIdx + 1);
          const body = headPart.join("\n").trimEnd();
          if (body.length > 0) {
            chunks.push({ body, title: formatTitle(currentHeadingPath) });
          }
          const tailPlusLine = [...tailPart, line];
          const tailPlusBytes = Buffer.byteLength(tailPlusLine.join("\n"), "utf8") + 1;
          if (tailPlusBytes <= maxBytes) {
            currentLines = tailPlusLine;
            currentLineInFence = [...tailFence, inFence];
            currentBytes = tailPlusBytes;
          } else {
            const tailBody = tailPart.join("\n").trimEnd();
            if (tailBody.length > 0) {
              chunks.push({ body: tailBody, title: formatTitle(currentHeadingPath) });
            }
            currentHeadingPath = headingStack.map((h) => h.text).join(" > ");
            currentLines = [line];
            currentLineInFence = [inFence];
            currentBytes = lineBytes;
          }
        } else {
          flush();
          currentHeadingPath = headingStack.map((h) => h.text).join(" > ");
          currentLines = [line];
          currentLineInFence = [inFence];
          currentBytes = lineBytes;
        }
      } else {
        if (currentLines.length === 0) {
          currentHeadingPath = headingStack.map((h) => h.text).join(" > ");
        }
        currentLines.push(line);
        currentLineInFence.push(inFence);
        currentBytes += lineBytes;
      }
    }

    flush();
    return chunks;
  }

  /** Split content into chunks by byte budget (heading-aware for Markdown) */
  chunkContent(text, maxBytes = MAX_CHUNK_BYTES, options = {}) {
    return this.chunkContentDetailed(text, maxBytes, options).map((c) => c.body);
  }

  /** Index a text, file output, or tool response into SQLite FTS5 */
  indexContent({ sessionId, worktree, agent, kind, label, content, sourceId, isMarkdown = null, dedup = false }) {
    this.open();
    const sid = sessionId || "default";
    const wt = worktree || process.cwd();
    const ag = agent || "antigravity";
    const k = kind || "content";
    const lbl = label || "untitled";
    const rawText = typeof content === "string" ? content : String(content || "");
    const totalBytes = Buffer.byteLength(rawText, "utf8");
    const contentHash = createHash("sha256").update(rawText, "utf8").digest("hex");
    const now = Date.now();

    if (dedup === true && !sourceId && totalBytes > 0) {
      const existing = this.db
        .prepare(`
          SELECT id, label, bytes_total, chunk_count
          FROM sources
          WHERE session_id = ? AND content_hash = ?
          ORDER BY accessed_ts DESC
          LIMIT 1
        `)
        .get(sid, contentHash);
      if (existing) {
        this.db.prepare("UPDATE sources SET accessed_ts = ? WHERE id = ?").run(now, existing.id);
        return {
          sourceId: existing.id,
          bytesTotal: existing.bytes_total,
          chunkCount: existing.chunk_count,
          label: existing.label,
          contentHash,
          deduplicated: true
        };
      }
    }

    const id = sourceId || `s_${now}_${(++this.sourceCounter).toString(36)}`;
    const isoDate = new Date(now).toISOString();

    const detailedChunks = this.chunkContentDetailed(rawText, MAX_CHUNK_BYTES, { label: lbl, isMarkdown });
    const chunkCount = detailedChunks.length;

    const insertSource = this.db.prepare(`
      INSERT OR REPLACE INTO sources (
        id, session_id, worktree, agent, kind, label, bytes_total, chunk_count, created_ts, created_at, accessed_ts, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertChunk = this.db.prepare(`
      INSERT INTO chunks (source_id, session_id, worktree, agent, ord, body, title)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertChunkTri = this.db.prepare(`
      INSERT INTO chunks_tri (source_id, session_id, ord, body)
      VALUES (?, ?, ?, ?)
    `);

    insertSource.run(id, sid, wt, ag, k, lbl, totalBytes, chunkCount, now, isoDate, now, contentHash);

    for (let ord = 0; ord < chunkCount; ord++) {
      const ch = detailedChunks[ord];
      insertChunk.run(id, sid, wt, ag, ord, ch.body, ch.title || lbl);
      insertChunkTri.run(id, sid, ord, ch.body);
    }

    this.pruneStaleSources();

    return {
      sourceId: id,
      bytesTotal: totalBytes,
      chunkCount,
      label: lbl,
      contentHash,
      deduplicated: false,
      chunks: detailedChunks.map((c) => c.body),
      chunkTitles: detailedChunks.map((c) => c.title)
    };
  }

  /** Search indexed chunks using BM25 + Trigram Reciprocal Rank Fusion */
  search({ queries, sourceId, sessionId, worktree, scope = "session", limit = 5, offset = 0 }) {
    this.open();
    const queryList = Array.isArray(queries) ? queries : [queries];
    const maxHits = Math.min(Math.max(1, limit || 5), 20);
    const skipHits = Math.max(0, offset || 0);

    const scores = new Map();

    for (const q of queryList) {
      if (!q || typeof q !== "string") continue;
      const porterQ = sanitizeFtsQuery(q);
      const trigramQ = sanitizeTrigramQuery(q);

      // 1. Porter FTS5 with BM25 ranking
      if (porterQ) {
        let sql = `
          SELECT rowid, source_id, ord, body, title, session_id, worktree, bm25(chunks) AS rank
          FROM chunks
          WHERE chunks MATCH ?
        `;
        const params = [porterQ];

        if (sourceId) {
          sql += " AND source_id = ?";
          params.push(sourceId);
        } else if (scope === "session" && sessionId) {
          sql += " AND session_id = ?";
          params.push(sessionId);
        } else if (scope === "worktree" && worktree) {
          sql += " AND worktree = ?";
          params.push(worktree);
        }

        sql += " ORDER BY rank LIMIT 30";

        try {
          const rows = this.db.prepare(sql).all(...params);
          rows.forEach((row, rankIdx) => {
            const key = `${row.source_id}:${row.ord}`;
            const rrf = 1.0 / (RRF_K + rankIdx + 1);
            const existing = scores.get(key);
            if (existing) {
              existing.rrfScore += rrf;
              existing.matches.push({ query: q, type: "porter", rank: rankIdx + 1 });
            } else {
              scores.set(key, {
                rowid: row.rowid,
                sourceId: row.source_id,
                ord: row.ord,
                body: row.body,
                title: row.title,
                sessionId: row.session_id,
                worktree: row.worktree,
                rrfScore: rrf,
                matches: [{ query: q, type: "porter", rank: rankIdx + 1 }]
              });
            }
          });
        } catch {
          // Porter match error ignored
        }
      }

      // 2. Trigram FTS5
      if (trigramQ) {
        let sqlTri = `
          SELECT t.rowid, t.source_id, t.ord, t.body, t.session_id, s.worktree
          FROM chunks_tri t
          LEFT JOIN sources s ON s.id = t.source_id
          WHERE chunks_tri MATCH ?
        `;
        const paramsTri = [trigramQ];

        if (sourceId) {
          sqlTri += " AND t.source_id = ?";
          paramsTri.push(sourceId);
        } else if (scope === "session" && sessionId) {
          sqlTri += " AND t.session_id = ?";
          paramsTri.push(sessionId);
        } else if (scope === "worktree" && worktree) {
          sqlTri += " AND s.worktree = ?";
          paramsTri.push(worktree);
        }

        sqlTri += " LIMIT 30";

        try {
          const rowsTri = this.db.prepare(sqlTri).all(...paramsTri);
          rowsTri.forEach((row, rankIdx) => {
            const key = `${row.source_id}:${row.ord}`;
            const rrf = 1.0 / (RRF_K + rankIdx + 1);
            const existing = scores.get(key);
            if (existing) {
              existing.rrfScore += rrf;
              existing.matches.push({ query: q, type: "trigram", rank: rankIdx + 1 });
            } else {
              scores.set(key, {
                rowid: row.rowid,
                sourceId: row.source_id,
                ord: row.ord,
                body: row.body,
                title: "",
                sessionId: row.session_id,
                worktree: row.worktree || "",
                rrfScore: rrf,
                matches: [{ query: q, type: "trigram", rank: rankIdx + 1 }]
              });
            }
          });
        } catch {
          // Trigram match error ignored
        }
      }
    }

    const allHits = Array.from(scores.values()).sort((a, b) => b.rrfScore - a.rrfScore);
    const paginated = allHits.slice(skipHits, skipHits + maxHits);

    const lookupTitleStmt = this.db.prepare("SELECT title FROM chunks WHERE source_id = ? AND ord = ? LIMIT 1");
    const touchSourceStmt = this.db.prepare("UPDATE sources SET accessed_ts = ? WHERE id = ?");
    const nowTs = Date.now();
    const touchedSources = new Set();

    const formatted = paginated.map((hit) => {
      if (!hit.title) {
        try {
          const row = lookupTitleStmt.get(hit.sourceId, hit.ord);
          if (row && row.title) hit.title = row.title;
        } catch {}
      }
      if (hit.sourceId && !touchedSources.has(hit.sourceId)) {
        touchedSources.add(hit.sourceId);
        try { touchSourceStmt.run(nowTs, hit.sourceId); } catch {}
      }
      let snippet = hit.body;
      if (Buffer.byteLength(snippet, "utf8") > SNIPPET_MAX_BYTES) {
        const suffix = "\n... [truncated, use ctx_search or ctx_index to inspect full]";
        snippet = truncateUtf8Bytes(snippet, Math.max(120, SNIPPET_MAX_BYTES - Buffer.byteLength(suffix, "utf8"))) + suffix;
      }
      return {
        sourceId: hit.sourceId,
        ord: hit.ord,
        title: hit.title || hit.sourceId,
        rrfScore: parseFloat(hit.rrfScore.toFixed(5)),
        matches: hit.matches.length,
        snippet
      };
    });

    return {
      hits: formatted,
      totalMatches: allHits.length,
      returned: formatted.length,
      offset: skipHits,
      limit: maxHits
    };
  }

  /** Record an event in the session journal */
  recordEvent({
    sessionId,
    worktree,
    agent,
    kind,
    tool,
    key,
    path: filePath,
    ok = 1,
    exitCode,
    bytes = 0,
    body = "",
    turn = 0,
    sandboxBytes = 0,
    returnedBytes = 0
  }) {
    this.open();
    const now = new Date().toISOString();
    const insert = this.db.prepare(`
      INSERT INTO events (
        session_id, worktree, agent, kind, tool, key, path, ok, exit_code, bytes, body, turn, sandbox_bytes, returned_bytes, created_at, accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(
      sessionId || "default",
      worktree || process.cwd(),
      agent || "antigravity",
      kind || "tool",
      tool || null,
      key || null,
      filePath || null,
      ok ? 1 : 0,
      exitCode ?? (ok ? 0 : 1),
      bytes,
      body || null,
      turn,
      sandboxBytes,
      returnedBytes,
      now,
      now
    );

    return { seq: result.lastInsertRowid };
  }

  /** Retrieve compaction / state resume block */
  getResumeState(sessionId, limit = 5, options = {}) {
    this.open();
    const sid = sessionId || "default";
    const sinceTs = options.sinceTs || null;
    const sinceIso = sinceTs ? new Date(sinceTs).toISOString() : null;

    let sources;
    let events;

    if (sid === "all" || sid === "lifetime") {
      sources = this.db
        .prepare(`
          SELECT id, label, kind, bytes_total, chunk_count, created_at
          FROM sources
          ORDER BY created_ts DESC
          LIMIT ?
        `)
        .all(limit);
      events = this.db
        .prepare(`
          SELECT seq, tool, kind, key, path, ok, sandbox_bytes, returned_bytes, agent, created_at
          FROM events
          ORDER BY seq DESC
          LIMIT ?
        `)
        .all(limit);
    } else if (sid === "app" && sinceIso) {
      sources = this.db
        .prepare(`
          SELECT id, label, kind, bytes_total, chunk_count, created_at
          FROM sources
          WHERE created_at >= ? OR created_ts >= ?
          ORDER BY created_ts DESC
          LIMIT ?
        `)
        .all(sinceIso, sinceTs, limit);
      events = this.db
        .prepare(`
          SELECT seq, tool, kind, key, path, ok, sandbox_bytes, returned_bytes, agent, created_at
          FROM events
          WHERE created_at >= ?
          ORDER BY seq DESC
          LIMIT ?
        `)
        .all(sinceIso, limit);
    } else {
      sources = this.db
        .prepare(`
          SELECT id, label, kind, bytes_total, chunk_count, created_at
          FROM sources
          WHERE session_id = ?
          ORDER BY created_ts DESC
          LIMIT ?
        `)
        .all(sid, limit);
      events = this.db
        .prepare(`
          SELECT seq, tool, kind, key, path, ok, sandbox_bytes, returned_bytes, agent, created_at
          FROM events
          WHERE session_id = ?
          ORDER BY seq DESC
          LIMIT ?
        `)
        .all(sid, limit);
    }

    return {
      sessionId: sid,
      recentSources: sources,
      recentEvents: events,
      sessionCheckpoint: this.getSessionCheckpoint(sid)
    };
  }

  /** Record modified file paths into the session's structured compaction checkpoint ledger */
  recordModifiedFiles(sessionId, filePaths = [], { worktree = "", tool = null } = {}) {
    this.open();
    const sid = sessionId || "default";
    const list = Array.isArray(filePaths) ? filePaths : [filePaths];
    const cleaned = list
      .map((p) => (typeof p === "string" ? p.trim() : ""))
      .filter(Boolean);
    if (cleaned.length === 0) return this.getSessionCheckpoint(sid);

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const normKey = (p) => {
      const posix = p.replace(/\\/g, "/");
      return process.platform === "win32" ? posix.toLowerCase() : posix;
    };

    const MAX_CHECKPOINT_FILES = 30;
    this._withBusyRetry(() => {
      let inTx = false;
      try {
        this.db.exec("BEGIN IMMEDIATE;");
        inTx = true;
        const row = this.db
          .prepare("SELECT worktree, modified_files_json, last_test_json, last_build_json FROM session_checkpoints WHERE session_id = ?")
          .get(sid);

        let existing = [];
        if (row?.modified_files_json) {
          try {
            const parsed = JSON.parse(row.modified_files_json);
            if (Array.isArray(parsed)) existing = parsed;
          } catch {}
        }

        const byKey = new Map();
        for (const item of existing) {
          if (!item) continue;
          const p = typeof item === "string" ? item : item.path;
          if (!p) continue;
          byKey.set(normKey(p), typeof item === "string" ? { path: p, edits: 1, lastTool: null, updatedAt: nowIso } : item);
        }

        for (const rawPath of cleaned) {
          const displayPath = worktree
            ? (() => {
                const rel = path.relative(worktree, rawPath);
                if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
                  return rel.replace(/\\/g, "/");
                }
                return rawPath.replace(/\\/g, "/");
              })()
            : rawPath.replace(/\\/g, "/");
          const k = normKey(displayPath);
          const prev = byKey.get(k);
          byKey.delete(k); // Move to most-recent end
          byKey.set(k, {
            path: displayPath,
            edits: (prev?.edits || 0) + 1,
            lastTool: tool || prev?.lastTool || null,
            updatedAt: nowIso
          });
        }

        const merged = Array.from(byKey.values()).slice(-MAX_CHECKPOINT_FILES);
        this.db
          .prepare(`
            INSERT INTO session_checkpoints (session_id, worktree, modified_files_json, last_test_json, last_build_json, updated_ts, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              worktree = CASE WHEN excluded.worktree != '' THEN excluded.worktree ELSE session_checkpoints.worktree END,
              modified_files_json = excluded.modified_files_json,
              updated_ts = excluded.updated_ts,
              updated_at = excluded.updated_at
          `)
          .run(
            sid,
            worktree || row?.worktree || "",
            JSON.stringify(merged),
            row?.last_test_json ?? null,
            row?.last_build_json ?? null,
            now,
            nowIso
          );

        this.db.exec("COMMIT;");
        inTx = false;
      } catch (err) {
        if (inTx) {
          try { this.db.exec("ROLLBACK;"); } catch {}
        }
        throw err;
      }
    });

    return this.getSessionCheckpoint(sid);
  }

  /** Record latest test or build verification status into the session checkpoint ledger */
  recordVerificationResult(
    sessionId,
    { kind = "test", command = "", ruleId = "", exitCode = 0, passed = null, summary = "", sourceId = null, worktree = "" } = {}
  ) {
    this.open();
    const sid = sessionId || "default";
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const isBuild = kind === "build";
    const ok = passed !== null && passed !== undefined ? Boolean(passed) : Number(exitCode) === 0;
    const payload = JSON.stringify({
      command: String(command || "").trim().slice(0, 140),
      ruleId: String(ruleId || ""),
      ok,
      exitCode: Number.isFinite(Number(exitCode)) ? Number(exitCode) : ok ? 0 : 1,
      summary: String(summary || "").trim().slice(0, 220),
      sourceId: sourceId || null,
      at: nowIso
    });

    this._withBusyRetry(() => {
      if (isBuild) {
        this.db
          .prepare(`
            INSERT INTO session_checkpoints (session_id, worktree, modified_files_json, last_test_json, last_build_json, updated_ts, updated_at)
            VALUES (?, ?, '[]', NULL, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              worktree = CASE WHEN excluded.worktree != '' THEN excluded.worktree ELSE session_checkpoints.worktree END,
              last_build_json = excluded.last_build_json,
              updated_ts = excluded.updated_ts,
              updated_at = excluded.updated_at
          `)
          .run(sid, worktree || "", payload, now, nowIso);
      } else {
        this.db
          .prepare(`
            INSERT INTO session_checkpoints (session_id, worktree, modified_files_json, last_test_json, last_build_json, updated_ts, updated_at)
            VALUES (?, ?, '[]', ?, NULL, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              worktree = CASE WHEN excluded.worktree != '' THEN excluded.worktree ELSE session_checkpoints.worktree END,
              last_test_json = excluded.last_test_json,
              updated_ts = excluded.updated_ts,
              updated_at = excluded.updated_at
          `)
          .run(sid, worktree || "", payload, now, nowIso);
      }
    });

    return this.getSessionCheckpoint(sid);
  }

  /** Retrieve compact structured session checkpoint for compaction recovery */
  getSessionCheckpoint(sessionId) {
    this.open();
    const sid = sessionId || "default";
    const row =
      sid === "all" || sid === "lifetime" || sid === "app"
        ? this.db
            .prepare("SELECT * FROM session_checkpoints ORDER BY updated_ts DESC LIMIT 1")
            .get()
        : this.db
            .prepare("SELECT * FROM session_checkpoints WHERE session_id = ?")
            .get(sid);

    if (!row) {
      return {
        modifiedFiles: [],
        modifiedFileCount: 0,
        lastTest: null,
        lastBuild: null,
        updatedAt: null
      };
    }

    let rawFiles = [];
    try {
      const parsed = JSON.parse(row.modified_files_json || "[]");
      if (Array.isArray(parsed)) rawFiles = parsed;
    } catch {}

    const modifiedFiles = rawFiles
      .map((item) => (typeof item === "string" ? item : item?.path))
      .filter(Boolean)
      .reverse()
      .slice(0, 20);

    let lastTest = null;
    if (row.last_test_json) {
      try { lastTest = JSON.parse(row.last_test_json); } catch {}
    }
    let lastBuild = null;
    if (row.last_build_json) {
      try { lastBuild = JSON.parse(row.last_build_json); } catch {}
    }

    return {
      modifiedFiles,
      modifiedFileCount: rawFiles.length,
      lastTest,
      lastBuild,
      updatedAt: row.updated_at || null
    };
  }

  /** Retrieve full event body by sequence number */
  getEventBySeq(seq) {
    this.open();
    const row = this.db.prepare("SELECT * FROM events WHERE seq = ?").get(seq);
    return row || null;
  }

  /** Retrieve all chunks for a specific source */
  getSourceChunks(sourceId) {
    this.open();
    if (!sourceId) return [];
    return this.db
      .prepare("SELECT ord, body, title FROM chunks WHERE source_id = ? ORDER BY ord ASC")
      .all(sourceId);
  }

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
        WHERE created_at >= ?
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
        WHERE session_id = ?
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
          FROM events GROUP BY kind
        `).all();
      } else if (sid === "app" && sinceIso) {
        breakdownRows = this.db.prepare(`
          SELECT kind, COUNT(*) AS cnt,
            COALESCE(SUM(MAX(0, MAX(sandbox_bytes, bytes, returned_bytes) - returned_bytes)), 0) AS saved_bytes
          FROM events WHERE created_at >= ? GROUP BY kind
        `).all(sinceIso);
      } else {
        breakdownRows = this.db.prepare(`
          SELECT kind, COUNT(*) AS cnt,
            COALESCE(SUM(MAX(0, MAX(sandbox_bytes, bytes, returned_bytes) - returned_bytes)), 0) AS saved_bytes
          FROM events WHERE session_id = ? GROUP BY kind
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

  /** Purge stored data */
  purge({ scope = "session", sessionId, worktree, sinceTs, olderThanDays = 14, vacuum = false } = {}) {
    this.open();
    if (scope === "stale") {
      return this.pruneByTtl({ maxAgeDays: olderThanDays, vacuum });
    }

    if (scope === "all" || scope === "lifetime") {
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
        VACUUM;
      `);
      return { ok: true, purged: "all" };
    }

    if (scope === "app" && sinceTs) {
      const sinceIso = new Date(sinceTs).toISOString();
      const sourceIds = this.db.prepare("SELECT id FROM sources WHERE created_at >= ? OR created_ts >= ?").all(sinceIso, sinceTs).map((r) => r.id);
      for (const sId of sourceIds) {
        this.db.prepare("DELETE FROM chunks WHERE source_id = ?").run(sId);
        this.db.prepare("DELETE FROM chunks_tri WHERE source_id = ?").run(sId);
      }
      this.db.prepare("DELETE FROM sources WHERE created_at >= ? OR created_ts >= ?").run(sinceIso, sinceTs);
      this.db.prepare("DELETE FROM events WHERE created_at >= ?").run(sinceIso);
      this.db.prepare("DELETE FROM file_reads WHERE read_ts >= ?").run(sinceTs);
      this.db.prepare("DELETE FROM file_snapshots WHERE updated_ts >= ?").run(sinceTs);
      this.db.prepare("DELETE FROM ghost_interceptions WHERE blocked_ts >= ?").run(sinceTs);
      this.db.prepare("DELETE FROM session_checkpoints WHERE updated_ts >= ?").run(sinceTs);
      return { ok: true, purged: "app", count: sourceIds.length };
    }

    if (scope === "worktree" && worktree) {
      this.db.prepare("DELETE FROM chunks WHERE worktree = ?").run(worktree);
      this.db.prepare("DELETE FROM sources WHERE worktree = ?").run(worktree);
      this.db.prepare("DELETE FROM events WHERE worktree = ?").run(worktree);
      this.db.prepare("DELETE FROM session_checkpoints WHERE worktree = ?").run(worktree);
      return { ok: true, purged: "worktree", worktree };
    }

    const sid = sessionId || "default";
    this.db.prepare("DELETE FROM chunks WHERE session_id = ?").run(sid);
    this.db.prepare("DELETE FROM chunks_tri WHERE session_id = ?").run(sid);
    this.db.prepare("DELETE FROM sources WHERE session_id = ?").run(sid);
    this.db.prepare("DELETE FROM events WHERE session_id = ?").run(sid);
    this.db.prepare("DELETE FROM file_reads WHERE session_id = ?").run(sid);
    this.db.prepare("DELETE FROM file_snapshots WHERE session_id = ?").run(sid);
    this.db.prepare("DELETE FROM ghost_interceptions WHERE session_id = ?").run(sid);
    this.db.prepare("DELETE FROM session_checkpoints WHERE session_id = ?").run(sid);
    return { ok: true, purged: "session", sessionId: sid };
  }

  /** Run diagnostic checks */
  doctor() {
    try {
      this.open();
      const versionRow = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
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
        sqliteVersion: process.versions.node
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

  /** Read a timestamped meta value (backward compatible with plain string values) */
  getTimedMeta(key, defaultValue = null) {
    const raw = this.getMeta(key, null);
    if (raw === null) return defaultValue;
    if (raw.startsWith("{")) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && "v" in parsed) {
          return parsed.v;
        }
      } catch {}
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

  /** Get active cutoff in bytes (0 = none/disabled) */
  getCutoff(sessionId = null) {
    this.open();
    // 1. Session/Conversation override
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      const sessionCutoff = this.getMeta(`cutoff:session:${sessionId}`);
      if (sessionCutoff !== null) {
        return parseInt(sessionCutoff, 10);
      }
      // If checking a conversation, fall back to the app session cutoff if set
      if (sessionId !== "app") {
        const appCutoff = this.getMeta("cutoff:session:app");
        if (appCutoff !== null) {
          return parseInt(appCutoff, 10);
        }
      }
    }

    // 2. Environment variable if explicitly set
    const envVal = process.env.CONTEXT_MODE_MAX_READ_BYTES;
    if (envVal) {
      const parsed = parseInt(envVal, 10);
      if (!Number.isNaN(parsed)) return parsed;
    }

    // 3. Saved global setting in SQLite
    const globalCutoff = this.getMeta("cutoff:global");
    if (globalCutoff !== null) {
      return parseInt(globalCutoff, 10);
    }

    // 4. Default 16 KB (balanced co-op cutoff for agy-dart: allows <16 KB small files & <=410-line slices)
    return 16384;
  }

  /** Set cutoff in bytes (0 = none/disabled) */
  setCutoff(bytes, sessionId = null) {
    this.open();
    const val = parseInt(bytes, 10);
    const numVal = Number.isNaN(val) ? 16384 : Math.max(0, val);
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      this.setMeta(`cutoff:session:${sessionId}`, numVal);
    } else {
      this.setMeta("cutoff:global", numVal);
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
    if (sessionId && sessionId !== "all") {
      this.setMeta(`exempt_ext:session:${sessionId}`, serialized);
    } else {
      this.setMeta("exempt_ext:global", serialized);
    }
    return cleanList;
  }

  /** Get list of active category IDs */
  getExemptCategories(sessionId = null) {
    this.open();
    if (sessionId && sessionId !== "all") {
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
    if (sessionId && sessionId !== "all") {
      this.setMeta(`exempt_categories:session:${sessionId}`, serialized);
    } else {
      this.setMeta("exempt_categories:global", serialized);
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
    if (sessionId && sessionId !== "all") {
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

  /** Set custom file extensions */
  setCustomExemptExtensions(extensions, sessionId = null) {
    this.open();
    const cleanList = Array.from(
      new Set(
        (Array.isArray(extensions) ? extensions : [])
          .map((ext) => String(ext || "").trim().toLowerCase())
          .filter(Boolean)
          .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`))
      )
    );
    const serialized = JSON.stringify(cleanList);
    if (sessionId && sessionId !== "all") {
      this.setMeta(`custom_exempt_ext:session:${sessionId}`, serialized);
    } else {
      this.setMeta("custom_exempt_ext:global", serialized);
    }
    this._recomputeExemptExtensions(sessionId);
    return cleanList;
  }

  /** Add custom file extension */
  addCustomExemptExtension(ext, sessionId = null) {
    const list = this.getCustomExemptExtensions(sessionId);
    const cleanExt = String(ext || "").trim().toLowerCase();
    if (!cleanExt) return list;
    const formatted = cleanExt.startsWith(".") ? cleanExt : `.${cleanExt}`;
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
    const formatted = cleanExt.startsWith(".") ? cleanExt : `.${cleanExt}`;
    const filtered = list.filter((e) => e !== formatted);
    this.setCustomExemptExtensions(filtered, sessionId);
    return filtered;
  }

  /** Get list of file extensions exempt from the size cutoff */
  getExemptExtensions(sessionId = null) {
    this.open();
    // 1. Session/Conversation override
    if (sessionId && sessionId !== "all") {
      const raw = this.getMeta(`exempt_ext:session:${sessionId}`);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed;
        } catch {}
      }
      // If checking a conversation, fall back to the app session exemptions if set
      if (sessionId !== "app") {
        const appRaw = this.getMeta("exempt_ext:session:app");
        if (appRaw) {
          try {
            const parsed = JSON.parse(appRaw);
            if (Array.isArray(parsed)) return parsed;
          } catch {}
        }
      }
    }
    const globalRaw = this.getMeta("exempt_ext:global");
    if (globalRaw) {
      try {
        const parsed = JSON.parse(globalRaw);
        if (Array.isArray(parsed)) return parsed;
      } catch {}
    }
    return [...DEFAULT_EXEMPT_EXTENSIONS];
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
      if (catObj.extensions.some((e) => cleanList.includes(e))) {
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
    if (process.env.AGY_DART_DISABLE_CLI_FILTER === "1") return false;
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
    if (process.env.AGY_DART_DISABLE_READ_DEDUP === "1") return false;
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

  /** Normalize absolute file paths consistently across OSes for dedup/invalidation */
  _normalizeTrackPath(filePath) {
    if (!filePath) return "";
    const resolved = path.resolve(String(filePath)).replace(/\\/g, "/");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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
            session_id, file_path, start_line, end_line, sha256, mtime_ms, file_size, raw_bytes, content_gz, updated_ts, bypass_armed
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id, file_path, start_line, end_line) DO UPDATE SET
            sha256 = excluded.sha256,
            mtime_ms = excluded.mtime_ms,
            file_size = excluded.file_size,
            raw_bytes = excluded.raw_bytes,
            content_gz = excluded.content_gz,
            updated_ts = excluded.updated_ts,
            bypass_armed = excluded.bypass_armed
        `)
        .run(sid, norm, reqStart, reqEnd, digest, mtimeMs, fileSize, rawBytes, contentGz, now, armed);

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
        SELECT start_line, end_line, sha256, mtime_ms, file_size, raw_bytes, content_gz, updated_ts, bypass_armed
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

  /** Read git-HEAD-keyed workspace skeleton cache */
  getRepoCache(workspaceDir, headSha, kind, maxAgeMs = 7 * 24 * 3600 * 1000) {
    this.open();
    const normDir = this._normalizeTrackPath(workspaceDir);
    const row = this.db
      .prepare("SELECT payload, updated_ts FROM repo_cache WHERE workspace_dir = ? AND head_sha = ? AND kind = ?")
      .get(normDir, String(headSha || "nogit"), String(kind || "hotspots"));
    if (!row) return null;
    if (maxAgeMs > 0 && Date.now() - Number(row.updated_ts) > maxAgeMs) return null;
    return row.payload;
  }

  /** Write git-HEAD-keyed workspace skeleton cache and prune obsolete commits for same workspace */
  setRepoCache(workspaceDir, headSha, kind, payload) {
    this.open();
    const normDir = this._normalizeTrackPath(workspaceDir);
    const sha = String(headSha || "nogit");
    const k = String(kind || "hotspots");
    const now = Date.now();
    this.db
      .prepare("DELETE FROM repo_cache WHERE workspace_dir = ? AND kind = ? AND head_sha != ?")
      .run(normDir, k, sha);
    this.db
      .prepare(`
        INSERT INTO repo_cache (workspace_dir, head_sha, kind, payload, updated_ts)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(workspace_dir, head_sha, kind) DO UPDATE SET
          payload = excluded.payload,
          updated_ts = excluded.updated_ts
      `)
      .run(normDir, sha, k, String(payload ?? ""), now);
  }

  /**
   * Look up persistent L2 outline symbols for a file by normalized path, mtimeMs (±1 ms tolerance), and exact fileSize.
   * Touches updated_ts for LRU recency on hit and returns `{ lineCount, symbols }` or `null`.
   */
  getOutlineCache(filePath, mtimeMs, fileSize) {
    this.open();
    const norm = this._normalizeTrackPath(filePath);
    if (!norm) return null;
    const mtime = Number(mtimeMs);
    const size = Number(fileSize);
    if (!Number.isFinite(mtime) || !Number.isFinite(size)) return null;

    const row = this.db
      .prepare("SELECT mtime_ms, file_size, line_count, symbols_json FROM outline_cache WHERE file_path = ?")
      .get(norm);
    if (!row) return null;
    if (Math.abs(Number(row.mtime_ms) - mtime) > 1 || Number(row.file_size) !== size) {
      return null;
    }

    let symbols;
    try {
      symbols = JSON.parse(row.symbols_json);
    } catch {
      return null;
    }
    if (!Array.isArray(symbols)) return null;

    try {
      this._withBusyRetry(() => {
        this.db
          .prepare("UPDATE outline_cache SET updated_ts = ? WHERE file_path = ?")
          .run(Date.now(), norm);
      });
    } catch {
      // Best-effort LRU touch
    }

    return {
      lineCount: Number(row.line_count),
      symbols
    };
  }

  /**
   * Persist extracted outline symbols in SQLite L2 cache (bounded to max 512 entries LRU, skipping >128 KB JSON).
   */
  setOutlineCache(filePath, mtimeMs, fileSize, lineCount, symbols, options = {}) {
    this.open();
    const norm = this._normalizeTrackPath(filePath);
    if (!norm || !Array.isArray(symbols)) return false;
    const mtime = Number(mtimeMs);
    const size = Number(fileSize);
    const lines = Math.max(0, Math.trunc(Number(lineCount) || 0));
    if (!Number.isFinite(mtime) || !Number.isFinite(size) || size < 0) return false;

    const symbolsJson = JSON.stringify(symbols);
    if (Buffer.byteLength(symbolsJson, "utf8") > MAX_OUTLINE_JSON_BYTES) {
      return false;
    }

    const now = Date.now();
    const cap =
      Number.isFinite(options?.maxEntries) && options.maxEntries > 0
        ? Math.floor(options.maxEntries)
        : MAX_OUTLINE_CACHE_DB_ENTRIES;

    this._withBusyRetry(() => {
      this.db
        .prepare(`
          INSERT INTO outline_cache (file_path, mtime_ms, file_size, line_count, symbols_json, updated_ts)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(file_path) DO UPDATE SET
            mtime_ms = excluded.mtime_ms,
            file_size = excluded.file_size,
            line_count = excluded.line_count,
            symbols_json = excluded.symbols_json,
            updated_ts = excluded.updated_ts
        `)
        .run(norm, mtime, Math.trunc(size), lines, symbolsJson, now);

      const countRow = this.db.prepare("SELECT COUNT(*) AS cnt FROM outline_cache").get();
      if (countRow && countRow.cnt > cap) {
        const excess = countRow.cnt - cap;
        this.db
          .prepare(`
            DELETE FROM outline_cache
            WHERE rowid IN (
              SELECT rowid FROM outline_cache
              ORDER BY updated_ts ASC, rowid ASC
              LIMIT ?
            )
          `)
          .run(excess);
      }
    });

    return true;
  }

  /** Delete one path, an array of paths, or all entries from persistent outline_cache */
  deleteOutlineCache(filePath = null) {
    this.open();
    return this._withBusyRetry(() => {
      if (filePath === null || filePath === undefined || filePath === "") {
        const res = this.db.prepare("DELETE FROM outline_cache").run();
        return res.changes || 0;
      }
      if (Array.isArray(filePath)) {
        const norms = Array.from(
          new Set(
            filePath
              .map((p) => (typeof p === "string" ? this._normalizeTrackPath(p) : ""))
              .filter(Boolean)
          )
        );
        if (norms.length === 0) return 0;
        let total = 0;
        for (let i = 0; i < norms.length; i += 400) {
          const batch = norms.slice(i, i + 400);
          const placeholders = batch.map(() => "?").join(",");
          const res = this.db
            .prepare(`DELETE FROM outline_cache WHERE file_path IN (${placeholders})`)
            .run(...batch);
          total += res.changes || 0;
        }
        return total;
      }
      const norm = this._normalizeTrackPath(filePath);
      if (!norm) return 0;
      const res = this.db.prepare("DELETE FROM outline_cache WHERE file_path = ?").run(norm);
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

    // Prune stale per-session PreInvocation alert/compaction/sensitive-file meta keys so meta stays bounded
    try {
      const metaRows = this.db
        .prepare("SELECT key, value FROM meta WHERE key LIKE 'cache_alert:%' OR key LIKE 'compact_invalidated:%' OR key LIKE 'sensitive_read_confirm:%'")
        .all();
      const delMetaStmt = this.db.prepare("DELETE FROM meta WHERE key = ?");
      for (const row of metaRows) {
        let entryTs = 0;
        if (typeof row.value === "string" && row.value.startsWith("{")) {
          try {
            const p = JSON.parse(row.value);
            if (p && Number.isFinite(p.ts)) entryTs = p.ts;
          } catch {}
        }
        if (entryTs > 0 && entryTs < cutoffTs) {
          delMetaStmt.run(row.key);
        }
      }
    } catch {}

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

    this.setMeta("last_maintenance_ts", String(now));
    const bytesAfter = getDiskSize();

    return {
      ok: true,
      purged: "stale",
      maxAgeDays: days,
      deletedSources: staleSources.length,
      deletedEvents: evRes.changes || 0,
      deletedFileReads: readRes.changes || 0,
      deletedFileSnapshots: snapRes.changes || 0,
      deletedGhostInterceptions: ghostRes.changes || 0,
      deletedCheckpoints: cpRes.changes || 0,
      deletedOutlineCache: outlineRes.changes || 0,
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
      // 1. Prune sources exceeding per-session cap
      const excessSessionSources = this.db
        .prepare(`
          SELECT id FROM sources
          WHERE id NOT IN (
            SELECT id FROM sources s2
            WHERE s2.session_id = sources.session_id
            ORDER BY s2.created_ts DESC
            LIMIT ?
          )
        `)
        .all(maxSourcesPerSession);

      if (excessSessionSources.length > 0) {
        const ids = excessSessionSources.map((r) => r.id);
        const placeholders = ids.map(() => "?").join(",");
        this.db.prepare(`DELETE FROM chunks WHERE source_id IN (${placeholders})`).run(...ids);
        this.db.prepare(`DELETE FROM chunks_tri WHERE source_id IN (${placeholders})`).run(...ids);
        this.db.prepare(`DELETE FROM sources WHERE id IN (${placeholders})`).run(...ids);
      }

      // 2. Prune global total sources if over cap
      const totalCountRow = this.db.prepare("SELECT count(*) as count FROM sources").get();
      if (totalCountRow && totalCountRow.count > maxTotalSources) {
        const deleteCount = totalCountRow.count - maxTotalSources;
        const oldest = this.db
          .prepare("SELECT id FROM sources ORDER BY created_ts ASC LIMIT ?")
          .all(deleteCount);

        if (oldest.length > 0) {
          const ids = oldest.map((r) => r.id);
          const placeholders = ids.map(() => "?").join(",");
          this.db.prepare(`DELETE FROM chunks WHERE source_id IN (${placeholders})`).run(...ids);
          this.db.prepare(`DELETE FROM chunks_tri WHERE source_id IN (${placeholders})`).run(...ids);
          this.db.prepare(`DELETE FROM sources WHERE id IN (${placeholders})`).run(...ids);
        }
      }
    } catch {
      // Best-effort auto-prune
    }
  }
}
