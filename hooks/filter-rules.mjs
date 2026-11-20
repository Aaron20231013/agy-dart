/**
 * Declarative CLI output filter rules for agy-dart PreToolUse.overwrite.
 * Clean-room zero-dependency implementation inspired by MIT-licensed tokf patterns.
 */
import fs from "node:fs";
import path from "node:path";

let smartCrushJsonFn = null;
let isJsonLikeFn = null;
try {
  const crusher = await import("../context/lib/json-crusher.js");
  smartCrushJsonFn = crusher.smartCrushJson;
  isJsonLikeFn = crusher.isJsonLike;
} catch {
  // Fail-open when running from partial isolated copies without json-crusher.js
}

export const MAX_FILTERED_OUTPUT_BYTES = 7900; // Leaves ~900 B headroom for Antigravity overwrite notice (<= 8.8 KB total)

const MAX_PROJECT_RULES_FILE_BYTES = 64 * 1024;
const MAX_PROJECT_RULES_COUNT = 20;
const MAX_CUSTOM_REGEX_LENGTH = 256;
const MAX_PROJECT_RULES_CACHE_ENTRIES = 32;
const CUSTOM_RULE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/;

const projectRulesCache = new Map();

/** Truncate string strictly by UTF-8 byte length without breaking multi-byte characters */
export function truncateUtf8Safe(text, maxBytes) {
  if (!text) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const sliced = Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes)).toString("utf8");
  return sliced.replace(/\uFFFD+$/, "");
}

/** Take strictly the last <= maxBytes UTF-8 bytes without splitting a leading multi-byte character */
export function truncateTailUtf8Safe(text, maxBytes) {
  if (!text) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let start = Math.max(0, buf.length - Math.max(0, maxBytes));
  // Advance past any UTF-8 continuation bytes (10xxxxxx)
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return buf.subarray(start).toString("utf8").replace(/^\uFFFD+/, "");
}

/** Preserve both head context (~35%) and failure tail/summary (~65%) within <= maxBytes UTF-8 */
export function truncateHeadTailUtf8Safe(text, maxBytes) {
  if (!text) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "\n... [middle omitted to stay <=8.8KB; tail failure/summary preserved] ...\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const avail = maxBytes - markerBytes;
  if (avail < 200) return truncateTailUtf8Safe(text, maxBytes);
  const headBudget = Math.floor(avail * 0.35);
  const tailBudget = avail - headBudget;
  const head = truncateUtf8Safe(text, headBudget).replace(/\s+$/, "");
  const tail = truncateTailUtf8Safe(text, tailBudget).replace(/^\s+/, "");
  return `${head}${marker}${tail}`;
}

/** Strip ANSI CSI/OSC sequences and collapse carriage-return progress spinner overwrites */
export function stripAnsiAndProgress(text) {
  if (!text) return "";
  // Strip ANSI OSC and CSI escape sequences
  let clean = text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "");

  // Normalize CRLF -> LF first, then resolve standalone \r progress bar overwrites
  clean = clean.replace(/\r\n/g, "\n");
  if (clean.includes("\r")) {
    clean = clean
      .split("\n")
      .map((line) => {
        if (!line.includes("\r")) return line;
        const parts = line.split("\r").filter((p) => p.length > 0);
        return parts.length > 0 ? parts[parts.length - 1] : "";
      })
      .join("\n");
  }
  return clean;
}

/**
 * Returns true if the command contains shell pipelines, redirections, chaining,
 * subshells, newlines, NUL bytes, cmd.exe expansion/escape characters (`%`, `!`,
 * non-git-rev `^`), or PowerShell script blocks/splatting (`{`, `}`, leading `@` / `@(` / `@{`).
 * Prevents both shell injection and cross-shell semantic drift when rewriting via cli-filter.mjs.
 */
export function hasUnsafeShellSyntax(cmd) {
  if (!cmd || typeof cmd !== "string") return true;
  if (/[\r\n\0|;&<>`$()%!{}]/.test(cmd)) return true;
  // PowerShell splatting (`@var`), array/hash/here-string (`@(`, `@{`, `@"`, `@'`), or cmd `@echo`
  if (/(?:^|\s)@|@[({"']/.test(cmd)) return true;
  // Caret `^`: cmd.exe escape char. Only allow benign git parent-revspec suffixes (e.g. `git diff HEAD^`, `HEAD^1..HEAD`).
  if (cmd.includes("^")) {
    if (!/^\s*git(?:\.exe)?\s+(?:diff|log|show)\b/i.test(cmd)) return true;
    const strippedGitRefs = cmd.replace(/(?<=[A-Za-z0-9_.-])\^+(?:\d+)?(?=\s|\.\.|$)/g, "");
    if (strippedGitRefs.includes("^")) return true;
  }
  return false;
}

const LEADING_SAFE_CD_RE =
  /^(cd(?:\s+\/d)?\s+)("(?:[^"`$%()|;&<>!^{}@\0\r\n]+)"|'(?:[^'`$%()|;&<>!^{}@\0\r\n]+)'|[^\s"'`$%()|;&<>!^{}@\0\r\n]+)(\s+&&\s+)([\s\S]+)$/i;
const TRAILING_STDERR_REDIRECT_RE = /^([\s\S]+?)\s+(2>&1)$/;

/**
 * Safely unwrap optional single leading `cd [/d] <safe_path> && ` and optional
 * single trailing `2>&1`. Rejects subshells, extra chaining, pipes, file redirects,
 * backticks, `$()`, NUL bytes, and unsafe cd targets.
 * Returns { cdPrefix, cdPath, innerCommand, hasStderrRedirect, trailingRedirect } or null.
 */
export function unwrapSafeCompoundCommand(commandLine) {
  if (!commandLine || typeof commandLine !== "string") return null;
  if (/[\r\n\0]/.test(commandLine)) return null;
  const trimmed = commandLine.trim();
  if (!trimmed) return null;

  let cdPrefix = "";
  let cdPath = null;
  let rest = trimmed;

  const cdMatch = LEADING_SAFE_CD_RE.exec(trimmed);
  if (cdMatch) {
    const rawTarget = cdMatch[2];
    let unquoted = rawTarget;
    if (
      (rawTarget.startsWith('"') && rawTarget.endsWith('"')) ||
      (rawTarget.startsWith("'") && rawTarget.endsWith("'"))
    ) {
      unquoted = rawTarget.slice(1, -1);
    } else if (rawTarget.startsWith("-")) {
      // Reject `cd -` (depends on shell OLDPWD) or unknown cd flags
      return null;
    }
    if (!unquoted.trim()) return null;
    cdPrefix = `${cdMatch[1]}${rawTarget}${cdMatch[3]}`;
    cdPath = unquoted;
    rest = cdMatch[4].trim();
  }

  let innerCommand = rest;
  let hasStderrRedirect = false;
  let trailingRedirect = "";

  const redirMatch = TRAILING_STDERR_REDIRECT_RE.exec(rest);
  if (redirMatch) {
    innerCommand = redirMatch[1].trim();
    hasStderrRedirect = true;
    trailingRedirect = " 2>&1";
  }

  if (!innerCommand || hasUnsafeShellSyntax(innerCommand)) {
    return null;
  }

  return {
    cdPrefix,
    cdPath,
    innerCommand,
    hasStderrRedirect,
    trailingRedirect
  };
}

const SKIP_FLAGS_RE =
  /(?:^|\s)(?:--help|-h|--version|-V|--watch|-w|--ui|--interactive|-i|--json|--porcelain(?:=\S+)?|--short|-s|--stat|--numstat|--shortstat|--name-only|--name-status|--format(?:=\S+)?|--pretty(?:=\S+)?|--reporter(?:=|\s+)json|(?:--output|-o)(?:=|\s+)(?:json|yaml|jsonpath\S*|go-template\S*)|-o(?:json|yaml))(?=\s|$)/;

function compactLinesBudget(lines, maxBytes) {
  const out = [];
  let used = 0;
  let omitted = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const b = Buffer.byteLength(line, "utf8") + 1;
    if (used + b > maxBytes) {
      omitted = lines.length - i;
      break;
    }
    out.push(line);
    used += b;
  }
  return { text: out.join("\n"), omitted };
}

/**
 * Defensive zero-dep ReDoS validator for user-provided project filter regexes.
 * Rejects nested quantifiers (e.g. (a+)+, ([a-z]+)*, (.*a){10}), ambiguous
 * quantified alternations (e.g. (a|aa)+), backreferences, huge bounds, and invalid syntax.
 */
export function isSafeRegex(source) {
  if (typeof source !== "string" || source.length === 0 || source.length > MAX_CUSTOM_REGEX_LENGTH) {
    return false;
  }

  const readQuantifier = (str, pos) => {
    if (pos >= str.length) return null;
    const ch = str[pos];
    if (ch === "+" || ch === "*") {
      const lazy = str[pos + 1] === "?" ? 1 : 0;
      return { end: pos + 1 + lazy, isRepeating: true, isUnbounded: true, minZero: ch === "*" };
    }
    if (ch === "?") {
      const lazy = str[pos + 1] === "?" ? 1 : 0;
      return { end: pos + 1 + lazy, isRepeating: false, isUnbounded: false, minZero: true };
    }
    if (ch === "{") {
      const m = /^\{(\d+)(?:,(\d*))?\}/.exec(str.slice(pos));
      if (!m) return null;
      const min = Number(m[1]);
      const hasComma = m[0].includes(",");
      const max = m[2] !== undefined && m[2] !== "" ? Number(m[2]) : hasComma ? Infinity : min;
      if (min > 100 || (Number.isFinite(max) && max > 200) || (Number.isFinite(max) && max < min)) {
        return { invalid: true };
      }
      const nextPos = pos + m[0].length;
      const lazy = str[nextPos] === "?" ? 1 : 0;
      return {
        end: nextPos + lazy,
        isRepeating: max > 1,
        isUnbounded: !Number.isFinite(max),
        minZero: min === 0
      };
    }
    return null;
  };

  const atomsCanOverlap = (a, b) => {
    if (!a || !b) return false;
    if (a === "." || b === ".") return true;
    if (a === b) return true;
    const pair = new Set([a, b]);
    if (
      (pair.has("\\d") && pair.has("\\s")) ||
      (pair.has("\\w") && pair.has("\\s")) ||
      (pair.has("\\d") && pair.has("\\D")) ||
      (pair.has("\\w") && pair.has("\\W")) ||
      (pair.has("\\s") && pair.has("\\S"))
    ) {
      return false;
    }
    const isLit = (x) => x.length === 1 && x !== ".";
    if (isLit(a) && isLit(b)) {
      return a.toLowerCase() === b.toLowerCase();
    }
    const checkShorthandLit = (sh, lit) => {
      if (sh === "\\d") return /[0-9]/.test(lit);
      if (sh === "\\D") return !/[0-9]/.test(lit);
      if (sh === "\\s") return /\s/.test(lit);
      if (sh === "\\S") return !/\s/.test(lit);
      if (sh === "\\w") return /[A-Za-z0-9_]/.test(lit);
      if (sh === "\\W") return !/[A-Za-z0-9_]/.test(lit);
      return true;
    };
    if (a.startsWith("\\") && isLit(b)) return checkShorthandLit(a, b);
    if (b.startsWith("\\") && isLit(a)) return checkShorthandLit(b, a);
    return true;
  };

  const hasAmbiguousAlternation = (branches) => {
    if (branches.length < 2) return false;
    const seen = new Set();
    for (const raw of branches) {
      const b = raw.trim();
      if (!b) return true;
      // Wildcards / character classes / escapes in quantified alternation risk exponential overlap
      if (/[.[\\+*?{]/.test(b)) return true;
      if (seen.has(b)) return true;
      for (const prev of seen) {
        if (prev.startsWith(b) || b.startsWith(prev)) return true;
      }
      seen.add(b);
    }
    return false;
  };

  const stack = [];
  let inCharClass = false;
  let charClassStart = -1;
  let prevUnboundedAtom = null;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (ch === "\\") {
      if (i + 1 >= source.length) return false;
      const next = source[i + 1];
      if (!inCharClass && next >= "1" && next <= "9") {
        // Backreferences can trigger exponential backtracking
        return false;
      }
      if (!inCharClass) {
        const atom = `\\${next}`;
        const isZeroWidthAssertion = next === "b" || next === "B";
        if (stack.length > 0) {
          stack[stack.length - 1].curBranch += atom;
        }
        const q = readQuantifier(source, i + 2);
        if (q?.invalid) return false;
        if (q) {
          if (readQuantifier(source, q.end)) return false;
          if (stack.length > 0) {
            stack[stack.length - 1].hasQuantifier = true;
            stack[stack.length - 1].curBranch += source.slice(i + 2, q.end);
          }
          if (q.isUnbounded) {
            if (atomsCanOverlap(prevUnboundedAtom, atom)) return false;
            prevUnboundedAtom = atom;
          } else if (!q.minZero) {
            prevUnboundedAtom = null;
          }
          i = q.end - 1;
          continue;
        }
        if (!isZeroWidthAssertion) {
          prevUnboundedAtom = null;
        }
      }
      i += 1;
      continue;
    }

    if (inCharClass) {
      if (ch === "]") {
        inCharClass = false;
        const atom = source.slice(charClassStart, i + 1);
        const q = readQuantifier(source, i + 1);
        if (q?.invalid) return false;
        if (q) {
          if (readQuantifier(source, q.end)) return false;
          if (stack.length > 0) {
            stack[stack.length - 1].hasQuantifier = true;
          }
          if (q.isUnbounded) {
            if (atomsCanOverlap(prevUnboundedAtom, atom)) return false;
            prevUnboundedAtom = atom;
          } else if (!q.minZero) {
            prevUnboundedAtom = null;
          }
          i = q.end - 1;
        } else {
          prevUnboundedAtom = null;
        }
      }
      continue;
    }

    if (ch === "[") {
      inCharClass = true;
      charClassStart = i;
      if (stack.length > 0) stack[stack.length - 1].curBranch += "[";
      continue;
    }

    if (ch === "(") {
      if (stack.length >= 6) return false;
      const frame = { hasQuantifier: false, hasAlternation: false, branches: [], curBranch: "" };
      stack.push(frame);
      if (source[i + 1] === "?") {
        if (source[i + 2] === ":" || source[i + 2] === "=" || source[i + 2] === "!") {
          i += 2;
        } else if (source[i + 2] === "<" && (source[i + 3] === "=" || source[i + 3] === "!")) {
          i += 3;
        } else if (source[i + 2] === "<") {
          const closeAngle = source.indexOf(">", i + 3);
          if (closeAngle === -1) return false;
          i = closeAngle;
        }
      }
      prevUnboundedAtom = null;
      continue;
    }

    if (ch === "|") {
      if (stack.length > 0) {
        const top = stack[stack.length - 1];
        top.hasAlternation = true;
        top.branches.push(top.curBranch);
        top.curBranch = "";
      }
      prevUnboundedAtom = null;
      continue;
    }

    if (ch === ")") {
      if (stack.length === 0) return false;
      const frame = stack.pop();
      frame.branches.push(frame.curBranch);
      const q = readQuantifier(source, i + 1);
      if (q?.invalid) return false;
      if (q && q.isRepeating) {
        if (frame.hasQuantifier) return false;
        if (frame.hasAlternation && hasAmbiguousAlternation(frame.branches)) return false;
        // Reject chained quantifier after group quantifier (e.g. (a)+*)
        const q2 = readQuantifier(source, q.end);
        if (q2) return false;
      }
      if (stack.length > 0) {
        const parent = stack[stack.length - 1];
        if (frame.hasQuantifier || q) {
          parent.hasQuantifier = true;
        }
        parent.curBranch += `(${frame.branches.join("|")})`;
      }
      if (q) {
        i = q.end - 1;
      }
      prevUnboundedAtom = null;
      continue;
    }

    if (ch === ".") {
      const q = readQuantifier(source, i + 1);
      if (q?.invalid) return false;
      if (q && q.isUnbounded) {
        if (readQuantifier(source, q.end)) return false;
        if (atomsCanOverlap(prevUnboundedAtom, ".")) return false;
        if (stack.length > 0) stack[stack.length - 1].hasQuantifier = true;
        prevUnboundedAtom = ".";
        i = q.end - 1;
        continue;
      }
      if (q && stack.length > 0) {
        stack[stack.length - 1].hasQuantifier = true;
      }
      if (stack.length > 0) stack[stack.length - 1].curBranch += ".";
      if (!q || !q.minZero) prevUnboundedAtom = null;
      if (q) i = q.end - 1;
      continue;
    }

    if (ch === "+" || ch === "*" || ch === "?" || ch === "{") {
      const q = readQuantifier(source, i);
      if (q?.invalid) return false;
      if (q) {
        if (stack.length > 0) {
          stack[stack.length - 1].hasQuantifier = true;
        }
        const q2 = readQuantifier(source, q.end);
        if (q2) return false;
        if (stack.length > 0) stack[stack.length - 1].curBranch += source.slice(i, q.end);
        i = q.end - 1;
        continue;
      }
    }

    if (stack.length > 0) {
      stack[stack.length - 1].curBranch += ch;
    }
    if (ch === "^" || ch === "$") {
      prevUnboundedAtom = null;
      continue;
    }
    const litQ = readQuantifier(source, i + 1);
    if (litQ?.invalid) return false;
    if (litQ) {
      if (readQuantifier(source, litQ.end)) return false;
      if (stack.length > 0) {
        stack[stack.length - 1].hasQuantifier = true;
        stack[stack.length - 1].curBranch += source.slice(i + 1, litQ.end);
      }
      if (litQ.isUnbounded) {
        if (atomsCanOverlap(prevUnboundedAtom, ch)) return false;
        prevUnboundedAtom = ch;
      } else if (!litQ.minZero) {
        prevUnboundedAtom = null;
      }
      i = litQ.end - 1;
    } else {
      prevUnboundedAtom = null;
    }
  }

  if (inCharClass || stack.length !== 0) return false;

  try {
    new RegExp(source, "i");
    return true;
  } catch {
    return false;
  }
}

/** Rule 1: git status */
function filterGitStatus(combined, exitCode) {
  if (exitCode !== 0) return combined;
  const lines = combined.split("\n");
  const keep = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    // Drop verbose git hint lines
    if (/^\(use "git /i.test(t)) continue;
    if (/^no changes added to commit/i.test(t)) continue;
    if (/^nothing added to commit but untracked/i.test(t)) continue;
    keep.push(raw.trimEnd());
  }
  return keep.join("\n");
}

/** Rule 2: git diff */
function filterGitDiff(combined, exitCode) {
  if (exitCode !== 0) return combined;
  const lines = combined.split("\n");
  const files = [];
  let curFile = null;
  const compactHunks = [];

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const mQuoted = /^diff --git "a\/(.+?)" "b\/(.+)"$/.exec(line);
      const mPlain = !mQuoted ? /^diff --git a\/(.+?) b\/(.+)$/.exec(line) : null;
      const name = mQuoted ? mQuoted[2] : mPlain ? mPlain[2] : line.slice(11);
      curFile = { name, added: 0, removed: 0 };
      files.push(curFile);
      compactHunks.push(`=== ${name}`);
      continue;
    }
    if (line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      continue;
    }
    if (line.startsWith("@@ ")) {
      compactHunks.push(line);
      continue;
    }
    if (line.startsWith("+")) {
      if (curFile) curFile.added += 1;
      compactHunks.push(line);
      continue;
    }
    if (line.startsWith("-")) {
      if (curFile) curFile.removed += 1;
      compactHunks.push(line);
      continue;
    }
    if (
      line.startsWith("new file mode ") ||
      line.startsWith("deleted file mode ") ||
      line.startsWith("old mode ") ||
      line.startsWith("new mode ") ||
      line.startsWith("Binary files ") ||
      line.startsWith("rename from ") ||
      line.startsWith("rename to ") ||
      line.startsWith("copy from ") ||
      line.startsWith("copy to ")
    ) {
      compactHunks.push(line);
    }
  }

  if (files.length === 0) return combined;

  const summaryHeader = [
    `Files changed: ${files.length}`,
    ...files.slice(0, 40).map((f) => `  ${f.name} (+${f.added} / -${f.removed})`),
    ...(files.length > 40 ? [`  ... (+${files.length - 40} more files)`] : []),
    ""
  ].join("\n");

  const headerBytes = Buffer.byteLength(summaryHeader, "utf8");
  const hunkBudget = Math.max(1200, MAX_FILTERED_OUTPUT_BYTES - headerBytes - 300);
  const { text: hunkText, omitted } = compactLinesBudget(compactHunks, hunkBudget);
  const tail = omitted > 0 ? `\n... [+${omitted} diff lines omitted; narrow with 'git diff -- <file>' or ctx_search]` : "";
  return `${summaryHeader}${hunkText}${tail}`;
}

/** Rule 3: git log */
function filterGitLog(combined, exitCode) {
  if (exitCode !== 0) return combined;
  const lines = combined.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  if (lines.length <= 40 && Buffer.byteLength(combined, "utf8") <= 3500) {
    return lines.join("\n");
  }
  // Compact full multi-line commit blocks into concise single-line entries when default format was used
  const commits = [];
  let curHash = "";
  let curAuthor = "";
  let curDate = "";
  let curMsg = "";
  const flush = () => {
    if (!curHash) return;
    commits.push(`${curHash.slice(0, 8)} ${curDate ? `[${curDate}] ` : ""}${curAuthor ? `<${curAuthor}> ` : ""}${curMsg}`.trim());
    curHash = "";
    curAuthor = "";
    curDate = "";
    curMsg = "";
  };
  let sawCommitHeader = false;
  for (const line of lines) {
    const cm = /^commit\s+([0-9a-f]{7,40})/i.exec(line);
    if (cm) {
      sawCommitHeader = true;
      flush();
      curHash = cm[1];
      continue;
    }
    if (sawCommitHeader) {
      if (line.startsWith("Author:")) {
        curAuthor = line.slice(7).replace(/<[^>]+>/, "").trim().slice(0, 24);
      } else if (line.startsWith("Date:")) {
        curDate = line.slice(5).trim().slice(0, 16);
      } else if (!curMsg && line.trim()) {
        curMsg = line.trim().slice(0, 100);
      }
    }
  }
  flush();
  if (sawCommitHeader && commits.length > 0) {
    const shown = commits.slice(0, 35);
    if (commits.length > shown.length) {
      shown.push(`... [+${commits.length - shown.length} more commits omitted]`);
    }
    return shown.join("\n");
  }
  const shownLines = lines.slice(0, 45);
  if (lines.length > shownLines.length) {
    shownLines.push(`... [+${lines.length - shownLines.length} more lines omitted]`);
  }
  return shownLines.join("\n");
}

/** Rule 4: test runners (node --test, npm/pnpm/yarn test, vitest, jest, pytest, go test, cargo test) */
function filterTestRunner(combined, exitCode) {
  const lines = combined.split("\n").map((l) => l.trimEnd());
  const nonEmpty = lines.filter((l) => l.trim().length > 0);

  const summaryRe =
    /(?:^|\s)(?:tests?\s+\d+|suites?\s+\d+|pass(?:ed)?\s*[:=]?\s*\d+|fail(?:ed|ures?)?\s*[:=]?\s*\d+|skipped?\s*[:=]?\s*\d+|duration_ms|test result:|passed in \d|failed in \d|ran \d+ tests?|total:\s*\d+|Tests:\s+|Test Suites:\s+|FAIL\s+|PASS\s+|ok\s+\S+\s+\d|---\s+FAIL:|errors?\b)/i;

  if (exitCode === 0) {
    // Passing run: keep summary lines, warnings, and test count totals; collapse passing checklists
    const kept = [];
    for (const line of nonEmpty) {
      if (
        summaryRe.test(line) ||
        /\bwarn(?:ing)?\b/i.test(line) ||
        /^ℹ\s+(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/i.test(line.trim())
      ) {
        kept.push(line);
      }
    }
    if (kept.length > 0) {
      const unique = [];
      for (const l of kept) {
        if (unique[unique.length - 1] !== l) unique.push(l);
      }
      return `PASS (exit 0) — ${nonEmpty.length} raw lines compacted:\n${unique.slice(-40).join("\n")}`;
    }
    // Fallback: last 20 lines
    return `PASS (exit 0) — tail:\n${nonEmpty.slice(-20).join("\n")}`;
  }

  // Failing run: strip pure passing check lines, keep all failure blocks, assertions, stacks & summary
  const passNoiseRe = /^\s*(?:✔|✓|ok\s+\d+|PASS\s+|test\s+\S+\s+\.\.\.\s+ok\s*$|---\s+PASS:|passed\b.*\[100%\]|\.\s*$)/i;
  const kept = [];
  for (const line of lines) {
    if (passNoiseRe.test(line)) continue;
    kept.push(line);
  }
  const collapsed = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return collapsed || combined;
}

/** Rule 5: build / lint / typecheck */
function filterBuildLint(combined, exitCode) {
  const lines = combined.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  if (exitCode === 0) {
    const important = lines.filter((l) =>
      /(?:warn(?:ing)?|error|built in|compiled|finished|done in|0 errors|succeeded|bundle|dist\/)/i.test(l)
    );
    if (important.length > 0 && important.length < lines.length) {
      return `OK (exit 0) — ${lines.length} raw lines compacted:\n${important.slice(-30).join("\n")}`;
    }
    return lines.slice(-25).join("\n");
  }

  // On failure: deduplicate repeated lines & strip progress noise while preserving all errors + context
  const progressRe = /^\s*(?:Compiling\s+|Downloading\s+|Updating\s+|Checking\s+|Fetching\s+|transforming\s*\(|rendering chunks|computing gzip)/i;
  const kept = [];
  for (const l of lines) {
    if (progressRe.test(l)) continue;
    if (kept[kept.length - 1] === l) continue;
    kept.push(l);
  }
  return kept.join("\n");
}

/** Rule 6: package install */
function filterPkgInstall(combined, exitCode) {
  const lines = combined.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  if (exitCode === 0) {
    const kept = lines.filter((l) =>
      /(?:added|removed|changed|audited|up to date|vulnerabilit|done in|installed|successfully|resolved|packages|warn|error)/i.test(l) &&
      !/npm warn deprecated/i.test(l) &&
      !/looking for funding/i.test(l)
    );
    return kept.length > 0 ? kept.slice(-25).join("\n") : lines.slice(-15).join("\n");
  }
  return lines.filter((l) => !/looking for funding/i.test(l)).slice(-80).join("\n");
}

/** Rule 7: docker build */
function filterDockerBuild(combined, exitCode) {
  const lines = combined.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  if (exitCode === 0) {
    const kept = lines.filter((l) =>
      /(?:^#\d+\s+\[|naming to|exporting to image|FINISHED|ERROR|WARN|Successfully built|Successfully tagged)/i.test(l)
    );
    return kept.length > 0 ? kept.slice(-35).join("\n") : lines.slice(-20).join("\n");
  }
  // Keep error tail
  return lines.slice(-100).join("\n");
}

/** Rule 8: GitHub CLI (gh pr view/diff/checks, gh run view, gh issue view) */
function filterGhCli(combined, exitCode) {
  if (exitCode !== 0) return combined;
  if (combined.includes("diff --git ")) {
    return filterGitDiff(combined, exitCode);
  }
  const lines = combined.split("\n").map((l) => l.trimEnd());
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length <= 45 && Buffer.byteLength(combined, "utf8") <= 4500) {
    return combined.replace(/\n{3,}/g, "\n\n").trim();
  }
  const importantRe =
    /(?:^(?:title|state|author|labels|assignees|reviewers|projects|milestone|number|url|branch|head|base|status|conclusion|workflow|job|step|checks?):|\b(?:FAIL|FAILED|ERROR|WARN|WARNING|CANCELLED|TIMED_OUT|SKIPPED|PENDING|PASS|PASSED|SUCCESS)\b|[✓✔✘×✗])/i;
  const head = nonEmpty.slice(0, 20);
  const tailImportant = nonEmpty.slice(20).filter((l) => importantRe.test(l));
  const merged = [...head];
  if (tailImportant.length > 0) {
    const omitted = nonEmpty.length - head.length - tailImportant.length;
    if (omitted > 0) merged.push(`... [+${omitted} body/log lines omitted]`);
    merged.push(...tailImportant.slice(-45));
  } else {
    merged.push(`... [+${nonEmpty.length - head.length - 15} middle lines omitted]`, ...nonEmpty.slice(-15));
  }
  return merged.join("\n");
}

/** Rule 9: Kubernetes CLI (kubectl logs/describe/get) */
function filterKubectl(combined, exitCode) {
  const lines = combined.split("\n").map((l) => l.trimEnd());
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length <= 45 && Buffer.byteLength(combined, "utf8") <= 4500) {
    return nonEmpty.join("\n");
  }

  // Collapse consecutive identical lines first
  const deduped = [];
  let repeatCount = 0;
  for (let i = 0; i < nonEmpty.length; i++) {
    const line = nonEmpty[i];
    if (deduped.length > 0 && deduped[deduped.length - 1] === line) {
      repeatCount += 1;
      continue;
    }
    if (repeatCount > 0) {
      deduped.push(`  ... [repeated ${repeatCount}x]`);
      repeatCount = 0;
    }
    deduped.push(line);
  }
  if (repeatCount > 0) deduped.push(`  ... [repeated ${repeatCount}x]`);

  if (exitCode !== 0) {
    return deduped.slice(-100).join("\n");
  }

  const probeNoiseRe = /(?:kube-probe|GET\s+\/(?:healthz|livez|readyz|metrics)\b.*\s200\b)/i;
  const cleaned = deduped.filter((l) => !probeNoiseRe.test(l));
  if (cleaned.length <= 60) return cleaned.join("\n");

  const anomalyRe =
    /(?:error|err\b|warn(?:ing)?|fatal|panic|exception|fail(?:ed|ure)?|CrashLoopBackOff|OOMKilled|ImagePullBackOff|ErrImagePull|Evicted|Unhealthy|BackOff|Pending|Terminating|Events:|Conditions:|Status:|State:|Last State:|Restart Count:)/i;
  const header = cleaned.slice(0, 15);
  const middle = cleaned.slice(15, -20).filter((l) => anomalyRe.test(l));
  const tail = cleaned.slice(-20);
  const out = [...header];
  if (middle.length > 0) {
    out.push(`... [filtered ${cleaned.length - 35} lines -> ${middle.length} alert/status lines]`);
    out.push(...middle.slice(-30));
  } else {
    out.push(`... [+${cleaned.length - 35} middle lines omitted]`);
  }
  out.push(...tail);
  return out.join("\n");
}

/** Rule 10: Terraform (terraform plan/apply/validate) */
function filterTerraform(combined, exitCode) {
  const lines = combined.split("\n").map((l) => l.trimEnd());
  const refreshNoiseRe =
    /^\s*\S+:\s+(?:Refreshing state|Reading\.\.\.|Read complete after|Still reading|Still creating|Still modifying|Still destroying)\b/i;

  const withoutRefresh = lines.filter((l) => !refreshNoiseRe.test(l));
  if (exitCode !== 0) {
    return withoutRefresh.join("\n").replace(/\n{3,}/g, "\n\n").trim() || combined;
  }

  const nonEmpty = withoutRefresh.filter((l) => l.trim().length > 0);
  if (nonEmpty.length <= 50 && Buffer.byteLength(withoutRefresh.join("\n"), "utf8") <= 4500) {
    return withoutRefresh.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  const keepRe =
    /(?:^\s*#\s+\S+\s+(?:will be|must be|has changed|is tainted)|^\s*[+\-~!]\s+(?:resource|module|data)|^Plan:|^Apply complete!|^Destroy complete!|^No changes\.|^Success!|^Outputs:|^(?:│\s*)?(?:Error|Warning):|^[╷╵])/i;
  const kept = nonEmpty.filter((l) => keepRe.test(l));
  if (kept.length > 0) {
    return `Terraform OK (exit 0) — ${lines.length} raw lines compacted:\n${kept.slice(-70).join("\n")}`;
  }
  return nonEmpty.slice(-35).join("\n");
}

/** Rule 11: Playwright test runner */
function filterPlaywright(combined, exitCode) {
  const lines = combined.split("\n").map((l) => l.trimEnd());
  const nonEmpty = lines.filter((l) => l.trim().length > 0);

  if (exitCode === 0) {
    const keepRe =
      /(?:Running\s+\d+\s+tests?|\b\d+\s+(?:passed|failed|flaky|skipped|interrupted)\b|Slow test file|\bwarn(?:ing)?\b)/i;
    const kept = nonEmpty.filter((l) => keepRe.test(l));
    if (kept.length > 0) {
      return `PASS (exit 0) — ${nonEmpty.length} raw lines compacted:\n${kept.slice(-35).join("\n")}`;
    }
    return `PASS (exit 0) — tail:\n${nonEmpty.slice(-20).join("\n")}`;
  }

  // On failure: strip passing test lines, keep all failure blocks, locators, call logs & summary
  const passLineRe = /^\s*(?:✓|✔|ok\s+\d+)\s+\d+\s+\[[^\]]+\]/i;
  const kept = lines.filter((l) => !passLineRe.test(l));
  const collapsed = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return collapsed || combined;
}

/** Apply a declarative project rule from .agy-dart/filters.json */
function filterDeclarativeRule(ruleDef, combined, exitCode) {
  const rawLines = combined.split("\n").map((l) => l.trimEnd());
  const nonEmpty = rawLines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return combined;

  let lines = nonEmpty;
  if (ruleDef.drop) {
    lines = lines.filter((l) => {
      if (!ruleDef.drop.test(l)) return true;
      // Preserve explicit keep matches even if they also match drop
      if (ruleDef.keep && ruleDef.keep.test(l)) return true;
      return false;
    });
  }

  let kept = lines;
  if (ruleDef.keep) {
    const matched = lines.filter((l) => ruleDef.keep.test(l));
    if (matched.length > 0) {
      kept = matched;
    } else if (exitCode !== 0) {
      // Never swallow an unexpected crash/error if keep pattern didn't match
      kept = lines.slice(-ruleDef.maxLines);
    } else {
      kept = lines.slice(-Math.min(20, ruleDef.maxLines));
    }
  }

  const maxLines = ruleDef.maxLines;
  if (kept.length > maxLines) {
    if (exitCode !== 0 && ruleDef.preserveTailOnFail) {
      const headCount = Math.max(1, Math.floor(maxLines * 0.35));
      const tailCount = Math.max(1, maxLines - headCount);
      const omitted = kept.length - headCount - tailCount;
      kept = [
        ...kept.slice(0, headCount),
        `... [+${omitted} lines omitted; tail preserved]`,
        ...kept.slice(-tailCount)
      ];
    } else {
      const omitted = kept.length - maxLines;
      kept = [...kept.slice(0, maxLines), `... [+${omitted} lines omitted]`];
    }
  }

  return kept.join("\n");
}

/**
 * Load declarative project-level filter rules from `<cwd>/.agy-dart/filters.json`.
 * Cached by `absPath + mtimeMs + size`, max 64 KB, max 20 rules, strictly fail-open
 * on missing/malformed files or ReDoS-prone/invalid regexes.
 */
export function loadProjectFilterRules(cwd = process.cwd()) {
  if (!cwd || typeof cwd !== "string") return [];
  const absPath = path.join(path.resolve(cwd), ".agy-dart", "filters.json");

  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    projectRulesCache.delete(absPath);
    return [];
  }

  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_PROJECT_RULES_FILE_BYTES) {
    projectRulesCache.delete(absPath);
    return [];
  }

  const cached = projectRulesCache.get(absPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.rules;
  }

  let parsed;
  try {
    const raw = fs.readFileSync(absPath, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.rules)) {
    return [];
  }
  if (parsed.rules.length > MAX_PROJECT_RULES_COUNT) {
    return [];
  }

  const seenIds = new Set();
  const compiled = [];

  for (const item of parsed.rules) {
    if (!item || typeof item !== "object") continue;
    const rawId = typeof item.id === "string" ? item.id.trim() : "";
    if (!CUSTOM_RULE_ID_RE.test(rawId) || seenIds.has(rawId)) continue;

    if (typeof item.match !== "string" || !isSafeRegex(item.match)) continue;
    let matchRe;
    try {
      matchRe = new RegExp(item.match, "i");
    } catch {
      continue;
    }

    let keepRe = null;
    if (item.keep !== undefined && item.keep !== null && item.keep !== "") {
      if (typeof item.keep !== "string" || !isSafeRegex(item.keep)) continue;
      try {
        keepRe = new RegExp(item.keep, "i");
      } catch {
        continue;
      }
    }

    let dropRe = null;
    if (item.drop !== undefined && item.drop !== null && item.drop !== "") {
      if (typeof item.drop !== "string" || !isSafeRegex(item.drop)) continue;
      try {
        dropRe = new RegExp(item.drop, "i");
      } catch {
        continue;
      }
    }

    const rawMaxLines = Number(item.maxLines);
    const maxLines =
      Number.isInteger(rawMaxLines) && rawMaxLines >= 1
        ? Math.min(500, rawMaxLines)
        : 80;
    const preserveTailOnFail =
      typeof item.preserveTailOnFail === "boolean" ? item.preserveTailOnFail : true;

    const ruleDef = {
      id: `custom:${rawId}`,
      rawId,
      custom: true,
      pattern: matchRe,
      keep: keepRe,
      drop: dropRe,
      maxLines,
      preserveTailOnFail,
      filter: null
    };
    ruleDef.filter = (combined, exitCode) => filterDeclarativeRule(ruleDef, combined, exitCode);

    seenIds.add(rawId);
    compiled.push(ruleDef);
  }

  if (projectRulesCache.size >= MAX_PROJECT_RULES_CACHE_ENTRIES) {
    const oldestKey = projectRulesCache.keys().next().value;
    if (oldestKey !== undefined) projectRulesCache.delete(oldestKey);
  }
  projectRulesCache.set(absPath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    rules: compiled
  });

  return compiled;
}

export const FILTER_RULES = [
  {
    id: "git-status",
    pattern: /^git(?:\.exe)?\s+status(?:\s|$)/i,
    filter: filterGitStatus
  },
  {
    id: "git-diff",
    pattern: /^git(?:\.exe)?\s+diff(?:\s|$)/i,
    filter: filterGitDiff
  },
  {
    id: "git-log",
    pattern: /^git(?:\.exe)?\s+log(?:\s|$)/i,
    // Never strip diff hunks or custom graph/raw views when user explicitly asks for patches
    skipFlags: /(?:^|\s)(?:-p|--patch|-u|--raw|--graph|--cc)(?=\s|$)/,
    filter: filterGitLog,
    prepareCommand(cmd) {
      const hasBound =
        /(?:^|\s)(?:-n\s*\d+|-\d+|--max-count(?:=|\s)\d+|--since(?:=|\s)\S+|--after(?:=|\s)\S+|\S+\.\.\S+)(?=\s|$)/i.test(
          cmd
        );
      if (hasBound) return { effectiveCommand: cmd, note: null };
      const bounded = cmd.replace(/^git(?:\.exe)?\s+log\b/i, "$& -n 30");
      return { effectiveCommand: bounded, note: "bounded unbounded git log to -n 30" };
    }
  },
  {
    id: "test-runner",
    preserveTailOnFail: true,
    pattern:
      /^(?:(?:npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?\s+(?:run\s+)?test(?:\s|$)|node(?:\.exe)?\s+--test(?:\s|$)|(?:npx(?:\.cmd)?\s+)?(?:vitest|jest|mocha|ava)(?:\s|$)|pytest(?:\s|$)|python(?:3)?(?:\.exe)?\s+-m\s+(?:pytest|unittest)(?:\s|$)|go(?:\.exe)?\s+test(?:\s|$)|cargo(?:\.exe)?\s+test(?:\s|$)|dotnet(?:\.exe)?\s+test(?:\s|$))/i,
    filter: filterTestRunner
  },
  {
    id: "build-lint",
    preserveTailOnFail: true,
    pattern:
      /^(?:(?:npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?\s+(?:run\s+)?(?:build|lint|typecheck|check)(?:\s|$)|(?:npx(?:\.cmd)?\s+)?(?:tsc|eslint|biome|vite\s+build|next\s+build|webpack)(?:\s|$)|ruff\s+check(?:\s|$)|mypy(?:\s|$)|flake8(?:\s|$)|cargo(?:\.exe)?\s+(?:build|check|clippy)(?:\s|$)|go(?:\.exe)?\s+(?:build|vet)(?:\s|$)|dotnet(?:\.exe)?\s+build(?:\s|$))/i,
    filter: filterBuildLint
  },
  {
    id: "pkg-install",
    preserveTailOnFail: true,
    pattern:
      /^(?:(?:npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?\s+(?:install|i|ci|add|update)(?:\s|$)|(?:pip|pip3|uv\s+pip)(?:\.exe)?\s+install(?:\s|$))/i,
    filter: filterPkgInstall
  },
  {
    id: "docker-build",
    preserveTailOnFail: true,
    pattern: /^docker(?:\.exe)?\s+(?:compose\s+)?build(?:\s|$)/i,
    filter: filterDockerBuild
  },
  {
    id: "gh-cli",
    preserveTailOnFail: true,
    pattern: /^gh(?:\.exe)?\s+(?:pr\s+(?:view|diff|checks)|run\s+view|issue\s+view)(?:\s|$)/i,
    skipFlags: /(?:^|\s)(?:--web|--jq(?:=|\s)\S+|--template(?:=|\s)\S+)(?=\s|$)/,
    filter: filterGhCli
  },
  {
    id: "kubectl",
    preserveTailOnFail: true,
    pattern: /^kubectl(?:\.exe)?\s+(?:logs|describe|get)(?:\s|$)/i,
    skipFlags: /(?:^|\s)(?:-f|--follow)(?=\s|$)/,
    filter: filterKubectl
  },
  {
    id: "terraform",
    preserveTailOnFail: true,
    pattern: /^terraform(?:\.exe)?\s+(?:plan|apply|validate)(?:\s|$)/i,
    skipFlags: /(?:^|\s)-json(?=\s|$)/,
    filter: filterTerraform
  },
  {
    id: "playwright",
    preserveTailOnFail: true,
    pattern: /^(?:(?:npx|pnpm|yarn|bunx)(?:\.cmd|\.exe)?\s+)?playwright(?:\.cmd|\.exe)?\s+test(?:\s|$)/i,
    filter: filterPlaywright
  }
];

function rewrapCompound(unwrapped, effectiveInner) {
  return `${unwrapped.cdPrefix}${effectiveInner}${unwrapped.trailingRedirect}`;
}

/**
 * Determine whether a CommandLine should be transparently rewritten through cli-filter.mjs.
 * Supports optional safe single leading `cd [/d] <path> &&` and trailing `2>&1`.
 * Checks built-in rules first, then valid repo-level `.agy-dart/filters.json` rules.
 * Returns { rule, effectiveCommand, note } or null if command should run untouched.
 */
export function matchFilterRule(commandLine, options = {}) {
  if (!commandLine || typeof commandLine !== "string") return null;
  const trimmed = commandLine.trim();
  if (!trimmed) return null;
  if (trimmed.includes("cli-filter.mjs")) return null;

  const unwrapped = unwrapSafeCompoundCommand(trimmed);
  if (!unwrapped) return null;
  const inner = unwrapped.innerCommand;
  if (SKIP_FLAGS_RE.test(inner)) return null;

  for (const rule of FILTER_RULES) {
    if (rule.pattern.test(inner)) {
      if (rule.skipFlags && rule.skipFlags.test(inner)) {
        return null;
      }
      if (typeof rule.prepareCommand === "function") {
        const prep = rule.prepareCommand(inner);
        return {
          rule,
          effectiveCommand: rewrapCompound(unwrapped, prep.effectiveCommand),
          note: prep.note || null
        };
      }
      return {
        rule,
        effectiveCommand: rewrapCompound(unwrapped, inner),
        note: null
      };
    }
  }

  // Fallback to project-level declarative rules (.agy-dart/filters.json)
  const cwd = options?.cwd || process.cwd();
  const projectRules = loadProjectFilterRules(cwd);
  for (const rule of projectRules) {
    if (rule.pattern.test(inner)) {
      return {
        rule,
        effectiveCommand: rewrapCompound(unwrapped, inner),
        note: null
      };
    }
  }

  return null;
}

/**
 * Apply the matched filter rule to raw stdout/stderr and enforce the <= 7900 B UTF-8 cap.
 * Automatically runs structural JSON/JSONL SmartCrusher when output is large JSON/JSONL.
 */
export function applyFilterRule(ruleId, rawStdout, rawStderr, exitCode = 0, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_FILTERED_OUTPUT_BYTES;
  const rawCombined =
    (rawStdout || "") +
    (rawStderr ? (rawStdout && !rawStdout.endsWith("\n") ? "\n" : "") + rawStderr : "");
  const rawBytes = Buffer.byteLength(rawCombined, "utf8");
  const cleaned = stripAnsiAndProgress(rawCombined);

  let rule = FILTER_RULES.find((r) => r.id === ruleId);
  if (!rule && typeof ruleId === "string" && ruleId.startsWith("custom:")) {
    const cwd = options.cwd || process.cwd();
    const projectRules = loadProjectFilterRules(cwd);
    rule = projectRules.find((r) => r.id === ruleId) || null;
  }

  const noteParts = [];
  if (options.note) noteParts.push(options.note);
  const sourceHint = options.sourceId
    ? ` full output indexed as ${options.sourceId} (query via agy-dart_context ctx_search)`
    : "";

  const reserveFooter = Math.max(
    220,
    140 +
      Buffer.byteLength(String(ruleId || ""), "utf8") +
      Buffer.byteLength(noteParts.join(", "), "utf8") +
      Buffer.byteLength(sourceHint, "utf8")
  );
  const jsonCrushThreshold = Math.max(512, maxBytes - 300);
  const crushBudget = Math.max(256, maxBytes - reserveFooter);

  let filtered = "";
  let crushedJson = false;
  let truncated = false;

  // For large JSON/JSONL payloads without explicit line keep/drop overrides, crush structurally
  // instead of mangling JSON lines or blindly byte-truncating mid-object.
  const hasExplicitLineFilters = Boolean(rule?.custom && (rule.keep || rule.drop));
  if (
    !hasExplicitLineFilters &&
    smartCrushJsonFn &&
    isJsonLikeFn &&
    Buffer.byteLength(cleaned, "utf8") > jsonCrushThreshold &&
    isJsonLikeFn(cleaned)
  ) {
    const crushed = smartCrushJsonFn(cleaned, {
      maxBytes: crushBudget,
      sourceId: options.sourceId || null
    });
    if (crushed.crushed) {
      filtered = crushed.text;
      crushedJson = true;
      noteParts.push("json-crushed");
    }
  }

  if (!crushedJson) {
    filtered = rule ? rule.filter(cleaned, exitCode) : cleaned;
    if (!filtered && cleaned) filtered = cleaned;

    // Also structurally crush if post-rule output is STILL large JSON/JSONL
    if (
      smartCrushJsonFn &&
      isJsonLikeFn &&
      Buffer.byteLength(filtered, "utf8") > jsonCrushThreshold &&
      isJsonLikeFn(filtered)
    ) {
      const crushed = smartCrushJsonFn(filtered, {
        maxBytes: crushBudget,
        sourceId: options.sourceId || null
      });
      if (crushed.crushed) {
        filtered = crushed.text;
        crushedJson = true;
        noteParts.push("json-crushed");
      }
    }
  }

  const keepTail = exitCode !== 0 && Boolean(rule?.preserveTailOnFail);
  if (Buffer.byteLength(filtered, "utf8") > maxBytes - reserveFooter) {
    filtered = keepTail
      ? truncateHeadTailUtf8Safe(filtered, maxBytes - reserveFooter)
      : truncateUtf8Safe(filtered, maxBytes - reserveFooter);
    truncated = true;
  }

  let filteredBodyBytes = Buffer.byteLength(filtered, "utf8");
  // Never inflate tiny already-compact outputs when no truncation, JSON crush, or rewrite note occurred
  if (
    !truncated &&
    !crushedJson &&
    !options.note &&
    filteredBodyBytes >= rawBytes &&
    Buffer.byteLength(cleaned, "utf8") <= maxBytes
  ) {
    filtered = cleaned;
    filteredBodyBytes = Buffer.byteLength(filtered, "utf8");
  }

  const savedBytes = Math.max(0, rawBytes - filteredBodyBytes);
  const wasFiltered = truncated || crushedJson || savedBytes >= 256 || Boolean(options.note);

  if (wasFiltered) {
    const pct = rawBytes > 0 ? ((savedBytes / rawBytes) * 100).toFixed(0) : "0";
    const meta = [
      `rule=${ruleId}`,
      `${rawBytes}B -> ${filteredBodyBytes}B (-${pct}%)`,
      ...noteParts
    ].join(", ");
    const footer = `\n[agy-dart cli-filter: ${meta}${truncated ? ", capped <=8.8KB" : ""}${sourceHint ? `;${sourceHint}` : ""}]`;
    const combinedWithFooter = filtered + footer;
    filtered =
      Buffer.byteLength(combinedWithFooter, "utf8") <= maxBytes
        ? combinedWithFooter
        : (keepTail
            ? truncateHeadTailUtf8Safe(filtered, maxBytes - Buffer.byteLength(footer, "utf8"))
            : truncateUtf8Safe(filtered, maxBytes - Buffer.byteLength(footer, "utf8"))) + footer;
  }

  const finalBytes = Buffer.byteLength(filtered, "utf8");
  return {
    filteredText: filtered,
    rawBytes,
    filteredBytes: finalBytes,
    wasFiltered,
    truncated,
    crushedJson
  };
}
