#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {runTargets} from "../scripts/targets/index.mjs";
const src=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [cmd,...args]=process.argv.slice(2);
async function outline() {
  const {extractSymbolsFromLines,renderOutlineWithinBudget}=await import("../context/lib/code-outline.js");
  const {collectSourceFiles}=await import("../context/lib/repo-skeleton.js");
  if(!args[0] || args[0].startsWith("--")) throw Error("outline <path> [--depth N] [--map] [--json]");
  const root=path.resolve(args[0]), depthAt=args.indexOf("--depth");
  const depth=depthAt<0?8:Number(args[depthAt+1]);
  if(!Number.isInteger(depth)||depth<0) throw Error("Invalid depth");
  const files=fs.statSync(root).isDirectory()?collectSourceFiles(root,120,depth):[root];
  const rows=files.map(file=>{
    const text=fs.readFileSync(file,"utf8"),lines=text.split(/\r?\n/),bytes=Buffer.byteLength(text);
    const row={path:path.relative(process.cwd(),file),lines:lines.length,estimatedTokens:Math.ceil(bytes/4)};
    if(!args.includes("--map")){
      row.outline=renderOutlineWithinBudget(row.path,lines.length,extractSymbolsFromLines(file,lines),null,files.length, {bracketLines:true});
      row.savedPercent=bytes?Math.round(100*(1-Buffer.byteLength(row.outline)/bytes)):0;
    }
    return row;
  });
  console.log(args.includes("--json")?JSON.stringify(rows,null,2):rows.map(r=>r.outline?r.outline+"\nSavings: "+r.savedPercent+"%":r.path+"  "+r.lines+" lines  ~"+r.estimatedTokens+" tokens").join("\n"));
}
async function quotaCmd() {
  const { suppressSqliteExperimentalWarning } = await import("../hooks/compile-cache.mjs");
  suppressSqliteExperimentalWarning();
  const {
    buildStatusLineSetupInfo,
    collectLocalRollingUsage,
    formatResetDuration,
    projectQuotaSnapshot,
    readStatusLineQuotaSnapshot
  } = await import("../context/lib/quota.js");
  if (args.includes("--setup-snippet")) {
    console.log(buildStatusLineSetupInfo(src).snippetJson);
    return;
  }
  const { ContextModeStore } = await import("../context/lib/store.js");
  const store = new ContextModeStore({ hookMode: true });
  let snap = null;
  try {
    store.open();
    snap = readStatusLineQuotaSnapshot(store);
  } catch {
    snap = null;
  } finally {
    try {
      store.close();
    } catch {}
  }
  const official = projectQuotaSnapshot(snap);
  const envRootsRaw = typeof process.env.AGY_DART_QUOTA_BRAIN_ROOTS === "string" ? process.env.AGY_DART_QUOTA_BRAIN_ROOTS.trim() : "";
  const localOpts = envRootsRaw
    ? { roots: envRootsRaw.split(path.delimiter).filter(Boolean), includeDefaultRoots: false }
    : {};
  const local = collectLocalRollingUsage(localOpts);
  const setup = buildStatusLineSetupInfo(src);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true, official, local, setup }, null, 2));
    return;
  }
  const lines = [];
  if (official.available) {
    lines.push(`Official Quota (CLI statusLine · ${official.freshness}, updated ${official.capturedAt}):`);
    for (const b of official.buckets) {
      const resetPart = b.remainingResetSec !== null ? ` · resets in ${formatResetDuration(b.remainingResetSec)}` : "";
      lines.push(`  - ${b.label} (${b.id}): ${b.remainingPercent.toFixed(1)}%${resetPart}`);
    }
  } else {
    lines.push("Official Quota: no CLI statusLine snapshot yet (App/IDE: Settings > Models; CLI: /usage or configure statusLine).");
  }
  const fmtTok = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  lines.push(
    `Local Spend (5h): ${fmtTok(local.window5h.totalTokens)} total (${fmtTok(local.window5h.nonCachedTokens)} non-cached, ${local.window5h.turns} turns, ${local.window5h.sessions} sessions, est ~$${local.window5h.estimatedUsd.toFixed(2)})`
  );
  lines.push(
    `Local Spend (7d): ${fmtTok(local.window7d.totalTokens)} total (${fmtTok(local.window7d.nonCachedTokens)} non-cached, ${local.window7d.turns} turns, ${local.window7d.sessions} sessions, est ~$${local.window7d.estimatedUsd.toFixed(2)})`
  );
  if (local.rateLimitHits7d > 0) {
    lines.push(`Rate-limit events detected locally: ${local.rateLimitHits5h} (5h) / ${local.rateLimitHits7d} (7d)`);
  }
  console.log(lines.join("\n"));
}
try {
  if(cmd==="outline") await outline();
  else if(cmd==="quota") await quotaCmd();
  else if(cmd==="statusline") {
    const r=spawnSync(process.execPath,[path.join(src,"hooks/statusline.mjs"),...args],{stdio:"inherit",windowsHide:true});
    if(r.error) throw r.error;
    process.exitCode=r.status??1;
  }
  else if(["install","uninstall","doctor","status","mode","tool-loading"].includes(cmd)) await runTargets(src,[cmd,...args]);
  else if(["compare","session","cache","audit"].includes(cmd)) {
    let script="fast/benchmark.mjs", pass=[cmd,...args];
    if(cmd==="audit" && args[0]!=="session"){
      if(args[0]==="skills"){
        script="scripts/cache-audit.mjs";
        pass=["--skills-only",...args.slice(1)];
      } else {
        script=args[0]==="prefix"?"scripts/prefix-budget.mjs":"scripts/cache-audit.mjs";
        pass=["prefix","cache"].includes(args[0])?args.slice(1):args;
      }
    } else if(cmd==="audit") pass=args;
    const r=spawnSync(process.execPath,[path.join(src,script),...pass],{stdio:"inherit",windowsHide:true});
    if(r.error) throw r.error;
    process.exitCode=r.status??1;
  } else if(!cmd || cmd==="--help" || cmd==="-h") console.log("agy-dart install|uninstall|doctor|status|mode|tool-loading|outline|compare|session|cache|audit|quota|statusline");
  else throw Error("Unknown command: "+cmd);
} catch(error) {console.error(error.message);process.exitCode=1;}
