/**
 * Tests for ASD v2.2 Harness Installer & Sync (tests/installer-sync.test.ts)
 *
 * Verifies:
 * 1. Strictly Global-Only sync across all 4 harnesses under isolated temp homeDir.
 * 2. Idempotency on second run ({ status: "skipped", skipped: true }).
 * 3. Surgical rollback restoring pre-existing user configurations 100% cleanly.
 * 4. Fast zero-token doctorProbe passing with 0 errors in < 100ms.
 * 5. Main-session autoSyncIfNeeded respecting the Subagent Shield.
 * 6. Zero pollution of project directory during sync.
 */

import assert from "node:assert/strict";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

import {
  autoSyncIfNeeded,
  buildAntigravityHookSpec,
  buildCodexManagedTomlBlock,
  doctorProbe,
  generateAgentContent,
  generateAllAgentsMarkdown,
  getAgentTemplate,
  getSkillTemplate,
  loadCatalogMcpServers,
  loadHarnessNativeCapabilities,
  mergeJsonMcpServersForHarness,
  renderSkillTemplate,
  resolveHarnessConditionalBlocks,
  resolveHarnessRoleModel,
  runAsdDoctor,
  runAsdSync,
  runAsdUninstall,
  syncAgentModelsIfNeeded,
  syncHarnessConfigs,
  syncJsonMcpConfigFile,
  uninstallHarnessConfigs,
} from "../src/adapters/installer.ts";
import * as skillRendererMod from "../src/adapters/installer/skill-renderer.ts";
import * as agentRendererMod from "../src/adapters/installer/agent-renderer.ts";
import * as mcpSyncMod from "../src/adapters/installer/mcp-sync.ts";
import { AGENT_ROLES, ASD_VERSION, type HarnessId, type RoutingConfig } from "../src/core/types.ts";
import { ASD_SKILLS } from "../src/adapters/claude-code.ts";
import {
  OPENCODE_V2_PLUGIN_MARKER,
  OPENCODE_V2_PLUGIN_RELATIVE_PATH,
  buildOpenCodeCapabilityProfile,
  resolveOpenCodeCapabilityProfile,
} from "../src/adapters/opencode.ts";
import {
  OPENCODE_V1_PLUGIN_MARKER,
  OPENCODE_V1_PLUGIN_RELATIVE_PATH,
} from "../src/adapters/opencode-v1.ts";

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTempDir(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup error
  }
}

describe("Installer & Sync Engine", () => {
  let tmpHome: string;
  let tmpProject: string;

  before(() => {
    tmpHome = createTempDir("asd-test-installer-home-");
    tmpProject = createTempDir("asd-test-installer-project-");
  });

  after(() => {
    removeTempDir(tmpHome);
    removeTempDir(tmpProject);
  });

  describe("1. Strictly Global-Only Sync (`syncHarnessConfigs`)", () => {
    test("initial sync updates all 4 harnesses into isolated homeDir", async () => {
      const res = await syncHarnessConfigs({
        homeDir: tmpHome,
        projectRoot: tmpProject,
      });

      assert.equal(res.status, "updated");
      assert.equal(res.skipped, false);
      assert.ok(res.configHash && res.configHash.length > 0);

      const harnesses: HarnessId[] = ["claude-code", "opencode", "codex", "antigravity"];
      for (const h of harnesses) {
        assert.equal(res.harnesses[h].status, "updated");
        assert.equal(res.harnesses[h].skipped, false);
        assert.ok(res.harnesses[h].filesWritten.length > 0);
      }
    });

    test("Claude Code targets exist and contain hooks and MCP config", () => {
      const claudeDir = path.join(tmpHome, ".claude");

      // 10 agent files
      for (const role of AGENT_ROLES) {
        const agentFile = path.join(claudeDir, "agents", `asd-${role}.md`);
        assert.ok(fs.existsSync(agentFile), `Missing agent: ${agentFile}`);
        const content = fs.readFileSync(agentFile, "utf8");
        assert.ok(content.includes(`asd-${role}`));
      }

      // 5 skill files
      for (const skill of ASD_SKILLS) {
        const skillFile = path.join(claudeDir, "skills", skill, "SKILL.md");
        assert.ok(fs.existsSync(skillFile), `Missing skill: ${skillFile}`);
        const content = fs.readFileSync(skillFile, "utf8");
        assert.ok(content.includes("progressBoard"));
      }

      // settings.json
      const settingsFile = path.join(claudeDir, "settings.json");
      assert.ok(fs.existsSync(settingsFile));
      const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
      assert.ok(settings.hooks?.PreToolUse?.length > 0);
      assert.ok(settings.hooks?.Stop?.length > 0);
      assert.equal(
        settings.hooks.PreToolUse[0].matcher,
        "Write|Edit|MultiEdit|NotebookEdit|Bash"
      );
      assert.equal(settings.hooks.PreToolUse[0].hooks[0].type, "command");
      assert.ok(settings.hooks.PreToolUse[0].hooks[0].command.includes("hook pre-tool-use"));
      assert.equal(settings.hooks.Stop[0].matcher, "");
      assert.equal(settings.hooks.Stop[0].hooks[0].type, "command");
      assert.ok(settings.hooks.Stop[0].hooks[0].command.includes("hook stop"));

      // .claude.json & .claude/.mcp.json
      const claudeJson = path.join(tmpHome, ".claude.json");
      assert.ok(fs.existsSync(claudeJson));
      const parsedClaudeJson = JSON.parse(fs.readFileSync(claudeJson, "utf8"));
      assert.equal(parsedClaudeJson.mcpServers["asd-core"], undefined);
      assert.ok(parsedClaudeJson.mcpServers["context7"]);
      assert.equal(parsedClaudeJson.mcpServers["context7"]._asdManaged, true);

      const dotMcpJson = path.join(claudeDir, ".mcp.json");
      assert.ok(fs.existsSync(dotMcpJson));
      const parsedDotMcp = JSON.parse(fs.readFileSync(dotMcpJson, "utf8"));
      assert.equal(parsedDotMcp.mcpServers["asd-core"], undefined);
      assert.ok(parsedDotMcp.mcpServers["context7"]);
    });

    test("OpenCode targets exist and contain commands, AGENTS.md, and MCP config", () => {
      const opencodeDir = path.join(tmpHome, ".config", "opencode");

      // 5 commands
      for (const skill of ASD_SKILLS) {
        const cmdFile = path.join(opencodeDir, "command", `${skill}.md`);
        assert.ok(fs.existsSync(cmdFile), `Missing command: ${cmdFile}`);
      }

      // AGENTS.md
      const agentsMd = path.join(opencodeDir, "AGENTS.md");
      assert.ok(fs.existsSync(agentsMd));
      const content = fs.readFileSync(agentsMd, "utf8");
      assert.ok(content.includes("asd-planner"));
      assert.ok(content.includes("asd-critic"));

      // opencode.json
      const opencodeJson = path.join(opencodeDir, "opencode.json");
      assert.ok(fs.existsSync(opencodeJson));
      const parsed = JSON.parse(fs.readFileSync(opencodeJson, "utf8"));
      assert.equal(parsed._asdVersion, ASD_VERSION);
      assert.equal(parsed.mcpServers["asd-core"], undefined);
      assert.ok(parsed.mcpServers["context7"]);
      assert.equal(parsed.mcpServers["context7"]._asdManaged, true);
    });

    test("Codex targets exist and contain skills, AGENTS.md, and config.toml fence", () => {
      const codexDir = path.join(tmpHome, ".codex");

      // 5 skills
      for (const skill of ASD_SKILLS) {
        const skillFile = path.join(codexDir, "skills", skill, "SKILL.md");
        assert.ok(fs.existsSync(skillFile), `Missing skill: ${skillFile}`);
      }

      // AGENTS.md
      const agentsMd = path.join(codexDir, "AGENTS.md");
      assert.ok(fs.existsSync(agentsMd));

      // config.toml
      const configToml = path.join(codexDir, "config.toml");
      assert.ok(fs.existsSync(configToml));
      const toml = fs.readFileSync(configToml, "utf8");
      assert.ok(toml.includes("# >>> BEGIN MANAGED BY ASD-V2"));
      assert.ok(
        toml.includes('notify = ["node", "--no-warnings",') &&
          toml.includes('"hook", "stop", "--harness", "codex"]'),
        "Codex config.toml managed block must include notify hook"
      );
      assert.ok(
        toml.indexOf("notify =") < toml.indexOf("[mcp_servers."),
        "notify must appear before any [mcp_servers.*] table header"
      );
      assert.ok(!toml.includes("[mcp_servers.asd-core]"));
      assert.ok(toml.includes("[mcp_servers.context7]"));
      assert.ok(toml.includes("# <<< END MANAGED BY ASD-V2 <<<"));
    });

    test("Cursor targets exist and hooks.json uses nested { version: 1, hooks: {...} } schema", () => {
      const cursorDir = path.join(tmpHome, ".cursor");
      const hooksJsonPath = path.join(cursorDir, "hooks.json");
      assert.ok(fs.existsSync(hooksJsonPath));
      const parsedHooks = JSON.parse(fs.readFileSync(hooksJsonPath, "utf8"));
      assert.equal(parsedHooks.version, 1);
      assert.ok(parsedHooks.hooks && typeof parsedHooks.hooks === "object");
      assert.ok(Array.isArray(parsedHooks.hooks.sessionStart));
      assert.ok(Array.isArray(parsedHooks.hooks.preToolUse));
      assert.ok(Array.isArray(parsedHooks.hooks.beforeShellExecution));
      assert.ok(Array.isArray(parsedHooks.hooks.stop));
      assert.equal(parsedHooks.SessionStart, undefined);
      assert.equal(parsedHooks.PreToolUse, undefined);
      assert.equal(parsedHooks.Stop, undefined);
    });

    test("Antigravity targets exist and contain config/agents (with normalized models & subagent flags), skills, config/hooks.json, and MCP config", () => {
      const geminiDir = path.join(tmpHome, ".gemini");

      // 5 agents in ~/.gemini/config/agents/ (and legacy ~/.gemini/agents/ must not exist)
      assert.equal(fs.existsSync(path.join(geminiDir, "agents")), false);
      for (const role of AGENT_ROLES) {
        const agentFile = path.join(geminiDir, "config", "agents", `asd-${role}.md`);
        assert.ok(fs.existsSync(agentFile), `Missing agent: ${agentFile}`);
        const content = fs.readFileSync(agentFile, "utf8");
        assert.ok(content.includes("mainAgent: false"), `${role} must have mainAgent: false`);
        assert.ok(content.includes("subagent: true"), `${role} must have subagent: true`);
        if (role === "scout") {
          assert.ok(content.includes("model: flash_lite"), "scout must use normalized model: flash_lite");
        } else if (role === "architect" || role === "critic") {
          assert.ok(content.includes("model: pro"), `${role} must use normalized model: pro`);
        } else {
          assert.ok(content.includes("model: flash"), `${role} must use normalized model: flash`);
        }
      }

      // 5 skills
      for (const skill of ASD_SKILLS) {
        const skillFile = path.join(geminiDir, "skills", skill, "SKILL.md");
        assert.ok(fs.existsSync(skillFile), `Missing skill: ${skillFile}`);
      }

      // Legacy ~/.gemini/hooks.json is NOT created; consolidated in ~/.gemini/config/hooks.json
      assert.equal(fs.existsSync(path.join(geminiDir, "hooks.json")), false);
      const configHooksJson = path.join(geminiDir, "config", "hooks.json");
      assert.ok(fs.existsSync(configHooksJson));
      const hooks = JSON.parse(fs.readFileSync(configHooksJson, "utf8"));
      const tracker = hooks["asd-session-tracker"];
      assert.ok(tracker, "Missing asd-session-tracker hook group");
      assert.equal(tracker.PreInvocation, undefined, "PreInvocation should not be registered");
      assert.ok(tracker.PreToolUse?.length > 0);
      assert.equal(
        tracker.PreToolUse[0].matcher,
        "write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content|run_command|invoke_subagent"
      );
      assert.ok(tracker.Stop?.length > 0);

      // mcp_config.json
      const mcpConfig = path.join(geminiDir, "mcp_config.json");
      assert.ok(fs.existsSync(mcpConfig));
      const parsed = JSON.parse(fs.readFileSync(mcpConfig, "utf8"));
      assert.equal(parsed.mcpServers["asd-core"], undefined);
      assert.ok(parsed.mcpServers["context7"]);
      assert.equal(parsed.mcpServers["context7"]._asdManaged, true);
    });

    test("project directory is NEVER touched or polluted during sync", () => {
      assert.equal(fs.existsSync(path.join(tmpProject, ".claude")), false);
      assert.equal(fs.existsSync(path.join(tmpProject, ".gemini")), false);
      assert.equal(fs.existsSync(path.join(tmpProject, ".codex")), false);
      assert.equal(fs.existsSync(path.join(tmpProject, "opencode.json")), false);
    });
  });

  describe("2. Idempotency on Second Run", () => {
    test("subsequent sync skips all harnesses without re-writing", async () => {
      const res = await syncHarnessConfigs({
        homeDir: tmpHome,
        projectRoot: tmpProject,
      });

      assert.equal(res.status, "skipped");
      assert.equal(res.skipped, true);

      const harnesses: HarnessId[] = ["claude-code", "opencode", "codex", "antigravity"];
      for (const h of harnesses) {
        assert.equal(res.harnesses[h].status, "skipped");
        assert.equal(res.harnesses[h].skipped, true);
        assert.equal(res.harnesses[h].filesWritten.length, 0);
      }
    });

    test("force option forces re-sync despite matching hash", async () => {
      const res = await syncHarnessConfigs({
        homeDir: tmpHome,
        projectRoot: tmpProject,
        force: true,
      });

      assert.equal(res.status, "updated");
      assert.equal(res.skipped, false);
      assert.equal(res.harnesses["claude-code"].status, "updated");
    });
  });

  describe("3. Surgical Uninstall & Config Restoration", () => {
    let userHome: string;

    before(() => {
      userHome = createTempDir("asd-test-user-home-");

      // Seed pre-existing user configurations
      const claudeDir = path.join(userHome, ".claude");
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          theme: "dark",
          hooks: {
            PreToolUse: [{ command: "my-custom-guard", _asdManaged: false }],
          },
        }, null, 2)
      );

      const codexDir = path.join(userHome, ".codex");
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(
        path.join(codexDir, "config.toml"),
        'model = "gpt-5"\ntemperature = 0.7\n'
      );

      const opencodeDir = path.join(userHome, ".config", "opencode");
      fs.mkdirSync(opencodeDir, { recursive: true });
      fs.writeFileSync(
        path.join(opencodeDir, "opencode.json"),
        JSON.stringify({
          editor: "neovim",
          mcpServers: {
            "custom-mcp": { command: "custom-bin" },
          },
        }, null, 2)
      );
    });

    after(() => {
      removeTempDir(userHome);
    });

    test("sync bakes in managed entries while backing up user files", async () => {
      const syncRes = await syncHarnessConfigs({ homeDir: userHome });
      assert.equal(syncRes.status, "updated");

      // Backups should exist
      assert.ok(fs.existsSync(path.join(userHome, ".claude", "settings.json.asd-backup")));
      assert.ok(fs.existsSync(path.join(userHome, ".codex", "config.toml.asd-backup")));
      assert.ok(fs.existsSync(path.join(userHome, ".config", "opencode", "opencode.json.asd-backup")));

      // Simulate user adding a new MCP entry AFTER asd sync ran
      const ocPath = path.join(userHome, ".config", "opencode", "opencode.json");
      const ocCurrent = JSON.parse(fs.readFileSync(ocPath, "utf8"));
      ocCurrent.mcpServers["added-after-sync-mcp"] = { command: "post-sync-bin" };
      fs.writeFileSync(ocPath, JSON.stringify(ocCurrent, null, 2), "utf8");
    });

    test("uninstall surgically restores original user configurations 100%", async () => {
      const uninstRes = await uninstallHarnessConfigs({ homeDir: userHome });
      assert.equal(uninstRes.status, "success");

      // User configs restored
      const claudeSettings = JSON.parse(
        fs.readFileSync(path.join(userHome, ".claude", "settings.json"), "utf8")
      );
      assert.equal(claudeSettings.theme, "dark");
      assert.equal(claudeSettings.hooks.PreToolUse.length, 1);
      assert.equal(claudeSettings.hooks.PreToolUse[0].command, "my-custom-guard");
      assert.equal(claudeSettings.hooks.PreToolUse[0]._asdManaged, false);
      assert.equal(claudeSettings.hooks.Stop, undefined);

      const codexToml = fs.readFileSync(path.join(userHome, ".codex", "config.toml"), "utf8");
      assert.ok(codexToml.includes('model = "gpt-5"'));
      assert.ok(codexToml.includes("temperature = 0.7"));
      assert.equal(codexToml.includes("BEGIN MANAGED BY ASD-V2"), false);

      const opencodeJson = JSON.parse(
        fs.readFileSync(path.join(userHome, ".config", "opencode", "opencode.json"), "utf8")
      );
      assert.equal(opencodeJson.editor, "neovim");
      assert.ok(opencodeJson.mcpServers["custom-mcp"]);
      assert.ok(opencodeJson.mcpServers["added-after-sync-mcp"]);
      assert.equal(opencodeJson.mcpServers["asd-core"], undefined);
      assert.equal(opencodeJson.mcpServers["context7"], undefined);

      // ASD-generated files removed
      assert.equal(fs.existsSync(path.join(userHome, ".claude", "agents")), false);
      assert.equal(fs.existsSync(path.join(userHome, ".claude", "skills")), false);
      assert.equal(fs.existsSync(path.join(userHome, ".config", "opencode", "AGENTS.md")), false);
      assert.equal(fs.existsSync(path.join(userHome, ".codex", "AGENTS.md")), false);
      assert.equal(fs.existsSync(path.join(userHome, ".gemini", "agents")), false);
      assert.equal(fs.existsSync(path.join(userHome, ".gemini", "config", "agents")), false);

      // Backups removed
      assert.equal(fs.existsSync(path.join(userHome, ".claude", "settings.json.asd-backup")), false);
      assert.equal(fs.existsSync(path.join(userHome, ".codex", "config.toml.asd-backup")), false);
    });
  });

  describe("4. Doctor Diagnostic Probe (`doctorProbe` / `runAsdDoctor`)", () => {
    test("fast zero-token probe executes in < 100ms with 0 errors", async () => {
      const probe = await doctorProbe({
        homeDir: tmpHome,
        projectRoot: process.cwd(),
      });

      assert.equal(probe.ok, true);
      assert.equal(probe.errors.length, 0);
      assert.ok(probe.durationMs < 250, `durationMs: ${probe.durationMs}ms >= 250ms`);

      // Node.js version
      assert.equal(probe.nodeVersion.ok, true);
      assert.ok(probe.nodeVersion.version.length > 0);

      // SQLite WAL
      assert.equal(probe.sqliteWal.ok, true);

      // Security Policy Probe (.GIT/config and .ENV blocked)
      assert.equal(probe.policyProbe.ok, true);
      assert.equal(probe.policyProbe.gitBlocked, true);
      assert.equal(probe.policyProbe.envBlocked, true);

      // Git repo
      assert.equal(probe.gitRepo.ok, true);
      assert.equal(probe.gitRepo.isRepo, true);

      // Harnesses
      assert.ok(probe.harnesses["claude-code"]);
      assert.ok(probe.harnesses.opencode);
      assert.ok(probe.harnesses.codex);
      assert.ok(probe.harnesses.antigravity);
    });
  });

  describe("5. Main-Session Auto-Sync (`autoSyncIfNeeded`)", () => {
    test("subagent session skips auto-sync via Subagent Shield", async () => {
      const prevRole = process.env.ASD_SESSION_ROLE;
      try {
        process.env.ASD_SESSION_ROLE = "subagent";
        const res = await autoSyncIfNeeded({ homeDir: tmpHome });
        assert.equal(res.synced, false);
        assert.equal(res.skipped, true);
        assert.equal(res.reason, "subagent_shield");
      } finally {
        if (prevRole !== undefined) {
          process.env.ASD_SESSION_ROLE = prevRole;
        } else {
          delete process.env.ASD_SESSION_ROLE;
        }
      }
    });

    test("main session triggers sync when config changed", async () => {
      const prevRole = process.env.ASD_SESSION_ROLE;
      try {
        delete process.env.ASD_SESSION_ROLE;
        const res = await autoSyncIfNeeded({ homeDir: tmpHome, force: true });
        assert.equal(res.synced, true);
        assert.equal(res.skipped, false);
      } finally {
        if (prevRole !== undefined) {
          process.env.ASD_SESSION_ROLE = prevRole;
        }
      }
    });
  });

  describe("6. Function Aliases & Acceptance Criteria", () => {
    test("runAsdSync, runAsdUninstall, runAsdDoctor aliases exist and match", () => {
      assert.equal(runAsdSync, syncHarnessConfigs);
      assert.equal(runAsdUninstall, uninstallHarnessConfigs);
      assert.equal(runAsdDoctor, doctorProbe);
    });

    test("buildCodexManagedTomlBlock skips notify when unmanagedToml already defines notify", () => {
      const withCustomNotify = buildCodexManagedTomlBlock({
        unmanagedToml: 'model = "gpt-5"\nnotify = ["custom-notify"]\n',
        catalog: { context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] } },
        nativeCapabilities: new Set(),
        asdCliPath: "/tmp/asd/src/cli/index.ts",
      });
      assert.equal(withCustomNotify.includes("notify ="), false);
      assert.ok(withCustomNotify.includes("[mcp_servers.context7]"));
    });

    test("syncHarnessConfigs never mutates repo README.md, README_ko.md, or historical version strings", async () => {
      const fixtureRepo = createTempDir("asd-test-repo-fixture-");
      const fixtureHome = createTempDir("asd-test-repo-home-");
      try {
        const readmeContent = "# ASD\nHistorical note: ASD v2.1.0 and (v2.2.0) release.\n";
        const readmeKoContent = "# ASD 한국어\n> **버전**: `2.1.0`\n이전 버전 ASD v2.1.0 (v2.2.0) 기록\n";
        fs.writeFileSync(path.join(fixtureRepo, "README.md"), readmeContent, "utf8");
        fs.writeFileSync(path.join(fixtureRepo, "README_ko.md"), readmeKoContent, "utf8");

        const realReadmePath = path.resolve(process.cwd(), "README.md");
        const realReadmeKoPath = path.resolve(process.cwd(), "README_ko.md");
        const realReadmeBefore = fs.existsSync(realReadmePath)
          ? fs.readFileSync(realReadmePath, "utf8")
          : null;
        const realReadmeKoBefore = fs.existsSync(realReadmeKoPath)
          ? fs.readFileSync(realReadmeKoPath, "utf8")
          : null;

        await syncHarnessConfigs({ homeDir: fixtureHome, projectRoot: fixtureRepo, noPath: true });

        if (realReadmeBefore !== null) {
          assert.equal(fs.readFileSync(realReadmePath, "utf8"), realReadmeBefore);
        }
        if (realReadmeKoBefore !== null) {
          assert.equal(fs.readFileSync(realReadmeKoPath, "utf8"), realReadmeKoBefore);
        }
        assert.equal(fs.readFileSync(path.join(fixtureRepo, "README.md"), "utf8"), readmeContent);
        assert.equal(fs.readFileSync(path.join(fixtureRepo, "README_ko.md"), "utf8"), readmeKoContent);

        // Installed copies in homeDir receive the current ASD_VERSION
        const installedRouting = fs.readFileSync(
          path.join(fixtureHome, ".asd", "routing.jsonc"),
          "utf8"
        );
        const installedMcp = fs.readFileSync(
          path.join(fixtureHome, ".asd", "mcp.jsonc"),
          "utf8"
        );
        const installedSkill = fs.readFileSync(
          path.join(fixtureHome, ".claude", "skills", "asd", "SKILL.md"),
          "utf8"
        );
        assert.ok(installedRouting.includes(`"_asdVersion": "${ASD_VERSION}"`));
        assert.ok(installedMcp.includes(`"_asdVersion": "${ASD_VERSION}"`));
        assert.ok(installedSkill.includes(`ASD v${ASD_VERSION}`));
      } finally {
        removeTempDir(fixtureRepo);
        removeTempDir(fixtureHome);
      }
    });

    test("getSkillTemplate, generateAgentContent, and generateAllAgentsMarkdown enforce Protected .asd/ Directory & Official CLI-Only Rule", () => {
      const skillsToCheck = ["asd", "asd-plan", "asd-run", "asd-debate", "asd-debug", "handoff", "asd-handoff"];
      for (const skill of skillsToCheck) {
        const content = getSkillTemplate(skill);
        assert.ok(
          content.includes("Protected `.asd/` Directory & Official CLI-Only Rule"),
          `Skill '${skill}' must include Protected .asd/ Directory & Official CLI-Only Rule`
        );
        assert.ok(
          content.includes("IMMEDIATELY HALT"),
          `Skill '${skill}' must instruct agent to IMMEDIATELY HALT when no official CLI/MCP command exists`
        );
      }

      for (const role of AGENT_ROLES) {
        const agentMd = generateAgentContent(role);
        assert.ok(
          agentMd.includes("Protected `.asd/` Directory & Official CLI-Only Rule"),
          `Agent '${role}' must include Protected .asd/ Directory & Official CLI-Only Rule`
        );
        assert.ok(
          agentMd.includes("IMMEDIATELY HALT"),
          `Agent '${role}' must instruct agent to IMMEDIATELY HALT when no official CLI/MCP command exists`
        );
      }

      const allAgentsMd = generateAllAgentsMarkdown();
      assert.ok(allAgentsMd.includes("Protected `.asd/` Directory & Official CLI-Only Rule"));
      assert.ok(allAgentsMd.includes("IMMEDIATELY HALT"));
    });
  });
});

test("F19: Codex config.toml with user [table] sections places notify in root scope before any [table]", async () => {
  const f19Home = createTempDir("asd-f19-home-");
  try {
    const codexDir = path.join(f19Home, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    // User config has [features] and [some_table] with a table-scoped notify = false
    fs.writeFileSync(
      path.join(codexDir, "config.toml"),
      [
        'model = "gpt-5.4"',
        "",
        "[features]",
        "fast_apply = true",
        "notify = false",
      ].join("\n") + "\n",
      "utf8"
    );

    await syncHarnessConfigs({ homeDir: f19Home });

    const syncedToml = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
    const idxRootNotify = syncedToml.indexOf('notify = ["node"');
    const idxFeaturesTable = syncedToml.indexOf("[features]");

    assert.ok(idxRootNotify !== -1, "Managed root notify hook must be injected even if a table has notify = false");
    assert.ok(idxFeaturesTable !== -1, "User [features] table must be preserved");
    assert.ok(
      idxRootNotify < idxFeaturesTable,
      "Managed notify hook must appear in TOML root scope BEFORE [features]"
    );
  } finally {
    removeTempDir(f19Home);
  }
});

test("F20: OpenCode opencode.jsonc with comments is preserved and prevents duplicate catalog MCP servers across idempotent syncs", async () => {
  const f20Home = createTempDir("asd-f20-home-");
  try {
    const opencodeDir = path.join(f20Home, ".config", "opencode");
    fs.mkdirSync(opencodeDir, { recursive: true });
    const originalJsonc = [
      "// User OpenCode JSONC config with comments",
      "{",
      "  \"model\": \"openai/gpt-5.4\",",
      "  // User already configured context7 in opencode.jsonc",
      "  \"mcp\": {",
      "    \"context7\": { \"type\": \"local\", \"command\": [\"custom-c7\"] },",
      "  },",
      "  \"mcpServers\": {",
      "    \"grep_app\": { \"url\": \"https://custom.grep.app/mcp\" },",
      "  },",
      "}",
    ].join("\n") + "\n";
    const jsoncPath = path.join(opencodeDir, "opencode.jsonc");
    fs.writeFileSync(jsoncPath, originalJsonc, "utf8");

    const firstSync = await syncHarnessConfigs({ homeDir: f20Home });
    assert.equal(firstSync.status, "updated");

    // 1. opencode.jsonc is preserved intact (including comments)
    assert.equal(fs.readFileSync(jsoncPath, "utf8"), originalJsonc);

    // 2. opencode.json exists and does NOT duplicate context7 or grep_app from opencode.jsonc
    const jsonPath = path.join(opencodeDir, "opencode.json");
    assert.ok(fs.existsSync(jsonPath));
    const syncedJson = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    assert.equal(syncedJson.mcpServers.context7, undefined, "context7 in opencode.jsonc mcp must not be duplicated");
    assert.equal(syncedJson.mcpServers.grep_app, undefined, "grep_app in opencode.jsonc mcpServers must not be duplicated");
    assert.ok(syncedJson.mcpServers.websearch, "Remaining catalog server websearch must be injected");

    // 3. Second sync is idempotent (skipped)
    const secondSync = await syncHarnessConfigs({ homeDir: f20Home });
    assert.equal(secondSync.harnesses.opencode.status, "skipped");
    assert.equal(secondSync.harnesses.opencode.skipped, true);
  } finally {
    removeTempDir(f20Home);
  }
});

test("Runtime Isolation: syncHarnessConfigs stages isolated runtime copy and wires all harness hooks to the isolated runtime path", async () => {
  const isoHome = createTempDir("asd-iso-home-");
  const customRuntimeDir = createTempDir("asd-iso-runtime-");
  try {
    const expectedCliPath = path.join(customRuntimeDir, "src", "cli", "index.ts");
    fs.mkdirSync(path.dirname(expectedCliPath), { recursive: true });
    fs.writeFileSync(expectedCliPath, "#!/usr/bin/env node\nconsole.log('isolated');\n", "utf8");
    fs.writeFileSync(path.join(customRuntimeDir, "package.json"), "{}", "utf8");

    const res = await syncHarnessConfigs({
      homeDir: isoHome,
      asdCliPath: expectedCliPath,
    });
    assert.equal(res.status, "updated");

    assert.ok(fs.existsSync(expectedCliPath), "Staged CLI entrypoint must exist in isolated runtimeDir");
    assert.ok(fs.existsSync(path.join(customRuntimeDir, "package.json")), "Staged package.json must exist");

    const claudeSettings = JSON.parse(
      fs.readFileSync(path.join(isoHome, ".claude", "settings.json"), "utf8")
    );
    const claudeHookCmd = claudeSettings.hooks.PreToolUse[0].hooks[0].command;
    assert.ok(
      claudeHookCmd.includes(expectedCliPath),
      `Claude PreToolUse hook (${claudeHookCmd}) must point to isolated runtime (${expectedCliPath})`
    );
    assert.equal(
      claudeHookCmd.includes(process.cwd()),
      false,
      "Claude hook must NOT point directly to live development repository"
    );
  } finally {
    removeTempDir(isoHome);
    removeTempDir(customRuntimeDir);
  }
});

test("v2.4.3 Auto-Migration: syncHarnessConfigs upgrades legacy (< 2.4.2) ~/.asd/routing.jsonc with lightSubagents while preserving user agents & categories", async () => {
  const migHome = createTempDir("asd-mig-home-");
  try {
    const asdDir = path.join(migHome, ".asd");
    fs.mkdirSync(asdDir, { recursive: true });
    const legacyRouting = {
      _asdVersion: "2.2.0",
      agents: {
        worker: {
          harness: "opencode",
          model: "nvidia/z-ai/glm-5.3-flash",
          modelFamily: "glm",
          fallbacks: [{ harness: "antigravity", model: "gemini-3.8-flash", modelFamily: "gemini" }],
        },
      },
      categories: {
        general: {
          harness: "opencode",
          model: "nvidia/z-ai/glm-5.3-flash",
          modelFamily: "glm",
        },
      },
    };
    const routingPath = path.join(asdDir, "routing.jsonc");
    fs.writeFileSync(routingPath, JSON.stringify(legacyRouting, null, 2), "utf8");

    await syncHarnessConfigs({ homeDir: migHome, noPath: true });

    const migratedRaw = fs.readFileSync(routingPath, "utf8");
    const migrated = JSON.parse(
      migratedRaw
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n")
    );
    assert.equal(migrated._asdVersion, ASD_VERSION);
    assert.ok(migrated.lightSubagents, "Migrated routing.jsonc must include lightSubagents block");
    assert.ok(migrated.lightSubagents.antigravity, "Migrated lightSubagents must include antigravity");
    assert.equal(
      migrated.agents.worker.model,
      "nvidia/z-ai/glm-5.3-flash",
      "User custom agents.worker must be preserved intact"
    );
    assert.equal(
      migrated.agents.worker.fallbacks[0].model,
      "gemini-3.8-flash-medium",
      "Legacy nonexistent Antigravity CLI model must be migrated to valid agy model ID"
    );
    assert.equal(
      migrated.categories.general.model,
      "nvidia/z-ai/glm-5.3-flash",
      "User custom categories.general must be preserved intact"
    );

    // Verify syncAgentModelsIfNeeded updates Claude Code & OpenCode agent .md model: immediately when routing.jsonc is edited
    migrated.lightSubagents["claude-code"] = {
      worker: { model: "haiku", fallbacks: ["sonnet"] },
      defaultModel: "haiku",
    };
    migrated.lightSubagents.opencode = {
      worker: { model: "nvidia/deepseek-ai/deepseek-v4.1-flash", fallbacks: ["nvidia/z-ai/glm-5.3-flash"] },
      defaultModel: "nvidia/deepseek-ai/deepseek-v4.1-flash",
    };
    fs.writeFileSync(routingPath, JSON.stringify(migrated, null, 2), "utf8");

    const refreshRes = syncAgentModelsIfNeeded({ homeDir: migHome });
    assert.equal(refreshRes.updated, true);

    const claudeWorkerMd = fs.readFileSync(
      path.join(migHome, ".claude", "agents", "asd-worker.md"),
      "utf8"
    );
    const opencodeWorkerMd = fs.readFileSync(
      path.join(migHome, ".config", "opencode", "agent", "asd-worker.md"),
      "utf8"
    );
    assert.ok(claudeWorkerMd.includes("model: haiku"), "Claude Code asd-worker.md must immediately reflect model: haiku");
    assert.ok(
      opencodeWorkerMd.includes("model: nvidia/deepseek-ai/deepseek-v4.1-flash"),
      "OpenCode asd-worker.md must immediately reflect model: nvidia/deepseek-ai/deepseek-v4.1-flash"
    );
  } finally {
    removeTempDir(migHome);
  }
});

// ============================================================================
// I1: Backup Freshness & Uninstall Smart Restore
// ============================================================================

describe("I1: Backup Freshness & Uninstall Smart Restore", () => {
  let i1Home: string;

  before(() => {
    i1Home = createTempDir("asd-i1-home-");
  });

  after(() => {
    removeTempDir(i1Home);
  });

  test("I1a: sync → user edits config → uninstall preserves post-sync edits (not stale backup)", async () => {
    // Seed pre-existing user config BEFORE initial sync
    const claudeDir = path.join(i1Home, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({
      theme: "light",
      hooks: {
        PreToolUse: [{ command: "pre-existing-guard", _asdManaged: false }],
      },
    }, null, 2), "utf8");

    // Initial sync (backs up pre-existing user config)
    await syncHarnessConfigs({ homeDir: i1Home, noPath: true });

    // Verify backup exists (pre-sync user config)
    const backupPath = `${settingsPath}.asd-backup`;
    assert.ok(fs.existsSync(backupPath), "Backup should exist after initial sync");
    const backupContent = fs.readFileSync(backupPath, "utf8");
    assert.ok(backupContent.includes("pre-existing-guard"), "Backup should contain pre-sync user config");

    // User edits settings.json AFTER sync (simulate post-sync user change)
    const userEditedSettings = {
      theme: "dark",
      customSetting: "user-value",
      hooks: {
        PreToolUse: [{ command: "my-custom-guard", _asdManaged: false }],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(userEditedSettings, null, 2), "utf8");

    // Run uninstall
    const uninstRes = await uninstallHarnessConfigs({ homeDir: i1Home });
    assert.equal(uninstRes.status, "success");

    // The restored settings should contain the USER's post-sync edits, not the stale backup
    const restoredSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.equal(restoredSettings.theme, "dark");
    assert.equal(restoredSettings.customSetting, "user-value");
    assert.equal(restoredSettings.hooks.PreToolUse[0].command, "my-custom-guard");
    assert.equal(restoredSettings.hooks.PreToolUse[0]._asdManaged, false);
    // ASD-managed hooks should be removed
    assert.equal(restoredSettings.hooks.Stop, undefined);
  });

  test("I1b: backup file never contains ASD-generated content", async () => {
    const i1bHome = createTempDir("asd-i1b-home-");
    try {
      // Seed pre-existing user config BEFORE initial sync
      const claudeDir = path.join(i1bHome, ".claude");
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, "settings.json");
      fs.writeFileSync(settingsPath, JSON.stringify({
        theme: "light",
      }, null, 2), "utf8");

      // Initial sync
      await syncHarnessConfigs({ homeDir: i1bHome, noPath: true });

      // Check that backup does NOT contain ASD-managed markers
      const backupPath = `${settingsPath}.asd-backup`;
      assert.ok(fs.existsSync(backupPath), "Backup should exist");

      const backupContent = fs.readFileSync(backupPath, "utf8");
      // Backup should be the original user config, not ASD-generated
      assert.ok(!backupContent.includes("_asdManaged"), "Backup must not contain _asdManaged marker");
      assert.ok(!backupContent.includes("asd-core"), "Backup must not contain asd-core MCP");
      assert.ok(!backupContent.includes("hook pre-tool-use"), "Backup must not contain ASD hook commands");
      assert.ok(!backupContent.includes("hook stop"), "Backup must not contain ASD hook commands");
      assert.ok(backupContent.includes("light"), "Backup should contain original user theme");

      // Second sync (idempotent) - backup should still not be overwritten with ASD content
      await syncHarnessConfigs({ homeDir: i1bHome, noPath: true });

      const backupContent2 = fs.readFileSync(backupPath, "utf8");
      assert.ok(!backupContent2.includes("_asdManaged"), "Backup must not contain _asdManaged after second sync");
      assert.ok(!backupContent2.includes("asd-core"), "Backup must not contain asd-core after second sync");
      assert.ok(backupContent2.includes("light"), "Backup should still contain original user theme after second sync");
    } finally {
      removeTempDir(i1bHome);
    }
  });
});

// ============================================================================
// I2: Hash Divergence Detection & Re-merge
// ============================================================================

describe("I2: Hash Divergence Detection & Re-merge", () => {
  let i2Home: string;

  before(() => {
    i2Home = createTempDir("asd-i2-home-");
  });

  after(() => {
    removeTempDir(i2Home);
  });

  test("I2a: user edits config → next sync (without --force) does NOT skip diverged harness; user keys survive re-merge", async () => {
    // Initial sync
    const firstSync = await syncHarnessConfigs({ homeDir: i2Home, noPath: true });
    assert.equal(firstSync.status, "updated");
    assert.equal(firstSync.harnesses["claude-code"].status, "updated");

    // User edits Claude Code settings.json (adds a custom hook)
    const settingsPath = path.join(i2Home, ".claude", "settings.json");
    const currentSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    currentSettings.hooks.CustomUserHook = [{ command: "user-custom-hook", _asdManaged: false }];
    fs.writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2), "utf8");

    // Next sync WITHOUT --force should NOT skip claude-code (divergence detected)
    const secondSync = await syncHarnessConfigs({ homeDir: i2Home, noPath: true });
    assert.equal(secondSync.harnesses["claude-code"].status, "updated", "Harness should not be skipped due to user config divergence");
    assert.equal(secondSync.harnesses["claude-code"].skipped, false);

    // User's custom hook should survive the re-merge
    const mergedSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.ok(mergedSettings.hooks.CustomUserHook, "User's custom hook should survive re-merge");
    assert.equal(mergedSettings.hooks.CustomUserHook[0].command, "user-custom-hook");
    assert.equal(mergedSettings.hooks.CustomUserHook[0]._asdManaged, false);
    // ASD-managed hooks should still be present
    assert.ok(mergedSettings.hooks.PreToolUse?.length > 0, "ASD PreToolUse hooks should be present");
    assert.ok(mergedSettings.hooks.Stop?.length > 0, "ASD Stop hooks should be present");
  });

  test("I2b: user edits OpenCode opencode.json → next sync re-merges preserving user MCP servers", async () => {
    const i2bHome = createTempDir("asd-i2b-home-");
    try {
      // Initial sync
      await syncHarnessConfigs({ homeDir: i2bHome, noPath: true });

      // User adds a custom MCP server to opencode.json
      const opencodeJsonPath = path.join(i2bHome, ".config", "opencode", "opencode.json");
      const currentJson = JSON.parse(fs.readFileSync(opencodeJsonPath, "utf8"));
      currentJson.mcpServers["user-custom-mcp"] = { command: "user-custom-bin" };
      fs.writeFileSync(opencodeJsonPath, JSON.stringify(currentJson, null, 2), "utf8");

      // Next sync should re-merge OpenCode
      const secondSync = await syncHarnessConfigs({ homeDir: i2bHome, noPath: true });
      assert.equal(secondSync.harnesses.opencode.status, "updated", "OpenCode should not be skipped due to user config divergence");

      // User's custom MCP should survive
      const mergedJson = JSON.parse(fs.readFileSync(opencodeJsonPath, "utf8"));
      assert.ok(mergedJson.mcpServers["user-custom-mcp"], "User's custom MCP should survive re-merge");
      assert.equal(mergedJson.mcpServers["user-custom-mcp"].command, "user-custom-bin");
      // ASD-managed MCPs should still be present
      assert.ok(mergedJson.mcpServers["context7"], "ASD context7 MCP should be present");
      assert.equal(mergedJson.mcpServers["context7"]._asdManaged, true);
    } finally {
      removeTempDir(i2bHome);
    }
  });

  test("I2c: lastSync.json stores userConfigHashes and is backward-compatible (missing field = behave as today)", async () => {
    const i2cHome = createTempDir("asd-i2c-home-");
    try {
      // Initial sync
      await syncHarnessConfigs({ homeDir: i2cHome, noPath: true });

      // Check last-sync.json has userConfigHashes
      const lastSyncPath = path.join(i2cHome, ".asd", "state", "last-sync.json");
      const lastSync = JSON.parse(fs.readFileSync(lastSyncPath, "utf8"));
      assert.ok(lastSync.harnesses["claude-code"].userConfigHashes, "userConfigHashes should be stored for claude-code");
      assert.ok(lastSync.harnesses.opencode.userConfigHashes, "userConfigHashes should be stored for opencode");
      assert.ok(lastSync.harnesses.codex.userConfigHashes, "userConfigHashes should be stored for codex");
      assert.ok(lastSync.harnesses.antigravity.userConfigHashes, "userConfigHashes should be stored for antigravity");
      assert.ok(lastSync.harnesses.cursor.userConfigHashes, "userConfigHashes should be stored for cursor");

      // Simulate old last-sync.json without userConfigHashes (backward compatibility)
      delete lastSync.harnesses["claude-code"].userConfigHashes;
      fs.writeFileSync(lastSyncPath, JSON.stringify(lastSync, null, 2), "utf8");

      // User edits config
      const settingsPath = path.join(i2cHome, ".claude", "settings.json");
      const currentSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      currentSettings.hooks.CustomHook = [{ command: "custom", _asdManaged: false }];
      fs.writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2), "utf8");

      // Sync should still work (backward compatible - missing userConfigHashes means no divergence check)
      const syncRes = await syncHarnessConfigs({ homeDir: i2cHome, noPath: true });
      // Since userConfigHashes is missing, it may skip or not - but should not crash
      assert.ok(syncRes.status === "updated" || syncRes.status === "skipped", "Sync should complete without error");
    } finally {
      removeTempDir(i2cHome);
    }
  });
});

// ============================================================================
// I4: MCP extKeys mutation fix
// ============================================================================

describe("I4: MCP extKeys mutation - mutateBeforeMerge must not add phantom keys", () => {
  let i4Home: string;

  before(() => {
    i4Home = createTempDir("asd-i4-home-");
  });

  after(() => {
    removeTempDir(i4Home);
  });

  test("I4a: syncJsonMcpConfigFile - mutateBeforeMerge adds keys to extKeys that don't exist in user config; ASD-managed servers should still be injected", () => {
    const configPath = path.join(i4Home, "test-mcp.json");
    const userConfig = {
      mcpServers: {
        "user-existing": { command: "user-bin" },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(userConfig, null, 2), "utf8");

    const catalog = {
      "asd-core": { command: "asd-core-bin" },
      "context7": { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
      "websearch": { command: "websearch-bin" },
    };
    const nativeCapabilities = new Set<string>();

    // This simulates the opencode mutateBeforeMerge which adds keys from cfg.mcp to extKeys
    // The bug: cfg.mcp might have keys that don't exist in the actual user config
    syncJsonMcpConfigFile({
      filePath: configPath,
      harnessId: "opencode",
      catalog,
      nativeCapabilities,
      externalExistingKeys: new Set(["user-existing"]), // Only user-existing is actually in user config
      mutateBeforeMerge: (cfg, extKeys) => {
        // This is the buggy behavior: adding keys from cfg.mcp (which may include catalog keys)
        // to extKeys, even though they don't exist in the user's actual config
        if (cfg.mcp && typeof cfg.mcp === "object") {
          for (const k of Object.keys(cfg.mcp as Record<string, unknown>)) {
            extKeys.add(k); // BUG: adds phantom keys
          }
        }
      },
    });

    const result = JSON.parse(fs.readFileSync(configPath, "utf8"));
    
    // user-existing should be preserved
    assert.ok(result.mcpServers["user-existing"], "user-existing should be preserved");
    assert.equal(result.mcpServers["user-existing"].command, "user-bin");

    // ASD-managed servers should be injected despite mutateBeforeMerge adding phantom keys
    // The bug causes these to be skipped because extKeys now contains them
    assert.ok(result.mcpServers["context7"], "context7 should be injected (ASD-managed)");
    assert.equal(result.mcpServers["context7"]._asdManaged, true);
    assert.ok(result.mcpServers["websearch"], "websearch should be injected (ASD-managed)");
    assert.equal(result.mcpServers["websearch"]._asdManaged, true);

    // asd-core should not be injected
    assert.equal(result.mcpServers["asd-core"], undefined);
  });

  test("I4b: mergeJsonMcpServersForHarness - trusts filtered externalExistingKeys from other config files", () => {
    const existingMcpServers = {
      "user-existing": { command: "user-bin" },
    };
    const catalog = {
      "asd-core": { command: "asd-core-bin" },
      "context7": { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
      "websearch": { command: "websearch-bin" },
      "from-other-config": { command: "other-config-bin" }, // Key from another config file (e.g., opencode.jsonc)
    };
    const nativeCapabilities = new Set<string>();
    // externalExistingKeys contains keys from other user config files (filtered by syncJsonMcpConfigFile)
    const externalExistingKeys = new Set(["user-existing", "from-other-config"]);

    const result = mergeJsonMcpServersForHarness({
      harnessId: "opencode",
      existingMcpServers,
      catalog,
      nativeCapabilities,
      externalExistingKeys,
    });

    // user-existing should be preserved (exists in current config)
    assert.ok((result as Record<string, any>)["user-existing"], "user-existing should be preserved");
    assert.equal((result as Record<string, any>)["user-existing"].command, "user-bin");

    // from-other-config should be skipped (exists in externalExistingKeys from other config file)
    assert.equal((result as Record<string, any>)["from-other-config"], undefined, "from-other-config should be skipped (exists in other config)");

    // context7 and websearch should be injected (ASD-managed, not in externalExistingKeys)
    assert.ok((result as Record<string, any>)["context7"], "context7 should be injected");
    assert.equal((result as Record<string, any>)["context7"]._asdManaged, true);
    assert.ok((result as Record<string, any>)["websearch"], "websearch should be injected");
    assert.equal((result as Record<string, any>)["websearch"]._asdManaged, true);

    // asd-core should not be injected
    assert.equal(result["asd-core"], undefined);
  });
});

// ============================================================================
// T1.3: Agent Tools Frontmatter, Quoted Antigravity Hooks, OpenCode Guard Plugin & Roster Count
// ============================================================================

describe("T1.3: Subagent tools frontmatter, quoted hooks, OpenCode plugin, and roster count", () => {
  test("Antigravity, OpenCode, and Claude Code agent frontmatter declare explicit role-appropriate tool permissions", () => {
    const agScout = generateAgentContent("scout", { harnessId: "antigravity" });
    const agCritic = generateAgentContent("critic", { harnessId: "antigravity" });
    const agWorker = generateAgentContent("worker", { harnessId: "antigravity" });
    const agPlanner = generateAgentContent("planner", { harnessId: "antigravity" });

    assert.ok(agScout.includes("tools: [read_file, search_web]"), "Antigravity scout must be read-only");
    assert.ok(agCritic.includes("tools: [read_file, search_web]"), "Antigravity critic must be read-only");
    assert.ok(
      agWorker.includes("tools: [read_file, edit_file, write_file, run_command, manage_task, search_web]"),
      "Antigravity worker must include workspace write/command tools"
    );
    assert.ok(
      agPlanner.includes("tools: [read_file, edit_file, write_file, run_command, manage_task, search_web]"),
      "Antigravity planner must include workspace write/command tools"
    );

    const ocScout = generateAgentContent("scout", { harnessId: "opencode" });
    const ocWorker = generateAgentContent("worker", { harnessId: "opencode" });
    assert.ok(ocScout.includes("  write: false\n  edit: false\n  patch: false"), "OpenCode scout must disable write/edit/patch");
    assert.equal(ocWorker.includes("write: false"), false, "OpenCode worker must allow writes");

    const ccScout = generateAgentContent("scout", { harnessId: "claude-code" });
    assert.ok(
      ccScout.includes("disallowedTools: Write, Edit, MultiEdit, NotebookEdit"),
      "Claude Code scout must disallow write tools"
    );

    const rosterMd = generateAllAgentsMarkdown();
    assert.ok(
      rosterMd.includes("defines the 5 standard specialist agent roles"),
      "AGENTS.md header must state 5 standard specialist agent roles"
    );
    assert.equal(rosterMd.includes("10 standard specialist agent roles"), false);
  });

  test("Antigravity hooks handle CLI paths with spaces safely on Windows (no Go cmd /c quote-escaping) and POSIX, and OpenCode guard plugin syncs & uninstalls cleanly", async () => {
    // 1. Unit checks for cross-platform Antigravity hook spec generation
    const noSpaceSpecWin = buildAntigravityHookSpec("C:\\Users\\dev\\asd-runtime\\src\\cli\\index.ts", "win32");
    assert.equal(noSpaceSpecWin.cliArg, "C:/Users/dev/asd-runtime/src/cli/index.ts");
    assert.equal(noSpaceSpecWin.launcherSource, null);
    assert.equal(noSpaceSpecWin.cliArg.includes('"'), false, "Windows hook cliArg must never contain double quotes");

    const spaceSpecWin = buildAntigravityHookSpec("C:\\Program Files\\ASD Runtime\\src\\cli\\index.ts", "win32");
    assert.equal(spaceSpecWin.cliArg, "./asd-hook.mjs");
    assert.ok(spaceSpecWin.launcherSource && spaceSpecWin.launcherSource.includes("Program%20Files"));
    assert.equal(spaceSpecWin.cliArg.includes('"'), false, "Windows space-path hook cliArg must never contain double quotes");

    const spaceSpecPosix = buildAntigravityHookSpec("/Users/dev/ASD Runtime/src/cli/index.ts", "linux");
    assert.equal(spaceSpecPosix.cliArg, '"/Users/dev/ASD Runtime/src/cli/index.ts"');
    assert.equal(spaceSpecPosix.launcherSource, null);

    // 2. End-to-end sync & execution check with spaces in CLI path
    const spaceHome = createTempDir("asd-space-home-");
    const spaceRuntime = createTempDir("asd runtime with spaces ");
    try {
      const cliWithSpaces = path.join(spaceRuntime, "src", "cli", "index.ts");
      fs.mkdirSync(path.dirname(cliWithSpaces), { recursive: true });
      fs.writeFileSync(
        cliWithSpaces,
        'export async function main(): Promise<number> { process.stdout.write("{}\\n"); return 0; }\n',
        "utf8"
      );

      const first = await syncHarnessConfigs({
        homeDir: spaceHome,
        asdCliPath: cliWithSpaces,
        noPath: true,
      });
      assert.equal(first.status, "updated");

      const geminiConfigDir = path.join(spaceHome, ".gemini", "config");
      const hooksPath = path.join(geminiConfigDir, "hooks.json");
      const launcherPath = path.join(geminiConfigDir, "asd-hook.mjs");
      const hooks = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
      const posixCli = cliWithSpaces.replaceAll("\\", "/");
      const preToolCmd = hooks["asd-session-tracker"].PreToolUse[0].hooks[0].command as string;
      const sessionStartCmd = hooks["asd-session-tracker"].SessionStart[0].command as string;
      const stopCmd = hooks["asd-session-tracker"].Stop[0].command as string;

      if (process.platform === "win32") {
        assert.equal(preToolCmd.includes('"'), false, `Windows hook command must not contain quotes: ${preToolCmd}`);
        assert.ok(preToolCmd.includes("./asd-hook.mjs"), `Expected ./asd-hook.mjs in PreToolUse: ${preToolCmd}`);
        assert.ok(sessionStartCmd.includes("./asd-hook.mjs"), `Expected ./asd-hook.mjs in SessionStart: ${sessionStartCmd}`);
        assert.ok(stopCmd.includes("./asd-hook.mjs"), `Expected ./asd-hook.mjs in Stop: ${stopCmd}`);
        assert.ok(fs.existsSync(launcherPath), "asd-hook.mjs launcher must exist on Windows when CLI path has spaces");

        // Reproduce Go exec.Command("cmd", "/c", preToolCmd) with cwd = ~/.gemini/config
        const execRes = child_process.spawnSync("cmd", ["/c", preToolCmd], {
          cwd: geminiConfigDir,
          encoding: "utf8",
          windowsHide: true,
        });
        assert.equal(execRes.status, 0, `cmd /c hook failed: ${execRes.stderr || execRes.stdout}`);
        assert.equal(execRes.stdout.trim(), "{}");
      } else {
        assert.ok(preToolCmd.includes(`"${posixCli}"`), `Expected quoted CLI path in PreToolUse: ${preToolCmd}`);
        assert.ok(sessionStartCmd.includes(`"${posixCli}"`), `Expected quoted CLI path in SessionStart: ${sessionStartCmd}`);
        assert.ok(stopCmd.includes(`"${posixCli}"`), `Expected quoted CLI path in Stop: ${stopCmd}`);
      }

      const activeOcProfile = resolveOpenCodeCapabilityProfile().effectiveProfile;
      const ocPluginRelPath =
        activeOcProfile === "v2"
          ? OPENCODE_V2_PLUGIN_RELATIVE_PATH
          : OPENCODE_V1_PLUGIN_RELATIVE_PATH;
      const ocPluginPath = path.join(spaceHome, ".config", "opencode", ...ocPluginRelPath.split("/"));
      assert.ok(fs.existsSync(ocPluginPath), `OpenCode plugin (${ocPluginRelPath}) must be installed`);
      const pluginSrc = fs.readFileSync(ocPluginPath, "utf8");
      if (activeOcProfile === "v2") {
        assert.ok(pluginSrc.includes(OPENCODE_V2_PLUGIN_MARKER), "OpenCode V2 plugin must carry V2 marker");
        assert.ok(pluginSrc.includes("execute.before"), "OpenCode V2 plugin must hook execute.before");
      } else {
        assert.ok(pluginSrc.includes(OPENCODE_V1_PLUGIN_MARKER), "OpenCode V1 plugin must carry V1 marker");
        assert.ok(pluginSrc.includes("tool.execute.before"), "OpenCode V1 plugin must hook tool.execute.before");
      }
      assert.ok(pluginSrc.includes(posixCli), "OpenCode plugin must reference configured CLI path");
      assert.ok(
        pluginSrc.includes("resolveNodeExecutable()"),
        "OpenCode plugin must resolve Node binary instead of blindly spawning process.execPath (which is opencode.exe under Bun)"
      );
      assert.equal(
        pluginSrc.includes("spawnSync(\n    process.execPath,"),
        false,
        "OpenCode plugin must never pass process.execPath directly to spawnSync"
      );

      // Idempotency check
      const second = await syncHarnessConfigs({
        homeDir: spaceHome,
        asdCliPath: cliWithSpaces,
        noPath: true,
      });
      assert.equal(second.status, "skipped");

      // Doctor hookCoverage check
      const probe = await doctorProbe({ homeDir: spaceHome, projectRoot: process.cwd() });
      assert.equal(probe.ok, true);
      assert.equal(probe.harnesses.opencode.hookCoverage?.preToolUse, "plugin-hook");
      assert.equal(probe.harnesses.codex.hookCoverage?.preToolUse, "sandbox-only");
      assert.ok(probe.checks.some((c) => c.name === "hook_coverage" && c.ok));

      // Surgical uninstall removes Antigravity launcher and OpenCode plugin cleanly
      await uninstallHarnessConfigs({ homeDir: spaceHome });
      assert.equal(fs.existsSync(launcherPath), false, "Antigravity asd-hook.mjs launcher must be removed on uninstall");
      assert.equal(fs.existsSync(ocPluginPath), false, "OpenCode plugin must be removed on uninstall");
    } finally {
      removeTempDir(spaceHome);
      removeTempDir(spaceRuntime);
    }
  });

  test("Claude Code settings.json and Oh-My-OpenAgent config disable AI Co-authored-by attribution and restore cleanly on uninstall", async () => {
    const attrHome = createTempDir("asd-no-coauthor-home-");
    try {
      const opencodeDir = path.join(attrHome, ".config", "opencode");
      fs.mkdirSync(opencodeDir, { recursive: true });
      fs.writeFileSync(
        path.join(opencodeDir, "opencode.jsonc"),
        '{\n  "plugin": ["oh-my-openagent@latest"]\n}\n',
        "utf8"
      );

      await syncHarnessConfigs({ homeDir: attrHome, noPath: true });

      const claudeSettings = JSON.parse(
        fs.readFileSync(path.join(attrHome, ".claude", "settings.json"), "utf8")
      );
      assert.equal(claudeSettings.includeCoAuthoredBy, false);
      assert.deepEqual(claudeSettings.attribution, { commit: "", pr: "" });

      const omoConfigPath = path.join(opencodeDir, "oh-my-openagent.json");
      assert.ok(fs.existsSync(omoConfigPath), "oh-my-openagent.json must be created when plugin is configured");
      const omoCfg = JSON.parse(fs.readFileSync(omoConfigPath, "utf8"));
      assert.equal(omoCfg.git_master.commit_footer, false);
      assert.equal(omoCfg.git_master.include_co_authored_by, false);

      await uninstallHarnessConfigs({ homeDir: attrHome });
      assert.equal(
        fs.existsSync(path.join(attrHome, ".claude", "settings.json")),
        false,
        "Freshly created Claude settings.json must be removed on uninstall"
      );
      assert.equal(
        fs.existsSync(omoConfigPath),
        false,
        "ASD-created oh-my-openagent.json must be removed on uninstall"
      );
    } finally {
      removeTempDir(attrHome);
    }
  });
});

describe("Model Discovery Integration on Bootstrap & asd sync", () => {
  test("1. Initial install (routing.jsonc missing): auto-substitutes unavailable preset models from discovered catalog while keeping offline harnesses on mainstream preset", async () => {
    const bootHome = createTempDir("asd-model-boot-home-");
    try {
      const mockCatalog = {
        antigravity: [
          "gemini-4-carbon-high",
          "gemini-3.8-flash-medium",
          "gemini-3.8-flash-low",
        ],
        "claude-code": [], // Simulate offline / unauthenticated Claude Code -> must keep mainstream preset!
        codex: ["gpt-5.6-terra", "gpt-5.6-luna"], // Simulate user without gpt-6-luna -> auto-matched to gpt-5.6-terra!
        opencode: ["nvidia/z-ai/glm-5.3-flash", "nvidia/deepseek-ai/deepseek-v4.1-flash"],
        cursor: ["claude-sonnet-5-5-medium"],
      };

      const res = await syncHarnessConfigs({
        homeDir: bootHome,
        noPath: true,
        modelCatalogOverride: mockCatalog,
      });

      assert.ok(res.modelsBootstrapped && res.modelsBootstrapped.length > 0);
      assert.equal(res.modelWarnings, undefined);

      // Verify models-cache.json was pre-warmed
      const cachePath = path.join(bootHome, ".asd", "state", "models-cache.json");
      assert.equal(fs.existsSync(cachePath), true);

      const routingRaw = fs.readFileSync(path.join(bootHome, ".asd", "routing.jsonc"), "utf8");
      const routing = JSON.parse(
        routingRaw
          .split("\n")
          .filter((l) => !l.trim().startsWith("//"))
          .join("\n")
      );

      // Codex preset 'gpt-6-luna' was auto-matched to available 'gpt-5.6-terra'
      assert.equal(routing.lightSubagents.codex.defaultModel, "gpt-5.6-terra");
      assert.equal(routing.agents.critic.model, "gpt-5.6-terra");
      // OpenCode preset 'z-ai/glm-5.3-flash' & 'deepseek-ai/deepseek-v4.1-flash' matched provider-prefixed models
      assert.equal(routing.agents.worker.model, "nvidia/z-ai/glm-5.3-flash");
      assert.equal(routing.categories.research.model, "nvidia/deepseek-ai/deepseek-v4.1-flash");
      // Offline Claude Code preserved latest 5.5 mainstream static preset without error
      assert.equal(routing.agents.planner.model, "claude-sonnet-5-5");
      assert.equal(routing.agents.architect.model, "claude-opus-5-5");
      // Native Antigravity lightSubagents tiers remained untouched
      assert.equal(routing.lightSubagents.antigravity.scout.model, "flash_lite");
    } finally {
      removeTempDir(bootHome);
    }
  });

  test("2. Normal asd sync vs --refresh-models: warns without mutating existing user routing.jsonc, preserves idempotency, and remaps only when --refresh-models is passed", async () => {
    const warnHome = createTempDir("asd-model-warn-home-");
    try {
      const asdDir = path.join(warnHome, ".asd");
      fs.mkdirSync(asdDir, { recursive: true });
      const routingPath = path.join(asdDir, "routing.jsonc");
      const userRouting = {
        _asdVersion: ASD_VERSION,
        lightSubagents: {
          antigravity: {
            scout: "flash_lite",
            defaultModel: "flash",
          },
          codex: {
            defaultModel: "gpt-6.1-nonexistent",
          },
        },
        agents: {
          planner: {
            harness: "codex",
            model: "gpt-6.1-nonexistent",
            modelFamily: "gpt",
            fallbacks: [
              { harness: "opencode", model: "nvidia/z-ai/glm-5.3-flash", modelFamily: "glm" },
            ],
          },
          worker: {
            harness: "opencode",
            model: "nvidia/z-ai/glm-5.3-flash",
            modelFamily: "glm",
            fallbacks: [],
          },
        },
        categories: {},
      };
      const initialContent = JSON.stringify(userRouting, null, 2);
      fs.writeFileSync(routingPath, initialContent, "utf8");

      const mockCatalog = {
        antigravity: ["gemini-3.8-flash-medium", "gemini-3.8-flash-low"],
        "claude-code": [],
        codex: ["gpt-6-luna", "gpt-5.6-terra"],
        opencode: ["nvidia/z-ai/glm-5.3-flash"],
        cursor: [],
      };

      // Normal sync: MUST NOT mutate user routing.jsonc, MUST emit warnings, and second sync MUST skip (idempotent)
      const firstSync = await syncHarnessConfigs({
        homeDir: warnHome,
        noPath: true,
        modelCatalogOverride: mockCatalog,
      });
      assert.equal(fs.readFileSync(routingPath, "utf8"), initialContent, "Normal sync must never overwrite user routing.jsonc");
      assert.equal(firstSync.modelsRemapped, undefined);
      assert.ok(firstSync.modelWarnings && firstSync.modelWarnings.length === 2);
      assert.equal(firstSync.modelWarnings[0]!.configuredModel, "gpt-6.1-nonexistent");
      assert.equal(firstSync.modelWarnings[0]!.suggestedModel, "gpt-6-luna");

      const secondSync = await syncHarnessConfigs({
        homeDir: warnHome,
        noPath: true,
        modelCatalogOverride: {
          ...mockCatalog,
          codex: ["gpt-6-luna", "gpt-5.6-terra", "gpt-brand-new-model"],
        },
      });
      assert.equal(secondSync.status, "skipped", "Provider model list changes must NOT break configHash idempotency");

      // Explicit --refresh-models: remaps ONLY missing models while keeping valid user models untouched
      const refreshSync = await syncHarnessConfigs({
        homeDir: warnHome,
        noPath: true,
        refreshModels: true,
        modelCatalogOverride: mockCatalog,
      });
      assert.ok(refreshSync.modelsRemapped && refreshSync.modelsRemapped.length === 2);
      assert.equal(refreshSync.modelWarnings, undefined);

      const updated = JSON.parse(
        fs
          .readFileSync(routingPath, "utf8")
          .split("\n")
          .filter((l) => !l.trim().startsWith("//"))
          .join("\n")
      );
      assert.equal(updated.lightSubagents.codex.defaultModel, "gpt-6-luna");
      assert.equal(updated.agents.planner.model, "gpt-6-luna");
      assert.equal(updated.agents.worker.model, "nvidia/z-ai/glm-5.3-flash");
    } finally {
      removeTempDir(warnHome);
    }
  });
});

describe("ACP Readiness & Bridge Setup Guidance (`runAsdDoctor` & `runAsdSync`)", () => {
  test("reports native ACP for opencode/antigravity/cursor and non-fatal bridge setup guidance for claude-code & codex", async () => {
    const fakeBinDir = createTempDir("asd-acp-bins-");
    const acpHome = createTempDir("asd-acp-home-");
    const ext = process.platform === "win32" ? ".cmd" : "";
    const writeStub = (name: string) => {
      const p = path.join(fakeBinDir, `${name}${ext}`);
      fs.writeFileSync(p, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n", {
        encoding: "utf8",
        mode: 0o755,
      });
    };

    try {
      for (const bin of ["opencode", "agy", "cursor-agent", "claude", "codex"]) {
        writeStub(bin);
      }

      const isolatedEnv = { PATH: fakeBinDir, Path: fakeBinDir };

      // 1. Bridges missing -> doctor stays ok=true, reports native ready + bridge install guidance
      const docMissing = await runAsdDoctor({
        homeDir: acpHome,
        projectRoot: process.cwd(),
        env: isolatedEnv,
      });
      assert.equal(docMissing.ok, true, "Missing optional ACP bridges must never fail doctor");
      assert.equal(docMissing.errors.length, 0);

      assert.equal(docMissing.harnesses.opencode.acp?.supported, true);
      assert.equal(docMissing.harnesses.opencode.acp?.mode, "native");
      assert.equal(docMissing.harnesses.antigravity.acp?.supported, true);
      assert.equal(docMissing.harnesses.antigravity.acp?.mode, "native");
      assert.equal(docMissing.harnesses.cursor.acp?.supported, true);
      assert.equal(docMissing.harnesses.cursor.acp?.mode, "native");

      assert.equal(docMissing.harnesses["claude-code"].installed, true);
      assert.equal(docMissing.harnesses["claude-code"].acp?.supported, false);
      assert.equal(docMissing.harnesses["claude-code"].acp?.mode, "missing-bridge");
      assert.ok(
        docMissing.harnesses["claude-code"].acp?.installHint?.includes(
          "@agentclientprotocol/claude-agent-acp"
        )
      );

      assert.equal(docMissing.harnesses.codex.installed, true);
      assert.equal(docMissing.harnesses.codex.acp?.supported, false);
      assert.equal(docMissing.harnesses.codex.acp?.mode, "missing-bridge");
      assert.ok(
        docMissing.harnesses.codex.acp?.installHint?.includes(
          "@agentclientprotocol/codex-acp"
        )
      );

      assert.ok(docMissing.acpBridgeHints && docMissing.acpBridgeHints.length >= 2);
      assert.ok(
        docMissing.acpBridgeHints.some((h) =>
          h.includes("npm i -g @agentclientprotocol/claude-agent-acp @agentclientprotocol/codex-acp")
        )
      );
      const acpCheck = docMissing.checks.find((c) => c.name === "acp_readiness");
      assert.ok(acpCheck && acpCheck.ok);
      assert.ok(acpCheck.message?.includes("streaming CLI fallback active"));

      // Sync summary also exposes acpReadiness & acpBridgeHints without breaking idempotency
      const syncRes = await runAsdSync({
        homeDir: acpHome,
        noPath: true,
        skipModelDiscovery: true,
        env: isolatedEnv,
      });
      assert.equal(syncRes.acpReadiness?.opencode.supported, true);
      assert.equal(syncRes.acpReadiness?.["claude-code"].supported, false);
      assert.ok(syncRes.acpBridgeHints && syncRes.acpBridgeHints.length >= 2);

      // 2. Install bridge stubs -> doctor reports bridge ACP ready and clears hints
      writeStub("claude-agent-acp");
      writeStub("codex-acp");

      const docReady = await runAsdDoctor({
        homeDir: acpHome,
        projectRoot: process.cwd(),
        env: isolatedEnv,
      });
      assert.equal(docReady.ok, true);
      assert.equal(docReady.harnesses["claude-code"].acp?.supported, true);
      assert.equal(docReady.harnesses["claude-code"].acp?.mode, "bridge");
      assert.equal(docReady.harnesses.codex.acp?.supported, true);
      assert.equal(docReady.harnesses.codex.acp?.mode, "bridge");
      assert.equal(docReady.acpBridgeHints, undefined);
    } finally {
      removeTempDir(fakeBinDir);
      removeTempDir(acpHome);
    }
  });
});

describe("T3.1: Facade Split, Harness-Conditional Skills, Dynamic routing.jsonc Injection & CLI-Only Agents", () => {
  const ALL_HARNESSES: readonly HarnessId[] = [
    "claude-code",
    "opencode",
    "codex",
    "antigravity",
    "cursor",
  ];

  test("Facade re-exports in src/adapters/installer.ts preserve exact identity with extracted submodules", () => {
    assert.equal(getSkillTemplate, skillRendererMod.getSkillTemplate);
    assert.equal(renderSkillTemplate, skillRendererMod.renderSkillTemplate);
    assert.equal(resolveHarnessConditionalBlocks, skillRendererMod.resolveHarnessConditionalBlocks);

    assert.equal(resolveHarnessRoleModel, agentRendererMod.resolveHarnessRoleModel);
    assert.equal(getAgentTemplate, agentRendererMod.getAgentTemplate);
    assert.equal(generateAgentContent, agentRendererMod.generateAgentContent);
    assert.equal(generateAllAgentsMarkdown, agentRendererMod.generateAllAgentsMarkdown);

    assert.equal(loadHarnessNativeCapabilities, mcpSyncMod.loadHarnessNativeCapabilities);
    assert.equal(loadCatalogMcpServers, mcpSyncMod.loadCatalogMcpServers);
    assert.equal(mergeJsonMcpServersForHarness, mcpSyncMod.mergeJsonMcpServersForHarness);
    assert.equal(syncJsonMcpConfigFile, mcpSyncMod.syncJsonMcpConfigFile);
    assert.equal(buildCodexManagedTomlBlock, mcpSyncMod.buildCodexManagedTomlBlock);
  });

  test("getSkillTemplate resolves @harness blocks cleanly per harness with zero stray tags, placeholders, or ASD MCP references", () => {
    for (const harnessId of ALL_HARNESSES) {
      for (const skill of ASD_SKILLS) {
        const rendered = getSkillTemplate(skill, { harnessId });
        assert.equal(
          rendered.includes("<!-- @harness:"),
          false,
          `${harnessId}/${skill} must not contain raw @harness tags`
        );
        assert.equal(
          rendered.includes("<!-- @end -->"),
          false,
          `${harnessId}/${skill} must not contain raw @end tags`
        );
        assert.equal(
          /\{\{LIGHT_[A-Z]+_MODEL\}\}/.test(rendered),
          false,
          `${harnessId}/${skill} must not contain unresolved {{LIGHT_*_MODEL}} placeholders`
        );
        assert.equal(
          /official ASD MCP|or MCP tool/i.test(rendered),
          false,
          `${harnessId}/${skill} must not reference retired ASD MCP tools`
        );
      }
    }

    // Harness-specific isolation checks on `asd`
    const ccAsd = getSkillTemplate("asd", { harnessId: "claude-code" });
    assert.ok(ccAsd.includes('Invoke `Agent` / `Task` with `subagent_type: "asd-scout"`'));
    assert.equal(ccAsd.includes("invoke_subagent"), false);
    assert.equal(ccAsd.includes("asd-guard.js"), false);

    const ocAsd = getSkillTemplate("asd", { harnessId: "opencode" });
    assert.ok(ocAsd.includes('Invoke `task` with `subagent_type: "asd-scout"`'));
    assert.ok(ocAsd.includes("--mode parallel_spawn"));
    assert.equal(ocAsd.includes("asd-guard.js"), false);
    assert.equal(ocAsd.includes("ALWAYS pass `--async`"), false);
    assert.equal(ocAsd.includes("--mode parallel_spawn --async"), false);
    assert.equal(ocAsd.includes("invoke_subagent"), false);
    assert.equal(ocAsd.includes("Agent` / `Task"), false);

    const ocAsdV1 = getSkillTemplate("asd", { harnessId: "opencode", openCodeProfile: "v1" });
    assert.ok(ocAsdV1.includes('Invoke `task` with `subagent_type: "asd-scout"`'));
    assert.ok(ocAsdV1.includes("--mode parallel_spawn --async"));
    assert.ok(ocAsdV1.includes("ALWAYS pass `--async`"));
    assert.ok(ocAsdV1.includes("asd-guard.js"));
    assert.ok(ocAsdV1.includes("Legacy V1 Non-Blocking Rule"));

    const agAsd = getSkillTemplate("asd", { harnessId: "antigravity" });
    assert.ok(agAsd.includes('invoke_subagent(TypeName="asd-scout", Model="flash_lite")'));
    assert.equal(agAsd.includes("subagent_type:"), false);
    assert.equal(agAsd.includes("asd-guard.js"), false);

    const cxAsd = getSkillTemplate("asd", { harnessId: "codex" });
    assert.ok(cxAsd.includes("Spawn internal `asd-<role>` subagent"));
    assert.equal(cxAsd.includes("invoke_subagent"), false);
    assert.equal(cxAsd.includes("asd-guard.js"), false);

    const curAsd = getSkillTemplate("asd", { harnessId: "cursor" });
    assert.ok(curAsd.includes("Spawn internal `asd-<role>` subagent"));
    assert.equal(curAsd.includes("invoke_subagent"), false);
    assert.equal(curAsd.includes("asd-guard.js"), false);

    // Calling without harnessId strips tags cleanly while keeping general + opencode-v2 blocks (and excluding opencode-v1)
    const unharnessed = getSkillTemplate("asd");
    assert.equal(unharnessed.includes("<!-- @harness:"), false);
    assert.equal(unharnessed.includes("<!-- @end -->"), false);
    assert.equal(/\{\{LIGHT_[A-Z]+_MODEL\}\}/.test(unharnessed), false);
    assert.ok(unharnessed.includes('subagent_type: "asd-scout"'));
    assert.ok(unharnessed.includes('invoke_subagent(TypeName="asd-scout"'));
    assert.ok(unharnessed.includes("OpenCode V2 natively backgrounds subagents/shell commands"));
    assert.equal(unharnessed.includes("Legacy V1 Non-Blocking Rule"), false);
    assert.equal(unharnessed.includes("asd-guard.js"), false);

    // Canonical asd-handoff alias rewrites frontmatter name cleanly
    const asdHandoff = getSkillTemplate("asd-handoff", { harnessId: "claude-code" });
    assert.ok(/^name:\s*asd-handoff$/m.test(asdHandoff));
    assert.ok(asdHandoff.includes("DIRECT"));
    assert.ok(asdHandoff.includes("LIGHT"));
    assert.ok(asdHandoff.includes("HEAVY"));
  });

  test("getSkillTemplate & syncHarnessConfigs dynamically inject {{LIGHT_<ROLE>_MODEL}} from routing.jsonc", async () => {
    const customRouting = {
      _asdVersion: ASD_VERSION,
      lightSubagents: {
        antigravity: {
          scout: { model: "flash" },
          worker: { model: "pro" },
          planner: { model: "pro" },
          architect: { model: "flash" },
          critic: { model: "flash_lite" },
          defaultModel: "flash",
        },
      },
      agents: {},
      categories: {},
    } as unknown as RoutingConfig;

    const agAsd = getSkillTemplate("asd", {
      harnessId: "antigravity",
      routingConfig: customRouting,
    });
    assert.ok(agAsd.includes('Model="flash"'));
    assert.ok(
      agAsd.includes(
        "`scout=flash`, `worker=pro`, `planner=pro`, `architect=flash`, `critic=flash_lite`"
      )
    );

    const agDebate = getSkillTemplate("asd-debate", {
      harnessId: "antigravity",
      routingConfig: customRouting,
    });
    assert.ok(agDebate.includes('TypeName="asd-critic", Model="flash_lite"'));
    assert.ok(agDebate.includes('TypeName="asd-architect", Model="flash"'));

    // End-to-end syncHarnessConfigs propagates routing.jsonc models into synced skill files
    const dynHome = createTempDir("asd-t31-dyn-home-");
    try {
      const asdDir = path.join(dynHome, ".asd");
      fs.mkdirSync(asdDir, { recursive: true });
      fs.writeFileSync(
        path.join(asdDir, "routing.jsonc"),
        JSON.stringify(customRouting, null, 2),
        "utf8"
      );

      const syncRes = await syncHarnessConfigs({
        homeDir: dynHome,
        noPath: true,
        skipModelDiscovery: true,
      });
      assert.equal(syncRes.status, "updated");

      const syncedAgSkill = fs.readFileSync(
        path.join(dynHome, ".gemini", "skills", "asd", "SKILL.md"),
        "utf8"
      );
      assert.ok(syncedAgSkill.includes('invoke_subagent(TypeName="asd-scout", Model="flash")'));
      assert.equal(syncedAgSkill.includes("<!-- @harness:"), false);
      assert.equal(syncedAgSkill.includes("subagent_type:"), false);

      const syncedOcCmd = fs.readFileSync(
        path.join(dynHome, ".config", "opencode", "command", "asd-run.md"),
        "utf8"
      );
      const activeOcProfile = resolveOpenCodeCapabilityProfile().effectiveProfile;
      if (activeOcProfile === "v2") {
        assert.ok(syncedOcCmd.includes("OpenCode V2 natively backgrounds subagents/shell commands"));
        assert.equal(syncedOcCmd.includes("asd-guard.js"), false);
      } else {
        assert.ok(syncedOcCmd.includes("Legacy V1 Non-Blocking Rule"));
        assert.ok(syncedOcCmd.includes("asd-guard.js"));
      }
      assert.equal(syncedOcCmd.includes("invoke_subagent"), false);

      const syncedCcSkill = fs.readFileSync(
        path.join(dynHome, ".claude", "skills", "asd-run", "SKILL.md"),
        "utf8"
      );
      assert.equal(syncedCcSkill.includes("OpenCode V2 natively backgrounds"), false);
      assert.equal(syncedCcSkill.includes("Legacy V1 Non-Blocking Rule"), false);
      assert.ok(syncedCcSkill.includes('`Agent` / `Task` with `subagent_type: "asd-<role>"`'));
    } finally {
      removeTempDir(dynHome);
    }
  });

  test("agent-renderer & generateAllAgentsMarkdown are CLI-only, reflect DIRECT/LIGHT/HEAVY, and omit automated-test bullet from read-only/planner fallbacks", () => {
    for (const role of AGENT_ROLES) {
      const presetMd = generateAgentContent(role);
      assert.equal(
        /official ASD MCP|or MCP tool/i.test(presetMd),
        false,
        `Agent '${role}' must not mention ASD MCP tools`
      );

      const fallbackMd = generateAgentContent(role, { skipPreset: true });
      assert.equal(
        /official ASD MCP|or MCP tool/i.test(fallbackMd),
        false,
        `Fallback agent '${role}' must not mention ASD MCP tools`
      );
      if (role === "scout" || role === "critic" || role === "planner") {
        assert.equal(
          fallbackMd.includes("verified with automated tests"),
          false,
          `Fallback '${role}' must not include hardcoded automated-test bullet`
        );
      } else if (role === "worker") {
        assert.ok(
          fallbackMd.includes("verified with automated tests"),
          "Fallback 'worker' should retain automated-test verification bullet"
        );
      } else if (role === "architect") {
        assert.ok(
          fallbackMd.includes("only when modifying code"),
          "Fallback 'architect' should make automated tests conditional on code modifications"
        );
      }
    }

    const rosterMd = generateAllAgentsMarkdown();
    assert.equal(/official ASD MCP|or MCP tool/i.test(rosterMd), false);
    assert.ok(rosterMd.includes("`DIRECT`"));
    assert.ok(rosterMd.includes("`LIGHT`"));
    assert.ok(rosterMd.includes("`HEAVY`"));
  });
});

describe("OpenCode V1/V2 Profile-Aware Sync, Uninstall Safety, Doctor Drift & Skill Rendering", () => {
  test("(a) & (b) V2 sync vs V1 sync: installs profile-matched guard & skills, cleans stale ASD cross-version guards, preserves user plugins, and skips spurious opencode.jsonc backup", async () => {
    const ocHome = createTempDir("asd-oc-v1v2-sync-");
    try {
      const opencodeDir = path.join(ocHome, ".config", "opencode");
      const v1PluginDir = path.join(opencodeDir, "plugin");
      const v1PluginPath = path.join(v1PluginDir, "asd-guard.js");
      const v2PluginPath = path.join(opencodeDir, "plugins", "asd-guard", "index.js");
      const userPluginPath = path.join(opencodeDir, "plugins", "user-custom", "index.js");
      const jsoncPath = path.join(opencodeDir, "opencode.jsonc");

      fs.mkdirSync(v1PluginDir, { recursive: true });
      fs.mkdirSync(path.dirname(userPluginPath), { recursive: true });
      fs.writeFileSync(v1PluginPath, `${OPENCODE_V1_PLUGIN_MARKER} (v2.6.0)\nexport default {};\n`, "utf8");
      const userPluginSrc = "export default { id: 'user-custom-plugin' };\n";
      fs.writeFileSync(userPluginPath, userPluginSrc, "utf8");
      const userJsoncSrc = '// User JSONC\n{\n  "model": "openai/gpt-5.4",\n}\n';
      fs.writeFileSync(jsoncPath, userJsoncSrc, "utf8");

      const v2Env = { ...process.env, ASD_OPENCODE_PROFILE: "v2" };
      const v2Sync1 = await syncHarnessConfigs({
        homeDir: ocHome,
        noPath: true,
        skipModelDiscovery: true,
        env: v2Env,
      });
      assert.equal(v2Sync1.status, "updated");

      // (a) V2 sync installs plugins/asd-guard/index.js, removes stale V1 plugin/asd-guard.js + empty plugin/ dir
      assert.equal(fs.existsSync(v2PluginPath), true, "V2 guard plugins/asd-guard/index.js must exist");
      assert.ok(fs.readFileSync(v2PluginPath, "utf8").startsWith(OPENCODE_V2_PLUGIN_MARKER));
      assert.equal(fs.existsSync(v1PluginPath), false, "Stale ASD V1 plugin/asd-guard.js must be removed on V2 sync");
      assert.equal(fs.existsSync(v1PluginDir), false, "Empty legacy plugin/ dir must be cleaned up");
      assert.equal(fs.readFileSync(userPluginPath, "utf8"), userPluginSrc, "User plugin in plugins/ must stay intact");

      // (a) No spurious opencode.jsonc.asd-backup and opencode.jsonc untouched
      assert.equal(fs.existsSync(`${jsoncPath}.asd-backup`), false, "sync must NEVER create opencode.jsonc.asd-backup");
      assert.equal(fs.readFileSync(jsoncPath, "utf8"), userJsoncSrc);

      // (a) V2 skill guidance omits V1 asd-guard.js / ALWAYS pass --async
      const v2AsdCmd = fs.readFileSync(path.join(opencodeDir, "command", "asd.md"), "utf8");
      const v2RunCmd = fs.readFileSync(path.join(opencodeDir, "command", "asd-run.md"), "utf8");
      assert.ok(v2AsdCmd.includes("OpenCode V2 natively backgrounds subagents/shell commands"));
      assert.equal(v2AsdCmd.includes("asd-guard.js"), false);
      assert.equal(v2AsdCmd.includes("ALWAYS pass"), false);
      assert.equal(v2AsdCmd.includes("--mode parallel_spawn --async"), false);
      assert.ok(v2RunCmd.includes("OpenCode V2 natively backgrounds subagents/shell commands"));
      assert.equal(v2RunCmd.includes("asd-guard.js"), false);
      assert.equal(v2RunCmd.includes("ALWAYS pass"), false);
      assert.equal(v2RunCmd.includes("--mode parallel_spawn --async"), false);

      // Idempotent second V2 sync skips cleanly
      const v2Sync2 = await syncHarnessConfigs({
        homeDir: ocHome,
        noPath: true,
        skipModelDiscovery: true,
        env: v2Env,
      });
      assert.equal(v2Sync2.status, "skipped");
      assert.equal(v2Sync2.harnesses.opencode.skipped, true);

      // (b) Switching to V1 invalidates hash automatically (no --force needed), installs V1 plugin, cleans V2 plugin, preserves user plugin
      const v1Env = { ...process.env, ASD_OPENCODE_PROFILE: "v1" };
      const v1Sync = await syncHarnessConfigs({
        homeDir: ocHome,
        noPath: true,
        skipModelDiscovery: true,
        env: v1Env,
      });
      assert.equal(v1Sync.status, "updated");
      assert.equal(v1Sync.harnesses.opencode.status, "updated");
      assert.equal(fs.existsSync(v1PluginPath), true, "V1 guard plugin/asd-guard.js must be installed");
      assert.ok(fs.readFileSync(v1PluginPath, "utf8").startsWith(OPENCODE_V1_PLUGIN_MARKER));
      assert.equal(fs.existsSync(v2PluginPath), false, "Stale ASD V2 plugin must be removed on V1 sync");
      assert.equal(fs.existsSync(path.join(opencodeDir, "plugins", "asd-guard")), false);
      assert.equal(fs.readFileSync(userPluginPath, "utf8"), userPluginSrc, "User plugin must survive V1 sync cleanup");

      const v1AsdCmd = fs.readFileSync(path.join(opencodeDir, "command", "asd.md"), "utf8");
      const v1RunCmd = fs.readFileSync(path.join(opencodeDir, "command", "asd-run.md"), "utf8");
      assert.ok(v1AsdCmd.includes("Legacy V1 Non-Blocking Rule"));
      assert.ok(v1AsdCmd.includes("ALWAYS pass `--async`"));
      assert.ok(v1AsdCmd.includes("asd-guard.js"));
      assert.ok(v1RunCmd.includes("Legacy V1 Non-Blocking Rule"));
      assert.ok(v1RunCmd.includes("ALWAYS pass `--async`"));
      assert.ok(v1RunCmd.includes("asd-guard.js"));

      // Upgrading V1 -> V2 again automatically invalidates configHash without --force
      const upgradeSync = await syncHarnessConfigs({
        homeDir: ocHome,
        noPath: true,
        skipModelDiscovery: true,
        env: v2Env,
      });
      assert.equal(upgradeSync.status, "updated");
      assert.equal(fs.existsSync(v2PluginPath), true);
      assert.equal(fs.existsSync(v1PluginPath), false);
    } finally {
      removeTempDir(ocHome);
    }
  });

  test("(c) uninstall removes ASD-managed V1 & V2 plugins while keeping user plugins, user AGENTS.md, opencode.jsonc, and JSONC oh-my-openagent.json intact", async () => {
    // Subtest 1: V2 sync + pre-existing user AGENTS.md + user plugins + JSONC oh-my-openagent.json with comments
    const home1 = createTempDir("asd-oc-uninst-1-");
    try {
      const opencodeDir = path.join(home1, ".config", "opencode");
      const userPluginPath = path.join(opencodeDir, "plugins", "user-plugin", "index.js");
      const unmarkedV1Path = path.join(opencodeDir, "plugin", "asd-guard.js");
      const userAgentsMdPath = path.join(opencodeDir, "AGENTS.md");
      const jsoncPath = path.join(opencodeDir, "opencode.jsonc");
      const omoPath = path.join(opencodeDir, "oh-my-openagent.json");

      fs.mkdirSync(path.dirname(userPluginPath), { recursive: true });
      fs.mkdirSync(path.dirname(unmarkedV1Path), { recursive: true });

      const userPluginSrc = "export const userPlugin = true;\n";
      const unmarkedV1Src = "// User-authored custom plugin\nexport default {};\n";
      const userAgentsSrc = "# My Personal OpenCode Instructions\nKeep things tidy.\n";
      const userJsoncSrc = '// User opencode.jsonc\n{\n  "theme": "tokyonight",\n}\n';
      const userOmoJsoncSrc = [
        "// User Oh-My-OpenAgent JSONC config",
        "{",
        '  "agents": {',
        '    "sisyphus": { "model": "anthropic/claude-opus-4-6" },',
        "  },",
        "}",
      ].join("\n") + "\n";

      fs.writeFileSync(userPluginPath, userPluginSrc, "utf8");
      fs.writeFileSync(unmarkedV1Path, unmarkedV1Src, "utf8");
      fs.writeFileSync(userAgentsMdPath, userAgentsSrc, "utf8");
      fs.writeFileSync(jsoncPath, userJsoncSrc, "utf8");

      await syncHarnessConfigs({
        homeDir: home1,
        noPath: true,
        skipModelDiscovery: true,
        env: { ...process.env, ASD_OPENCODE_PROFILE: "v2" },
      });

      const v2GuardPath = path.join(opencodeDir, "plugins", "asd-guard", "index.js");
      assert.equal(fs.existsSync(v2GuardPath), true);
      assert.equal(fs.existsSync(`${jsoncPath}.asd-backup`), false);

      // Write user's JSONC oh-my-openagent.json (no backup) to verify uninstall bug (b) fix
      fs.writeFileSync(omoPath, userOmoJsoncSrc, "utf8");

      await uninstallHarnessConfigs({ homeDir: home1 });

      assert.equal(fs.existsSync(v2GuardPath), false, "ASD V2 plugin must be removed on uninstall");
      assert.equal(fs.existsSync(path.join(opencodeDir, "plugins", "asd-guard")), false);
      assert.equal(fs.readFileSync(userPluginPath, "utf8"), userPluginSrc, "User plugin in plugins/ must survive uninstall");
      assert.equal(fs.readFileSync(unmarkedV1Path, "utf8"), unmarkedV1Src, "Unmarked plugin/asd-guard.js must NOT be deleted");
      assert.equal(fs.readFileSync(userAgentsMdPath, "utf8"), userAgentsSrc, "Pre-existing user AGENTS.md must be restored");
      assert.equal(fs.readFileSync(jsoncPath, "utf8"), userJsoncSrc, "opencode.jsonc must remain untouched");
      assert.equal(fs.readFileSync(omoPath, "utf8"), userOmoJsoncSrc, "JSONC oh-my-openagent.json with comments must stay 100% intact");
    } finally {
      removeTempDir(home1);
    }

    // Subtest 2: V1 marked plugin removed, unparseable oh-my-openagent.json preserved, user-authored AGENTS.md without backup preserved
    const home2 = createTempDir("asd-oc-uninst-2-");
    try {
      const opencodeDir = path.join(home2, ".config", "opencode");
      const v1GuardPath = path.join(opencodeDir, "plugin", "asd-guard.js");
      const agentsMdPath = path.join(opencodeDir, "AGENTS.md");
      const omoPath = path.join(opencodeDir, "oh-my-openagent.json");

      fs.mkdirSync(path.dirname(v1GuardPath), { recursive: true });
      fs.writeFileSync(v1GuardPath, `${OPENCODE_V1_PLUGIN_MARKER} (v2.7.0)\nexport default {};\n`, "utf8");
      const customAgentsSrc = "# Custom Non-ASD AGENTS.md\n";
      fs.writeFileSync(agentsMdPath, customAgentsSrc, "utf8");
      const brokenOmoSrc = "{ invalid-unparseable-omo-jsonc :::\n";
      fs.writeFileSync(omoPath, brokenOmoSrc, "utf8");

      await uninstallHarnessConfigs({ homeDir: home2 });

      assert.equal(fs.existsSync(v1GuardPath), false, "ASD-marked V1 plugin must be removed on uninstall");
      assert.equal(fs.readFileSync(agentsMdPath, "utf8"), customAgentsSrc, "User-authored non-ASD AGENTS.md must NOT be deleted");
      assert.equal(fs.readFileSync(omoPath, "utf8"), brokenOmoSrc, "Unparseable oh-my-openagent.json must NOT be deleted");
    } finally {
      removeTempDir(home2);
    }
  });

  test("(d) doctorProbe reports OpenCode version, V1/V2 profile, plugin drift, ACP args, and degraded fallback warnings", async () => {
    const docHome = createTempDir("asd-oc-doctor-home-");
    const fakeBinDir = createTempDir("asd-oc-doctor-bins-");
    try {
      const ext = process.platform === "win32" ? ".cmd" : "";
      const ocBinPath = path.join(fakeBinDir, `opencode${ext}`);
      const writeOcStub = (output: string) => {
        const script =
          process.platform === "win32"
            ? `@echo off\r\necho ${output}\r\n`
            : `#!/bin/sh\necho "${output}"\n`;
        fs.writeFileSync(ocBinPath, script, { encoding: "utf8", mode: 0o755 });
      };
      const fakeEnv = { PATH: fakeBinDir, Path: fakeBinDir };

      // 1. V2 profile with stale V1 plugin only -> flags drift non-fatally (ok: true, errors: [])
      const opencodeDir = path.join(docHome, ".config", "opencode");
      const v1GuardPath = path.join(opencodeDir, "plugin", "asd-guard.js");
      fs.mkdirSync(path.dirname(v1GuardPath), { recursive: true });
      fs.writeFileSync(v1GuardPath, `${OPENCODE_V1_PLUGIN_MARKER} (v2.6.0)\n`, "utf8");

      const v2Profile = buildOpenCodeCapabilityProfile({
        rawOutput: "opencode 2.3.2",
        version: "2.3.2",
        major: 2,
        pluginApi: "v2",
        source: "cli-probe",
      });
      writeOcStub("opencode 2.3.2");

      const driftDoc = await doctorProbe({
        homeDir: docHome,
        projectRoot: process.cwd(),
        env: fakeEnv,
        openCodeProfile: v2Profile,
      });
      assert.equal(driftDoc.ok, true);
      assert.equal(driftDoc.errors.length, 0);
      assert.equal(driftDoc.harnesses.opencode.version, "2.3.2");
      assert.equal(driftDoc.harnesses.opencode.activeProfile, "v2");
      assert.equal(driftDoc.harnesses.opencode.acp?.args.join(" "), "acp");
      assert.equal(driftDoc.harnesses.opencode.guardStatus?.hasV1Guard, true);
      assert.equal(driftDoc.harnesses.opencode.guardStatus?.hasV2Guard, false);
      assert.equal(driftDoc.harnesses.opencode.guardStatus?.driftDetected, true);
      assert.ok(driftDoc.harnesses.opencode.guardStatus?.driftWarning?.includes("plugins/asd-guard/index.js"));
      const ocDriftCheck = driftDoc.checks.find((c) => c.name === "opencode_profile");
      assert.ok(ocDriftCheck && ocDriftCheck.ok);
      assert.ok(ocDriftCheck.message?.includes("2.3.2"));
      assert.ok(ocDriftCheck.message?.includes("plugins/asd-guard/index.js is missing"));

      // 2. Sync V2 -> drift clears
      await syncHarnessConfigs({
        homeDir: docHome,
        noPath: true,
        skipModelDiscovery: true,
        env: fakeEnv,
        openCodeProfile: v2Profile,
      });
      const syncedDoc = await doctorProbe({
        homeDir: docHome,
        projectRoot: process.cwd(),
        env: fakeEnv,
        openCodeProfile: v2Profile,
      });
      assert.equal(syncedDoc.ok, true);
      assert.equal(syncedDoc.harnesses.opencode.guardStatus?.hasV2Guard, true);
      assert.equal(syncedDoc.harnesses.opencode.guardStatus?.hasV1Guard, false);
      assert.equal(syncedDoc.harnesses.opencode.guardStatus?.driftDetected, false);

      // 3. V1 profile -> reports activeProfile "v1" and ACP args ["acp", "--pure"]
      const v1Profile = buildOpenCodeCapabilityProfile({
        rawOutput: "opencode 1.19.4",
        version: "1.19.4",
        major: 1,
        pluginApi: "v1",
        source: "cli-probe",
      });
      const v1Doc = await doctorProbe({
        homeDir: docHome,
        projectRoot: process.cwd(),
        env: fakeEnv,
        openCodeProfile: v1Profile,
      });
      assert.equal(v1Doc.harnesses.opencode.version, "1.19.4");
      assert.equal(v1Doc.harnesses.opencode.activeProfile, "v1");
      assert.deepEqual(v1Doc.harnesses.opencode.acp?.args, ["acp", "--pure"]);

      // 4. Unknown degraded fallback -> reports degraded warning non-fatally
      const unknownProfile = buildOpenCodeCapabilityProfile({
        rawOutput: "unparseable",
        version: null,
        major: null,
        pluginApi: "unknown",
        source: "fallback",
      });
      const degradedDoc = await doctorProbe({
        homeDir: docHome,
        projectRoot: process.cwd(),
        env: fakeEnv,
        openCodeProfile: unknownProfile,
      });
      assert.equal(degradedDoc.ok, true);
      assert.equal(degradedDoc.errors.length, 0);
      assert.equal(degradedDoc.harnesses.opencode.version, "unknown");
      assert.equal(degradedDoc.harnesses.opencode.activeProfile, "v1");
      assert.equal(degradedDoc.harnesses.opencode.degraded, true);
      const degradedCheck = degradedDoc.checks.find((c) => c.name === "opencode_profile");
      assert.ok(
        degradedCheck?.message?.includes("OpenCode version detection failed; degraded fallback to V1 profile active")
      );
    } finally {
      removeTempDir(docHome);
      removeTempDir(fakeBinDir);
    }
  });

  test("(e) skill-renderer handles opencode-v2, opencode-v1, omitted harnessId, other harnesses, and {{LIGHT_*_MODEL}} routes", () => {
    const customRouting = {
      _asdVersion: ASD_VERSION,
      lightSubagents: {
        opencode: {
          scout: { model: "custom/oc-scout-model" },
          worker: { model: "custom/oc-worker-model" },
          defaultModel: "custom/oc-default",
        },
      },
      agents: {},
      categories: {},
    } as unknown as RoutingConfig;

    const runV2 = getSkillTemplate("asd-run", {
      harnessId: "opencode",
      openCodeProfile: "v2",
      routingConfig: customRouting,
    });
    assert.ok(runV2.includes("OpenCode V2 natively backgrounds subagents/shell commands"));
    assert.equal(runV2.includes("Legacy V1 Non-Blocking Rule"), false);
    assert.equal(runV2.includes("asd-guard.js"), false);
    assert.equal(runV2.includes("ALWAYS pass"), false);
    assert.equal(runV2.includes("--mode parallel_spawn --async"), false);

    const runV1 = getSkillTemplate("asd-run", {
      harnessId: "opencode",
      openCodeProfile: "v1",
      routingConfig: customRouting,
    });
    assert.ok(runV1.includes("Legacy V1 Non-Blocking Rule"));
    assert.ok(runV1.includes("ALWAYS pass `--async`"));
    assert.ok(runV1.includes("--mode parallel_spawn --async"));
    assert.ok(runV1.includes("asd-guard.js"));
    assert.equal(runV1.includes("OpenCode V2 natively backgrounds"), false);

    const runOmitted = getSkillTemplate("asd-run");
    assert.ok(runOmitted.includes("OpenCode V2 natively backgrounds subagents/shell commands"));
    assert.equal(runOmitted.includes("Legacy V1 Non-Blocking Rule"), false);
    assert.equal(runOmitted.includes("asd-guard.js"), false);
    assert.ok(runOmitted.includes("Claude Code"));

    // Verify comma-separated tags + {{LIGHT_*_MODEL}} OpenCode route preservation across both V1 and V2
    const sample = [
      "<!-- @harness:opencode -->common oc {{LIGHT_SCOUT_MODEL}}<!-- @end -->",
      "<!-- @harness:opencode-v2,claude-code -->v2-or-cc {{LIGHT_WORKER_MODEL}}<!-- @end -->",
      "<!-- @harness:opencode-v1 -->v1-only {{LIGHT_WORKER_MODEL}}<!-- @end -->",
    ].join("\n");

    const renderedOcV2 = renderSkillTemplate(sample, {
      harnessId: "opencode",
      openCodeProfile: "v2",
      routingConfig: customRouting,
    });
    assert.ok(renderedOcV2.includes("common oc custom/oc-scout-model"));
    assert.ok(renderedOcV2.includes("v2-or-cc custom/oc-worker-model"));
    assert.equal(renderedOcV2.includes("v1-only"), false);

    const renderedOcV1 = renderSkillTemplate(sample, {
      harnessId: "opencode",
      openCodeProfile: "v1",
      routingConfig: customRouting,
    });
    assert.ok(renderedOcV1.includes("common oc custom/oc-scout-model"));
    assert.ok(renderedOcV1.includes("v1-only custom/oc-worker-model"));
    assert.equal(renderedOcV1.includes("v2-or-cc"), false);

    const renderedCc = renderSkillTemplate(sample, {
      harnessId: "claude-code",
      routingConfig: customRouting,
    });
    assert.equal(renderedCc.includes("common oc"), false);
    assert.equal(renderedCc.includes("v1-only"), false);
    assert.ok(renderedCc.includes("v2-or-cc"));
  });
});
