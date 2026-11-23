import path from "node:path";
import fs from "node:fs";
import { isDeepStrictEqual as equal } from "node:util";
import { insertConfig, serverCommands, skillSpec } from "./shared.mjs";

export const detect = home => [".claude", ".claude.json"].some(file => fs.existsSync(path.join(home, file)));
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

function parseObject(text) {
  const config = JSON.parse(text);
  if (!object(config)) throw Error("Expected a JSON configuration object");
  return config;
}

// JSON.parse validates the document. These spans allow edits without reserializing
// unrelated values, including numeric literals outside JavaScript's integer precision.
function children(raw, start) {
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:"]+/g;
  tokens.lastIndex = start + 1;
  const result = [];
  let previousComma = null;
  for (let token = tokens.exec(raw); token && !["]", "}"].includes(token[0]); token = tokens.exec(raw)) {
    const first = token.index;
    let key;
    if (raw[start] === "{") {
      key = JSON.parse(token[0]);
      tokens.exec(raw); // colon
      token = tokens.exec(raw);
    }
    const valueStart = token.index;
    let depth = Number(token[0] === "{" || token[0] === "[");
    while (depth) {
      const word = tokens.exec(raw)[0];
      if (word === "{" || word === "[") depth++;
      if (word === "}" || word === "]") depth--;
    }
    const end = tokens.lastIndex;
    const delimiter = tokens.exec(raw);
    const nextComma = delimiter[0] === "," ? delimiter.index : null;
    result.push({ key, first, valueStart, end, previousComma, nextComma });
    if (nextComma === null) break;
    previousComma = nextComma;
  }
  return result;
}

function member(raw, offset, key) {
  const matches = children(raw, offset).filter(entry => entry.key === key);
  if (matches.length > 1) throw Error("Duplicate Claude configuration key: " + key);
  return matches[0];
}

function drop(raw, entry) {
  if (entry.nextComma !== null) return raw.slice(0, entry.first) + raw.slice(entry.nextComma + 1);
  return raw.slice(0, entry.previousComma ?? entry.first) + raw.slice(entry.end);
}

function jsonSpec(file, keys, entries) {
  const array = keys.at(-1) === "PreToolUse";
  function containerInfo(config) {
    let value = config;
    for (let i = 0; i < keys.length; i++) {
      value = value[keys[i]];
      if (value == null) return { depth: i, wasNull: value === null };
      if (!(i === keys.length - 1 && array ? Array.isArray(value) : object(value)))
        throw Error("Invalid Claude configuration: " + keys.slice(0, i + 1).join("."));
    }
    return { depth: keys.length, value };
  }
  function matches(container, managed) {
    if (array) return managed.every(item => container.filter(value => equal(value, item)).length === 1);
    return Object.entries(managed).every(([key, value]) => equal(container[key], value));
  }
  return {
    file,
    install(original) {
      const raw = original ?? "{}\n";
      const { depth, wasNull, value } = containerInfo(parseObject(raw));
      let offset = raw.search(/\S/);
      for (let i = 0; i < depth; i++) offset = member(raw, offset, keys[i]).valueStart;
      const managed = entries(process.execPath);
      const undo = { depth, wasNull, executable: process.execPath };
      if (depth === keys.length) {
        const conflict = array ? managed.some(item => value.some(v => equal(v, item))) : Object.keys(managed).some(key => Object.hasOwn(value, key));
        if (conflict) throw Error("Unmanaged agy-dart entry: " + file);
        const inside = JSON.stringify(managed).slice(1, -1);
        return insertConfig(raw, offset + 1, inside + (Object.keys(value).length ? "," : ""), undo);
      }
      let addition = managed;
      for (let i = keys.length - 1; i > depth; i--) addition = { [keys[i]]: addition };
      if (wasNull) return insertConfig(raw, member(raw, offset, keys[depth]).valueStart, JSON.stringify(addition), undo, "null");
      const empty = raw.slice(offset + 1).trimStart().startsWith("}");
      return insertConfig(raw, offset + 1, JSON.stringify(keys[depth]) + ":" + JSON.stringify(addition) + (empty ? "" : ","), undo);
    },
    verify(raw) {
      const { value } = containerInfo(parseObject(raw));
      return value !== undefined && matches(value, entries(process.execPath));
    },
    legacyUndo(original, installed) {
      const { depth, wasNull } = containerInfo(parseObject(original ?? "{}"));
      const { value } = containerInfo(parseObject(installed));
      const legacyEntries = array ? [value.at(-1)] : Object.fromEntries(Object.keys(entries(process.execPath)).map(key => [key, value[key]]));
      return { depth, wasNull, legacyEntries };
    },
    remove(raw, undo) {
      if (containerInfo(parseObject(raw)).value === undefined) return raw;
      const parents = [];
      let offset = raw.search(/\S/);
      for (const key of keys) {
        parents.push(offset);
        offset = member(raw, offset, key).valueStart;
      }
      const managed = undo.legacyEntries ?? entries(undo.executable);
      if (array) {
        for (const item of managed) {
          const match = children(raw, offset).find(entry => equal(JSON.parse(raw.slice(entry.valueStart, entry.end)), item));
          if (match) raw = drop(raw, match);
        }
      } else {
        for (const [key, expected] of Object.entries(managed)) {
          const entry = member(raw, offset, key);
          if (!entry) continue;
          if (!equal(JSON.parse(raw.slice(entry.valueStart, entry.end)), expected)) throw Error("Conflicting MCP: " + key);
          raw = drop(raw, entry);
        }
      }
      for (let i = keys.length - 1; i >= undo.depth; i--) {
        const entry = member(raw, parents[i], keys[i]);
        if (children(raw, entry.valueStart).length) break;
        if (i === undo.depth && undo.wasNull) raw = raw.slice(0, entry.valueStart) + "null" + raw.slice(entry.end);
        else raw = drop(raw, entry);
      }
      return raw;
    }
  };
}

export function specs(home, src, runtime) {
  const quote = value => process.platform === "win32" ? '"' + value.replaceAll("\\", "/") + '"' : "'" + value.replaceAll("'", "'\\''") + "'";
  return [
    jsonSpec(path.join(home, ".claude.json"), ["mcpServers"], executable =>
      Object.fromEntries(Object.entries(serverCommands(runtime, executable)).map(([key, value]) => ["agy-dart_" + key, value]))),
    jsonSpec(path.join(home, ".claude/settings.json"), ["hooks", "PreToolUse"], executable =>
      [{ matcher: "Read|Bash", hooks: [{ type: "command", command: quote(executable) + " " + quote(path.join(runtime, "hooks/pre-tool-use.mjs")) }] }]),
    skillSpec(home, ".claude", src)
  ];
}
