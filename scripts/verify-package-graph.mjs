#!/usr/bin/env node
/**
 * Static import-graph verifier for agy-dart packaging (`scripts/install.mjs`).
 *
 * Traverses all runtime entrypoints declared in hooks.json, mcp_config.json,
 * sidecars/dashboard/sidecar.json, and scripts/install.mjs to prove:
 *   1. Every transitively imported local JS/MJS module or spawned helper script
 *      is listed in RUNTIME_FILES (zero missing-module install bugs).
 *   2. Every file in RUNTIME_FILES and DEVTOOLS_FILES exists on disk.
 *   3. Zero DEVTOOLS_FILES leak into the runtime import graph.
 *   4. Every module transitively imported by DEVTOOLS_FILES is covered by
 *      RUNTIME_FILES U DEVTOOLS_FILES.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEVTOOLS_FILES, FILES_TO_COPY, RUNTIME_FILES } from "./install.mjs";

const __selfPath = path.resolve(fileURLToPath(import.meta.url));
const __dirname = path.dirname(__selfPath);
const REPO_ROOT = path.resolve(__dirname, "..");

function toPosixRel(rootDir, absPath) {
  return path.relative(rootDir, absPath).replace(/\\/g, "/");
}

const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "throw",
  "case",
  "delete",
  "void",
  "typeof",
  "yield",
  "await",
  "in",
  "instanceof",
  "of",
  "new",
  "else",
  "do",
  "export",
  "default"
]);

const ID_START_RE = /[\p{ID_Start}$_]/u;
const ID_CONT_RE = /[\p{ID_Continue}$]/u;

function canStartRegexLiteral(prevToken) {
  if (!prevToken) return true;
  if (prevToken.type === "punct") {
    return prevToken.value !== ")" && prevToken.value !== "]" && prevToken.value !== "++" && prevToken.value !== "--";
  }
  if (prevToken.type === "ident") {
    return REGEX_PRECEDING_KEYWORDS.has(prevToken.value);
  }
  return false;
}

/**
 * Lightweight, linear-time JS lexer that strips comments, preserves strings/template
 * expressions without leaking comment markers inside strings or fake imports inside
 * string/template literals, and produces a flat token stream for specifier extraction.
 */
function tokenizeJsForSpecifiers(source) {
  const tokens = [];
  const n = source.length;
  let i = 0;

  // Skip leading shebang line
  if (source.startsWith("#!")) {
    while (i < n && source[i] !== "\n") i++;
  }

  // Stack of brace depths for active `${ ... }` template interpolations
  const templateBraceStack = [];

  const scanTemplateChunk = (startIdx) => {
    let p = startIdx;
    let raw = "";
    while (p < n) {
      const c = source[p];
      if (c === "\\") {
        if (p + 1 < n) {
          raw += source[p + 1];
          p += 2;
        } else {
          p++;
        }
        continue;
      }
      if (c === "`") {
        return { end: p + 1, interpolated: false, raw };
      }
      if (c === "$" && source[p + 1] === "{") {
        return { end: p + 2, interpolated: true, raw };
      }
      raw += c;
      p++;
    }
    return { end: n, interpolated: false, raw };
  };

  while (i < n) {
    const ch = source[i];

    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\f" || ch === "\v") {
      i++;
      continue;
    }

    // Line comment
    if (ch === "/" && source[i + 1] === "/") {
      i += 2;
      while (i < n && source[i] !== "\n" && source[i] !== "\r") i++;
      continue;
    }

    // Block comment
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i = i < n ? i + 2 : n;
      continue;
    }

    // Regex literal vs division operator
    if (ch === "/") {
      const prev = tokens.length > 0 ? tokens[tokens.length - 1] : null;
      if (canStartRegexLiteral(prev)) {
        let p = i + 1;
        let inClass = false;
        let closed = false;
        while (p < n) {
          const rc = source[p];
          if (rc === "\n" || rc === "\r") break;
          if (rc === "\\") {
            p += 2;
            continue;
          }
          if (rc === "[") {
            inClass = true;
            p++;
            continue;
          }
          if (rc === "]") {
            inClass = false;
            p++;
            continue;
          }
          if (rc === "/" && !inClass) {
            closed = true;
            p++;
            while (p < n && /[a-zA-Z]/.test(source[p])) p++;
            break;
          }
          p++;
        }
        if (closed) {
          tokens.push({ type: "other", value: "regex" });
          i = p;
          continue;
        }
      }
      tokens.push({ type: "punct", value: "/" });
      i++;
      continue;
    }

    // Single or double quoted string literal
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let p = i + 1;
      let val = "";
      while (p < n) {
        const sc = source[p];
        if (sc === "\\") {
          if (p + 1 < n) {
            const esc = source[p + 1];
            if (esc === "\r" && source[p + 2] === "\n") {
              p += 3;
              continue;
            }
            if (esc === "n") val += "\n";
            else if (esc === "r") val += "\r";
            else if (esc === "t") val += "\t";
            else if (esc !== "\n" && esc !== "\r") val += esc;
            p += 2;
          } else {
            p++;
          }
          continue;
        }
        if (sc === quote) {
          p++;
          break;
        }
        if (sc === "\n" || sc === "\r") break;
        val += sc;
        p++;
      }
      tokens.push({ type: "string", value: val });
      i = p;
      continue;
    }

    // Template literal
    if (ch === "`") {
      const chunk = scanTemplateChunk(i + 1);
      if (chunk.interpolated) {
        tokens.push({ type: "other", value: "template" });
        templateBraceStack.push(0);
      } else {
        tokens.push({ type: "template_static", value: chunk.raw });
      }
      i = chunk.end;
      continue;
    }

    // Track brace nesting for active template literal interpolations
    if (templateBraceStack.length > 0) {
      if (ch === "{") {
        templateBraceStack[templateBraceStack.length - 1] += 1;
      } else if (ch === "}") {
        if (templateBraceStack[templateBraceStack.length - 1] === 0) {
          templateBraceStack.pop();
          const chunk = scanTemplateChunk(i + 1);
          if (chunk.interpolated) {
            templateBraceStack.push(0);
          }
          tokens.push({ type: "other", value: "template" });
          i = chunk.end;
          continue;
        }
        templateBraceStack[templateBraceStack.length - 1] -= 1;
      }
    }

    // Identifier / keyword
    if (ID_START_RE.test(ch)) {
      let p = i + 1;
      while (p < n && ID_CONT_RE.test(source[p])) p++;
      tokens.push({ type: "ident", value: source.slice(i, p) });
      i = p;
      continue;
    }

    // Number literal
    if (ch >= "0" && ch <= "9") {
      let p = i + 1;
      while (p < n && /[0-9a-zA-Z_.]/.test(source[p])) p++;
      tokens.push({ type: "other", value: source.slice(i, p) });
      i = p;
      continue;
    }

    // Increment/decrement operators (keep `/` after `a++` or `a--` as division, not regex)
    if ((ch === "+" && source[i + 1] === "+") || (ch === "-" && source[i + 1] === "-")) {
      tokens.push({ type: "punct", value: ch + ch });
      i += 2;
      continue;
    }

    // Punctuation
    tokens.push({ type: "punct", value: ch });
    i++;
  }

  return tokens;
}

/**
 * Extract relative JS/MJS module specifiers and sibling script references from source text.
 */
export function extractLocalSpecifiers(source, fileAbsPath, rootDir = REPO_ROOT) {
  const tokens = tokenizeJsForSpecifiers(source);
  const found = new Set();
  const dir = path.dirname(fileAbsPath);

  const isStringLike = (tok) => Boolean(tok && (tok.type === "string" || tok.type === "template_static"));
  const isIdent = (tok, val) => Boolean(tok && tok.type === "ident" && (val === undefined || tok.value === val));
  const isPunct = (tok, val) => Boolean(tok && tok.type === "punct" && tok.value === val);

  const addRel = (spec) => {
    if (!spec || typeof spec !== "string") return;
    if (!spec.startsWith("./") && !spec.startsWith("../")) return;
    const candidate = path.resolve(dir, spec);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      found.add(toPosixRel(rootDir, candidate));
    }
  };

  const findMatchingBrace = (openIdx) => {
    let depth = 0;
    for (let k = openIdx; k < tokens.length; k++) {
      if (isPunct(tokens[k], "{")) depth++;
      else if (isPunct(tokens[k], "}")) {
        depth--;
        if (depth === 0) return k;
      }
    }
    return -1;
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const prev = i > 0 ? tokens[i - 1] : null;
    const afterDot = isPunct(prev, ".");

    // 1. Static & dynamic `import` statements/expressions
    if (!afterDot && isIdent(tok, "import")) {
      const t1 = tokens[i + 1];
      if (!t1) continue;

      // Side-effect import: import "./x.js"
      if (t1.type === "string") {
        addRel(t1.value);
        i += 1;
        continue;
      }

      // Dynamic import: import("./x.js") or import("./data.json", { with: { type: "json" } })
      if (isPunct(t1, "(")) {
        const arg = tokens[i + 2];
        const sep = tokens[i + 3];
        if (isStringLike(arg) && (isPunct(sep, ")") || isPunct(sep, ","))) {
          addRel(arg.value);
        }
        continue;
      }

      // import * as ns from "./x.js"
      if (isPunct(t1, "*") && isIdent(tokens[i + 2], "as") && isIdent(tokens[i + 3]) && isIdent(tokens[i + 4], "from") && tokens[i + 5]?.type === "string") {
        addRel(tokens[i + 5].value);
        i += 5;
        continue;
      }

      // import { ... } from "./x.js"
      if (isPunct(t1, "{")) {
        const closeIdx = findMatchingBrace(i + 1);
        if (closeIdx !== -1 && isIdent(tokens[closeIdx + 1], "from") && tokens[closeIdx + 2]?.type === "string") {
          addRel(tokens[closeIdx + 2].value);
          i = closeIdx + 2;
        }
        continue;
      }

      // import def from "./x.js" | import def, * as ns from "./x.js" | import def, { ... } from "./x.js"
      if (isIdent(t1)) {
        const t2 = tokens[i + 2];
        if (isIdent(t2, "from") && tokens[i + 3]?.type === "string") {
          addRel(tokens[i + 3].value);
          i += 3;
          continue;
        }
        if (isPunct(t2, ",")) {
          const t3 = tokens[i + 3];
          if (isPunct(t3, "*") && isIdent(tokens[i + 4], "as") && isIdent(tokens[i + 5]) && isIdent(tokens[i + 6], "from") && tokens[i + 7]?.type === "string") {
            addRel(tokens[i + 7].value);
            i += 7;
            continue;
          }
          if (isPunct(t3, "{")) {
            const closeIdx = findMatchingBrace(i + 3);
            if (closeIdx !== -1 && isIdent(tokens[closeIdx + 1], "from") && tokens[closeIdx + 2]?.type === "string") {
              addRel(tokens[closeIdx + 2].value);
              i = closeIdx + 2;
              continue;
            }
          }
        }
      }
      continue;
    }

    // 2. Static `export ... from "./x.js"` re-exports (never bleeds from `export { local }` or `export const`)
    if (!afterDot && isIdent(tok, "export")) {
      const t1 = tokens[i + 1];
      if (!t1) continue;

      if (isPunct(t1, "*")) {
        if (isIdent(tokens[i + 2], "from") && tokens[i + 3]?.type === "string") {
          addRel(tokens[i + 3].value);
          i += 3;
          continue;
        }
        if (
          isIdent(tokens[i + 2], "as") &&
          (isIdent(tokens[i + 3]) || tokens[i + 3]?.type === "string") &&
          isIdent(tokens[i + 4], "from") &&
          tokens[i + 5]?.type === "string"
        ) {
          addRel(tokens[i + 5].value);
          i += 5;
          continue;
        }
      } else if (isPunct(t1, "{")) {
        const closeIdx = findMatchingBrace(i + 1);
        if (closeIdx !== -1) {
          if (isIdent(tokens[closeIdx + 1], "from") && tokens[closeIdx + 2]?.type === "string") {
            addRel(tokens[closeIdx + 2].value);
            i = closeIdx + 2;
          } else {
            i = closeIdx;
          }
        }
      }
      continue;
    }

    // 3. CommonJS require("./...")
    if (!afterDot && isIdent(tok, "require") && isPunct(tokens[i + 1], "(")) {
      const arg = tokens[i + 2];
      if (isStringLike(arg) && isPunct(tokens[i + 3], ")")) {
        addRel(arg.value);
        i += 3;
      }
      continue;
    }

    // 4. Relative URL asset/module resolution via new URL("./...", import.meta.url)
    if (
      !afterDot &&
      isIdent(tok, "new") &&
      isIdent(tokens[i + 1], "URL") &&
      isPunct(tokens[i + 2], "(") &&
      isStringLike(tokens[i + 3]) &&
      isPunct(tokens[i + 4], ",") &&
      isIdent(tokens[i + 5], "import") &&
      isPunct(tokens[i + 6], ".") &&
      isIdent(tokens[i + 7], "meta") &&
      isPunct(tokens[i + 8], ".") &&
      isIdent(tokens[i + 9], "url")
    ) {
      addRel(tokens[i + 3].value);
      i += 9;
      continue;
    }

    // 5. Direct sibling/child helper script spawns via path.resolve/join(__dirname, ...)
    if (
      !afterDot &&
      isIdent(tok, "path") &&
      isPunct(tokens[i + 1], ".") &&
      (isIdent(tokens[i + 2], "resolve") || isIdent(tokens[i + 2], "join")) &&
      isPunct(tokens[i + 3], "(") &&
      isIdent(tokens[i + 4], "__dirname") &&
      isPunct(tokens[i + 5], ",")
    ) {
      const parts = [];
      let k = i + 6;
      let valid = true;
      while (k < tokens.length && !isPunct(tokens[k], ")")) {
        if (isStringLike(tokens[k])) {
          parts.push(tokens[k].value);
          k++;
          if (isPunct(tokens[k], ",")) k++;
        } else {
          valid = false;
          break;
        }
      }
      if (valid && parts.length > 0 && isPunct(tokens[k], ")")) {
        const last = parts[parts.length - 1];
        if (/\.(?:m?js|cjs|html|json|svg|md)$/i.test(last)) {
          const candidate = path.resolve(dir, ...parts);
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            found.add(toPosixRel(rootDir, candidate));
          }
        }
        i = k;
      }
    }
  }

  return Array.from(found).sort();
}

export function discoverRuntimeEntrypoints(rootDir = REPO_ROOT) {
  const entries = new Set(["scripts/install.mjs"]);

  // 1. hooks.json
  const hooksJson = JSON.parse(fs.readFileSync(path.join(rootDir, "hooks.json"), "utf8"));
  const collectHookCommands = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) collectHookCommands(item);
      return;
    }
    if (typeof node.command === "string") {
      const m = node.command.match(/\bnode\s+(?:\.\/)?([^\s"']+\.m?js)/i);
      if (m) entries.add(m[1].replace(/\\/g, "/"));
    }
    for (const v of Object.values(node)) collectHookCommands(v);
  };
  collectHookCommands(hooksJson);

  // 2. mcp_config.json
  const mcpJson = JSON.parse(fs.readFileSync(path.join(rootDir, "mcp_config.json"), "utf8"));
  for (const srv of Object.values(mcpJson.mcpServers || {})) {
    for (const arg of srv.args || []) {
      const cleaned = String(arg).replace(/^\$\{PLUGIN_ROOT\}[\\/]/, "").replace(/\\/g, "/");
      if (/\.(?:m?js|cjs)$/i.test(cleaned)) entries.add(cleaned);
    }
  }

  // 3. sidecars/dashboard/sidecar.json
  const sidecarDir = path.join(rootDir, "sidecars", "dashboard");
  const sidecarJson = JSON.parse(fs.readFileSync(path.join(sidecarDir, "sidecar.json"), "utf8"));
  for (const arg of sidecarJson.args || []) {
    if (/\.(?:m?js|cjs)$/i.test(String(arg))) {
      entries.add(toPosixRel(rootDir, path.resolve(sidecarDir, String(arg))));
    }
  }

  return Array.from(entries).sort();
}

export function collectImportGraph(entrypoints, rootDir = REPO_ROOT) {
  const visited = new Set();
  const edges = new Map();
  const queue = [...entrypoints];

  while (queue.length > 0) {
    const rel = queue.shift().replace(/\\/g, "/");
    if (visited.has(rel)) continue;
    visited.add(rel);
    const abs = path.join(rootDir, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      edges.set(rel, []);
      continue;
    }
    if (!/\.(?:m?js|cjs)$/i.test(rel)) {
      edges.set(rel, []);
      continue;
    }
    const src = fs.readFileSync(abs, "utf8");
    const deps = extractLocalSpecifiers(src, abs, rootDir);
    edges.set(rel, deps);
    for (const d of deps) {
      if (!visited.has(d)) queue.push(d);
    }
  }

  return {
    reachable: Array.from(visited).sort(),
    edges: Object.fromEntries(Array.from(edges.entries()).sort(([a], [b]) => a.localeCompare(b)))
  };
}

export function verifyPackageManifest(rootDir = REPO_ROOT) {
  const runtimeSet = new Set(RUNTIME_FILES);
  const devtoolsSet = new Set(DEVTOOLS_FILES);
  const allSet = new Set(FILES_TO_COPY);

  const missingOnDisk = FILES_TO_COPY.filter((rel) => !fs.existsSync(path.join(rootDir, rel)));
  const overlap = RUNTIME_FILES.filter((rel) => devtoolsSet.has(rel));

  const runtimeEntries = discoverRuntimeEntrypoints(rootDir);
  const runtimeGraph = collectImportGraph(runtimeEntries, rootDir);
  const missingFromRuntimeManifest = runtimeGraph.reachable.filter((rel) => !runtimeSet.has(rel));
  const devtoolsLeakedIntoRuntime = runtimeGraph.reachable.filter((rel) => devtoolsSet.has(rel));

  const devtoolsGraph = collectImportGraph(DEVTOOLS_FILES, rootDir);
  const missingFromFullManifest = devtoolsGraph.reachable.filter((rel) => !allSet.has(rel));

  const ok =
    missingOnDisk.length === 0 &&
    overlap.length === 0 &&
    missingFromRuntimeManifest.length === 0 &&
    devtoolsLeakedIntoRuntime.length === 0 &&
    missingFromFullManifest.length === 0;

  return {
    ok,
    runtimeEntrypoints: runtimeEntries,
    runtimeReachableCount: runtimeGraph.reachable.length,
    runtimeManifestCount: RUNTIME_FILES.length,
    devtoolsManifestCount: DEVTOOLS_FILES.length,
    missingOnDisk,
    overlap,
    missingFromRuntimeManifest,
    devtoolsLeakedIntoRuntime,
    missingFromFullManifest,
    runtimeGraph: runtimeGraph.edges
  };
}

const isDirectRun = Boolean(
  process.argv[1] &&
    (process.platform === "win32"
      ? path.resolve(process.argv[1]).toLowerCase() === __selfPath.toLowerCase()
      : path.resolve(process.argv[1]) === __selfPath)
);

if (isDirectRun) {
  const asJson = process.argv.includes("--json");
  const report = verifyPackageManifest(REPO_ROOT);
  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    console.log(`Package import-graph verification: ${report.ok ? "PASS" : "FAIL"}`);
    console.log(`  - Runtime entrypoints : ${report.runtimeEntrypoints.length} (${report.runtimeEntrypoints.join(", ")})`);
    console.log(`  - Reachable modules   : ${report.runtimeReachableCount} (manifest runtime=${report.runtimeManifestCount}, devtools=${report.devtoolsManifestCount})`);
    if (report.missingOnDisk.length) console.error(`  - Missing on disk     : ${report.missingOnDisk.join(", ")}`);
    if (report.overlap.length) console.error(`  - Manifest overlap    : ${report.overlap.join(", ")}`);
    if (report.missingFromRuntimeManifest.length) console.error(`  - Missing from RUNTIME_FILES: ${report.missingFromRuntimeManifest.join(", ")}`);
    if (report.devtoolsLeakedIntoRuntime.length) console.error(`  - Devtools leaked into runtime: ${report.devtoolsLeakedIntoRuntime.join(", ")}`);
    if (report.missingFromFullManifest.length) console.error(`  - Missing from full manifest: ${report.missingFromFullManifest.join(", ")}`);
  }
  if (!report.ok) process.exit(1);
}
