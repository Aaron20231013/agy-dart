import { createHash, randomBytes } from "node:crypto";
import {
  MAX_CHUNK_BYTES,
  RRF_K,
  SNIPPET_MAX_BYTES,
  sanitizeFtsQuery,
  sanitizeTrigramQuery,
  truncateUtf8Bytes
} from "./schema.js";

function parseMarkdownHeadingLinear(line) {
  if (!line || line.length > 1024 || line.charCodeAt(0) !== 0x23) return null;
  let hashes = 0;
  while (hashes < line.length && hashes <= 6 && line.charCodeAt(hashes) === 0x23) {
    hashes += 1;
  }
  if (hashes < 1 || hashes > 6 || hashes >= line.length) return null;
  const after = line.charCodeAt(hashes);
  if (after !== 0x20 && after !== 0x09) return null;
  let start = hashes + 1;
  while (start < line.length && (line.charCodeAt(start) === 0x20 || line.charCodeAt(start) === 0x09)) {
    start += 1;
  }
  let end = line.length;
  while (end > start && (line.charCodeAt(end - 1) === 0x20 || line.charCodeAt(end - 1) === 0x09)) {
    end -= 1;
  }
  let hashEnd = end;
  while (hashEnd > start && line.charCodeAt(hashEnd - 1) === 0x23) {
    hashEnd -= 1;
  }
  if (hashEnd < end && (hashEnd === start || line.charCodeAt(hashEnd - 1) === 0x20 || line.charCodeAt(hashEnd - 1) === 0x09)) {
    end = hashEnd;
    while (end > start && (line.charCodeAt(end - 1) === 0x20 || line.charCodeAt(end - 1) === 0x09)) {
      end -= 1;
    }
  }
  if (end <= start) return null;
  return { level: hashes, text: line.slice(start, end) };
}

export class FtsMethods {
  // Older MCP clients stored anonymous data under one shared ID. Only these rows
  // carry a per-operation worktree; the shared checkpoint and caches can be mixed.
  adoptLegacyWorkspaceData(worktree, sessionId) {
    this.open();
    const match = "session_id = 'default' AND worktree = ?";
    const sources = "SELECT id FROM sources WHERE " + match;
    const hasSources = this.db.prepare(sources + " LIMIT 1").get(worktree);
    const hasEvents = this.db.prepare("SELECT 1 FROM events WHERE " + match + " LIMIT 1").get(worktree);
    if (!hasSources && !hasEvents) return;
    this._withWriteTx(() => {
      if (hasSources) {
        this.db.prepare("UPDATE chunks SET session_id = ? WHERE " + match).run(sessionId, worktree);
        this.db.prepare("UPDATE chunks_tri SET session_id = ? WHERE session_id = 'default' AND source_id IN (" + sources + ")").run(sessionId, worktree);
        this.db.prepare("UPDATE sources SET session_id = ? WHERE " + match).run(sessionId, worktree);
      }
      this.db.prepare("UPDATE events SET session_id = ? WHERE " + match).run(sessionId, worktree);
    });
  }

  /** Safely split an oversized single line into <= maxBytes UTF-8 slices */
  _splitOversizedLine(line, maxBytes) {
    const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 1;
    const parts = [];
    let buf = Buffer.from(line, "utf8");
    while (buf.length > limit) {
      let cut = limit;
      // Back up if we landed on a UTF-8 continuation byte (10xxxxxx)
      while (cut > 0 && (buf[cut] & 0xc0) === 0x80) {
        cut -= 1;
      }
      if (cut === 0) cut = Math.min(buf.length, limit);
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
      const fenceMatch = line.length <= 1024 ? /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line) : null;
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
        const headingMatch = parseMarkdownHeadingLinear(line);
        if (headingMatch) {
          const level = headingMatch.level;
          const headingText = headingMatch.text;
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
          WHERE session_id = ? AND worktree = ? AND content_hash = ?
          ORDER BY accessed_ts DESC
          LIMIT 1
        `)
        .get(sid, wt, contentHash);
      if (existing) {
        this._withBusyRetry(() => {
          this.db.prepare("UPDATE sources SET accessed_ts = ? WHERE id = ?").run(now, existing.id);
        });
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

    const id =
      sourceId ||
      `s_${now}_${process.pid.toString(36)}_${randomBytes(3).toString("hex")}_${(++this.sourceCounter).toString(36)}`;
    const isoDate = new Date(now).toISOString();

    const detailedChunks = this.chunkContentDetailed(rawText, MAX_CHUNK_BYTES, { label: lbl, isMarkdown });
    const chunkCount = detailedChunks.length;

    const deleteOldChunks = this.db.prepare("DELETE FROM chunks WHERE source_id = ?");
    const deleteOldChunksTri = this.db.prepare("DELETE FROM chunks_tri WHERE source_id = ?");
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

    this._withWriteTx(() => {
      deleteOldChunks.run(id);
      deleteOldChunksTri.run(id);
      insertSource.run(id, sid, wt, ag, k, lbl, totalBytes, chunkCount, now, isoDate, now, contentHash);

      for (let ord = 0; ord < chunkCount; ord++) {
        const ch = detailedChunks[ord];
        insertChunk.run(id, sid, wt, ag, ord, ch.body, ch.title || lbl);
        insertChunkTri.run(id, sid, ord, ch.body);
      }
    });

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
    const effScope = scope === "all" ? "all" : scope === "worktree" ? "worktree" : "session";
    const effSid = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : "default";
    const effWorktree = typeof worktree === "string" && worktree.trim() ? worktree.trim() : "";
    const isAnonSid = effSid === "default" || effSid.startsWith("workspace:");
    const rootSid =
      effScope === "session" && !isAnonSid && typeof this.resolveRootSessionId === "function"
        ? this.resolveRootSessionId(effSid)
        : effSid;
    const familyIds =
      effScope === "session" && !isAnonSid && typeof this.getSessionFamilyIds === "function"
        ? this.getSessionFamilyIds(rootSid)
        : [rootSid];

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
        }
        if (effScope === "session") {
          if (isAnonSid) {
            sql += " AND (session_id = ? OR source_id IN (SELECT id FROM sources WHERE origin_session_id = ? AND (? = '' OR worktree = ?)))";
            params.push(effSid, effSid, effWorktree, effWorktree);
          } else if (familyIds.length > 1) {
            sql += ` AND session_id IN (${familyIds.map(() => "?").join(",")})`;
            params.push(...familyIds);
          } else {
            sql += " AND session_id = ?";
            params.push(rootSid);
          }
        } else if (effScope === "worktree") {
          if (effWorktree) {
            sql += " AND worktree = ?";
            params.push(effWorktree);
          } else {
            sql += " AND session_id = ?";
            params.push(effSid);
          }
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
        }
        if (effScope === "session") {
          if (isAnonSid) {
            sqlTri += " AND (t.session_id = ? OR (s.origin_session_id = ? AND (? = '' OR s.worktree = ?)))";
            paramsTri.push(effSid, effSid, effWorktree, effWorktree);
          } else if (familyIds.length > 1) {
            sqlTri += ` AND t.session_id IN (${familyIds.map(() => "?").join(",")})`;
            paramsTri.push(...familyIds);
          } else {
            sqlTri += " AND t.session_id = ?";
            paramsTri.push(rootSid);
          }
        } else if (effScope === "worktree") {
          if (effWorktree) {
            sqlTri += " AND s.worktree = ?";
            paramsTri.push(effWorktree);
          } else {
            sqlTri += " AND t.session_id = ?";
            paramsTri.push(effSid);
          }
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
    returnedBytes = 0,
    executionReceipt = null,
    sourceId = null,
    claimFingerprint = null,
    claimedConv = null
  }) {
    this.open();
    const now = new Date().toISOString();
    const insert = this.db.prepare(`
      INSERT INTO events (
        session_id, worktree, agent, kind, tool, key, path, ok, exit_code, bytes, body, turn, sandbox_bytes, returned_bytes, execution_receipt, source_id, claim_fingerprint, claimed_conv, created_at, accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = this._withBusyRetry(() =>
      insert.run(
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
        executionReceipt,
        sourceId || null,
        claimFingerprint || null,
        claimedConv || null,
        now,
        now
      )
    );

    return { seq: result.lastInsertRowid };
  }

  _resolveValidClaimOwner(sessionId) {
    const raw = typeof sessionId === "string" ? sessionId.trim() : "";
    if (
      !raw ||
      raw.length > 128 ||
      /[\x00-\x1f\x7f\\/]/.test(raw) ||
      /^(?:default|all|app|lifetime|__unbound__)$/i.test(raw) ||
      /^workspace:/i.test(raw)
    ) {
      return "";
    }
    this.open();
    const resolved = typeof this.resolveRootSessionId === "function" ? this.resolveRootSessionId(raw) : raw;
    if (
      resolved &&
      resolved.length <= 128 &&
      !/[\x00-\x1f\x7f\\/]/.test(resolved) &&
      !/^(?:default|all|app|lifetime|__unbound__)$/i.test(resolved) &&
      !/^workspace:/i.test(resolved)
    ) {
      return resolved;
    }
    return raw;
  }

  claimExecutionReceipts(sessionId, receipts) {
    if (!Array.isArray(receipts) || !receipts.length) return;
    const owner = this._resolveValidClaimOwner(sessionId);
    if (!owner) return;

    const findPending = this.db.prepare(
      "SELECT seq, source_id FROM events WHERE execution_receipt = ? " +
      "AND (session_id = 'default' OR session_id GLOB 'workspace:*') " +
      "AND ((tool = 'ctx_execute' AND kind = 'execution') OR (tool = 'ctx_index' AND kind = 'index') OR (tool = 'ctx_batch' AND kind = 'batch'))"
    );
    const claimEvent = this.db.prepare(
      "UPDATE events SET session_id = ?, execution_receipt = NULL WHERE seq = ? AND execution_receipt = ?"
    );
    const claimSource = this.db.prepare(
      "UPDATE sources SET session_id = ?, origin_session_id = COALESCE(origin_session_id, session_id) " +
      "WHERE id = ? AND (session_id = 'default' OR session_id GLOB 'workspace:*')"
    );
    const claimChunks = this.db.prepare(
      "UPDATE chunks SET session_id = ? WHERE source_id = ? AND (session_id = 'default' OR session_id GLOB 'workspace:*')"
    );
    const claimChunksTri = this.db.prepare(
      "UPDATE chunks_tri SET session_id = ? WHERE source_id = ? AND (session_id = 'default' OR session_id GLOB 'workspace:*')"
    );

    for (const receipt of receipts) {
      if (typeof receipt !== "string" || !receipt) continue;
      const row = findPending.get(receipt);
      if (!row) continue;
      this._withWriteTx(() => {
        const res = claimEvent.run(owner, row.seq, receipt);
        if (res.changes > 0 && row.source_id) {
          claimSource.run(owner, row.source_id);
          claimChunks.run(owner, row.source_id);
          claimChunksTri.run(owner, row.source_id);
        }
      });
    }
  }

  claimFastToolEvent(sessionId, { fingerprint = "", tool = "", worktree = "", directConvId = "" } = {}) {
    if (typeof fingerprint !== "string" || !fingerprint) return 0;
    const owner = this._resolveValidClaimOwner(sessionId);
    if (!owner) return 0;
    const rawDirect = typeof directConvId === "string" ? directConvId.trim() : "";
    const claimantConv =
      rawDirect && rawDirect.length <= 128 && !/[\x00-\x1f\x7f\\/]/.test(rawDirect) && !/^(?:default|all|app|lifetime|__unbound__)$/i.test(rawDirect)
        ? rawDirect
        : owner;
    const normWt = typeof worktree === "string" ? worktree.trim() : "";
    const toolFilter = typeof tool === "string" && ["read_slices", "run_checks", "batch_search"].includes(tool) ? tool : "";

    let candidate;
    if (toolFilter) {
      candidate = this.db
        .prepare(
          "SELECT seq FROM events WHERE claim_fingerprint = ? AND tool = ? " +
          "AND (session_id = 'default' OR session_id GLOB 'workspace:*') " +
          "ORDER BY CASE WHEN ? != '' AND lower(worktree) = lower(?) THEN 0 ELSE 1 END ASC, seq DESC LIMIT 1"
        )
        .get(fingerprint, toolFilter, normWt, normWt);
    } else {
      candidate = this.db
        .prepare(
          "SELECT seq FROM events WHERE claim_fingerprint = ? AND tool IN ('read_slices', 'run_checks', 'batch_search') " +
          "AND (session_id = 'default' OR session_id GLOB 'workspace:*') " +
          "ORDER BY CASE WHEN ? != '' AND lower(worktree) = lower(?) THEN 0 ELSE 1 END ASC, seq DESC LIMIT 1"
        )
        .get(fingerprint, normWt, normWt);
    }
    if (!candidate) return 0;
    let claimed = 0;
    this._withWriteTx(() => {
      const res = this.db
        .prepare(
          "UPDATE events SET session_id = ?, claimed_conv = ? WHERE seq = ? AND (session_id = 'default' OR session_id GLOB 'workspace:*')"
        )
        .run(owner, claimantConv, candidate.seq);
      claimed = res.changes || 0;
    });
    return claimed;
  }

  claimFastToolClaims(sessionId, claims, { directConvId = "", windowStartIso = "", isFullTranscript = null } = {}) {
    if (!Array.isArray(claims) || !claims.length) return 0;
    const owner = this._resolveValidClaimOwner(sessionId);
    if (!owner) return 0;
    const rawDirect = typeof directConvId === "string" ? directConvId.trim() : "";
    const claimantConv =
      rawDirect && rawDirect.length <= 128 && !/[\x00-\x1f\x7f\\/]/.test(rawDirect) && !/^(?:default|all|app|lifetime|__unbound__)$/i.test(rawDirect)
        ? rawDirect
        : owner;
    const safeWindowIso = typeof windowStartIso === "string" ? windowStartIso.trim() : "";
    const fullMode = typeof isFullTranscript === "boolean" ? isFullTranscript : !safeWindowIso;

    const byFp = new Map();
    for (const item of claims) {
      if (!item || typeof item.fingerprint !== "string" || !item.fingerprint) continue;
      const list = byFp.get(item.fingerprint) || [];
      list.push(item);
      byFp.set(item.fingerprint, list);
    }
    if (byFp.size === 0) return 0;

    const listOwnedStmt =
      claimantConv === owner
        ? this.db.prepare(
            "SELECT seq, created_at FROM events WHERE claim_fingerprint = ? " +
            "AND (claimed_conv = ? OR (claimed_conv IS NULL AND session_id = ?)) " +
            "ORDER BY seq ASC"
          )
        : this.db.prepare(
            "SELECT seq, created_at FROM events WHERE claim_fingerprint = ? " +
            "AND claimed_conv = ? ORDER BY seq ASC"
          );
    const listPendingStmt = this.db.prepare(
      "SELECT seq, tool, created_at FROM events WHERE claim_fingerprint = ? " +
      "AND tool IN ('read_slices', 'run_checks', 'batch_search') " +
      "AND (session_id = 'default' OR session_id GLOB 'workspace:*') " +
      "ORDER BY seq ASC"
    );
    const updateSeqStmt = this.db.prepare(
      "UPDATE events SET session_id = ?, claimed_conv = ? WHERE seq = ? AND (session_id = 'default' OR session_id GLOB 'workspace:*')"
    );

    const pickClosestRow = (rows, anchorMs, winLo = -Infinity, winHi = Infinity) => {
      let pickIdx = -1;
      let bestDiff = Infinity;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (r.used) continue;
        if (winLo > -Infinity || winHi < Infinity) {
          if (!Number.isFinite(r.ts) || r.ts < winLo || r.ts > winHi) continue;
        }
        if (Number.isFinite(anchorMs) && Number.isFinite(r.ts)) {
          const diff = Math.abs(r.ts - anchorMs);
          if (diff < bestDiff) {
            bestDiff = diff;
            pickIdx = i;
          }
        } else if (pickIdx === -1) {
          pickIdx = i;
        }
      }
      return pickIdx;
    };

    let totalClaimed = 0;
    for (const [fp, entries] of byFp.entries()) {
      const pendingRows = listPendingStmt.all(fp).map((r) => ({
        seq: r.seq,
        ts: Date.parse(r.created_at),
        created_at: r.created_at,
        used: false
      }));
      if (!pendingRows.length) continue;

      const ownedRaw =
        claimantConv === owner
          ? listOwnedStmt.all(fp, claimantConv, owner)
          : listOwnedStmt.all(fp, claimantConv);
      const ownedRows = ownedRaw.map((r) => ({
        seq: r.seq,
        ts: Date.parse(r.created_at),
        created_at: r.created_at,
        used: false
      }));

      const selectedSeqs = [];
      if (fullMode) {
        const needed = entries.length - ownedRows.length;
        if (needed <= 0) continue;

        const unmatched = entries.map((entry) => ({
          entry,
          anchor: Number.isFinite(entry.completedAtMs)
            ? entry.completedAtMs
            : Number.isFinite(entry.createdAtMs)
              ? entry.createdAtMs
              : NaN
        }));
        for (const owned of ownedRows) {
          if (unmatched.length === 0) break;
          let matchIdx = 0;
          if (Number.isFinite(owned.ts)) {
            let bestDiff = Infinity;
            for (let i = 0; i < unmatched.length; i++) {
              const diff = Number.isFinite(unmatched[i].anchor)
                ? Math.abs(unmatched[i].anchor - owned.ts)
                : Infinity;
              if (diff < bestDiff) {
                bestDiff = diff;
                matchIdx = i;
              }
            }
          }
          unmatched.splice(matchIdx, 1);
        }

        for (const item of unmatched) {
          const pickIdx = pickClosestRow(pendingRows, item.anchor);
          if (pickIdx === -1) break;
          pendingRows[pickIdx].used = true;
          selectedSeqs.push(pendingRows[pickIdx].seq);
        }
      } else {
        const timed = [];
        const untimed = [];
        for (const entry of entries) {
          if (Number.isFinite(entry.createdAtMs) || Number.isFinite(entry.completedAtMs)) {
            timed.push(entry);
          } else {
            untimed.push(entry);
          }
        }
        for (const entry of timed) {
          const hasStart = Number.isFinite(entry.createdAtMs);
          const hasEnd = Number.isFinite(entry.completedAtMs);
          const anchor = hasEnd ? entry.completedAtMs : entry.createdAtMs;
          const winLo = hasStart && hasEnd
            ? Math.min(entry.createdAtMs, entry.completedAtMs) - 5000
            : anchor - 15000;
          const winHi = hasStart && hasEnd
            ? Math.max(entry.createdAtMs, entry.completedAtMs) + 5000
            : anchor + 5000;

          const ownedIdx = pickClosestRow(ownedRows, anchor, winLo, winHi);
          if (ownedIdx !== -1) {
            ownedRows[ownedIdx].used = true;
            continue;
          }
          const pendIdx = pickClosestRow(pendingRows, anchor, winLo, winHi);
          if (pendIdx !== -1) {
            pendingRows[pendIdx].used = true;
            selectedSeqs.push(pendingRows[pendIdx].seq);
          }
        }
        if (untimed.length > 0) {
          const ownedInWin = ownedRows.filter(
            (r) => !r.used && (!safeWindowIso || r.created_at >= safeWindowIso)
          ).length;
          let neededUntimed = untimed.length - ownedInWin;
          if (neededUntimed > 0) {
            for (const r of pendingRows) {
              if (neededUntimed <= 0) break;
              if (r.used) continue;
              if (safeWindowIso && r.created_at < safeWindowIso) continue;
              r.used = true;
              selectedSeqs.push(r.seq);
              neededUntimed -= 1;
            }
          }
        }
      }

      if (selectedSeqs.length > 0) {
        this._withWriteTx(() => {
          for (const seq of selectedSeqs) {
            const res = updateSeqStmt.run(owner, claimantConv, seq);
            totalClaimed += res.changes || 0;
          }
        });
      }
    }
    return totalClaimed;
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
      const rootSid = typeof this.resolveRootSessionId === "function" ? this.resolveRootSessionId(sid) : sid;
      const familyIds = typeof this.getSessionFamilyIds === "function" ? this.getSessionFamilyIds(rootSid) : [rootSid];
      const inClause = familyIds.length > 1 ? `IN (${familyIds.map(() => "?").join(",")})` : "= ?";
      const sidParams = familyIds.length > 1 ? familyIds : [rootSid];
      sources = this.db
        .prepare(`
          SELECT id, label, kind, bytes_total, chunk_count, created_at
          FROM sources
          WHERE session_id ${inClause}
          ORDER BY created_ts DESC
          LIMIT ?
        `)
        .all(...sidParams, limit);
      events = this.db
        .prepare(`
          SELECT seq, tool, kind, key, path, ok, sandbox_bytes, returned_bytes, agent, created_at
          FROM events
          WHERE session_id ${inClause}
          ORDER BY seq DESC
          LIMIT ?
        `)
        .all(...sidParams, limit);
    }

    return {
      sessionId: sid,
      recentSources: sources,
      recentEvents: events,
      sessionCheckpoint: this.getSessionCheckpoint(sid)
    };
  }

  /** Retrieve full event body by sequence number (scoped to session when sessionId is provided) */
  getEventBySeq(seq, sessionId = null) {
    this.open();
    const numSeq = typeof seq === "object" && seq !== null ? Number(seq.seq) : Number(seq);
    if (!Number.isInteger(numSeq) || numSeq <= 0) return null;
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime" && sessionId !== "app") {
      const rootSid = typeof this.resolveRootSessionId === "function" ? this.resolveRootSessionId(sessionId) : sessionId;
      const familyIds = typeof this.getSessionFamilyIds === "function" ? this.getSessionFamilyIds(rootSid) : [rootSid];
      const inClause = familyIds.length > 1 ? `IN (${familyIds.map(() => "?").join(",")})` : "= ?";
      const sidParams = familyIds.length > 1 ? familyIds : [rootSid];
      const row = this.db.prepare(`SELECT * FROM events WHERE seq = ? AND session_id ${inClause}`).get(numSeq, ...sidParams);
      return row || null;
    }
    if (sessionId === "app") {
      return null;
    }
    const row = this.db.prepare("SELECT * FROM events WHERE seq = ?").get(numSeq);
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
}
