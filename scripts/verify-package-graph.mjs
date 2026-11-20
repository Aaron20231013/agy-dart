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

function stripComments(source) {
  // Remove block comments and // line comments conservatively without breaking regex/URL literals
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/[^\r\n]*/g, "$1");
}

/**
 * Extract relative JS/MJS module specifiers and sibling script references from source text.
 */
export function extractLocalSpecifiers(source, fileAbsPath, rootDir = REPO_ROOT) {
  const cleaned = stripComments(source);
  const found = new Set();
  const dir = path.dirname(fileAbsPath);

  const addRel = (spec) => {
    if (!spec || typeof spec !== "string") return;
    if (!spec.startsWith("./") && !spec.startsWith("../")) return;
    const candidate = path.resolve(dir, spec);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      found.add(toPosixRel(rootDir, candidate));
    }
  };

  // 1. Static ESM import/export ... from "./..." and side-effect import "./..."
  const staticRe = /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["'](\.\.?\/[^"']+)["']/g;
  for (const m of cleaned.matchAll(staticRe)) {
    addRel(m[1]);
  }

  // 2. Dynamic import("./...") and require("./...")
  const dynRe = /\b(?:import|require)\s*\(\s*["'](\.\.?\/[^"']+)["']\s*\)/g;
  for (const m of cleaned.matchAll(dynRe)) {
    addRel(m[1]);
  }

  // 3. Direct sibling/child helper script spawns via path.resolve/join(__dirname, ...)
  const pathRefRe = /path\.(?:resolve|join)\(\s*__dirname\s*,\s*([^)]+)\)/g;
  for (const m of cleaned.matchAll(pathRefRe)) {
    const parts = Array.from(m[1].matchAll(/["']([^"']+)["']/g)).map((p) => p[1]);
    if (parts.length === 0) continue;
    const last = parts[parts.length - 1];
    if (!/\.(?:m?js|cjs|html|json|svg|md)$/i.test(last)) continue;
    const candidate = path.resolve(dir, ...parts);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      found.add(toPosixRel(rootDir, candidate));
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
