# Changelog

## [Unreleased]

## [0.2.1] - 2026-01-31

### Fixed

- Thinking level now correctly restored after commands that switch model without a `thinking` field. Previously, running a prompt template that only specified `model` would reset thinking to "off" instead of restoring the original level (e.g., "high").

## [0.2.0] - 2025-01-31

### Added

- **Model fallback**: The `model` field now accepts a comma-separated list of models tried in order
- First model that resolves and has auth configured is used
- Supports mixing bare model IDs and explicit `provider/model-id` specs
- If the current model matches any candidate, it's used without switching
- Single consolidated error when all candidates fail
- Autocomplete shows fallback chain with pipe separator: `[haiku|sonnet]`
- Banner image

## [0.1.0] - 2025-01-12

### Added

- **Model switching** via `model` frontmatter in prompt templates
- **Print mode support**: Commands work with `pi -p "/command args"` for scripting
- **Thinking level control**: `thinking` frontmatter field with levels `off`, `minimal`, `low`, `medium`, `high`, `xhigh`
- **Skill injection**: `skill` frontmatter field injects skill content into system prompt via `<skill>` tags
- **Subdirectory support**: Recursive scanning creates namespaced commands like `(user:subdir)`
- **Auto-restore**: Previous model and thinking level restored after response (configurable via `restore: false`)
- **Provider resolution** with priority fallback (anthropic, github-copilot, openrouter)
- Support for explicit `provider/model-id` format
- Fancy TUI display for skill loading with expandable content preview
