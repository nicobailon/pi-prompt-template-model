# Prompt Template Model Extension

Adds `model` frontmatter support to prompt templates. Temporarily switch to a different model for a specific prompt, then auto-restore your previous model.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  You're using Opus                                                          │
│       │                                                                     │
│       ▼                                                                     │
│  /save-progress-doc  ──►  Extension detects `model: claude-haiku-4-5`       │
│       │                                                                     │
│       ▼                                                                     │
│  Switches to Haiku  ──►  Stores "Opus" as previous model                    │
│       │                                                                     │
│       ▼                                                                     │
│  Agent responds with Haiku                                                  │
│       │                                                                     │
│       ▼                                                                     │
│  agent_end fires  ──►  Restores Opus  ──►  Shows "Restored to opus" notif   │
│       │                                                                     │
│       ▼                                                                     │
│  You're back on Opus                                                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Why?

Some tasks don't need your most powerful (and expensive) model. For example, you might use Opus 4.5 as your daily driver for complex coding tasks, but a progress document that summarizes your work is straightforward enough for Haiku 4.5 - it's faster and cheaper.

Instead of manually switching models with `/model` before and after, just add `model: claude-haiku-4-5` to your prompt template. The extension handles the rest.

**Example: `/save-progress-doc`**

A prompt that generates a handoff document for the next engineer. This is mostly summarization and formatting - perfect for Haiku:

```markdown
---
description: Save a progress document for handoff
model: claude-haiku-4-5
---
Create a progress document that captures everything needed for another 
engineer to continue this work. Save to ~/Documents/docs/...
```

Run `/save-progress-doc`, Haiku generates the doc, then you're automatically back on Opus for your next task.

## Location

`~/.pi/agent/extensions/pi-prompt-template-model/`

Auto-discovered by pi from `~/.pi/agent/extensions/*/index.ts`.

## Adding a Model to a Prompt Template

Add a `model` field to the YAML frontmatter of any prompt template:

```markdown
---
description: Save a progress document for handoff
model: claude-haiku-4-5
---
Create a progress document that captures everything needed...
```

**Before (standard prompt template):**
```markdown
---
description: Quick answer
---
Answer concisely: $@
```

**After (with model switching):**
```markdown
---
description: Quick answer
model: claude-haiku-4-5
---
Answer concisely: $@
```

That's it. The extension picks up any prompt template with a `model` field and handles the switching automatically.

## Model Format

The `model` field accepts:

| Format | Example | Notes |
|--------|---------|-------|
| Model ID only | `claude-haiku-4-5` | Auto-detects provider |
| Full path | `anthropic/claude-haiku-4-5` | Explicit provider |

When multiple providers have the same model ID, prefers providers with auth configured, then by priority: `anthropic` > `github-copilot` > `openrouter`.

## Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `description` | No | Shown in autocomplete |
| `model` | Yes | Model ID or `provider/model-id` |

## Limitations

- Templates discovered at startup only. Restart pi after adding/modifying.
- Only scans top-level prompts directory (no subdirectories).
- Model restore state is in-memory. Closing pi mid-response loses restore state.
