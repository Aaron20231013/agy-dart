import { createHash } from "node:crypto";

function compareAsciiKeys(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively rebuild plain objects with lexicographically sorted keys while preserving array order.
 */
export function stableSortObject(value) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stableSortObject(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const sorted = {};
  for (const key of Object.keys(value).sort(compareAsciiKeys)) {
    sorted[key] = stableSortObject(value[key]);
  }
  return sorted;
}

/** Deterministic JSON serialization with recursively sorted object keys */
export function stableStringify(value, space) {
  return JSON.stringify(stableSortObject(value), null, space);
}

/** Compute lowercase hex SHA-256 digest of a UTF-8 string */
export function sha256Hex(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}
