#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const VERSION = 1;
const KIMI_CODING_BASE = "https://api.kimi.com/coding";
const KIMI_MODELS_URL = "https://api.kimi.com/coding/v1/models";
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const KIMI_API_ORIGINS = ["https://api.moonshot.ai", "https://api.moonshot.cn"];
const DEEPSEEK_API_ORIGIN = "https://api.deepseek.com";
const DEEPSEEK_ANTHROPIC_BASE = `${DEEPSEEK_API_ORIGIN}/anthropic`;
const DEEPSEEK_MODELS_URL = `${DEEPSEEK_API_ORIGIN}/models`;
const DEEPSEEK_BALANCE_URL = `${DEEPSEEK_API_ORIGIN}/user/balance`;
const PROBE_PROMPT = "这是一个接口测试，请返回 \"ok\" 即可。";
const PROBE_MAX_TOKENS = 8;
const PROBE_TIMEOUT_MS = 20000;
const SUPPORTED_PROVIDERS = [
  {
    id: "kimi",
    name: "Kimi Coding Plan / Kimi API",
    aliases: ["moonshot", "kimi-coding", "kimi-api"]
  },
  {
    id: "deepseek",
    name: "DeepSeek API",
    aliases: ["deepseek-api", "ds"]
  }
];

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
    printHelp(opts);
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

function printHelp(opts = {}) {
  const color = makeColor({ ...opts, stream: process.stdout });
  console.log(`${color.bold("MengMeng (萌萌)")} ${color.gray("- tiny Claude Code provider assistant")}

${color.cyan("Usage:")}
  ${color.gray("mm init")}
  ${color.gray("mm add <provider>")}
  ${color.gray("mm list")}
  ${color.gray("mm current")}
  ${color.gray("mm show <profile>")}
  ${color.gray("mm use <profile>")}
  ${color.gray("mm doctor")}
  ${color.gray("mm remove <profile>")}
  ${color.gray("mm rollback [backup-id]")}
  ${color.gray("mm export [--redact]")}
  ${color.gray("mm import <file>")}

${formatSupportedProviders(color)}`);
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

function normalizeProvider(value = "") {
  const lower = value.trim().toLowerCase();
  const hit = SUPPORTED_PROVIDERS.find((provider) => provider.id === lower || provider.aliases.includes(lower));
  return hit ? hit.id : lower;
}

function isSupportedProvider(value) {
  return SUPPORTED_PROVIDERS.some((provider) => provider.id === value);
}

function formatSupportedProviders(color = makeColor({ noColor: true })) {
  return [
    color.bold("Supported providers:"),
    ...SUPPORTED_PROVIDERS.map((provider) => `  ${color.cyan(provider.id.padEnd(8))} ${color.gray(provider.name)}`)
  ].join("\n");
}

function formatUnsupportedProvider(input = "") {
  const color = makeColor({ stream: process.stderr });
  const suggestion = nearestProvider(input);
  const lines = [`Provider ${color.yellow(`"${input}"`)} is not supported yet.`];
  if (suggestion) lines.push(`Did you mean: ${color.cyan(`mm add ${suggestion}`)}`);
  lines.push("", formatSupportedProviders(color));
  return lines.join("\n");
}

function nearestProvider(input = "") {
  const lower = input.trim().toLowerCase();
  if (!lower) return "";
  let best = { id: "", distance: Infinity };
  for (const provider of SUPPORTED_PROVIDERS) {
    for (const candidate of [provider.id, ...provider.aliases]) {
      const distance = levenshtein(lower, candidate);
      if (distance < best.distance) best = { id: provider.id, distance };
    }
  }
  return best.distance <= Math.max(2, Math.floor(lower.length / 2)) ? best.id : "";
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
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
    const color = makeColor(opts);
    if (!flags.yes && isInteractive()) {
      return reconfigureInit(existing, configDir);
    }
    console.log(color.green("MengMeng is already initialized."));
    console.log(`${color.gray("Profiles:")} ${existing.configDir}`);
    console.log(`${color.gray("Claude:  ")} ${existing.claudeConfigPath}`);
    return;
  }

  let chosenConfigDir = configDir;
  let claudeConfigPath = getClaudeConfigPath();
  if (flags["config-dir"]) chosenConfigDir = expandHome(flags["config-dir"]);
  if (flags["claude-config"]) claudeConfigPath = expandHome(flags["claude-config"]);
  if (!flags.yes && isInteractive()) {
    const color = makeColor({ ...opts, stream: process.stderr });
    console.log(color.bold("MengMeng first-run setup"));
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
  const color = makeColor(opts);
  console.log(color.green("MengMeng initialized."));
  console.log(`${color.gray("Profiles:")} ${chosenConfigDir}`);
  console.log(`${color.gray("Claude:  ")} ${claudeConfigPath}`);
}

async function reconfigureInit(existing, defaultConfigDir) {
  const color = makeColor({ stream: process.stdout });
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
    console.log(color.bold("MengMeng config:"));
    console.log(`${color.gray("Profiles:")} ${existing.configDir}`);
    console.log(`${color.gray("Claude:  ")} ${existing.claudeConfigPath}`);
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
  console.log(color.green("MengMeng config updated."));
  console.log(`${color.gray("Profiles:")} ${updated.configDir}`);
  console.log(`${color.gray("Claude:  ")} ${updated.claudeConfigPath}`);
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
  const providerInput = rest[0];
  const provider = normalizeProvider(providerInput);
  if (!provider) throw new Error("usage: mm add <provider>");
  if (!isSupportedProvider(provider)) throw new Error(formatUnsupportedProvider(providerInput));
  if (provider === "kimi") return addKimiCommand(flags, opts);
  if (provider === "deepseek") return addDeepSeekCommand(flags, opts);
  throw new Error(formatUnsupportedProvider(providerInput));
}

async function addKimiCommand(flags, opts) {
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
        description: "Moonshot/Kimi Open Platform API",
        value: "api"
      }
    ], 0);
    mode = selected.value;
  }
  if (!mode) mode = "coding-plan";
  if (!["coding-plan", "api"].includes(mode)) throw new Error(`unsupported Kimi mode "${mode}"; use coding-plan or api`);

  let profileName = flags.name || (mode === "api" ? "kimi-api" : "kimi");
  if (isInteractive() && !flags.yes) {
    const answer = await ask(`Profile name [${profileName}]: `);
    if (answer.trim()) profileName = answer.trim();
  }

  const apiKey = await resolveApiKey(flags, keyDefaultsForMode(mode));
  console.error(`Testing ${mode === "api" ? "Kimi API" : "Kimi Coding Plan"}...`);
  const adapter = await resolveKimiAdapter(mode, apiKey);
  const models = adapter.models;
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
  let balanceCache = null;
  if (mode === "coding-plan") {
    try {
      quotaCache = await fetchKimiQuota(apiKey);
    } catch {
      quotaCache = null;
    }
  } else if (mode === "api") {
    try {
      balanceCache = await fetchKimiAPIBalance(adapter.apiOrigin, apiKey);
    } catch {
      balanceCache = null;
    }
  }

  console.error("Checking Claude Code request path...");
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
    baseUrl: adapter.baseUrl,
    apiKey,
    model: mapping,
    env: {
      ENABLE_TOOL_SEARCH: "false",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "262144"
    },
    powerUser,
    quotaCache,
    balanceCache,
    statusCache: null,
    apiOrigin: adapter.apiOrigin || "",
    modelSource: adapter.modelSource,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  profile.statusCache = await probeProfileStatus(profile);
  upsertProfile(store, profile);
  writeStore(config.configDir, store);

  if (opts.json) return printJSON(redactProfile(profile));
  const color = makeColor(opts);
  console.log(`${color.green("Saved provider:")} ${color.cyan(profileName)}`);
  if (quotaCache?.success) console.log(formatQuota(quotaCache, opts));
  if (balanceCache?.success) console.log(formatBalance(balanceCache, opts));
  console.log(formatProfileStatus(profile, opts));
  if (isInteractive() && !flags.yes) {
    const useNow = await ask(`Use ${profileName} now? [Y/n] `);
    if (confirmDefaultYes(useNow)) await useProfile(profileName);
  }
}

async function addDeepSeekCommand(flags, opts) {
  const mode = flags.mode || "api";
  if (mode !== "api") throw new Error(`unsupported DeepSeek mode "${mode}"; use api`);

  let profileName = flags.name || "deepseek";
  if (isInteractive() && !flags.yes) {
    const answer = await ask(`Profile name [${profileName}]: `);
    if (answer.trim()) profileName = answer.trim();
  }

  const apiKey = await resolveApiKey(flags, keyDefaultsForProvider("deepseek"));
  console.error("Testing DeepSeek API...");
  const adapter = await resolveDeepSeekAdapter(apiKey);
  const models = adapter.models;
  let mapping = recommendDeepSeekMapping(models);

  if (isInteractive() && !flags.yes) {
    mapping = await editModelMapping(models, mapping);
  }

  let powerUser = Boolean(flags["power-user"]);
  if (isInteractive() && !flags.yes) {
    const answer = await ask("Enable Claude Code power-user permission settings? [y/N] ");
    powerUser = confirmDefaultNo(answer);
  }

  let balanceCache = null;
  try {
    balanceCache = await fetchDeepSeekBalance(apiKey);
  } catch {
    balanceCache = null;
  }

  console.error("Checking Claude Code request path...");
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
    provider: "deepseek",
    mode,
    baseUrl: adapter.baseUrl,
    apiKey,
    model: mapping,
    env: {
      ENABLE_TOOL_SEARCH: "false",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "262144"
    },
    powerUser,
    quotaCache: null,
    balanceCache,
    statusCache: null,
    apiOrigin: adapter.apiOrigin,
    modelSource: adapter.modelSource,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  profile.statusCache = await probeProfileStatus(profile);
  upsertProfile(store, profile);
  writeStore(config.configDir, store);

  if (opts.json) return printJSON(redactProfile(profile));
  const color = makeColor(opts);
  console.log(`${color.green("Saved provider:")} ${color.cyan(profileName)}`);
  if (balanceCache?.success) console.log(formatBalance(balanceCache, opts));
  console.log(formatProfileStatus(profile, opts));
  if (isInteractive() && !flags.yes) {
    const useNow = await ask(`Use ${profileName} now? [Y/n] `);
    if (confirmDefaultYes(useNow)) await useProfile(profileName);
  }
}

async function listCommand(args, opts) {
  if (args.length) throw new Error("usage: mm list");
  const config = requireConfig();
  const store = readStore(config.configDir);
  let changed = false;
  for (const profile of store.profiles) {
    if (profile.provider === "kimi" && profile.mode === "coding-plan") {
      try {
        profile.quotaCache = await fetchKimiQuota(profile.apiKey);
      } catch (error) {
        profile.quotaCache = {
          success: false,
          provider: profile.provider,
          queriedAt: new Date().toISOString(),
          error: error.message
        };
      }
    }
    if (profile.provider === "kimi" && profile.mode === "api") {
      try {
        profile.balanceCache = await fetchKimiAPIBalance(kimiAPIOriginForProfile(profile), profile.apiKey);
      } catch (error) {
        profile.balanceCache = {
          success: false,
          provider: profile.provider,
          queriedAt: new Date().toISOString(),
          error: error.message
        };
      }
    }
    if (profile.provider === "deepseek" && profile.mode === "api") {
      try {
        profile.balanceCache = await fetchDeepSeekBalance(profile.apiKey);
      } catch (error) {
        profile.balanceCache = {
          success: false,
          provider: profile.provider,
          queriedAt: new Date().toISOString(),
          error: error.message
        };
      }
    }
    profile.statusCache = await probeProfileStatus(profile);
    profile.updatedAt = new Date().toISOString();
    changed = true;
  }
  if (changed) writeStore(config.configDir, store);

  if (opts.json) return printJSON(store.profiles.map(redactProfile));
  if (!store.profiles.length) {
    console.log("No profiles yet. Try `mm add kimi`.");
    return;
  }
  const color = makeColor(opts);
  console.log([
    pad("", 4),
    pad(color.gray("PROFILE"), 18),
    pad(color.gray("PROVIDER"), 18),
    pad(color.gray("MODEL"), 20),
    pad(color.gray("LIMIT"), 30),
    color.gray("STATUS")
  ].join(" "));
  for (const profile of store.profiles) {
    const isActive = profile.name === config.current;
    const active = activeMarker(isActive, color);
    const name = profile.name;
    const provider = isActive ? color.bold(displayProvider(profile)) : displayProvider(profile);
    const { limit, status } = listStatus(profile, color);
    console.log([
      pad(active, 4),
      pad(name, 18),
      pad(provider, 18),
      pad(color.gray(truncate(profile.model.main, 20)), 20),
      pad(truncate(limit, 30), 30),
      status
    ].join(" "));
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
  const color = makeColor(opts);
  console.log(`${color.gray("Profile: ")} ${color.cyan(profile.name)}`);
  console.log(`${color.gray("Provider:")} ${displayProvider(profile)}`);
  console.log(`${color.gray("Base URL:")} ${profile.baseUrl}`);
  console.log(`${color.gray("API key: ")} ${maskSecret(profile.apiKey)}\n`);
  console.log(color.green("Claude Code mapping:"));
  printMapping(profile.model, color);
  if (profile.statusCache || profile.balanceCache) console.log(`\n${formatProfileStatus(profile, opts)}`);
  if (profile.balanceCache) console.log(`\n${formatBalance(profile.balanceCache, opts)}`);
  if (profile.quotaCache) console.log(`\n${formatQuota(profile.quotaCache, opts)}`);
}

async function useCommand(args, opts) {
  const name = args[0];
  if (!name) throw new Error("usage: mm use <profile>");
  await useProfile(name);
  if (opts.json) return printJSON({ success: true, current: name });
  const color = makeColor(opts);
  console.log(`${color.green("Current provider:")} ${color.cyan(name)}`);
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
  const color = makeColor(opts);
  for (const [name, ok, detail] of checks) {
    const mark = ok ? color.green("✓") : color.yellow("!");
    console.log(`${mark} ${pad(color.gray(name), 18)} ${detail}`);
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
  const color = makeColor(opts);
  console.log(`${color.green("Removed profile:")} ${color.cyan(name)}`);
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

function keyDefaultsForMode(mode) {
  if (mode === "api") {
    return {
      envNames: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
      prompt: "Moonshot / Kimi API key"
    };
  }
  return {
    envNames: ["KIMI_CODE_API_KEY"],
    prompt: "Moonshot / Kimi Coding Plan API key"
  };
}

function keyDefaultsForProvider(provider) {
  if (provider === "deepseek") {
    return {
      envNames: ["DEEPSEEK_API_KEY"],
      prompt: "DeepSeek API key"
    };
  }
  throw new Error(`unknown provider "${provider}"`);
}

async function resolveKimiAdapter(mode, apiKey) {
  if (mode === "coding-plan") {
    return {
      baseUrl: KIMI_CODING_BASE,
      apiOrigin: "",
      modelSource: "kimi-coding-models-api",
      models: await fetchKimiCodingModels(apiKey)
    };
  }

  const errors = [];
  for (const origin of KIMI_API_ORIGINS) {
    try {
      return {
        baseUrl: `${origin}/anthropic`,
        apiOrigin: origin,
        modelSource: `${origin}/v1/models`,
        models: await fetchKimiAPIModels(apiKey, origin)
      };
    } catch (error) {
      errors.push(`${origin}: ${error.message}`);
    }
  }
  throw new Error(`Kimi API key did not work with known Moonshot endpoints:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
}

async function resolveDeepSeekAdapter(apiKey) {
  return {
    baseUrl: DEEPSEEK_ANTHROPIC_BASE,
    apiOrigin: DEEPSEEK_API_ORIGIN,
    modelSource: DEEPSEEK_MODELS_URL,
    models: await fetchDeepSeekModels(apiKey)
  };
}

function mergeSettings(target, generated) {
  target.env = { ...(target.env || {}), ...generated.env };
  if (generated.skipDangerousModePermissionPrompt) target.skipDangerousModePermissionPrompt = true;
  if (generated.skipAutoPermissionPrompt) target.skipAutoPermissionPrompt = true;
}

async function fetchKimiCodingModels(apiKey) {
  const res = await fetch(KIMI_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Kimi models request failed: HTTP ${res.status}: ${text}`);
  return parseKimiModels(JSON.parse(text));
}

async function fetchKimiAPIModels(apiKey, origin) {
  const url = `${origin}/v1/models`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`models request failed: HTTP ${res.status}: ${text}`);
  const models = parseKimiModels(JSON.parse(text));
  if (!models.length) throw new Error("models request returned no models");
  return models;
}

async function fetchKimiAPIBalance(origin, apiKey) {
  const url = `${origin}/v1/users/me/balance`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`balance request failed: HTTP ${res.status}: ${text}`);
  return parseKimiBalance(JSON.parse(text));
}

async function fetchDeepSeekModels(apiKey) {
  const res = await fetch(DEEPSEEK_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`DeepSeek models request failed: HTTP ${res.status}: ${text}`);
  return withDeepSeekClaudeVariants(parseDeepSeekModels(JSON.parse(text)));
}

async function fetchDeepSeekBalance(apiKey) {
  const res = await fetch(DEEPSEEK_BALANCE_URL, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`balance request failed: HTTP ${res.status}: ${text}`);
  return parseDeepSeekBalance(JSON.parse(text));
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

function parseDeepSeekModels(body) {
  return (body.data || [])
    .filter((item) => item.id)
    .map((item) => ({
      id: item.id,
      displayName: item.id,
      contextLength: 0
    }));
}

function withDeepSeekClaudeVariants(models) {
  const ids = new Set(models.map((model) => model.id));
  const output = [...models];
  if (ids.has("deepseek-v4-pro") && !ids.has("deepseek-v4-pro[1m]")) {
    output.unshift({
      id: "deepseek-v4-pro[1m]",
      displayName: "deepseek-v4-pro for Claude Code 1M",
      contextLength: 1000000
    });
  }
  return output;
}

function parseKimiBalance(body) {
  const data = body.data || {};
  if (body.status === false) throw new Error(`balance request failed: ${body.scode || body.code || "unknown"}`);
  return {
    success: true,
    provider: "kimi",
    queriedAt: new Date().toISOString(),
    available: number(data.available_balance),
    voucher: number(data.voucher_balance),
    cash: number(data.cash_balance),
    currency: data.currency || body.currency || "RMB"
  };
}

function parseDeepSeekBalance(body) {
  const balances = body.balance_infos || [];
  const preferred = balances.find((item) => item.currency === "CNY") || balances[0] || {};
  return {
    success: true,
    provider: "deepseek",
    queriedAt: new Date().toISOString(),
    available: number(preferred.total_balance),
    voucher: number(preferred.granted_balance),
    cash: number(preferred.topped_up_balance),
    currency: preferred.currency || "RMB",
    isAvailable: body.is_available !== false
  };
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

async function probeProfileStatus(profile) {
  const checkedAt = new Date().toISOString();
  const endpoint = `${String(profile.baseUrl || "").replace(/\/+$/, "")}/v1/messages`;
  const started = Date.now();
  try {
    await fetchClaudeProbe(endpoint, profile, "bearer");
    return successfulProbe(checkedAt, endpoint, profile, started);
  } catch (firstError) {
    if (requiresEnabledThinking(firstError)) {
      try {
        await fetchClaudeProbe(endpoint, profile, "bearer", { thinking: "enabled" });
        profile.probeThinking = "enabled";
        return successfulProbe(checkedAt, endpoint, profile, started);
      } catch (thinkingError) {
        return failedProbe(checkedAt, endpoint, profile, thinkingError, started);
      }
    }
    if (!/HTTP (401|403)\b/.test(firstError.message || "")) {
      return failedProbe(checkedAt, endpoint, profile, firstError, started);
    }
    try {
      await fetchClaudeProbe(endpoint, profile, "x-api-key");
      return successfulProbe(checkedAt, endpoint, profile, started);
    } catch (secondError) {
      if (requiresEnabledThinking(secondError)) {
        try {
          await fetchClaudeProbe(endpoint, profile, "x-api-key", { thinking: "enabled" });
          profile.probeThinking = "enabled";
          return successfulProbe(checkedAt, endpoint, profile, started);
        } catch (thinkingError) {
          return failedProbe(checkedAt, endpoint, profile, thinkingError, started);
        }
      }
      return failedProbe(checkedAt, endpoint, profile, secondError, started);
    }
  }
}

function successfulProbe(checkedAt, endpoint, profile, started) {
  return {
    success: true,
    checkedAt,
    endpoint,
    model: profile.model.main,
    latencyMs: Date.now() - started
  };
}

function failedProbe(checkedAt, endpoint, profile, error, started) {
  return {
    success: false,
    checkedAt,
    endpoint,
    model: profile.model.main,
    latencyMs: Date.now() - started,
    error: summarizeError(error.message || String(error), 180)
  };
}

async function fetchClaudeProbe(endpoint, profile, authMode, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01"
  };
  if (authMode === "x-api-key") headers["x-api-key"] = profile.apiKey;
  else headers.Authorization = `Bearer ${profile.apiKey}`;

  try {
    const body = {
      model: profile.model.main,
      max_tokens: PROBE_MAX_TOKENS,
      messages: [
        {
          role: "user",
          content: PROBE_PROMPT
        }
      ]
    };
    if (options.thinking === "enabled" || profile.probeThinking === "enabled") {
      body.thinking = { type: "enabled" };
    }
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`request timed out after ${PROBE_TIMEOUT_MS / 1000}s`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function requiresEnabledThinking(error) {
  return /invalid thinking: only type=enabled/i.test(error.message || String(error));
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

function recommendDeepSeekMapping(models) {
  const ids = new Set(models.map((model) => model.id));
  const pro = ids.has("deepseek-v4-pro[1m]") ? "deepseek-v4-pro[1m]" : ids.has("deepseek-v4-pro") ? "deepseek-v4-pro" : models[0]?.id || "deepseek-v4-pro[1m]";
  const flash = ids.has("deepseek-v4-flash") ? "deepseek-v4-flash" : pro;
  return {
    main: pro,
    opus: pro,
    sonnet: pro,
    haiku: flash,
    subagent: flash
  };
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

async function resolveApiKey(flags, defaults) {
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
  for (const envName of defaults.envNames) {
    if (process.env[envName]) return process.env[envName].trim();
  }
  if (!isInteractive()) throw new Error(`missing API key; pass --key-env ${defaults.envNames[0]} or --key-stdin`);
  const value = await ask(`${defaults.prompt}:\n> `);
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
  if (profile.provider === "kimi" && profile.mode === "api") return "Kimi API";
  if (profile.provider === "deepseek" && profile.mode === "api") return "DeepSeek API";
  return `${profile.provider} ${profile.mode}`;
}

function kimiAPIOriginForProfile(profile) {
  if (profile.apiOrigin) return profile.apiOrigin;
  return String(profile.baseUrl || "").replace(/\/anthropic\/?$/, "").replace(/\/+$/, "");
}

function activeMarker(isActive, color) {
  return isActive ? color.active("✹") : "";
}

function listStatus(profile, color) {
  const quota = profile.quotaCache;
  const balance = profile.balanceCache;
  let limit;
  let quotaStatus = null;
  if (profile.mode === "api") {
    if (!balance) {
      limit = color.gray("balance not checked");
    } else if (!balance.success) {
      limit = color.red("balance error");
    } else {
      limit = color.green(formatBalanceLimit(balance));
    }
  } else if (!quota) {
    limit = color.gray("no quota data");
  } else if (!quota.success) {
    limit = color.red("quota error");
    quotaStatus = color.red("quota error");
  } else {
    const max = Math.max(0, ...quota.tiers.map((tier) => tier.usedPct || 0));
    const text = quota.tiers.map((tier) => `${tier.name} ${Math.round(tier.usedPct)}%`).join("  ");
    if (max >= 95) {
      limit = color.red(text);
      quotaStatus = color.red("exhausted");
    } else if (max >= 75) {
      limit = color.yellow(text);
      quotaStatus = color.yellow("warn");
    } else {
      limit = color.green(text);
      quotaStatus = color.green("ok");
    }
  }
  return {
    limit,
    status: compactProfileStatus(profile, color) || quotaStatus || color.gray("not checked")
  };
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

function formatBalance(balance, opts) {
  const color = makeColor(opts);
  if (!balance.success) return `Balance: ${color.red(balance.error || "error")}`;
  return [
    `Balance: ${color.green(formatCurrency(balance.available, balance.currency))} available`,
    color.gray(`voucher ${formatCurrency(balance.voucher, balance.currency)}; cash ${formatCurrency(balance.cash, balance.currency)}`)
  ].join("; ");
}

function formatBalanceLimit(balance) {
  return `balance ${formatCurrency(balance.available, balance.currency)}`;
}

function formatCurrency(value, currency = "RMB") {
  const code = currency || "RMB";
  const symbol = code === "RMB" || code === "CNY" ? "¥" : "";
  return `${symbol}${formatMoney(value)} ${code}`;
}

function formatMoney(value) {
  return Number(value || 0).toFixed(2);
}

function compactProfileStatus(profile, color) {
  if (profile.statusCache?.success) return color.green("ok");
  if (profile.statusCache) return color.red(summarizeError(profile.statusCache.error || "request failed", 48));
  return "";
}

function formatProbeStatus(statusCache, opts) {
  const color = makeColor(opts);
  if (!statusCache) return `Status: ${color.gray("not checked")}`;
  if (statusCache.success) {
    const latency = typeof statusCache.latencyMs === "number" ? color.gray(` ${statusCache.latencyMs}ms`) : "";
    return `Status: ${color.green("ok")}${latency}`;
  }
  return `Status: ${color.red(summarizeError(statusCache.error || "request failed", 120))}`;
}

function formatProfileStatus(profile, opts) {
  const color = makeColor(opts);
  if (profile.statusCache?.success) {
    const latency = typeof profile.statusCache.latencyMs === "number" ? color.gray(` ${profile.statusCache.latencyMs}ms`) : "";
    return `Status: ${color.green("ok")}${latency}`;
  }
  return formatProbeStatus(profile.statusCache, opts);
}

function summarizeError(value, max = 80) {
  const text = String(value || "request failed").replace(/\s+/g, " ").trim();
  const http = text.match(/^HTTP\s+\d+/i)?.[0] || "";
  const jsonStart = text.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const body = JSON.parse(text.slice(jsonStart));
      const extracted = extractErrorMessage(body);
      if (extracted) return truncatePlain(http ? `${http}: ${extracted}` : extracted, max);
    } catch {
      const extracted = extractErrorMessageFromText(text.slice(jsonStart));
      if (extracted) return truncatePlain(http ? `${http}: ${extracted}` : extracted, max);
    }
  }
  return truncatePlain(text, max);
}

function extractErrorMessage(body) {
  if (!body || typeof body !== "object") return "";
  if (typeof body.message === "string") return body.message;
  if (typeof body.error === "string") return body.error;
  if (body.error && typeof body.error === "object") {
    if (typeof body.error.message === "string") return body.error.message;
    if (typeof body.error.type === "string") return body.error.type;
    if (typeof body.error.code === "string") return body.error.code;
  }
  if (typeof body.code === "string" || typeof body.code === "number") return `code ${body.code}`;
  if (typeof body.scode === "string") return body.scode;
  return "";
}

function extractErrorMessageFromText(text) {
  for (const key of ["message", "type", "code", "scode"]) {
    const match = text.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)`));
    if (match) return match[1];
  }
  return "";
}

function printMapping(mapping, color = makeColor({ noColor: true })) {
  for (const slot of ["main", "opus", "sonnet", "haiku", "subagent"]) {
    console.log(`  ${color.gray(`${slot}:`.padEnd(10))}${color.cyan(mapping[slot])}`);
  }
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
  const plain = stripAnsi(value);
  if (plain.length <= max) return value;
  return `${plain.slice(0, max - 1)}…`;
}

function truncatePlain(value, max) {
  value = stripAnsi(value);
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function pad(value, length) {
  value = String(value || "");
  const visibleLength = stripAnsi(value).length;
  return visibleLength >= length ? value : value + " ".repeat(length - visibleLength);
}

function stripAnsi(value) {
  return String(value || "").replace(/\u001b\[[0-9;]*m/g, "");
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
      const width = Math.max(60, output.columns || 80);
      const lines = [colorText(message, "92;1")];
      for (let i = 0; i < options.length; i++) {
        const option = options[i];
        const selected = i === index;
        if (selected) {
          lines.push(selectedOptionLine(option, width - 1));
          continue;
        }
        const description = option.description ? colorText(` ${option.description}`, "90") : "";
        lines.push(`    ${colorText(option.label, "37")}${description}`);
      }
      lines.push(colorText("Use ↑/↓, j/k, or number keys. Press Enter to confirm.", "90"));
      for (const line of lines) output.write(`\u001b[2K\r${line}\n`);
      renderedLines = lines.length;
    };

    const finish = () => {
      cleanup();
      if (renderedLines > 0) output.write(`\u001b[${renderedLines}A`);
      output.write(`\u001b[2K\r${colorText(message, "92;1")} ${colorText(options[index].label, "36;1")}\n`);
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

function selectedOptionLine(option, width) {
  const bg = "\u001b[48;5;17m";
  const reset = "\u001b[0m";
  const withBg = (code, text) => `${bg}\u001b[${code}m${text}${reset}${bg}`;
  const description = option.description ? withBg("90", ` ${option.description}`) : "";
  const line = `${bg}  ${withBg("36;1", "✦")} ${withBg("36;1", option.label)}${description}`;
  return `${line}${" ".repeat(Math.max(0, width - stripAnsi(line).length))}${reset}`;
}

function makeColor(opts = {}) {
  const stream = opts.stream || process.stdout;
  const enabled = !opts.noColor && stream.isTTY;
  const wrap = (code, text) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : text);
  return {
    bold: (text) => wrap(1, text),
    active: (text) => wrap("5;36;1", text),
    green: (text) => wrap(32, text),
    cyan: (text) => wrap(36, text),
    yellow: (text) => wrap(33, text),
    red: (text) => wrap(31, text),
    gray: (text) => wrap(90, text),
    blue: (text) => wrap(94, text)
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
  parseKimiBalance,
  parseDeepSeekModels,
  parseDeepSeekBalance,
  recommendMapping,
  recommendDeepSeekMapping,
  mergeSettings,
  settingsForProfile,
  listStatus,
  formatProbeStatus,
  formatProfileStatus,
  detectStorageCandidates,
  normalizeProvider,
  formatUnsupportedProvider
};
