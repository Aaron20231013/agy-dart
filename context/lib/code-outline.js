import path from "node:path";
import { redactSecrets } from "./security.js";
export const OUTLINE_SCHEMA_VERSION = 3;
function isRegexStartContext(line, slashIdx) {
  let j = slashIdx - 1;
  while (j >= 0 && /\s/.test(line[j])) j--;
  if (j < 0) return true;
  const prev = line[j];
  if ("=(,:![&|?{};~+-*%^<>".includes(prev)) return true;
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_$]/.test(line[k])) k--;
  const word = line.slice(k + 1, j + 1);
  return word === "return" || word === "case" || word === "throw" || word === "in" || word === "of" || word === "typeof" || word === "void" || word === "delete" || word === "new";
}
function scanBracesOnLine(line, state, lang, ignoreBracesInParensBeforeOpen = false, alreadySeenOpen = false) {
  let open = 0;
  let close = 0;
  let openParen = 0;
  let closeParen = 0;
  let parenDepth = state.parenDepth ?? 0;
  let seenOpen = alreadySeenOpen;
  let inSingle = false;
  let inDouble = false;
  let inRegex = false;
  let inRegexClass = false;
  let escape = false;
  let lastCodeChar = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (state.inBlockComment) {
      if (ch === "*" && next === "/") {
        state.inBlockComment = false;
        i++;
      }
      continue;
    }
    if (escape) {
      escape = false;
      continue;
    }
    if (inRegex) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === "[") {
        inRegexClass = true;
      } else if (ch === "]") {
        inRegexClass = false;
      } else if (ch === "/" && !inRegexClass) {
        inRegex = false;
        lastCodeChar = "/";
      }
      continue;
    }
    if (state.inBacktick) {
      if (lang === "js" && ch === "\\") {
        escape = true;
      } else if (ch === "`") {
        state.inBacktick = false;
        lastCodeChar = "`";
      } else if (lang === "js" && ch === "$" && next === "{") {
        state.inBacktick = false;
        state.templateExprStack.push(0);
        i++;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "\\") escape = true;
      else if (ch === "'") {
        inSingle = false;
        lastCodeChar = "'";
      }
      continue;
    }
    if (inDouble) {
      if (ch === "\\") escape = true;
      else if (ch === '"') {
        inDouble = false;
        lastCodeChar = '"';
      }
      continue;
    }
    if (lang === "shell" && ch === "#") break;
    if ((lang === "js" || lang === "c") && ch === "/" && next === "/") break;
    if ((lang === "js" || lang === "c") && ch === "/" && next === "*") {
      state.inBlockComment = true;
      i++;
      continue;
    }
    if (lang === "js" && ch === "/" && next !== "/" && next !== "*" && isRegexStartContext(line, i)) {
      inRegex = true;
      inRegexClass = false;
      continue;
    }
    if (ch === "'" && lang !== "json") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "`" && (lang === "js" || lang === "c")) {
      state.inBacktick = true;
      continue;
    }
    if (ch === "{") {
      if (state.templateExprStack.length > 0) {
        state.templateExprStack[state.templateExprStack.length - 1] += 1;
      } else if (!(ignoreBracesInParensBeforeOpen && !seenOpen && parenDepth > 0)) {
        open++;
        seenOpen = true;
      }
      lastCodeChar = "{";
    } else if (ch === "}") {
      if (state.templateExprStack.length > 0) {
        const top = state.templateExprStack[state.templateExprStack.length - 1];
        if (top === 0) {
          state.templateExprStack.pop();
          state.inBacktick = true;
        } else {
          state.templateExprStack[state.templateExprStack.length - 1] = top - 1;
        }
      } else if (!(ignoreBracesInParensBeforeOpen && !seenOpen && parenDepth > 0)) {
        close++;
      }
      lastCodeChar = "}";
    } else if (ch === "(") {
      openParen++;
      parenDepth++;
      lastCodeChar = "(";
    } else if (ch === ")") {
      closeParen++;
      parenDepth = Math.max(0, parenDepth - 1);
      lastCodeChar = ")";
    } else if (!/\s/.test(ch)) {
      lastCodeChar = ch;
    }
  }
  state.parenDepth = parenDepth;
  return {
    open,
    close,
    openParen,
    closeParen,
    endsWithSemi: lastCodeChar === ";",
    lastCodeChar
  };
}
function findBraceBlockEnd(lines, startIdx, lang = "c") {
  let depth = 0;
  let seenOpen = false;
  const state = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false,
    parenDepth: 0
  };
  const maxScan = Math.min(lines.length, startIdx + 2e3);
  for (let i = startIdx; i < maxScan; i++) {
    const { open, close, endsWithSemi, lastCodeChar } = scanBracesOnLine(
      lines[i],
      state,
      lang,
      lang === "js",
      seenOpen
    );
    if (open > 0) seenOpen = true;
    depth += open - close;
    if (seenOpen && depth <= 0) {
      if (lang === "js" && i <= startIdx + 16) {
        if (lastCodeChar === "}" && /\)\s*:\s*\{/.test(lines.slice(startIdx, i + 1).join(" "))) {
          const next = lines.slice(i + 1, maxScan).find(line => line.trim());
          if (/^\s*(?:=>\s*)?\{/.test(next || "")) {
            seenOpen = false;
            continue;
          }
        }
        const headerHasGeneric = lines.slice(startIdx, i + 1).some((l) => l.includes("<"));
        let isGenericContinuation = lastCodeChar === ">" || (state.parenDepth ?? 0) > 0;
        if (!isGenericContinuation && headerHasGeneric) {
          if (lastCodeChar === ",") {
            isGenericContinuation = true;
          } else {
            let nextIdx = i + 1;
            while (nextIdx < maxScan && !lines[nextIdx].trim()) nextIdx++;
            if (nextIdx < maxScan && lines[nextIdx].trim().startsWith(">")) {
              isGenericContinuation = true;
            }
          }
        }
        if (isGenericContinuation) {
          seenOpen = false;
          depth = 0;
          continue;
        }
      }
      return i + 1;
    }
    if (!seenOpen && (state.parenDepth ?? 0) <= 0 && endsWithSemi) {
      return i + 1;
    }
    if (!seenOpen && i > startIdx + 40) {
      return startIdx + 1;
    }
  }
  return seenOpen ? Math.min(lines.length, maxScan) : startIdx + 1;
}
function findTypeAliasEnd(lines, startIdx) {
  const firstLine = lines[startIdx] ?? "";
  const eqIdx = firstLine.indexOf("=");
  const rhs = eqIdx >= 0 ? firstLine.slice(eqIdx + 1) : firstLine;
  const state = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false,
    parenDepth: 0
  };
  const firstScan = scanBracesOnLine(rhs, state, "js");
  if (firstScan.open > firstScan.close) {
    return findBraceBlockEnd(lines, startIdx, "js");
  }
  if (firstScan.endsWithSemi && firstScan.openParen <= firstScan.closeParen) {
    return startIdx + 1;
  }
  let endIdx = startIdx;
  let parenBal = firstScan.openParen - firstScan.closeParen;
  let prevLast = firstScan.lastCodeChar;
  const maxScan = Math.min(lines.length - 1, startIdx + 40);
  while (endIdx < maxScan) {
    const nextLine = lines[endIdx + 1] ?? "";
    const nextTrim = nextLine.trim();
    if (!nextTrim) break;
    const isContinuation = parenBal > 0 || prevLast === "=" || prevLast === "|" || prevLast === "&" || prevLast === "?" || prevLast === ":" || /^[ \t]+(?:[|&?:]|\w+\s*\?*:)/.test(nextLine);
    if (!isContinuation) break;
    endIdx++;
    const scan = scanBracesOnLine(nextLine, state, "js");
    if (scan.open > scan.close) {
      return findBraceBlockEnd(lines, endIdx, "js");
    }
    parenBal += scan.openParen - scan.closeParen;
    prevLast = scan.lastCodeChar;
    if (scan.endsWithSemi && parenBal <= 0) break;
  }
  return endIdx + 1;
}
function findParenCallEnd(lines, startIdx) {
  const state = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false,
    parenDepth: 0
  };
  let seenParen = false;
  const maxScan = Math.min(lines.length, startIdx + 400);
  for (let i = startIdx; i < maxScan; i++) {
    const { openParen } = scanBracesOnLine(lines[i], state, "js");
    if (openParen > 0) seenParen = true;
    if (seenParen && (state.parenDepth ?? 0) <= 0) {
      return i + 1;
    }
  }
  return startIdx + 1;
}
function hasArrowOrBraceWithin(lines, startIdx, maxLookahead = 12) {
  const state = { inBlockComment: false, templateExprStack: [], inBacktick: false };
  let parenDepth = 0;
  let seenParen = false;
  let hasArrow = false;
  const end = Math.min(lines.length, startIdx + maxLookahead);
  for (let i = startIdx; i < end; i++) {
    const line = lines[i];
    const { open, openParen, closeParen, endsWithSemi } = scanBracesOnLine(line, state, "js");
    if (openParen > 0) seenParen = true;
    parenDepth += openParen - closeParen;
    if (line.includes("=>")) hasArrow = true;
    if (open > 0 && (!seenParen || parenDepth <= 0)) {
      return { hasArrow, hasBrace: true };
    }
    if (seenParen && parenDepth <= 0 && endsWithSemi) {
      return { hasArrow, hasBrace: false };
    }
  }
  return { hasArrow, hasBrace: false };
}
function extractTsJsSymbols(lines) {
  const symbols = [];
  const first = lines.find(line => /^(?!\/\/|\/\*|\*|$)/.test(line.trim()) && line.trim());
  const wrapped = /^\s*(?:\(function|!function|\(\(\)\s*=>)/.test(first || "");
  const patterns = [
    {
      re: /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
      kind: "class",
      nameGroup: 1
    },
    {
      re: /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/,
      kind: "interface",
      nameGroup: 1
    },
    {
      re: /^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/,
      kind: "type",
      nameGroup: 1
    },
    {
      re: /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/,
      kind: "enum",
      nameGroup: 1
    },
    {
      re: /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
      kind: "function",
      nameGroup: 1
    },
    {
      re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
      kind: "function",
      nameGroup: 1
    }
  ];
  const multilineArrowStartRe = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?\(/;
  const methodHeaderRe = /^([ \t]{1,4})(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
  const controlKeywords = /* @__PURE__ */ new Set([
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "else",
    "try",
    "return",
    "new",
    "throw",
    "await",
    "super",
    "typeof",
    "delete"
  ]);
  const routeRegisterRe = /^[ \t]{1,6}(?:app|router|server|fastify)\.(get|post|put|patch|delete|all|route)\s*(?:<[^>]*>)?\s*\(\s*['"`]([^'"`]+)['"`]/;
  const testSuiteRe = /^(?:describe|suite)(?:\.(?:only|skip|concurrent|serial|sequential|todo))*(?:\.each\s*\([^\n]*?\))?\s*\(\s*['"`]([^'"`]+)['"`]/;
  const testCaseRe = /^[ \t]{0,4}(?:it|test)(?:\.(?:only|skip|concurrent|serial|sequential|todo))*(?:\.each\s*\([^\n]*?\))?\s*\(\s*['"`]([^'"`]+)['"`]/;
  let currentClassEnd = -1;
  let currentClassIndent = -1;
  let currentFnEnd = -1;
  let currentSuiteEnd = -1;
  const commentState = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false
  };
  for (let i = 0; i < lines.length; i++) {
    const line = wrapped ? lines[i].replace(/^ {1,4}/, "") : lines[i];
    const wasInComment = commentState.inBlockComment;
    const wasInBacktick = commentState.inBacktick;
    scanBracesOnLine(line, commentState, "js");
    if (wasInComment || wasInBacktick) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      continue;
    }
    let matchedTop = false;
    if (!line.startsWith(" ") && !line.startsWith("	")) {
      for (const p of patterns) {
        const m = p.re.exec(line);
        if (m && m[p.nameGroup]) {
          const endLine = p.kind === "type" ? findTypeAliasEnd(lines, i) : findBraceBlockEnd(lines, i, "js");
          symbols.push({
            kind: p.kind,
            name: m[p.nameGroup],
            startLine: i + 1,
            endLine,
            depth: 0
          });
          if (p.kind === "class") {
            currentClassEnd = endLine;
            currentClassIndent = -1;
          } else if (p.kind === "function" && endLine - (i + 1) >= 40) {
            currentFnEnd = endLine;
          }
          matchedTop = true;
          break;
        }
      }
      if (!matchedTop) {
        const ma = multilineArrowStartRe.exec(line);
        if (ma && ma[1]) {
          const { hasArrow } = hasArrowOrBraceWithin(lines, i, 12);
          if (hasArrow) {
            const endLine = findBraceBlockEnd(lines, i, "js");
            symbols.push({
              kind: "function",
              name: ma[1],
              startLine: i + 1,
              endLine,
              depth: 0
            });
            if (endLine - (i + 1) >= 40) {
              currentFnEnd = endLine;
            }
            matchedTop = true;
          }
        }
      }
      if (!matchedTop) {
        const ms = testSuiteRe.exec(line);
        if (ms && ms[1]) {
          const endLine = findParenCallEnd(lines, i);
          symbols.push({
            kind: "suite",
            name: ms[1].slice(0, 64),
            startLine: i + 1,
            endLine,
            depth: 0
          });
          currentSuiteEnd = endLine;
          matchedTop = true;
        }
      }
    }
    if (!matchedTop && i + 1 <= currentClassEnd) {
      const mm = methodHeaderRe.exec(line);
      if (mm && mm[1] && mm[2] && !controlKeywords.has(mm[2])) {
        const indentWidth = mm[1].replace(/\t/g, "  ").length;
        if (currentClassIndent === -1) {
          currentClassIndent = indentWidth;
        }
        if (indentWidth === currentClassIndent) {
          const { hasBrace } = hasArrowOrBraceWithin(lines, i, 10);
          if (hasBrace) {
            const endLine = findBraceBlockEnd(lines, i, "js");
            symbols.push({
              kind: "method",
              name: mm[2],
              startLine: i + 1,
              endLine,
              depth: 1
            });
          }
        }
      }
    } else if (!matchedTop && i + 1 <= currentFnEnd) {
      const mr = routeRegisterRe.exec(line);
      if (mr && mr[1] && mr[2]) {
        const endLine = findParenCallEnd(lines, i);
        symbols.push({
          kind: "route",
          name: `${mr[1].toUpperCase()} ${mr[2]}`,
          startLine: i + 1,
          endLine,
          depth: 1
        });
      }
    } else if (!matchedTop) {
      const mt = testCaseRe.exec(line);
      if (mt && mt[1]) {
        const endLine = findParenCallEnd(lines, i);
        symbols.push({
          kind: "test",
          name: mt[1].slice(0, 64),
          startLine: i + 1,
          endLine,
          depth: i + 1 <= currentSuiteEnd ? 1 : 0
        });
      }
    }
  }
  return symbols;
}
function extractPythonSymbols(lines) {
  const symbols = [];
  const re = /^([ \t]*)(async\s+def|def|class)\s+([A-Za-z_]\w*)/;
  const inTripleString = new Array(lines.length).fill(false);
  let activeQuote = null;
  for (let i = 0; i < lines.length; i++) {
    inTripleString[i] = activeQuote !== null;
    const line = lines[i];
    let j = 0;
    while (j < line.length) {
      if (activeQuote) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line.startsWith(activeQuote, j)) {
          activeQuote = null;
          j += 3;
          continue;
        }
        j++;
      } else {
        if (line[j] === "#") break;
        if (line.startsWith('"""', j)) {
          activeQuote = '"""';
          j += 3;
          continue;
        }
        if (line.startsWith("'''", j)) {
          activeQuote = "'''";
          j += 3;
          continue;
        }
        if (line[j] === '"' || line[j] === "'") {
          const q = line[j];
          j++;
          while (j < line.length && line[j] !== q) {
            if (line[j] === "\\") j += 2;
            else j++;
          }
          j++;
          continue;
        }
        j++;
      }
    }
  }
  const raw = [];
  for (let i = 0; i < lines.length; i++) {
    if (inTripleString[i]) continue;
    const m = re.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, "    ").length;
    const kind = m[2] === "class" ? "class" : indent > 0 ? "method" : "function";
    raw.push({ indent, kind, name: m[3], startIdx: i });
  }
  for (let idx = 0; idx < raw.length; idx++) {
    const item = raw[idx];
    let headerEndIdx = item.startIdx;
    let bracketBal = 0;
    let seenHeaderBracket = false;
    const maxHeaderScan = Math.min(lines.length - 1, item.startIdx + 40);
    for (let h = item.startIdx; h <= maxHeaderScan; h++) {
      if (h > item.startIdx && inTripleString[h]) {
        headerEndIdx = h;
        continue;
      }
      const hl = lines[h];
      let q = null;
      for (let k = 0; k < hl.length; k++) {
        const ch = hl[k];
        if (q) {
          if (ch === "\\") {
            k++;
            continue;
          }
          if (ch === q) q = null;
          continue;
        }
        if (ch === "#") break;
        if (ch === '"' || ch === "'") {
          if (hl.startsWith('"""', k) || hl.startsWith("'''", k)) break;
          q = ch;
          continue;
        }
        if (ch === "(" || ch === "[" || ch === "{") {
          bracketBal++;
          seenHeaderBracket = true;
        } else if (ch === ")" || ch === "]" || ch === "}") {
          bracketBal = Math.max(0, bracketBal - 1);
        }
      }
      headerEndIdx = h;
      if (!seenHeaderBracket || bracketBal === 0) break;
    }
    let endIdx = lines.length - 1;
    for (let j = headerEndIdx + 1; j < lines.length; j++) {
      if (inTripleString[j]) continue;
      const l = lines[j];
      const trimmed = l.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const curIndent = (/^[ \t]*/.exec(l)?.[0] ?? "").replace(/\t/g, "    ").length;
      if (curIndent <= item.indent) {
        endIdx = j - 1;
        break;
      }
    }
    while (endIdx > item.startIdx && !lines[endIdx].trim()) {
      endIdx--;
    }
    symbols.push({
      kind: item.kind,
      name: item.name,
      startLine: item.startIdx + 1,
      endLine: endIdx + 1,
      depth: item.indent > 0 ? 1 : 0
    });
  }
  return symbols;
}
function stripLeadingGdAnnotations(text) {
  let rest = text;
  while (rest.startsWith("@")) {
    const m = /^@[A-Za-z_]\w*/.exec(rest);
    if (!m) break;
    let idx = m[0].length;
    while (idx < rest.length && (rest[idx] === " " || rest[idx] === "	")) idx++;
    if (rest[idx] === "(") {
      let depth = 0;
      let quote = null;
      while (idx < rest.length) {
        const ch = rest[idx];
        if (quote) {
          if (ch === "\\") {
            idx += 2;
            continue;
          }
          if (ch === quote) quote = null;
        } else {
          if (ch === '"' || ch === "'") quote = ch;
          else if (ch === "(") depth++;
          else if (ch === ")") {
            depth--;
            if (depth === 0) {
              idx++;
              break;
            }
          }
        }
        idx++;
      }
    }
    while (idx < rest.length && (rest[idx] === " " || rest[idx] === "	")) idx++;
    rest = rest.slice(idx);
  }
  return rest;
}
function extractGdScriptSymbols(rawLines) {
  const lines = rawLines.map((l, idx) => {
    const clean = l.endsWith("\r") ? l.slice(0, -1) : l;
    return idx === 0 ? clean.replace(/^\uFEFF/, "") : clean;
  });
  const info = new Array(lines.length);
  let activeTriple = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const startsInTriple = activeTriple !== null;
    let openBrace = 0;
    let closeBrace = 0;
    let openParen = 0;
    let closeParen = 0;
    let hasCode = startsInTriple;
    let j = 0;
    while (j < line.length) {
      if (activeTriple) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line.startsWith(activeTriple, j)) {
          activeTriple = null;
          j += 3;
          continue;
        }
        j++;
      } else {
        const ch = line[j];
        if (ch === "#") break;
        if (line.startsWith('"""', j) || line.startsWith("'''", j)) {
          activeTriple = line.startsWith('"""', j) ? '"""' : "'''";
          hasCode = true;
          j += 3;
          continue;
        }
        if (ch === '"' || ch === "'") {
          hasCode = true;
          j++;
          while (j < line.length && line[j] !== ch) {
            if (line[j] === "\\") j += 2;
            else j++;
          }
          if (j < line.length) j++;
          continue;
        }
        if (ch !== " " && ch !== "	") {
          hasCode = true;
          if (ch === "{") openBrace++;
          else if (ch === "}") closeBrace++;
          else if (ch === "(") openParen++;
          else if (ch === ")") closeParen++;
        }
        j++;
      }
    }
    info[i] = {
      startsInTriple,
      openBrace,
      closeBrace,
      openParen,
      closeParen,
      hasCode
    };
  }
  const raw = [];
  const classNameRe = /^class_name\s+([A-Za-z_]\w*)\b/;
  const classRe = /^class\s+([A-Za-z_]\w*)\b/;
  const funcRe = /^(?:static\s+)?func\s+([A-Za-z_]\w*)\s*\(/;
  const signalRe = /^signal\s+([A-Za-z_]\w*)\b/;
  const enumRe = /^enum(?:\s+([A-Za-z_]\w*))?\s*(?:\{|$|#)/;
  for (let i = 0; i < lines.length; i++) {
    if (info[i].startsInTriple) continue;
    const line = lines[i];
    const indentStr = /^[ \t]*/.exec(line)?.[0] ?? "";
    const afterIndent = line.slice(indentStr.length);
    if (!afterIndent || afterIndent.startsWith("#")) continue;
    const rest = stripLeadingGdAnnotations(afterIndent);
    if (!rest || rest.startsWith("#")) continue;
    const indent = indentStr.replace(/\t/g, "    ").length;
    let m = classNameRe.exec(rest);
    if (m && m[1]) {
      raw.push({ indent, rawKind: "class_name", name: m[1], startIdx: i });
      continue;
    }
    m = classRe.exec(rest);
    if (m && m[1]) {
      raw.push({ indent, rawKind: "class", name: m[1], startIdx: i });
      continue;
    }
    m = funcRe.exec(rest);
    if (m && m[1]) {
      raw.push({ indent, rawKind: "func", name: m[1], startIdx: i });
      continue;
    }
    m = signalRe.exec(rest);
    if (m && m[1]) {
      raw.push({ indent, rawKind: "signal", name: m[1], startIdx: i });
      continue;
    }
    m = enumRe.exec(rest);
    if (m) {
      if (!m[1] && info[i].openBrace === 0) {
        let nextCodeIdx = i + 1;
        while (nextCodeIdx < lines.length && !info[nextCodeIdx].hasCode) {
          nextCodeIdx++;
        }
        if (nextCodeIdx >= lines.length || info[nextCodeIdx].openBrace === 0) {
          continue;
        }
      }
      raw.push({
        indent,
        rawKind: "enum",
        name: m[1] ?? "<anonymous>",
        startIdx: i
      });
    }
  }
  const symbols = [];
  const classStack = [];
  for (const item of raw) {
    let endIdx = item.startIdx;
    if (item.rawKind === "class_name") {
      endIdx = item.startIdx;
    } else if (item.rawKind === "signal") {
      let parenDepth = info[item.startIdx].openParen - info[item.startIdx].closeParen;
      const maxSigScan = Math.min(lines.length - 1, item.startIdx + 40);
      while (parenDepth > 0 && endIdx < maxSigScan) {
        endIdx++;
        parenDepth += info[endIdx].openParen - info[endIdx].closeParen;
      }
      if (parenDepth > 0) endIdx = item.startIdx;
    } else if (item.rawKind === "enum") {
      let braceDepth = 0;
      let seenOpen = false;
      const maxEnumScan = Math.min(lines.length - 1, item.startIdx + 500);
      for (let k = item.startIdx; k <= maxEnumScan; k++) {
        const li = info[k];
        if (li.openBrace > 0) seenOpen = true;
        braceDepth += li.openBrace - li.closeBrace;
        if (seenOpen && braceDepth <= 0) {
          endIdx = k;
          break;
        }
        if (!seenOpen && k > item.startIdx && li.hasCode && li.openBrace === 0) {
          break;
        }
      }
      if (seenOpen && braceDepth > 0) {
        endIdx = maxEnumScan;
      }
    } else {
      let headerEndIdx = item.startIdx;
      let parenDepth = info[item.startIdx].openParen - info[item.startIdx].closeParen;
      const maxHeaderScan = Math.min(lines.length - 1, item.startIdx + 40);
      while (parenDepth > 0 && headerEndIdx < maxHeaderScan) {
        headerEndIdx++;
        parenDepth += info[headerEndIdx].openParen - info[headerEndIdx].closeParen;
      }
      if (parenDepth > 0) headerEndIdx = item.startIdx;
      endIdx = lines.length - 1;
      for (let j = headerEndIdx + 1; j < lines.length; j++) {
        if (info[j].startsInTriple) continue;
        const l = lines[j];
        const trimmed = l.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const curIndent = (/^[ \t]*/.exec(l)?.[0] ?? "").replace(/\t/g, "    ").length;
        if (curIndent <= item.indent) {
          endIdx = j - 1;
          break;
        }
      }
      while (endIdx > headerEndIdx) {
        if (info[endIdx].startsInTriple) break;
        const endLineStr = lines[endIdx];
        const endTrimmed = endLineStr.trim();
        if (!endTrimmed) {
          endIdx--;
          continue;
        }
        if (endTrimmed.startsWith("#")) {
          const commentIndent = (/^[ \t]*/.exec(endLineStr)?.[0] ?? "").replace(
            /\t/g,
            "    "
          ).length;
          if (commentIndent <= item.indent) {
            endIdx--;
            continue;
          }
        }
        break;
      }
    }
    const startLine = item.startIdx + 1;
    const endLine = Math.max(startLine, endIdx + 1);
    while (classStack.length > 0 && (classStack[classStack.length - 1].endLine < startLine || classStack[classStack.length - 1].indent >= item.indent)) {
      classStack.pop();
    }
    const depth = classStack.length > 0 ? classStack.length : item.indent > 0 ? Math.max(1, Math.floor(item.indent / 4)) : 0;
    const kind = item.rawKind === "func" ? item.indent > 0 ? "method" : "function" : item.rawKind;
    symbols.push({
      kind,
      name: item.name,
      startLine,
      endLine,
      depth
    });
    if (item.rawKind === "class") {
      classStack.push({ indent: item.indent, endLine });
    }
  }
  return symbols;
}
function extractGoSymbols(lines) {
  const symbols = [];
  const funcRe = /^func\s+(?:\(([^)]+)\)\s+)?([A-Za-z_]\w*)/;
  const typeRe = /^type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = funcRe.exec(line);
    if (fm && fm[2]) {
      const recv = fm[1]?.trim();
      const name = recv ? `(${recv}) ${fm[2]}` : fm[2];
      symbols.push({
        kind: recv ? "method" : "function",
        name,
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "c"),
        depth: 0
      });
      continue;
    }
    const tm = typeRe.exec(line);
    if (tm && tm[1] && tm[2]) {
      symbols.push({
        kind: tm[2],
        name: tm[1],
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "c"),
        depth: 0
      });
    }
  }
  return symbols;
}
function extractRustSymbols(lines) {
  const symbols = [];
  const re = /^([ \t]*)(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|unsafe|const|extern(?:\s+"[^"]*")?)\s+)*(fn|struct|enum|trait|impl|mod)\s+([A-Za-z_][\w:<>,\s]*?)(?:\s*[\({;]|$)/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 2048) continue;
    const m = re.exec(line);
    if (!m || !m[2] || !m[3]) continue;
    const indent = m[1].length;
    if (indent > 4) continue;
    symbols.push({
      kind: m[2],
      name: m[3].trim(),
      startLine: i + 1,
      endLine: findBraceBlockEnd(lines, i, "c"),
      depth: indent > 0 ? 1 : 0
    });
  }
  return symbols;
}
function extractCLikeSymbols(lines) {
  const symbols = [];
  const typeRe = /^([ \t]{0,4})(?:(?:public|private|protected|internal|static|final|abstract|sealed|data|open|export|partial|base|mixin)\s+)*(class|interface|enum|struct|record|protocol|namespace|mixin|extension)\s+(?:type\s+)?([A-Za-z_]\w*)/;
  const kwFuncRe = /^([ \t]{0,4})(?:(?:public|private|protected|internal|static|final|override|virtual|inline|async|suspend|open|mutating)\s+)*(?:fun|func)\s+([A-Za-z_]\w*)/;
  const cMethodRe = /^([ \t]{0,4})(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|inline|constexpr|extern|async|synchronized|native|unsigned|signed|const|factory|late|covariant|external)\s+)*(?:[A-Za-z_~][\w:<>,?\[\]\s*&]*?\s+)([A-Za-z_~][\w.:]*)\s*(?:<[^{;()]{1,64}>)?\s*\([^;]*(?:=>.*)?$/;
  const excludedNames = /* @__PURE__ */ new Set([
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "else",
    "return",
    "sizeof",
    "alignof",
    "decltype",
    "new",
    "delete",
    "throw",
    "typedef",
    "using",
    "case"
  ]);
  const commentState = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const wasInComment = commentState.inBlockComment;
    scanBracesOnLine(line, commentState, "c");
    if (wasInComment) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("#")) {
      continue;
    }
    const tm = typeRe.exec(line);
    if (tm && tm[2] && tm[3]) {
      const indented = (tm[1]?.length ?? 0) > 0;
      symbols.push({
        kind: tm[2],
        name: tm[3],
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "c"),
        depth: indented ? 1 : 0
      });
      continue;
    }
    const fm = kwFuncRe.exec(line);
    if (fm && fm[2]) {
      const indented = (fm[1]?.length ?? 0) > 0;
      symbols.push({
        kind: indented ? "method" : "function",
        name: fm[2],
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "c"),
        depth: indented ? 1 : 0
      });
      continue;
    }
    const cm = cMethodRe.exec(line);
    if (cm && cm[2] && !excludedNames.has(cm[2]) && !(trimmed.includes("=") && !trimmed.includes("=>"))) {
      const { hasBrace, hasArrow } = hasArrowOrBraceWithin(lines, i, 8);
      if (hasBrace || hasArrow) {
        const indented = (cm[1]?.length ?? 0) > 0;
        symbols.push({
          kind: indented ? "method" : "function",
          name: cm[2],
          startLine: i + 1,
          endLine: hasBrace ? findBraceBlockEnd(lines, i, "c") : i + 1,
          depth: indented ? 1 : 0
        });
      }
    }
  }
  return symbols;
}
function extractShellSymbols(lines) {
  const symbols = [];
  const re = /^(?:function\s+([A-Za-z_][\w-]*)\s*(?:\(\))?|([A-Za-z_][\w-]*)\s*\(\))\s*\{/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const name = m[1] || m[2];
    if (!name) continue;
    symbols.push({
      kind: "function",
      name,
      startLine: i + 1,
      endLine: findBraceBlockEnd(lines, i, "shell"),
      depth: 0
    });
  }
  return symbols;
}
function extractMarkdownSymbols(lines) {
  const raw = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length <= 1024 && /^\s*(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line.length > 1024 || line.charCodeAt(0) !== 35) continue;
    let level = 0;
    while (level < line.length && level <= 4 && line.charCodeAt(level) === 35) {
      level += 1;
    }
    if (level < 1 || level > 4 || level >= line.length) continue;
    const sep = line.charCodeAt(level);
    if (sep !== 32 && sep !== 9) continue;
    let start = level + 1;
    while (start < line.length && (line.charCodeAt(start) === 32 || line.charCodeAt(start) === 9)) start += 1;
    let end = line.length;
    while (end > start && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end -= 1;
    let hEnd = end;
    while (hEnd > start && line.charCodeAt(hEnd - 1) === 35) hEnd -= 1;
    if (hEnd < end && (hEnd === start || line.charCodeAt(hEnd - 1) === 32 || line.charCodeAt(hEnd - 1) === 9)) {
      end = hEnd;
      while (end > start && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end -= 1;
    }
    if (end > start) {
      raw.push({ level, name: line.slice(start, end), startLine: i + 1 });
    }
  }
  return raw.map((item, idx) => {
    let endLine = lines.length;
    for (let j = idx + 1; j < raw.length; j++) {
      if (raw[j].level <= item.level) {
        endLine = raw[j].startLine - 1;
        break;
      }
    }
    return {
      kind: `h${item.level}`,
      name: item.name,
      startLine: item.startLine,
      endLine: Math.max(item.startLine, endLine),
      depth: item.level - 1
    };
  });
}
function extractJsonYamlSymbols(lines, isJson) {
  const symbols = [];
  if (isJson) {
    let keyIndent = null;
    for (let i = 0; i < lines.length; i++) {
      const m = /^([ \t]+)"([^"]+)"\s*:/.exec(lines[i]);
      if (m && m[1] && m[2]) {
        if (keyIndent === null) {
          keyIndent = m[1];
        }
        if (m[1] === keyIndent) {
          symbols.push({
            kind: "key",
            name: m[2],
            startLine: i + 1,
            endLine: i + 1,
            depth: 0
          });
        }
      }
    }
    for (let idx = 0; idx < symbols.length; idx++) {
      const cur = symbols[idx];
      const nextStart = idx + 1 < symbols.length ? symbols[idx + 1].startLine - 1 : lines.length - 1;
      let endLine = Math.max(cur.startLine, nextStart);
      while (endLine > cur.startLine && /^\s*[}\]]?,?\s*$/.test(lines[endLine - 1] ?? "") && idx === symbols.length - 1) {
        endLine--;
      }
      cur.endLine = endLine;
    }
    return symbols;
  }
  const re = /^([A-Za-z0-9_.-]+)\s*:/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m && m[1]) {
      symbols.push({
        kind: "key",
        name: m[1],
        startLine: i + 1,
        endLine: i + 1,
        depth: 0
      });
    }
  }
  for (let idx = 0; idx < symbols.length; idx++) {
    const cur = symbols[idx];
    let endLine = idx + 1 < symbols.length ? symbols[idx + 1].startLine - 1 : lines.length;
    while (endLine > cur.startLine && !(lines[endLine - 1] ?? "").trim()) {
      endLine--;
    }
    cur.endLine = Math.max(cur.startLine, endLine);
  }
  return symbols;
}
function extractCssSymbols(lines, compactOnly = false) {
  const symbols = [];
  const state = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false
  };
  let braceDepth = 0;
  const atRuleRe = /^@(layer|media|keyframes|supports|container|font-face|theme)\b([^{;]*)/i;
  const tokenBlockRe = /^(:root\b|html(?:\[[^\]]+\]|\.[A-Za-z_-][\w-]*)?(?=\s|[,{])|\[data-theme[^\]]*\]|body\b)[^{;]*\{/;
  const extractCssSectionComment = (text) => {
    if (text.length < 6 || text.length > 200) return null;
    if (!text.startsWith("/*") || !text.endsWith("*/")) return null;
    const inner = text.slice(2, -2);
    if (inner.includes("/*") || inner.includes("*/")) return null;
    const cleaned = inner.replace(/^[\s=\-*#]+/, "").replace(/[\s=\-*#]+$/, "");
    if (cleaned.length < 2 || cleaned.length > 71) return null;
    if (/[*/]/.test(cleaned) || cleaned.startsWith("=")) return null;
    if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(cleaned)) return null;
    return cleaned.slice(0, 64);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const wasInComment = state.inBlockComment;
    if (!wasInComment && braceDepth === 0 && trimmed) {
      const sectionName = extractCssSectionComment(trimmed);
      if (sectionName) {
        symbols.push({
          kind: "section",
          name: sectionName,
          startLine: i + 1,
          endLine: i + 1,
          depth: 0
        });
      } else {
        const am = atRuleRe.exec(trimmed);
        if (am && am[1]) {
          const endLine = trimmed.includes("{") ? findBraceBlockEnd(lines, i, "c") : i + 1;
          const rest = (am[2] ?? "").trim().replace(/\s+/g, " ").slice(0, 56);
          symbols.push({
            kind: `@${am[1].toLowerCase()}`,
            name: rest || `@${am[1].toLowerCase()}`,
            startLine: i + 1,
            endLine,
            depth: 0
          });
        } else {
          const tm = tokenBlockRe.exec(trimmed);
          if (tm && tm[1]) {
            const endLine = findBraceBlockEnd(lines, i, "c");
            const header = trimmed.slice(0, trimmed.indexOf("{")).trim().replace(/\s+/g, " ").slice(0, 60);
            symbols.push({
              kind: "tokens",
              name: header || tm[1],
              startLine: i + 1,
              endLine,
              depth: 0
            });
          }
        }
      }
    }
    const { open, close } = scanBracesOnLine(line, state, "c");
    braceDepth = Math.max(0, braceDepth + open - close);
  }
  if (!compactOnly && symbols.length < 10) {
    const fallbackState = {
      inBlockComment: false,
      templateExprStack: [],
      inBacktick: false
    };
    let d = 0;
    let lastAddedLine = -999;
    const seen = new Set(symbols.map((s) => s.startLine));
    for (let i = 0; i < lines.length && symbols.length < 40; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const wasInComment = fallbackState.inBlockComment;
      if (!wasInComment && d === 0 && !seen.has(i + 1) && i - lastAddedLine >= 10 && /^[.#\[a-zA-Z*:]/.test(trimmed) && trimmed.includes("{") && !trimmed.startsWith("@")) {
        const sel = trimmed.slice(0, trimmed.indexOf("{")).trim().replace(/\s+/g, " ").slice(0, 60);
        if (sel) {
          const endLine = findBraceBlockEnd(lines, i, "c");
          symbols.push({
            kind: "rule",
            name: sel,
            startLine: i + 1,
            endLine,
            depth: 0
          });
          lastAddedLine = i;
        }
      }
      const { open, close } = scanBracesOnLine(line, fallbackState, "c");
      d = Math.max(0, d + open - close);
    }
    symbols.sort((a, b) => a.startLine - b.startLine);
  }
  return symbols;
}
var HTML_VOID_ELEMENTS = /* @__PURE__ */ new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]);
var HTML_RAW_SKIP_TAGS = /* @__PURE__ */ new Set([
  "textarea",
  "title",
  "xmp",
  "noembed",
  "noframes"
]);
var HTML_SEMANTIC_TAGS = /* @__PURE__ */ new Set([
  "head",
  "body",
  "header",
  "nav",
  "main",
  "aside",
  "section",
  "article",
  "footer",
  "form",
  "dialog",
  "template"
]);
var HTML_CONTAINER_TAGS = /* @__PURE__ */ new Set([
  "div",
  "ul",
  "ol",
  "table",
  "fieldset",
  "details"
]);
var COMPONENT_LANDMARK_RE = /^(?:[A-Z][A-Za-z0-9]*\.)?(?:[A-Z][A-Za-z0-9]*)?(?:Modal|Drawer|Dialog|Panel|Tabs?|View|Page|Form)$/;
var MAX_HTML_DEPTH = 2;
var MAX_TAG_HEADER_SCAN = 8192;
function leadingWhitespaceCols(line, tabWidth = 4) {
  let cols = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === " ") cols += 1;
    else if (ch === "	") cols += tabWidth;
    else break;
  }
  return cols;
}
function stripLeadingCols(line, colsToStrip, tabWidth = 4) {
  if (colsToStrip <= 0) return line;
  let cols = 0;
  let idx = 0;
  while (idx < line.length && cols < colsToStrip) {
    const ch = line[idx];
    if (ch === " ") {
      cols += 1;
      idx++;
    } else if (ch === "	") {
      cols += tabWidth;
      idx++;
    } else {
      break;
    }
  }
  if (cols > colsToStrip) {
    return " ".repeat(cols - colsToStrip) + line.slice(idx);
  }
  return line.slice(idx);
}
function dedentBlockLines(lines, skipFirstLineForIndent = false) {
  const startIdx = skipFirstLineForIndent ? 1 : 0;
  let firstNonEmptyIndent = -1;
  let minPosCols = Infinity;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cols = leadingWhitespaceCols(line);
    if (firstNonEmptyIndent === -1) firstNonEmptyIndent = cols;
    if (cols > 0 && cols < minPosCols) minPosCols = cols;
  }
  if (firstNonEmptyIndent <= 0 || !Number.isFinite(minPosCols) || minPosCols <= 0) {
    return lines;
  }
  return lines.map((line, idx) => {
    if (idx < startIdx || !line.trim()) return line;
    return stripLeadingCols(line, minPosCols);
  });
}
function findMatchingBrace2(text, start, maxLookahead = 2e3) {
  const limit = Math.min(text.length, start + maxLookahead);
  let depth = 0;
  let quote = null;
  let escape = false;
  for (let i = start; i < limit; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (quote) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function findClosingMustache(text, start, maxLookahead = 2e3) {
  const limit = Math.min(text.length, start + maxLookahead);
  let quote = null;
  let escape = false;
  for (let i = start + 2; i + 1 < limit; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (quote) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "}" && text[i + 1] === "}") {
      return i;
    }
  }
  return -1;
}
function parseHtmlAttrs(attrText) {
  const attrs = /* @__PURE__ */ new Map();
  let vueSlot;
  let i = 0;
  const len = attrText.length;
  while (i < len) {
    while (i < len && /[\s/]/.test(attrText[i])) i++;
    if (i >= len) break;
    const nameStart = i;
    while (i < len && !/[\s=/>"'`]/.test(attrText[i])) i++;
    const rawName = attrText.slice(nameStart, i);
    if (!rawName) {
      i++;
      continue;
    }
    const lowerName = rawName.toLowerCase();
    if (!vueSlot && rawName.startsWith("#") && rawName.length > 1) {
      vueSlot = rawName.slice(1);
    } else if (!vueSlot && lowerName.startsWith("v-slot:") && rawName.length > 7) {
      vueSlot = rawName.slice(7);
    }
    while (i < len && /\s/.test(attrText[i])) i++;
    let value = "";
    if (i < len && attrText[i] === "=") {
      i++;
      while (i < len && /\s/.test(attrText[i])) i++;
      if (i < len) {
        const ch = attrText[i];
        if (ch === '"' || ch === "'") {
          const quote = ch;
          i++;
          const valStart = i;
          while (i < len && attrText[i] !== quote) i++;
          value = attrText.slice(valStart, i);
          if (i < len) i++;
        } else if (ch === "{") {
          const endBrace = findMatchingBrace2(attrText, i);
          if (endBrace >= 0) {
            value = attrText.slice(i, endBrace + 1);
            i = endBrace + 1;
          } else {
            const valStart = i;
            while (i < len && !/[\s/>]/.test(attrText[i])) i++;
            value = attrText.slice(valStart, i);
          }
        } else {
          const valStart = i;
          while (i < len && !/[\s/>]/.test(attrText[i])) i++;
          value = attrText.slice(valStart, i);
        }
      }
    }
    if (!attrs.has(lowerName)) {
      attrs.set(lowerName, value);
    }
  }
  return { attrs, vueSlot };
}
function normalizeInlineAttr(value, maxChars) {
  if (!value) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.slice(0, maxChars).replace(/[\uD800-\uDBFF]$/, "");
}
function formatHtmlTagLabel(displayTag, lowerTag, rawAttrs, parsed) {
  if (lowerTag === "script" || lowerTag === "style") {
    const compact = normalizeInlineAttr(rawAttrs, 40);
    return compact ? `<${lowerTag} ${compact}>` : `<${lowerTag}>`;
  }
  const idVal = normalizeInlineAttr(parsed.attrs.get("id"), 36);
  if (idVal) {
    return `<${displayTag} #${idVal}>`;
  }
  const testIdVal = normalizeInlineAttr(parsed.attrs.get("data-testid"), 36);
  if (testIdVal) {
    return `<${displayTag} data-testid="${testIdVal}">`;
  }
  const roleVal = normalizeInlineAttr(parsed.attrs.get("role"), 36);
  if (roleVal) {
    return `<${displayTag} role="${roleVal}">`;
  }
  const slotVal = normalizeInlineAttr(parsed.vueSlot, 36);
  if (lowerTag === "template" && slotVal) {
    return `<template #${slotVal}>`;
  }
  return `<${displayTag}>`;
}
function isJsScriptType(typeAttr) {
  if (typeAttr === void 0) return true;
  const mime = typeAttr.trim().toLowerCase().split(";")[0]?.trim() ?? "";
  return !mime || mime === "module" || mime === "text/javascript" || mime === "application/javascript" || mime === "text/ecmascript" || mime === "application/ecmascript" || mime === "text/typescript" || mime === "ts" || mime === "tsx" || mime === "jsx";
}
function isCommentDecorChar(ch) {
  return ch === "=" || ch === "-" || ch === "*" || ch === "#" || ch === "~" || ch === ":" || ch === " " || ch === "	" || ch === "\r" || ch === "\n";
}
function extractCommentLandmark(inner) {
  let start = 0;
  let end = inner.length;
  while (start < end && isCommentDecorChar(inner[start])) start++;
  while (end > start && isCommentDecorChar(inner[end - 1])) end--;
  const cleaned = inner.slice(start, end);
  if (cleaned.length < 2 || cleaned.length > 60) return null;
  if (/[<>]/.test(cleaned)) return null;
  if (/^(?:eslint|prettier|istanbul|c8|v8|@ts-)/i.test(cleaned)) return null;
  if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(cleaned)) return null;
  return cleaned;
}
function extractTemplateSymbols(rawLines, mode = "html") {
  if (rawLines.length === 0) return [];
  const lines = rawLines[0].startsWith("\uFEFF") ? [rawLines[0].slice(1), ...rawLines.slice(1)] : rawLines;
  const text = lines.join("\n");
  const lineStarts = new Array(lines.length);
  let acc = 0;
  for (let idx = 0; idx < lines.length; idx++) {
    lineStarts[idx] = acc;
    acc += lines[idx].length + 1;
  }
  const offsetToLineIdx = (pos) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const symbols = [];
  const stack = [];
  const stackTagCounts = /* @__PURE__ */ new Map();
  const pushFrame = (frame) => {
    stack.push(frame);
    stackTagCounts.set(frame.lowerTag, (stackTagCounts.get(frame.lowerTag) ?? 0) + 1);
  };
  const popFrame = () => {
    const frame = stack.pop();
    const prev = stackTagCounts.get(frame.lowerTag) ?? 0;
    if (prev <= 1) stackTagCounts.delete(frame.lowerTag);
    else stackTagCounts.set(frame.lowerTag, prev - 1);
    return frame;
  };
  let emittedCount = 0;
  let noCloseSingle = false;
  let noCloseDouble = false;
  let noCloseScript = false;
  let noCloseStyle = false;
  let noCloseBodyBrace = false;
  let noCloseMustache = false;
  const noCloseRawSkip = /* @__PURE__ */ new Set();
  let nextRightBrace = text.indexOf("}");
  let nextCloseMustache = mode === "vue" ? text.indexOf("}}") : -1;
  let i = 0;
  const len = text.length;
  while (i < len) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    if (mode === "svelte" && !noCloseBodyBrace) {
      const bracePos = text.indexOf("{", i);
      if (bracePos >= 0 && bracePos < lt) {
        if (nextRightBrace !== -1 && nextRightBrace < bracePos) {
          nextRightBrace = text.indexOf("}", bracePos);
        }
        if (nextRightBrace === -1) {
          noCloseBodyBrace = true;
        } else if (nextRightBrace < bracePos + 2e3) {
          const endBrace = findMatchingBrace2(text, bracePos);
          if (endBrace >= 0) {
            i = endBrace + 1;
            continue;
          }
          i = bracePos + 1;
          continue;
        } else if (nextRightBrace < lt) {
          i = nextRightBrace + 1;
          continue;
        }
      }
    } else if (mode === "vue" && !noCloseMustache) {
      const mustachePos = text.indexOf("{{", i);
      if (mustachePos >= 0 && mustachePos < lt) {
        if (nextCloseMustache !== -1 && nextCloseMustache < mustachePos + 2) {
          nextCloseMustache = text.indexOf("}}", mustachePos + 2);
        }
        if (nextCloseMustache === -1) {
          noCloseMustache = true;
        } else if (nextCloseMustache < mustachePos + 2e3) {
          const endMustache = findClosingMustache(text, mustachePos);
          if (endMustache >= 0) {
            i = endMustache + 2;
            continue;
          }
          i = mustachePos + 2;
          continue;
        } else if (nextCloseMustache < lt) {
          i = nextCloseMustache + 2;
          continue;
        }
      }
    }
    i = lt;
    if (text.startsWith("<!--", i)) {
      if (text.startsWith("<!-->", i)) {
        i += 5;
        continue;
      }
      if (text.startsWith("<!--->", i)) {
        i += 6;
        continue;
      }
      const startLineIdx2 = offsetToLineIdx(i);
      const stdClose = text.indexOf("-->", i + 4);
      const bangClose = text.indexOf("--!>", i + 4);
      let closePos = -1;
      let closeLen = 3;
      if (stdClose >= 0 && (bangClose < 0 || stdClose <= bangClose)) {
        closePos = stdClose;
        closeLen = 3;
      } else if (bangClose >= 0) {
        closePos = bangClose;
        closeLen = 4;
      }
      if (closePos < 0) {
        break;
      }
      const endLineIdx = offsetToLineIdx(closePos + closeLen - 1);
      if (startLineIdx2 === endLineIdx && closeLen === 3) {
        const lineTrim = lines[startLineIdx2].trim();
        if (lineTrim.startsWith("<!--") && lineTrim.endsWith("-->") && lineTrim.indexOf("-->", 4) === lineTrim.length - 3) {
          const landmark = extractCommentLandmark(text.slice(i + 4, closePos));
          if (landmark) {
            const ln = startLineIdx2 + 1;
            symbols.push({
              kind: "section",
              name: landmark,
              startLine: ln,
              endLine: ln,
              depth: Math.min(MAX_HTML_DEPTH, emittedCount)
            });
          }
        }
      }
      i = closePos + closeLen;
      continue;
    }
    if (text.startsWith("<![CDATA[", i)) {
      const closePos = text.indexOf("]]>", i + 9);
      i = closePos < 0 ? len : closePos + 3;
      continue;
    }
    const nextCh = text[i + 1];
    if (nextCh === "?") {
      const closePi = text.indexOf("?>", i + 2);
      if (closePi >= 0) {
        i = closePi + 2;
      } else {
        const closeGt = text.indexOf(">", i + 2);
        i = closeGt >= 0 ? closeGt + 1 : len;
      }
      continue;
    }
    if (nextCh === "!") {
      let quote2 = null;
      let j2 = i + 2;
      while (j2 < len) {
        const c = text[j2];
        if (quote2) {
          if (c === quote2 || c === "\n") quote2 = null;
        } else if (c === '"' || c === "'") {
          quote2 = c;
        } else if (c === ">") {
          j2++;
          break;
        }
        j2++;
      }
      i = j2;
      continue;
    }
    if (nextCh === "/") {
      const nameStart = i + 2;
      if (nameStart >= len || !/[A-Za-z]/.test(text[nameStart])) {
        i += 2;
        continue;
      }
      let j2 = nameStart + 1;
      while (j2 < len && /[A-Za-z0-9:._-]/.test(text[j2])) j2++;
      const closeLowerTag = text.slice(nameStart, j2).toLowerCase();
      while (j2 < len && text[j2] !== ">") j2++;
      if (j2 < len && text[j2] === ">") j2++;
      const closeLine = offsetToLineIdx(Math.max(i, j2 - 1)) + 1;
      if ((stackTagCounts.get(closeLowerTag) ?? 0) > 0) {
        let matchIdx = -1;
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s].lowerTag === closeLowerTag) {
            matchIdx = s;
            break;
          }
        }
        if (matchIdx >= 0) {
          for (let s = stack.length - 1; s > matchIdx; s--) {
            const unclosed = popFrame();
            if (unclosed.emitted) {
              emittedCount = Math.max(0, emittedCount - 1);
              if (unclosed.symbol) {
                unclosed.symbol.endLine = Math.max(
                  unclosed.symbol.endLine,
                  closeLine > unclosed.startLine ? closeLine - 1 : unclosed.startLine
                );
              }
            }
          }
          const matched = popFrame();
          if (matched.emitted) {
            emittedCount = Math.max(0, emittedCount - 1);
            if (matched.symbol) {
              matched.symbol.endLine = Math.max(matched.symbol.endLine, closeLine);
            }
          }
        }
      }
      i = j2;
      continue;
    }
    if (!nextCh || !/[A-Za-z]/.test(nextCh)) {
      i++;
      continue;
    }
    const tagStart = i;
    let nameEnd = i + 1;
    while (nameEnd < len && /[A-Za-z0-9:._-]/.test(text[nameEnd])) nameEnd++;
    const afterNameCh = text[nameEnd];
    if (afterNameCh !== void 0 && !/[\s/>]/.test(afterNameCh)) {
      i = nameEnd;
      continue;
    }
    const rawTag = text.slice(i + 1, nameEnd);
    const lowerTag = rawTag.toLowerCase();
    const headerLimit = Math.min(len, nameEnd + MAX_TAG_HEADER_SCAN);
    let j = nameEnd;
    let quote = null;
    let braceDepth = 0;
    let braceQuote = null;
    let braceEscape = false;
    let lastUnquotedNonWs = "";
    let foundGt = false;
    while (j < headerLimit) {
      const c = text[j];
      if (braceDepth > 0) {
        if (braceEscape) {
          braceEscape = false;
        } else if (braceQuote) {
          if (c === "\\") braceEscape = true;
          else if (c === braceQuote) braceQuote = null;
        } else if (c === '"' || c === "'" || c === "`") {
          braceQuote = c;
        } else if (c === "{") {
          braceDepth++;
        } else if (c === "}") {
          braceDepth--;
          if (braceDepth === 0) lastUnquotedNonWs = "}";
        }
        j++;
        continue;
      }
      if (quote) {
        if (c === quote) quote = null;
        j++;
        continue;
      }
      if ((c === '"' || c === "'") && lastUnquotedNonWs === "=") {
        if (c === '"' && !noCloseDouble || c === "'" && !noCloseSingle) {
          quote = c;
        }
        lastUnquotedNonWs = c;
        j++;
        continue;
      }
      if (c === "{") {
        if (nextRightBrace !== -1 && nextRightBrace < j) {
          nextRightBrace = text.indexOf("}", j);
        }
        if (nextRightBrace === -1 || nextRightBrace >= headerLimit) {
          foundGt = false;
          break;
        }
        braceDepth = 1;
        braceQuote = null;
        braceEscape = false;
        j++;
        continue;
      }
      if (c === "<") {
        foundGt = false;
        break;
      }
      if (c === "&" && text[j + 1] === "&" || c === "|" && text[j + 1] === "|" || c === "=" && text[j + 1] === ">") {
        foundGt = false;
        break;
      }
      if (c === ">") {
        foundGt = true;
        break;
      }
      if (!/\s/.test(c)) {
        lastUnquotedNonWs = c;
      }
      j++;
    }
    if (!foundGt) {
      if (j === len) {
        if (quote === '"') noCloseDouble = true;
        else if (quote === "'") noCloseSingle = true;
      }
      i = tagStart + 1;
      continue;
    }
    const gtPos = j;
    const selfClosing = lastUnquotedNonWs === "/";
    const rawAttrSlice = text.slice(
      nameEnd,
      selfClosing ? text.lastIndexOf("/", gtPos) : gtPos
    );
    const startLineIdx = offsetToLineIdx(tagStart);
    const openEndLineIdx = offsetToLineIdx(gtPos);
    const startLine = startLineIdx + 1;
    const openEndLine = openEndLineIdx + 1;
    if (HTML_RAW_SKIP_TAGS.has(lowerTag)) {
      if (selfClosing || noCloseRawSkip.has(lowerTag)) {
        i = gtPos + 1;
        continue;
      }
      const closeRe = new RegExp(`</${lowerTag}\\s*>`, "gi");
      closeRe.lastIndex = gtPos + 1;
      const closeMatch = closeRe.exec(text);
      if (closeMatch) {
        i = closeMatch.index + closeMatch[0].length;
      } else {
        noCloseRawSkip.add(lowerTag);
        i = gtPos + 1;
      }
      continue;
    }
    if (lowerTag === "script" || lowerTag === "style") {
      const parsed = parseHtmlAttrs(rawAttrSlice);
      const tagDepth = Math.min(MAX_HTML_DEPTH, emittedCount);
      const label = formatHtmlTagLabel(lowerTag, lowerTag, rawAttrSlice, parsed);
      if (selfClosing) {
        symbols.push({
          kind: lowerTag,
          name: label,
          startLine,
          endLine: openEndLine,
          depth: tagDepth
        });
        i = gtPos + 1;
        continue;
      }
      const noCloseLatch = lowerTag === "script" ? noCloseScript : noCloseStyle;
      let closeMatch = null;
      if (!noCloseLatch) {
        const closeRe = new RegExp(`</${lowerTag}\\s*>`, "gi");
        closeRe.lastIndex = gtPos + 1;
        closeMatch = closeRe.exec(text);
        if (!closeMatch) {
          if (lowerTag === "script") noCloseScript = true;
          else noCloseStyle = true;
        }
      }
      let closeStart;
      let endLine;
      let nextPos;
      if (closeMatch) {
        closeStart = closeMatch.index;
        const closeEndPos = closeMatch.index + closeMatch[0].length;
        endLine = Math.max(startLine, offsetToLineIdx(closeEndPos - 1) + 1);
        nextPos = closeEndPos;
      } else if (lowerTag === "script" && parsed.attrs.has("src")) {
        closeStart = gtPos + 1;
        endLine = openEndLine;
        nextPos = gtPos + 1;
      } else {
        closeStart = len;
        endLine = Math.max(startLine, lines.length);
        nextPos = len;
      }
      symbols.push({
        kind: lowerTag,
        name: label,
        startLine,
        endLine,
        depth: tagDepth
      });
      const shouldRecurse = closeStart > gtPos + 1 && (lowerTag === "style" || !parsed.attrs.has("src") && isJsScriptType(parsed.attrs.get("type")));
      if (shouldRecurse) {
        const closeLineIdx = offsetToLineIdx(
          closeStart < len ? closeStart : Math.max(0, len - 1)
        );
        const innerLines = [];
        let innerBaseLineIdx;
        let hasFirstRest = false;
        if (openEndLineIdx === closeLineIdx) {
          innerBaseLineIdx = openEndLineIdx;
          const singleInner = text.slice(gtPos + 1, closeStart);
          if (singleInner.trim()) {
            innerLines.push(singleInner);
          }
        } else {
          const openLineEnd = openEndLineIdx + 1 < lineStarts.length ? lineStarts[openEndLineIdx + 1] - 1 : len;
          const firstRest = text.slice(gtPos + 1, openLineEnd);
          if (firstRest.trim()) {
            innerBaseLineIdx = openEndLineIdx;
            innerLines.push(firstRest.trimStart());
            hasFirstRest = true;
          } else {
            innerBaseLineIdx = openEndLineIdx + 1;
          }
          for (let li = openEndLineIdx + 1; li < closeLineIdx; li++) {
            innerLines.push(lines[li]);
          }
          if (closeStart < len) {
            const lastPrefix = text.slice(lineStarts[closeLineIdx], closeStart);
            if (lastPrefix.trim()) {
              innerLines.push(lastPrefix);
            }
          } else if (closeLineIdx >= openEndLineIdx + 1) {
            innerLines.push(lines[closeLineIdx]);
          }
        }
        if (innerLines.some((l) => l.trim().length > 0)) {
          const dedented = dedentBlockLines(innerLines, hasFirstRest);
          const innerSyms = lowerTag === "script" ? extractTsJsSymbols(dedented) : extractCssSymbols(dedented, true);
          for (const s of innerSyms) {
            const childStart = s.startLine + innerBaseLineIdx;
            const childEnd = Math.max(childStart, s.endLine + innerBaseLineIdx);
            symbols.push({
              kind: s.kind,
              name: s.name,
              startLine: childStart,
              endLine: childEnd,
              depth: Math.min(MAX_HTML_DEPTH, tagDepth + 1 + s.depth)
            });
          }
        }
      }
      i = nextPos;
      continue;
    }
    const isVoid = HTML_VOID_ELEMENTS.has(lowerTag);
    const isComponent = COMPONENT_LANDMARK_RE.test(rawTag);
    const isSemantic = HTML_SEMANTIC_TAGS.has(lowerTag);
    const isContainer = HTML_CONTAINER_TAGS.has(lowerTag);
    let shouldEmit = false;
    let emittedSymbol;
    if (isComponent || isSemantic || isContainer) {
      const parsed = parseHtmlAttrs(rawAttrSlice);
      const hasIdentityAttr = Boolean(parsed.attrs.get("id")?.trim()) || Boolean(parsed.attrs.get("data-testid")?.trim()) || Boolean(parsed.attrs.get("role")?.trim());
      const keepTemplate = lowerTag !== "template" || emittedCount === 0 || Boolean(parsed.vueSlot) || hasIdentityAttr;
      if (keepTemplate && (isComponent || isSemantic || isContainer && hasIdentityAttr)) {
        shouldEmit = true;
        const displayTag = isComponent ? rawTag : lowerTag;
        const kind = lowerTag === "body" ? "body" : lowerTag === "template" ? "template" : isComponent ? "component" : "block";
        emittedSymbol = {
          kind,
          name: formatHtmlTagLabel(displayTag, lowerTag, rawAttrSlice, parsed),
          startLine,
          endLine: openEndLine,
          depth: Math.min(MAX_HTML_DEPTH, emittedCount)
        };
        symbols.push(emittedSymbol);
      }
    }
    if (!selfClosing && !isVoid) {
      pushFrame({
        lowerTag,
        startLine,
        emitted: shouldEmit,
        symbol: emittedSymbol
      });
      if (shouldEmit) emittedCount++;
    }
    i = gtPos + 1;
  }
  const eofLine = lines.length;
  while (stack.length > 0) {
    const frame = popFrame();
    if (frame.emitted && frame.symbol) {
      frame.symbol.endLine = Math.max(frame.symbol.endLine, eofLine);
    }
  }
  return symbols;
}
function extractSfcSymbols(lines, mode = "vue") {
  const language = typeof mode === "boolean" ? (mode ? "html" : "vue") : mode;
  const symbols = extractTemplateSymbols(lines, language);
  return language !== "html" && symbols.length === 0 ? extractTsJsSymbols(lines) : symbols;
}
function parseGitDiffPath(line) {
  if (!line || line.length > 1024) return "";
  const rest = line.slice(11).trim();
  if (!rest) return "";
  const readToken = (str, start, isSecond = false) => {
    let i = start;
    while (i < str.length && str[i] === " ") i++;
    if (i >= str.length) return null;
    if (str[i] === '"') {
      let j = i + 1;
      let val = "";
      while (j < str.length) {
        if (str[j] === "\\" && j + 1 < str.length) {
          val += str[j] + str[j + 1];
          j += 2;
          continue;
        }
        if (str[j] === '"') {
          return { val, next: j + 1 };
        }
        val += str[j];
        j++;
      }
      return { val, next: j };
    }
    if (isSecond) {
      return { val: str.slice(i), next: str.length };
    }
    const nextQuoteB = str.indexOf(' "b/', i);
    if (nextQuoteB !== -1) {
      return { val: str.slice(i, nextQuoteB), next: nextQuoteB + 1 };
    }
    const nextPlainB = str.indexOf(" b/", i);
    if (nextPlainB !== -1) {
      return { val: str.slice(i, nextPlainB), next: nextPlainB + 1 };
    }
    const sp = str.indexOf(" ", i);
    if (sp === -1) return { val: str.slice(i), next: str.length };
    return { val: str.slice(i, sp), next: sp + 1 };
  };
  const first = readToken(rest, 0, false);
  if (!first) return rest.slice(0, 120);
  const second = readToken(rest, first.next, true);
  const chosen = second && second.val ? second.val : first.val;
  return chosen.replace(/^[ab]\//, "").trim().slice(0, 120);
}
function isLikelyGitDiffHeaderFollowup(nextLine) {
  if (typeof nextLine !== "string") return false;
  return (
    nextLine.startsWith("index ") ||
    nextLine.startsWith("new file mode ") ||
    nextLine.startsWith("deleted file mode ") ||
    nextLine.startsWith("old mode ") ||
    nextLine.startsWith("new mode ") ||
    nextLine.startsWith("rename from ") ||
    nextLine.startsWith("copy from ") ||
    nextLine.startsWith("Binary files ") ||
    nextLine.startsWith("similarity index ") ||
    nextLine.startsWith("--- ")
  );
}
function extractDiffSymbols(lines) {
  const symbols = [];
  let curFile = null;
  let curHunk = null;
  let inHunk = false;
  let inCommitMsg = false;
  let sawGitHeaderForFile = false;
  let sawGitDiffInPatch = false;

  const closeHunk = (endLine) => {
    if (curHunk) {
      curHunk.endLine = Math.max(curHunk.startLine, endLine);
      curHunk = null;
    }
  };
  const closeFile = (endLine) => {
    closeHunk(endLine);
    if (curFile) {
      curFile.endLine = Math.max(curFile.startLine, endLine);
      curFile.name = `${curFile.rawName} (+${curFile.added}/-${curFile.removed})`;
      delete curFile.rawName;
      delete curFile.added;
      delete curFile.removed;
      curFile = null;
    }
    inHunk = false;
    sawGitHeaderForFile = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (line.length <= 512 && /^From [0-9a-f]{40}\s/.test(line)) {
      closeFile(i);
      inCommitMsg = true;
      continue;
    }
    if (inCommitMsg) {
      if (line === "---") {
        inCommitMsg = false;
        continue;
      }
      if (!line.startsWith("diff --git ") || !isLikelyGitDiffHeaderFollowup(lines[i + 1])) continue;
      inCommitMsg = false;
    }

    if (line.startsWith("diff --git ")) {
      closeFile(i);
      const rawName = parseGitDiffPath(line) || line.slice(11).trim().slice(0, 120);
      curFile = {
        kind: "file",
        name: rawName,
        rawName,
        startLine: lineNum,
        endLine: lineNum,
        depth: 0,
        added: 0,
        removed: 0
      };
      symbols.push(curFile);
      sawGitHeaderForFile = true;
      sawGitDiffInPatch = true;
      continue;
    }

    // Standard `diff -u` header without `diff --git` (never split inside a git-diff hunk on `---`/`+++` code lines)
    if (
      !sawGitDiffInPatch &&
      line.startsWith("--- ") &&
      i + 1 < lines.length &&
      lines[i + 1].startsWith("+++ ") &&
      (!sawGitHeaderForFile && (!inHunk || (i + 2 < lines.length && lines[i + 2].startsWith("@@ "))))
    ) {
      closeFile(i);
      const plusLine = lines[i + 1].slice(4).split("\t")[0].trim();
      const minusLine = line.slice(4).split("\t")[0].trim();
      const chosenRaw = plusLine === "/dev/null" && minusLine && minusLine !== "/dev/null" ? minusLine : plusLine;
      const unquoted = chosenRaw.replace(/^"(.*)"$/, "$1");
      const rawName = unquoted.replace(/^[ab]\//, "").slice(0, 120) || "patch";
      curFile = {
        kind: "file",
        name: rawName,
        rawName,
        startLine: lineNum,
        endLine: lineNum + 1,
        depth: 0,
        added: 0,
        removed: 0
      };
      symbols.push(curFile);
      i += 1;
      continue;
    }

    if (line.startsWith("@@ ")) {
      closeHunk(i);
      inHunk = true;
      sawGitHeaderForFile = false;
      const hunkLabel = line.trim().slice(0, 88);
      curHunk = {
        kind: "hunk",
        name: hunkLabel,
        startLine: lineNum,
        endLine: lineNum,
        depth: curFile ? 1 : 0
      };
      symbols.push(curHunk);
      if (curFile) curFile.endLine = lineNum;
      continue;
    }

    if (inHunk) {
      if (line === "-- " && (lines[i + 1] === void 0 || /^\d+\.\d+/.test(lines[i + 1].trim()))) {
        closeHunk(i);
        inHunk = false;
        continue;
      }
      if (curFile) {
        if (line.startsWith("+")) curFile.added += 1;
        else if (line.startsWith("-")) curFile.removed += 1;
        curFile.endLine = lineNum;
      }
      if (curHunk) curHunk.endLine = lineNum;
    } else if (curFile) {
      curFile.endLine = lineNum;
    }
  }

  closeFile(lines.length);
  return symbols;
}
function extractDeclarations(filePath, lines) {
  if (lines.length > 0 && lines[0].startsWith("\uFEFF")) {
    lines = [lines[0].slice(1), ...lines.slice(1)];
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".patch" || ext === ".diff") {
    return extractDiffSymbols(lines);
  }
  if (lines.some((l) => l.length > 2048)) {
    lines = lines.map((l) => (l.length > 2048 ? "" : l));
  }
  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return extractTsJsSymbols(lines);
    case ".vue":
    case ".svelte":
      return extractSfcSymbols(lines, ext.slice(1));
    case ".html":
    case ".htm":
    case ".xhtml":
    case ".astro":
      return extractSfcSymbols(lines, "html");
    case ".css":
    case ".scss":
    case ".less":
    case ".pcss":
      return extractCssSymbols(lines);
    case ".py":
      return extractPythonSymbols(lines);
    case ".gd":
      return extractGdScriptSymbols(lines);
    case ".go":
      return extractGoSymbols(lines);
    case ".rs":
      return extractRustSymbols(lines);
    case ".dart":
    case ".java":
    case ".kt":
    case ".kts":
    case ".cs":
    case ".swift":
    case ".c":
    case ".cc":
    case ".cpp":
    case ".h":
    case ".hpp":
      return extractCLikeSymbols(lines);
    case ".sh":
    case ".bash":
    case ".zsh":
      return extractShellSymbols(lines);
    case ".md":
    case ".mdx":
      return extractMarkdownSymbols(lines);
    case ".json":
      return extractJsonYamlSymbols(lines, true);
    case ".yaml":
    case ".yml":
      return extractJsonYamlSymbols(lines, false);
    case ".patch":
    case ".diff":
      return extractDiffSymbols(lines);
    default:
      return extractTsJsSymbols(lines);
  }
}
function computeWaterFillBudgets(itemLengths, totalBudget, _minFloor = 160) {
  if (!Array.isArray(itemLengths) || itemLengths.length === 0) return [];
  const n = itemLengths.length;
  const cap = Math.max(0, Math.floor(Number(totalBudget) || 0));
  const lens = itemLengths.map((v) => {
    const num = Number(v);
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
  });
  const totalLen = lens.reduce((acc, v) => acc + v, 0);
  if (totalLen <= cap) {
    return [...lens];
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => lens[a] - lens[b] || a - b);
  const budgets = new Array(n).fill(0);
  let remainingBudget = cap;
  let remainingCount = n;
  for (let k = 0; k < n; k++) {
    const idx = order[k];
    const fair = Math.floor(remainingBudget / remainingCount);
    if (lens[idx] <= fair) {
      budgets[idx] = lens[idx];
      remainingBudget -= lens[idx];
      remainingCount -= 1;
    } else {
      const base = Math.floor(remainingBudget / remainingCount);
      const extra = remainingBudget - base * remainingCount;
      const tailIndices = order.slice(k).sort((a, b) => a - b);
      for (let m = 0; m < tailIndices.length; m++) {
        budgets[tailIndices[m]] = base + (m < extra ? 1 : 0);
      }
      break;
    }
  }
  return budgets;
}
function formatSymbolLine(s, { includeSignature = true, bracketLines = false } = {}) {
  const indent = "  ".repeat(s.depth);
  const span = s.endLine > s.startLine ? `L${s.startLine}-L${s.endLine}` : `L${s.startLine}`;
  return `${indent}${bracketLines ? "[" + span + "]" : span} [${s.kind}] ${includeSignature && s.signature || s.name}`;
}
function renderOutlineWithinBudget(relPath, lineCount, symbols, charBudget, totalOutlinesCount, { bracketLines = false } = {}) {
  const header = `## Outline: ${relPath} (${lineCount} lines)`;
  if (symbols.length === 0) {
    return `${header}\n(no top-level symbols detected)`;
  }
  const maxHardSymbols = 160;
  const candidatePool = selectOutlineSymbols(symbols, maxHardSymbols);
  let includeSignature = totalOutlinesCount <= 15;
  const formatPicked = (picked) => {
    const formatted = picked.map(s => formatSymbolLine(s, { includeSignature, bracketLines }));
    const omitted = symbols.length - picked.length;
    const extra =
      omitted > 0
        ? totalOutlinesCount > 10
          ? `\n... (+${omitted} more symbols)`
          : `\n... (${omitted} more symbols omitted; outline this file alone for full list)`
        : "";
    return `${header}\n${formatted.join("\n")}${extra}`;
  };
  const fullRendered = formatPicked(candidatePool);
  if (charBudget === null || Buffer.byteLength(fullRendered) <= charBudget) {
    return fullRendered;
  }
  includeSignature = false;
  const plain = formatPicked(candidatePool);
  if (Buffer.byteLength(plain) <= charBudget) return plain;
  const effBudget = charBudget;
  const priorityOrder = [
    ...candidatePool.map((s, idx) => ({ s, idx })).filter((x) => x.s.depth === 0),
    ...candidatePool.map((s, idx) => ({ s, idx })).filter((x) => x.s.depth > 0)
  ];
  const chosenIndices = [];
  let runningChars = Buffer.byteLength(header) + 1 + 64;
  for (const item of priorityOrder) {
    const lineLen = Buffer.byteLength(formatSymbolLine(item.s, { includeSignature, bracketLines })) + 1;
    if (chosenIndices.length > 0 && runningChars + lineLen > effBudget) {
      continue;
    }
    chosenIndices.push(item.idx);
    runningChars += lineLen;
  }
  chosenIndices.sort((a, b) => a - b);
  const picked = chosenIndices.map((idx) => candidatePool[idx]);
  return formatPicked(picked);
}
function selectOutlineSymbols(symbols, limit) {
  if (symbols.length <= limit) return symbols;
  const keptIndices = /* @__PURE__ */ new Set();
  for (let i = 0; i < symbols.length && keptIndices.size < limit; i++) {
    if (symbols[i].depth === 0) keptIndices.add(i);
  }
  for (let i = 0; i < symbols.length && keptIndices.size < limit; i++) {
    keptIndices.add(i);
  }
  return [...keptIndices].sort((a, b) => a - b).map((idx) => symbols[idx]);
}

function compactSignature(symbol, lines) {
  const header = lines.slice(symbol.startLine - 1, Math.min(symbol.endLine, symbol.startLine + 7))
    .map(line => line.slice(0, 2048)).join("\n");
  const nameOffset = header.indexOf(symbol.name);
  if (nameOffset < 0) return;
  const source = header.slice(nameOffset + symbol.name.length);
  // Preserve quoted literals while discarding comments. Balance parentheses first:
  // braces inside destructuring and callbacks are part of the parameter list.
  const tokens = source.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\.|[^\x60\\])*\x60|\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|#[^\n]*|\s+|=>|->|./g) || [];
  let params = "", depth = 0, cursor = 0;
  for (; cursor < tokens.length; cursor++) {
    const t = tokens[cursor];
    if (/^(?:\/\/|\/\*|#)/.test(t)) continue;
    if (!depth && t !== "(") continue;
    params += t.trim() ? t : " ";
    if (t === "(") depth++;
    else if (t === ")" && --depth === 0) { cursor++; break; }
  }
  if (!params || depth) return;
  const rest = tokens.slice(cursor).filter(t => !/^(?:\/\/|\/\*|#)/.test(t));
  while (rest.length && !rest[0].trim()) rest.shift();
  if (rest[0] === ":" || rest[0] === "->") {
    const marker = rest.shift();
    let type = "", braces = 0, angles = 0;
    for (const t of rest) {
      if (!braces && !angles && (t === ";" || t === "=>" || t === ":" || (t === "{" && type.trim()))) break;
      if (!braces && !angles && t.includes("\n") && (type.trim() || marker === ":")) break;
      if (t === "{") braces++;
      if (t === "}") { if (!braces) break; braces--; }
      if (t === "<") angles++;
      if (t === ">") angles = Math.max(0, angles - 1);
      type += t.trim() ? t : " ";
    }
    if (type.trim()) params += (marker === ":" ? ": " : " -> ") + type.trim();
  }
  const clean = redactSecrets(symbol.name + params, { force: true }).text;
  return clean.length <= 96 ? clean : clean.slice(0, 93) + "...";
}

export function extractSymbolsFromLines(filePath, lines) {
  const symbols = extractDeclarations(filePath, lines);
  for (const symbol of symbols) {
    if (symbol.kind !== "method" && symbol.kind !== "function") continue;
    const signature = compactSignature(symbol, lines);
    if (signature) symbol.signature = signature;
  }
  return symbols;
}

export { extractTsJsSymbols, extractPythonSymbols, extractGdScriptSymbols, extractGoSymbols, extractRustSymbols, extractCLikeSymbols, extractShellSymbols, extractMarkdownSymbols, extractJsonYamlSymbols, extractCssSymbols, extractSfcSymbols, extractDiffSymbols, computeWaterFillBudgets, formatSymbolLine, renderOutlineWithinBudget, selectOutlineSymbols };
