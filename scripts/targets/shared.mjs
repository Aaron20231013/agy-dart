import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function isEphemeralNpxSource(dir) {
  return /(?:^|[/\\])(?:_npx|npm-cache|node_modules|bunx|pnpm[/\\]dlx)(?:[/\\]|$)/i.test(dir);
}
export function guardPath(file) {
  const parent = path.dirname(file);
  if (parent !== file) guardPath(parent);
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error("Refusing linked path: " + file);
}
export function read(file) {
  guardPath(file);
  try { return fs.readFileSync(file, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; return null; }
}
export function writeFileAtomicSync(file, data) {
  guardPath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + randomUUID();
  try {
    fs.writeFileSync(tmp, data, { flag: "wx", mode: fs.statSync(file, {throwIfNoEntry:false})?.mode ?? 0o600 });
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}
export function syncSharedRuntime(srcRoot, homeDir, manifest) {
  const dir = path.join(homeDir, ".agy-dart", "runtime");
  const marker = path.join(dir, ".installed-files.json");
  if (fs.existsSync(dir) && read(marker) === null && fs.readdirSync(dir).length) throw Error("Unmanaged runtime: " + dir);
  const prior = JSON.parse(read(marker) ?? "[]");
  const files = manifest.map(rel => [rel, fs.readFileSync(path.join(srcRoot, rel))]);
  writeFileAtomicSync(marker, JSON.stringify([...new Set([...prior, ...manifest])]));
  for (const [rel, bytes] of files) writeFileAtomicSync(path.join(dir, rel), bytes);
  return dir;
}
export function serverCommands(runtime) {
  return Object.fromEntries([["fast","fast/mcp-server.mjs"],["context","context/server.js"]].map(([name, file]) =>
    [name, { command: process.execPath, args: [path.join(runtime, file)] }]));
}
export function jsonConfig(original, edit) {
  const data = JSON.parse(original ?? "{}");
  if (!data || Array.isArray(data) || typeof data !== "object") throw Error("Expected a JSON configuration object");
  edit(data);
  return JSON.stringify(data, null, 2) + "\n";
}
export function manageFiles(home, host, specs, action) {
  const stateFile = path.join(home, ".agy-dart", host + "-install.json");
  const state = JSON.parse(read(stateFile) ?? "{}");
  const changes = [];
  for (const { file, install, remove } of specs) {
    const current = read(file), previous = state[file];
    if (action === "uninstall" && !previous) continue;
    const original = previous ? previous.original : current;
    let next;
    if (action === "install") {
      if (previous && current === previous.installed) next = install(original);
      else next = install(current, Boolean(previous));
      state[file] = { original, installed: next };
      // Restore the original bytes only when all unrelated content is still identical.
      if (previous && current !== previous.installed && current !== original) state[file].original = remove(current);
    } else next = current === previous.installed ? original : current === null ? null : remove(current);
    changes.push({ file, next, current });
  }
  if (action === "install") writeFileAtomicSync(stateFile, JSON.stringify(state));
  for (const {file,next,current} of changes) {
    if (next === current) continue;
    if (next === null) {
      fs.unlinkSync(file);
      if (file.endsWith(path.join("skills","agy-dart","SKILL.md")) && !fs.readdirSync(path.dirname(file)).length)
        fs.rmdirSync(path.dirname(file));
    }
    else writeFileAtomicSync(file, next);
  }
  if (action === "uninstall" && read(stateFile) !== null) fs.unlinkSync(stateFile);
}
export function skillSpec(home, dir, src) {
  const body = fs.readFileSync(path.join(src,"skills/agy-dart/SKILL.md"),"utf8");
  return { file:path.join(home,dir,"skills/agy-dart/SKILL.md"),
    install(current, owned) {
      if (current !== null && !owned) throw Error("Skill already exists: " + dir);
      if (owned && current !== body) throw Error("Local skill has edits: " + dir);
      return body;
    }, remove(current) { if (current !== body) throw Error("Locally modified skill: " + dir); return null; } };
}
export function cleanupRuntime(home) {
  const base = path.join(home,".agy-dart");
  if (["claude","codex"].some(host => read(path.join(base,host+"-install.json")) !== null)) return;
  const dir = path.join(base,"runtime"), marker = path.join(dir,".installed-files.json");
  const list = read(marker);
  if (!list) return;
  const parents = new Set();
  for (const rel of JSON.parse(list)) {
    const file = path.resolve(dir,rel);
    if (!file.startsWith(dir+path.sep)) throw Error("Invalid runtime entry");
    guardPath(file);
    fs.rmSync(file,{force:true});
    for(let p=path.dirname(file); p!==dir; p=path.dirname(p)) parents.add(p);
  }
  fs.unlinkSync(marker);
  for(const p of [...parents].sort((a,b)=>b.length-a.length).concat(dir)) {
    if(fs.existsSync(p) && !fs.readdirSync(p).length) fs.rmdirSync(p);
  }
}
