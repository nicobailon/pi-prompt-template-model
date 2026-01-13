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

## Installation

Clone into your pi extensions directory:

```bash
git clone https://github.com/nicobailon/pi-prompt-template-model.git ~/.pi/agent/extensions/pi-prompt-template-model
```

Pi auto-discovers extensions from `~/.pi/agent/extensions/*/index.ts`, so no config changes needed. Just restart pi.

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

The `model` field accepts two formats:

```yaml
model: claude-opus-4-5               # Model ID only - auto-selects provider
model: github-copilot/claude-opus-4-5   # Explicit provider/model
```

### Explicit Provider Selection

Use the `provider/model-id` format when you want a specific provider:

```yaml
# Claude models - pick your provider
model: anthropic/claude-opus-4-5        # Direct Anthropic API
model: github-copilot/claude-opus-4-5   # Via Copilot/Codex subscription
model: openrouter/claude-opus-4-5       # Via OpenRouter

# OpenAI models - two different auth methods
model: openai/gpt-5.2                   # Direct OpenAI API key
model: openai-codex/gpt-5.2             # Via Codex subscription (OAuth)

# Other providers
model: google/gemini-3.0-pro            # Google AI Studio
model: xai/grok-3                       # xAI
model: mistral/mistral-large            # Mistral AI
```

### OpenAI vs OpenAI-Codex

These are **different providers** with different auth:

| Provider | Auth Type | Login Command |
|----------|-----------|---------------|
| `openai` | API Key | `pi login openai` → paste API key |
| `openai-codex` | OAuth | `pi login openai-codex` → web login through ChatGPT |

If you have a Codex subscription, use `openai-codex/gpt-5.2`. If you're paying per-token with an API key, use `openai/gpt-5.2`.

### Auto-Selection Priority

When you specify just the model ID (e.g., `model: claude-opus-4-5`), the extension picks a provider automatically:

1. Filters to providers where you have auth configured
2. If multiple matches, uses priority order: `anthropic` → `github-copilot` → `openrouter`
3. If only one match, uses that

## Frontmatter Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `model` | Yes | - | Model ID or `provider/model-id` |
| `description` | No | - | Shown in autocomplete |
| `restore` | No | `true` | Restore previous model after response |

### The `restore` Option

By default, the extension restores your previous model after the response. Set `restore: false` to stay on the new model:

```markdown
---
description: Switch to Haiku for the rest of this session
model: claude-haiku-4-5
restore: false
---
Switched to Haiku. How can I help?
```

Use cases for `restore: false`:
- Switching to a cheaper model for a long exploratory session
- Changing context to a specialized model (e.g., coding → writing)

## Limitations

- Templates discovered at startup only. Restart pi after adding/modifying.
- Only scans top-level prompts directory (no subdirectories).
- Model restore state is in-memory. Closing pi mid-response loses restore state.
