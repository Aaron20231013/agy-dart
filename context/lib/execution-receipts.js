// Antigravity can JSON-quote individual wrapper arguments in a transcript.
export function isContextExecution(call) {
  if (call?.name === "mcp_agy-dart_context_ctx_execute") return true;
  if (call?.name !== "call_mcp_tool") return false;
  const args = call.args || {};
  const server = args.ServerName ?? args.serverName;
  const tool = args.ToolName ?? args.toolName;
  return (server === "agy-dart_context" || server === '"agy-dart_context"') &&
    (tool === "ctx_execute" || tool === '"ctx_execute"');
}

// Put the receipt first in the result so even the host's truncated transcript retains it.
// Match the outer result only. A receipt quoted inside stdout is unrelated.
export function executionReceiptFromText(text) {
  if (typeof text !== "string") return null;
  return /^(?:(?:Created At|Completed At):[^\r\n]*\r?\n)*\s*\{\s*"executionReceipt"\s*:\s*"([0-9a-f]{32})"\s*,/.exec(text)?.[1] ?? null;
}

export function executionReceiptsFromSteps(steps) {
  const expected = new Set();
  const receipts = [];
  for (const step of steps) {
    const index = step.step_index ?? step.stepIndex;
    if (!Number.isSafeInteger(index)) continue;
    if (step.type === "PLANNER_RESPONSE") {
      expected.clear();
      if (Array.isArray(step.tool_calls)) {
        step.tool_calls.forEach((call, offset) => {
          if (isContextExecution(call)) expected.add(index + offset + 1);
        });
      }
    } else if (step.type === "GENERIC" && expected.delete(index)) {
      const receipt = executionReceiptFromText(step.content);
      if (receipt) receipts.push(receipt);
    }
  }
  return receipts;
}
