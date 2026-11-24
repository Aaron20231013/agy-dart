import path from "node:path";
import fs from "node:fs";
import { insertConfig, serverCommands, skillSpecs } from "./shared.mjs";

export const detect = home => fs.existsSync(path.join(home, ".codex"));

export function specs(home, src, runtime) {
  const start = "# >>> agy-dart >>>";
  const end = "# <<< agy-dart <<<";
  function block(executable = process.execPath) {
    const lines = [start];
    for (const [name, entry] of Object.entries(serverCommands(runtime, executable))) {
      lines.push("[mcp_servers.agy_dart_" + name + "]", "command = " + JSON.stringify(entry.command), "args = " + JSON.stringify(entry.args));
    }
    return [...lines, end, ""].join("\n");
  }
  function checkUnmanaged(text) {
    if (text.includes(start) || text.includes(end) || /^\s*\[\s*mcp_servers\s*\.\s*["']?agy_dart_(fast|context)\b/m.test(text))
      throw Error("Conflicting agy-dart TOML block");
  }
  function ownedRange(raw, executable) {
    const offset = raw.indexOf(start);
    if (offset < 0) return null;
    const last = raw.indexOf(end, offset);
    if (last < 0 || (offset && raw[offset - 1] !== "\n")) throw Error("Conflicting agy-dart TOML block");
    let after = last + end.length;
    if (raw.startsWith("\r\n", after)) after += 2;
    else if (raw[after] === "\n") after++;
    else if (after !== raw.length) throw Error("Conflicting agy-dart TOML block");
    if (raw.slice(offset, after).replaceAll("\r\n", "\n").trimEnd() !== block(executable).trimEnd())
      throw Error("Conflicting agy-dart TOML block");
    return { offset, after };
  }
  function remove(raw, undo = {}) {
    const range = ownedRange(raw, undo.executable);
    if (!range) {
      checkUnmanaged(raw);
      return raw;
    }
    const tail = raw.slice(range.after);
    let prefix = raw.slice(0, range.offset);
    if (undo.addedNewline && !tail) prefix = prefix.replace(/\r?\n$/, "");
    const rest = prefix + tail;
    checkUnmanaged(rest);
    return rest;
  }
  return [{
    file: path.join(home, ".codex/config.toml"),
    install(original) {
      const raw = original ?? "";
      checkUnmanaged(raw);
      const addedNewline = raw.length > 0 && !raw.endsWith("\n");
      const newline = raw.includes("\r\n") ? "\r\n" : "\n";
      return insertConfig(raw, raw.length, (addedNewline ? newline : "") + block().replaceAll("\n", newline), { addedNewline, executable: process.execPath });
    },
    verify(raw) {
      if (!ownedRange(raw)) return false;
      remove(raw);
      return true;
    },
    legacyUndo(original, installed) {
      const command = /(?:^|\n)# >>> agy-dart >>>\r?\n\[mcp_servers\.agy_dart_fast\]\r?\ncommand = ([^\r\n]+)/.exec(installed);
      return { addedNewline: Boolean(original && !original.endsWith("\n")), executable: command && JSON.parse(command[1]) || process.execPath };
    },
    remove
  }, ...skillSpecs(home, ".codex", src)];
}
