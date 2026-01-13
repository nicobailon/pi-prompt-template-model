# Prompt Template Model Extension

**Pi prompt templates on steroids.** Adds `model`, `skill`, and `thinking` frontmatter support. Create specialized agent modes that switch to the right model, set thinking level, and inject the right skill, then auto-restore when done.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  You're using Opus                                                          │
│       │                                                                     │
│       ▼                                                                     │
│  /debug-python  ──►  Extension detects model + skill                        │
│       │                                                                     │
│       ▼                                                                     │
│  Switches to Sonnet  ──►  Injects tmux skill into system prompt             │
│       │                                                                     │
│       ▼                                                                     │
│  Agent responds with Sonnet + tmux expertise                                │
│       │                                                                     │
│       ▼                                                                     │
│  agent_end fires  ──►  Restores Opus                                        │
│       │                                                                     │
│       ▼                                                                     │
│  You're back on Opus                                                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Why?

Create switchable agent "modes" with a single slash command. Each mode bundles:

- **The right model** for the task complexity and cost tradeoff
- **The right skill** so the agent knows exactly how to approach it
- **Auto-restore** to your daily driver when done

Instead of manually switching models and hoping the agent picks up on the right skill, you define prompt templates that configure both. `/quick-debug` spins up a cheap fast agent with REPL skills. `/deep-analysis` brings in the heavy hitter with refactoring expertise. Then you're back to your normal setup.

## Installation

```bash
git clone https://github.com/nicobailon/pi-prompt-template-model.git ~/.pi/agent/extensions/pi-prompt-template-model
```

Pi auto-discovers extensions from `~/.pi/agent/extensions/*/index.ts`. Just restart pi.

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

Run `/debug-python some issue` and the agent has:
- Sonnet as the active model
- Full tmux skill instructions already loaded
- Your task ready to go

## Skills as a Cheat Code

Normally, skills work like this: pi lists available skills in the system prompt, the agent sees your task, decides it needs a skill, and uses the read tool to load it. That's an extra round-trip, and the agent might not always pick the right one.

With the `skill` field, you're forcing it:

```markdown
---
description: Browser testing mode
model: claude-sonnet-4-20250514
skill: surf
---
$@
```

Here `skill: surf` loads `~/.pi/agent/skills/surf/SKILL.md` and injects its content directly into the system prompt before the agent even sees your task. No decision-making, no read tool, just immediate expertise. It's a forcing function for when you know exactly what workflow the agent needs.

## Frontmatter Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `model` | Yes | - | Model ID or `provider/model-id` |
| `skill` | No | - | Skill name to inject into system prompt |
| `thinking` | No | - | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `description` | No | - | Shown in autocomplete |
| `restore` | No | `true` | Restore previous model and thinking level after response |

## Model Format

```yaml
model: claude-sonnet-4-20250514            # Model ID only - auto-selects provider
model: anthropic/claude-sonnet-4-20250514  # Explicit provider/model
```

When you specify just the model ID, the extension picks a provider automatically based on where you have auth configured, preferring: `anthropic` → `github-copilot` → `openrouter`.

For explicit control:

```yaml
model: anthropic/claude-opus-4-5        # Direct Anthropic API
model: github-copilot/claude-opus-4-5   # Via Copilot subscription
model: openrouter/claude-opus-4-5       # Via OpenRouter
model: openai/gpt-5.2                   # Direct OpenAI API
model: openai-codex/gpt-5.2             # Via Codex subscription (OAuth)
```

## Skill Resolution

The `skill` field matches the skill's directory name:

```yaml
skill: tmux
```

Resolves to (checked in order):
1. `<cwd>/.pi/skills/tmux/SKILL.md` (project)
2. `~/.pi/agent/skills/tmux/SKILL.md` (user)

This matches pi's precedence - project skills override user skills.

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

The subdirectory shows in autocomplete as the source label. Note: command names are based on filename only, so avoid duplicate filenames across subdirectories (e.g., `quick.md` and `frontend/quick.md` would collide).

## Examples

**Cost optimization** - use Haiku for simple summarization:

```markdown
---
description: Save progress doc for handoff
model: claude-haiku-4-5
---
Create a progress document that captures everything needed for another 
engineer to continue this work. Save to ~/Documents/docs/...
```

**Skill injection** - guarantee the agent has REPL expertise:

```markdown
---
description: Python debugging session
model: claude-sonnet-4-20250514
skill: tmux
---
Start a Python REPL and help me debug: $@
```

**Browser automation** - pair surf skill with a capable model:

```markdown
---
description: Test user flow in browser
model: claude-sonnet-4-20250514
skill: surf
---
Test this user flow: $@
```

**Deep thinking** - max thinking for complex analysis:

```markdown
---
description: Deep code analysis with extended thinking
model: claude-sonnet-4-20250514
thinking: high
---
Analyze this code thoroughly, considering edge cases and potential issues: $@
```

**Mode switching** - stay on the new model:

```markdown
---
description: Switch to Haiku for this session
model: claude-haiku-4-5
restore: false
---
Switched to Haiku. How can I help?
```

## Autocomplete Display

Commands show model, thinking level, and skill in the description:

```
/debug-python    Debug Python session [sonnet +tmux] (user)
/deep-analysis   Deep code analysis [sonnet high] (user)
/component       Create React component [sonnet] (user:frontend)
/quick           Quick answer [haiku] (user)
```

## Print Mode (`pi -p`)

These commands work in print mode too:

```bash
pi -p "/debug-python my code crashes on line 42"
```

The model switches, skill injects, agent responds, and output prints to stdout. Useful for scripting or piping to other tools.

## Limitations

- Templates discovered at startup. Restart pi after adding/modifying.
- Model restore state is in-memory. Closing pi mid-response loses restore state.
