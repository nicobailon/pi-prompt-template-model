---
name: prompt-template-authoring
description: |
  Write and run custom Pi prompt templates (slash commands) for this extension.
  Use when creating templates with model selection, deterministic pre-steps,
  loops, chains, subagents, or best-of-N compare flows.
---

# Prompt Template Authoring

Use this skill when working on prompt templates for `pi-prompt-template-model`.
Templates are markdown files that register as slash commands.

## Where Templates Live

- `~/.pi/agent/prompts/` — user prompts (highest priority)
- `.pi/prompts/` inside a project — project-specific prompts

Extension `examples/` are reference files only. Copy them to a prompt directory to register them.

## Minimal Template

```markdown
---
model: claude-sonnet-4-20250514
---
Your prompt body here.
```

Save as `my-command.md`, restart Pi, run `/my-command`. Use `description:` for autocomplete text.

## Model Selection

Omit `model:` to inherit the current session model. Otherwise:

- `model: claude-sonnet-4-20250514` — specific model
- `model: claude-opus-4, gpt-5.4` — fallback order (tries first, falls back to second if unavailable)
- `model: claude-opus-4, gpt-5.4` + `rotate: true` — cycle through list on each loop iteration

## Argument Substitution

The prompt body can use placeholders:

- `$@` — all arguments passed to the command
- `$1`, `$2` — specific positional arguments
- `${@:1}` — argument 1 and everything after

## Deterministic Steps (Pre-LLM Execution)

Run a command or script before the LLM turn. The model only sees the output if you want it to.

Two equivalent forms. Don't mix them in the same prompt.

**Shorthand form** — top-level keys:

```yaml
---
run: git status --short
handoff: always
---
Summarize the repo state.
```

**Nested form** — under `deterministic:`:

```yaml
---
deterministic:
  run: ./scripts/ship.sh
  handoff: on-failure
  timeout: 60000
---
Diagnose the failure and suggest a fix.
```

**Handoff controls when the LLM sees the result:**

- `never` — run, show result, done (no LLM turn)
- `always` — always hand result to model
- `on-failure` — only hand off if command exits non-zero
- `on-success` — only hand off if command exits zero

**Execution forms:**

- `run: command string` — runs via `/bin/bash -lc`
- `run: {command: git, args: [status], shell: false}` — explicit args, optional shell
- `script: ./script.sh` or `script: {path: ./script.sh, args: [--fast]}` — run a file

**Constraints:**
- Only single prompt templates (no `chain`, `loop`, `subagent`, or `parallel`)
- Runtime flags `--loop`, `--subagent`, `--fork` are rejected for deterministic prompts

## Subagent Delegation

Delegate to another Pi agent instead of running inline:

```yaml
---
model: claude-sonnet-4-20250514
subagent: delegate          # or true, or a specific agent name
inheritContext: true        # fork conversation context (optional)
cwd: /absolute/path         # working directory for the subagent (optional)
parallel: 3                 # run 3 copies in parallel (optional)
---
$@
```

Requires [pi-subagents](https://github.com/nicobailon/pi-subagents/) to be installed.

## Loops

Run the prompt multiple times:

```yaml
---
model: claude-sonnet-4-20250514
loop: 5                     # run exactly 5 times
converge: true              # stop early if no changes (default)
fresh: true                 # collapse context between iterations
---
$@
```

Or at runtime: `/command --loop 5`, `/command --loop` (unlimited), or `/command --loop=5 --fresh`.

## Chains

Chain templates declare a reusable pipeline:

```yaml
---
chain: analyze -> fix -> test
chainContext: summary        # pass step summaries to later delegated steps
---
$@
```

Or use `/chain-prompts analyze -> fix -> test` at runtime. Chain templates ignore the body and `model:` field.

## Model Conditionals

Show different content based on which model runs:

```markdown
<if-model is="anthropic/*">
Use Claude-specific instructions.
<else>
Use default instructions.
</if-model>
```

Supports exact IDs, `provider/model-id` pairs, wildcards (`anthropic/*`), and comma-separated combinations.

## Best-of-N Compare

Run multiple workers, aggregate with reviewers, optionally apply final changes:

```yaml
---
description: Best-of-N code review
bestOfN:
  worktree: true            # required if using finalApplier
  workers:
    - model: openai-codex/gpt-5.4-mini:low
      count: 2
  reviewers:
    - model: anthropic/claude-sonnet-4-20250514:medium
  finalApplier:
    agent: delegate
    model: anthropic/claude-sonnet-4-20250514:high
---
$@
```

## Runtime Flags

Override frontmatter at invocation:

- `--model=provider/model-id` — use this model instead
- `--subagent` / `--subagent=<name>` / `--subagent:<name>` — force delegation
- `--fork` — force delegation with context fork
- `--loop N` / `--loop=N` / `--loop` — override loop count (unlimited if bare)
- `--fresh` — collapse context between iterations
- `--no-converge` — run all iterations even if no changes
- `--cwd=/absolute/path` — working directory override when the prompt supports `cwd`
- `--chain-context` — pass summaries to later delegated chain steps
- `--worktree` — use git worktrees for parallel delegated work

When stuck, check `README.md` and `examples/best-of-n.md` in this extension.
