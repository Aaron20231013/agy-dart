import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { truncateUtf8Bytes } from "../context/lib/store.js";
import { computeUnifiedDiff, truncateUtf8Safe } from "../context/lib/text-diff.js";
import { capSerializedJsonField, fetchUrlText } from "../context/lib/tools.js";
import { isPrivateOrReservedIp, validateFetchTarget } from "../context/lib/security.js";
import {
  hasUnsafeShellSyntax,
  isSafeRegex,
  matchFilterRule,
  truncateHeadTailUtf8Safe,
  unwrapSafeCompoundCommand
} from "../hooks/filter-rules.mjs";

// Deterministic Mulberry32 PRNG for 100% reproducible property & fuzz tests
function createRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hasLoneSurrogate(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Strict unified diff applier for Myers roundtrip property testing */
function applyUnifiedDiff(baseText, diffText, startLineOffset = 1) {
  if (!diffText || !diffText.trim()) return baseText;
  const baseLines = baseText === "" ? [] : baseText.replace(/\r\n/g, "\n").split("\n");
  if (baseLines.length > 0 && baseLines[baseLines.length - 1] === "") baseLines.pop();
  const hadTrailingNewline = baseText.endsWith("\n");

  const diffLines = diffText.split("\n");
  const out = [];
  let cursor = 0; // 0-based index into baseLines
  let i = 0;

  while (i < diffLines.length && (diffLines[i].startsWith("--- ") || diffLines[i].startsWith("+++ "))) {
    i++;
  }

  while (i < diffLines.length) {
    const header = diffLines[i++];
    if (!header.startsWith("@@ ")) continue;
    const m = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    assert.ok(m, `Invalid hunk header: ${header}`);
    const oldStart = Number(m[1]);
    const oldCount = m[2] !== undefined ? Number(m[2]) : 1;
    const targetIdx = oldCount === 0 && oldStart === 0 ? 0 : Math.max(0, oldStart - startLineOffset);

    while (cursor < targetIdx && cursor < baseLines.length) {
      out.push(baseLines[cursor++]);
    }

    while (i < diffLines.length && !diffLines[i].startsWith("@@ ")) {
      const line = diffLines[i++];
      if (line.startsWith(" ")) {
        assert.equal(baseLines[cursor], line.slice(1), `Context mismatch at cursor ${cursor}`);
        out.push(baseLines[cursor++]);
      } else if (line.startsWith("-")) {
        assert.equal(baseLines[cursor], line.slice(1), `Removal mismatch at cursor ${cursor}`);
        cursor++;
      } else if (line.startsWith("+")) {
        out.push(line.slice(1));
      }
    }
  }

  while (cursor < baseLines.length) {
    out.push(baseLines[cursor++]);
  }
  return out.length === 0 ? "" : out.join("\n") + (hadTrailingNewline ? "\n" : "");
}

test("Property 1: UTF-8 truncation helpers never exceed byte budget, never emit U+FFFD or lone surrogates (200 randomized CJK/emoji cases)", () => {
  const rng = createRng(0x20261120);
  const alphabet = [
    "a", "Z", "0", " ", "\n", "\"", "\\",
    "é", "ñ", "Ω", "Ж", // 2-byte UTF-8
    "中", "文", "缓", "存", "测", "试", "日", "本", "한", // 3-byte UTF-8 CJK/Hangul
    "🚀", "🔥", "🧪", "𠀀", "✨" // 4-byte UTF-8 surrogate pairs + BMP emoji
  ];

  for (let trial = 0; trial < 200; trial++) {
    const len = 10 + Math.floor(rng() * 140);
    let str = "";
    for (let j = 0; j < len; j++) {
      str += alphabet[Math.floor(rng() * alphabet.length)];
    }
    const maxBytes = 1 + Math.floor(rng() * 220);

    for (const fn of [truncateUtf8Bytes, truncateUtf8Safe]) {
      const out = fn(str, maxBytes);
      assert.ok(Buffer.byteLength(out, "utf8") <= maxBytes, `Byte budget exceeded on trial ${trial}`);
      assert.equal(out.includes("\uFFFD"), false, `U+FFFD introduced on trial ${trial}`);
      assert.equal(hasLoneSurrogate(out), false, `Lone surrogate introduced on trial ${trial}`);
    }

    const htBudget = 40 + Math.floor(rng() * 200);
    const ht = truncateHeadTailUtf8Safe(str, htBudget);
    assert.ok(Buffer.byteLength(ht, "utf8") <= htBudget, `Head-tail budget exceeded on trial ${trial}`);
    assert.equal(ht.includes("\uFFFD"), false);
    assert.equal(hasLoneSurrogate(ht), false);

    // JSON serialized field capper must always produce valid JSON <= maxJsonBytes
    const jsonBudget = 160 + Math.floor(rng() * 300);
    const payload = { id: trial, output: "" };
    capSerializedJsonField(payload, "output", str.repeat(4), "\n...[cap]", jsonBudget);
    const serialized = JSON.stringify(payload, null, 2);
    assert.ok(Buffer.byteLength(serialized, "utf8") <= jsonBudget, `JSON cap exceeded on trial ${trial}`);
    assert.doesNotThrow(() => JSON.parse(serialized));
    assert.equal(payload.output.includes("\uFFFD"), false);
    assert.equal(hasLoneSurrogate(payload.output), false);
  }
});

test("Property 2: ReDoS validator rejects catastrophic patterns, accepts safe patterns, and survives 300 fuzzed inputs cleanly", () => {
  const mustReject = [
    "(a+)+",
    "(a*)*",
    "([a-z]+)*",
    "(a+){2,}",
    "(.*a){10}",
    "((ab)+)+",
    "(a|a)+",
    "(a|aa)+",
    "(foo|foobar)+",
    "([a-z]+|[a-z0-9]+)+",
    "(a+)\\1+",
    "a{1,10000}",
    "(?:[a-z]+)+$",
    "(?=a+)+",
    "a+a+a+a+a+b",
    "\\s+\\s+\\s+\\s+X",
    "\\w+\\w+\\w+\\w+!",
    "[a-z]+[a-z]+",
    "a+b?a+",
    "(?:a)+(?:a)+(?:a)+(?:a)+(?:a)+b",
    "(a)+(a)+(a)+(a)+(a)+b",
    "(a|b)+(a|b)+(a|b)+(a|b)+c",
    "(?:\\w)+(?:\\w)+(?:\\w)+(?:\\w)+!",
    "(?:a+)(?:a+)(?:a+)(?:a+)b",
    "a+(?:a+)b",
    "(?:a)+a+b",
    "a+(?:b)?a+",
    "a+b*a+",
    "((a|aa))+",
    "(a|A)+",
    "(?:a){1,50}(?:a){1,50}b",
    "a+(?=a)a+",
    "(?i:a)+(?i:a)+",
    "()+",
    "(?:\\b)+",
    "(?:a)\\k<x>",
    "(?:ab)+(?:ab)+",
    ".*a.*a.*a.*a.*b",
    "a+aa+aa+aa+b",
    "(?:a)+a(?:a)+a(?:a)+b",
    "\\w+_\\w+_\\w+_\\w+!",
    "a+(?:a)a+",
    "a?".repeat(25) + "a".repeat(25) + "Z",
    "(?:a)?".repeat(20) + "a".repeat(20) + "Z",
    "unclosed(",
    "",
    "x".repeat(500)
  ];
  for (const p of mustReject) {
    assert.equal(isSafeRegex(p), false, `ReDoS pattern MUST be rejected: ${p}`);
  }

  const mustAccept = [
    "^FAIL\\b",
    "error\\[\\d+\\]",
    "\\b(?:WARN|ERROR|FATAL)\\b",
    "\\(a\\+\\)\\+",
    "[+*()?]+",
    "^\\s*tests?\\s+\\d+\\s+passed",
    "^[a-z0-9_.-]{1,64}$",
    "(?:foo)+(?:bar)+",
    "a+(?:b)a+",
    "a+(?:b|c)a+",
    "(?:a|b)+",
    "\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}",
    "\\w+:\\w+",
    "\\w+\\.\\w+",
    "ERROR.*timeout",
    "a+b*ba+"
  ];
  for (const p of mustAccept) {
    assert.equal(isSafeRegex(p), true, `Safe pattern MUST be accepted: ${p}`);
  }

  const rng = createRng(0xfeedface);
  const tokens = ["a", "b", "0", "\\d", "\\w", ".", "(", ")", "(?:", "[", "]", "|", "+", "*", "?", "{2,5}", "\\1", "^", "$", "\\+"];
  const t0 = performance.now();
  for (let i = 0; i < 300; i++) {
    const n = 1 + Math.floor(rng() * 18);
    let expr = "";
    for (let j = 0; j < n; j++) expr += tokens[Math.floor(rng() * tokens.length)];
    const res = isSafeRegex(expr);
    assert.equal(typeof res, "boolean");
  }
  assert.ok(performance.now() - t0 < 500, "300 fuzzed isSafeRegex checks must complete in < 500ms");
});

test("Property 3: Shell syntax hardening (cmd %, !, ^; PowerShell {}, @) + unwrapSafeCompoundCommand fuzzing (300 cases)", () => {
  const mustBlock = [
    "npm test %TEMP%",
    "pytest %USERPROFILE%",
    "npm test !PATH!",
    "npm test foo^bar",
    "pytest a^ b",
    "npm test { exit 1 }",
    "pytest @(1,2)",
    "pytest @{a=1}",
    "npm test @splat",
    "npm test\0--flag",
    "git diff HEAD^ && whoami",
    "git diff ^HEAD",
    "cd sub && npm test %PATH%",
    "cd sub && pytest { a }",
    "cd 'foo!bar' && npm test",
    "cd foo^bar && npm test",
    "cd {sub} && npm test",
    "cd @splat && npm test",
    "cd foo\0bar && npm test",
    'cd "foo^bar" && npm test',
    'cd "foo{a}" && npm test'
  ];
  for (const cmd of mustBlock) {
    assert.equal(matchFilterRule(cmd), null, `Unsafe/cross-shell-drift command must NOT match filter rule: ${cmd}`);
  }

  // Benign commands that MUST remain supported
  assert.equal(matchFilterRule("git diff HEAD^")?.rule.id, "git-diff");
  assert.equal(matchFilterRule("git diff HEAD^1..HEAD")?.rule.id, "git-diff");
  assert.equal(matchFilterRule("npm install lodash@4.17.21")?.rule.id, "pkg-install");
  assert.equal(matchFilterRule('cd /d "packages/core" && npm test 2>&1')?.rule.id, "test-runner");

  // Fuzz unwrapSafeCompoundCommand: never throws, and any accepted innerCommand passes !hasUnsafeShellSyntax
  const rng = createRng(0xbadc0de);
  const pieces = [
    "cd ", "cd /d ", "\"sub dir\"", "'sub'", "pkg", "..", " && ", " || ", " ; ", " | ",
    "npm test", "git diff HEAD^", "pytest -v", " 2>&1", " > out.txt", "%TEMP%", "!VAR!",
    "{a}", "@(1)", "@foo", "$(id)", "`id`", "\n", "\0", "^&"
  ];
  for (let i = 0; i < 300; i++) {
    const n = 1 + Math.floor(rng() * 6);
    let cmd = "";
    for (let j = 0; j < n; j++) cmd += pieces[Math.floor(rng() * pieces.length)];
    const uw = unwrapSafeCompoundCommand(cmd);
    if (uw !== null) {
      assert.equal(hasUnsafeShellSyntax(uw.innerCommand), false, `Unwrapped innerCommand must be safe: ${uw.innerCommand}`);
      assert.equal(uw.innerCommand.includes("\n"), false);
      assert.equal(uw.innerCommand.includes("\0"), false);
    }
  }
});

test("Property 4: Myers unified diff roundtrip applyUnifiedDiff(a, computeUnifiedDiff(a, b)) === b across 120 random & boundary cases", () => {
  const rng = createRng(0x1337beef);
  const pool = [
    "const alpha = 1;",
    "const beta = 2;",
    "export function run() { return true; }",
    "// 中文注释测试 🚀",
    "return value + delta;",
    "  if (ok) break;",
    "}"
  ];

  const makeDoc = (lineCount) => {
    const lines = [];
    for (let i = 0; i < lineCount; i++) {
      lines.push(`L${i}_${pool[Math.floor(rng() * pool.length)]}`);
    }
    return lines.length ? lines.join("\n") + "\n" : "";
  };

  for (let trial = 0; trial < 120; trial++) {
    const n = trial === 0 ? 0 : trial === 1 ? 1 : 5 + Math.floor(rng() * 80);
    const baseText = makeDoc(n);
    const baseLines = baseText ? baseText.slice(0, -1).split("\n") : [];
    const nextLines = [...baseLines];

    // Apply random inserts, deletes, and edits
    const ops = Math.floor(rng() * 12);
    for (let k = 0; k < ops; k++) {
      const op = Math.floor(rng() * 3);
      const pos = nextLines.length ? Math.floor(rng() * nextLines.length) : 0;
      if (op === 0 && nextLines.length > 0) {
        nextLines.splice(pos, 1); // delete
      } else if (op === 1) {
        nextLines.splice(pos, 0, `INS_${trial}_${k}_中文✨`); // insert
      } else if (nextLines.length > 0) {
        nextLines[pos] = `MOD_${trial}_${k}_${pool[Math.floor(rng() * pool.length)]}`; // modify
      }
    }
    const nextText = nextLines.length ? nextLines.join("\n") + "\n" : "";
    const startLine = trial % 5 === 0 ? 25 : 1;

    const res = computeUnifiedDiff(baseText, nextText, {
      fileLabel: `case_${trial}.js`,
      startLine,
      maxDiffBytes: 32768
    });

    if (!res.truncated) {
      const reconstructed = applyUnifiedDiff(baseText, res.diff, startLine);
      assert.equal(reconstructed, nextText, `Roundtrip mismatch on trial ${trial} (startLine=${startLine})`);
    }
  }

  // Large file linear-fallback roundtrip (>2000 edits triggers linear fallback path safely without OOM)
  const bigA = Array.from({ length: 1200 }, (_, i) => `row_${i} = ${i};`).join("\n") + "\n";
  const bigB = Array.from({ length: 1200 }, (_, i) => (i % 2 === 0 ? `changed_${i} = ${i * 2};` : `row_${i} = ${i};`)).join("\n") + "\n";
  const bigRes = computeUnifiedDiff(bigA, bigB, { fileLabel: "big.js", maxDiffBytes: 256 * 1024 });
  assert.equal(bigRes.changed, true);
  assert.equal(applyUnifiedDiff(bigA, bigRes.diff, 1), bigB);
});

test("Property 5: SSRF IPv4-mapped IPv6 bypasses & TTL=0 DNS rebinding protection via IP pinning", async () => {
  // 1. IPv4-mapped IPv6, NAT64, 6to4, ULA, link-local, loopback, cloud metadata must ALL be blocked
  const privateTargets = [
    "127.0.0.1",
    "169.254.169.254",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "::1",
    "::",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:169.254.169.254",
    "::ffff:10.0.0.1",
    "64:ff9b::127.0.0.1",
    "64:ff9b::169.254.169.254",
    "2002:7f00:0001::1",
    "fe80::1%eth0",
    "fc00::1",
    "fd12:3456::1",
    "2001:0000:4136:e378:8000:63bf:3fff:fdd2"
  ];
  for (const ip of privateTargets) {
    assert.equal(isPrivateOrReservedIp(ip), true, `Expected private/reserved IP to be blocked: ${ip}`);
  }
  assert.equal(isPrivateOrReservedIp("93.184.216.34"), false);
  assert.equal(isPrivateOrReservedIp("2606:2800:220:1:248:1893:25c8:1946"), false);

  // 2. TTL=0 DNS rebinding simulation:
  //    Call 1 resolves rebind.example -> 93.184.216.34 (public)
  //    Call 2 resolves rebind.example -> 127.0.0.1 (private loopback!)
  //    validateFetchTarget returns pinned 93.184.216.34 on call 1 and BLOCKS call 2.
  let dnsCalls = 0;
  const rebindingLookup = async () => {
    dnsCalls++;
    if (dnsCalls === 1) return [{ address: "93.184.216.34", family: 4 }];
    return [{ address: "127.0.0.1", family: 4 }];
  };

  const first = await validateFetchTarget("http://rebind.example/data", { lookupFn: rebindingLookup });
  assert.equal(first.pinned.address, "93.184.216.34");
  await assert.rejects(
    () => validateFetchTarget("http://rebind.example/data", { lookupFn: rebindingLookup }),
    /Blocked SSRF DNS resolution/i
  );

  // 3. End-to-end fetchUrlText DNS-rebinding & redirect-to-private guard:
  //    Spin up a local canary server on 127.0.0.1; verify fetchUrlText blocks loopback,
  //    IPv4-mapped IPv6, and a TTL=0 rebinding lookup that flips public -> 127.0.0.1 on redirect.
  let canaryTouched = false;
  const canaryServer = http.createServer((req, res) => {
    canaryTouched = true;
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("SECRET_INTERNAL_CANARY");
  });
  await new Promise((resolve) => canaryServer.listen(0, "127.0.0.1", resolve));
  const canaryPort = canaryServer.address().port;

  // Redirector server that tries to redirect to the SAME rebinding hostname whose hop-2 TTL=0 lookup flips to 127.0.0.1
  let redirectorHits = 0;
  const redirector = http.createServer((req, res) => {
    redirectorHits++;
    res.writeHead(302, { Location: `http://rebind-e2e.example:${canaryPort}/secret` });
    res.end();
  });
  await new Promise((resolve) => redirector.listen(0, "127.0.0.1", resolve));
  const redirPort = redirector.address().port;

  try {
    await assert.rejects(
      () => fetchUrlText(`http://127.0.0.1:${canaryPort}/secret`),
      /Blocked SSRF/i
    );
    assert.equal(canaryTouched, false, "Canary loopback server must NEVER be contacted when SSRF blocks it");

    await assert.rejects(
      () => fetchUrlText(`http://[::ffff:127.0.0.1]:${canaryPort}/secret`),
      /Blocked SSRF/i
    );
    assert.equal(canaryTouched, false, "IPv4-mapped IPv6 loopback must NEVER touch canary");

    // End-to-end 2-hop TTL=0 DNS rebinding + IP pinning test (allowPrivate remains FALSE throughout!):
    // Hop 1 resolves rebind-e2e.example -> 93.184.216.34 (public). Our test Agent verifies pinnedLookup
    // actually hands out 93.184.216.34 (not re-querying DNS!) and routes that hop-1 connection to `redirector`.
    // Redirector replies 302 -> http://rebind-e2e.example:<canaryPort>/secret; Hop 2 re-resolves DNS,
    // gets 127.0.0.1 (TTL=0 rebind!), and MUST block BEFORE touching canaryServer.
    let e2eDnsCalls = 0;
    const e2eLookup = async () => {
      e2eDnsCalls++;
      if (e2eDnsCalls === 1) return [{ address: "93.184.216.34", family: 4 }];
      return [{ address: "127.0.0.1", family: 4 }];
    };
    const pinnedIpsSeen = [];
    const testAgent = new http.Agent({ keepAlive: false });
    const origCreateConn = testAgent.createConnection.bind(testAgent);
    testAgent.createConnection = (opts, cb) => {
      assert.equal(typeof opts.lookup, "function", "fetchUrlText must supply a pinned lookup function");
      opts.lookup(opts.host, { family: 4 }, (err, addr) => {
        assert.equal(err, null);
        pinnedIpsSeen.push(Array.isArray(addr) ? addr[0]?.address : addr);
      });
      return origCreateConn({ ...opts, host: "127.0.0.1", port: redirPort, lookup: undefined }, cb);
    };
    await assert.rejects(
      () => fetchUrlText(`http://rebind-e2e.example:${redirPort}/start`, { lookupFn: e2eLookup, agent: testAgent }),
      /Blocked SSRF DNS resolution/i
    );
    assert.equal(redirectorHits, 1, "Hop 1 public target must reach redirector once");
    assert.deepEqual(pinnedIpsSeen, ["93.184.216.34"], "Hop 1 socket must use pinned IP without re-resolving DNS");
    assert.equal(e2eDnsCalls, 2, "DNS must be re-validated on hop 2 and blocked when TTL=0 flips to 127.0.0.1");
    assert.equal(canaryTouched, false, "Canary loopback server must NEVER be contacted on hop-2 TTL=0 rebind");
  } finally {
    await new Promise((r) => canaryServer.close(r));
    await new Promise((r) => redirector.close(r));
  }
});
