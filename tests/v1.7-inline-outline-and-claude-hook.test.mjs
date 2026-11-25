import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
const hook=fileURLToPath(new URL("../hooks/pre-tool-use.mjs",import.meta.url));
test("v1.7 inline read scopes, UTF-8 budget and Claude permission flow", t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"agy-outline-"));
  t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));
  const file=path.join(dir,"中文.ts");
  fs.writeFileSync(file,Array.from({length:1500},(_,i)=>"export function parse"+i+"(text: string) { return text; }").join("\n"));
  const env={...process.env, HOME:dir,USERPROFILE:dir,AGY_DART_CONFIG_PATH:path.join(dir,"cfg.json"),AGY_DART_DB_PATH:path.join(dir,"db")};
  function call(payload) {
    const child=spawnSync(process.execPath,[hook],{env,input:JSON.stringify({cwd:dir,...payload}),encoding:"utf8"});
    assert.equal(child.status,0,child.stderr);assert.equal(child.stderr,"");
    return JSON.parse(child.stdout);
  }
  const read=id=>call({common:{conversationId:id},toolCall:{name:"read_file",args:{Path:file}}});
  for(const id of ["a","b"]){const verdict=read(id);assert.equal(verdict.decision,"deny");assert.match(verdict.reason,/\[L\d+/);assert.ok(Buffer.byteLength(verdict.reason)<=4500);}
  assert.equal(read("a").decision,"allow");
  const patch=path.join(dir,"large.patch");
  fs.writeFileSync(patch,"diff --git a/x b/x\n@@ -1 +1 @@\n"+"+line text example here\n".repeat(6200));
  const native=(id,Path)=>call({common:{conversationId:id},toolCall:{name:"read_file",args:{Path}}});
  assert.match(native("patch",patch).reason,/\[L\d+/);
  assert.equal(native("patch",patch).decision,"allow");
  env.AGY_DART_INLINE_OUTLINE_MAX_BYTES="0";
  assert.doesNotMatch(native("disabled",file).reason,/\[L\d+/);
  delete env.AGY_DART_INLINE_OUTLINE_MAX_BYTES;
  const claude=(tool_name,tool_input)=>call({hook_event_name:"PreToolUse",session_id:"ccc",tool_name,tool_input});
  assert.equal(claude("Read",{file_path:file}).hookSpecificOutput.permissionDecision,"deny");
  assert.deepEqual(claude("Read",{file_path:file,offset:10,limit:50}),{});
  const bash=claude("Bash",{command:"git log",description:"history"}).hookSpecificOutput;
  assert.equal(bash.permissionDecision,undefined);
  assert.equal(bash.updatedInput.description,"history");
  assert.notEqual(bash.updatedInput.command,"git log");
});
