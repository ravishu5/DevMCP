/**
 * Dependency manifest parsing (spec §4 find_dependencies).
 *
 * Parsers are intentionally **tolerant and non-executing**. A build file is a program in
 * several of these ecosystems (Gradle Kotlin DSL is literally Kotlin), and evaluating one
 * is exactly the arbitrary-code-execution risk spec §22 forbids. So we pattern-match the
 * declaration syntax and accept that dynamically-computed dependencies are missed —
 * reporting that gap honestly (`inferred`/`notes`) rather than pretending completeness.
 *
 * Coverage is deliberately broad rather than deep: knowing a repository pulls in OkHttp
 * and WorkManager is decision-relevant; knowing the exact resolved version of a transitive
 * dependency usually is not, and costs a lockfile fetch.
 */

import type { Dependency, DependencyEcosystem } from "../../types/index.js";

export interface ManifestSpec {
  path: string;
  ecosystem: DependencyEcosystem;
}

/** Manifest filenames worth fetching, in priority order. */
export const MANIFEST_PATTERNS: { re: RegExp; ecosystem: DependencyEcosystem }[] = [
  { re: /(^|\/)package\.json$/, ecosystem: "npm" },
  { re: /(^|\/)build\.gradle(\.kts)?$/, ecosystem: "gradle" },
  { re: /(^|\/)libs\.versions\.toml$/, ecosystem: "gradle" },
  { re: /(^|\/)pom\.xml$/, ecosystem: "maven" },
  { re: /(^|\/)requirements(-\w+)?\.txt$/, ecosystem: "pypi" },
  { re: /(^|\/)pyproject\.toml$/, ecosystem: "pypi" },
  { re: /(^|\/)setup\.py$/, ecosystem: "pypi" },
  { re: /(^|\/)Pipfile$/, ecosystem: "pypi" },
  { re: /(^|\/)Cargo\.toml$/, ecosystem: "cargo" },
  { re: /(^|\/)go\.mod$/, ecosystem: "go" },
  { re: /(^|\/)composer\.json$/, ecosystem: "composer" },
  { re: /(^|\/)Gemfile$/, ecosystem: "gem" },
  { re: /(^|\/)Package\.swift$/, ecosystem: "swiftpm" },
  { re: /(^|\/)Podfile$/, ecosystem: "cocoapods" },
  { re: /\.csproj$/, ecosystem: "nuget" },
];

/** Depth limit: a monorepo has hundreds of manifests and we want the top-level story. */
export function findManifests(paths: string[], maxDepth = 3, limit = 12): ManifestSpec[] {
  const found: ManifestSpec[] = [];
  for (const p of paths) {
    if (p.split("/").length > maxDepth + 1) continue;
    if (/(^|\/)(node_modules|vendor|third_party|\.git|build|dist|target|Pods)\//.test(p)) continue;
    const hit = MANIFEST_PATTERNS.find((m) => m.re.test(p));
    if (hit) found.push({ path: p, ecosystem: hit.ecosystem });
    if (found.length >= limit) break;
  }
  // Shallower manifests first — the root manifest describes the project, not a fixture.
  return found.sort((a, b) => a.path.split("/").length - b.path.split("/").length);
}

export function parseManifest(spec: ManifestSpec, content: string): Dependency[] {
  try {
    switch (spec.ecosystem) {
      case "npm": return parsePackageJson(content, spec.path);
      case "gradle": return spec.path.endsWith(".toml")
        ? parseVersionCatalog(content, spec.path)
        : parseGradle(content, spec.path);
      case "maven": return parsePom(content, spec.path);
      case "pypi": return parsePython(content, spec.path);
      case "cargo": return parseCargo(content, spec.path);
      case "go": return parseGoMod(content, spec.path);
      case "composer": return parseComposer(content, spec.path);
      case "gem": return parseGemfile(content, spec.path);
      case "swiftpm": return parseSwiftPm(content, spec.path);
      case "cocoapods": return parsePodfile(content, spec.path);
      case "nuget": return parseCsproj(content, spec.path);
      default: return [];
    }
  } catch {
    // A malformed manifest is a fact about the repository, not a reason to fail the run.
    return [];
  }
}

const dep = (
  name: string, version: string | undefined, ecosystem: DependencyEcosystem,
  scope: Dependency["scope"], declaredIn: string, inferred = false,
): Dependency => ({ name: name.trim(), version: version?.trim(), ecosystem, scope, declaredIn, inferred });

function parsePackageJson(content: string, path: string): Dependency[] {
  const pkg = JSON.parse(content) as Record<string, Record<string, string> | undefined>;
  const groups: [string, Dependency["scope"]][] = [
    ["dependencies", "runtime"], ["devDependencies", "dev"],
    ["peerDependencies", "peer"], ["optionalDependencies", "optional"],
  ];
  const out: Dependency[] = [];
  for (const [field, scope] of groups) {
    for (const [name, version] of Object.entries(pkg[field] ?? {})) {
      out.push(dep(name, String(version), "npm", scope, path));
    }
  }
  return out;
}

/**
 * Gradle: matches `implementation("g:a:v")`, `api 'g:a:v'`, and version-catalog
 * references (`libs.okhttp`). Catalog references have no version here by design — the
 * version lives in libs.versions.toml, and inventing one would be worse than omitting it.
 */
function parseGradle(content: string, path: string): Dependency[] {
  const out: Dependency[] = [];
  // `classpath` declares BUILD tooling (the Android Gradle plugin, the Kotlin plugin) —
  // things the build needs, not things a consumer of this library inherits. Reporting them
  // as runtime dependencies inflated the integration surface and put "gradle" at the top of
  // the dependency list for a download library.
  const scopeOf = (c: string): Dependency["scope"] =>
    /^(test|androidTest)/i.test(c) ? "test"
      : /^(kapt|ksp|annotationProcessor|compileOnly|classpath)/i.test(c) ? "build"
      : "runtime";

  const coord = /\b(implementation|api|compileOnly|runtimeOnly|testImplementation|androidTestImplementation|kapt|ksp|annotationProcessor|classpath)\s*[\s(]\s*["']([^"':\s]+):([^"':\s]+)(?::([^"'\s]+))?["']/g;
  for (const m of content.matchAll(coord)) {
    const version = m[4];
    // A "$kotlin_version" version is a real declaration we cannot resolve without
    // evaluating the build script — which we will not do (spec §22). Reporting the
    // placeholder as if it were a version would be worse than admitting we do not know.
    const unresolved = Boolean(version && (version.startsWith("$") || version.includes("${")));
    out.push(dep(`${m[2]}:${m[3]}`, unresolved ? undefined : version, "gradle", scopeOf(m[1] ?? ""), path, unresolved));
  }
  const catalog = /\b(implementation|api|testImplementation|androidTestImplementation|ksp|kapt)\s*[\s(]\s*(libs\.[A-Za-z0-9._-]+)/g;
  for (const m of content.matchAll(catalog)) {
    out.push(dep(m[2] ?? "", undefined, "gradle", scopeOf(m[1] ?? ""), path, true));
  }
  return out;
}

function parseVersionCatalog(content: string, path: string): Dependency[] {
  const out: Dependency[] = [];
  for (const m of content.matchAll(/^\s*[\w.-]+\s*=\s*\{([^}]*)\}/gm)) {
    const body = m[1] ?? "";
    const module = /module\s*=\s*["']([^"']+)["']/.exec(body)?.[1];
    const group = /group\s*=\s*["']([^"']+)["']/.exec(body)?.[1];
    const artifact = /name\s*=\s*["']([^"']+)["']/.exec(body)?.[1];
    const version = /version(?:\.ref)?\s*=\s*["']([^"']+)["']/.exec(body)?.[1];
    const name = module ?? (group && artifact ? `${group}:${artifact}` : undefined);
    if (name) out.push(dep(name, version, "gradle", "runtime", path));
  }
  return out;
}

function parsePom(content: string, path: string): Dependency[] {
  const out: Dependency[] = [];
  for (const m of content.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const body = m[1] ?? "";
    const g = /<groupId>\s*([^<]+?)\s*<\/groupId>/.exec(body)?.[1];
    const a = /<artifactId>\s*([^<]+?)\s*<\/artifactId>/.exec(body)?.[1];
    const v = /<version>\s*([^<]+?)\s*<\/version>/.exec(body)?.[1];
    const s = /<scope>\s*([^<]+?)\s*<\/scope>/.exec(body)?.[1]?.toLowerCase();
    if (g && a) {
      const scope: Dependency["scope"] = s === "test" ? "test" : s === "provided" ? "build" : "runtime";
      // A ${property} version is a real declaration we cannot resolve statically — say so.
      out.push(dep(`${g}:${a}`, v, "maven", scope, path, Boolean(v?.startsWith("${"))));
    }
  }
  return out;
}

function parsePython(content: string, path: string): Dependency[] {
  const out: Dependency[] = [];
  if (path.endsWith("pyproject.toml")) {
    // PEP 621 `dependencies = [...]` and Poetry `[tool.poetry.dependencies]`.
    for (const m of content.matchAll(/^\s*dependencies\s*=\s*\[([\s\S]*?)\]/gm)) {
      for (const s of (m[1] ?? "").matchAll(/["']([^"']+)["']/g)) {
        const p = splitPyReq(s[1] ?? "");
        if (p) out.push(dep(p.name, p.version, "pypi", "runtime", path));
      }
    }
    const poetry = /\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\n\[|$)/.exec(content)?.[1];
    for (const m of (poetry ?? "").matchAll(/^\s*([A-Za-z0-9._-]+)\s*=\s*["']?([^"'\n{]+)/gm)) {
      if ((m[1] ?? "").toLowerCase() !== "python") out.push(dep(m[1] ?? "", m[2], "pypi", "runtime", path));
    }
    return out;
  }
  if (path.endsWith("setup.py")) {
    for (const m of content.matchAll(/install_requires\s*=\s*\[([\s\S]*?)\]/g)) {
      for (const s of (m[1] ?? "").matchAll(/["']([^"']+)["']/g)) {
        const p = splitPyReq(s[1] ?? "");
        if (p) out.push(dep(p.name, p.version, "pypi", "runtime", path));
      }
    }
    return out;
  }
  if (path.endsWith("Pipfile")) {
    for (const m of content.matchAll(/^\s*([A-Za-z0-9._-]+)\s*=\s*["']([^"']*)["']/gm)) {
      out.push(dep(m[1] ?? "", m[2] || undefined, "pypi", "runtime", path));
    }
    return out;
  }
  // requirements.txt
  const scope: Dependency["scope"] = /requirements-(dev|test)/i.test(path) ? "dev" : "runtime";
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("-")) continue;
    const p = splitPyReq(t);
    if (p) out.push(dep(p.name, p.version, "pypi", scope, path));
  }
  return out;
}

function splitPyReq(s: string): { name: string; version?: string } | null {
  const m = /^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(s.split(";")[0]?.trim() ?? "");
  if (!m?.[1]) return null;
  return { name: m[1], version: m[2]?.trim() || undefined };
}

function parseCargo(content: string, path: string): Dependency[] {
  const out: Dependency[] = [];
  const sections: [RegExp, Dependency["scope"]][] = [
    [/\[dependencies\]([\s\S]*?)(?=\n\[|$)/, "runtime"],
    [/\[dev-dependencies\]([\s\S]*?)(?=\n\[|$)/, "dev"],
    [/\[build-dependencies\]([\s\S]*?)(?=\n\[|$)/, "build"],
  ];
  for (const [re, scope] of sections) {
    const body = re.exec(content)?.[1] ?? "";
    for (const m of body.matchAll(/^\s*([A-Za-z0-9._-]+)\s*=\s*(?:["']([^"']+)["']|\{[^}]*version\s*=\s*["']([^"']+)["'])/gm)) {
      out.push(dep(m[1] ?? "", m[2] ?? m[3], "cargo", scope, path));
    }
  }
  return out;
}

function parseGoMod(content: string, path: string): Dependency[] {
  const out: Dependency[] = [];
  for (const block of content.matchAll(/require\s*\(([\s\S]*?)\)/g)) {
    for (const m of (block[1] ?? "").matchAll(/^\s*([^\s]+)\s+([^\s]+)(\s*\/\/\s*indirect)?/gm)) {
      out.push(dep(m[1] ?? "", m[2], "go", m[3] ? "optional" : "runtime", path));
    }
  }
  for (const m of content.matchAll(/^require\s+([^\s(]+)\s+([^\s]+)/gm)) {
    out.push(dep(m[1] ?? "", m[2], "go", "runtime", path));
  }
  return out;
}

function parseComposer(content: string, path: string): Dependency[] {
  const pkg = JSON.parse(content) as Record<string, Record<string, string> | undefined>;
  const out: Dependency[] = [];
  for (const [name, v] of Object.entries(pkg.require ?? {})) if (name !== "php") out.push(dep(name, v, "composer", "runtime", path));
  for (const [name, v] of Object.entries(pkg["require-dev"] ?? {})) out.push(dep(name, v, "composer", "dev", path));
  return out;
}

function parseGemfile(content: string, path: string): Dependency[] {
  const out: Dependency[] = [];
  for (const m of content.matchAll(/^\s*gem\s+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/gm)) {
    out.push(dep(m[1] ?? "", m[2], "gem", "runtime", path));
  }
  return out;
}

function parseSwiftPm(content: string, path: string): Dependency[] {
  const out: Dependency[] = [];
  for (const m of content.matchAll(/\.package\s*\(\s*(?:name:\s*["'][^"']*["']\s*,\s*)?url:\s*["']([^"']+)["']([^)]*)\)/g)) {
    const name = (m[1] ?? "").replace(/\.git$/, "").split("/").slice(-2).join("/");
    const version = /from:\s*["']([^"']+)["']/.exec(m[2] ?? "")?.[1];
    out.push(dep(name, version, "swiftpm", "runtime", path));
  }
  return out;
}

function parsePodfile(content: string, path: string): Dependency[] {
  const out: Dependency[] = [];
  for (const m of content.matchAll(/^\s*pod\s+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/gm)) {
    out.push(dep(m[1] ?? "", m[2], "cocoapods", "runtime", path));
  }
  return out;
}

function parseCsproj(content: string, path: string): Dependency[] {
  const out: Dependency[] = [];
  for (const m of content.matchAll(/<PackageReference\s+Include\s*=\s*"([^"]+)"(?:[^>]*Version\s*=\s*"([^"]+)")?/g)) {
    out.push(dep(m[1] ?? "", m[2], "nuget", "runtime", path));
  }
  return out;
}

/** Deduplicate, preferring the shallowest declaration and a concrete version. */
export function dedupeDependencies(deps: Dependency[]): Dependency[] {
  const byName = new Map<string, Dependency>();
  for (const d of deps) {
    const k = `${d.ecosystem}:${d.name.toLowerCase()}`;
    const existing = byName.get(k);
    if (!existing) { byName.set(k, d); continue; }
    const better =
      (!existing.version && d.version) ||
      (existing.inferred && !d.inferred) ||
      d.declaredIn.split("/").length < existing.declaredIn.split("/").length;
    if (better) byName.set(k, d);
  }
  return [...byName.values()];
}
