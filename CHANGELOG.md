# Changelog

## 2025-01-12

**Print Mode Support**

- Commands now work with `pi -p "/command args"` for scripting
- Handler waits for agent to complete before returning

**Thinking Level Control**

- Added `thinking` frontmatter field to set thinking level per prompt
- Valid levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`
- Previous thinking level restored after response (when `restore: true`)
- Thinking level shown in autocomplete: `[sonnet high]`

**Skill Injection**

- Added `skill` frontmatter field to inject skill content into system prompt
- Skills resolved from project (`.pi/skills/`) first, then user (`~/.pi/agent/skills/`)
- Skill content wrapped in `<skill name="...">` tags for clear context
- Fancy TUI display: expandable box shows skill name, path, and truncated content preview

**Subdirectory Support**

- Prompts directory now scanned recursively
- Subdirectories create namespaced commands shown as `(user:subdir)` or `(project:subdir)`
- Example: `~/.pi/agent/prompts/frontend/component.md` → `/component (user:frontend)`

**Documentation**

- Expanded Model Format section with explicit provider selection examples
- Added OpenAI vs OpenAI-Codex distinction (API key vs OAuth)
- Documented auto-selection priority for models on multiple providers
- Updated examples to use latest frontier models

**Initial Release**

- Model switching via `model` frontmatter in prompt templates
- Auto-restore previous model after response (configurable via `restore: false`)
- Provider resolution with priority fallback (anthropic → github-copilot → openrouter)
- Support for explicit `provider/model-id` format
