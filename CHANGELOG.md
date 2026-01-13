# Changelog

## 2025-01-12

**Documentation**

- Expanded Model Format section with explicit provider selection examples
- Added OpenAI vs OpenAI-Codex distinction (API key vs OAuth)
- Documented auto-selection priority for models on multiple providers
- Updated examples to use latest frontier models (claude-opus-4-5, gpt-5.2, gemini-3.0-pro, grok-3)

**Initial Release**

- Model switching via `model` frontmatter in prompt templates
- Auto-restore previous model after response (configurable via `restore: false`)
- Provider resolution with priority fallback (anthropic → github-copilot → openrouter)
- Support for explicit `provider/model-id` format
