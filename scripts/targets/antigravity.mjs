import path from "node:path";
import {spawnSync} from "node:child_process";
export function run(src,args) {
  const r=spawnSync(process.execPath,[path.join(src,"scripts/install.mjs"),...args],{stdio:"inherit",windowsHide:true});
  if(r.error) throw r.error;
  if(r.status!==0) throw Error("Antigravity command failed: "+args[0]);
}
