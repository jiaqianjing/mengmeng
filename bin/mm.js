#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const APP_VERSION = "0.1.0";
const STORE_VERSION = 1;
const INSTALL_SH_URL = "https://raw.githubusercontent.com/jiaqianjing/mengmeng/main/install.sh";
const KIMI_CODING_BASE = "https://api.kimi.com/coding";
const KIMI_MODELS_URL = "https://api.kimi.com/coding/v1/models";
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const KIMI_API_ORIGINS = ["https://api.moonshot.ai", "https://api.moonshot.cn"];
const DEEPSEEK_API_ORIGIN = "https://api.deepseek.com";
const DEEPSEEK_ANTHROPIC_BASE = `${DEEPSEEK_API_ORIGIN}/anthropic`;
const DEEPSEEK_MODELS_URL = `${DEEPSEEK_API_ORIGIN}/models`;
const DEEPSEEK_BALANCE_URL = `${DEEPSEEK_API_ORIGIN}/user/balance`;
const SILICONFLOW_API_ORIGIN = "https://api.siliconflow.cn";
const SILICONFLOW_MODELS_URL = `${SILICONFLOW_API_ORIGIN}/v1/models?type=text&sub_type=chat`;
const SILICONFLOW_USER_INFO_URL = `${SILICONFLOW_API_ORIGIN}/v1/user/info`;
const GLM_ANTHROPIC_BASE = "https://open.bigmodel.cn/api/anthropic";
const MIMO_API_ANTHROPIC_BASE = "https://api.xiaomimimo.com/anthropic";
const MIMO_TOKEN_PLAN_ANTHROPIC_BASE = "https://token-plan-cn.xiaomimimo.com/anthropic";
const PROBE_PROMPT = "这是一个接口测试，请返回 \"ok\" 即可。";
const PROBE_MAX_TOKENS = 8;
const PROBE_TIMEOUT_MS = 20000;
const CLAUDE_ONE_M_MARKER = "[1M]";
const KNOWN_COMPAT_SUFFIXES = [
  "/api/claudecode",
  "/api/anthropic",
  "/apps/anthropic",
  "/api/coding",
  "/claudecode",
  "/anthropic",
  "/step_plan",
  "/coding",
  "/claude"
];
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
  },
  {
    id: "siliconflow",
    name: "SiliconFlow API",
    aliases: ["silicon", "silicon-flow", "siliconcloud", "sf"]
  },
  {
    id: "glm",
    name: "Zhipu GLM",
    aliases: ["zhipu", "zhipu-glm", "bigmodel", "bigmodel-glm"]
  },
  {
    id: "mimo",
    name: "Xiaomi MiMo",
    aliases: ["xiaomi", "xiaomi-mimo", "mimo-token-plan"]
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

  if (command === "version" || command === "-v" || command === "--version") {
    versionCommand(opts);
    return;
  }

  if (command === "init") {
    await initCommand(args.slice(1), opts);
    return;
  }

  if (command === "upgrade") {
    await upgradeCommand(args.slice(1), opts);
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
    case "edit":
      return editCommand(args.slice(1), opts);
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
  ${color.gray("mm version")}
  ${color.gray("mm upgrade")}
  ${color.gray("mm add <provider>")}
  ${color.gray("mm list")}
  ${color.gray("mm current")}
  ${color.gray("mm show <profile>")}
  ${color.gray("mm edit <profile>")}
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
    "key-env": "value",
    "base-url": "value",
    model: "value"
  });
  const providerInput = rest[0];
  const provider = normalizeProvider(providerInput);
  if (!provider) throw new Error("usage: mm add <provider>");
  if (!isSupportedProvider(provider)) throw new Error(formatUnsupportedProvider(providerInput));
  if (provider === "kimi") return addKimiCommand(flags, opts);
  if (provider === "deepseek") return addDeepSeekCommand(flags, opts);
  if (provider === "siliconflow") return addSiliconFlowCommand(flags, opts);
  if (["glm", "mimo"].includes(provider)) return addStaticAnthropicCommand(provider, flags, opts);
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

async function addSiliconFlowCommand(flags, opts) {
  const mode = flags.mode || "api";
  if (mode !== "api") throw new Error(`unsupported SiliconFlow mode "${mode}"; use api`);

  let profileName = flags.name || "siliconflow";
  if (isInteractive() && !flags.yes) {
    const answer = await ask(`Profile name [${profileName}]: `);
    if (answer.trim()) profileName = answer.trim();
  }

  let baseUrl = flags["base-url"] || SILICONFLOW_API_ORIGIN;
  if (isInteractive() && !flags.yes) {
    const answer = await ask(`Base URL [${baseUrl}]: `);
    if (answer.trim()) baseUrl = answer.trim();
  }
  baseUrl = normalizeSiliconFlowBaseUrl(baseUrl);

  const apiKey = await resolveApiKey(flags, keyDefaultsForProvider("siliconflow"));
  console.error("Testing SiliconFlow API...");
  const adapter = await resolveSiliconFlowAdapter(apiKey, baseUrl);
  const models = adapter.models;
  let mapping = flags.model ? sameModelMapping(flags.model) : recommendSiliconFlowMapping(models);

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
    balanceCache = await fetchSiliconFlowBalance(baseUrl, apiKey);
  } catch {
    balanceCache = null;
  }

  console.error("Checking SiliconFlow request path...");
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
    provider: "siliconflow",
    mode,
    baseUrl,
    apiKey,
    model: mapping,
    env: {
      ENABLE_TOOL_SEARCH: "true"
    },
    powerUser,
    quotaCache: null,
    balanceCache,
    statusCache: null,
    apiOrigin: baseUrl,
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

async function addStaticAnthropicCommand(provider, flags, opts) {
  const preset = await resolveStaticAnthropicPreset(provider, flags);

  let profileName = flags.name || preset.defaultName;
  if (isInteractive() && !flags.yes) {
    const answer = await ask(`Profile name [${profileName}]: `);
    if (answer.trim()) profileName = answer.trim();
  }

  let baseUrl = flags["base-url"] || preset.baseUrl;
  if (isInteractive() && !flags.yes && preset.allowBaseUrlEdit) {
    const answer = await ask(`Base URL [${baseUrl}]: `);
    if (answer.trim()) baseUrl = answer.trim();
  }

  const apiKey = await resolveApiKey(flags, preset.keyDefaults);
  const modelInfo = await resolveStaticAnthropicModels(preset, baseUrl, apiKey);
  const models = modelInfo.models;
  let mapping = flags.model ? sameModelMapping(flags.model) : { ...preset.mapping };

  if (isInteractive() && !flags.yes) {
    mapping = await editModelMapping(models, mapping);
  }

  let powerUser = Boolean(flags["power-user"]);
  if (isInteractive() && !flags.yes) {
    const answer = await ask("Enable Claude Code power-user permission settings? [y/N] ");
    powerUser = confirmDefaultNo(answer);
  }

  let quotaCache = null;
  if (provider === "glm" && preset.mode === "coding-plan") {
    try {
      quotaCache = await fetchGlmQuota(baseUrl, apiKey);
    } catch {
      quotaCache = null;
    }
  }

  console.error(`Checking ${preset.displayName} request path...`);
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
    provider,
    mode: preset.mode,
    baseUrl,
    apiKey,
    model: mapping,
    env: preset.env,
    powerUser,
    quotaCache,
    balanceCache: null,
    statusCache: null,
    apiOrigin: "",
    modelSource: modelInfo.modelSource,
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
    if (profile.provider === "glm" && profile.mode === "coding-plan") {
      try {
        profile.quotaCache = await fetchGlmQuota(profile.baseUrl, profile.apiKey);
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
    if (profile.provider === "siliconflow" && profile.mode === "api") {
      try {
        profile.balanceCache = await fetchSiliconFlowBalance(profile.baseUrl, profile.apiKey);
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
  printProfileDetails(profile, opts);
}

function printProfileDetails(profile, opts) {
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

async function editCommand(args, opts) {
  const name = args[0];
  if (!name) throw new Error("usage: mm edit <profile>");
  if (opts.json || !isInteractive()) throw new Error("mm edit is interactive; use `mm show --json <profile>` and `mm import` for scripted changes");

  const config = requireConfig();
  const store = readStore(config.configDir);
  const index = store.profiles.findIndex((p) => p.name === name);
  if (index < 0) throw new Error(`profile "${name}" not found`);
  const profile = cloneJSON(store.profiles[index]);
  const color = makeColor(opts);
  let changed = false;

  for (;;) {
    console.log("");
    printProfileDetails(profile, opts);
    console.log("");
    const selected = await selectOption(`Edit ${profile.name}`, editProfileOptions(profile), 0);
    if (selected.value === "done") break;
    if (selected.value === "cancel") {
      console.log("Cancelled.");
      return;
    }
    if (selected.value === "apiKey") {
      profile.apiKey = await askSecretValue("API key", profile.apiKey);
      changed = true;
    } else if (selected.value === "baseUrl") {
      const answer = await ask(`Base URL [${profile.baseUrl}]: `);
      if (answer.trim()) {
        profile.baseUrl = answer.trim();
        changed = true;
      }
    } else if (selected.value === "mapping") {
      profile.model = await editModelMapping(await modelsForProfile(profile), normalizeProfileMapping(profile.model));
      changed = true;
    } else if (selected.value === "env") {
      changed = await editProfileEnv(profile) || changed;
    } else if (selected.value === "powerUser") {
      profile.powerUser = !profile.powerUser;
      changed = true;
      console.log(`${color.gray("Power-user settings:")} ${profile.powerUser ? color.green("enabled") : color.yellow("disabled")}`);
    } else if (selected.value === "refresh") {
      await refreshProfileCaches(profile);
      changed = true;
      console.log(formatProfileStatus(profile, opts));
    }
  }

  if (!changed) {
    console.log("No changes.");
    return;
  }

  await refreshProfileCaches(profile);
  profile.updatedAt = new Date().toISOString();
  store.profiles[index] = profile;
  writeStore(config.configDir, store);

  if (config.current === profile.name) {
    const applyNow = await ask(`"${profile.name}" is active. Rewrite Claude Code settings now? [Y/n] `);
    if (confirmDefaultYes(applyNow)) await useProfile(profile.name);
  }

  console.log(`${color.green("Updated profile:")} ${color.cyan(profile.name)}`);
  console.log(formatProfileStatus(profile, opts));
}

function editProfileOptions(profile) {
  return [
    { label: "Done", description: "save changes", value: "done" },
    { label: "API key", description: maskSecret(profile.apiKey), value: "apiKey" },
    { label: "Base URL", description: profile.baseUrl || "", value: "baseUrl" },
    { label: "Model mapping", description: profile.model?.main || "", value: "mapping" },
    { label: "Extra env", description: `${Object.keys(profile.env || {}).length} managed vars`, value: "env" },
    { label: "Power-user settings", description: profile.powerUser ? "enabled" : "disabled", value: "powerUser" },
    { label: "Refresh status", description: "probe and sync quota/balance", value: "refresh" },
    { label: "Cancel", description: "discard changes", value: "cancel" }
  ];
}

async function askSecretValue(label, current = "") {
  const answer = await ask(`${label} [${maskSecret(current)}]: `);
  return answer.trim() ? answer.trim() : current;
}

async function modelsForProfile(profile) {
  try {
    if (profile.provider === "kimi" && profile.mode === "coding-plan") return mergeModels(await fetchKimiCodingModels(profile.apiKey), mappingModels(profile.model));
    if (profile.provider === "kimi" && profile.mode === "api") return mergeModels(await fetchKimiAPIModels(profile.apiKey, kimiAPIOriginForProfile(profile)), mappingModels(profile.model));
    if (profile.provider === "deepseek") return mergeModels(await fetchDeepSeekModels(profile.apiKey), mappingModels(profile.model));
    if (profile.provider === "siliconflow") return mergeModels(await fetchSiliconFlowModels(profile.apiKey, profile.baseUrl), mappingModels(profile.model));
    if (profile.provider === "glm" || profile.provider === "mimo") {
      const preset = await resolveStaticAnthropicPreset(profile.provider, { mode: profile.mode, yes: true });
      return (await resolveStaticAnthropicModels(preset, profile.baseUrl, profile.apiKey)).models;
    }
  } catch (error) {
    console.log(`Model list unavailable: ${summarizeError(error.message, 120)}`);
  }
  return mappingModels(profile.model);
}

function mappingModels(mapping = {}) {
  return unique(Object.values(normalizeProfileMapping(mapping)).filter(Boolean)).map((id) => ({
    id,
    displayName: modelDisplayName(id),
    contextLength: 0
  }));
}

function normalizeProfileMapping(mapping = {}) {
  const main = mapping.main || mapping.opus || mapping.sonnet || mapping.haiku || "";
  return {
    main,
    opus: mapping.opus || main,
    sonnet: mapping.sonnet || main,
    haiku: mapping.haiku || main,
    fable: mapping.fable || mapping.opus || main,
    subagent: mapping.subagent || mapping.haiku || main
  };
}

async function editProfileEnv(profile) {
  profile.env ||= {};
  const known = [
    "ENABLE_TOOL_SEARCH",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
    "CLAUDE_CODE_EFFORT_LEVEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES"
  ];
  const keys = unique([...Object.keys(profile.env), ...known]);
  const selected = await selectOption("Edit managed env", [
    { label: "Back", value: "back" },
    ...keys.map((key) => ({
      label: key,
      description: String(profile.env[key] ?? ""),
      value: key
    }))
  ], 0);
  if (selected.value === "back") return false;
  const current = profile.env[selected.value] ?? "";
  const answer = await ask(`${selected.value} [${current}] (blank deletes): `);
  if (!answer.trim()) delete profile.env[selected.value];
  else profile.env[selected.value] = answer.trim();
  return true;
}

async function refreshProfileCaches(profile) {
  if (profile.provider === "kimi" && profile.mode === "coding-plan") profile.quotaCache = await cacheOrError(() => fetchKimiQuota(profile.apiKey), profile.provider);
  if (profile.provider === "glm" && profile.mode === "coding-plan") profile.quotaCache = await cacheOrError(() => fetchGlmQuota(profile.baseUrl, profile.apiKey), profile.provider);
  if (profile.provider === "kimi" && profile.mode === "api") profile.balanceCache = await cacheOrError(() => fetchKimiAPIBalance(kimiAPIOriginForProfile(profile), profile.apiKey), profile.provider);
  if (profile.provider === "deepseek" && profile.mode === "api") profile.balanceCache = await cacheOrError(() => fetchDeepSeekBalance(profile.apiKey), profile.provider);
  if (profile.provider === "siliconflow" && profile.mode === "api") profile.balanceCache = await cacheOrError(() => fetchSiliconFlowBalance(profile.baseUrl, profile.apiKey), profile.provider);
  profile.statusCache = await probeProfileStatus(profile);
}

async function cacheOrError(fn, provider) {
  try {
    return await fn();
  } catch (error) {
    return {
      success: false,
      provider,
      queriedAt: new Date().toISOString(),
      error: error.message
    };
  }
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
  if (config.current === name) {
    const other = store.profiles.find((p) => p.name !== name)?.name;
    const hint = other ? ` Run \`mm use ${other}\` first, then remove "${name}".` : " Add or switch to another profile first.";
    throw new Error(`profile "${name}" is active and cannot be removed.${hint}`);
  }
  store.profiles.splice(index, 1);
  writeStore(config.configDir, store);
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

function versionCommand(opts) {
  if (opts.json) return printJSON({ name: "mengmeng", version: APP_VERSION });
  console.log(`MengMeng ${APP_VERSION}`);
}

async function upgradeCommand(args, opts) {
  const { flags, rest } = parseFlags(args, {
    "bin-dir": "value",
    "install-url": "value"
  });
  if (flags.help || rest.includes("-h")) {
    printUpgradeHelp(opts);
    return;
  }

  const binDir = flags["bin-dir"] ? expandHome(flags["bin-dir"]) : getSelfInstallDir();
  const selfPath = realSelfPath();
  if (!flags.force && isHomebrewInstall(selfPath)) {
    const message = "MengMeng appears to be managed by Homebrew. Use `brew upgrade mengmeng` or rerun with `mm upgrade --force`.";
    if (opts.json) return printJSON({ success: false, version: APP_VERSION, binDir, reason: "homebrew" });
    throw new Error(message);
  }
  if (!flags.force && isSourceCheckout(selfPath)) {
    const message = [
      "MengMeng appears to be running from a source checkout.",
      "Use `git pull` in the repository, or rerun with `mm upgrade --force` to overwrite the current bin directory."
    ].join(" ");
    if (opts.json) return printJSON({ success: false, version: APP_VERSION, binDir, reason: "source-checkout" });
    throw new Error(message);
  }

  const installUrl = flags["install-url"] || process.env.MENGMENG_INSTALL_SH_URL || INSTALL_SH_URL;
  const script = await fetchText(installUrl);
  const installArgs = ["-s", "--", "--bin-dir", binDir, "--force"];
  await runInstaller(script, installArgs, opts);

  if (opts.json) return printJSON({ success: true, version: APP_VERSION, binDir });
}

function printUpgradeHelp(opts = {}) {
  const color = makeColor({ ...opts, stream: process.stdout });
  console.log(`${color.bold("Usage:")}
  ${color.gray("mm upgrade")}
  ${color.gray("mm upgrade --bin-dir <dir>")}

${color.bold("Options:")}
  ${color.gray("--bin-dir <dir>")}      Install directory, defaults to the current mm executable directory
  ${color.gray("--install-url <url>")}  Override install.sh URL
  ${color.gray("--force")}              Allow upgrade from a source checkout`);
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
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: modelDisplayName(profile.model.opus, profile.model.opusName),
    ANTHROPIC_DEFAULT_SONNET_MODEL: profile.model.sonnet,
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: modelDisplayName(profile.model.sonnet, profile.model.sonnetName),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: profile.model.haiku,
    ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: modelDisplayName(profile.model.haiku, profile.model.haikuName),
    ANTHROPIC_DEFAULT_FABLE_MODEL: profile.model.fable || profile.model.opus,
    ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: modelDisplayName(profile.model.fable || profile.model.opus, profile.model.fableName || profile.model.opusName),
    CLAUDE_CODE_SUBAGENT_MODEL: profile.model.subagent,
    ...cleanEnv(profile.env || {})
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
  if (provider === "siliconflow") {
    return {
      envNames: ["SILICONFLOW_API_KEY", "SILICONCLOUD_API_KEY"],
      prompt: "SiliconFlow API key"
    };
  }
  if (provider === "glm") {
    return {
      envNames: ["GLM_API_KEY", "ZHIPU_API_KEY", "BIGMODEL_API_KEY"],
      prompt: "Zhipu GLM API key"
    };
  }
  if (provider === "mimo") {
    return {
      envNames: ["MIMO_API_KEY", "XIAOMI_MIMO_API_KEY", "MIMO_TOKEN_PLAN_API_KEY", "XIAOMI_MIMO_TOKEN_PLAN_API_KEY"],
      prompt: "Xiaomi MiMo API key"
    };
  }
  throw new Error(`unknown provider "${provider}"`);
}

async function resolveStaticAnthropicPreset(provider, flags) {
  if (provider === "glm") {
    return {
      defaultName: "glm",
      displayName: "Zhipu GLM",
      mode: "coding-plan",
      baseUrl: GLM_ANTHROPIC_BASE,
      allowBaseUrlEdit: false,
      keyDefaults: keyDefaultsForProvider("glm"),
      modelSource: "static-cc-switch-preset",
      models: [
        { id: "glm-5.1", displayName: "GLM-5.1", contextLength: 200000 },
        { id: "glm-5.1[1M]", displayName: "GLM-5.1 1M", contextLength: 1000000 }
      ],
      mapping: {
        main: "glm-5.1",
        opus: "glm-5.1[1M]",
        sonnet: "glm-5.1[1M]",
        haiku: "glm-5.1",
        fable: "glm-5.1[1M]",
        subagent: "glm-5.1"
      },
      env: {
        ENABLE_TOOL_SEARCH: "true",
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000",
        CLAUDE_CODE_EFFORT_LEVEL: "xhigh",
        ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES: "effort,xhigh_effort,max_effort,thinking,adaptive_thinking,interleaved_thinking"
      }
    };
  }

  if (provider === "mimo") {
    let mode = flags.mode || "";
    if (!mode && isInteractive() && !flags.yes) {
      const selected = await selectOption("How do you want to use Xiaomi MiMo?", [
        {
          label: "MiMo Token Plan",
          description: "China token-plan endpoint",
          value: "token-plan"
        },
        {
          label: "MiMo API key",
          description: "pay-as-you-go API endpoint",
          value: "api"
        }
      ], 0);
      mode = selected.value;
    }
    if (!mode) mode = "token-plan";
    if (!["token-plan", "api"].includes(mode)) throw new Error(`unsupported MiMo mode "${mode}"; use token-plan or api`);
    return {
      defaultName: mode === "api" ? "mimo-api" : "mimo",
      displayName: mode === "api" ? "Xiaomi MiMo API" : "Xiaomi MiMo Token Plan",
      mode,
      baseUrl: mode === "api" ? MIMO_API_ANTHROPIC_BASE : MIMO_TOKEN_PLAN_ANTHROPIC_BASE,
      allowBaseUrlEdit: false,
      keyDefaults: keyDefaultsForProvider("mimo"),
      modelSource: "static-cc-switch-preset",
      models: [
        { id: "mimo-v2.5-pro", displayName: "MiMo V2.5 Pro", contextLength: 1048576 },
        { id: "mimo-v2.5", displayName: "MiMo V2.5", contextLength: 1048576 }
      ],
      mapping: sameModelMapping("mimo-v2.5-pro"),
      env: {
        ENABLE_TOOL_SEARCH: "true"
      }
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

async function resolveSiliconFlowAdapter(apiKey, baseUrl = SILICONFLOW_API_ORIGIN) {
  return {
    baseUrl,
    apiOrigin: baseUrl,
    modelSource: siliconFlowModelsUrl(baseUrl),
    models: await fetchSiliconFlowModels(apiKey, baseUrl)
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

async function fetchSiliconFlowModels(apiKey, baseUrl = SILICONFLOW_API_ORIGIN) {
  const url = siliconFlowModelsUrl(baseUrl);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SiliconFlow models request failed: HTTP ${res.status}: ${text}`);
  const models = parseSiliconFlowModels(JSON.parse(text));
  if (!models.length) throw new Error("SiliconFlow models request returned no chat models");
  return models;
}

async function fetchSiliconFlowBalance(baseUrl, apiKey) {
  const res = await fetch(siliconFlowUserInfoUrl(baseUrl), {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`balance request failed: HTTP ${res.status}: ${text}`);
  return parseSiliconFlowBalance(JSON.parse(text));
}

async function resolveStaticAnthropicModels(preset, baseUrl, apiKey) {
  const fallback = {
    models: preset.models,
    modelSource: preset.modelSource
  };
  const candidates = buildModelsUrlCandidates(baseUrl, preset.modelsUrl);
  const errors = [];
  for (const url of candidates) {
    try {
      const models = await fetchGenericModels(url, apiKey);
      return {
        models: mergeModels(models, preset.models),
        modelSource: url
      };
    } catch (error) {
      errors.push(`${url}: ${error.message}`);
    }
  }
  if (errors.length) {
    fallback.modelSource = `${preset.modelSource}; models fetch failed`;
  }
  return fallback;
}

async function fetchGenericModels(url, apiKey) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${summarizeError(text, 160)}`);
  const models = parseGenericModels(JSON.parse(text));
  if (!models.length) throw new Error("models request returned no models");
  return models;
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

function parseSiliconFlowModels(body) {
  return (body.data || [])
    .filter((item) => item.id)
    .filter((item) => isSiliconFlowChatModel(item))
    .map((item) => ({
      id: item.id,
      displayName: item.display_name || item.name || item.id,
      contextLength: number(item.context_length || item.contextWindow || item.context_window)
    }));
}

function isSiliconFlowChatModel(item) {
  const type = String(item.type || "").toLowerCase();
  const subType = String(item.sub_type || item.subType || "").toLowerCase();
  if (type && type !== "text") return false;
  if (subType && subType !== "chat") return false;
  return true;
}

function parseGenericModels(body) {
  return (body.data || [])
    .filter((item) => item.id)
    .map((item) => ({
      id: item.id,
      displayName: item.display_name || item.name || item.id,
      contextLength: number(item.context_length || item.contextWindow || item.context_window)
    }));
}

function mergeModels(primary, fallback) {
  const seen = new Set();
  const merged = [];
  for (const model of [...primary, ...fallback]) {
    if (!model?.id || seen.has(model.id)) continue;
    seen.add(model.id);
    merged.push(model);
  }
  return merged;
}

function buildModelsUrlCandidates(baseUrl, override = "") {
  const explicit = String(override || "").trim();
  if (explicit) return [explicit];

  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return [];

  const candidates = [];
  if (endsWithVersionSegment(trimmed)) {
    candidates.push(`${trimmed}/models`);
    if (!trimmed.endsWith("/v1")) candidates.push(`${trimmed}/v1/models`);
  } else {
    candidates.push(`${trimmed}/v1/models`);
  }

  const stripped = stripCompatSuffix(trimmed);
  if (stripped && stripped.includes("://")) {
    candidates.push(`${stripped}/v1/models`);
    candidates.push(`${stripped}/models`);
  }

  return unique(candidates);
}

function normalizeSiliconFlowBaseUrl(baseUrl) {
  const trimmed = String(baseUrl || SILICONFLOW_API_ORIGIN).trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3).replace(/\/+$/, "") : trimmed;
}

function siliconFlowModelsUrl(baseUrl = SILICONFLOW_API_ORIGIN) {
  const normalized = normalizeSiliconFlowBaseUrl(baseUrl);
  if (normalized === SILICONFLOW_API_ORIGIN) return SILICONFLOW_MODELS_URL;
  return `${normalized}/v1/models?type=text&sub_type=chat`;
}

function siliconFlowUserInfoUrl(baseUrl = SILICONFLOW_API_ORIGIN) {
  const normalized = normalizeSiliconFlowBaseUrl(baseUrl);
  if (normalized === SILICONFLOW_API_ORIGIN) return SILICONFLOW_USER_INFO_URL;
  return `${normalized}/v1/user/info`;
}

function stripCompatSuffix(baseUrl) {
  for (const suffix of KNOWN_COMPAT_SUFFIXES) {
    if (baseUrl.endsWith(suffix)) return baseUrl.slice(0, -suffix.length).replace(/\/+$/, "");
  }
  return "";
}

function endsWithVersionSegment(url) {
  const segment = url.split("/").pop() || "";
  return /^v\d+$/i.test(segment);
}

function unique(values) {
  return values.filter((value, index) => values.indexOf(value) === index);
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

function parseSiliconFlowBalance(body) {
  if (body.status === false) throw new Error(`balance request failed: ${body.message || body.code || "unknown"}`);
  const data = body.data || {};
  return {
    success: true,
    provider: "siliconflow",
    queriedAt: new Date().toISOString(),
    available: number(data.totalBalance ?? data.total_balance ?? data.balance),
    voucher: number(data.balance),
    cash: number(data.chargeBalance ?? data.charge_balance),
    currency: data.currency || body.currency || "RMB",
    accountStatus: data.status || ""
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

async function fetchGlmQuota(baseUrl, apiKey) {
  const origin = glmQuotaOrigin(baseUrl);
  if (!origin) throw new Error("GLM quota endpoint is not known for this base URL");
  const url = `${origin}/api/monitor/usage/quota/limit`;
  const res = await fetch(url, {
    headers: {
      Authorization: apiKey,
      Accept: "application/json",
      "Content-Type": "application/json",
      "Accept-Language": "en-US,en"
    }
  });
  const text = await res.text();
  if (!res.ok) {
    return {
      success: false,
      provider: "glm",
      queriedAt: new Date().toISOString(),
      error: `HTTP ${res.status}: ${text}`
    };
  }
  return parseGlmQuota(JSON.parse(text));
}

function glmQuotaOrigin(baseUrl = "") {
  const value = String(baseUrl).toLowerCase();
  if (value.includes("bigmodel.cn")) return "https://open.bigmodel.cn";
  if (value.includes("api.z.ai") || value.includes("z.ai")) return "https://api.z.ai";
  return "";
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
    throw new Error(formatFetchError(error));
  } finally {
    clearTimeout(timeout);
  }
}

function requiresEnabledThinking(error) {
  return /invalid thinking: only type=enabled/i.test(error.message || String(error));
}

function formatFetchError(error) {
  const message = error?.message || String(error);
  const cause = error?.cause;
  const detail = cause?.code || cause?.message || "";
  return detail && !message.includes(detail) ? `${message}: ${detail}` : message;
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

function parseGlmQuota(body) {
  if (body.success === false) throw new Error(`quota request failed: ${body.msg || body.message || "unknown"}`);
  const data = body.data || {};
  const tiers = parseGlmQuotaTiers(data);
  return {
    success: true,
    provider: "glm",
    queriedAt: new Date().toISOString(),
    tiers,
    level: data.level || ""
  };
}

function parseGlmQuotaTiers(data) {
  const slots = { fiveHour: null, week: null };
  const unclassified = [];
  for (const item of data.limits || []) {
    const type = String(item.type || "");
    if (type.toUpperCase() !== "TOKENS_LIMIT") continue;
    const entry = {
      resetMs: Number.isFinite(Number(item.nextResetTime)) ? Number(item.nextResetTime) : null,
      tier: {
        name: "",
        usedPct: number(item.percentage),
        resetTime: formatMillisISO(item.nextResetTime)
      }
    };
    if (Number(item.unit) === 3 && !slots.fiveHour) slots.fiveHour = entry.tier;
    else if (Number(item.unit) === 6 && !slots.week) slots.week = entry.tier;
    else unclassified.push(entry);
  }

  unclassified.sort((a, b) => {
    if (a.resetMs === null && b.resetMs !== null) return -1;
    if (a.resetMs !== null && b.resetMs === null) return 1;
    return (a.resetMs ?? Number.MIN_SAFE_INTEGER) - (b.resetMs ?? Number.MIN_SAFE_INTEGER);
  });

  for (const entry of unclassified) {
    if (!slots.fiveHour) slots.fiveHour = entry.tier;
    else if (!slots.week) slots.week = entry.tier;
  }

  const tiers = [];
  if (slots.fiveHour) tiers.push({ ...slots.fiveHour, name: "5h" });
  if (slots.week) tiers.push({ ...slots.week, name: "week" });
  return tiers;
}

function formatMillisISO(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  try {
    return new Date(n).toISOString();
  } catch {
    return "";
  }
}

function recommendMapping(models) {
  const sorted = [...models].sort((a, b) => modelScore(b) - modelScore(a));
  const main = sorted[0]?.id || "kimi-for-coding";
  return { main, opus: main, sonnet: main, haiku: main, subagent: main };
}

function sameModelMapping(model) {
  return { main: model, opus: model, sonnet: model, haiku: model, fable: model, subagent: model };
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
    fable: pro,
    subagent: flash
  };
}

function recommendSiliconFlowMapping(models) {
  const sorted = [...models].sort((a, b) => siliconFlowModelScore(b) - siliconFlowModelScore(a));
  const main = sorted[0]?.id || "Pro/zai-org/GLM-5.2";
  return sameModelMapping(main);
}

function siliconFlowModelScore(model) {
  const text = `${model.id} ${model.displayName}`.toLowerCase();
  let score = modelScore(model);
  if (text.includes("glm-5.2") || text.includes("glm5.2")) score += 100000;
  else if (text.includes("glm-5.1") || text.includes("glm5.1")) score += 60000;
  else if (text.includes("glm")) score += 30000;
  if (text.startsWith("pro/")) score += 1000;
  if (text.includes("coder") || text.includes("code")) score += 500;
  return score;
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
    current[selected.value] = await chooseModel(modelSlotLabel(selected.value), models, current[selected.value] || current.opus || current.main);
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
    { label: `Fable    ${mapping.fable || mapping.opus}`, description: "ANTHROPIC_DEFAULT_FABLE_MODEL", value: "fable" },
    { label: `Subagent ${mapping.subagent}`, description: "CLAUDE_CODE_SUBAGENT_MODEL", value: "subagent" }
  ];
}

function modelSlotLabel(slot) {
  return {
    main: "Main",
    opus: "Opus",
    sonnet: "Sonnet",
    haiku: "Haiku",
    fable: "Fable",
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

function realSelfPath() {
  try {
    return fs.realpathSync(invokedSelfPath());
  } catch {
    return invokedSelfPath();
  }
}

function getSelfInstallDir() {
  return path.dirname(invokedSelfPath());
}

function invokedSelfPath() {
  return path.resolve(process.argv[1] || "mm");
}

function isSourceCheckout(file) {
  if (!file) return false;
  const dir = path.dirname(file);
  return path.basename(file) === "mm.js"
    && path.basename(dir) === "bin"
    && fs.existsSync(path.join(dir, "..", "package.json"));
}

function isHomebrewInstall(file) {
  return file.split(path.sep).includes("Cellar") || file.includes(`${path.sep}Homebrew${path.sep}`);
}

async function fetchText(url) {
  if (url.startsWith("file://")) {
    return fs.readFileSync(new URL(url), "utf8");
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to download ${url}: HTTP ${response.status}`);
  return response.text();
}

function runInstaller(script, args, opts) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("sh", args, {
      stdio: opts.json ? ["pipe", "pipe", "pipe"] : ["pipe", "inherit", "inherit"]
    });
    if (opts.json) {
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = (stderr || stdout).trim();
      reject(new Error(`installer failed with exit code ${code}${detail ? `: ${detail}` : ""}`));
    });
    child.stdin.end(script);
  });
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
  if (!fs.existsSync(storePath)) writeJSONAtomic(storePath, { version: STORE_VERSION, profiles: [] });
}

function readStore(configDir) {
  ensureStore(configDir);
  const store = readJSONIfExists(path.join(configDir, "profiles.json")) || {};
  store.version = STORE_VERSION;
  store.profiles ||= [];
  return store;
}

function writeStore(configDir, store) {
  store.version = STORE_VERSION;
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

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

function displayProvider(profile) {
  if (profile.provider === "kimi" && profile.mode === "coding-plan") return "Kimi Coding";
  if (profile.provider === "kimi" && profile.mode === "api") return "Kimi API";
  if (profile.provider === "deepseek" && profile.mode === "api") return "DeepSeek API";
  if (profile.provider === "siliconflow" && profile.mode === "api") return "SiliconFlow API";
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
  for (const slot of ["main", "opus", "sonnet", "haiku", "fable", "subagent"]) {
    if (!mapping[slot]) continue;
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

function modelDisplayName(model, explicitName) {
  if (explicitName) return explicitName;
  return stripClaudeOneMMarker(model);
}

function stripClaudeOneMMarker(model = "") {
  const value = String(model || "").trimEnd();
  if (!value.toLowerCase().endsWith(CLAUDE_ONE_M_MARKER.toLowerCase())) return value;
  return value.slice(0, -CLAUDE_ONE_M_MARKER.length).trimEnd();
}

function cleanEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== null && value !== ""));
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
  APP_VERSION,
  parseKimiModels,
  parseKimiQuota,
  parseGlmQuota,
  parseKimiBalance,
  parseDeepSeekModels,
  parseDeepSeekBalance,
  parseSiliconFlowModels,
  parseSiliconFlowBalance,
  recommendMapping,
  recommendDeepSeekMapping,
  recommendSiliconFlowMapping,
  mergeSettings,
  settingsForProfile,
  listStatus,
  formatProbeStatus,
  formatProfileStatus,
  detectStorageCandidates,
  normalizeProvider,
  formatUnsupportedProvider
};
