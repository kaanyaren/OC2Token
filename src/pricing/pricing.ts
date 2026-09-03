import type { UsageTotals } from "../domain/tokens.js";

/** Version of this pricing table. Bump on any rate/model change. */
export const PRICING_VERSION = 1;
/** ISO date the rates in this table were last verified against official sources. */
export const PRICING_AS_OF = "2026-09-02";

export interface ModelPricing {
  readonly input: number; // USD per 1M input tokens
  readonly output: number; // USD per 1M output tokens
  readonly reasoning: number; // USD per 1M reasoning tokens
  readonly cacheRead: number; // USD per 1M cacheRead tokens
  readonly cacheWrite: number; // USD per 1M cacheWrite tokens
}

// Per-model pricing per 1M tokens (USD) — updated 2026-09-02 from official sources:
// - OpenAI: openai.com/api/pricing, Azure, pricepertoken.com
// - Anthropic: anthropic.com/pricing, platform.claude.com
// - Google: ai.google.dev/gemini-api/docs/pricing
// - OpenCode Zen: opencode.ai/zen + opencode.ai/docs/zen + opencode.ai/docs/go (opencode/* at-cost, 2026-09-02)
// Unknown models return undefined (no generic fallback) per spec, except opencode/* which has explicit Zen pricing.

// OpenAI GPT-5 family
const PRICING_GPT5: ModelPricing = { input: 1.25, output: 10, reasoning: 10, cacheRead: 0.125, cacheWrite: 1.25 };
const PRICING_GPT5_MINI: ModelPricing = { input: 0.25, output: 2, reasoning: 2, cacheRead: 0.025, cacheWrite: 0.25 };
const PRICING_GPT5_NANO: ModelPricing = { input: 0.05, output: 0.40, reasoning: 0.40, cacheRead: 0.005, cacheWrite: 0.05 };
const PRICING_GPT51: ModelPricing = { input: 1.25, output: 10, reasoning: 10, cacheRead: 0.125, cacheWrite: 1.25 };
const PRICING_GPT52: ModelPricing = { input: 1.75, output: 14, reasoning: 14, cacheRead: 0.175, cacheWrite: 1.75 };
const PRICING_GPT53_CODEX: ModelPricing = { input: 1.75, output: 14, reasoning: 14, cacheRead: 0.175, cacheWrite: 1.75 };
const PRICING_GPT54: ModelPricing = { input: 2.5, output: 15, reasoning: 15, cacheRead: 0.25, cacheWrite: 3.125 };
const PRICING_GPT54_MINI: ModelPricing = { input: 0.75, output: 4.5, reasoning: 4.5, cacheRead: 0.075, cacheWrite: 0.9375 };
const PRICING_GPT54_NANO: ModelPricing = { input: 0.20, output: 1.25, reasoning: 1.25, cacheRead: 0.02, cacheWrite: 0.25 };
const PRICING_GPT55: ModelPricing = { input: 5, output: 30, reasoning: 30, cacheRead: 0.5, cacheWrite: 6.25 };
const PRICING_GPT55_PRO: ModelPricing = { input: 30, output: 180, reasoning: 180, cacheRead: 3, cacheWrite: 37.5 };
const PRICING_GPT56_SOL: ModelPricing = { input: 5, output: 30, reasoning: 30, cacheRead: 0.5, cacheWrite: 6.25 };
const PRICING_GPT56_TERRA: ModelPricing = { input: 2, output: 12, reasoning: 12, cacheRead: 0.2, cacheWrite: 2.5 };
const PRICING_GPT56_LUNA: ModelPricing = { input: 0.20, output: 1.20, reasoning: 1.20, cacheRead: 0.02, cacheWrite: 0.25 };
// Zen variants (opencode/* at-cost, slightly cheaper for GPT-5 family)
const PRICING_ZEN_GPT5: ModelPricing = { input: 1.07, output: 8.50, reasoning: 8.50, cacheRead: 0.107, cacheWrite: 1.07 };
const PRICING_ZEN_GPT51: ModelPricing = { input: 1.07, output: 8.50, reasoning: 8.50, cacheRead: 0.107, cacheWrite: 1.07 };
const PRICING_ZEN_GPT51_CODEX_MINI: ModelPricing = { input: 0.25, output: 2, reasoning: 2, cacheRead: 0.025, cacheWrite: 0.25 };

const PRICING_GPT4O: ModelPricing = { input: 2.5, output: 10, reasoning: 10, cacheRead: 1.25, cacheWrite: 2.5 };
const PRICING_GPT4O_MINI: ModelPricing = { input: 0.15, output: 0.60, reasoning: 0.60, cacheRead: 0.075, cacheWrite: 0.15 };
const PRICING_GPT41: ModelPricing = { input: 2.0, output: 8.0, reasoning: 8.0, cacheRead: 0.50, cacheWrite: 2.0 };
const PRICING_GPT41_MINI: ModelPricing = { input: 0.40, output: 1.60, reasoning: 1.60, cacheRead: 0.10, cacheWrite: 0.40 };
const PRICING_GPT41_NANO: ModelPricing = { input: 0.10, output: 0.40, reasoning: 0.40, cacheRead: 0.025, cacheWrite: 0.10 };
const PRICING_O1: ModelPricing = { input: 15, output: 60, reasoning: 60, cacheRead: 7.5, cacheWrite: 15 };
const PRICING_O1_MINI: ModelPricing = { input: 1.10, output: 4.40, reasoning: 4.40, cacheRead: 0.55, cacheWrite: 1.10 };
const PRICING_O3: ModelPricing = { input: 2.0, output: 8.0, reasoning: 8.0, cacheRead: 0.50, cacheWrite: 2.0 };
const PRICING_O3_MINI: ModelPricing = { input: 1.10, output: 4.40, reasoning: 4.40, cacheRead: 0.55, cacheWrite: 1.10 };
const PRICING_O4_MINI: ModelPricing = { input: 1.10, output: 4.40, reasoning: 4.40, cacheRead: 0.275, cacheWrite: 1.10 };

const PRICING_CLAUDE_SONNET: ModelPricing = { input: 3.0, output: 15, reasoning: 15, cacheRead: 0.30, cacheWrite: 3.75 };
const PRICING_CLAUDE_SONNET5: ModelPricing = { input: 2.0, output: 10, reasoning: 10, cacheRead: 0.20, cacheWrite: 2.50 };
const PRICING_CLAUDE_HAIKU: ModelPricing = { input: 0.80, output: 4.0, reasoning: 4.0, cacheRead: 0.08, cacheWrite: 1.0 };
const PRICING_CLAUDE_HAIKU45: ModelPricing = { input: 1.0, output: 5.0, reasoning: 5.0, cacheRead: 0.10, cacheWrite: 1.25 };
const PRICING_CLAUDE_OPUS: ModelPricing = { input: 15, output: 75, reasoning: 75, cacheRead: 1.50, cacheWrite: 18.75 };
const PRICING_CLAUDE_OPUS_45: ModelPricing = { input: 5.0, output: 25, reasoning: 25, cacheRead: 0.50, cacheWrite: 6.25 };
const PRICING_CLAUDE_FABLE: ModelPricing = { input: 10, output: 50, reasoning: 50, cacheRead: 1.0, cacheWrite: 12.50 };
const PRICING_CLAUDE_FABLE51: ModelPricing = { input: 10, output: 50, reasoning: 50, cacheRead: 0.25, cacheWrite: 12.50 };

const PRICING_GEMINI_25_PRO: ModelPricing = { input: 1.25, output: 10, reasoning: 10, cacheRead: 0.125, cacheWrite: 1.25 };
const PRICING_GEMINI_25_FLASH: ModelPricing = { input: 0.30, output: 2.50, reasoning: 2.50, cacheRead: 0.03, cacheWrite: 0.30 };
const PRICING_GEMINI_25_FLASH_LITE: ModelPricing = { input: 0.10, output: 0.40, reasoning: 0.40, cacheRead: 0.01, cacheWrite: 0.10 };
const PRICING_GEMINI_20_FLASH: ModelPricing = { input: 0.10, output: 0.40, reasoning: 0.40, cacheRead: 0.01, cacheWrite: 0.10 };
const PRICING_GEMINI_31_PRO: ModelPricing = { input: 2.0, output: 12, reasoning: 12, cacheRead: 0.20, cacheWrite: 2.0 };
const PRICING_GEMINI_31_FLASH_LITE: ModelPricing = { input: 0.25, output: 1.50, reasoning: 1.50, cacheRead: 0.025, cacheWrite: 0.25 };
const PRICING_GEMINI_35_FLASH: ModelPricing = { input: 1.50, output: 9.00, reasoning: 9.00, cacheRead: 0.15, cacheWrite: 1.50 };
const PRICING_GEMINI_35_FLASH_LITE: ModelPricing = { input: 0.30, output: 2.50, reasoning: 2.50, cacheRead: 0.03, cacheWrite: 0.30 };
const PRICING_GEMINI_36_FLASH: ModelPricing = { input: 0.75, output: 3.75, reasoning: 3.75, cacheRead: 0.075, cacheWrite: 0.75 };
const PRICING_GEMINI_37_FLASH: ModelPricing = { input: 0.75, output: 3.75, reasoning: 3.75, cacheRead: 0.075, cacheWrite: 0.75 };
const PRICING_GEMINI_15_PRO: ModelPricing = { input: 1.25, output: 5.0, reasoning: 5.0, cacheRead: 0.125, cacheWrite: 1.25 };

// Zen / Go open models (opencode/*) — at-cost from opencode.ai/zen
const PRICING_ZEN_MINIMAX_M25: ModelPricing = { input: 0.30, output: 1.20, reasoning: 1.20, cacheRead: 0.06, cacheWrite: 0.30 };
const PRICING_ZEN_MINIMAX_M3: ModelPricing = { input: 0.30, output: 1.20, reasoning: 1.20, cacheRead: 0.06, cacheWrite: 0.30 };
const PRICING_ZEN_GLM5: ModelPricing = { input: 1.0, output: 3.20, reasoning: 3.20, cacheRead: 0.20, cacheWrite: 1.0 };
const PRICING_ZEN_GLM51: ModelPricing = { input: 1.40, output: 4.40, reasoning: 4.40, cacheRead: 0.26, cacheWrite: 1.40 };
const PRICING_ZEN_GLM52: ModelPricing = { input: 1.40, output: 4.40, reasoning: 4.40, cacheRead: 0.26, cacheWrite: 1.40 };
const PRICING_ZEN_KIMI_K2_5: ModelPricing = { input: 0.60, output: 3.00, reasoning: 3.00, cacheRead: 0.10, cacheWrite: 0.60 };
const PRICING_ZEN_KIMI_K3: ModelPricing = { input: 3.00, output: 15.00, reasoning: 15.00, cacheRead: 0.30, cacheWrite: 3.00 };
const PRICING_ZEN_QWEN_37_MAX: ModelPricing = { input: 2.50, output: 7.50, reasoning: 7.50, cacheRead: 0.50, cacheWrite: 3.125 };
const PRICING_ZEN_DEEPSEEK_V4_PRO: ModelPricing = { input: 0.66, output: 1.98, reasoning: 1.98, cacheRead: 0.022, cacheWrite: 0.66 };
const PRICING_ZEN_DEEPSEEK_V4_FLASH: ModelPricing = { input: 0.22, output: 0.66, reasoning: 0.66, cacheRead: 0.007, cacheWrite: 0.22 };
const PRICING_ZEN_MIMO: ModelPricing = { input: 0.14, output: 0.28, reasoning: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 };
const PRICING_ZEN_MUSE_SPARK: ModelPricing = { input: 1.25, output: 4.25, reasoning: 4.25, cacheRead: 0.15, cacheWrite: 1.25 };

const PRICING_GEMINI_3_PRO = PRICING_GEMINI_31_PRO;
const PRICING_GEMINI_3_FLASH = PRICING_GEMINI_36_FLASH;

const EXACT_PRICING: Record<string, ModelPricing> = {
  "gpt-5": PRICING_GPT5,
  "gpt-5-mini": PRICING_GPT5_MINI,
  "gpt-5-nano": PRICING_GPT5_NANO,
  "openai/gpt-5": PRICING_GPT5,
  "openai/gpt-5-mini": PRICING_GPT5_MINI,
  "openai/gpt-5-nano": PRICING_GPT5_NANO,
  // Zen opencode/* variants (at-cost, cheaper)
  "opencode/gpt-5": PRICING_ZEN_GPT5,
  "opencode/gpt-5.1": PRICING_ZEN_GPT51,
  "opencode/gpt-5.1-codex": PRICING_ZEN_GPT51,
  "opencode/gpt-5.1-codex-mini": PRICING_ZEN_GPT51_CODEX_MINI,
  "opencode/gpt-5.1-codex-max": PRICING_ZEN_GPT5,
  "opencode/gpt-5-codex": PRICING_ZEN_GPT5,
  "opencode/gpt-5-nano": PRICING_GPT5_NANO,
  "opencode/gpt-5-mini": PRICING_GPT5_MINI,
  "gpt-5.1": PRICING_GPT51,
  "openai/gpt-5.1": PRICING_GPT51,
  "gpt-5.2": PRICING_GPT52,
  "openai/gpt-5.2": PRICING_GPT52,
  "gpt-5.3-codex": PRICING_GPT53_CODEX,
  "openai/gpt-5.3-codex": PRICING_GPT53_CODEX,
  "opencode/gpt-5.2": PRICING_GPT52,
  "opencode/gpt-5.3-codex": PRICING_GPT53_CODEX,
  "gpt-5.4": PRICING_GPT54,
  "openai/gpt-5.4": PRICING_GPT54,
  "gpt-5.4-mini": PRICING_GPT54_MINI,
  "openai/gpt-5.4-mini": PRICING_GPT54_MINI,
  "gpt-5.4-nano": PRICING_GPT54_NANO,
  "openai/gpt-5.4-nano": PRICING_GPT54_NANO,
  "opencode/gpt-5.4": PRICING_GPT54,
  "opencode/gpt-5.4-mini": PRICING_GPT54_MINI,
  "gpt-5.5": PRICING_GPT55,
  "openai/gpt-5.5": PRICING_GPT55,
  "gpt-5.5-pro": PRICING_GPT55_PRO,
  "openai/gpt-5.5-pro": PRICING_GPT55_PRO,
  "opencode/gpt-5.5": PRICING_GPT55,
  "gpt-5.6-sol": PRICING_GPT56_SOL,
  "gpt-5.6-terra": PRICING_GPT56_TERRA,
  "gpt-5.6-luna": PRICING_GPT56_LUNA,
  "openai/gpt-5.6-sol": PRICING_GPT56_SOL,
  "openai/gpt-5.6-terra": PRICING_GPT56_TERRA,
  "openai/gpt-5.6-luna": PRICING_GPT56_LUNA,
  "opencode/gpt-5.6-sol": PRICING_GPT56_SOL,
  "opencode/gpt-5.6-terra": PRICING_GPT56_TERRA,
  "opencode/gpt-5.6-luna": PRICING_GPT56_LUNA,
  "gpt-4o": PRICING_GPT4O,
  "gpt-4o-mini": PRICING_GPT4O_MINI,
  "openai/gpt-4o": PRICING_GPT4O,
  "openai/gpt-4o-mini": PRICING_GPT4O_MINI,
  "opencode/gpt-4o": PRICING_GPT4O,
  "opencode/gpt-4o-mini": PRICING_GPT4O_MINI,
  "gpt-4.1": PRICING_GPT41,
  "gpt-4.1-mini": PRICING_GPT41_MINI,
  "gpt-4.1-nano": PRICING_GPT41_NANO,
  "openai/gpt-4.1": PRICING_GPT41,
  "openai/gpt-4.1-mini": PRICING_GPT41_MINI,
  "opencode/gpt-4.1": PRICING_GPT41,
  "o1": PRICING_O1,
  "o1-mini": PRICING_O1_MINI,
  "o3": PRICING_O3,
  "o3-mini": PRICING_O3_MINI,
  "o4-mini": PRICING_O4_MINI,
  "openai/o1": PRICING_O1,
  "openai/o1-mini": PRICING_O1_MINI,
  "openai/o3": PRICING_O3,
  "openai/o3-mini": PRICING_O3_MINI,
  "openai/o4-mini": PRICING_O4_MINI,
  "opencode/o1": PRICING_O1,
  "opencode/o3": PRICING_O3,
  "claude-3-5-sonnet": PRICING_CLAUDE_SONNET,
  "claude-3.5-sonnet": PRICING_CLAUDE_SONNET,
  "claude-sonnet-4": PRICING_CLAUDE_SONNET,
  "claude-sonnet-4.5": PRICING_CLAUDE_SONNET,
  "claude-sonnet-4.6": PRICING_CLAUDE_SONNET,
  "claude-sonnet-5": PRICING_CLAUDE_SONNET5,
  "claude-3-5-haiku": PRICING_CLAUDE_HAIKU,
  "claude-haiku": PRICING_CLAUDE_HAIKU,
  "claude-haiku-3.5": PRICING_CLAUDE_HAIKU,
  "claude-haiku-4.5": PRICING_CLAUDE_HAIKU45,
  "claude-opus": PRICING_CLAUDE_OPUS,
  "claude-opus-4": PRICING_CLAUDE_OPUS,
  "claude-opus-4.1": PRICING_CLAUDE_OPUS,
  "claude-opus-4.5": PRICING_CLAUDE_OPUS_45,
  "claude-opus-4.6": PRICING_CLAUDE_OPUS_45,
  "claude-opus-4.7": PRICING_CLAUDE_OPUS_45,
  "claude-opus-4.8": PRICING_CLAUDE_OPUS_45,
  "claude-opus-5": PRICING_CLAUDE_OPUS_45,
  "claude-fable-5": PRICING_CLAUDE_FABLE,
  "claude-fable-5.1": PRICING_CLAUDE_FABLE51,
  "anthropic/claude-3-5-sonnet": PRICING_CLAUDE_SONNET,
  "anthropic/claude-sonnet-4": PRICING_CLAUDE_SONNET,
  "anthropic/claude-sonnet-5": PRICING_CLAUDE_SONNET5,
  "anthropic/claude-haiku": PRICING_CLAUDE_HAIKU,
  "anthropic/claude-haiku-4.5": PRICING_CLAUDE_HAIKU45,
  "anthropic/claude-opus-4": PRICING_CLAUDE_OPUS,
  "anthropic/claude-opus-5": PRICING_CLAUDE_OPUS_45,
  "anthropic/claude-fable-5": PRICING_CLAUDE_FABLE,
  "anthropic/claude-fable-5.1": PRICING_CLAUDE_FABLE51,
  "opencode/claude-sonnet-4": PRICING_CLAUDE_SONNET,
  "opencode/claude-sonnet-5": PRICING_CLAUDE_SONNET5,
  "opencode/claude-haiku-4.5": PRICING_CLAUDE_HAIKU45,
  "opencode/claude-opus-5": PRICING_CLAUDE_OPUS_45,
  "opencode/claude-fable-5": PRICING_CLAUDE_FABLE,
  "opencode/claude-fable-5.1": PRICING_CLAUDE_FABLE51,
  "gemini-2.5-pro": PRICING_GEMINI_25_PRO,
  "gemini-2.5-flash": PRICING_GEMINI_25_FLASH,
  "gemini-2.5-flash-lite": PRICING_GEMINI_25_FLASH_LITE,
  "gemini-2.0-flash": PRICING_GEMINI_20_FLASH,
  "gemini-3-pro": PRICING_GEMINI_31_PRO,
  "gemini-3.1-pro": PRICING_GEMINI_31_PRO,
  "gemini-3.1-pro-preview": PRICING_GEMINI_31_PRO,
  "gemini-3-flash": PRICING_GEMINI_36_FLASH,
  "gemini-3.5-flash": PRICING_GEMINI_35_FLASH,
  "gemini-3.5-flash-lite": PRICING_GEMINI_35_FLASH_LITE,
  "gemini-3.6-flash": PRICING_GEMINI_36_FLASH,
  "gemini-3.7-flash": PRICING_GEMINI_37_FLASH,
  "gemini-3.1-flash-lite": PRICING_GEMINI_31_FLASH_LITE,
  "gemini-1.5-pro": PRICING_GEMINI_15_PRO,
  "google/gemini-2.5-pro": PRICING_GEMINI_25_PRO,
  "opencode/gemini-2.5-pro": PRICING_GEMINI_25_PRO,
  "opencode/gemini-3.1-pro": PRICING_GEMINI_31_PRO,
  "opencode/gemini-3.5-flash": PRICING_GEMINI_35_FLASH,
  "opencode/gemini-3.7-flash": PRICING_GEMINI_37_FLASH,
  // Go models (opencode-go/*)
  "opencode-go/kimi-k2.5": PRICING_ZEN_KIMI_K2_5,
  "opencode-go/kimi-k3": PRICING_ZEN_KIMI_K3,
  "opencode-go/qwen3.7-max": PRICING_ZEN_QWEN_37_MAX,
  "opencode-go/qwen3.8-max": PRICING_ZEN_QWEN_37_MAX,
  "opencode-go/deepseek-v4-pro": PRICING_ZEN_DEEPSEEK_V4_PRO,
  "opencode-go/deepseek-v4-flash": PRICING_ZEN_DEEPSEEK_V4_FLASH,
  "opencode-go/minimax-m2.5": PRICING_ZEN_MINIMAX_M25,
  "opencode-go/minimax-m3": PRICING_ZEN_MINIMAX_M3,
  "opencode-go/mimo-v2.5": PRICING_ZEN_MIMO,
  "opencode-go/muse-spark-1.2": PRICING_ZEN_MUSE_SPARK,
  "opencode/go/kimi-k2.5": PRICING_ZEN_KIMI_K2_5,
  // Zen open models (opencode/*)
  "opencode/minimax-m2.5": PRICING_ZEN_MINIMAX_M25,
  "opencode/minimax-m3": PRICING_ZEN_MINIMAX_M3,
  "opencode/glm-5": PRICING_ZEN_GLM5,
  "opencode/glm-5.1": PRICING_ZEN_GLM51,
  "opencode/glm-5.2": PRICING_ZEN_GLM52,
  "opencode/glm-5.3": PRICING_ZEN_GLM52,
  "opencode/kimi-k2.5": PRICING_ZEN_KIMI_K2_5,
  "opencode/kimi-k3": PRICING_ZEN_KIMI_K3,
  "opencode/kimi-k2.6": PRICING_ZEN_KIMI_K3,
  "opencode/qwen3.7-max": PRICING_ZEN_QWEN_37_MAX,
  "opencode/qwen3.8-max": PRICING_ZEN_QWEN_37_MAX,
  "opencode/deepseek-v4-pro": PRICING_ZEN_DEEPSEEK_V4_PRO,
  "opencode/deepseek-v4-flash": PRICING_ZEN_DEEPSEEK_V4_FLASH,
  "opencode/mimo-v2.5": PRICING_ZEN_MIMO,
  "opencode/muse-spark-1.2": PRICING_ZEN_MUSE_SPARK,
  "opencode/qwen3.7-plus": PRICING_ZEN_QWEN_37_MAX,
  // Provider-level aliases
  "openai": PRICING_GPT5,
  "anthropic": PRICING_CLAUDE_SONNET5,
  "google": PRICING_GEMINI_25_PRO,
  "opencode": PRICING_ZEN_GPT5,
  "codex": PRICING_GPT5,
  "antigravity": PRICING_GEMINI_25_PRO,
};

function stripPricingSuffix(value: string): string {
  return value.replace(/-(high|medium|low|agent)$/i, "");
}

function normalizeForLookup(value: string): string {
  const lower = value.toLowerCase().trim();
  const stripped = stripPricingSuffix(lower);
  return stripped;
}

export interface PricingResolution {
  readonly pricing: ModelPricing | undefined;
  /**
   * True when the match came from fuzzy substring heuristics rather than the
   * exact table. Fuzzy costs are approximate — callers displaying them should
   * mark the figure estimated.
   */
  readonly estimated: boolean;
}

/**
 * Token-boundary match for short model tokens ("o1"/"o3"/...). A bare
 * includes() over-matches ("foo1" contains "o1" but is not OpenAI o1), so
 * short tokens must sit on a non-alphanumeric boundary on both sides.
 */
function hasToken(value: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(value);
}

export function resolvePricing(model: string): PricingResolution {
  if (typeof model !== "string" || model.trim().length === 0) {
    return { pricing: undefined, estimated: false };
  }
  // Exact table first — never let a fuzzy heuristic shadow a pinned rate.
  const normalized = normalizeForLookup(model);
  const direct = EXACT_PRICING[normalized];
  if (direct !== undefined) return { pricing: direct, estimated: false };
  const withoutProvider = normalized.includes("/") ? normalized.split("/").pop()! : normalized;
  const withoutProviderExact = EXACT_PRICING[withoutProvider];
  if (withoutProviderExact !== undefined) return { pricing: withoutProviderExact, estimated: false };
  const base = withoutProvider.split("-20")[0] ?? withoutProvider;
  if (EXACT_PRICING[base] !== undefined) return { pricing: EXACT_PRICING[base], estimated: false };

  const fuzzy = fuzzyPricingFor(normalized);
  if (fuzzy !== undefined) return { pricing: fuzzy, estimated: true };
  return { pricing: undefined, estimated: false };
}

export function pricingForModel(model: string): ModelPricing | undefined {
  return resolvePricing(model).pricing;
}

function fuzzyPricingFor(m: string): ModelPricing | undefined {

  if (m.includes("gpt-5.6")) {
    if (m.includes("luna")) return PRICING_GPT56_LUNA;
    if (m.includes("terra")) return PRICING_GPT56_TERRA;
    if (m.includes("sol")) return PRICING_GPT56_SOL;
    if (m.includes("nano")) return PRICING_GPT54_NANO;
    if (m.includes("mini")) return PRICING_GPT54_MINI;
    return PRICING_GPT56_SOL;
  }
  if (m.includes("gpt-5.5")) {
    if (m.includes("pro")) return PRICING_GPT55_PRO;
    return PRICING_GPT55;
  }
  if (m.includes("gpt-5.4")) {
    if (m.includes("nano")) return PRICING_GPT54_NANO;
    if (m.includes("mini")) return PRICING_GPT54_MINI;
    return PRICING_GPT54;
  }
  if (m.includes("gpt-5.3") || m.includes("gpt-5.2")) {
    if (m.includes("pro")) return PRICING_GPT52;
    return PRICING_GPT52;
  }
  if (m.includes("gpt-5.1")) return PRICING_GPT51;
  if (m.includes("gpt-5")) {
    if (m.includes("nano")) return PRICING_GPT5_NANO;
    if (m.includes("mini")) return PRICING_GPT5_MINI;
    return PRICING_GPT5;
  }
  if (m.includes("gpt-4o-mini")) return PRICING_GPT4O_MINI;
  if (m.includes("gpt-4o")) return PRICING_GPT4O;
  if (m.includes("gpt-4.1-nano")) return PRICING_GPT41_NANO;
  if (m.includes("gpt-4.1-mini")) return PRICING_GPT41_MINI;
  if (m.includes("gpt-4.1")) return PRICING_GPT41;
  if (hasToken(m, "o4-mini")) return PRICING_O4_MINI;
  if (hasToken(m, "o3-mini")) return PRICING_O3_MINI;
  if (hasToken(m, "o3")) return PRICING_O3;
  if (hasToken(m, "o1-mini")) return PRICING_O1_MINI;
  if (hasToken(m, "o1")) return PRICING_O1;

  if (m.includes("fable")) {
    if (m.includes("5.1")) return PRICING_CLAUDE_FABLE51;
    return PRICING_CLAUDE_FABLE;
  }
  if (m.includes("claude")) {
    if (m.includes("opus")) {
      if (m.includes("4.1")) return PRICING_CLAUDE_OPUS;
      return PRICING_CLAUDE_OPUS_45;
    }
    if (m.includes("haiku")) {
      if (m.includes("4.5")) return PRICING_CLAUDE_HAIKU45;
      return PRICING_CLAUDE_HAIKU;
    }
    if (m.includes("sonnet")) {
      if (m.includes("5")) return PRICING_CLAUDE_SONNET5;
      return PRICING_CLAUDE_SONNET;
    }
    return PRICING_CLAUDE_SONNET5;
  }
  if (m.includes("minimax")) return PRICING_ZEN_MINIMAX_M25;
  if (m.includes("glm-5")) return PRICING_ZEN_GLM5;
  if (m.includes("glm")) return PRICING_ZEN_GLM52;
  if (m.includes("kimi")) {
    if (m.includes("k3")) return PRICING_ZEN_KIMI_K3;
    return PRICING_ZEN_KIMI_K2_5;
  }
  if (m.includes("qwen")) {
    if (m.includes("3.8") || m.includes("3.7")) return PRICING_ZEN_QWEN_37_MAX;
    return PRICING_ZEN_QWEN_37_MAX;
  }
  if (m.includes("deepseek")) {
    if (m.includes("flash")) return PRICING_ZEN_DEEPSEEK_V4_FLASH;
    return PRICING_ZEN_DEEPSEEK_V4_PRO;
  }
  if (m.includes("mimo")) return PRICING_ZEN_MIMO;
  if (m.includes("muse") && m.includes("spark")) return PRICING_ZEN_MUSE_SPARK;

  if (m.includes("gemini")) {
    if (m.includes("3.7")) return PRICING_GEMINI_37_FLASH;
    if (m.includes("3.6")) return PRICING_GEMINI_36_FLASH;
    if (m.includes("3.5")) {
      if (m.includes("lite")) return PRICING_GEMINI_35_FLASH_LITE;
      return PRICING_GEMINI_35_FLASH;
    }
    if (m.includes("3.1")) {
      if (m.includes("lite")) return PRICING_GEMINI_31_FLASH_LITE;
      if (m.includes("pro")) return PRICING_GEMINI_31_PRO;
      return PRICING_GEMINI_31_PRO;
    }
    if (m.includes("flash")) {
      if (m.includes("lite")) {
        if (m.includes("2.5")) return PRICING_GEMINI_25_FLASH_LITE;
        if (m.includes("2.0") || m.includes("2-0")) return PRICING_GEMINI_20_FLASH;
        return PRICING_GEMINI_25_FLASH_LITE;
      }
      if (m.includes("2.0") || m.includes("2-0")) return PRICING_GEMINI_20_FLASH;
      if (m.includes("3")) return PRICING_GEMINI_36_FLASH;
      return PRICING_GEMINI_25_FLASH;
    }
    if (m.includes("pro")) {
      if (m.includes("3")) return PRICING_GEMINI_31_PRO;
      if (m.includes("2.5") || m.includes("2-5")) return PRICING_GEMINI_25_PRO;
      return PRICING_GEMINI_15_PRO;
    }
    return PRICING_GEMINI_25_FLASH;
  }

  return undefined;
}

export function costForTokens(totals: UsageTotals, pricing: ModelPricing): number {
  const inputCost = (totals.input * pricing.input) / 1_000_000;
  const outputCost = (totals.output * pricing.output) / 1_000_000;
  const reasoningCost = (totals.reasoning * pricing.reasoning) / 1_000_000;
  const cacheReadCost = (totals.cacheRead * pricing.cacheRead) / 1_000_000;
  const cacheWriteCost = (totals.cacheWrite * pricing.cacheWrite) / 1_000_000;
  const total = inputCost + outputCost + reasoningCost + cacheReadCost + cacheWriteCost;
  return Math.round(total * 1_000_000) / 1_000_000;
}

export function estimatedCost(totals: UsageTotals, model: string): number | undefined {
  const pricing = pricingForModel(model);
  if (pricing === undefined) return undefined;
  return costForTokens(totals, pricing);
}

export interface BreakdownCostEstimate {
  /** Partial sum over the priced breakdowns (unknown models contribute 0). */
  readonly cost: number;
  /**
   * True only when every model resolved via the exact table (no unknown, no
   * fuzzy). False means the cost is partial/approximate — check
   * unknownModels/estimatedModels for why.
   */
  readonly complete: boolean;
  readonly unknownModels: readonly string[];
  readonly estimatedModels: readonly string[];
}

export function estimateCostForBreakdownsDetailed(
  breakdowns: ReadonlyArray<{ readonly name: string; readonly totals: UsageTotals }>,
): BreakdownCostEstimate {
  let total = 0;
  const unknownModels: string[] = [];
  const estimatedModels: string[] = [];
  for (const item of breakdowns) {
    const resolution = resolvePricing(item.name);
    if (resolution.pricing === undefined) {
      unknownModels.push(item.name);
      continue;
    }
    if (resolution.estimated) {
      estimatedModels.push(item.name);
    }
    total += costForTokens(item.totals, resolution.pricing);
  }
  return {
    cost: Math.round(total * 1_000_000) / 1_000_000,
    complete: unknownModels.length === 0 && estimatedModels.length === 0,
    unknownModels,
    estimatedModels,
  };
}

export function estimatedCostForBreakdowns(
  breakdowns: ReadonlyArray<{ readonly name: string; readonly totals: UsageTotals }>,
  strict = true,
): number | undefined {
  // NOTE: `strict` is deprecated and ignored. It used to return undefined for
  // the whole window when a single model was unknown ("poisoning" valid
  // partial costs). Both modes now return the partial sum; callers that need
  // the indicator must use estimateCostForBreakdownsDetailed and inspect
  // complete/unknownModels/estimatedModels. Undefined is returned only when
  // nothing could be priced at all (non-empty input, zero known models).
  void strict;
  const detailed = estimateCostForBreakdownsDetailed(breakdowns);
  const priced = breakdowns.length - detailed.unknownModels.length;
  if (breakdowns.length > 0 && priced === 0) {
    return undefined;
  }
  return detailed.cost;
}

export function estimatedCostForBreakdownsPartial(
  breakdowns: ReadonlyArray<{ readonly name: string; readonly totals: UsageTotals }>
): number {
  return estimateCostForBreakdownsDetailed(breakdowns).cost;
}

