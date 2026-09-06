/**
 * Parser for jCodeMunch's compact wire format.
 *
 * jCodeMunch replies in an interned, CSV-ish encoding rather than JSON:
 *
 *   #MUNCH/1 tool=list_repos enc=gen1
 *
 *   @1=/srv/index/repos/
 *   @9=sqlite
 *
 *   count=31 __stypes=count:int __tables=t:repos:repo|indexed_at|...:str|str|int|...
 *
 *   t,282857341/nnFormer,2026-09-05T23:01:37,967,169,d48aaeb0...,@1282857341/nnFormer,...
 *
 * `@N=value` defines an interned string; `@N` anywhere in a field expands to it, including
 * as a *prefix* of a longer value (`@1282857341/nnFormer` = `<@1>282857341/nnFormer`).
 * That prefix expansion is the subtle part and the reason a naive split-and-replace gets
 * paths wrong.
 *
 * Design stance: this format is undocumented and may change. So the parser is defensive
 * and returns `null` rather than throwing, and every caller has a JSON path and a fallback.
 * A wire-format change must degrade this MCP to GitHub retrieval, never crash it
 * (spec §21).
 */

export interface MunchTable {
  name: string;
  columns: string[];
  types: string[];
  rows: Record<string, unknown>[];
}

export interface MunchDocument {
  version: string;
  tool?: string;
  encoding?: string;
  /** Scalar key=value pairs from the header line (e.g. `count=31`). */
  scalars: Record<string, unknown>;
  tables: MunchTable[];
  /** Free text that did not parse as structure. Kept so nothing is silently lost. */
  trailing: string[];
}

/** True when the payload looks like the MUNCH format rather than JSON. */
export function isMunch(text: string): boolean {
  return /^\s*#MUNCH\//.test(text);
}

/**
 * Parse a MUNCH document. Returns null when the text is not MUNCH or is unparseable —
 * callers treat null as "use the fallback path".
 */
export function parseMunch(text: string): MunchDocument | null {
  if (!isMunch(text)) return null;
  try {
    return parseInner(text);
  } catch {
    return null;
  }
}

function parseInner(text: string): MunchDocument {
  const lines = text.split(/\r?\n/);
  const header = (lines[0] ?? "").trim();
  const headerMatch = /^#MUNCH\/(\S+)(.*)$/.exec(header);
  const version = headerMatch?.[1] ?? "unknown";
  const headerAttrs = parseAttrs(headerMatch?.[2] ?? "");

  const interned = new Map<string, string>();
  const scalars: Record<string, unknown> = {};
  const tableDefs = new Map<string, { name: string; columns: string[]; types: string[] }>();
  const rowsByTag = new Map<string, Record<string, unknown>[]>();
  const trailing: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = raw.trim();
    if (!line) continue;

    // Interning definition: @N=value
    const intern = /^@(\d+)=(.*)$/.exec(line);
    if (intern) {
      // A definition may itself reference earlier symbols.
      interned.set(`@${intern[1]}`, expand(intern[2] ?? "", interned));
      continue;
    }

    // Metadata line: `count=31 __stypes=... __tables=...`
    if (line.includes("__tables=") || line.includes("__stypes=") || /^\w+=[^,]*$/.test(line)) {
      const attrs = parseAttrs(line);
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "__tables") {
          for (const def of parseTableDefs(String(v))) tableDefs.set(def.tag, def);
        } else if (k === "__stypes") {
          // Scalar types; applied below when coercing.
          scalars.__stypes = v;
        } else {
          scalars[k] = v;
        }
      }
      continue;
    }

    // Data row: `<tag>,<field>,<field>,...`
    const comma = line.indexOf(",");
    if (comma > 0) {
      const tag = line.slice(0, comma);
      const def = tableDefs.get(tag);
      if (def) {
        const fields = splitCsv(line.slice(comma + 1)).map((f) => expand(f, interned));
        const row: Record<string, unknown> = {};
        def.columns.forEach((col, idx) => {
          row[col] = coerce(fields[idx], def.types[idx]);
        });
        const list = rowsByTag.get(tag) ?? [];
        list.push(row);
        rowsByTag.set(tag, list);
        continue;
      }
    }

    trailing.push(expand(line, interned));
  }

  // Coerce scalar values using __stypes when present (e.g. "count:int").
  const stypes = parseScalarTypes(String(scalars.__stypes ?? ""));
  delete scalars.__stypes;
  for (const [k, t] of Object.entries(stypes)) {
    if (k in scalars) scalars[k] = coerce(String(scalars[k]), t);
  }

  const tables: MunchTable[] = [];
  for (const [tag, def] of tableDefs) {
    tables.push({
      name: def.name,
      columns: def.columns,
      types: def.types,
      rows: rowsByTag.get(tag) ?? [],
    });
  }

  return {
    version,
    tool: headerAttrs.tool as string | undefined,
    encoding: headerAttrs.enc as string | undefined,
    scalars,
    tables,
    trailing,
  };
}

/**
 * Expand interned references.
 *
 * References may appear as a whole field OR as a prefix of a longer value: `@1foo/bar`
 * means `<value of @1>foo/bar`. Longest-symbol-first matching prevents `@1` from
 * shadowing `@12`, which would corrupt every path in the document.
 */
function expand(value: string, interned: Map<string, string>): string {
  if (!value.includes("@")) return value;
  return value.replace(/@(\d+)/g, (match, digits: string) => {
    // Try the longest numeric run first, then progressively shorter prefixes.
    for (let len = digits.length; len >= 1; len--) {
      const symbol = `@${digits.slice(0, len)}`;
      const hit = interned.get(symbol);
      if (hit !== undefined) return hit + digits.slice(len);
    }
    return match;
  });
}

/** `key=value` pairs, tolerating quoted values containing spaces. */
function parseAttrs(s: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const re = /(\w+|__\w+)=("[^"]*"|'[^']*'|[^\s]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const key = m[1] as string;
    let value = m[2] ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** `t:repos:repo|indexed_at|...:str|str|int|...` → one table definition per comma group. */
function parseTableDefs(spec: string): { tag: string; name: string; columns: string[]; types: string[] }[] {
  const defs: { tag: string; name: string; columns: string[]; types: string[] }[] = [];
  for (const group of spec.split(";")) {
    const parts = group.split(":");
    if (parts.length < 3) continue;
    const tag = (parts[0] ?? "").trim();
    const name = (parts[1] ?? "").trim();
    const columns = (parts[2] ?? "").split("|").map((c) => c.trim()).filter(Boolean);
    const types = (parts[3] ?? "").split("|").map((t) => t.trim());
    if (!tag || !columns.length) continue;
    defs.push({ tag, name, columns, types });
  }
  return defs;
}

function parseScalarTypes(spec: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of spec.split(",")) {
    const [k, t] = pair.split(":");
    if (k && t) out[k.trim()] = t.trim();
  }
  return out;
}

/** CSV split honouring double quotes, since descriptions and dicts contain commas. */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) { out.push(current); current = ""; continue; }
    current += ch;
  }
  out.push(current);
  return out;
}

/** Coerce a field using its declared type. `T`/`F` are MUNCH's booleans. */
function coerce(value: string | undefined, type: string | undefined): unknown {
  if (value === undefined || value === "") return undefined;
  switch (type) {
    case "int": {
      const n = Number.parseInt(value, 10);
      return Number.isFinite(n) ? n : value;
    }
    case "float": {
      const n = Number.parseFloat(value);
      return Number.isFinite(n) ? n : value;
    }
    case "bool":
      return value === "T" || value === "true" || value === "1";
    default:
      return value;
  }
}

/** Convenience: find a table by name or tag. */
export function findTable(doc: MunchDocument, name: string): MunchTable | undefined {
  return doc.tables.find((t) => t.name === name) ?? doc.tables[0];
}

/**
 * Normalise a tool result of unknown shape into plain objects.
 *
 * jCodeMunch answers in JSON for some actions and MUNCH for others, and which is which is
 * not documented. Callers should not have to care, so this tries JSON, then MUNCH, then
 * gives up honestly.
 */
export function parseToolPayload(text: string): { kind: "json"; value: unknown } | { kind: "munch"; value: MunchDocument } | { kind: "text"; value: string } {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { kind: "json", value: JSON.parse(trimmed) };
    } catch {
      // fall through — a truncated JSON payload is still worth trying as text
    }
  }
  const munch = parseMunch(trimmed);
  if (munch) return { kind: "munch", value: munch };
  return { kind: "text", value: trimmed };
}
