import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {runTargets} from "../scripts/targets/index.mjs";
const src=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
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
