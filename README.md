<p>
  <img src="banner.png" alt="pi-prompt-template-model" width="1100">
</p>

# Prompt Template Model Extension

Adds `model`, `skill`, and `thinking` frontmatter to pi prompt templates. Define slash commands that switch to the right model, set a thinking level, inject skill context, and auto-restore your session when done.

```
/debug-python my code crashes
  → switches to Sonnet, loads tmux skill, agent responds
  → restores your previous model when finished
```

## Why?

Each prompt template becomes a self-contained agent mode. `/quick-debug` spins up a cheap model with REPL skills. `/deep-analysis` brings in extended thinking with refactoring expertise. When the command finishes, you're back to your daily driver without touching anything.

No more manually switching models, no hoping the agent picks up on the right skill. You define the configuration once, and the slash command handles the rest.

## Installation

```bash
pi install npm:pi-prompt-template-model
```

Restart pi to load the extension.

For delegated subagent execution (`subagent` and `inheritContext` frontmatter), install [pi-subagents](https://github.com/nicobailon/pi-subagents/) separately:

```bash
pi install npm:pi-subagents
```

pi-subagents is optional — everything else works without it. Using `subagent: true` without it installed fails fast with a clear error.

## Quick Start

Add `model` and optionally `skill` to any prompt template:

```markdown
---
description: Debug Python in tmux REPL
model: claude-sonnet-4-20250514
skill: tmux
---
Start a Python REPL session and help me debug: $@
```

Run `/debug-python some issue` and the agent switches to Sonnet, receives the tmux skill as context, and starts working. When it finishes, your previous model is restored. If Pi is compacting or finishing a turn, the slash command waits until the session can accept the generated prompt.

## Prompt Discovery

The extension scans the default prompt directories and the same local prompt paths Pi loads from `settings.json`:

- User defaults: `~/.pi/agent/prompts/`
- Project defaults: `<cwd>/.pi/prompts/`
- User settings: `~/.pi/agent/settings.json` `prompts` entries
- Project settings: `<cwd>/.pi/settings.json` `prompts` entries

Settings entries may point at directories or individual `.md` files. Absolute paths and `~/...` work. Relative user settings paths resolve from `~/.pi/agent`; relative project settings paths resolve from `<cwd>/.pi`. Pattern entries follow Pi's settings behavior: glob-style entries filter configured prompt paths, and `!`, `+`, or `-` entries exclude or force exact matches.

Precedence follows Pi's local-resource order: project settings, project defaults, user settings, then user defaults. If the same file is reachable through both settings and a default directory, it is loaded once by canonical path. Malformed settings files or invalid configured paths produce warnings while the rest of discovery continues.

## Frontmatter Reference

All fields are optional. Templates that don't use any extension features (no `model`, `skill`, `thinking`, etc.) are left to pi's default prompt loader.

### Core Fields

| Field | Default | What it does |
|-------|---------|--------------|
| `model` | current session model | Which model to use. Accepts a single model, a `provider/model-id` pair, or a comma-separated fallback list (see [Model Format](#model-format)). Ignored when `chain` is set. |
| `skill` | — | Loads one or more skills. Accepts one name, comma-separated names, or a YAML array; each entry may use the optional `skill:` prefix. Inline runs inject the full content before the agent turn, while delegated runs bind resolved name/path metadata to the outbound request. See [Skill Resolution](#skill-resolution). |
| `thinking` | — | Thinking level for the model: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `description` | — | Short text shown next to the command in autocomplete. |
| `chain` | — | Declares a reusable pipeline of templates (`step -> step`). When set, the body is ignored. See [Chain Templates](#chain-templates). |
| `chainContext` | — | Chain templates only. Set to `summary` so delegated steps receive a compact summary of what previous steps did. Steps with `inheritContext: true` are excluded. See [Chain context for delegated steps](#chain-context-for-delegated-steps). |

### Execution Control

| Field | Default | What it does |
|-------|---------|--------------|
| `restore` | `true` | After the command finishes, switch back to whatever model and thinking level were active before. Set `false` to stay on the new model. |
| `loop` | — | Run this template multiple times by default (1–999, `true`, or `unlimited`). CLI `--loop` overrides this. See [Loop Execution](#loop-execution). |
| `rotate` | `false` | When `true` and looping, cycle through models in the `model` list instead of using fallback semantics. Thinking levels can also be comma-separated to pair with each model. |
| `fresh` | `false` | When looping, collapse the conversation between iterations to a brief summary instead of carrying the full context forward. Saves tokens on long loops. |
| `converge` | `true` | When looping, stop early if an iteration makes no file changes. Set `false` to always run every iteration. |
| `boomerang` | `false` | After a non-chain prompt finishes, collapse its execution context back to the branch point with a brief summary. Works with loops, including `fresh` loop summaries. Useful for review prompts like `/double-check`. |
| `worktree` | `false` | When `true`, parallel delegated work runs in separate git worktrees. Valid on chain templates with `parallel()` steps, on delegated prompts with `parallel: N`, and on compare templates via `bestOfN.worktree`. |

### Delegation

| Field | Default | What it does |
|-------|---------|--------------|
| `subagent` | — | Delegate execution to a subagent instead of running in the current session. `true` uses the default `delegate` agent; a string value like `reviewer` targets that specific agent. Requires [pi-subagents](https://github.com/nicobailon/pi-subagents/). |
| `inheritContext` | `false` | Only meaningful with `subagent`. When `true`, the subagent receives a fork of the current conversation context instead of starting fresh. |
| `parallel` | — | Delegated prompts only. Repeats the same subagent in parallel `N` times. Each copy gets a slot header like `[Parallel subagent 2/3]` prepended to the task. Must be an integer greater than or equal to 2. |
| `bestOfN` | — | Compare templates only. Nested compare authoring block with `workers`, `reviewers`, optional `finalApplier`, and optional `worktree`. Top-level compare fields are not supported in templates. |
| `bestOfN.workers` | — | Ordered worker lineup used for the worker phase. Each slot object supports optional `agent`/`subagent`, optional `model`, optional `task`, optional `taskSuffix`, optional `cwd`, and optional `count`. If both `agent` and `subagent` are omitted, the default agent is `delegate`. |
| `bestOfN.reviewers` | — | Ordered reviewer lineup used after worker aggregation. Slot shape matches workers. If both `agent` and `subagent` are omitted, the default agent is `reviewer`. |
| `bestOfN.finalApplier` | — | Optional single-slot final apply phase that edits the real branch after reviewers. Supports optional `agent`/`subagent`, optional `model`, optional `task`, and optional `taskSuffix`. If both `agent` and `subagent` are omitted, the default agent is `delegate`. `count` and `cwd` are not supported. Requires `bestOfN.worktree: true` at runtime. |
| `cwd` | — | Working directory for delegated subagent subprocesses. Must be an absolute path (`~/...` is expanded). Valid with `subagent`, on chain templates as the default cwd for delegated steps, and on compare prompts as the default repo cwd. Worker/reviewer slots can also set their own `cwd` inside `bestOfN.workers` / `bestOfN.reviewers`. |

## Model Format

```yaml
model: claude-sonnet-4-20250514            # bare model ID — auto-selects provider
model: anthropic/claude-sonnet-4-20250514  # explicit provider/model
```

Bare model IDs resolve through a provider priority list: `openai-codex` → `anthropic` → `github-copilot` → `openrouter`. The first provider with valid auth wins.

For explicit control:

```yaml
model: anthropic/claude-opus-4-5        # Direct Anthropic API
model: openai-codex/gpt-5.2             # Via Codex subscription (OAuth)
model: github-copilot/claude-opus-4-5   # Via Copilot subscription
model: openrouter/claude-opus-4-5       # Via OpenRouter
model: openai/gpt-5.2                   # Direct OpenAI API
```

### Model Fallback

Comma-separated lists try each model in order:

```yaml
model: claude-haiku-4-5, claude-sonnet-4-20250514
```

Haiku is tried first. If it can't be found or has no API key, Sonnet is used instead. If the session is already on one of the listed models, that one is kept without switching. When every candidate fails, you get a single error listing what was tried.

You can mix bare IDs and explicit provider specs:

```yaml
model: anthropic/claude-haiku-4-5, openrouter/claude-haiku-4-5, claude-sonnet-4-20250514
```

## Skills

Normally, pi lists available skills in the system prompt, the agent reads your task, decides which skill it needs, and loads it with the read tool. That's an extra round-trip, and the agent might not pick the right one.

The `skill` field bypasses all of that:

```markdown
---
description: Browser testing mode
model: claude-sonnet-4-20250514
skill: surf
---
$@
```

For inline runs, every skill is resolved first and its full content is injected in a separate `<skill name="...">` block within one context message before the agent processes your task. For single delegated runs, skill bodies are not prepended to the task; the outbound pi-subagents request uses the versioned `skill` field with resolved skill names. Parallel delegated runs also resolve every declared skill before emitting the request and carry name-only `skill` metadata per task for compatible bridges. If any declared skill can't be found or read, the command fails before the inline turn or delegated request starts.

### Skill Resolution

The `skill` field accepts one name, comma-separated names, or a YAML array. Entries are trimmed, empty entries are dropped, duplicates keep their first position, and each entry may use a `skill:` prefix:

```yaml
skill: tmux
skill: tmux, skill:browser
skill:
  - tmux
  - skill:browser
```

Resolution order:

1. Registered skill commands from `pi.getCommands()` (source: `"skill"`)
2. `<cwd>/.pi/skills/<name>/SKILL.md` or `<cwd>/.pi/skills/<name>.md` when project trust is enabled
3. `.agents/skills` in the current directory and ancestors (up to the git root) when project trust is enabled
4. `~/.pi/agent/skills/<name>/SKILL.md` or `~/.pi/agent/skills/<name>.md`
5. `~/.agents/skills/<name>/SKILL.md` or `~/.agents/skills/<name>.md`

## Inline Model Conditionals

Prompt bodies can include sections that only render for specific models:

```markdown
---
description: Cross-model code review
model: claude-haiku-4-5, claude-sonnet-4-20250514
---
Summarize the change first.

<if-model is="claude-haiku-4-5">
Keep the answer brief and cost-conscious.
<else>
Do a deeper pass and call out subtle risks.
</if-model>
```

Conditionals evaluate against whichever model actually runs — after fallback resolution for multi-model templates, or against the session model when `model` is omitted.

The `is` attribute supports exact model IDs, `provider/model-id` pairs, provider wildcards like `anthropic/*`, and comma-separated combinations:

```markdown
<if-model is="anthropic/*">Anthropic-specific instructions</if-model>
<if-model is="openai/gpt-5.2, anthropic/*">Either OpenAI or Anthropic</if-model>
```

`<else>` is the fallback branch. Nested `<if-model>` blocks work.

## Argument Substitution

Prompt bodies support placeholders that expand to the arguments passed after the command name:

| Placeholder | Expands to |
|-------------|------------|
| `$1`, `$2`, ... | The Nth argument (1-indexed) |
| `$@` or `@$` or `$ARGUMENTS` | All arguments joined with spaces |
| `${@:N}` | All arguments from position N onward |
| `${@:N:L}` | L arguments starting from position N |

```markdown
---
model: claude-sonnet-4-20250514
---
Analyze $1 focusing on $2. Additional context: ${@:3}
```

`/analyze src/main.ts performance edge cases error handling` expands `$1` to `src/main.ts`, `$2` to `performance`, and `${@:3}` to `edge cases error handling`.

## Delegated Subagent Execution

Instead of running a prompt in the current session, you can hand it off to a subagent:

```markdown
---
model: anthropic/claude-sonnet-4-20250514
subagent: true
---
Review and simplify this code: $@
```

`subagent: true` delegates to the default `delegate` agent. To target a specific agent:

```markdown
---
model: anthropic/claude-sonnet-4-20250514
subagent: reviewer
inheritContext: true
---
Audit this diff for correctness and edge cases: $@
```

`inheritContext: true` forks the current conversation so the subagent has full context. Without it, the subagent starts fresh. Declared skills are resolved against the delegated `cwd` and sent as skill names on the delegation request; their bodies are never prepended to delegated task text.

To force a subagent into a specific working directory, add `cwd`:

```markdown
---
model: claude-sonnet-4-20250514
subagent: browser-screenshoter
cwd: /tmp/screenshots
---
Use url in the prompt to take screenshot: $@
```

The subagent process runs with `/tmp/screenshots` as its working directory. Paths must be absolute (`~/...` is expanded). The directory is validated at execution time.

To fan the same delegated prompt out to multiple copies in parallel, add `parallel: N`:

```markdown
---
model: anthropic/claude-sonnet-4-20250514
subagent: simplifier
inheritContext: true
parallel: 3
worktree: true
---
Review changed code and fix any issues found.
```

This expands to three parallel `pi-subagents` tasks targeting the same agent. Each one receives the same rendered prompt plus an automatic slot header like `[Parallel subagent 1/3]`, `[Parallel subagent 2/3]`, and `[Parallel subagent 3/3]` so the body can assign different roles to each copy. `worktree: true` is optional here and gives each parallel run its own git worktree.

During execution, a live progress widget appears above the editor showing elapsed time, tool count, token usage, and the current tool. When the run finishes, it's replaced by a completion card with the task preview, tool call history, output, and usage stats.

You can override delegation at runtime per invocation with `--subagent`, `--subagent=<name>`, `--subagent:<name>`, or `--cwd=<path>`. `--cwd=<path>` must be absolute after optional `~/...` expansion. Runtime flags take precedence for that invocation only.

Two additional runtime flags work for any prompt (not just delegated ones):

- `--model=provider/model-id` — override the template's `model` for this invocation. Works with single execution, loops, and delegation.
- `--fork` — run with `inheritContext` (forked context). Implies `--subagent` if not already set.

```
/double-check --model=anthropic/claude-opus-4-6
/double-check --fork --subagent:worker
/deslop --model=openai/gpt-5.4 --loop 3
```

Compare templates also accept runtime lineup overrides:

Prompt-template frontmatter authoring uses `bestOfN:`. Runtime overrides stay on the low-level flags below.

- `--workers=<json-array>` / `--reviewers=<json-array>` replace the corresponding frontmatter lineup.
- `--workers-append=<json-array>` / `--reviewers-append=<json-array>` append to the corresponding lineup.
- `--final-applier=<json-object-or-one-element-array>` replaces the optional final apply slot.

Each worker/reviewer JSON array entry must be an object with either `subagent` or `agent`, plus optional `model`, `task`, `taskSuffix`, `cwd`, and `count`. In worker slots, `"subagent": true` maps to `delegate`. In reviewer slots, `"subagent": true` maps to `reviewer`. `--final-applier=` accepts one slot object (or a one-element array) with `subagent`/`agent`, optional `model`, optional `task`, and optional `taskSuffix`; for this final slot, `"subagent": true` maps to `delegate`, and both `count` and `cwd` are not supported.

## Best-of-N Compare Prompt

This repo ships one example compare prompt under `examples/`:

- `examples/best-of-n.md` installs as `/best-of-n`, runs in the current repo, and shows mixed workers, mixed reviewers, and an optional final apply phase.
- Smoke test: `/best-of-n smoke test`.

Install it manually from this repo checkout (or from the installed package directory):

```bash
PTM_DIR=/path/to/pi-prompt-template-model
mkdir -p ~/.pi/agent/prompts
cp "$PTM_DIR/examples/best-of-n.md" ~/.pi/agent/prompts/best-of-n.md
```

After copying the file, restart `pi` if it is already running. The prompt then runs an explicit compare flow:

Compare prompt templates are authored under `bestOfN:`. Top-level `workers`, `reviewers`, and `finalApplier` frontmatter fields are rejected with migration diagnostics.

1. Worker phase: run the worker lineup in parallel (`context: fork`) so workers generate candidate implementations in temporary worktrees.
2. Continue as long as at least one worker succeeds. Reviewer slots receive successful worker outputs plus worker/worktree summaries and produce findings only.
3. Optional final apply phase: if `finalApplier` is configured, run one delegated apply step on the real compare repo (`compareCwd`) to pick a winner or synthesize/cherry-pick and apply the final patch.
4. If all reviewers fail but `finalApplier` exists, the final apply step still runs with fallback context from workers plus reviewer failure summaries.

Worker/reviewer lineups are fully configurable from `bestOfN` frontmatter or runtime overrides, so there is no fixed three-model worker assumption. If a compare prompt omits `bestOfN.workers`, it falls back to one `delegate` worker using the current/main model. If it omits `bestOfN.reviewers`, it falls back to one `reviewer` slot. `bestOfN.finalApplier` is optional, and compare runs reject an effective final applier unless `bestOfN.worktree: true` is set.

For same-model best-of-N, use `count: N` on one worker slot:

```yaml
bestOfN:
  workers:
    - model: openai-codex/gpt-5.4:low
      count: 4
```

You can also mix models and give each slot its own count:

```yaml
bestOfN:
  workers:
    - model: openai-codex/gpt-5.4:low
      count: 3
    - model: google/gemini-2.5-pro:medium
      count: 2
    - model: anthropic/claude-sonnet-4-20250514:high
```

Reviewer slots support the same lineup shape, and `bestOfN.finalApplier` is one optional single-slot final apply step:

```yaml
bestOfN:
  reviewers:
    - model: openai-codex/gpt-5.4:low
      count: 2
    - model: google/gemini-2.5-pro:medium
      taskSuffix: Focus on regression risk.
  finalApplier:
    model: anthropic/claude-sonnet-4-20250514:high
    taskSuffix: Apply the final patch on the current branch and report verification.
```

Within compare lineups, omitting both `agent` and `subagent` uses phase defaults: `delegate` in workers, `reviewer` in reviewers, and `delegate` in finalApplier. You can still set explicit `agent` or `subagent` when needed.

Explicitly repeating the same slot still works, but `count: N` is the cleaner shorthand when the slot is identical.

Within a compare lineup, use `task` for a full per-slot override and `taskSuffix` for a small per-slot append. `taskSuffix` is added after the shared worker task (or after the slot's `task` if you set one), which makes it the better fit for things like per-model output file names.

When a compare prompt uses `bestOfN.worktree: true`, all worker slots must resolve to the same `cwd`. Mixed worker `cwd` values are only allowed when worktree isolation is off. Worktree isolation is for the worker phase only; `bestOfN.finalApplier` always applies on the real branch (`compareCwd`).

## Deterministic Steps

Prompt templates can run one deterministic command or script before any optional LLM turn. Use this when the first step should be direct code, not model latency.

The flow is simple:

1. Run one command or script.
2. Always render a visible deterministic result card with the command, exit code, duration, and stdout/stderr previews.
3. Optionally hand the structured result to the model as a `[Deterministic step]` preamble before the prompt body.
4. If `handoff: never`, stop after the result card and a visible completion marker — no LLM turn happens.

That handoff preamble is intentionally structured and uses stable field names like `status`, `executionKind`, `command`, `cwd`, `exitCode`, `signal`, `durationMs`, `timedOut`, `lineCount`, `charCount`, `truncated`, `omittedChars`, and `preview`.

V1 scope is intentionally narrow: deterministic execution only works on single prompt templates. It does not combine with chain templates, delegated/subagent prompts, `parallel`, or loops. At runtime, deterministic prompts explicitly reject `--loop`, `--subagent`, and `--fork` in v1.

### Authoring forms

You can write deterministic steps as **top-level shorthand** or **nested under `deterministic:`**. Both are equivalent. Use shorthand for brevity, nested when you want everything grouped under one key.

**Top-level shorthand** — put `run`, `script`, `handoff`, `timeout`, `cwd`, `env`, and `nonInteractive` directly in frontmatter:

```markdown
---
run: git push origin HEAD:main
handoff: on-failure
timeout: 30000
---
If the push failed, explain why and suggest the next step.
```

You can also use `script:` as shorthand:

```markdown
---
script: ./scripts/ship.sh
handoff: always
timeout: 15000
---
Summarize the script result.
```

**Nested form** — group everything under `deterministic:`:

```markdown
---
model: claude-sonnet-4-20250514
deterministic:
  script:
    path: ./scripts/ship.sh
    args:
      - --fast
  handoff: always
  timeout: 15000
  cwd: ~/src/my-repo
---
Summarize the script result and call out anything risky.
```

**Structured command form** — when you need explicit args instead of a single shell string, use `deterministic.run.command` with `args`:

```markdown
---
model: claude-sonnet-4-20250514
deterministic:
  run:
    command: git
    args: [status, --short]
  handoff: always
---
Interpret the repo state.
```

Do not mix top-level shorthand with nested `deterministic:` in the same prompt. Pick one style.

### Model requirement

Deterministic prompts that hand off to the model (`handoff: always`, `on-success`, or `on-failure`) need a model to continue into. You can either:

- Add a `model:` field explicitly
- Omit `model:` and let the prompt inherit whatever model is currently active

`handoff: never` prompts do not need a model field because they never reach the LLM.

### Handoff values

- `always` — always continue into the LLM after the deterministic card is emitted.
- `never` — stop after the deterministic card and completion marker.
- `on-success` — continue only when the command exits `0`.
- `on-failure` — continue only when the command exits non-zero.

Command descriptions in the slash-command picker show this feature as `deterministic-step:<handoff>`.

### Timeout

`timeout` is in milliseconds. When a timeout fires, the runner sends `SIGTERM` first. If the process still has not exited after a short grace window, it escalates to `SIGKILL`.

### Script path resolution

Relative script paths resolve from the prompt file's directory first, then fall back to the command invocation `cwd`. Absolute script paths also work.

### Environment and non-interactive mode

You can provide explicit environment variables and control the runner's non-interactive guardrails:

```markdown
---
deterministic:
  run: ./deploy.sh
  handoff: never
  nonInteractive: false
  env:
    SPECIAL_TOKEN: abc123
    RETRIES: 2
---
```

`nonInteractive` defaults to `true`. In that mode the runner keeps stdin ignored and adds a few guardrail environment defaults such as `CI=1`, `GIT_TERMINAL_PROMPT=0`, `PAGER=cat`, and `GIT_PAGER=cat`. Set `nonInteractive: false` when the command needs a more normal process environment and you explicitly want to opt out of those defaults. Explicit `env` values override the built-in defaults.

### Output capping

Large stdout/stderr streams are capped before they are stored in the conversation card payload. The card and the LLM handoff block both show the total character and line counts plus explicit truncation metadata when output was capped.

## Loop Execution

Run a template multiple times with `--loop`:

```
/deslop --loop 5
/deslop --loop=5
/deslop --loop          # unlimited — runs until convergence or cap (999)
```

You can also set a default in frontmatter. CLI `--loop` always overrides:

```markdown
---
loop: 5
---
```

Use `loop: unlimited` (or `loop: true`) for open-ended loops that run until convergence, user interrupt, or the safety cap of 999 iterations:

```markdown
---
loop: unlimited
converge: false
fresh: true
subagent: true
---
```

### How looping works

Each iteration runs the same prompt. By default, context accumulates — iteration 3 sees the full conversation from iterations 1 and 2 and builds on that work.

**Convergence**: If an iteration makes no file changes (no `write` or `edit` tool calls), the loop stops early. This is on by default. Use `--no-converge` or `converge: false` to always run every iteration.

**Fresh context**: Add `--fresh` (or `fresh: true` in frontmatter) to collapse the conversation between iterations. Each iteration gets a clean slate with only brief summaries of what previous iterations did. Good for long loops where accumulated context would blow up the token count.

**Status**: The TUI status bar shows `loop 2/5` during execution.

Model, thinking level, and skill are maintained throughout. If `restore: true` (the default), everything is restored after the final iteration.

## Model Rotation

`rotate: true` turns a comma-separated `model` list from a fallback chain into a cycling list. Each loop iteration uses the next model in the list, wrapping around:

```markdown
---
model: claude-opus-4-6, gpt-5.4, gpt-5.3-codex
thinking: high, max, off
loop: 9
rotate: true
fresh: true
---
Review and fix issues in this codebase.
```

Iteration 1 runs Opus + `high`, iteration 2 runs GPT-5.4 + `max`, iteration 3 runs Codex + `off`, then wraps back to Opus. The status bar shows which model is active: `loop 2/9 · gpt-5.4 max`.

This is especially useful for [ralph-style loops](https://ghuntley.com/ralph/) where different models catch different things. The `subagent` examples below require [pi-subagents](https://github.com/nicobailon/pi-subagents/). A single-model ralph loop that delegates with fresh context each iteration:

```markdown
---
model: claude-sonnet-4-20250514
subagent: true
inheritContext: true
loop: 5
fresh: true
---
Simplify this code: $@
```

Add `rotate` and multiple models to cycle different perspectives on each pass:

```markdown
---
model: claude-opus-4-6, gpt-5.4, gpt-5.3-codex
thinking: max, high, high
loop: 9
rotate: true
fresh: true
subagent: true
---
Review and fix issues in this codebase.
```

Each iteration gets fresh context, a different model, and its own thinking level. Convergence stops the loop when an iteration makes no file changes — use `converge: false` to guarantee every model gets at least one shot.

`thinking` pairing with `rotate: true`:

- Single value (`thinking: high`) — applied to every model.
- Comma-separated (`thinking: high, max, off`) — positional, must match the number of models.
- Omitted — each iteration inherits the session default.

Without `loop`, `rotate` has no effect and comma-separated `model` keeps normal fallback behavior.

## Chaining Templates

`/chain-prompts` runs multiple templates in sequence. Each step uses its own model, skill, and thinking level, while conversation context flows between them:

```
/chain-prompts analyze-code -> fix-plan -> summarize -- src/main.ts
```

This runs `analyze-code`, then `fix-plan` (which sees the analysis), then `summarize`. The ` -- ` separator marks shared args — everything after it is passed to each step as `$@`, unless a step has its own inline args:

```
/chain-prompts analyze-code "error handling" -> fix-plan -> summarize -- src/main.ts
```

Step 1 gets `"error handling"` as its args. Steps 2 and 3 fall back to the shared `"src/main.ts"`.

The chain captures your model and thinking level before starting and restores them when finished (or if any step fails).

### Chain Templates

For reusable pipelines, put the chain in frontmatter:

```markdown
---
description: Review then clean up
chain: double-check --loop 2 -> deslop --loop 2
---
```

This registers the file's name as a command that runs `double-check` twice, then `deslop` twice. Per-step `--loop N` repeats that step before moving to the next, with per-step convergence (stops early if no changes, unless the step's template has `converge: false`).

Chain declarations also support parallel groups with `parallel(...)`:

```markdown
---
chain: parallel(scan-frontend, scan-backend) -> consolidate
---
```

Each entry inside `parallel(...)` runs as a delegated subagent task concurrently. Parallel entries can include per-step args (for example `parallel(scan-frontend, scan-backend "auth")`), but per-step `--loop` is not supported inside parallel groups. Nested `parallel(...)` is rejected. Parallel entries must be delegated templates (`subagent: ...` or runtime `--subagent` override). All entries in the same parallel group must resolve to the same `inheritContext` mode. Mixed `cwd` values are allowed normally, but when `worktree: true` is enabled they must all resolve to the same `cwd`.

Add `worktree: true` (or `--worktree` at runtime) so each parallel subagent runs in its own git worktree, avoiding file conflicts when agents edit concurrently:

```markdown
---
chain: parallel(scan-frontend, scan-backend) -> consolidate
worktree: true
---
```

`worktree` requires a chain with at least one `parallel()` step. The flag is passed to pi-subagents, which handles worktree creation and cleanup.

Steps with a `model` field use their own model. Steps without one inherit a snapshot of whatever model was active when the chain started — not the previous step's model. This keeps behavior deterministic regardless of what earlier steps do.

Chain templates support `loop`, `fresh`, `converge`, `restore`, `worktree`, and `cwd` in their frontmatter for controlling the overall execution:

```markdown
---
chain: analyze -> fix
loop: 3
fresh: true
converge: false
---
```

This runs the full analyze → fix chain 3 times, with fresh context between iterations and no early stopping. Chain nesting is not supported — steps can't reference other chain templates.

When a chain template sets `cwd`, it becomes the default delegated subprocess working directory for all delegated steps in that chain. Runtime `--cwd=<path>` overrides the chain template value.

### Chain context for delegated steps

Delegated chain steps start fresh — they don't see what earlier steps did. Chain context prepends a compact summary of previous steps to each delegated task so later steps can build on earlier work.

Enable it chain-wide with `chainContext: summary` in frontmatter or `--chain-context` on the CLI:

```markdown
---
chain: analyze -> fix
chainContext: summary
---
```

```
/chain-prompts analyze -> fix --chain-context
```

To enable it for a single step, attach `--with-context` to that step name:

```
/chain-prompts analyze -> reviewer --with-context -> summarize
```

Here only `reviewer` receives the summary of `analyze`. The `summarize` step does not.

Steps using `inheritContext: true` already fork the full parent conversation and skip the summary preamble. `--with-context` is not supported inside `parallel(...)` groups. When a chain uses `loop`, summaries reset each iteration.

### Parallel and looping from the CLI

Parallel groups work in `/chain-prompts` too:

```
/chain-prompts parallel(scan-fe, scan-be) -> review
/chain-prompts parallel(scan-fe, scan-be) -> review --worktree
```

Looping applies to the entire chain:

```
/chain-prompts analyze -> fix --loop 3
/chain-prompts analyze -> fix --loop 3 --fresh
/chain-prompts analyze -> fix --loop 3 --no-converge
/chain-prompts analyze -> fix --loop
```

Convergence applies across all steps in each iteration — if no step made file changes, the loop stops. Templates are re-read from disk between iterations, so edits take effect live.

## Prompt Invocation Events

External orchestrators can request prompt execution through the prompt invocation event channel. An accepted request emits one `prompt-template:prompt:started` event and one terminal `prompt-template:prompt:finished` event for the acknowledged `runId`.

The event channel fails closed for prompt types that cannot guarantee bounded completion. Deterministic prompts must set `timeout` to be accepted through events. Delegated prompts, runtime `--subagent` or `--fork` invocations, and compare lineups are refused through events for now with `accepted: false` and `reason: "unsupported-context"`. Interactive slash commands keep the existing behavior.

## Agent Tool

The agent can invoke prompt templates itself via a `run-prompt` tool. It's off by default:

```
/prompt-tool on
```

Once enabled, the agent sees `run-prompt` in its tool list:

```
run-prompt({ command: "deslop --loop 5 --fresh" })
run-prompt({ command: "chain-prompts analyze -> fix --chain-context" })
run-prompt({ command: "chain-prompts analyze -> fix --loop 3" })
run-prompt({ command: "deslop --subagent" })
```

The tool queues the command for execution after the agent's current turn ends. All loop, chain, and convergence features work the same as slash commands.

You can add guidance to steer when the agent reaches for it:

```
/prompt-tool on Use run-prompt for iterative code improvement tasks
/prompt-tool guidance Use sparingly, only for multi-pass refinement
/prompt-tool guidance clear
/prompt-tool off
/prompt-tool                   # show current status
```

Config persists across sessions in `~/.pi/agent/prompt-template-model.json`.

## Autocomplete

Commands show their configuration in the autocomplete description:

```
/debug-python    Debug Python session [sonnet +tmux] (user)
/deep-analysis   Deep code analysis [sonnet high] (user)
/save-progress   Save progress doc [haiku|sonnet] (user)
/component       Create React component [sonnet] (user:frontend)
```

## Subdirectories

Organize prompts in subdirectories for namespacing:

```
~/.pi/agent/prompts/
├── quick.md                    → /quick (user)
├── debug-python.md             → /debug-python (user)
└── frontend/
    ├── component.md            → /component (user:frontend)
    └── hook.md                 → /hook (user:frontend)
```

The subdirectory shows as the source label in autocomplete. Command names are based on filename only. Duplicates within the same source layer are skipped with a warning, as are reserved names like `model`, `reload`, and `chain-prompts`.

## Print Mode

These commands work in `pi -p` too:

```bash
pi -p "/debug-python my code crashes on line 42"
```

The model switches, skill is injected, the agent responds, and output goes to stdout. Useful for scripting or piping.

## Examples

**Thinking levels** — max thinking for thorny analysis:

```markdown
---
description: Deep code analysis with extended thinking
model: claude-sonnet-4-20250514
thinking: max
---
Analyze this code thoroughly, considering edge cases and potential issues: $@
```

**Sticky mode switch** — switch models for the rest of the session:

```markdown
---
description: Switch to Haiku for this session
model: claude-haiku-4-5
restore: false
---
Switched to Haiku. How can I help?
```

**Cross-provider fallback** — try the same model on different providers:

```markdown
---
description: Quick analysis
model: anthropic/claude-haiku-4-5, openrouter/claude-haiku-4-5
---
$@
```

## Limitations

- Prompt files are reloaded on session start and whenever an extension-owned command runs. If you add a new prompt file mid-session, run any extension command (like `/chain-prompts`), start a new session, or reload pi to pick it up.
- Model restore state is in-memory. Closing pi mid-response loses it.
- In chains, model-less steps inherit the chain-start model snapshot, not the previous step's model. This is intentional for deterministic behavior.
- Delegated `subagent` prompts require [pi-subagents](https://github.com/nicobailon/pi-subagents/).
- `run-prompt` must be explicitly enabled with `/prompt-tool on`.
