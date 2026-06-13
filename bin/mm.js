#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const VERSION = 1;
const KIMI_CODING_BASE = "https://api.kimi.com/coding";
const KIMI_MODELS_URL = "https://api.kimi.com/coding/v1/models";
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const QUOTA_CACHE_MS = 5 * 60 * 1000;

loadDotEnv(path.resolve(process.cwd(), ".env"));

if (require.main === module) {
  main().catch((error) => {
    if (error instanceof UserCancelled) {
      if (error.message) console.error(error.message);
      process.exit(0);
    }
    console.error(`Error: ${error.message}`);
    process.exit(1);
  });
}

class UserCancelled extends Error {
  constructor(message = "Cancelled.") {
    super(message);
    this.name = "UserCancelled";
  }
}

async function main() {
  const { opts, args } = parseGlobalArgs(process.argv.slice(2));
  const command = args[0];

  if (!command || command === "help" || command === "-h" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "init") {
    await initCommand(args.slice(1), opts);
    return;
  }

  await ensureInitialized(command, args.slice(1), opts);

  switch (command) {
    case "add":
      return addCommand(args.slice(1), opts);
    case "list":
    case "ls":
      return listCommand(args.slice(1), opts);
    case "current":
      return currentCommand(opts);
    case "show":
      return showCommand(args.slice(1), opts);
    case "use":
      return useCommand(args.slice(1), opts);
    case "doctor":
      return doctorCommand(opts);
    case "remove":
    case "rm":
      return removeCommand(args.slice(1), opts);
    case "rollback":
      return rollbackCommand(args.slice(1), opts);
    case "export":
      return exportCommand(args.slice(1));
    case "import":
      return importCommand(args.slice(1), opts);
    default:
      throw new Error(`unknown command "${command}"`);
  }
}

function printHelp() {
  console.log(`MengMeng (萌萌) - tiny Claude Code provider assistant

Usage:
  mm init
  mm add <provider>
  mm list [--refresh]
  mm current
  mm show <profile>
  mm use <profile>
  mm doctor
  mm remove <profile>
  mm rollback [backup-id]
  mm export [--redact]
  mm import <file>

Supported providers:
  kimi    Kimi Coding Plan`);
}

function parseGlobalArgs(argv) {
  const opts = { json: false, noColor: false };
  const args = [];
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--no-color") opts.noColor = true;
    else args.push(arg);
  }
  return { opts, args };
}

function parseFlags(args, specs = {}) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    const [rawName, inlineValue] = arg.slice(2).split("=", 2);
    const kind = specs[rawName] || "bool";
    if (kind === "value") {
      flags[rawName] = inlineValue !== undefined ? inlineValue : args[++i];
    } else {
      flags[rawName] = true;
    }
  }
  return { flags, rest };
}

async function initCommand(args, opts) {
  const { flags } = parseFlags(args, {
    "config-dir": "value",
    "claude-config": "value"
  });
  const configPath = getConfigPath();
  const configDir = path.dirname(configPath);
  const existing = readJSONIfExists(configPath);

  if (existing?.initialized) {
    if (opts.json) return printJSON(existing);
    if (!flags.yes && isInteractive()) {
      return reconfigureInit(existing, configDir);
    }
    console.log("MengMeng is already initialized.");
    console.log(`Profiles: ${existing.configDir}`);
    console.log(`Claude:   ${existing.claudeConfigPath}`);
    return;
  }

  let chosenConfigDir = configDir;
  let claudeConfigPath = getClaudeConfigPath();
  if (flags["config-dir"]) chosenConfigDir = expandHome(flags["config-dir"]);
  if (flags["claude-config"]) claudeConfigPath = expandHome(flags["claude-config"]);
  if (!flags.yes && isInteractive()) {
    console.log("MengMeng first-run setup");
    const detected = detectStorageCandidates(configDir);
    const selected = await selectOption("Where should MengMeng store profiles?", detected, 0);
    if (selected.value === "custom") {
      const storage = await ask(`Custom profile storage path [${chosenConfigDir}]: `);
      if (storage.trim()) chosenConfigDir = expandHome(storage.trim());
    } else {
      chosenConfigDir = selected.path;
    }
    console.error("");
    const claudePath = await ask(`Claude Code settings path [${claudeConfigPath}]: `);
    if (claudePath.trim()) claudeConfigPath = expandHome(claudePath.trim());
  }

  const now = new Date().toISOString();
  const config = {
    initialized: true,
    configDir: chosenConfigDir,
    claudeConfigPath,
    current: "",
    createdAt: now,
    updatedAt: now
  };
  mkdirp(chosenConfigDir);
  writeJSONAtomic(configPath, config);
  ensureStore(chosenConfigDir);

  if (opts.json) return printJSON(config);
  console.log("MengMeng initialized.");
  console.log(`Profiles: ${chosenConfigDir}`);
  console.log(`Claude:   ${claudeConfigPath}`);
}

async function reconfigureInit(existing, defaultConfigDir) {
  const selected = await selectOption("MengMeng is already initialized. What would you like to change?", [
    {
      label: "View current config",
      description: "show paths and leave everything unchanged",
      value: "view"
    },
    {
      label: "Profile storage location",
      description: "choose iCloud, local, or custom storage",
      value: "storage"
    },
    {
      label: "Claude Code settings path",
      description: "change the settings.json file MengMeng writes",
      value: "claude"
    },
    {
      label: "Cancel",
      description: "do nothing",
      value: "cancel"
    }
  ], 0);

  if (selected.value === "cancel") {
    console.log("Cancelled.");
    return;
  }

  if (selected.value === "view") {
    console.log("MengMeng config:");
    console.log(`Profiles: ${existing.configDir}`);
    console.log(`Claude:   ${existing.claudeConfigPath}`);
    return;
  }

  const updated = { ...existing, updatedAt: new Date().toISOString() };
  if (selected.value === "storage") {
    const detected = detectStorageCandidates(defaultConfigDir);
    const current = {
      label: "Current location",
      description: existing.configDir,
      path: existing.configDir,
      value: existing.configDir
    };
    const storage = await selectOption("Where should MengMeng store profiles?", [current, ...detected], 0);
    let nextDir = storage.path;
    if (storage.value === "custom") {
      const answer = await ask(`Custom profile storage path [${existing.configDir}]: `);
      nextDir = answer.trim() ? expandHome(answer.trim()) : existing.configDir;
    }
    updated.configDir = nextDir;
    mkdirp(nextDir);
    const oldProfiles = path.join(existing.configDir, "profiles.json");
    const newProfiles = path.join(nextDir, "profiles.json");
    if (fs.existsSync(oldProfiles) && !fs.existsSync(newProfiles)) {
      fs.copyFileSync(oldProfiles, newProfiles);
    }
    ensureStore(nextDir);
  }

  if (selected.value === "claude") {
    const answer = await ask(`Claude Code settings path [${existing.claudeConfigPath}]: `);
    if (answer.trim()) updated.claudeConfigPath = expandHome(answer.trim());
  }

  writeConfig(updated);
  console.log("MengMeng config updated.");
  console.log(`Profiles: ${updated.configDir}`);
  console.log(`Claude:   ${updated.claudeConfigPath}`);
}

async function ensureInitialized(command, args, opts) {
  const config = readConfig();
  if (config?.initialized) return;
  if (opts.json || args.includes("--yes") || !isInteractive()) {
    await initCommand(["--yes"], opts);
    return;
  }
  console.log("MengMeng has not been initialized yet.\n");
  console.log("Before managing Claude Code providers, MengMeng needs to set up:");
  console.log("  - where profiles are stored");
  console.log("  - where backups should be written");
  console.log("  - which Claude Code settings file to manage\n");
  console.log("This only needs to be done once.");
  console.log("You can change these choices later with:\n\n  mm init\n");
  const ok = await ask("Continue setup now? [Y/n] ");
  if (!confirmDefaultYes(ok)) throw new UserCancelled("Cancelled. Run `mm init` when you're ready.");
  await initCommand([], opts);
}

async function addCommand(args, opts) {
  const { flags, rest } = parseFlags(args, {
    name: "value",
    mode: "value",
    "key-env": "value"
  });
  const provider = rest[0];
  if (!provider) throw new Error("usage: mm add <provider>");
  if (provider !== "kimi") throw new Error(`provider "${provider}" is not implemented yet; supported: kimi`);

  let mode = flags.mode || "";
  if (!mode && isInteractive() && !flags.yes) {
    const selected = await selectOption("How do you want to use Kimi?", [
      {
        label: "Kimi Coding Plan",
        description: "recommended for Claude Code",
        value: "coding-plan"
      },
      {
        label: "Kimi API key",
        description: "not implemented in this MVP",
        value: "api"
      }
    ], 0);
    mode = selected.value;
  }
  if (!mode) mode = "coding-plan";
  if (mode !== "coding-plan") throw new Error("Kimi API mode is not implemented yet; use Kimi Coding Plan");

  let profileName = flags.name || "kimi";
  if (isInteractive() && !flags.yes) {
    const answer = await ask(`Profile name [${profileName}]: `);
    if (answer.trim()) profileName = answer.trim();
  }

  const apiKey = await resolveApiKey(flags);
  console.error("Testing Kimi Coding Plan...");
  const models = await fetchKimiModels(apiKey);
  let mapping = recommendMapping(models);

  if (isInteractive() && !flags.yes) {
    mapping = await editModelMapping(models, mapping);
  }

  let powerUser = Boolean(flags["power-user"]);
  if (isInteractive() && !flags.yes) {
    const answer = await ask("Enable Claude Code power-user permission settings? [y/N] ");
    powerUser = confirmDefaultNo(answer);
  }

  let quotaCache = null;
  try {
    quotaCache = await fetchKimiQuota(apiKey);
  } catch {
    quotaCache = null;
  }

  const config = requireConfig();
  const store = readStore(config.configDir);
  const now = new Date().toISOString();
  const existing = store.profiles.find((p) => p.name === profileName);
  if (existing && !flags.yes && isInteractive()) {
    const ok = await ask(`Profile "${profileName}" already exists. Overwrite? [y/N] `);
    if (!confirmDefaultNo(ok)) throw new UserCancelled();
  } else if (existing && !flags.yes) {
    throw new Error(`profile "${profileName}" already exists; rerun with --yes to overwrite`);
  }

  const profile = {
    name: profileName,
    provider: "kimi",
    mode,
    baseUrl: KIMI_CODING_BASE,
    apiKey,
    model: mapping,
    env: {
      ENABLE_TOOL_SEARCH: "false",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "262144"
    },
    powerUser,
    quotaCache,
    modelSource: "kimi-coding-models-api",
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  upsertProfile(store, profile);
  writeStore(config.configDir, store);

  if (opts.json) return printJSON(redactProfile(profile));
  console.log(`Saved provider: ${profileName}`);
  if (quotaCache?.success) console.log(formatQuota(quotaCache, opts));
  if (isInteractive() && !flags.yes) {
    const useNow = await ask(`Use ${profileName} now? [Y/n] `);
    if (confirmDefaultYes(useNow)) await useProfile(profileName);
  }
}

async function listCommand(args, opts) {
  const { flags } = parseFlags(args);
  const config = requireConfig();
  const store = readStore(config.configDir);
  let changed = false;
  for (const profile of store.profiles) {
    if (profile.provider === "kimi" && profile.mode === "coding-plan" && shouldRefreshQuota(profile.quotaCache, flags.refresh)) {
      try {
        profile.quotaCache = await fetchKimiQuota(profile.apiKey);
        profile.updatedAt = new Date().toISOString();
        changed = true;
      } catch {
        // Keep list fast and forgiving.
      }
    }
  }
  if (changed) writeStore(config.configDir, store);

  if (opts.json) return printJSON(store.profiles.map(redactProfile));
  if (!store.profiles.length) {
    console.log("No profiles yet. Try `mm add kimi`.");
    return;
  }
  const color = makeColor(opts);
  console.log(`${pad("", 2)} ${pad("PROFILE", 16)} ${pad("PROVIDER", 16)} ${pad("MODEL", 18)} ${pad("LIMIT", 28)} STATUS`);
  for (const profile of store.profiles) {
    const active = profile.name === config.current ? "*" : " ";
    const { limit, status } = listStatus(profile, color);
    console.log(`${pad(active, 2)} ${pad(profile.name, 16)} ${pad(displayProvider(profile), 16)} ${pad(truncate(profile.model.main, 18), 18)} ${pad(truncate(limit, 28), 28)} ${status}`);
  }
}

function currentCommand(opts) {
  const config = requireConfig();
  if (opts.json) return printJSON({ current: config.current || null });
  console.log(config.current || "No active MengMeng profile.");
}

function showCommand(args, opts) {
  const name = args[0];
  if (!name) throw new Error("usage: mm show <profile>");
  const profile = loadProfile(name);
  if (opts.json) return printJSON(redactProfile(profile));
  console.log(`Profile:  ${profile.name}`);
  console.log(`Provider: ${displayProvider(profile)}`);
  console.log(`Base URL: ${profile.baseUrl}`);
  console.log(`API key:  ${maskSecret(profile.apiKey)}\n`);
  console.log("Claude Code mapping:");
  printMapping(profile.model);
  if (profile.quotaCache) console.log(`\n${formatQuota(profile.quotaCache, opts)}`);
}

async function useCommand(args, opts) {
  const name = args[0];
  if (!name) throw new Error("usage: mm use <profile>");
  await useProfile(name);
  if (opts.json) return printJSON({ success: true, current: name });
  console.log(`Current provider: ${name}`);
}

function doctorCommand(opts) {
  const config = requireConfig();
  const store = readStore(config.configDir);
  const checks = [
    ["profile store", true, config.configDir],
    ["Claude settings", fs.existsSync(config.claudeConfigPath), config.claudeConfigPath],
    ["profiles", store.profiles.length > 0, `${store.profiles.length} configured`],
    ["current profile", Boolean(config.current), config.current || "none"]
  ];
  if (opts.json) return printJSON(checks.map(([name, ok, detail]) => ({ name, ok, detail })));
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "✓" : "!"} ${pad(name, 18)} ${detail}`);
  }
}

async function removeCommand(args, opts) {
  const { flags, rest } = parseFlags(args);
  const name = rest[0];
  if (!name) throw new Error("usage: mm remove <profile>");
  const config = requireConfig();
  const store = readStore(config.configDir);
  const index = store.profiles.findIndex((p) => p.name === name);
  if (index < 0) throw new Error(`profile "${name}" not found`);
  if (config.current === name && !flags.yes) {
    if (!isInteractive()) throw new Error("profile is active; rerun with --yes to remove saved profile while leaving Claude settings unchanged");
    console.log(`"${name}" is currently active in Claude Code.`);
    const ok = await ask("Remove saved profile but leave Claude Code settings as-is? [Y/n] ");
    if (!confirmDefaultYes(ok)) throw new UserCancelled();
  }
  store.profiles.splice(index, 1);
  writeStore(config.configDir, store);
  if (config.current === name) {
    config.current = "";
    config.updatedAt = new Date().toISOString();
    writeConfig(config);
  }
  if (opts.json) return printJSON({ success: true, removed: name });
  console.log(`Removed profile: ${name}`);
}

function rollbackCommand(args, opts) {
  const config = requireConfig();
  const backupDir = path.join(config.configDir, "backups");
  const backups = fs.existsSync(backupDir)
    ? fs.readdirSync(backupDir).filter((f) => f.endsWith(".json")).sort()
    : [];
  if (!backups.length) throw new Error("no backups found");
  const wanted = args[0];
  const chosen = wanted ? backups.find((b) => b.includes(wanted)) : backups[backups.length - 1];
  if (!chosen) throw new Error(`backup "${wanted}" not found`);
  const source = path.join(backupDir, chosen);
  writeFileAtomic(config.claudeConfigPath, fs.readFileSync(source));
  if (opts.json) return printJSON({ success: true, backup: source });
  console.log(`Rolled back Claude settings from ${source}`);
}

function exportCommand(args) {
  const { flags } = parseFlags(args);
  const config = requireConfig();
  const store = readStore(config.configDir);
  if (flags.redact) store.profiles = store.profiles.map(redactProfile);
  printJSON(store);
}

function importCommand(args, opts) {
  const file = args[0];
  if (!file) throw new Error("usage: mm import <file>");
  const incoming = JSON.parse(fs.readFileSync(file, "utf8"));
  const config = requireConfig();
  const store = readStore(config.configDir);
  for (const profile of incoming.profiles || []) upsertProfile(store, profile);
  writeStore(config.configDir, store);
  if (opts.json) return printJSON({ success: true, imported: incoming.profiles?.length || 0 });
  console.log(`Imported ${incoming.profiles?.length || 0} profiles.`);
}

async function useProfile(name) {
  const profile = loadProfile(name);
  const config = requireConfig();
  backupClaudeSettings(config);
  const settings = readJSONIfExists(config.claudeConfigPath) || {};
  mergeSettings(settings, settingsForProfile(profile, { redact: false }));
  writeJSONAtomic(config.claudeConfigPath, settings);
  config.current = name;
  config.updatedAt = new Date().toISOString();
  writeConfig(config);
}

function settingsForProfile(profile, { redact }) {
  const key = redact ? "sk-****" : profile.apiKey;
  const env = {
    ANTHROPIC_BASE_URL: profile.baseUrl,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_MODEL: profile.model.main,
    ANTHROPIC_DEFAULT_OPUS_MODEL: profile.model.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: profile.model.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: profile.model.haiku,
    CLAUDE_CODE_SUBAGENT_MODEL: profile.model.subagent,
    ENABLE_TOOL_SEARCH: profile.env.ENABLE_TOOL_SEARCH,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: profile.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  };
  const settings = { env };
  if (profile.powerUser) {
    settings.skipDangerousModePermissionPrompt = true;
    settings.skipAutoPermissionPrompt = true;
  }
  return settings;
}

function mergeSettings(target, generated) {
  target.env = { ...(target.env || {}), ...generated.env };
  if (generated.skipDangerousModePermissionPrompt) target.skipDangerousModePermissionPrompt = true;
  if (generated.skipAutoPermissionPrompt) target.skipAutoPermissionPrompt = true;
}

async function fetchKimiModels(apiKey) {
  const res = await fetch(KIMI_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Kimi models request failed: HTTP ${res.status}: ${text}`);
  return parseKimiModels(JSON.parse(text));
}

function parseKimiModels(body) {
  return (body.data || [])
    .filter((item) => item.id)
    .map((item) => ({
      id: item.id,
      displayName: item.display_name || "",
      contextLength: item.context_length || 0
    }));
}

async function fetchKimiQuota(apiKey) {
  const res = await fetch(KIMI_USAGE_URL, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
  });
  const text = await res.text();
  if (!res.ok) {
    return {
      success: false,
      provider: "kimi",
      queriedAt: new Date().toISOString(),
      error: `HTTP ${res.status}: ${text}`
    };
  }
  return parseKimiQuota(JSON.parse(text));
}

function parseKimiQuota(body) {
  const tiers = [];
  for (const item of body.limits || []) {
    const detail = item.detail || {};
    const limit = number(detail.limit);
    const used = number(detail.used) || Math.max(0, limit - number(detail.remaining));
    tiers.push({
      name: item.window?.duration === 300 ? "5h" : "window",
      usedPct: pct(used, limit),
      used,
      remaining: number(detail.remaining),
      limit,
      resetTime: detail.resetTime || ""
    });
  }
  if (body.usage) {
    const limit = number(body.usage.limit);
    const used = number(body.usage.used) || Math.max(0, limit - number(body.usage.remaining));
    tiers.push({
      name: "week",
      usedPct: pct(used, limit),
      used,
      remaining: number(body.usage.remaining),
      limit,
      resetTime: body.usage.resetTime || ""
    });
  }
  return { success: true, provider: "kimi", queriedAt: new Date().toISOString(), tiers };
}

function recommendMapping(models) {
  const sorted = [...models].sort((a, b) => modelScore(b) - modelScore(a));
  const main = sorted[0]?.id || "kimi-for-coding";
  return { main, opus: main, sonnet: main, haiku: main, subagent: main };
}

function modelScore(model) {
  const text = `${model.id} ${model.displayName}`.toLowerCase();
  let score = Math.floor((model.contextLength || 0) / 1000);
  for (const token of ["coding", "code", "for-coding", "k2.7", "latest"]) {
    if (text.includes(token)) score += 100;
  }
  return score;
}

async function editModelMapping(models, mapping) {
  let current = { ...mapping };
  for (;;) {
    const selected = await selectOption("Claude Code model mapping", modelMappingOptions(current), 0);
    if (selected.value === "done") return current;
    current[selected.value] = await chooseModel(modelSlotLabel(selected.value), models, current[selected.value]);
  }
}

function modelMappingOptions(mapping) {
  return [
    {
      label: "Use recommended mapping",
      description: "press Enter without moving to keep these defaults",
      value: "done"
    },
    { label: `Main     ${mapping.main}`, description: "ANTHROPIC_MODEL", value: "main" },
    { label: `Opus     ${mapping.opus}`, description: "ANTHROPIC_DEFAULT_OPUS_MODEL", value: "opus" },
    { label: `Sonnet   ${mapping.sonnet}`, description: "ANTHROPIC_DEFAULT_SONNET_MODEL", value: "sonnet" },
    { label: `Haiku    ${mapping.haiku}`, description: "ANTHROPIC_DEFAULT_HAIKU_MODEL", value: "haiku" },
    { label: `Subagent ${mapping.subagent}`, description: "CLAUDE_CODE_SUBAGENT_MODEL", value: "subagent" }
  ];
}

function modelSlotLabel(slot) {
  return {
    main: "Main",
    opus: "Opus",
    sonnet: "Sonnet",
    haiku: "Haiku",
    subagent: "Subagent"
  }[slot] || slot;
}

async function chooseModel(slot, models, current) {
  const options = [
    { label: `Keep current (${current})`, value: current },
    ...models.map((model) => ({
      label: model.id,
      description: model.displayName || "",
      value: model.id
    }))
  ];
  const selected = await selectOption(`Select ${slot} model`, options, 0);
  return selected.value;
}

async function resolveApiKey(flags) {
  if (flags["key-env"]) {
    const value = process.env[flags["key-env"]];
    if (!value) throw new Error(`env var ${flags["key-env"]} is empty`);
    return value.trim();
  }
  if (flags["key-stdin"]) {
    const value = await readStdin();
    if (!value.trim()) throw new Error("stdin did not contain an API key");
    return value.trim();
  }
  if (process.env.KIMI_CODE_API_KEY) return process.env.KIMI_CODE_API_KEY.trim();
  if (!isInteractive()) throw new Error("missing API key; pass --key-env KIMI_CODE_API_KEY or --key-stdin");
  const value = await ask("Moonshot / Kimi Coding Plan API key:\n> ");
  if (!value.trim()) throw new Error("API key is required");
  return value.trim();
}

function getConfigPath() {
  if (process.env.MENGMENG_HOME) return path.join(expandHome(process.env.MENGMENG_HOME), "config.json");
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "mengmeng", "config.json");
}

function getClaudeConfigPath() {
  return expandHome(process.env.MENGMENG_CLAUDE_CONFIG || path.join(os.homedir(), ".claude", "settings.json"));
}

function readConfig() {
  return readJSONIfExists(getConfigPath());
}

function requireConfig() {
  const config = readConfig();
  if (!config?.initialized) throw new Error("MengMeng is not initialized; run `mm init`");
  return config;
}

function writeConfig(config) {
  writeJSONAtomic(getConfigPath(), config);
}

function ensureStore(configDir) {
  const storePath = path.join(configDir, "profiles.json");
  if (!fs.existsSync(storePath)) writeJSONAtomic(storePath, { version: VERSION, profiles: [] });
}

function readStore(configDir) {
  ensureStore(configDir);
  const store = readJSONIfExists(path.join(configDir, "profiles.json")) || {};
  store.version = VERSION;
  store.profiles ||= [];
  return store;
}

function writeStore(configDir, store) {
  store.version = VERSION;
  writeJSONAtomic(path.join(configDir, "profiles.json"), store);
}

function upsertProfile(store, profile) {
  const index = store.profiles.findIndex((p) => p.name === profile.name);
  if (index >= 0) store.profiles[index] = profile;
  else store.profiles.push(profile);
}

function loadProfile(name) {
  const config = requireConfig();
  const store = readStore(config.configDir);
  const profile = store.profiles.find((p) => p.name === name);
  if (!profile) throw new Error(`profile "${name}" not found`);
  return profile;
}

function backupClaudeSettings(config) {
  const backupDir = path.join(config.configDir, "backups");
  mkdirp(backupDir);
  const data = fs.existsSync(config.claudeConfigPath) ? fs.readFileSync(config.claudeConfigPath) : Buffer.from("{}\n");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  fs.writeFileSync(path.join(backupDir, `settings-${stamp}.json`), data, { mode: 0o600 });
}

function readJSONIfExists(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

function writeJSONAtomic(file, value) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFileAtomic(file, data) {
  mkdirp(path.dirname(file));
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temp, data, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function printJSON(value) {
  console.log(JSON.stringify(value, null, 2));
}

function displayProvider(profile) {
  if (profile.provider === "kimi" && profile.mode === "coding-plan") return "Kimi Coding";
  return `${profile.provider} ${profile.mode}`;
}

function listStatus(profile, color) {
  const quota = profile.quotaCache;
  if (!quota) return { limit: color.gray("unknown"), status: color.gray("unknown") };
  if (!quota.success) return { limit: color.red("quota error"), status: color.red("error") };
  const max = Math.max(0, ...quota.tiers.map((tier) => tier.usedPct || 0));
  const text = quota.tiers.map((tier) => `${tier.name} ${Math.round(tier.usedPct)}%`).join("  ");
  if (max >= 95) return { limit: color.red(text), status: color.red("exhausted") };
  if (max >= 75) return { limit: color.yellow(text), status: color.yellow("warn") };
  return { limit: color.green(text), status: color.green("ok") };
}

function formatQuota(quota, opts) {
  const color = makeColor(opts);
  if (!quota.success) return `Quota: ${color.red(quota.error || "error")}`;
  if (!quota.tiers?.length) return `Quota: ${color.gray("unknown")}`;
  return `Quota: ${quota.tiers.map((tier) => formatQuotaTier(tier, color)).join("; ")}`;
}

function formatQuotaTier(tier, color) {
  const pctText = `${Math.round(tier.usedPct)}%`;
  const paint = tier.usedPct >= 95 ? color.red : tier.usedPct >= 75 ? color.yellow : color.green;
  const reset = tier.resetTime ? color.gray(` reset ${tier.resetTime}`) : "";
  return `${color.cyan(tier.name)} ${paint(pctText)} used${reset}`;
}

function printMapping(mapping) {
  console.log(`  main:     ${mapping.main}`);
  console.log(`  opus:     ${mapping.opus}`);
  console.log(`  sonnet:   ${mapping.sonnet}`);
  console.log(`  haiku:    ${mapping.haiku}`);
  console.log(`  subagent: ${mapping.subagent}`);
}

function shouldRefreshQuota(cache, force) {
  if (force || !cache?.queriedAt) return true;
  return Date.now() - Date.parse(cache.queriedAt) > QUOTA_CACHE_MS;
}

function redactProfile(profile) {
  return { ...profile, apiKey: maskSecret(profile.apiKey) };
}

function maskSecret(value = "") {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function truncate(value, max) {
  value = String(value || "");
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function pad(value, length) {
  value = String(value || "");
  return value.length >= length ? value : value + " ".repeat(length - value.length);
}

function pct(used, limit) {
  return limit > 0 ? Math.max(0, used / limit) * 100 : 0;
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function confirmDefaultYes(value) {
  const v = value.trim().toLowerCase();
  return v === "" || v === "y" || v === "yes";
}

function confirmDefaultNo(value) {
  const v = value.trim().toLowerCase();
  return v === "y" || v === "yes";
}

function isInteractive() {
  return process.stdin.isTTY;
}

function detectStorageCandidates(defaultConfigDir) {
  const candidates = [];
  const add = (label, description, storagePath, value = storagePath) => {
    if (value === "custom") {
      candidates.push({ label, description, path: "", value });
      return;
    }
    if (!storagePath) return;
    const normalized = expandHome(storagePath);
    if (value !== "custom" && candidates.some((candidate) => candidate.path === normalized)) return;
    candidates.push({ label, description, path: normalized, value });
  };

  if (process.platform === "darwin") {
    const iCloud = path.join(os.homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs");
    if (fs.existsSync(iCloud)) {
      add("iCloud Drive", "recommended on macOS for multi-device sync", path.join(iCloud, "MengMeng"));
    }
  }

  addIfExists(candidates, "Dropbox", "sync profiles with Dropbox", path.join(os.homedir(), "Dropbox", "MengMeng"));
  addIfExists(candidates, "OneDrive", "sync profiles with OneDrive", findOneDrivePath());
  addIfExists(candidates, "Syncthing", "sync profiles with Syncthing", path.join(os.homedir(), "Sync", "MengMeng"));

  add("Local config", "simple local-only storage", defaultConfigDir);
  add("Custom path", "choose another directory", "", "custom");

  return candidates;
}

function addIfExists(candidates, label, description, storagePath) {
  if (!storagePath) return;
  const base = path.dirname(storagePath);
  if (!fs.existsSync(base)) return;
  const normalized = expandHome(storagePath);
  if (candidates.some((candidate) => candidate.path === normalized)) return;
  candidates.push({ label, description, path: normalized, value: normalized });
}

function findOneDrivePath() {
  const cloudStorage = path.join(os.homedir(), "Library", "CloudStorage");
  if (fs.existsSync(cloudStorage)) {
    const hit = fs.readdirSync(cloudStorage).find((entry) => entry.toLowerCase().startsWith("onedrive"));
    if (hit) return path.join(cloudStorage, hit, "MengMeng");
  }
  const homeHit = fs.readdirSync(os.homedir()).find((entry) => entry.toLowerCase().startsWith("onedrive"));
  return homeHit ? path.join(os.homedir(), homeHit, "MengMeng") : "";
}

async function selectOption(message, options, defaultIndex = 0) {
  if (!isInteractive() || typeof process.stdin.setRawMode !== "function") {
    return options[defaultIndex];
  }

  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stderr;
    let index = defaultIndex;
    let renderedLines = 0;
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      output.write("\u001b[?25h");
    };

    const render = () => {
      if (renderedLines > 0) output.write(`\u001b[${renderedLines}A`);
      const lines = [message];
      for (let i = 0; i < options.length; i++) {
        const option = options[i];
        const selected = i === index;
        const prefix = selected ? colorText("›", "36") : " ";
        const label = selected ? colorText(option.label, "36;1") : option.label;
        const description = option.description ? colorText(` ${option.description}`, selected ? "90" : "90") : "";
        lines.push(` ${prefix} ${label}${description}`);
      }
      lines.push(colorText("Use ↑/↓, j/k, or number keys. Press Enter to confirm.", "90"));
      for (const line of lines) output.write(`\u001b[2K\r${line}\n`);
      renderedLines = lines.length;
    };

    const finish = () => {
      cleanup();
      if (renderedLines > 0) output.write(`\u001b[${renderedLines}A`);
      output.write(`\u001b[2K\r${message} ${colorText(options[index].label, "36;1")}\n`);
      for (let i = 1; i < renderedLines; i++) output.write("\u001b[2K\r\n");
      if (renderedLines > 1) output.write(`\u001b[${renderedLines - 1}A`);
      resolve(options[index]);
    };

    const onData = (chunk) => {
      const key = chunk.toString("utf8");
      if (key === "\u0003") {
        cleanup();
        reject(new UserCancelled());
        return;
      }
      if (key === "\r" || key === "\n") return finish();
      if (key === "\u001b[A" || key === "k") index = (index - 1 + options.length) % options.length;
      else if (key === "\u001b[B" || key === "j") index = (index + 1) % options.length;
      else if (/^[1-9]$/.test(key)) {
        const n = Number(key) - 1;
        if (n >= 0 && n < options.length) index = n;
      }
      render();
    };

    output.write("\u001b[?25l");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
    render();
  });
}

function colorText(text, code) {
  return `\u001b[${code}m${text}\u001b[0m`;
}

function makeColor(opts) {
  const enabled = !opts.noColor && process.stdout.isTTY;
  const wrap = (code, text) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : text);
  return {
    green: (text) => wrap(32, text),
    cyan: (text) => wrap(36, text),
    yellow: (text) => wrap(33, text),
    red: (text) => wrap(31, text),
    gray: (text) => wrap(90, text)
  };
}

function ask(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

module.exports = {
  parseKimiModels,
  parseKimiQuota,
  recommendMapping,
  mergeSettings,
  settingsForProfile,
  detectStorageCandidates
};
