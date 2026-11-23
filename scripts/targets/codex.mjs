import path from "node:path";
import fs from "node:fs";
import {serverCommands,skillSpec} from "./shared.mjs";
export const detect = home => fs.existsSync(path.join(home,".codex"));
export function specs(home,src,runtime) {
  const start="# >>> agy-dart >>>", end="# <<< agy-dart <<<";
  const body = [start,...Object.entries(serverCommands(runtime)).flatMap(([name,entry])=>[
    "[mcp_servers.agy_dart_"+name+"]", "command = "+JSON.stringify(entry.command),"args = "+JSON.stringify(entry.args)]),end].join("\n")+"\n";
  function strip(raw, owned) {
    const text=raw ?? "";
    if (!text.includes(start) && !text.includes(end)) return text;
    if (!owned || text.split(body).length!==2 || text.replace(body,"").includes(start) || text.replace(body,"").includes(end)) throw Error("Conflicting agy-dart TOML block");
    return text.replace(body,"");
  }
  return [{file:path.join(home,".codex/config.toml"), install(raw,owned) {
    const rest=strip(raw,owned);
    if (/^\s*\[\s*mcp_servers\s*\.\s*["']?agy_dart_(fast|context)\b/m.test(rest)) throw Error("Unmanaged Codex MCP table");
    return rest+(rest && !rest.endsWith("\n")?"\n":"")+body;
  },remove:raw=>strip(raw,true)},skillSpec(home,".codex",src)];
}
