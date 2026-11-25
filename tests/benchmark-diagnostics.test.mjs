import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTranscriptSessions } from "../fast/benchmark.mjs";

const turn = (...tool_calls) => ({ type: "PLANNER_RESPONSE", tool_calls });
const read = (Path, args = {}) => ({ name: "read_file", args: { Path, ...args } });
const result = (content, extra = {}) => ({ type: "TOOL_RESULT", content, ...extra });
const shell = CommandLine => ({ name: "run_command", args: { CommandLine } });
const lines = (first, contents, total = 6) => result(
  "Showing lines " + first + "-" + (first + contents.length - 1) + " of " + total + "\n" +
  contents.map((line, i) => (i + first) + ": " + line).join("\n")
);
const analyze = (...steps) => analyzeTranscriptSessions([steps]);

test("partial overlaps count only verified UTF-8 body bytes, resetting on change and compaction", () => {
  const checkpoint = { type: "SYSTEM_MESSAGE", content: "CHECKPOINT: # Resuming from a compaction" };
  const m = analyze(turn(read("a")), lines(1, ["hello", "好"]), turn(read("a")), lines(2, ["好", "b"]),
    turn(read("a")), lines(2, ["好"]), turn(read("a")), lines(2, ["changed", "b"]),
    checkpoint, turn(read("a")), lines(3, ["b"]), turn({ name: "edit_file", args: { Path: "a" } }),
    turn(read("a")), lines(3, ["b"]));
  assert.equal(m.measuredReadCalls, 6);
  assert.equal(m.repeatedReadBytes, 6);
  assert.equal(m.observedReadBytes, 25);
});

test("parallel results use IDs, never their order; incomplete payloads have unknown coverage", () => {
  const a = { ...read("a"), id: "x" }, b = { ...read("b"), id: "y" };
  const m = analyze(turn(a, b), { ...lines(1, ["B"]), tool_call_id: "y" }, { ...lines(1, ["A"]), tool_call_id: "x" },
    turn(read("a")), lines(1, ["A"]), turn(read("a"), read("b")), lines(1, ["A"]), lines(1, ["B"]),
    turn(read("a")), result("Showing lines 1-3 of 6\n1: A"), turn(read("a")), result("Showing lines 1-1 of 6\n1: <truncated 55 bytes>"),
    turn({ name: "read_file" }));
  assert.equal(m.unknownReadCalls, 5);
  assert.equal(m.measuredReadCalls, 3);
  assert.equal(m.repeatedReadBytes, 1);
  const ranged = analyze(turn(read("a", { StartLine: 1 }), read("b", { StartLine: 5 })),
    lines(5, ["B"]), lines(1, ["A"]), turn(read("b")), lines(5, ["B"]));
  assert.equal(ranged.measuredReadCalls, 3);
  assert.equal(ranged.repeatedReadBytes, 1);
});

test("a denial followed by a verified targeted read is counted separately", () => {
  const m = analyze(turn(read("a")), result("Created At: now\nEncountered error in step execution: tool call denied by pre-tool hook: reason"),
    turn(read("a", { StartLine: 2 })), lines(2, ["yes"]));
  assert.equal(m.deniedReadCalls, 1);
  assert.equal(m.targetedAfterDenial, 1);
  assert.equal(m.measuredReadCalls, 1);
});

test("logical tool identity and user-named distinct reads use separate counters", () => {
  const mcp = (server, tool) => ({ name: "call_mcp_tool", args: { ServerName: server, ToolName: tool } });
  const m = analyze({ type: "USER_INPUT", content: "Read a.js and b.js" }, turn(read("a.js")), lines(1, ["A"]),
    turn(read("b.js")), lines(1, ["B"]), turn(read("c.js")), lines(1, ["C"]),
    turn(mcp("fast", "batch_search")), turn(mcp("fast", "apply_edits")), turn(mcp("else", "apply_edits")));
  assert.equal(m.consecutiveSingleChainsExtraTurns, 4);
  assert.equal(m.sameLogicalToolTurns, 2);
  assert.equal(m.parallelReadCandidates, 1);
});

test("static PowerShell pipelines distinguish searches, writes and unknown commands", () => {
  const commands = ["gEt-ChIlDiTeM | Select-Object -First 3", "Get-Content a | Select-String x",
    "Get-Content a | Set-Content b", "Get-Content a > out", "Get-Content a | ForEach-Object { $_ }",
    "Get-Content a | custom-cmd", "Get-Content 'unterminated", "Get-Content 'a>b'"];
  const m = analyze(...commands.map(cmd => turn(shell(cmd))));
  assert.equal(m.readonlySearchRunCommandCalls, 3);
  assert.equal(m.knownWriteShellCalls, 2);
  assert.equal(m.unknownShellCalls, 3);
});
