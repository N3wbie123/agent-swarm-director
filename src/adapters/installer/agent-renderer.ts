/**
 * ASD v2.7.0 Agent & Roster Markdown Renderer (src/adapters/installer/agent-renderer.ts)
 *
 * Generates:
 * 1. Harness-specific `asd-<role>.md` subagent definitions with role-appropriate
 *    tool permissions, synced `routing.jsonc` models/fallbacks, and CLI-only
 *    Protected `.asd/` rules (zero ASD MCP references).
 * 2. Consolidated `AGENTS.md` roster reflecting the 3-track execution model
 *    (`DIRECT`, `LIGHT`, `HEAVY`) and CLI-only `.asd/` protections.
 * 3. Legacy removed-role cleanup helper (`cleanupLegacyAgentFiles`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  normalizeAntigravityModel,
  resolveLightSubagentModel,
} from "../../core/router.ts";
import {
  AGENT_ROLES,
  ASD_VERSION,
  type AgentRole,
  type HarnessId,
  type RoutingConfig,
} from "../../core/types.ts";

function getAsdRoot(): string {
  return path.resolve(import.meta.dirname, "..", "..", "..");
}

/**
 * Resolves the highest-priority model configured for a given AgentRole on a specific HarnessId
 * by walking `[primary, ...fallbacks]` in `routing.jsonc`.
 */
export function resolveHarnessRoleModel(
  role: AgentRole,
  harnessId: HarnessId,
  routingConfig?: RoutingConfig | null
): string | undefined {
  return resolveLightSubagentModel(harnessId, role, routingConfig);
}

export const LEGACY_REMOVED_ROLES = [
  "director",
  "analyst",
  "arbiter",
  "builder",
  "verifier",
] as const;

export function cleanupLegacyAgentFiles(agentDir: string): void {
  for (const legacyRole of LEGACY_REMOVED_ROLES) {
    const legacyPath = path.join(agentDir, `asd-${legacyRole}.md`);
    if (fs.existsSync(legacyPath)) {
      try {
        fs.unlinkSync(legacyPath);
      } catch {
        // Ignore removal error
      }
    }
  }
}

export function getAgentTemplate(
  role: AgentRole,
  model?: string,
  fallbacks?: string[]
): string | null {
  const presetPath = path.join(getAsdRoot(), "presets", "agents", `${role}.md`);
  try {
    if (fs.existsSync(presetPath)) {
      const raw = fs.readFileSync(presetPath, "utf8").replace(/\r\n/g, "\n").trim();
      if (raw.length > 0) {
        let body = raw.replace(/^---\n[\s\S]*?\n---\n+/, "").trim() + "\n";
        if (model) {
          const fbSuffix =
            fallbacks && fallbacks.length > 0
              ? ` | **Fallbacks**: \`${fallbacks.join("` → `")}\``
              : "";
          const modelLine = `**Configured Model**: \`${model}\`${fbSuffix} (synced from \`routing.jsonc\`)`;
          if (body.includes("multi-agent system.")) {
            body = body.replace("multi-agent system.", `multi-agent system.\n${modelLine}`);
          } else {
            body = `${modelLine}\n\n${body}`;
          }
        }
        return body;
      }
    }
  } catch {
    // Fallback to built-in template
  }
  return null;
}

export interface GenerateAgentContentOptions {
  harnessId?: HarnessId;
  model?: string;
  fallbacks?: string[];
  skipPreset?: boolean;
}

export function generateAgentContent(
  role: AgentRole,
  opts?: GenerateAgentContentOptions
): string {
  const roleDescriptions: Record<AgentRole, { title: string; desc: string; focus: string }> = {
    planner: {
      title: "Planner",
      desc: "Task decomposition, requirements analysis, and orchestration architect. Produces structured .asd/PLAN.md specifications.",
      focus: "Turn scheduling, dependency graph resolution, allowedFiles boundaries, DIRECT/LIGHT/HEAVY track selection, and verification criteria.",
    },
    architect: {
      title: "Architect",
      desc: "System designer, escalation solver, and debate arbiter. Defines interfaces, resolves Round 2 conflicts, and handles complex architectural invariants.",
      focus: "Modular boundaries, core purity, definitive arbitration (APPROVE/MINOR_AMEND/REJECT), and architectural elegance.",
    },
    worker: {
      title: "Worker",
      desc: "Core implementation and task executor. Handles feature implementation, scoped file modifications, bug fixes, refactoring, and unit tests.",
      focus: "Idiomatic code, strict allowedFiles compliance, minimal diffs, and rapid test verification.",
    },
    scout: {
      title: "Scout",
      desc: "Read-only codebase explorer and fast inspector. Maps repository layouts, finds symbol declarations, and retrieves existing patterns.",
      focus: "Zero-mutation discovery, reference gathering, and concise context provision.",
    },
    critic: {
      title: "Critic",
      desc: "Hostile adversarial evaluator. Challenges assumptions, cross-examines code evidence, surfaces blind spots, and stress-tests designs.",
      focus: "Security boundaries, failure modes, over-engineering detection, and code-cited anti-pattern identification.",
    },
  };

  const meta = roleDescriptions[role] ?? {
    title: role,
    desc: `ASD agent specialist for role '${role}'.`,
    focus: "Specialized multi-agent execution.",
  };

  const effectiveModel =
    opts?.harnessId === "antigravity"
      ? (() => {
          const norm = normalizeAntigravityModel(
            opts.model ?? resolveLightSubagentModel("antigravity", role)
          );
          if (norm === "inherit") {
            if (role === "scout") return "flash_lite";
            if (role === "architect" || role === "critic") return "pro";
            return "flash";
          }
          return norm;
        })()
      : opts?.model;

  const isReadOnlyRole = role === "scout" || role === "critic";
  const frontmatterLines = [
    `---`,
    `name: asd-${role}`,
    `description: ASD v${ASD_VERSION} ${meta.title} Agent. ${meta.desc}`,
  ];
  if (opts?.harnessId === "opencode") {
    frontmatterLines.push(`mode: subagent`);
    if (isReadOnlyRole) {
      // OpenCode V2 automatically maps write/edit/patch: false to deny permissions.
      frontmatterLines.push(`tools:`);
      frontmatterLines.push(`  write: false`);
      frontmatterLines.push(`  edit: false`);
      frontmatterLines.push(`  patch: false`);
    }
  }
  if (opts?.harnessId === "claude-code" && isReadOnlyRole) {
    frontmatterLines.push(`disallowedTools: Write, Edit, MultiEdit, NotebookEdit`);
  }
  if (effectiveModel) {
    frontmatterLines.push(`model: ${effectiveModel}`);
  }
  if (opts?.harnessId === "antigravity") {
    frontmatterLines.push(`mainAgent: false`);
    frontmatterLines.push(`subagent: true`);
    if (isReadOnlyRole) {
      frontmatterLines.push(`tools: [read_file, search_web]`);
    } else {
      frontmatterLines.push(
        `tools: [read_file, edit_file, write_file, run_command, manage_task, search_web]`
      );
    }
  }
  frontmatterLines.push(`---`);

  const protectedAsdRuleBlock = [
    `## Protected \`.asd/\` Directory & Official CLI-Only Rule`,
    `- **NEVER** directly create, edit, or overwrite any file inside \`.asd/\` (such as \`.asd/PLAN.md\`, \`.asd/core.db\`, \`.asd/sessions/**\`, \`.asd/handoff.md\`) using file-editing tools (\`edit_file\`, \`write_file\`, \`Edit\`, \`Write\`, or shell redirection \`>\` / \`>>\`). The \`.asd/\` directory is strictly protected by the \`PreToolUse\` security hook.`,
    `- For ANY ASD state or \`.asd/\` operation, **ALWAYS** use the official \`asd\` CLI commands (\`asd plan create|update|sync_from_md|get\`, \`asd dispatch\`, \`asd verify\`, \`asd debate\`, \`asd handoff\`, \`asd status\`, \`asd clean\`).`,
    `- If an operation on \`.asd/\` has **no corresponding official \`asd\` CLI command**, **IMMEDIATELY HALT** execution and explain the situation to the user rather than attempting direct file manipulation or workarounds.`,
  ].join("\n");

  const presetBody = opts?.skipPreset
    ? null
    : getAgentTemplate(role, effectiveModel, opts?.fallbacks);
  if (presetBody) {
    const bodyWithRule = presetBody.includes("Protected `.asd/` Directory")
      ? presetBody
      : `${presetBody.trimEnd()}\n\n${protectedAsdRuleBlock}\n`;
    return `${frontmatterLines.join("\n")}\n\n${bodyWithRule}`;
  }

  const fbSuffix =
    opts?.fallbacks && opts.fallbacks.length > 0
      ? ` | **Fallbacks**: \`${opts.fallbacks.join("` → `")}\``
      : "";

  const operationalGuidelines = isReadOnlyRole
    ? [
        `1. Adhere strictly to assigned read-only role boundaries without creating, editing, or deleting files.`,
        `2. Ground every finding in concrete code evidence (\`file:line\`) with zero unverified assumptions.`,
      ]
    : role === "planner"
      ? [
          `1. Adhere strictly to planning boundaries—author and update plans via official \`asd plan\` CLI commands without editing implementation code.`,
          `2. Ground every task breakdown, \`targetFiles\` boundary, and \`DIRECT\`/\`LIGHT\`/\`HEAVY\` track recommendation in actual repository evidence with zero unverified assumptions.`,
        ]
      : role === "architect"
        ? [
            `1. Adhere strictly to assigned role boundaries and specified allowedFiles.`,
            `2. Maintain high architectural integrity, idiomatic patterns, and zero unverified assumptions.`,
            `3. Run automated tests to verify changes only when modifying code; skip test execution during pure design or Round 2 debate arbitration.`,
          ]
        : [
            `1. Adhere strictly to assigned role boundaries and specified allowedFiles.`,
            `2. Maintain high code quality, idiomatic patterns, and zero unverified assumptions.`,
            `3. Ensure all changes are verified with automated tests before completing.`,
          ];

  return `${frontmatterLines.join("\n")}

# ASD Agent: asd-${role} (${meta.title})

You are operating as the **${meta.title}** agent in the ASD v${ASD_VERSION} multi-agent system.${
    effectiveModel ? `\n**Configured Model**: \`${effectiveModel}\`${fbSuffix} (synced from \`routing.jsonc\`)` : ""
  }

## Responsibilities
${meta.desc}

## Primary Focus
${meta.focus}

## Operational Guidelines
${operationalGuidelines.join("\n")}

${protectedAsdRuleBlock}
`;
}

export function generateAllAgentsMarkdown(
  routingConfig?: RoutingConfig | null,
  harnessId?: HarnessId
): string {
  let md = `# ASD Multi-Agent Roster (v${ASD_VERSION})

This document defines the 5 standard specialist agent roles in ASD v${ASD_VERSION} and the delegation rules for \`DIRECT\`, \`LIGHT\`, and \`HEAVY\` execution tracks.

## Execution Tracks & Subagent Delegation Rules

1. **\`DIRECT\` Track (Main-Session Direct Execution)**:
   - Best for localized 1–3 file sequential changes executed directly by the main session with zero subagent spawn overhead (optional \`asd-scout\` for broad read-only search).
   - Gate changes via \`asd verify\`.

2. **\`LIGHT\` Track (Single-Harness Internal Subagent Delegation)**:
   - **NEVER** spawn external CLI processes via \`asd dispatch --mode parallel_spawn\`, \`asd debate\`, or raw \`opencode run\` / \`claude -p\` / \`codex exec\` / \`agy\` / \`cursor-agent\` commands.
   - Delegate work to the current harness's native internal subagents (\`asd-<role>\`) on synced \`routing.jsonc\` models, enforcing sequential execution or strictly disjoint \`targetFiles\` across concurrent \`worker\` tasks:
     - **OpenCode**: Use the \`task\` tool with \`subagent_type: "asd-<role>"\` (each \`asd-<role>\` agent in \`~/.config/opencode/agent/asd-<role>.md\` is pre-configured with the highest-priority OpenCode model from \`routing.jsonc\`).
     - **Claude Code**: Use the \`Agent\` / \`Task\` tool with \`subagent_type: "asd-<role>"\`.
     - **Antigravity**: Use the \`invoke_subagent\` tool with explicit synced \`Model\` tiers (never \`"inherit"\`).
     - **Codex / Cursor**: Delegate to native \`asd-<role>\` subagents on synced \`routing.jsonc\` models.
   - Use \`asd\` CLI only for local state/verification bookkeeping: \`asd plan\`, \`asd dispatch --turn <N> --mode claim_only\`, and \`asd verify --task <ID>\`.

3. **\`HEAVY\` Track (Multi-Harness External CLI & Worktree Execution)**:
   - Used only after explicit user confirmation when true cross-harness CLI diversity (\`asd debate\`) or parallel Git worktree isolation (\`asd dispatch --turn <N> --mode parallel_spawn\`) is required.

4. **Protected \`.asd/\` Directory & Official CLI-Only Rule**:
   - **NEVER** directly create, edit, or overwrite any file inside \`.asd/\` (such as \`.asd/PLAN.md\`, \`.asd/core.db\`, \`.asd/sessions/**\`, \`.asd/handoff.md\`) using file-editing tools (\`edit_file\`, \`write_file\`, \`Edit\`, \`Write\`, or shell redirection \`>\` / \`>>\`). The \`.asd/\` directory is strictly protected by the \`PreToolUse\` security hook.
   - For ANY ASD state or \`.asd/\` operation, **ALWAYS** use the official \`asd\` CLI commands (\`asd plan create|update|sync_from_md|get\`, \`asd dispatch\`, \`asd verify\`, \`asd debate\`, \`asd handoff\`, \`asd status\`, \`asd clean\`).
   - If an operation on \`.asd/\` has **no corresponding official \`asd\` CLI command**, **IMMEDIATELY HALT** execution and explain the situation to the user rather than attempting direct file manipulation or workarounds.

---

`;

  for (let i = 0; i < AGENT_ROLES.length; i++) {
    const role = AGENT_ROLES[i]!;
    const model = harnessId ? resolveHarnessRoleModel(role, harnessId, routingConfig) : undefined;
    md += `## ${i + 1}. asd-${role}\n`;
    md += generateAgentContent(role, { harnessId, model });
    md += `\n---\n\n`;
  }

  return md;
}
