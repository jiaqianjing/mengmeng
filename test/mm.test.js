const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const {
  APP_VERSION,
  parseKimiModels,
  parseKimiQuota,
  parseGlmQuota,
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
} = require("../bin/mm.js");

const packageJson = require("../package.json");

const plainColor = {
  bold: (text) => text,
  active: (text) => text,
  green: (text) => text,
  cyan: (text) => text,
  yellow: (text) => text,
  red: (text) => text,
  gray: (text) => text
};

test("application version is controlled from package and CLI constant", async () => {
  assert.equal(APP_VERSION, "0.0.1");
  assert.equal(packageJson.version, APP_VERSION);

  const cwd = path.resolve(__dirname, "..");
  const version = await execFileAsync(process.execPath, ["bin/mm.js", "version"], { cwd });
  assert.equal(version.stdout.trim(), `MengMeng ${APP_VERSION}`);

  const short = await execFileAsync(process.execPath, ["bin/mm.js", "--version"], { cwd });
  assert.equal(short.stdout.trim(), `MengMeng ${APP_VERSION}`);
});

test("upgrade does not self-install from a source checkout by default", async () => {
  const cwd = path.resolve(__dirname, "..");
  const { stdout } = await execFileAsync(process.execPath, ["bin/mm.js", "--json", "upgrade"], { cwd });
  const result = JSON.parse(stdout);
  assert.equal(result.success, false);
  assert.equal(result.reason, "source-checkout");
  assert.equal(result.version, APP_VERSION);
});

test("parseKimiModels normalizes Kimi model list", () => {
  const models = parseKimiModels({
    data: [
      {
        id: "kimi-for-coding",
        display_name: "K2.7 Code",
        context_length: 262144
      }
    ]
  });
  assert.deepEqual(models, [
    {
      id: "kimi-for-coding",
      displayName: "K2.7 Code",
      contextLength: 262144
    }
  ]);
});

test("parseKimiQuota extracts 5h and weekly tiers", () => {
  const quota = parseKimiQuota({
    usage: {
      limit: "100",
      used: "25",
      remaining: "75",
      resetTime: "2026-06-15T06:24:29Z"
    },
    limits: [
      {
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: {
          limit: "100",
          used: "40",
          remaining: "60",
          resetTime: "2026-06-13T20:00:00Z"
        }
      }
    ]
  });
  assert.equal(quota.success, true);
  assert.equal(quota.tiers.length, 2);
  assert.equal(quota.tiers[0].name, "5h");
  assert.equal(quota.tiers[0].usedPct, 40);
  assert.equal(quota.tiers[1].name, "week");
  assert.equal(quota.tiers[1].usedPct, 25);
});

test("parseGlmQuota extracts 5h and weekly token tiers", () => {
  const quota = parseGlmQuota({
    success: true,
    data: {
      level: "pro",
      limits: [
        {
          type: "TOKENS_LIMIT",
          unit: 6,
          number: 7,
          percentage: 52.5,
          nextResetTime: 1770000000000
        },
        {
          type: "TOKENS_LIMIT",
          unit: 3,
          number: 5,
          percentage: 12.25,
          nextResetTime: 1769900000000
        }
      ]
    }
  });

  assert.equal(quota.success, true);
  assert.equal(quota.provider, "glm");
  assert.equal(quota.level, "pro");
  assert.equal(quota.tiers.length, 2);
  assert.equal(quota.tiers[0].name, "5h");
  assert.equal(quota.tiers[0].usedPct, 12.25);
  assert.equal(quota.tiers[1].name, "week");
  assert.equal(quota.tiers[1].usedPct, 52.5);
  assert.match(quota.tiers[0].resetTime, /^2026-/);
});

test("parseKimiBalance extracts available voucher and cash balances", () => {
  const balance = parseKimiBalance({
    code: 0,
    data: {
      available_balance: 49.58894,
      voucher_balance: 46.58893,
      cash_balance: 3.00001
    },
    scode: "0x0",
    status: true
  });

  assert.equal(balance.success, true);
  assert.equal(balance.available, 49.58894);
  assert.equal(balance.voucher, 46.58893);
  assert.equal(balance.cash, 3.00001);
  assert.equal(balance.currency, "RMB");
});

test("parseDeepSeekModels normalizes model list", () => {
  const models = parseDeepSeekModels({
    data: [
      { id: "deepseek-v4-flash", object: "model", owned_by: "deepseek" },
      { id: "deepseek-v4-pro", object: "model", owned_by: "deepseek" }
    ]
  });

  assert.deepEqual(models, [
    { id: "deepseek-v4-flash", displayName: "deepseek-v4-flash", contextLength: 0 },
    { id: "deepseek-v4-pro", displayName: "deepseek-v4-pro", contextLength: 0 }
  ]);
});

test("parseDeepSeekBalance extracts CNY balances", () => {
  const balance = parseDeepSeekBalance({
    is_available: true,
    balance_infos: [
      {
        currency: "CNY",
        total_balance: "9.52",
        granted_balance: "0.00",
        topped_up_balance: "9.52"
      }
    ]
  });

  assert.equal(balance.success, true);
  assert.equal(balance.available, 9.52);
  assert.equal(balance.voucher, 0);
  assert.equal(balance.cash, 9.52);
  assert.equal(balance.currency, "CNY");
});


test("recommendMapping chooses the coding model", () => {
  const mapping = recommendMapping([
    { id: "kimi-lite", displayName: "Lite", contextLength: 1000 },
    { id: "kimi-for-coding", displayName: "K2.7 Code", contextLength: 262144 }
  ]);
  assert.equal(mapping.main, "kimi-for-coding");
  assert.equal(mapping.haiku, "kimi-for-coding");
});

test("recommendDeepSeekMapping follows Claude Code defaults", () => {
  const mapping = recommendDeepSeekMapping([
    { id: "deepseek-v4-pro[1m]", displayName: "DeepSeek V4 Pro 1M" },
    { id: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" },
    { id: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash" }
  ]);

  assert.equal(mapping.main, "deepseek-v4-pro[1m]");
  assert.equal(mapping.opus, "deepseek-v4-pro[1m]");
  assert.equal(mapping.sonnet, "deepseek-v4-pro[1m]");
  assert.equal(mapping.haiku, "deepseek-v4-flash");
  assert.equal(mapping.subagent, "deepseek-v4-flash");
});

test("mergeSettings preserves unrelated settings", () => {
  const target = { theme: "dark", env: { KEEP_ME: "yes" } };
  mergeSettings(target, {
    env: { ANTHROPIC_BASE_URL: "https://api.kimi.com/coding" },
    skipAutoPermissionPrompt: true
  });
  assert.equal(target.theme, "dark");
  assert.equal(target.env.KEEP_ME, "yes");
  assert.equal(target.env.ANTHROPIC_BASE_URL, "https://api.kimi.com/coding");
  assert.equal(target.skipAutoPermissionPrompt, true);
});

test("detectStorageCandidates always includes local and custom choices", () => {
  const choices = detectStorageCandidates("/tmp/mengmeng-default");
  assert.ok(choices.find((choice) => choice.label === "Local config" && choice.path === "/tmp/mengmeng-default"));
  assert.ok(choices.find((choice) => choice.label === "Custom path" && choice.value === "custom"));
});

test("provider names support aliases and friendly suggestions", () => {
  assert.equal(normalizeProvider("moonshot"), "kimi");
  assert.equal(normalizeProvider("ds"), "deepseek");
  assert.equal(normalizeProvider("zhipu"), "glm");
  assert.equal(normalizeProvider("xiaomi-mimo"), "mimo");
  const message = formatUnsupportedProvider("kim");
  assert.match(message, /Did you mean: mm add kimi/);
  assert.match(message, /Supported providers:/);
});

test("settingsForProfile supports Kimi API mode", () => {
  const settings = settingsForProfile({
    baseUrl: "https://api.moonshot.ai/anthropic",
    apiKey: "sk-api-test",
    model: {
      main: "kimi-k2.6",
      opus: "kimi-k2.6",
      sonnet: "kimi-k2.6",
      haiku: "kimi-k2.6",
      subagent: "kimi-k2.6"
    },
    env: {
      ENABLE_TOOL_SEARCH: "false",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "262144"
    },
    powerUser: false
  }, { redact: false });

  assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://api.moonshot.ai/anthropic");
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "sk-api-test");
  assert.equal(settings.env.ANTHROPIC_MODEL, "kimi-k2.6");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, "kimi-k2.6");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, "kimi-k2.6");
});

test("settingsForProfile supports DeepSeek API mode", () => {
  const settings = settingsForProfile({
    baseUrl: "https://api.deepseek.com/anthropic",
    apiKey: "sk-deepseek-test",
    model: {
      main: "deepseek-v4-pro[1m]",
      opus: "deepseek-v4-pro[1m]",
      sonnet: "deepseek-v4-pro[1m]",
      haiku: "deepseek-v4-flash",
      subagent: "deepseek-v4-flash"
    },
    env: {
      ENABLE_TOOL_SEARCH: "false",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "262144"
    },
    powerUser: false
  }, { redact: false });

  assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "sk-deepseek-test");
  assert.equal(settings.env.ANTHROPIC_MODEL, "deepseek-v4-pro[1m]");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "deepseek-v4-flash");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, "deepseek-v4-pro");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, "deepseek-v4-pro[1m]");
});

test("settingsForProfile carries GLM 1M mapping and extra Claude env", () => {
  const settings = settingsForProfile({
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    apiKey: "glm-test-key",
    model: {
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
      ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES: "effort,xhigh_effort,max_effort,thinking,adaptive_thinking,interleaved_thinking"
    },
    powerUser: false
  }, { redact: false });

  assert.equal(settings.env.ANTHROPIC_MODEL, "glm-5.1");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "glm-5.1[1M]");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, "glm-5.1");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, "glm-5.1[1M]");
  assert.equal(settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, "1");
  assert.match(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES, /adaptive_thinking/);
});

test("listStatus explains API profiles without quota endpoint", () => {
  const status = listStatus({
    mode: "api",
    quotaCache: null,
    balanceCache: {
      success: true,
      available: 49.58894,
      voucher: 46.58893,
      cash: 3.00001
    },
    statusCache: {
      success: true,
      checkedAt: "2026-06-14T00:00:00Z",
      latencyMs: 300
    }
  }, plainColor);

  assert.equal(status.limit, "balance ¥49.59 RMB");
  assert.equal(status.status, "ok");
});

test("listStatus displays GLM quota tiers", () => {
  const status = listStatus({
    provider: "glm",
    mode: "coding-plan",
    quotaCache: {
      success: true,
      tiers: [
        { name: "5h", usedPct: 12.25 },
        { name: "week", usedPct: 52.5 }
      ]
    },
    statusCache: {
      success: true,
      checkedAt: "2026-06-14T00:00:00Z",
      latencyMs: 300
    }
  }, plainColor);

  assert.equal(status.limit, "5h 12%  week 53%");
  assert.equal(status.status, "ok");
});

test("listStatus shows probe error even when balance succeeds", () => {
  const status = listStatus({
    mode: "api",
    balanceCache: {
      success: true,
      available: 3.2,
      voucher: 0,
      cash: 3.2,
      currency: "RMB"
    },
    statusCache: {
      success: false,
      error: "HTTP 400"
    }
  }, plainColor);

  assert.equal(status.limit, "balance ¥3.20 RMB");
  assert.equal(status.status, "HTTP 400");
});

test("formatProbeStatus makes failed probes explicit", () => {
  const text = formatProbeStatus({
    success: false,
    error: "HTTP 401"
  }, { noColor: true });

  assert.equal(text, "Status: HTTP 401");
});

test("formatProfileStatus shows probe error even when balance succeeds", () => {
  const text = formatProfileStatus({
    mode: "api",
    balanceCache: {
      success: true,
      available: 3.2,
      voucher: 0,
      cash: 3.2,
      currency: "RMB"
    },
    statusCache: {
      success: false,
      error: "HTTP 400: {\"error\":{\"message\":\"model not found\"}}"
    }
  }, { noColor: true });

  assert.equal(text, "Status: HTTP 400: model not found");
});

test("formatProbeStatus summarizes truncated JSON errors", () => {
  const text = formatProbeStatus({
    success: false,
    error: "HTTP 429: {\"error\":{\"type\":\"rate_limit_error\",\"message\":\"quota exceeded\""
  }, { noColor: true });

  assert.equal(text, "Status: HTTP 429: quota exceeded");
});

test("list probes provider status by default", async () => {
  let requestBody = "";
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/users/me/balance") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        code: 0,
        data: {
          available_balance: 49.58894,
          voucher_balance: 46.58893,
          cash_balance: 3.00001
        },
        scode: "0x0",
        status: true
      }));
      return;
    }
    assert.equal(req.url, "/anthropic/v1/messages");
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      requestBody += chunk;
    });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "kimi-test",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 8, output_tokens: 1 }
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mengmeng-test-"));
  try {
    const now = "2026-06-14T00:00:00Z";
    fs.writeFileSync(path.join(temp, "config.json"), JSON.stringify({
      initialized: true,
      configDir: temp,
      claudeConfigPath: path.join(temp, "settings.json"),
      current: "kimi-api",
      createdAt: now,
      updatedAt: now
    }));
    fs.writeFileSync(path.join(temp, "profiles.json"), JSON.stringify({
      version: 1,
      profiles: [{
        name: "kimi-api",
        provider: "kimi",
        mode: "api",
        baseUrl: `http://127.0.0.1:${port}/anthropic`,
        apiKey: "sk-test",
        model: {
          main: "kimi-test",
          opus: "kimi-test",
          sonnet: "kimi-test",
          haiku: "kimi-test",
          subagent: "kimi-test"
        },
        env: {
          ENABLE_TOOL_SEARCH: "false",
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: "262144"
        },
        powerUser: false,
        quotaCache: null,
        statusCache: null,
        createdAt: now,
        updatedAt: now
      }]
    }));

    const { stdout } = await execFileAsync(process.execPath, ["bin/mm.js", "--no-color", "list"], {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        MENGMENG_HOME: temp,
        MENGMENG_CLAUDE_CONFIG: path.join(temp, "settings.json")
      }
    });

    assert.match(stdout, /✹\s+kimi-api/);
    assert.match(stdout, /balance ¥49\.59 RMB\s+ok/);
    assert.equal(JSON.parse(requestBody).messages[0].content, "这是一个接口测试，请返回 \"ok\" 即可。");
    const store = JSON.parse(fs.readFileSync(path.join(temp, "profiles.json"), "utf8"));
    assert.equal(store.profiles[0].statusCache.success, true);
    assert.equal(store.profiles[0].balanceCache.available, 49.58894);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("list retries Kimi API probe with enabled thinking when required", async () => {
  const messageBodies = [];
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/users/me/balance") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        code: 0,
        data: {
          available_balance: 3.2,
          voucher_balance: 0,
          cash_balance: 3.2
        },
        scode: "0x0",
        status: true
      }));
      return;
    }

    assert.equal(req.url, "/anthropic/v1/messages");
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      messageBodies.push(parsed);
      if (messageBodies.length === 1) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: {
            type: "invalid_request_error",
            message: "invalid thinking: only type=enabled is allowed for this model"
          }
        }));
        return;
      }
      assert.deepEqual(parsed.thinking, { type: "enabled" });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "kimi-k2.7-code",
        content: [{ type: "thinking", thinking: "ok" }],
        usage: { input_tokens: 8, output_tokens: 1 }
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mengmeng-test-"));
  try {
    const now = "2026-06-14T00:00:00Z";
    fs.writeFileSync(path.join(temp, "config.json"), JSON.stringify({
      initialized: true,
      configDir: temp,
      claudeConfigPath: path.join(temp, "settings.json"),
      current: "kimi-api",
      createdAt: now,
      updatedAt: now
    }));
    fs.writeFileSync(path.join(temp, "profiles.json"), JSON.stringify({
      version: 1,
      profiles: [{
        name: "kimi-api",
        provider: "kimi",
        mode: "api",
        baseUrl: `http://127.0.0.1:${port}/anthropic`,
        apiOrigin: `http://127.0.0.1:${port}`,
        apiKey: "sk-test",
        model: {
          main: "kimi-k2.7-code",
          opus: "kimi-k2.7-code",
          sonnet: "kimi-k2.7-code",
          haiku: "kimi-k2.7-code",
          subagent: "kimi-k2.7-code"
        },
        env: {
          ENABLE_TOOL_SEARCH: "false",
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: "262144"
        },
        powerUser: false,
        quotaCache: null,
        balanceCache: null,
        statusCache: null,
        createdAt: now,
        updatedAt: now
      }]
    }));

    const { stdout } = await execFileAsync(process.execPath, ["bin/mm.js", "--no-color", "list"], {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        MENGMENG_HOME: temp,
        MENGMENG_CLAUDE_CONFIG: path.join(temp, "settings.json")
      }
    });

    assert.equal(messageBodies.length, 2);
    assert.equal(messageBodies[0].thinking, undefined);
    assert.match(stdout, /balance ¥3\.20 RMB\s+ok/);
    const store = JSON.parse(fs.readFileSync(path.join(temp, "profiles.json"), "utf8"));
    assert.equal(store.profiles[0].statusCache.success, true);
    assert.equal(store.profiles[0].probeThinking, "enabled");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("add glm saves a static Anthropic-compatible profile", async () => {
  let requestBody = "";
  let requestedModels = false;
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      requestedModels = true;
      assert.equal(req.headers.authorization, "Bearer glm-test-key");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        data: [
          { id: "glm-test", display_name: "GLM Test" },
          { id: "glm-5.1", display_name: "GLM-5.1" }
        ]
      }));
      return;
    }

    assert.equal(req.url, "/v1/messages");
    assert.equal(req.headers.authorization, "Bearer glm-test-key");
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      requestBody += chunk;
    });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_glm",
        type: "message",
        role: "assistant",
        model: "glm-test",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 8, output_tokens: 1 }
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mengmeng-test-"));
  try {
    const now = "2026-06-14T00:00:00Z";
    fs.writeFileSync(path.join(temp, "config.json"), JSON.stringify({
      initialized: true,
      configDir: temp,
      claudeConfigPath: path.join(temp, "settings.json"),
      current: "",
      createdAt: now,
      updatedAt: now
    }));

    const { stdout } = await execFileAsync(process.execPath, [
      "bin/mm.js",
      "--json",
      "add",
      "glm",
      "--yes",
      "--base-url",
      `http://127.0.0.1:${port}`,
      "--model",
      "glm-test"
    ], {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        MENGMENG_HOME: temp,
        MENGMENG_CLAUDE_CONFIG: path.join(temp, "settings.json"),
        GLM_API_KEY: "glm-test-key"
      }
    });

    const profile = JSON.parse(stdout);
    assert.equal(profile.provider, "glm");
    assert.equal(profile.mode, "coding-plan");
    assert.equal(profile.baseUrl, `http://127.0.0.1:${port}`);
    assert.equal(profile.model.main, "glm-test");
    assert.equal(profile.modelSource, `http://127.0.0.1:${port}/v1/models`);
    assert.equal(profile.statusCache.success, true);
    assert.equal(requestedModels, true);
    assert.equal(JSON.parse(requestBody).model, "glm-test");

    const store = JSON.parse(fs.readFileSync(path.join(temp, "profiles.json"), "utf8"));
    assert.equal(store.profiles[0].provider, "glm");
    assert.equal(store.profiles[0].env.ENABLE_TOOL_SEARCH, "true");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("remove refuses active profile even with yes flag", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mengmeng-test-"));
  try {
    const now = "2026-06-14T00:00:00Z";
    fs.writeFileSync(path.join(temp, "config.json"), JSON.stringify({
      initialized: true,
      configDir: temp,
      claudeConfigPath: path.join(temp, "settings.json"),
      current: "glm",
      createdAt: now,
      updatedAt: now
    }));
    fs.writeFileSync(path.join(temp, "profiles.json"), JSON.stringify({
      version: 1,
      profiles: [
        { name: "glm", provider: "glm", mode: "coding-plan", model: { main: "glm-5.1" } },
        { name: "mimo", provider: "mimo", mode: "token-plan", model: { main: "mimo-v2.5-pro" } }
      ]
    }));

    await assert.rejects(
      execFileAsync(process.execPath, ["bin/mm.js", "remove", "glm", "--yes"], {
        cwd: path.resolve(__dirname, ".."),
        env: {
          ...process.env,
          MENGMENG_HOME: temp,
          MENGMENG_CLAUDE_CONFIG: path.join(temp, "settings.json")
        }
      }),
      (error) => {
        assert.match(error.stderr, /profile "glm" is active and cannot be removed/);
        assert.match(error.stderr, /mm use mimo/);
        return true;
      }
    );

    const config = JSON.parse(fs.readFileSync(path.join(temp, "config.json"), "utf8"));
    const store = JSON.parse(fs.readFileSync(path.join(temp, "profiles.json"), "utf8"));
    assert.equal(config.current, "glm");
    assert.deepEqual(store.profiles.map((profile) => profile.name), ["glm", "mimo"]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

function execFileAsync(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(file, args, opts, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
