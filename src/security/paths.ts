/**
 * Path safety (spec §30 "path traversal", §22).
 *
 * Repository file paths are attacker-controlled: a repository can contain a file literally
 * named `../../../../etc/passwd` or a symlink pointing outside the tree. Two places this
 * matters:
 *
 *   1. **Target-project analysis**, where we read from the user's real filesystem and must
 *      not be walked out of the project root.
 *   2. **Cache keys and display**, where a crafted path could otherwise collide with, or
 *      impersonate, another repository's entry.
 */

import { resolve, relative, isAbsolute, sep, normalize } from "node:path";

/** True if `child` resolves to a location inside `root`. Symlink-aware callers should realpath first. */
export function isWithin(root: string, child: string): boolean {
  const r = resolve(root);
  const c = resolve(root, child);
  if (c === r) return true;
  const rel = relative(r, c);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Resolve a repository-relative path safely, or return null.
 *
 * Rejects absolute paths, traversal, NUL bytes, and Windows drive/UNC prefixes. Returning
 * null rather than throwing keeps this usable inside `filter()` at call sites that are
 * processing many attacker-supplied paths and should simply skip bad ones.
 */
export function safeJoin(root: string, untrustedRelative: string): string | null {
  if (!untrustedRelative || untrustedRelative.includes("\0")) return null;
  if (isAbsolute(untrustedRelative)) return null;
  if (/^[a-zA-Z]:[\\/]/.test(untrustedRelative)) return null;   // C:\…
  if (/^\\\\/.test(untrustedRelative)) return null;              // \\server\share
  const joined = resolve(root, untrustedRelative);
  return isWithin(root, joined) ? joined : null;
}

/**
 * Normalise a repository-internal path for display, comparison and cache keys.
 * Returns null when the path is not a plausible in-repo path.
 */
export function safeRepoPath(p: string): string | null {
  if (!p || p.includes("\0")) return null;
  const cleaned = normalize(p.replace(/\\/g, "/")).split(sep).join("/").replace(/^\.\//, "");
  if (cleaned.startsWith("/") || cleaned.startsWith("../") || cleaned === ".." ) return null;
  if (/^[a-zA-Z]:\//.test(cleaned)) return null;
  return cleaned;
}

/** Repository full-name validation. Guards cache keys and URL construction. */
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidRepoFullName(s: string): boolean {
  return REPO_NAME.test(s) && s.length <= 200 && !s.includes("..");
}

/** Parse "owner/name", "https://github.com/owner/name", "github.com/owner/name(.git)". */
export function parseRepoFullName(input: string): { owner: string; name: string; fullName: string } | null {
  let s = input.trim();
  s = s.replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "");
  s = s.replace(/^git@github\.com:/i, "");
  s = s.replace(/\.git$/i, "");
  s = s.replace(/[?#].*$/, "");
  s = s.replace(/\/+$/, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0] as string;
  const name = parts[1] as string;
  const fullName = `${owner}/${name}`;
  return isValidRepoFullName(fullName) ? { owner, name, fullName } : null;
}

/** Commit SHA validation, for cache-key integrity. */
export function isValidSha(s: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(s);
}

/** Git ref validation — conservative, rejects anything shell- or path-hostile. */
export function isValidRef(s: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,200}$/.test(s) && !s.includes("..") && !s.endsWith("/");
}
