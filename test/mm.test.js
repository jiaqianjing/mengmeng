const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseKimiModels,
  parseKimiQuota,
  recommendMapping,
  mergeSettings,
  detectStorageCandidates,
  normalizeProvider,
  formatUnsupportedProvider
} = require("../bin/mm.js");

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
