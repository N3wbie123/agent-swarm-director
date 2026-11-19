/**
 * ASD v2.7.0 Harness-Conditional Skill Renderer (src/adapters/installer/skill-renderer.ts)
 *
 * Resolves:
 * 1. Version stamping (`ASD vX.Y.Z` -> `ASD v${ASD_VERSION}`).
 * 2. Canonical alias mapping (`asd-handoff` -> `src/skills/handoff/SKILL.md` with frontmatter `name: asd-handoff`).
 * 3. Harness-conditional blocks (`<!-- @harness:<id> -->...<!-- @end -->`):
 *    - When `harnessId` is provided: keeps only blocks matching `harnessId` (supports comma-separated IDs)
 *      and removes non-matching blocks cleanly without leaving stray blank lines or comment tags.
 *    - When `harnessId` is omitted: strips conditional tags cleanly while keeping all blocks.
 * 4. Dynamic `{{LIGHT_<ROLE>_MODEL}}` placeholder substitution from `routing.jsonc` via
 *    `resolveLightSubagentModel`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveLightSubagentModel } from "../../core/router.ts";
import {
  ASD_VERSION,
  type HarnessId,
  type RoutingConfig,
} from "../../core/types.ts";

export interface RenderSkillOptions {
  harnessId?: HarnessId;
  routingConfig?: RoutingConfig | null;
}

function getAsdRoot(): string {
  return path.resolve(import.meta.dirname, "..", "..", "..");
}

function matchesHarnessTag(tagList: string, harnessId?: HarnessId): boolean {
  if (!harnessId) return true;
  const targets = tagList
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
  return targets.includes(harnessId.toLowerCase());
}

/**
 * Resolves `<!-- @harness:<id> -->...<!-- @end -->` conditional blocks.
 * Supports multi-line blocks, whole-line single-line blocks, and inline blocks.
 */
export function resolveHarnessConditionalBlocks(
  content: string,
  harnessId?: HarnessId
): string {
  let rendered = content.replace(/\r\n/g, "\n");

  // 1. Multi-line blocks whose opening and closing tags sit on their own lines
  rendered = rendered.replace(
    /^[ \t]*<!--\s*@harness:([a-z0-9_,-]+)\s*-->[ \t]*\n([\s\S]*?)^[ \t]*<!--\s*@end\s*-->[ \t]*(?:\n|$)/gm,
    (_match, tagList: string, body: string) =>
      matchesHarnessTag(tagList, harnessId) ? body : ""
  );

  // 2. Single-line blocks occupying an entire line (preserving optional leading indent and newline)
  rendered = rendered.replace(
    /^([ \t]*)<!--\s*@harness:([a-z0-9_,-]+)\s*-->([^\n]*?)<!--\s*@end\s*-->[ \t]*(\n|$)/gm,
    (_match, indent: string, tagList: string, body: string, eol: string) =>
      matchesHarnessTag(tagList, harnessId) ? `${indent}${body}${eol}` : ""
  );

  // 3. Inline conditional blocks embedded inside a line
  rendered = rendered.replace(
    /<!--\s*@harness:([a-z0-9_,-]+)\s*-->([\s\S]*?)<!--\s*@end\s*-->/g,
    (_match, tagList: string, body: string) =>
      matchesHarnessTag(tagList, harnessId) ? body : ""
  );

  // Collapse any 3+ consecutive newlines caused by stripped blocks
  rendered = rendered.replace(/\n{3,}/g, "\n\n");

  return rendered;
}

/**
 * Substitutes `{{LIGHT_<ROLE>_MODEL}}` placeholders dynamically from `routing.jsonc`
 * using `resolveLightSubagentModel`.
 */
export function substituteLightModelPlaceholders(
  content: string,
  opts?: RenderSkillOptions
): string {
  const targetHarness: HarnessId = opts?.harnessId ?? "antigravity";
  return content.replace(/\{\{LIGHT_([A-Z]+)_MODEL\}\}/g, (_match, rawRole: string) => {
    const role = rawRole.toLowerCase();
    const resolved =
      resolveLightSubagentModel(targetHarness, role, opts?.routingConfig) ??
      resolveLightSubagentModel("antigravity", role, opts?.routingConfig);
    return resolved ?? "flash";
  });
}

/**
 * Pure rendering pipeline for raw skill markdown content.
 */
export function renderSkillTemplate(
  rawContent: string,
  opts?: RenderSkillOptions
): string {
  const versionStamped = rawContent
    .replace(/\r\n/g, "\n")
    .replace(/\bASD v\d+\.\d+(?:\.\d+)?\b/g, `ASD v${ASD_VERSION}`);
  const harnessResolved = resolveHarnessConditionalBlocks(
    versionStamped,
    opts?.harnessId
  );
  return substituteLightModelPlaceholders(harnessResolved, opts);
}

/**
 * Loads and renders a skill template (`src/skills/<canonicalName>/SKILL.md`).
 * Maps `asd-handoff` canonically to `src/skills/handoff/SKILL.md` while rewriting
 * the frontmatter `name` to `asd-handoff`.
 */
export function getSkillTemplate(
  skillName: string,
  opts?: RenderSkillOptions
): string {
  const canonicalName = skillName === "asd-handoff" ? "handoff" : skillName;
  const skillPath = path.join(getAsdRoot(), "src", "skills", canonicalName, "SKILL.md");
  try {
    if (fs.existsSync(skillPath)) {
      const rawContent = fs.readFileSync(skillPath, "utf8");
      let rendered = renderSkillTemplate(rawContent, opts);
      if (skillName === "asd-handoff") {
        rendered = rendered.replace(/^name:\s*handoff$/m, "name: asd-handoff");
      }
      return rendered;
    }
  } catch {
    // Ignore unreadable file
  }
  return `# ASD Skill: ${skillName}\n`;
}
