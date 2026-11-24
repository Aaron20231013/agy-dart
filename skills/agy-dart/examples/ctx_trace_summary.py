#!/usr/bin/env python3
"""Zero-dependency streaming JSONL/log error summarizer for agy-dart `ctx_execute`.

Usage (via ctx_execute `file` + `args`, or directly from CLI):
  python ctx_trace_summary.py <trace.jsonl|app.log> [--top 10] [--max-bytes 8000]

Streams arbitrarily large files line by line, aggregates error/warning signatures
by frequency, and caps UTF-8 output safely within agy-dart's <= 8.8 KB inline budget.
"""

from collections import Counter
import json
import re
import sys

DEFAULT_TOP = 10
DEFAULT_MAX_BYTES = 8000
MIN_MAX_BYTES = 64
HARD_MAX_BYTES = 8800

UUID_RE = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
)
ISO_TS_RE = re.compile(r"\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b")
HEX_ID_RE = re.compile(r"\b0x[0-9a-fA-F]+\b|\b[0-9a-fA-F]{16,}\b")
NUM_RE = re.compile(r"(?<![A-Za-z_])\d+(?:\.\d+)?")
WS_RE = re.compile(r"\s+")

PLAIN_LEVEL_RE = re.compile(r"\b(FATAL|CRITICAL|ERROR|ERR|WARN|WARNING|INFO|DEBUG|TRACE)\b", re.IGNORECASE)
ERROR_LEVELS = {"ERROR", "ERR", "FATAL", "CRITICAL"}
WARN_LEVELS = {"WARN", "WARNING"}
NUMERIC_LEVELS = {
    10: "TRACE",
    20: "DEBUG",
    30: "INFO",
    40: "WARN",
    50: "ERROR",
    60: "FATAL",
}


def parse_args(argv):
    path = ""
    top_n = DEFAULT_TOP
    max_bytes = DEFAULT_MAX_BYTES
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in ("-h", "--help"):
            print("Usage: ctx_trace_summary.py <log_or_jsonl_path> [--top N] [--max-bytes N]")
            sys.exit(0)
        elif arg == "--top" and i + 1 < len(argv):
            top_n = max(1, min(50, int(argv[i + 1])))
            i += 2
        elif arg.startswith("--top="):
            top_n = max(1, min(50, int(arg.split("=", 1)[1])))
            i += 1
        elif arg == "--max-bytes" and i + 1 < len(argv):
            max_bytes = max(MIN_MAX_BYTES, min(HARD_MAX_BYTES, int(argv[i + 1])))
            i += 2
        elif arg.startswith("--max-bytes="):
            max_bytes = max(MIN_MAX_BYTES, min(HARD_MAX_BYTES, int(arg.split("=", 1)[1])))
            i += 1
        elif not arg.startswith("-") and not path:
            path = arg
            i += 1
        else:
            raise ValueError(f"Unknown or unexpected argument: {arg}")
    if not path:
        raise ValueError("Missing input file path. Usage: ctx_trace_summary.py <file> [--top N] [--max-bytes N]")
    return path, top_n, max_bytes


def to_text(val):
    if val is None:
        return ""
    if isinstance(val, str):
        return val
    if isinstance(val, (dict, list)):
        return json.dumps(val, ensure_ascii=False)
    return str(val)


def parse_int_status(val):
    if isinstance(val, bool) or val is None:
        return None
    if isinstance(val, int):
        return val
    if isinstance(val, str) and val.strip().isdigit():
        return int(val.strip())
    return None


def normalize_level(raw):
    if raw is None or isinstance(raw, bool):
        return "UNKNOWN"
    if isinstance(raw, int):
        return NUMERIC_LEVELS.get(raw, f"L{raw}")
    text = str(raw).strip().upper()
    if text.isdigit():
        num = int(text)
        if num in NUMERIC_LEVELS:
            return NUMERIC_LEVELS[num]
    if text in ("ERR", "ERROR"):
        return "ERROR"
    if text in ("WARN", "WARNING"):
        return "WARN"
    if text in ("FATAL", "CRITICAL", "CRIT"):
        return "FATAL"
    if text in ("INFO", "DEBUG", "TRACE"):
        return text
    return text[:16] if text else "UNKNOWN"


def normalize_signature(text):
    cleaned = ISO_TS_RE.sub("<ts>", text)
    cleaned = UUID_RE.sub("<uuid>", cleaned)
    cleaned = HEX_ID_RE.sub("<hex>", cleaned)
    cleaned = NUM_RE.sub("<n>", cleaned)
    cleaned = WS_RE.sub(" ", cleaned).strip()
    return cleaned[:160]


def extract_json_record(obj):
    raw_level = obj.get("level")
    if raw_level is None:
        raw_level = obj.get("severity")
    if raw_level is None:
        raw_level = obj.get("lvl")
    if raw_level is None and (obj.get("error") or obj.get("err")):
        raw_level = "ERROR"
    level = normalize_level(raw_level)

    raw_status = obj.get("status")
    if raw_status is None:
        raw_status = obj.get("statusCode")
    if raw_status is None:
        raw_status = obj.get("status_code")
    status_int = parse_int_status(raw_status)
    if level == "UNKNOWN" and status_int is not None and status_int >= 500:
        level = "ERROR"
    elif level == "UNKNOWN" and status_int is not None and status_int >= 400:
        level = "WARN"

    parts = []
    code = obj.get("code") or obj.get("errorCode") or obj.get("error_code")
    if code is not None and code != "":
        parts.append(f"[{to_text(code)}]")
    route = obj.get("endpoint") or obj.get("route") or obj.get("path") or obj.get("tool")
    if route is not None and route != "":
        parts.append(to_text(route))
    err_val = obj.get("error") or obj.get("err")
    if isinstance(err_val, dict):
        err_msg = to_text(err_val.get("message") or err_val.get("msg") or err_val)
    elif err_val is not None and err_val is not False:
        err_msg = to_text(err_val)
    else:
        err_msg = ""
    raw_msg = obj.get("message")
    if raw_msg is None or raw_msg == "":
        raw_msg = obj.get("msg")
    if raw_msg is None or raw_msg == "":
        raw_msg = obj.get("detail")
    msg = to_text(raw_msg)
    if err_msg and err_msg != msg:
        parts.append(err_msg)
    if msg:
        parts.append(msg)
    if raw_status is not None and to_text(raw_status) not in " ".join(parts):
        parts.append(f"status={to_text(raw_status)}")
    summary = " ".join(p.strip() for p in parts if p and p.strip())
    return level, summary or json.dumps(obj, ensure_ascii=False)[:200]


def truncate_utf8(text, max_bytes):
    if max_bytes <= 0:
        return ""
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text
    suffix = "\n... [truncated to stay within inline byte budget]\n"
    suffix_bytes = len(suffix.encode("utf-8"))
    if max_bytes <= suffix_bytes:
        return encoded[:max_bytes].decode("utf-8", errors="ignore")
    keep = max_bytes - suffix_bytes
    cut = encoded[:keep].decode("utf-8", errors="ignore").rstrip()
    return cut + suffix


def summarize_file(file_path, top_n, max_bytes):
    total_lines = 0
    json_lines = 0
    plain_lines = 0
    malformed_json = 0
    levels = Counter()
    error_counts = Counter()
    error_samples = {}
    warn_counts = Counter()

    with open(file_path, "r", encoding="utf-8-sig", errors="replace") as fh:
        for lineno, raw_line in enumerate(fh, start=1):
            line = raw_line.strip()
            if not line:
                continue
            total_lines += 1
            level = "UNKNOWN"
            message = line
            if line.startswith("{"):
                try:
                    parsed = json.loads(line)
                    if isinstance(parsed, dict):
                        json_lines += 1
                        level, message = extract_json_record(parsed)
                    else:
                        plain_lines += 1
                except json.JSONDecodeError:
                    malformed_json += 1
                    plain_lines += 1
                    match = PLAIN_LEVEL_RE.search(line)
                    if match:
                        level = normalize_level(match.group(1))
            else:
                plain_lines += 1
                match = PLAIN_LEVEL_RE.search(line)
                if match:
                    level = normalize_level(match.group(1))

            levels[level] += 1
            if level in ERROR_LEVELS:
                sig = normalize_signature(message)
                error_counts[sig] += 1
                if sig not in error_samples:
                    error_samples[sig] = f"L{lineno}: {WS_RE.sub(' ', message).strip()[:180]}"
            elif level in WARN_LEVELS:
                warn_counts[normalize_signature(message)] += 1

    out = [
        f"Trace Summary: {file_path}",
        f"Lines: {total_lines} total ({json_lines} JSON objects, {plain_lines} plain, {malformed_json} malformed JSON)",
    ]
    if levels:
        level_str = ", ".join(f"{k}={v}" for k, v in levels.most_common())
        out.append(f"Levels: {level_str}")
    else:
        out.append("Levels: none (empty file)")

    total_errors = sum(error_counts.values())
    total_warns = sum(warn_counts.values())
    out.append(f"Errors: {total_errors} ({len(error_counts)} unique) | Warnings: {total_warns} ({len(warn_counts)} unique)")

    if error_counts:
        out.append(f"\nTop {min(top_n, len(error_counts))} Error Signatures:")
        for rank, (sig, count) in enumerate(error_counts.most_common(top_n), start=1):
            out.append(f"  {rank}. [{count}x] {sig}")
            out.append(f"     sample: {error_samples[sig]}")
    elif warn_counts:
        out.append(f"\nTop {min(top_n, len(warn_counts))} Warning Signatures:")
        for rank, (sig, count) in enumerate(warn_counts.most_common(top_n), start=1):
            out.append(f"  {rank}. [{count}x] {sig}")

    return truncate_utf8("\n".join(out) + "\n", max_bytes)


def main():
    try:
        file_path, top_n, max_bytes = parse_args(sys.argv[1:])
        report = summarize_file(file_path, top_n, max_bytes)
        sys.stdout.buffer.write(report.encode("utf-8"))
        sys.stdout.buffer.flush()
    except (OSError, ValueError) as exc:
        sys.stderr.write(f"ctx_trace_summary error: {exc}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
