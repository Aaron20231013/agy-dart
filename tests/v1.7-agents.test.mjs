import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {RUNTIME_FILES} from "../scripts/install.mjs";
test("v1.7 shipped agents limit fast tools by role",()=>{
 for(const name of ["dart-coder","dart-reviewer"]){
   const rel="agents/"+name+".md";assert.ok(RUNTIME_FILES.includes(rel));
   const source=fs.readFileSync(new URL("../"+rel,import.meta.url),"utf8");
   assert.match(source,/description: .+/);assert.match(source,/inheritMcp: false/);
   assert.match(source,/inheritCustomizations: false/);
   const [, nativeTools, mcpConfig] = source.match(/\ntools:\n([\s\S]+?)\nmcpServers:\n([\s\S]+?)\n---/);
   assert.doesNotMatch(nativeTools, /mcp_/);
   const [, whitelist] = mcpConfig.match(/enabledTools: \[([^\]]+)\]/);
   assert.deepEqual(whitelist.split(", "), name === "dart-coder"
     ? ["batch_search", "read_slices", "apply_edits", "run_checks"]
     : ["batch_search", "read_slices", "run_checks"]);
   assert.match(mcpConfig, /\$\{PLUGIN_ROOT\}\/fast\/mcp-server\.mjs/);
 }
});
