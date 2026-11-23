import path from "node:path";
import fs from "node:fs";
import { isDeepStrictEqual as equal } from "node:util";
import { jsonConfig, serverCommands, skillSpec } from "./shared.mjs";
export const detect = home => [".claude",".claude.json"].some(f=>fs.existsSync(path.join(home,f)));
export function specs(home,src,runtime) {
  const servers = serverCommands(runtime);
  const quote = s => process.platform === "win32" ? '"'+s.replaceAll("\\","/")+'"' : "'"+s.replaceAll("'","'\\''")+"'";
  const command = quote(process.execPath)+" "+quote(path.join(runtime,"hooks/pre-tool-use.mjs"));
  const hook = { matcher:"Read|Bash", hooks:[{type:"command", command}] };
  function updateServers(raw, adding, owned) {
    return jsonConfig(raw, config => {
      config.mcpServers ??= {};
      for (const [name, entry] of Object.entries(servers)) {
        const key = "agy-dart_"+name;
        if (Object.hasOwn(config.mcpServers,key) && (!owned || !equal(config.mcpServers[key],entry))) throw Error("Conflicting MCP: "+key);
        if (adding) config.mcpServers[key]=entry;
        else delete config.mcpServers[key];
      }
    });
  }
  function updateHooks(raw, adding, owned) {
    return jsonConfig(raw, config => {
      config.hooks ??= {};
      const list = config.hooks.PreToolUse ?? [];
      if (!owned && list.some(item=>equal(item,hook))) throw Error("Unmanaged agy-dart hook");
      config.hooks.PreToolUse = list.filter(item=>!equal(item,hook));
      if (adding) config.hooks.PreToolUse.push(hook);
    });
  }
  return [{file:path.join(home,".claude.json"),install:(r,o)=>updateServers(r,true,o),remove:r=>updateServers(r,false,true)},
    {file:path.join(home,".claude/settings.json"),install:(r,o)=>updateHooks(r,true,o),remove:r=>updateHooks(r,false,true)},skillSpec(home,".claude",src)];
}
