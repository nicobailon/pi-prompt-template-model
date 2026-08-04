# Changelog

## [Unreleased]

### Changed
- Added ordered multi-skill support to the `skill` frontmatter field for inline and delegated prompts, including comma-separated and YAML array forms, atomic resolution, full inline context injection, and name/path-only delegated request metadata. Thanks @RotarySC for #13 and @chrisgoddard for the delegated protocol metadata ideas in #12.
- Updated local Pi development dependencies to `@earendil-works/*` `^0.83.0` while keeping package installs on peer dependencies.
- Project-local prompt and skill discovery now respects Pi project trust; global prompt and skill locations still load normally.
- Prompt model selection now honors Pi scoped model restrictions when a session has scoped models configured.

### Fixed
- Added support for Pi's `max` thinking level in prompt frontmatter and rotation lists.
- `run-prompt` now throws tool errors for invalid command state or input instead of returning `isError` results.
- Delegated prompt cancellation now installs terminal input hooks only in TUI mode.

## [0.10.0] - 2026-07-01

### Changed
- Updated local Pi development dependencies to `@earendil-works/*` `0.80.3` and declared Pi core packages plus `typebox` as peer dependencies for package installs.

### Fixed
- Inline prompt templates with `restore: true` now restore the previous model and thinking level on the prompt turn's `agent_end`, instead of one unrelated user turn later.
- Idle `agent_end` events now skip context/model reads when there is no pending restore state or queued `run-prompt` command.
- Prompt commands now initialize from the active session cwd instead of `process.cwd()`, and extension-owned Pi paths use Pi's current config-directory helpers.
- Delegated prompt execution now uses the loaded `pi-subagents` event bridge instead of importing `pi-subagents` internals for agent discovery.
- Prompt templates listed in user or project `settings.json` `prompts` paths now receive this extension's frontmatter handling, including `model`, `thinking`, and `skill`.

## [0.9.3] - 2026-04-28

### Fixed
- Delegated prompt templates now discover `pi-subagents` installs from project-local Pi npm paths and sibling npm package paths instead of the legacy `subagent` extension path, fixing #1. Thanks @hschne for the report.

## [0.9.2] - 2026-04-28

### Fixed
- Prompt templates now accept provider-qualified model IDs that contain additional slashes, such as `openrouter/openai/gpt-5.4`, across prompt loading, model selection, compare lineups, and `<if-model>` conditionals.

## [0.9.1] - 2026-04-26

### Fixed
- `boomerang: true` prompt collapses now signal rewind to keep current files automatically, avoiding the restore-options prompt during collapse.

## [0.9.0] - 2026-04-25

### Added
- Added `boomerang: true` prompt frontmatter so non-chain templates, including looped templates, can run through prompt-template-model and then collapse their execution context back to the pre-run branch.

### Fixed
- Migrated extension tool schemas from `@sinclair/typebox` to `typebox` 1.x so packaged installs follow Pi's current extension runtime contract.

### Changed
- Added `typebox` as a runtime dependency for packaged installs.

## [0.8.2] - 2026-04-21

### Added
- Added the packaged `prompt-template-authoring` skill for creating and maintaining prompt templates with this extension.

### Changed
- Tightened the shipped skill guide so it stays short, repo-specific, and aligned with the actual prompt-template runtime.

### Fixed
- Corrected the shipped skill examples for model fallback vs rotation, argument substitution, deterministic handoff behavior, chain context wording, runtime flag syntax, and prompt discovery rules.
- Removed the emoji from the skill-loaded renderer so the UI copy matches the extension's plain-text style.

## [0.8.1] - 2026-04-21

### Added
- Added agent skill `prompt-template-authoring` for writing, managing, and running custom prompt templates. Registered in `package.json` under `pi.skills`.

## [0.8.0] - 2026-04-21

### Added
- Added first-class deterministic prompt-template execution for single prompt templates via `deterministic:` or shorthand `run` / `script` frontmatter. Templates can run one direct command or script before any optional LLM turn.
- Added configurable deterministic-step handoff policies: `always`, `never`, `on-success`, and `on-failure`.
- Added deterministic result cards that always show the executed command or script, resolved `cwd`, exit code, duration, and stdout/stderr previews.
- Added deterministic-step `env` support plus `nonInteractive` control for deploy/release-style scripts that need explicit environment variables or want to disable the default non-interactive guardrail env bundle.
- Added a visible deterministic completion message for `handoff: never`, so no-handoff runs still end with an explicit completion marker after the result card.

### Changed
- When a deterministic prompt hands off to the model, the extension now prepends a generated `[Deterministic step]` block with structured execution metadata and truncated stdout/stderr previews before the prompt body.
- Deterministic stdout/stderr payloads are now capped before they are stored in message details, while preserving total line/character counts and truncation metadata for both the card UI and the LLM handoff block.

### Fixed
- Added regression coverage for deterministic loader parsing, relative script resolution, handoff gating, and the no-handoff fast path.
- Deterministic timeouts now escalate from `SIGTERM` to `SIGKILL` if the child process does not exit within the post-timeout grace window.

## [0.7.3] - 2026-04-14

### Fixed
- `/chain-prompts` and chain templates now resolve plain prompt files without extension-specific frontmatter, so standard prompts like `double-check -> deslop` work in chain execution.
- Added regression coverage for plain-prompt chain resolution while keeping ordinary prompt-template command registration unchanged.

## [0.7.2] - 2026-04-04

### Changed
- Added a `promptSnippet` for `run-prompt` so Pi 0.59+ includes it in the default tool prompt section and keeps prompt-template execution discoverable in agent turns.

## [0.7.1] - 2026-04-03

### Changed
- Bumped `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`, and `@mariozechner/pi-tui` to `^0.65.0` and updated the extension for the pi `0.65.0` session/runtime breaking changes (`session_start` migration and `getApiKeyAndHeaders()` auth lookup).

### Fixed
- Added regression coverage for the shipped `best-of-n` example and re-verified the installed prompt still matches the shipped example used for manual installs.

## [0.7.0] - 2026-04-01

### Added
- Added a first-class `bestOfN:` prompt-template authoring surface for compare workflows, with configurable `workers`, `reviewers`, optional `finalApplier`, and nested `bestOfN.worktree` support.
- Added configurable compare runtime overrides via `--workers`, `--reviewers`, `--workers-append`, `--reviewers-append`, and `--final-applier`.
- Added `count: N` compare-slot shorthand so one worker or reviewer slot can fan out into repeated identical runs without manual duplication.
- Added a shipped `/best-of-n` example prompt that demonstrates mixed worker counts, mixed reviewer counts, thinking-level model suffixes, `taskSuffix`, and final real-branch application.

### Changed
- Compare prompts now run as worker fan-out, reviewer fan-in, then an optional final apply step that edits the real branch instead of stopping at recommendation prose.
- Reviewer defaults now stay findings-only, while `finalApplier` handles winner-picking or synthesis plus best-effort verification on the current branch.
- Legacy top-level compare frontmatter in templates (`workers`, `reviewers`, `finalApplier`, top-level compare `worktree`) is now rejected in favor of `bestOfN:`.
- Delegated parallel live rendering now shows richer per-task output, including task index, model, recent tools, and bounded rolling output lines.
- README and bundled examples were refreshed to match the shipped compare/runtime surface, including `bestOfN`, compare-wide vs slot-level `cwd`, and chain `parallel(...)` `cwd` rules under `worktree: true`.

### Fixed
- Compare execution now allows partial success by phase: worker and reviewer phases continue as long as at least one slot succeeds, and `finalApplier` can still fall back to worker-only evidence when every reviewer fails.
- Preserved successful worker `=== Worktree Changes ===` summaries when building reviewer and final-apply inputs, so downstream compare stages do not lose worktree evidence.
- Invalid `bestOfN` blocks and legacy compare templates no longer degrade into ordinary runnable prompts after diagnostics; they are skipped entirely.
- `finalApplier` validation now correctly rejects unsupported `cwd` and `count` fields in both frontmatter and runtime overrides.
- Corrected remaining docs/tooling drift, including the `run-prompt` unlimited-loop cap text and compare/chain `cwd` wording.

## [0.6.10] - 2026-03-30

### Added
- Added lineup-based compare frontmatter for prompt templates: `workers` and `reviewers` slot lists (`agent` or `subagent`, optional `model`, optional `task`, optional `taskSuffix`, optional `cwd`, optional `count`), plus optional `finalApplier` for one final apply step.
- Added a two-phase compare execution flow for lineup templates: parallel worker phase first, then reviewer phase fed by aggregated worker output.
- Added runtime lineup override flags for compare templates: `--workers`, `--reviewers`, `--workers-append`, `--reviewers-append`, and `--final-applier`.
- Added compare lineup `count: N` shorthand so one worker or reviewer slot can expand into repeated identical runs without manually duplicating entries.
- Added an example compare prompt template under `examples/`: `best-of-n`, intended for manual installation into `~/.pi/agent/prompts/`.
- Added compare-lineup `subagent` shorthand so prompt authors can use `subagent: true` for default worker/reviewer slots instead of spelling the internal `delegate` / `reviewer` agent names directly.

### Changed
- Prompt-template compare authoring now uses nested `bestOfN:` frontmatter; the loader lowers `bestOfN.workers`, `bestOfN.reviewers`, `bestOfN.finalApplier`, and `bestOfN.worktree` into the existing runtime compare fields and rejects legacy top-level compare fields in templates.
- Removed fixed three-worker compare assumptions from docs and prompt guidance; compare lineups are now caller-defined and duplicate slots are preserved.
- The shipped `best-of-n` example now shows mixed workers, mixed reviewers, and an optional final apply phase, while the runtime fallback still stays at one worker when `workers` is omitted.
- Reviewers now default to findings-only output, and the optional final phase now applies the real-branch patch instead of ending at recommendation prose.
- Parallel delegated task contract now supports per-task `cwd` passthrough end-to-end across the prompt-template bridge.
- README now explains same-model vs multi-model best-of-N configuration explicitly.

### Fixed
- Compare execution now uses partial-success-by-phase behavior: worker and reviewer phases continue as long as at least one slot succeeds, and `finalApplier` can fall back to worker-only synthesis if reviewer slots all fail.
- Compare lineup slots now support `taskSuffix` so shared worker/reviewer instructions can stay in the prompt body while slots add small per-model suffixes such as output-file paths.
- Documented the current compare worktree constraint explicitly: when `worktree: true` is enabled, all worker slots must resolve to the same `cwd`.

## [0.6.9] - 2026-03-28

### Added
- Added `worktree: true` frontmatter and `--worktree` runtime flag for chain templates with parallel steps. When enabled, each parallel subagent runs in its own git worktree to avoid file conflicts during concurrent execution. Requires a chain with at least one `parallel()` step.
- Added `parallel: N` frontmatter for delegated prompts. This expands one delegated prompt into `N` parallel `pi-subagents` tasks targeting the same agent, with automatic slot headers like `[Parallel subagent 2/3]` prepended to each task.

### Changed
- Bumped `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`, and `@mariozechner/pi-tui` to `^0.64.0`.
- Delegated prompt execution now forwards `ctx.signal` into subagent runs so turn cancellation can stop in-flight delegated work for both single delegated prompts and delegated parallel chain steps.
- `worktree: true` now also works on delegated prompts that use `parallel: N`, not just chain templates with `parallel()` steps.

## [0.6.8] - 2026-03-28

### Added
- Delegated prompt results are now injected back into the parent conversation as a user message, triggering an agent turn so the parent agent can process and respond to the delegation outcome. Applies to single delegated runs, delegated loops, and delegated chain steps.

## [0.6.7] - 2026-03-28

### Changed
- Delegation progress widget now shows a unified tool stream where completed tools scroll chronologically with the active tool highlighted at the bottom, replacing the old design where the active tool flashed at the top and disappeared on completion.
- Delegation progress widget now renders the subagent's model name in the header (e.g., `delegate [fork] gpt-5.3-codex | 14 tools, 170k tok, 2m47s`).
- Delegation progress widget no longer caps tool history or output lines. The box grows to show the full execution trace.
- Delegation progress widget now refreshes every second during idle periods (model thinking) so the elapsed timer ticks smoothly instead of freezing between progress updates.
- Enriched the delegation bridge protocol to pass through full `recentOutputLines`, `recentTools` history, and `model` from pi-subagents progress data, replacing the old single-line `recentOutput` and missing tool/model fields.
- Removed `lastTool`/`lastToolArgs` tracking from live state (dead code after the unified tool stream redesign).

## [0.6.6] - 2026-03-28

### Added
- Added `--model=provider/model-id` runtime flag to override a template's model for a single invocation. Works with single execution, loops, and delegation.
- Added `--fork` runtime flag to enable `inheritContext` (forked context) at invocation time. Implies `--subagent` if not already set.
- Inline loop iterations now include a `[Loop 2/5]` prefix so the agent knows it's in a loop and which iteration it's on. Delegated (subagent) loops are unaffected.
- Added `loop: unlimited` (and `loop: true`) frontmatter for open-ended loops that run until convergence, user interrupt, or the 999-iteration safety cap.
- Added model rotation for loop iterations via `rotate: true` frontmatter. Cycles through comma-separated models and thinking levels each iteration instead of using fallback semantics.

### Fixed
- Pressing Escape during a loop or chain iteration now stops the loop. Previously, aborted inline turns were treated as "no changes" and the loop continued.
- Delegation errors during loop iterations no longer abort the entire loop. The error is reported and the loop continues to the next iteration (useful with model rotation where one model may fail but others succeed).
- Per-step bare `--loop` in chain declarations (e.g., `double-check --loop -> deslop`) now correctly runs unlimited iterations instead of running once.

### Changed
- Unlimited loops (`--loop` bare or `loop: unlimited`) no longer force convergence on. Convergence follows the `converge` field like bounded loops. Safety cap raised from 50 to 999.

## [0.6.5] - 2026-03-24

### Added
- Added delegated chain-step context summaries via `chainContext: summary` (chain frontmatter), `/chain-prompts ... --chain-context` (command-level), and per-step `--with-context` (single delegated chain steps).

## [0.6.4] - 2026-03-23

### Fixed
- Updated skill command resolution to use `sourceInfo.path` instead of the removed `path` field on `SlashCommandInfo`, fixing compatibility with pi-coding-agent 0.62.0 source provenance changes.

## [0.6.3] - 2026-03-21

### Added
- Chain step progress now shows in the status bar (e.g., `step 2/3: simplify`) and persists until the chain completes, instead of only appearing as a notification that scrolls away.
- Added `parallel(...)` chain step support for delegated prompt templates, including parser/frontmatter validation, delegated task fan-out, aggregated result rendering, and per-task progress display.

### Fixed
- Delegated subagent errors now show as clean notifications instead of extension crash messages with stack traces, matching how other validation errors (missing skill, missing template, etc.) are presented.
- When no subagent bridge is listening (extension not loaded, name collision with another extension), delegation now fails immediately with a diagnostic message instead of silently waiting 15 seconds before timing out.
- Timeout error message no longer dumps the full rendered prompt content; uses the agent name instead.
- Parallel delegated status now prefers aggregate `parallel X/Y running` updates over first-task tool labels, avoiding misleading `running <tool>` status lines during multi-task execution.

## [0.6.2] - 2026-03-20

### Added
- Added delegated-subprocess working directory controls via `cwd` frontmatter (for `subagent` prompts and chain-template defaults) plus runtime `--cwd=<path>` overrides.

### Fixed
- Rewrote README for clarity: fixed default subagent name (`delegate`, not `worker`), corrected provider priority to include `openai-codex`, merged broken frontmatter table into grouped sections with readable descriptions, cut redundant examples, and tightened prose throughout.

## [0.6.1] - 2026-03-20

### Added
- Added delegated prompt execution via direct extension event bus communication with `subagent` (`prompt-template:subagent:*` channels), including delegated custom-message persistence for loop summaries and context carry-forward.
- Added prompt frontmatter support for `subagent` and `inheritContext`, with `inheritContext: true` mapped to delegated fork context.
- Fork context preamble is handled by the subagent extension directly (via `DEFAULT_FORK_PREAMBLE` in `types.ts`), applying to all fork-context subagent runs universally.
- Added runtime delegation override flags: `--subagent`, `--subagent=<name>`, and `--subagent:<name>`.
- Added live progress widget above editor during delegated subagent runs showing elapsed time, tool count, tokens, current tool, and task preview — matching the native subagent tool card layout.
- Added styled completion card with task preview, tool call history, expandable output (Ctrl+O), and usage stats footer.

### Changed
- Updated provider priority for ambiguous bare model IDs to prefer `openai-codex` before `anthropic`, `github-copilot`, and `openrouter`.
- Updated loop convergence and fresh-summary analysis to account for delegated subagent message payloads.

### Fixed
- Delegated start-time hangs now fail fast with explicit timeout errors when a subagent run never emits a start signal.
- Delegated runs no longer treat arbitrary escape-sequence-bearing terminal input as an Esc cancellation signal; only literal Esc cancels.
- Chain and loop restore paths now use live runtime model/thinking state during cleanup, preventing skipped restore on mid-step failures.

## [0.6.0] - 2026-03-19

### Changed

- Clarified the README chain examples so the optional ` -- ` shared-args separator is clearly distinct from loop flags like `--loop`, `--fresh`, and `--no-converge`.
- Clarified in the README that chain frontmatter declarations support per-step `--loop N` inside the `chain:` value.
- Argument substitution now accepts `@$` as an alias for `$@` for compatibility with commonly-typed placeholder variants.
- Skill injection now uses a next-turn context message from `before_agent_start` instead of mutating the turn system prompt.
- Non-chain templates can now omit `model` and inherit the current session model, so inline `<if-model ...>` rendering and skill injection still work without explicit model frontmatter.
- Chain steps without `model` now inherit a fixed chain-start model snapshot, so model-less chain steps behave as if that model were declared in frontmatter while remaining deterministic across step switches.

### Fixed

- Chain step execution now avoids implicit previous-step model bleed for model-less templates by resolving them against the chain-start model snapshot instead of whichever model was active after the prior step.
- Model-less prompt loading now skips plain templates that do not use extension features, preventing command collisions with other extension commands like `/review` and `/handover`.
- Model-less prompt loading now also ignores no-op/invalid-only extension metadata (for example `restore`-only or invalid loop flags), so ineffective frontmatter does not unnecessarily claim command names.
- Model-less prompt loading now recognizes invalid conditional closers like `</else>` as extension-relevant markup, so those templates stay in this extension path and surface proper conditional-parse warnings instead of silently bypassing extension handling.
- Model-less prompt execution now tracks runtime model changes (`model_select` + internal switches/restores) and uses that tracked model instead of potentially stale command-context snapshots.
- Prompt commands now fail fast when a configured `skill` file is missing or unreadable, instead of silently sending the prompt without skill context.
- Skill resolution now returns a typed success/error outcome that callers handle explicitly, rather than emitting notifications from inside the resolver and returning sentinel `null` values.
- Session start/switch now clear any queued skill context message so stale pending skill payloads cannot leak across session boundaries.
- Session start/switch now also clear pending single-command restore state (`previousModel`/`previousThinking`) so restore writes cannot leak into a different session.
- Skill frontmatter resolution now checks registered skill commands first (`pi.getCommands()` skill entries), accepts both `<name>` and `skill:<name>` values, searches additional standard pi skill locations (`.agents/skills` in project ancestors and `~/.agents/skills`), supports direct `<skill>.md` files alongside `SKILL.md` directories, and rejects traversal-like skill names for path fallback.
- `extractLoopCount()` now strips repeated unquoted `--loop` tokens once looping is active, preventing stray loop flags from leaking into prompt arguments.
- Chain frontmatter step parsing now strips repeated per-step `--loop` tokens once a valid per-step loop is resolved, and keeps the first valid value (including mixed invalid/valid numeric sequences like `--loop 1000 --loop 2`).
- Loop-mode restore now tracks runtime model/thinking state per iteration instead of relying on command-context model snapshots, so model restoration remains correct even when command context values are stale.
- Chain execution now restores model/thinking state in a `finally` path, so restore still runs after unexpected runtime errors during a chain step and chain cleanup state is still reset even when restore itself fails.
- Loop and chain executions no longer report `Loop finished`/`Loop converged` when runtime errors abort execution mid-loop.
- Loop and chain error propagation now preserves thrown falsy values (for example `throw 0`) instead of treating them as success, preventing swallowed errors and false completion notifications.

## [0.5.0] - 2026-03-17

### Added

- Loop execution via `--loop` flag: `--loop N`, `--loop=N` to run a prompt N times (1-999), or bare `--loop` for unlimited until convergence with a 50-iteration safety cap. Bare `--loop` always forces convergence on.
- Frontmatter loop controls: templates can now set `loop: N` (1-999) and `converge: false` defaults; CLI `--loop` overrides frontmatter `loop`, and `--no-converge` disables convergence for bounded loops.
- Convergence detection: loops stop early when an iteration makes no file changes (`write`/`edit`). Enabled by default; `--no-converge` opts out.
- Fresh context mode: `--fresh` flag or `fresh: true` frontmatter collapses conversation between loop iterations, keeping only accumulated summaries. Saves tokens on long loops.
- Loop iteration context injected into the system prompt so the agent builds on previous work across iterations.
- Loop progress indicator in the TUI status bar.
- `run-prompt` agent tool: the agent can run prompt templates, chains, and loops on its own. Opt-in via `/prompt-tool on [guidance]`. Config persists in `~/.pi/agent/prompt-template-model.json`.
- Chain templates: new `chain` frontmatter field to declare reusable template pipelines (`chain: double-check --loop 2 -> deslop --loop 2`). Per-step `--loop N` loops each step independently. No `model` required — each step uses its own. Supports `loop`, `fresh`, `converge`, `restore` for overall execution control. Chain nesting is rejected at runtime.

### Fixed

- `readSkillContent` no longer swallows read errors. The caller now sees the actual error message (e.g., permission denied) instead of a generic "Failed to read skill" notification.
- `restoreSessionState` no longer clears `pendingSkill` as a side effect unrelated to model/thinking restoration.
- Error diagnostics now consistently use `String(error)` instead of hardcoded fallback strings.

## [0.4.0] - 2026-03-13

### Added

- Inline `<if-model is="...">...</if-model>` blocks with optional `<else>` branches inside prompt bodies.
- Provider wildcard matching in conditionals with syntax like `anthropic/*`.
- Conditional rendering now happens after model fallback resolution for both single prompt commands and `/chain-prompts`.
- Prompt argument substitution now mirrors pi core more closely, including `${@:N}` and `${@:N:L}` slice syntax. See README for full placeholder reference.

### Fixed

- Model fallback now preserves the currently active model whenever it matches any listed fallback candidate, including ambiguous bare model IDs that would otherwise resolve through provider preference, instead of switching to an earlier candidate unnecessarily.
- Prompt templates that collide with reserved slash commands, including built-ins like `/model` and the extension’s own `/chain-prompts`, are now skipped with a warning instead of being silently shadowed.
- Prompt discovery is now deterministic in a locale-independent way, and duplicate model-enabled prompt names within the same source layer are skipped with a warning instead of silently depending on traversal order.
- Invalid `model` frontmatter declarations are now rejected during prompt loading with diagnostics instead of failing later at execution time.
- Literal tags like `<elsewhere>` and `</if-modeling>` no longer get misparsed as malformed conditional directives.
- Non-interactive notifications now go to stderr so print-mode stdout stays clean.
- Bare model IDs with multiple providers can now still resolve through OAuth-backed auth checks even when fast availability checks alone are inconclusive.
- Optional string frontmatter fields are now trimmed so quoted values like `thinking: " high "` and `skill: " tmux "` behave as expected.
- Existing prompt commands now refresh prompt files before execution, so edits made during a session take effect on the next run instead of waiting for a new session.
- Skill-loaded custom messages now fail safe if their details payload is missing instead of crashing the renderer.
- Frontmatter `model` specs and inline conditional `is` specs now reject internal whitespace like `anthropic /model` or `anthropic /*` instead of silently registering values that can never match.
- Recursive prompt discovery now detects already-visited directories and skips symlink loops instead of risking infinite recursion or duplicate traversal.
- Bare model IDs now honor provider priority across all auth-capable candidates, including OAuth-backed providers, instead of incorrectly favoring a lower-priority provider just because it appeared in the fast-available set.
- Prompt loading now rejects non-object YAML frontmatter roots, like lists, with a diagnostic instead of silently treating them as missing `model` fields.
- `/chain-prompts` now only restores model and thinking when they actually changed, avoiding redundant state writes and noisy restore notifications on no-op chains.
- `/chain-prompts` now tracks thinking changes caused by model switches even when a step does not set `thinking`, so final restoration stays correct when the runtime clamps or resets thinking during a model change.
- `/chain-prompts` now rejects empty or quote-only step segments explicitly instead of treating them as blank template names.
- Single-command auto-restore now also skips no-op thinking restores and notifications when the runtime is already back on the original thinking level.
- Removed unnecessary exports: `modelSpecMatches` from model-selection.ts and `VALID_THINKING_LEVELS` from prompt-loader.ts are now internal implementation details.
- `/chain-prompts` now correctly ignores ` -- ` and `->` inside quoted per-step arguments instead of misinterpreting them as separators.
- `</else>` is now explicitly rejected with a helpful error message explaining that `<else>` is a separator, not a container.
- Fast-path optimization now correctly includes `</else>` check so standalone invalid tags are caught.
- Empty prompt abort in single-command mode now notifies as "error" instead of "warning" for consistency with chain mode.

## [0.3.1] - 2026-02-08

### Fixed

- Prompts map now initialized at extension load instead of waiting for `session_start`. Commands invoked before the first session event no longer fail with stale empty state.

## [0.3.0] - 2026-02-08

### Added

- **Chain command**: `/chain-prompts` orchestrates multiple prompt templates sequentially, each with its own model, skill, and thinking level. Conversation context flows between steps naturally.
- Per-step args override shared args: `/chain-prompts analyze "error handling" -> fix-plan "focus on perf" -> summarize -- src/main.ts`
- Mid-chain failure rolls back to the original model and thinking level
- Step progress notifications show which step is running
- State isolation: chain uses local variables, never interferes with single-command restore behavior

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
