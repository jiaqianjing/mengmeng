const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const {
  parseKimiModels,
  parseKimiQuota,
  parseKimiBalance,
  recommendMapping,
  mergeSettings,
  settingsForProfile,
  listStatus,
  formatProbeStatus,
  formatProfileStatus,
  detectStorageCandidates,
  normalizeProvider,
  formatUnsupportedProvider
} = require("../bin/mm.js");

const plainColor = {
  bold: (text) => text,
  active: (text) => text,
  green: (text) => text,
  cyan: (text) => text,
  yellow: (text) => text,
  red: (text) => text,
  gray: (text) => text
};

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


test("recommendMapping chooses the coding model", () => {
  const mapping = recommendMapping([
    { id: "kimi-lite", displayName: "Lite", contextLength: 1000 },
    { id: "kimi-for-coding", displayName: "K2.7 Code", contextLength: 262144 }
  ]);
  assert.equal(mapping.main, "kimi-for-coding");
  assert.equal(mapping.haiku, "kimi-for-coding");
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
