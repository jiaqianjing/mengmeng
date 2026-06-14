# MengMeng Product Notes

## Positioning

MengMeng (萌萌) is a tiny Claude Code provider assistant for power users.

It reduces the repeated work required to connect Claude Code to domestic coding
plans, third-party relays, and custom gateways from a terminal-only environment.
The product should feel like a precise workshop tool: simple, stable, and smart
about the parts that are annoying to configure manually.

## Non-Goals

- Do not build a desktop replacement for CC Switch.
- Do not support every AI coding tool in the MVP.
- Do not become a generic JSON/TOML editor.
- Do not introduce proxy routing, protocol conversion, or failover in v0.1.
- Do not hide dangerous Claude Code behavior changes behind silent defaults.
- Do not over-engineer a plugin system before the built-in adapters are useful.

## Target Users

- Developers using Claude Code on Linux/macOS servers, SSH hosts, WSL, or remote
  development machines.
- Claude Code power users who frequently switch between official access,
  domestic coding plans, team gateways, and third-party relays.
- Solo developers who want quick setup today, with enough structure to become a
  small public project later.

## Core Value

Manual Claude Code provider setup involves repetitive and error-prone work:

- Finding the right base URL.
- Deciding which API key field to use.
- Discovering supported model names.
- Mapping models to Claude Code's default model slots.
- Preserving unrelated Claude Code settings while switching.
- Remembering permission prompt tweaks.
- Backing up and restoring configs when something breaks.

MengMeng should automate those chores while keeping the resulting config
easy to inspect.

## MVP Scope

The MVP supports Claude Code only.

Initial provider targets:

- Kimi Coding Plan.
- Kimi API.
- DeepSeek API.
- Xiaomi MiMo Coding Plan.
- GLM Coding Plan.
- Custom OpenAI-compatible or Anthropic-compatible relay.

Core workflows:

- First-run initialization.
- Lazy first-run prompt when another command is used before initialization.
- Add provider through an interactive adapter.
- Probe provider connectivity.
- Discover available models.
- Recommend default model mapping.
- Show usage-aware profile lists with quota/limit status when supported.
- Switch active provider.
- Show current provider.
- Diagnose local Claude Code integration.
- Tune Claude Code permission prompt settings during guided setup.
- Export and import profiles.
- Backup and rollback live config.

## Installation

The first public release should support:

- curl-based binary install for macOS and Linux.
- Homebrew install for macOS and Linux.

The installer should:

1. Detect OS and architecture.
2. Download the matching release binary.
3. Prefer a user-writable install path such as `~/.local/bin` for curl install.
4. Check whether `mm` already exists before writing.
5. Print the next step: `mm init`.

The installer must not:

- Modify Claude Code config.
- Create provider profiles.
- Import current config.
- Run `mm init` automatically.
- Require `sudo` by default.

Homebrew should be supported from v0.1 because macOS users are a primary target.
Early distribution can use a project tap before considering homebrew-core.

## First-Run Flow

`mm init` should:

1. Detect OS and shell.
2. Detect whether Claude Code appears to be installed.
3. Detect the live Claude Code config path.
4. Validate existing Claude Code config format.
5. Offer to import the existing config as an initial profile.
6. Detect shared-storage candidates:
   - iCloud Drive on macOS.
   - Dropbox.
   - OneDrive.
   - Syncthing.
   - Existing user-provided config directory through environment variable.
7. Ask whether to store MengMeng profile data in default local storage,
   detected shared storage, or a custom path.
8. Create an initial backup before any live config write.

Initialization must not move Claude Code's own live config.

`mm init` is the formal setup entrypoint. If a user runs another command before
initialization, the command should pause and show:

```text
MengMeng has not been initialized yet.

Before managing Claude Code providers, MengMeng needs to set up:
  - where profiles are stored
  - whether to import your current Claude Code config
  - where backups should be written
  - whether to use shared storage such as iCloud Drive

This only needs to be done once.
You can change these choices later with:

  mm init

Continue setup now? [Y/n]
```

If the user accepts, run the same setup flow as `mm init`, then continue the
original command. For example, `mm add kimi` should resume provider setup after
initialization completes.

If the user declines, do not mutate state. Print:

```text
Cancelled.

Run `mm init` when you're ready.
```

When run after initialization, `mm init` should become a settings-management
entrypoint rather than blindly resetting state:

```text
MengMeng is already initialized.

What would you like to change?
  1. Profile storage location
  2. Backup location
  3. Import current Claude Code config as a profile
  4. Re-run full setup
  5. Cancel
```

`mm init` should be low risk: it must not change the active Claude Code provider
unless the user explicitly asks to import, switch, or rewrite live config.

## Provider Adapter Contract

Each built-in provider adapter should answer:

- Display name and stable provider id.
- Required fields.
- Optional fields.
- Secret fields.
- Default base URL candidates.
- API format: Anthropic-compatible, OpenAI-compatible, or provider-specific.
- How to test connectivity.
- How to list models.
- How to classify models for Claude Code defaults.
- Whether quota lookup is supported.
- How to fetch quota when supported.
- Any recommended Claude Code settings.

Adapters should keep provider-specific logic local. The command layer should not
know special-case details for Kimi, MiMo, GLM, DeepSeek, or future providers.

## Model Selection Rules

After model discovery, the tool should recommend a mapping for:

- Main model.
- Haiku-equivalent model.
- Sonnet-equivalent model.
- Opus-equivalent model.

Selection should prefer coding-plan models when detected. If the provider exposes
ambiguous models, ask the user to choose from a short ranked list instead of
dumping the full model catalog.

The recommendation engine should be explainable in `mm show <name>`:

```text
main:  kimi-k2-coding-latest  (chosen because name includes coding/latest)
sonnet: kimi-k2-coding-latest  (same as main; no smaller coding model detected)
haiku:  kimi-k2-fast           (chosen as fastest detected fallback)
opus:   kimi-k2-coding-latest  (highest capability detected)
```

## Permission Tuning

Power-user permission settings should be explicit, but not necessarily exposed
as a standalone MVP command. The first version should offer them during guided
setup when a provider is added or when `mm init` is re-run.

Later, a dedicated command can be added if the workflow proves common enough.

Power-user mode may set:

```json
{
  "skipDangerousModePermissionPrompt": true,
  "skipAutoPermissionPrompt": true
}
```

The tool should show a concise confirmation before enabling these settings in an
interactive session. In non-interactive usage, require an explicit flag.

## Storage

Default local storage:

```text
~/.config/mengmeng/
```

Suggested layout:

```text
config.json
profiles.json
secrets.json or OS keychain references
backups/
```

Use plain JSON for v0.1 unless implementation constraints strongly favor another
format. Keep the data model boring and inspectable.

Secrets strategy:

- Never print secrets by default.
- `export` redacts secrets by default.
- `export --include-secrets` must be explicit.
- macOS can later use Keychain.
- Linux can later support Secret Service, pass, or encrypted files.
- v0.1 may store secrets locally if the user accepts that tradeoff.

## Claude Code Live Config

The switch operation should:

1. Read existing live config.
2. Validate parseability.
3. Back it up.
4. Merge provider-managed fields.
5. Preserve unrelated settings.
6. Write through a temporary file and rename.
7. Verify the file can be parsed after write.

The tool should avoid treating the live config as its only source of truth.

## Import And Export

Export defaults to complete output because it is mainly for moving MengMeng
profiles between the user's own machines:

```sh
mm export > private-profiles.json
```

Redaction is available for sharing or debugging:

```sh
mm export --redact > redacted-profiles.json
```

Import should support:

- Merging new profiles.
- Replacing all profiles with confirmation.
- Detecting duplicates by provider id and profile name.

## Remove Profiles

`mm remove <profile>` should delete a saved MengMeng profile.

It should not silently rewrite Claude Code's live config. If the profile being
removed is active, ask the user to switch first or confirm that only the saved
profile should be removed:

```text
`kimi` is currently active in Claude Code.

Remove the saved MengMeng profile but leave Claude Code's current settings as-is?
[y/N]
```

This keeps remove low risk and preserves the principle that MengMeng does not
trap users into its own store.

## Usage-Aware Listing

`mm list` should be more than a stored-profile table. It should summarize the
state a Claude Code user cares about before switching:

```text
✹ kimi        Kimi Coding Plan   kimi-k2.7-code   5h 42%  week 18%   ok
  glm-work    GLM Coding Plan    glm-5.1-coding   5h 76%  week 51%   warn
  deepseek    DeepSeek API       deepseek-chat     balance ¥3.21 RMB  ok
  official    Claude Official    claude-sonnet     local             fallback
```

Columns should stay compact by default:

- Active marker.
- Profile name.
- Provider and mode.
- Main model.
- Quota, limit, balance, or unknown status.
- Health status.

For coding-plan providers, adapters may expose quota sync. Kimi Coding Plan, for
example, can be queried through a usage endpoint shaped like:

```text
GET https://api.kimi.com/coding/v1/usages
Authorization: Bearer <api-key>
```

The returned usage should be normalized into tiers such as:

- 5-hour window.
- Weekly window.
- Reset time when available.
- Utilization percentage.

Display rules:

- Green: healthy.
- Yellow: nearing limit.
- Red: exhausted, invalid, or key rejected.
- Dim/gray: not supported or not exposed by the provider API.

Terminal color should be enabled when stdout is a TTY and disabled for pipes.
Support `--no-color` and `--json`.

`mm list` should synchronize the latest quota, API balance, and connectivity
status by default. For API providers, prefer account balance over vague limit
copy when a balance endpoint exists. If neither quota nor balance is exposed,
show `usage not exposed` instead of pretending. The adapter should include a
console URL when useful.

Avoid adding standalone quota commands in the MVP. Detailed quota information can
live in `mm show <profile>` and list output until there is clear demand
for a separate verb.

## Minimal Command Surface

The MVP should keep the visible command set small:

```text
mm init
mm add <provider>
mm list
mm current
mm show <profile>
mm use <profile>
mm doctor
mm remove <profile>
mm rollback [backup-id]
mm export [--redact]
mm import <file>
```

Avoid documenting aliases or deeply nested forms in the first README. Concepts
such as provider templates, quota, model refresh, permission tuning, and backup
history should be handled inside these commands before earning dedicated verbs.

## Doctor Checks

`mm doctor` should check:

- OS and architecture.
- Claude Code executable availability.
- Claude Code config path.
- Tool config path.
- Whether config path is in shared storage.
- Live config parseability.
- Current profile existence.
- Provider base URL reachability.
- Model list fetch status.
- Quota lookup status when supported.
- Permission prompt setting status.

## Command Design Principles

- Interactive by default when run by a human.
- Scriptable with flags and `--json`.
- No hidden mutation in read commands.
- Back up before live config writes.
- Explain what changed after mutation commands.
- Prefer a short ranked choice over exposing raw provider complexity.

## Public Release Notes

If this becomes public, keep the public package name distinct from the short
binary name. `mm` is pleasant for daily use, but the installer should detect and
warn about any existing local `mm` command before writing to PATH.
