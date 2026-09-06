/**
 * Licence analysis (spec §12).
 *
 * Three rules govern everything here:
 *
 *   1. **Never claim legal certainty.** Every verdict carries a disclaimer. We report
 *      obligations and risks; a lawyer decides.
 *   2. **Never silently recommend incompatible code.** Missing or ambiguous licensing
 *      produces a loud warning, never an assumption of reusability.
 *   3. **Read the licence file, never prose claims.** A README saying "MIT licensed" is
 *      attacker-controlled text (SECURITY.md T8); the LICENSE file and the provider's own
 *      SPDX detection are the evidence.
 *
 * Compatibility is evaluated against the *consuming* project's distribution model, because
 * that is what actually determines risk: GPL code in an internal tool is a very different
 * situation from GPL code in a shipped proprietary binary, and a tool that ignores the
 * difference is either uselessly alarmist or dangerously permissive.
 */

import type { LicenseCategory, LicenseInfo, LicenseWarning, TargetStack } from "../types/index.js";
import type { LicenseRaw } from "../providers/github/types.js";

export const LICENSE_DISCLAIMER =
  "Advisory only — not legal advice. Verify licence terms with a qualified professional before reuse.";

interface LicenseSpec {
  category: LicenseCategory;
  name: string;
  obligations: string[];
  /** Aliases and common spellings found in the wild. */
  aliases?: string[];
}

const LICENSES: Record<string, LicenseSpec> = {
  "MIT": { category: "permissive", name: "MIT License", obligations: ["Preserve copyright notice and licence text"] },
  "Apache-2.0": { category: "permissive", name: "Apache License 2.0", obligations: ["Preserve copyright and NOTICE file", "State significant changes", "Includes an express patent grant"] },
  "BSD-2-Clause": { category: "permissive", name: "BSD 2-Clause", obligations: ["Preserve copyright notice"] },
  "BSD-3-Clause": { category: "permissive", name: "BSD 3-Clause", obligations: ["Preserve copyright notice", "Do not use contributor names to endorse"] },
  "ISC": { category: "permissive", name: "ISC License", obligations: ["Preserve copyright notice"] },
  "Unlicense": { category: "public-domain", name: "The Unlicense", obligations: [] },
  "CC0-1.0": { category: "public-domain", name: "Creative Commons Zero 1.0", obligations: [] },
  "0BSD": { category: "public-domain", name: "BSD Zero Clause", obligations: [] },
  "Zlib": { category: "permissive", name: "zlib License", obligations: ["Do not misrepresent origin"] },
  "MPL-2.0": { category: "weak-copyleft", name: "Mozilla Public License 2.0", obligations: ["Modified MPL-licensed FILES must remain MPL and be published", "Larger work may use another licence"] },
  "EPL-2.0": { category: "weak-copyleft", name: "Eclipse Public License 2.0", obligations: ["Modifications to EPL files must be published under EPL"] },
  "LGPL-2.1": { category: "weak-copyleft", name: "GNU LGPL v2.1", obligations: ["Dynamic linking generally permitted", "Users must be able to relink a modified library", "STATIC linking may impose LGPL on the combined work"] },
  "LGPL-3.0": { category: "weak-copyleft", name: "GNU LGPL v3.0", obligations: ["Dynamic linking generally permitted", "Users must be able to relink a modified library", "Anti-tivoisation clause applies to consumer devices"] },
  "GPL-2.0": { category: "strong-copyleft", name: "GNU GPL v2.0", obligations: ["Derivative works must be released under GPL-2.0", "Complete corresponding source must be offered to recipients"] },
  "GPL-3.0": { category: "strong-copyleft", name: "GNU GPL v3.0", obligations: ["Derivative works must be released under GPL-3.0", "Complete corresponding source must be offered", "Patent and anti-tivoisation clauses apply"] },
  "AGPL-3.0": { category: "network-copyleft", name: "GNU AGPL v3.0", obligations: ["All GPL-3.0 obligations", "NETWORK USE counts as distribution: users interacting over a network must be offered the complete source"] },
  "SSPL-1.0": { category: "network-copyleft", name: "Server Side Public License", obligations: ["Offering the software as a service requires releasing the entire service stack", "Not recognised as open source by the OSI"] },
  "BUSL-1.1": { category: "proprietary", name: "Business Source License 1.1", obligations: ["Production use is restricted until the change date", "Source-available, not open source"] },
  "Elastic-2.0": { category: "proprietary", name: "Elastic License 2.0", obligations: ["May not be offered as a managed service", "Source-available, not open source"] },
  "CC-BY-4.0": { category: "permissive", name: "Creative Commons Attribution 4.0", obligations: ["Attribution required", "Designed for content, not software — unusual for code"] },
  "CC-BY-SA-4.0": { category: "strong-copyleft", name: "CC Attribution-ShareAlike 4.0", obligations: ["Attribution required", "Derivatives must use the same licence", "Designed for content, not software"] },
};

/** Text fingerprints, used when SPDX metadata is absent but a LICENSE file exists. */
const TEXT_SIGNATURES: [RegExp, string][] = [
  [/GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/i, "AGPL-3.0"],
  [/GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3/i, "LGPL-3.0"],
  [/GNU LESSER GENERAL PUBLIC LICENSE\s+Version 2\.1/i, "LGPL-2.1"],
  [/GNU GENERAL PUBLIC LICENSE\s+Version 3/i, "GPL-3.0"],
  [/GNU GENERAL PUBLIC LICENSE\s+Version 2/i, "GPL-2.0"],
  [/Apache License\s+Version 2\.0/i, "Apache-2.0"],
  [/Mozilla Public License Version 2\.0/i, "MPL-2.0"],
  [/Eclipse Public License - v ?2\.0/i, "EPL-2.0"],
  [/Server Side Public License/i, "SSPL-1.0"],
  [/Business Source License/i, "BUSL-1.1"],
  [/Permission is hereby granted, free of charge, to any person obtaining a copy/i, "MIT"],
  [/Redistributions of source code must retain[\s\S]{0,400}Neither the name/i, "BSD-3-Clause"],
  [/Redistributions of source code must retain/i, "BSD-2-Clause"],
  [/Permission to use, copy, modify, and\/or distribute this software/i, "ISC"],
  [/This is free and unencumbered software released into the public domain/i, "Unlicense"],
];

export interface LicenseAnalysisInput {
  raw: LicenseRaw | null;
  /** SPDX from repository metadata, when the licence endpoint gave nothing. */
  metadataSpdx?: string;
  /** The consuming project's situation, which is what determines actual risk. */
  target?: TargetStack;
  repository: string;
}

export function analyzeLicense(input: LicenseAnalysisInput): LicenseInfo {
  const { spdx, confidence, sourceFile } = identify(input);

  if (!spdx) {
    return {
      spdx: "UNKNOWN",
      name: "No identifiable licence",
      category: "unknown",
      confidence: 0,
      compatible: "unclear",
      obligations: [],
      warnings: [{
        severity: "high",
        // Spec §12 asks for this wording specifically.
        message:
          "Repository does not contain a clearly identifiable license. Do not assume the code is freely reusable. " +
          "Absence of a licence means default copyright applies: all rights reserved.",
      }],
      disclaimer: LICENSE_DISCLAIMER,
    };
  }

  const spec = LICENSES[spdx];
  if (!spec) {
    return {
      spdx,
      name: spdx,
      category: "unknown",
      confidence: confidence * 0.7,
      sourceFile,
      compatible: "unclear",
      obligations: [],
      warnings: [{ severity: "caution", message: `Licence "${spdx}" is not in our reference table. Review its terms manually before reuse.` }],
      disclaimer: LICENSE_DISCLAIMER,
    };
  }

  const { compatible, warnings } = assessCompatibility(spec, spdx, input.target);
  return {
    spdx,
    name: spec.name,
    category: spec.category,
    confidence,
    sourceFile,
    compatible,
    obligations: spec.obligations,
    warnings,
    disclaimer: LICENSE_DISCLAIMER,
  };
}

function identify(input: LicenseAnalysisInput): { spdx?: string; confidence: number; sourceFile?: string } {
  // 1. Provider SPDX detection on the licence file — the strongest signal available.
  const declared = input.raw?.spdx ?? input.metadataSpdx;
  if (declared && declared !== "NOASSERTION" && declared !== "unknown") {
    const normalised = normaliseSpdx(declared);
    return { spdx: normalised, confidence: 0.95, sourceFile: input.raw?.path };
  }
  // 2. Fingerprint the licence text itself.
  if (input.raw?.text) {
    for (const [re, id] of TEXT_SIGNATURES) {
      if (re.test(input.raw.text)) return { spdx: id, confidence: 0.85, sourceFile: input.raw.path };
    }
    // A licence file exists but matches nothing we know — a real, reportable state.
    return { spdx: undefined, confidence: 0, sourceFile: input.raw.path };
  }
  return { confidence: 0 };
}

/** Strip "-only"/"-or-later" suffixes and normalise case to our table's keys. */
function normaliseSpdx(id: string): string {
  const cleaned = id.trim().replace(/-(only|or-later)$/i, "");
  const match = Object.keys(LICENSES).find((k) => k.toLowerCase() === cleaned.toLowerCase());
  return match ?? cleaned;
}

/**
 * Compatibility, evaluated against how the consuming project is distributed.
 *
 * The distinction matters enormously and most tools get it wrong in one direction or the
 * other: AGPL in an internal tool is usually fine; AGPL in a hosted SaaS is a source-release
 * obligation; GPL in a shipped proprietary binary is a licence violation. Reporting one
 * verdict for all three would be either alarmist or dangerous.
 */
function assessCompatibility(
  spec: LicenseSpec,
  spdx: string,
  target?: TargetStack,
): { compatible: boolean | "unclear"; warnings: LicenseWarning[] } {
  const warnings: LicenseWarning[] = [];
  const distribution = target?.distribution ?? "unknown";
  const proprietary = distribution === "proprietary";
  const internal = distribution === "internal";

  switch (spec.category) {
    case "permissive":
    case "public-domain":
      return { compatible: true, warnings };

    case "weak-copyleft": {
      warnings.push({
        severity: "caution",
        message: `${spdx} is weak copyleft: modifications to its own files must stay under ${spdx} and be published. ` +
                 `Using it unmodified, or linking to it, is normally fine.`,
      });
      if (spdx.startsWith("LGPL")) {
        warnings.push({
          severity: "caution",
          message: "LGPL: static linking or vendoring the source may impose LGPL on your combined work. Dynamic linking is the safer pattern.",
        });
      }
      return { compatible: true, warnings };
    }

    case "strong-copyleft": {
      warnings.push({
        severity: proprietary ? "high" : "caution",
        message: `${spdx} is strong copyleft: a derivative work must itself be released under ${spdx}, with complete corresponding source.`,
      });
      if (proprietary) {
        warnings.push({
          severity: "high",
          message: "Your project is declared proprietary. Copying this code into it would very likely be incompatible. Reference the approach and write an independent implementation instead.",
        });
        return { compatible: false, warnings };
      }
      if (internal) {
        warnings.push({
          severity: "info",
          message: "Internal-only use is generally not 'distribution' under GPL, so obligations may not trigger — but this changes the moment the software is shipped or offered externally.",
        });
        return { compatible: "unclear", warnings };
      }
      return { compatible: distribution === "open-source" ? true : "unclear", warnings };
    }

    case "network-copyleft": {
      warnings.push({
        severity: "high",
        message: `${spdx}: NETWORK USE counts as distribution. Running this in a hosted service obliges you to offer complete source to your users.`,
      });
      if (proprietary) {
        warnings.push({ severity: "high", message: "Incompatible with a proprietary product in almost all configurations. Treat as reference only." });
        return { compatible: false, warnings };
      }
      return { compatible: "unclear", warnings };
    }

    case "proprietary": {
      warnings.push({
        severity: "high",
        message: `${spdx} is source-available, not open source. Production and managed-service use are restricted. Read the licence before any reuse.`,
      });
      return { compatible: false, warnings };
    }

    default:
      return { compatible: "unclear", warnings };
  }
}

/** 0–1 score for the ranking axis. Unknown is scored low but not zero — it is a risk, not a disqualification. */
export function licenseScore(info: LicenseInfo): number {
  if (info.compatible === false) return 0;
  switch (info.category) {
    case "public-domain": return 1;
    case "permissive": return 1;
    case "weak-copyleft": return 0.7;
    case "strong-copyleft": return info.compatible === "unclear" ? 0.35 : 0.5;
    case "network-copyleft": return 0.2;
    case "proprietary": return 0.05;
    case "unknown":
    case "none":
    default: return 0.15;
  }
}
