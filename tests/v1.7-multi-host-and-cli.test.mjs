import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {runTargets} from "../scripts/targets/index.mjs";
import {manageFiles, skillSpec} from "../scripts/targets/shared.mjs";
const src=path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("host installation records omit unrelated config and respect later user edits", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-host-record-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = relative => path.join(home, relative);
  const read = relative => fs.readFileSync(file(relative), "utf8");
  const put = (relative, value) => fs.writeFileSync(file(relative), value);
  const run = (action, hosts = "claude,codex") => runTargets(src, [action, "--target", hosts], home);
  fs.mkdirSync(file(".claude"));
  fs.mkdirSync(file(".codex"));
  const secret = "fixture-private-value";
  const original = '{ "ignored":{"mcpServers":"a } ]"}, "mcpServers" : { "my-service":{"env":{"KEY":"' + secret + '"}} }, "counter":99999999999999999999 }\r\n';
  put(".claude.json", original);
  put(".claude/settings.json", '{ "hooks" : null, "label": "' + secret + '" }\n');
  put(".codex/config.toml", '# ' + secret);

  await run("install");
  function checkReceipts() {
    for (const host of ["claude", "codex"]) {
      const receipt = read(".agy-dart/" + host + "-install.json");
      assert.equal(JSON.parse(receipt).version, 2);
      assert.ok(!receipt.includes(secret));
      assert.ok(!receipt.includes("my-service"));
      assert.ok(!receipt.includes("profiles.audit"));
    }
  }
  checkReceipts();
  const profile = '[profiles.audit]\r\nmodel = "test"\r\n';
  put(".codex/config.toml", read(".codex/config.toml").replace(/\r?\n/g, "\r\n") + profile);
  put(".claude.json", read(".claude.json").replace(secret, secret + "-changed"));
  put(".claude/settings.json", read(".claude/settings.json").replace(secret, secret + "-changed"));
  await run("doctor");
  await run("install");
  checkReceipts();
  const working = read(".codex/config.toml");
  put(".codex/config.toml", working.replace("[mcp_servers.agy_dart_context]", "[mcp_servers.other_context]"));
  await assert.rejects(run("doctor", "codex"), /Conflicting|Invalid installation/);
  put(".codex/config.toml", working);
  await run("uninstall");
  assert.equal(read(".claude.json"), original.replace(secret, secret + "-changed"));
  assert.equal(read(".claude/settings.json"), '{ "hooks" : null, "label": "' + secret + '-changed" }\n');
  assert.equal(read(".codex/config.toml"), '# ' + secret + '\r\n' + profile);
});

test("reinstall migrates legacy whole-config snapshots and restores their original formatting", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-host-migration-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".claude"));
  const file = path.join(home, ".claude.json");
  const settings = path.join(home, ".claude/settings.json");
  const skill = path.join(home, ".claude/skills/agy-dart/SKILL.md");
  const receipt = path.join(home, ".agy-dart/claude-install.json");
  const original = '{  "projects" : { "sample":"legacy-secret-fixture" }, "mcpServers":{} }\r\n';
  fs.writeFileSync(file, original);
  const run = action => runTargets(src, [action, "--target", "claude"], home);
  await run("install");
  const installed = JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8")), null, 2) + "\n";
  fs.writeFileSync(file, installed);
  fs.writeFileSync(receipt, JSON.stringify({
    [file]: { original, installed },
    [settings]: { original: null, installed: fs.readFileSync(settings, "utf8") },
    [skill]: { original: null, installed: fs.readFileSync(skill, "utf8") }
  }));
  const rename = fs.renameSync;
  const stop = t.mock.method(fs, "renameSync", (from, to) => {
    if (to === receipt) throw Error("interrupted migration");
    return rename(from, to);
  });
  await assert.rejects(run("install"), /interrupted migration/);
  stop.mock.restore();
  await run("install");
  assert.ok(!fs.readFileSync(receipt, "utf8").includes("legacy-secret-fixture"));
  await run("uninstall");
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.ok(!fs.existsSync(settings));
});

test("interrupted skill upgrade can be retried using the compact receipt", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-host-retry-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const source = path.join(home, "source");
  const skill = path.join(source, "skills", "agy-dart", "SKILL.md");
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  const installedSkill = path.join(home, ".codex/skills/agy-dart/SKILL.md");
  const run = action => manageFiles(home, "codex", [skillSpec(home, ".codex", source)], action);
  fs.writeFileSync(skill, "old release");
  run("install");
  fs.writeFileSync(skill, "new release");
  const rename = fs.renameSync;
  const stop = t.mock.method(fs, "renameSync", (from, to) => {
    if (to === installedSkill) throw Error("interrupted upgrade");
    return rename(from, to);
  });
  assert.throws(() => run("install"), /interrupted upgrade/);
  stop.mock.restore();
  run("install");
  assert.equal(fs.readFileSync(installedSkill, "utf8"), "new release");
  run("uninstall");
  assert.ok(!fs.existsSync(installedSkill));
});
test("v1.7 host installs preserve config bytes and shared runtime in either uninstall order",async t=>{
 for(const order of [["claude","codex"],["codex","claude"]]){
   const home=fs.mkdtempSync(path.join(os.tmpdir(),"agy-hosts-"));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
   fs.mkdirSync(path.join(home,".claude"));fs.mkdirSync(path.join(home,".codex"));
   const fixtures={".claude.json":'{ "mcpServers":{"user":{"command":"a"}} }\n',".claude/settings.json":'{ "hooks":{"PreToolUse":[]} }\n',".codex/config.toml":"# user\r\n"};
   for(const [f,data] of Object.entries(fixtures))fs.writeFileSync(path.join(home,f),data);
   const run=(cmd,target)=>runTargets(src,[cmd,"--target",target],home);
   await run("install","claude,codex");await run("install","codex,claude");
   await run("doctor","claude,codex");await run("uninstall",order[0]);await run("doctor",order[1]);
   await run("uninstall",order[1]);assert.ok(!fs.existsSync(path.join(home,".agy-dart/runtime")));
   for(const [f,data] of Object.entries(fixtures))assert.equal(fs.readFileSync(path.join(home,f),"utf8"),data);
 }
});
test("v1.7 packed CLI and host entrypoints survive deletion of the npx source",async t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"agy-pack-"));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const home=path.join(tmp,"home");fs.mkdirSync(home);
 const env={...process.env,HOME:home,USERPROFILE:home,GEMINI_HOME:path.join(home,".gemini"),AGY_DART_CONFIG_PATH:path.join(home,"config.json"),AGY_DART_DB_PATH:path.join(home,"ctx.db"),npm_config_cache:path.join(tmp,"cache")};
 const npm=process.env.npm_execpath;
 const run=(args,cwd=src)=>{const r=spawnSync(process.execPath,args,{cwd,env,encoding:"utf8",windowsHide:true});assert.equal(r.status,0,r.stderr);return r.stdout;};
 assert.ok(npm,"Run via npm test to supply npm CLI");
 const [pack]=JSON.parse(run([npm,"pack","--json","--pack-destination",tmp]));
 assert.ok(!pack.files.some(f=>/^(tests|docs)\//.test(f.path)));
 const tar=path.join(tmp,pack.filename);
 for(const name of ["_npx","consumer"]){
   const project=path.join(tmp,name);fs.mkdirSync(project);
   run([npm,"install","--offline","--no-audit","--no-fund","--ignore-scripts","--no-save",tar],project);
 }
 const bin=name=>path.join(tmp,name,"node_modules/agy-dart/bin/agy-dart.mjs");
 run([bin("_npx"),"install","--target","claude,codex"],tmp);
 fs.rmSync(path.join(tmp,"_npx"),{recursive:true});
 run([bin("consumer"),"doctor","--target","claude,codex"],tmp);
 assert.ok(JSON.parse(run([bin("consumer"),"outline",path.join(src,"scripts/install.mjs"),"--json"]))[0].outline);
});
