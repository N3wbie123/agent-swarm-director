# ASD v2.7.0 Model Routing Configuration Guide (`routing.jsonc`)

**English** | [한국어](./ROUTING_GUIDE_ko.md) | [📖 Back to README](./README.md)

ASD (Agent Swarm Director v2.7.0) routes models across its 3-track execution model: **`DIRECT`** (main session executes directly), **`LIGHT` mode** (`lightSubagents` — internal subagent delegation within the active harness), and **`HEAVY` mode** (`agents` & `categories` — external ACP/CLI parallel process spawning & cross-model blind debate).

---

## 1. Configuration File Locations & Precedence

ASD loads `routing.jsonc` in the following order of precedence:

1. **Project-Local Configuration (Priority 1)**: `<project-root>/.asd/routing.jsonc`
   - Create this file when you want a custom model or fallback configuration for a specific project only.
2. **User Global Configuration (Default)**: `~/.asd/routing.jsonc` (Windows: `C:\Users\<user>\.asd\routing.jsonc`)
   - The global configuration applied across all projects by default.

> [!IMPORTANT]
> **When Configuration Changes Take Effect (`LIGHT` Mode)**:
> - Whenever ASD runs `asd plan`, `asd dispatch`, or saves routing configuration in the dashboard (`asd ui`), it automatically detects changes to `routing.jsonc` and **immediately updates** the `model:` field in each harness's agent Markdown files (`~/.claude/agents/asd-*.md`, `~/.config/opencode/agent/asd-*.md`, `~/.gemini/config/agents/asd-*.md`, `~/.cursor/agents/asd-*.md`). Running `asd sync --force` manually performs the same update.
> - **Mid-Session Reload Behavior by Harness**:
>   - **Antigravity / Codex / Cursor**: Reads `routing.jsonc` in real time during `PreToolUse` hooks and dispatch briefings, so changes **take effect immediately in the active session**.
>   - **Claude Code**: Supports both file watching and `model` parameter injection on the `Agent` tool, so changes **take effect immediately in the active session without restarting**.
>   - **OpenCode**: OpenCode's native `Task` tool does not accept a runtime model parameter and caches `.md` agent definitions in memory at session startup (lazy-loaded and pinned). **If you edit `routing.jsonc` mid-session, you must restart OpenCode (or start a new session)** for the updated `model:` to apply.

---

## 2. `LIGHT` Mode vs `HEAVY` Mode Routing Structure at a Glance

| Dimension | `lightSubagents` (`LIGHT` Mode Only) | `agents` & `categories` / `heavyRouting` (`HEAVY` Mode Only) |
| :--- | :--- | :--- |
| **When Active** | Single-harness internal subagent delegation (`invoke_subagent`, `Task`, `task`), `PreToolUse` forced model replacement (`overwrite`), `asd sync` agent file generation | `asd dispatch --mode parallel_spawn` (external CLI multi-process spawn), `asd debate` (cross-harness debate) |
| **Cross-Harness Switching** | **Pinned to the currently active harness** (e.g., inside Antigravity, only Antigravity subagents run) | **Cross-harness execution enabled** (e.g., if Priority 1 OpenCode fails, falls back to Priority 2 Codex CLI) |
| **Model Identifier Format** | **Native model tier/ID** recognized by each harness (`flash_lite`, `flash`, `pro`, `haiku`, `sonnet`, `opus`, etc.) | **Full canonical model string** passed to each CLI's `--model` flag (`claude-sonnet-4-6`, `gpt-5-codex`, `glm-5`, etc.) |

---

## 3. Configuring `lightSubagents` (`LIGHT` Mode + Fallbacks)

`lightSubagents` defines the primary model and **same-harness fallback model order** for the 5 specialist roles (`scout`, `worker`, `planner`, `architect`, `critic`) and `defaultModel` inside each harness (`antigravity`, `claude-code`, `opencode`, `codex`, `cursor`).

### 3.1. Three Supported Notations (Interchangeable)

You can freely use any of the following three formats for each role (`worker`, `scout`, etc.) and `defaultModel`:

1. **Single String Notation (Primary model only)**
   ```jsonc
   "worker": "flash"
   ```
2. **Array Notation (`[primary, fallback1, fallback2, ...]`)**
   ```jsonc
   "worker": ["flash", "flash_lite", "pro"]
   ```
3. **Object Notation (`{ "model": "primary", "fallbacks": ["fallback1", "fallback2"] }`)**
   ```jsonc
   "worker": { "model": "flash", "fallbacks": ["flash_lite", "pro"] }
   ```
4. **Harness-Wide Common Fallbacks (`"fallbacks"` array)**
   - Adding `"fallbacks": ["flash_lite"]` at the harness block level automatically appends those fallbacks after each role's individual fallback list (deduplicated).

---

### 3.2. Why Do Model Value Formats and Default Examples Differ Across Harnesses?

1. **JSON Notation Differences (`"string"` vs `{ "model", "fallbacks" }`)**:
   - In the default generated `routing.jsonc`, `antigravity` and `claude-code` define role-specific default fallbacks and therefore use the `{ "model": "...", "fallbacks": [...] }` object form, whereas `opencode` has empty role-level fallbacks by default and uses the shorthand string form `"scout": "glm-5"`.
   - **All 5 harnesses** support all three notations from Section 3.1 (single string / array / `{ model, fallbacks }` object) and all role keys (`scout`, `worker`, `planner`, `architect`, `critic`, `defaultModel`) **100% identically**.
2. **Harness-Specific Allowed Model Identifier Rules**:

| Harness | Accepted Model Value Format | Reason & Mechanism |
| :--- | :--- | :--- |
| **Antigravity** | `"flash_lite"`, `"flash"`, `"pro"` | Antigravity's built-in `invoke_subagent` tool enforces a strict schema of `enum: ["inherit", "flash_lite", "flash", "pro"]` on its `Model` parameter. Even if you accidentally specify `"gemini-3.8-flash"` or `"inherit"`, the ASD router automatically normalizes it to one of the 3 explicit tiers above to protect the parent model's quota. |
| **Claude Code** | `"haiku"`, `"sonnet"`, `"opus"` or full model ID (`"claude-sonnet-4-6"`, etc.) | Claude Code's `Agent` tool and `~/.claude/agents/asd-*.md` frontmatter (`model:`) accept both shorthand tier aliases and full canonical model IDs. |
| **OpenCode** | `"provider/model"` or model ID (`"glm-5"`, `"nvidia/z-ai/glm-5.3-flash"`, etc.) | OpenCode has no tier aliases like `haiku` or `flash`; the actual provider/model ID must be written directly into the `model:` field of `~/.config/opencode/agent/asd-*.md`. |
| **Codex CLI** | Full model ID (`"gpt-5-codex"`, `"gpt-6-luna"`, etc.) | Full model names are injected into Codex subagent briefings and `AGENTS.md` model instructions. |
| **Cursor CLI** | Full model ID (`"claude-sonnet-4-6"`, `"gpt-5.4"`, etc.) | Full model names are used in `~/.cursor/agents/asd-*.md` and `PreToolUse` hook validation. |

```jsonc
{
  "_asdVersion": "2.7.0",
  "lightSubagents": {
    // 1) Antigravity: Must use one of "flash_lite" | "flash" | "pro".
    //    (Even if "inherit" or "gemini-3.8-flash" is written, ASD automatically normalizes it
    //     to one of the 3 tiers above to prevent exhausting the parent Gemini 4 Argon weekly quota.)
    "antigravity": {
      "scout": { "model": "flash_lite", "fallbacks": ["flash"] },
      "worker": { "model": "flash", "fallbacks": ["flash_lite", "pro"] },
      "planner": ["flash", "pro"],
      "architect": { "model": "pro", "fallbacks": ["flash"] },
      "critic": { "model": "pro", "fallbacks": ["flash"] },
      "defaultModel": "flash",
      "fallbacks": ["flash_lite"]
    },

    // 2) Claude Code: "haiku" | "sonnet" | "opus" (or full claude-* model ID)
    "claude-code": {
      "scout": { "model": "haiku", "fallbacks": ["sonnet"] },
      "worker": { "model": "sonnet", "fallbacks": ["haiku", "opus"] },
      "planner": { "model": "sonnet", "fallbacks": ["opus"] },
      "architect": { "model": "opus", "fallbacks": ["sonnet"] },
      "critic": { "model": "opus", "fallbacks": ["sonnet"] },
      "defaultModel": "sonnet",
      "fallbacks": ["haiku"]
    },

    // 3) OpenCode: Supports provider/model format (single string, array, or object all supported)
    "opencode": {
      "scout": "nvidia/z-ai/glm-5.3-flash",
      "worker": {
        "model": "nvidia/z-ai/glm-5.3-flash",
        "fallbacks": ["nvidia/deepseek-ai/deepseek-v4.1-flash", "glm-5"]
      },
      "planner": "nvidia/z-ai/glm-5.3-flash",
      "architect": "nvidia/z-ai/glm-5.3-flash",
      "critic": "nvidia/z-ai/glm-5.3-flash",
      "defaultModel": "nvidia/z-ai/glm-5.3-flash",
      "fallbacks": ["glm-5"]
    },

    // 4) Codex CLI (applies defaultModel when role keys are omitted; scout/worker etc. can be specified individually)
    "codex": {
      "defaultModel": "gpt-6-luna",
      "fallbacks": ["gpt-6.1-sol"]
    },

    // 5) Cursor CLI (applies defaultModel when role keys are omitted; scout/worker etc. can be specified individually)
    "cursor": {
      "defaultModel": "claude-sonnet-4-6",
      "fallbacks": ["gpt-5.4"]
    }
  }
}
```

### 3.3. Overriding External Plugin Subagent Models in Antigravity (`explore`, `sisyphus-junior`, etc.)

Antigravity's `PreToolUse` hook intercepts `Model: "inherit"` and replaces it with a lightweight tier not only for `asd-*` agents, but also when external plugin subagents (such as OMO) are invoked via `invoke_subagent`.
If you want to map a specific external subagent name (`TypeName`) directly, add its key inside `lightSubagents.antigravity`:

```jsonc
"antigravity": {
  "scout": "flash_lite",
  "worker": "flash",
  "explore": "flash_lite",
  "librarian": "flash_lite",
  "sisyphus-junior": ["flash", "flash_lite"],
  "oracle": "pro"
}
```

---

## 4. Configuring `HEAVY` Mode (`agents` & `categories` or `heavyRouting`)

`HEAVY` mode (`asd dispatch --mode parallel_spawn` and `asd debate`), which spawns external CLIs via multi-process + Git Worktrees, uses the `agents` and `categories` blocks (or the `heavyRouting: { agents, categories }` wrapper).

- **`agents`**: Priority 1 harness/model and cross-harness `fallbacks` array for each specialist role (`planner`, `architect`, `worker`, `scout`, `critic`)
- **`categories`**:
  - Domain categories: `visual-ui`, `design`, `research`, `writing`, `general`
  - Difficulty tiers (used when role is `worker` + category is `general`): `low`, `medium`, `high`

```jsonc
{
  "agents": {
    "worker": {
      "harness": "opencode",
      "model": "nvidia/z-ai/glm-5.3-flash",
      "modelFamily": "glm",
      "fallbacks": [
        { "harness": "codex", "model": "gpt-6-luna", "modelFamily": "gpt" },
        { "harness": "claude-code", "model": "claude-sonnet-4-6", "modelFamily": "claude" }
      ]
    }
  }
}
```

---

## 5. Specifying Participating Harnesses, Roles, and Count in `/asd-debate` (`HEAVY` Mode)

When running `/asd-debate` in `HEAVY` mode (external CLI blind debate), the AI first asks for **which harnesses and how many participants** to include. You can specify them explicitly or ask the AI to **auto-assign** (autonomous selection or `routing.jsonc` role-based assignment).

1. **Directly Specify Participating Harnesses (`--harnesses`)**:
   - Specify harness names without typing full model IDs; ASD automatically maps each harness to its primary model and fallbacks configured in `routing.jsonc`.
   ```bash
   asd debate --topic "Architecture verification" --proposal "..." --harnesses "opencode,codex,claude-code" --diff
   ```
2. **Role-Based Assignment from `routing.jsonc` (`--roles`)**:
   - Assign specific roles (`critic`, `architect`, `planner`, `worker`, `scout`) defined under `agents` in `routing.jsonc`.
   ```bash
   asd debate --topic "Security and design review" --proposal "..." --roles "critic,architect,planner" --diff
   ```
3. **Specify Participant Count (`--count`) or Explicit Models (`--models`)**:
   ```bash
   # Auto-select 3 roles from routing.jsonc prioritizing model-family diversity
   asd debate --topic "Design review" --proposal "..." --count 3

   # Explicitly specify role@harness:model
   asd debate --topic "Design review" --proposal "..." --models "critic@opencode:nvidia/z-ai/glm-5.3-flash,architect@codex:gpt-6.1-sol"
   ```

---

## 6. Commands to Apply and Verify Configuration Changes

1. **Synchronize Global Harnesses and Standalone Runtime**:
   ```bash
   asd sync --force
   ```
2. **Check Current Status and Diagnostics**:
   ```bash
   asd doctor
   ```
3. **Visually Inspect and Edit in the Web Dashboard (`asd ui`)**:
   ```bash
   asd ui
   ```
   - Click **Edit Routing** in the browser to save a project-specific `.asd/routing.jsonc`, or test **Fallback Execution (`fallback`)** / **Custom Execution (`custom`)** in the Subagent Inspector.
