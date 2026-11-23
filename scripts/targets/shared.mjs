import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

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
export function serverCommands(runtime, executable = process.execPath) {
  return Object.fromEntries([["fast","fast/mcp-server.mjs"],["context","context/server.js"]].map(([name, file]) =>
    [name, { command: executable, args: [path.join(runtime, file)] }]));
}

export function insertConfig(text, offset, addition, details = {}, replaced = "") {
  return {
    text: text.slice(0, offset) + addition + text.slice(offset + replaced.length),
    undo: { offset, length: addition.length, ...details, ...(replaced && { replaced }) }
  };
}

const digest = text => text === null ? null : createHash("sha256").update(text).digest("hex");

function beforeInstall(spec, current, previous) {
  if (!previous) return current;
  if (Object.hasOwn(previous, "installed")) {
    // Pre-v2 installers saved complete configurations. Consume the old snapshot only in memory.
    if (current === previous.original || current === previous.installed) return previous.original;
    if (current === null) return null;
    const migrated = spec.install(previous.original);
    if (migrated.text === current) return previous.original;
    let undo = spec.legacyUndo?.(previous.original, previous.installed);
    // An interrupted migration may have already switched the live block to this executable.
    try { if (spec.verify(current)) undo = migrated.undo; } catch {}
    return spec.remove(current, undo);
  }
  const currentHash = digest(current);
  if (currentHash === previous.before || current === null) return current;
  if (currentHash === previous.after) {
    if (previous.before === null) return null;
    const { offset, length, replaced = "" } = previous.undo;
    const restored = current.slice(0, offset) + replaced + current.slice(offset + length);
    if (digest(restored) !== previous.before) throw Error("Invalid install record: " + spec.file);
    return restored;
  }
  return spec.remove(current, previous.undo);
}

export function manageFiles(home, host, specs, action) {
  const stateFile = path.join(home, ".agy-dart", host + "-install.json");
  const oldState = JSON.parse(read(stateFile) ?? "{}");
  const records = oldState.version === 2 ? oldState.files : oldState;
  const files = {};
  const pending = {};
  const changes = [];
  for (const spec of specs) {
    const file = spec.file;
    const current = read(file);
    let previous = records[file];
    const currentHash = digest(current);
    if (previous?.transition?.from === currentHash) previous = previous.transition.record;
    if (action === "uninstall" && !previous) continue;
    const original = beforeInstall(spec, current, previous);
    let next = original;
    const legacy = previous && Object.hasOwn(previous, "installed");
    if (action === "install") {
      const edit = spec.install(original);
      next = edit.text;
      files[file] = { before: digest(original), after: digest(next), undo: edit.undo };
      if (previous && !legacy && currentHash !== files[file].before && currentHash !== files[file].after) {
        const {before, after, undo} = previous;
        pending[file] = { ...files[file], transition: { from: currentHash, record: {before, after, undo} } };
      }
    }
    if (next !== current) changes.push({ file, next, current, legacy });
  }
  function apply({file, next, current}) {
    if (read(file) !== current) throw Error("Configuration changed during installation: " + file);
    if (next === null) {
      fs.unlinkSync(file);
      if (file.endsWith(path.join("skills","agy-dart","SKILL.md")) && !fs.readdirSync(path.dirname(file)).length)
        fs.rmdirSync(path.dirname(file));
    } else writeFileAtomicSync(file, next);
  }
  if (action === "install") {
    // Keep legacy originals on disk until their live files contain the original formatting.
    for (const change of changes) if (change.legacy) apply(change);
    writeFileAtomicSync(stateFile, JSON.stringify({ version: 2, files: { ...files, ...pending } }));
    for (const change of changes) if (!change.legacy) apply(change);
    if (Object.keys(pending).length) writeFileAtomicSync(stateFile, JSON.stringify({ version: 2, files }));
  } else {
    for (const change of changes) apply(change);
    if (read(stateFile) !== null) fs.unlinkSync(stateFile);
  }
}
export function skillSpec(home, dir, src) {
  const body = fs.readFileSync(path.join(src,"skills/agy-dart/SKILL.md"),"utf8");
  return { file:path.join(home,dir,"skills/agy-dart/SKILL.md"),
    install(current) {
      if (current !== null) throw Error("Skill already exists: " + dir);
      return insertConfig("", 0, body);
    }, verify(current) { return current === body; },
    remove() { throw Error("Locally modified skill: " + dir); } };
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
