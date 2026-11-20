#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { ContextModeStore } from "../context/lib/store.js";

export const DEFAULT_MAX_READ_BYTES = 16384; // 16 KB balanced default (~410 lines)
export const DEFAULT_MAX_LINE_RANGE = 410;
const CTX_SERVER = "agy-dart_context";
const FAST_SERVER = "agy-dart_fast";

let sharedStore = null;
function getSharedStore() {
  if (!sharedStore) {
    sharedStore = new ContextModeStore();
  }
  return sharedStore;
}

function closeSharedStore() {
  if (sharedStore) {
    try {
      sharedStore.close();
    } catch {}
    sharedStore = null;
  }
}

function isProtectionPaused(sessionId = null) {
  try {
    return getSharedStore().isPaused(sessionId);
  } catch {
    return false;
  }
}

function getMaxReadBytes(sessionId = null) {
  try {
    return getSharedStore().getCutoff(sessionId);
  } catch {
    const envVal = process.env.CONTEXT_MODE_MAX_READ_BYTES;
    if (envVal) {
      const parsed = parseInt(envVal, 10);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return DEFAULT_MAX_READ_BYTES;
  }
}

function getExemptExtensions(sessionId = null) {
  try {
    return getSharedStore().getExemptExtensions(sessionId);
  } catch {
    return Array.from(BINARY_EXTENSIONS);
  }
}

function getMaxLineRange(maxReadBytes = DEFAULT_MAX_READ_BYTES) {
  const envVal = process.env.CONTEXT_MODE_MAX_LINE_RANGE;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  if (maxReadBytes === 0) return 0;
  return Math.max(50, Math.round(maxReadBytes / 40));
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${Number.isInteger(kb) ? kb : kb.toFixed(1)} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(2)} MB`;
}

export function cleanStringArg(val) {
  if (val === undefined || val === null) return "";
  let str = String(val).trim();
  while (
    (str.startsWith('"') && str.endsWith('"') && str.length >= 2) ||
    (str.startsWith("'") && str.endsWith("'") && str.length >= 2)
  ) {
    str = str.slice(1, -1).trim();
  }
  return str;
}

export function cleanFilePath(val) {
  let p = cleanStringArg(val);
  if (!p) return "";
  if (p.startsWith("file:///")) {
    p = p.slice(8);
  } else if (p.startsWith("file://")) {
    p = p.slice(7);
  }
  try {
    p = decodeURIComponent(p);
  } catch {}
  p = p.replace(/#L\d+(-L\d+)?$/i, "");
  return path.normalize(p.trim());
}

export function parseLineArg(val) {
  if (val === undefined || val === null) return null;
  const str = cleanStringArg(val);
  if (!str || str.toLowerCase() === "null" || str.toLowerCase() === "undefined") {
    return null;
  }
  const parsed = parseInt(str, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

const KNOWN_TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".mdown", ".mkd", ".rst", ".adoc",
  ".cs", ".csx", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
  ".py", ".pyw", ".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".hh",
  ".rs", ".go", ".java", ".kt", ".kts", ".scala", ".rb", ".php",
  ".sh", ".bash", ".ps1", ".psm1", ".psd1", ".bat", ".cmd",
  ".html", ".htm", ".xhtml", ".css", ".scss", ".sass", ".less",
  ".json", ".jsonc", ".json5", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".sql", ".graphql", ".gql", ".diff", ".patch", ".txt", ".text", ".log", ".csv", ".tsv",
  ".vue", ".svelte", ".gd"
]);

const BINARY_EXTENSIONS = new Set([
  ".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tiff", ".tif",
  ".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".mp4", ".webm", ".mkv", ".avi", ".mov",
  ".zip", ".tar", ".gz", ".7z", ".rar", ".exe", ".dll", ".so", ".dylib", ".bin",
  ".blend", ".fbx", ".obj", ".gltf", ".glb", ".wasm"
]);

const AGENT_INSTRUCTION_BASENAMES = new Set([
  "skill.md",
  "agents.md",
  "gemini.md",
  "claude.md"
]);

function isUserAttachedFile(filePath, absPath) {
  const normalized = (absPath || filePath || "").replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/.user_uploaded/") ||
    normalized.includes("/user_uploaded/") ||
    normalized.includes("/.system_generated/uploads/")
  );
}

/** Exempt Antigravity's own skills, rules, and builtin manuals so agents can read instructions whole */
export function isAgentInstructionFile(filePath, absPath) {
  const raw = (absPath || filePath || "").replace(/\\/g, "/");
  const lower = raw.toLowerCase();
  const base = path.posix.basename(lower);
  if (AGENT_INSTRUCTION_BASENAMES.has(base)) {
    return true;
  }
  return (
    lower.includes("/.gemini/antigravity/builtin/") ||
    lower.includes("/.gemini/config/skills/") ||
    lower.includes("/.gemini/config/rules/") ||
    lower.includes("/.agents/skills/") ||
    lower.includes("/.agents/rules/")
  );
}

function isBinaryFile(absPath, ext) {
  const lowerExt = (ext || "").toLowerCase();
  if (KNOWN_TEXT_EXTENSIONS.has(lowerExt)) return false;
  if (BINARY_EXTENSIONS.has(lowerExt)) return true;
  try {
    const fd = fs.openSync(absPath, "r");
    const buf = Buffer.alloc(512);
    const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    if (bytesRead === 0) return false;
    if (bytesRead >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return false;
    if (bytesRead >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return false;
    if (bytesRead >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return true;
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
  } catch {}
  return false;
}

export function resolveSharedSessionId(payload = {}) {
  return (
    payload.rootConversationId ||
    payload.root_conversation_id ||
    payload.parentConversationId ||
    payload.parent_conversation_id ||
    process.env.ANTIGRAVITY_ROOT_CONVERSATION_ID ||
    process.env.ANTIGRAVITY_PARENT_CONVERSATION_ID ||
    process.env.ANTIGRAVITY_CONVERSATION_ID ||
    payload.conversationId ||
    payload.conversation_id ||
    payload.sessionId ||
    payload.session_id ||
    "default"
  );
}

export function resolveAgentName(payload = {}) {
  return (
    payload.agent ||
    payload.agentName ||
    payload.agent_name ||
    payload.agentType ||
    payload.agent_type ||
    payload.role ||
    (payload.subagent ? "subagent" : "antigravity")
  );
}

function recordInterception({ sessionId, agent, cwd, toolName, path: targetPath, size, reason }) {
  try {
    getSharedStore().recordEvent({
      sessionId: sessionId || "default",
      worktree: cwd || process.cwd(),
      agent: agent || "antigravity",
      kind: "interception",
      tool: toolName,
      key: "blocked",
      path: targetPath || null,
      ok: 0,
      exitCode: 1,
      bytes: size || 0,
      body: reason,
      sandboxBytes: size || 0,
      returnedBytes: 0
    });
  } catch {}
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
}

export function inspectCommand({ commandLine, cwd, sessionId }) {
  if (!commandLine || typeof commandLine !== "string") {
    return { shouldDeny: false };
  }

  const cleanCmd = cleanStringArg(commandLine);
  const maxReadBytes = getMaxReadBytes(sessionId);
  const exemptExtensions = getExemptExtensions(sessionId);

  // 1. Unbounded git log
  if (/^\s*git\s+log\b/i.test(cleanCmd)) {
    const isLimited = /(-n\s+\d+|-\d+|--max-count|\s*\|\s*(head|Select-Object|select|more))/i.test(cleanCmd);
    if (!isLimited) {
      return {
        shouldDeny: true,
        reason:
          `[agy-dart protection] 'git log' without a count limiter risks dumping thousands of commits into context. ` +
          `Use ${FAST_SERVER} batch_search(type:"git", pattern:"log -n 10 --oneline"), add '-n 10', or run inside call_mcp_tool(ServerName:"${CTX_SERVER}", ToolName:"ctx_execute").`,
        size: 32768,
        targetPath: "git log"
      };
    }
  }

  // 2. Direct curl / wget to stdout
  if (/^\s*(curl(\.exe)?|wget(\.exe)?)\b/i.test(cleanCmd)) {
    const writesToFile = /(-o\s+|-O\s+|--output\s+|>)/i.test(cleanCmd);
    const hasLimiter = /\|\s*(head|Select-Object|select|more)/i.test(cleanCmd);
    if (!writesToFile && !hasLimiter) {
      const urlMatch = cleanCmd.match(/https?:\/\/[^\s"']+/i);
      if (urlMatch) {
        try {
          const parsedUrl = new URL(urlMatch[0]);
          const ext = path.extname(parsedUrl.pathname).toLowerCase();
          if (ext && exemptExtensions.includes(ext)) {
            return { shouldDeny: false };
          }
        } catch {}
      }
      return {
        shouldDeny: true,
        reason:
          `[agy-dart protection] Direct curl/wget output to stdout risks flooding the context window. ` +
          `Use call_mcp_tool(ServerName:"${CTX_SERVER}", ToolName:"ctx_execute" or "ctx_index"), save to disk ('-o <file>'), or append '| head -n 50'.`,
        size: 32768,
        targetPath: urlMatch ? urlMatch[0] : cleanCmd
      };
    }
  }

  // 3. Raw file dump utilities (cat, type, Get-Content, gc)
  const printMatch = cleanCmd.match(/^\s*(cat|type|Get-Content|gc)(\.exe)?\b/i);
  if (printMatch) {
    const hasLimiter =
      /(-Head|-TotalCount|-First|-Tail)\s+\d+/i.test(cleanCmd) ||
      /\|\s*(head|Select-Object|select\s+(-[a-zA-Z]+\s+)*-First|more|Out-Null|Set-Content|Out-File)/i.test(cleanCmd) ||
      />\s*[^>]/i.test(cleanCmd);

    if (hasLimiter) return { shouldDeny: false };

    const argMatch = cleanCmd.match(/(?:cat|type|Get-Content|gc)(?:\.exe)?(?:\s+(?:-Path|-LiteralPath))?\s+["']?([^"'\r\n;|]+)["']?/i);
    const rawTarget = argMatch && argMatch[1] ? argMatch[1].trim() : "";

    if (rawTarget.includes("*") || rawTarget.includes("?")) {
      return {
        shouldDeny: true,
        reason:
          `[agy-dart protection] Wildcard file dump ('${rawTarget}') risks flooding the context window. ` +
          `Use call_mcp_tool(ServerName:"${CTX_SERVER}", ToolName:"ctx_execute") or append '| Select-Object -First 50'.`,
        size: 32768,
        targetPath: rawTarget
      };
    }

    if (rawTarget) {
      const cleanTarget = cleanFilePath(rawTarget);
      const absPath = path.isAbsolute(cleanTarget) ? cleanTarget : path.resolve(cwd, cleanTarget);
      try {
        if (fs.existsSync(absPath)) {
          if (isAgentInstructionFile(rawTarget, absPath)) return { shouldDeny: false };
          const ext = path.extname(absPath).toLowerCase();
          if (ext && exemptExtensions.includes(ext)) return { shouldDeny: false };
          const stat = fs.statSync(absPath);
          if (maxReadBytes > 0 && stat.size > maxReadBytes) {
            return {
              shouldDeny: true,
              reason:
                `[agy-dart protection] Command attempts an un-paged dump of '${cleanTarget}' (${formatBytes(stat.size)}), ` +
                `exceeding the ${formatBytes(maxReadBytes)} context limit. ` +
                `Use call_mcp_tool(ServerName:"${CTX_SERVER}", ToolName:"ctx_execute") or append '| Select-Object -First 50' / '-Head 50'.`,
              size: stat.size,
              targetPath: cleanTarget
            };
          }
          return { shouldDeny: false };
        }
      } catch {}

      return {
        shouldDeny: true,
        reason:
          `[agy-dart protection] Command matches an un-paged file dump ('${rawTarget}') that could flood the context window. ` +
          `Use call_mcp_tool(ServerName:"${CTX_SERVER}", ToolName:"ctx_execute") or append '| Select-Object -First 50' / '| head -n 50'.`,
        size: 32768,
        targetPath: cleanTarget || rawTarget
      };
    }
  }

  return { shouldDeny: false };
}

function finishAllow() {
  closeSharedStore();
  process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
  process.exit(0);
}

async function main() {
  const rawInput = await readStdin();
  if (!rawInput.trim()) return finishAllow();

  let payload;
  try {
    payload = JSON.parse(rawInput);
  } catch {
    return finishAllow();
  }

  const toolCall = payload.toolCall || {};
  const toolName = toolCall.name || "";
  const args = toolCall.args || {};
  const cwd = payload.cwd || process.cwd();
  const sessionId = resolveSharedSessionId(payload);
  const agentName = resolveAgentName(payload);

  if (isProtectionPaused(sessionId)) {
    return finishAllow();
  }

  // 1. Guard read_file / view_file (unless disabled via env for ultra-low-latency mode B)
  if ((toolName === "read_file" || toolName === "view_file") && process.env.AGY_DART_DISABLE_READ_HOOK !== "1") {
    const rawFilePath = args.Path || args.path || args.filePath || "";
    const filePath = cleanFilePath(rawFilePath);
    const startLine = parseLineArg(args.StartLine ?? args.startLine) ?? 1;
    const endLine = parseLineArg(args.EndLine ?? args.endLine);
    const maxReadBytes = getMaxReadBytes(sessionId);
    const maxLineRange = getMaxLineRange(maxReadBytes);

    if (filePath) {
      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
      try {
        if (fs.existsSync(absPath)) {
          const ext = path.extname(absPath).toLowerCase();
          const isUserAttachment = isUserAttachedFile(rawFilePath, absPath);
          const isAgentDoc = isAgentInstructionFile(rawFilePath, absPath);
          const exemptExtensions = getExemptExtensions(sessionId);
          const isExemptExt = exemptExtensions.includes(ext);
          const isBinary = isBinaryFile(absPath, ext);

          if (isUserAttachment || isAgentDoc || isExemptExt || isBinary) {
            return finishAllow();
          }

          const stat = fs.statSync(absPath);
          const isLargeFile = maxReadBytes > 0 && stat.size > maxReadBytes;
          const isWideRange = maxLineRange > 0 && (endLine === null || (endLine - startLine) > maxLineRange);

          if (isLargeFile && isWideRange) {
            const lineInstruction =
              maxLineRange > 0
                ? ` or outline via ${FAST_SERVER} read_slices({ outlines }) then pass StartLine/EndLine (<= ${maxLineRange} lines).`
                : "";
            const reason =
              `[agy-dart protection] File is ${formatBytes(stat.size)} (~${Math.round(stat.size / 4).toLocaleString()} tokens), exceeding the ${formatBytes(maxReadBytes)} context limit. ` +
              `Reading the entire file risks severe context bloat. ` +
              `For logs/docs/data use call_mcp_tool(ServerName:"${CTX_SERVER}", ToolName:"ctx_index" or "ctx_execute", path:"${filePath}")${lineInstruction}`;

            recordInterception({
              sessionId,
              agent: agentName,
              cwd,
              toolName,
              path: filePath,
              size: stat.size,
              reason
            });

            closeSharedStore();
            process.stdout.write(JSON.stringify({ decision: "deny", reason }) + "\n");
            process.exit(0);
          }
        }
      } catch {}
    }
  }

  // 2. Guard run_command
  if (toolName === "run_command") {
    const rawCommandLine = args.CommandLine || args.commandLine || args.command || "";
    const inspection = inspectCommand({ commandLine: rawCommandLine, cwd, sessionId });

    if (inspection.shouldDeny) {
      recordInterception({
        sessionId,
        agent: agentName,
        cwd,
        toolName,
        path: inspection.targetPath || cleanStringArg(rawCommandLine),
        size: inspection.size || 32768,
        reason: inspection.reason
      });

      closeSharedStore();
      process.stdout.write(JSON.stringify({ decision: "deny", reason: inspection.reason }) + "\n");
      process.exit(0);
    }
  }

  return finishAllow();
}

main().catch(() => {
  finishAllow();
});
