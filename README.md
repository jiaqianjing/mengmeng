# MengMeng

MengMeng (萌萌) is a tiny CLI for managing Claude Code API providers on
headless Linux and macOS machines.

MengMeng is intentionally small: it helps advanced Claude Code users add,
inspect, tune, switch, import, and export provider profiles without repeatedly
editing config files by hand.

The command name is planned as `mm`.

> Name note: `mm` is short and memorable, but short command names can collide
> with local tools. The installer should check for an existing `mm` before
> writing to PATH.

## Product Focus

This tool is not a general AI client manager. The MVP supports Claude Code only.
Codex, Gemini CLI, OpenCode, MCP, Skills, proxy routing, and failover can be
considered later if the project proves useful.

The first version focuses on:

- Fast setup for Kimi Coding Plan, Xiaomi MiMo Coding Plan, GLM Coding Plan,
  DeepSeek, and custom relay providers.
- Automatic provider probing, model discovery, and default model selection.
- Safe switching with backups, atomic writes, and rollback.
- Claude Code power-user tuning, including permission prompt settings.
- Simple import/export for moving profiles across machines.
- Headless-friendly commands that work over SSH, in WSL, on remote Linux boxes,
  and in automation scripts.

## Installation

The first release should support two install paths:

```sh
# macOS/Linux, single-binary installer
curl -fsSL https://example.com/mengmeng/install.sh | sh
```

```sh
# macOS/Linux with Homebrew
brew tap example/mengmeng
brew install mengmeng
```

Installation should only place the `mm` binary on PATH. It should not modify
Claude Code config, import profiles, or start setup automatically.

After installation:

```sh
mm init
mm add kimi
mm use kimi
```

If a user runs another command before `mm init`, MengMeng should explain that
first-run setup is required once, offer to run it, and continue the original
command after setup completes.

## Example Commands

```sh
mm init
mm add kimi
mm add mimo
mm add glm
mm add deepseek
mm add custom

mm list
mm current
mm show kimi
mm use kimi
mm emit kimi
mm doctor

mm remove kimi
mm rollback

mm export --redact > mengmeng-profiles.json
mm import mengmeng-profiles.json
```

## MVP Commands

```text
mm init
mm add <provider>
mm list
mm current
mm show <profile>
mm use <name>
mm emit [profile]
mm doctor
mm remove <profile>
mm rollback [backup-id]
mm export [--redact|--include-secrets]
mm import <file>
```

Most commands should support `--json` once the implementation reaches scripting
support.

`mm list` should show the information users care about most: active profile,
provider mode, primary model, connectivity, and quota/limit status when the
provider supports it. Terminal color should highlight healthy, warning, and
exhausted quota states, with `--no-color` and `--json` for automation.

MVP command design should favor fewer verbs over a large command tree. Provider
templates, quota details, and permission tuning should be surfaced inside
`mm add`, `mm list`, `mm show`, and `mm doctor` before adding dedicated commands.

`mm emit [profile]` is the escape hatch for machines without MengMeng. It should
print a Claude Code-ready `settings.json` snippet for the selected profile, while
`mm export` remains reserved for MengMeng profile backup and migration.

## Storage Philosophy

The tool should keep its own profile data separate from Claude Code's live
configuration. Switching writes the selected profile into Claude Code's config,
but the source of truth remains in the tool's own config directory.

On first run, `mm init` should detect common shared-storage locations such as
iCloud Drive, Dropbox, OneDrive, Syncthing, or user-provided paths, then ask
whether to store MengMeng profiles there.

Claude Code's own live config should not be moved during initialization.

## Roadmap

Near term:

- Claude Code provider profiles.
- Kimi Coding Plan, Xiaomi MiMo Coding Plan, GLM Coding Plan, DeepSeek, and
  custom relay adapters.
- Model discovery and intelligent defaults.
- Quota lookup where provider APIs make it practical.
- Safe backup and rollback.
- Import/export.

Later:

- `mm self-update`.
- Shell completions.
- Optional Codex support.
- Optional Gemini CLI support.
- Optional MCP/Skills helpers.
- Optional local proxy or failover layer.
