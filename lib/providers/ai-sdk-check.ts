/**
 * 统一的 AI SDK 健康检查模块
 *
 * 本模块使用 Vercel AI SDK 统一处理多种 AI Provider 的健康检查，包括：
 * - OpenAI (支持标准 Chat Completions API 和 Responses API)
 * - Anthropic (Claude 系列模型)
 * - Gemini (通过 OpenAI 兼容模式)
 *
 * 核心功能：
 * 1. 自动识别并配置不同 Provider 的 SDK 实例
 * 2. 支持推理模型的 reasoning_effort 参数配置
 * 3. 流式响应处理，快速获取首个响应
 * 4. 数学挑战验证，确保模型真正可用
 * 5. 延迟测量和状态判定
 */

import { streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import type { CheckResult, HealthStatus, ProviderConfig } from "../types";
import { DEFAULT_ENDPOINTS } from "../types";
import { generateChallenge, validateResponse } from "./challenge";
import { measureEndpointPing } from "./endpoint-ping";

/**
 * 默认超时时间 (毫秒)
 * 设置为 45 秒，考虑到部分模型首次响应可能较慢
 */
const DEFAULT_TIMEOUT_MS = 45_000;

/**
 * 性能降级阈值 (毫秒)
 * 超过此阈值的响应将被标记为 "degraded" 状态
 */
const DEGRADED_THRESHOLD_MS = 6_000;

/**
 * 需要完全排除的字段集合
 * 这些字段会与 streamText 内部参数冲突，必须过滤掉
 */
const EXCLUDED_KEYS = new Set(["model", "prompt", "messages", "abortSignal"]);

/**
 * URL 路径清理正则表达式
 * 用于从完整端点中提取 baseURL
 */
const PATH_CLEANUP_REGEX = /\/(chat\/completions|responses|messages)\/?$/;

/**
 * 从完整的 endpoint URL 中提取 baseURL
 *
 * AI SDK 需要的是 baseURL（如 https://api.openai.com/v1），
 * 而用户配置的往往是完整的 endpoint（如 https://api.openai.com/v1/chat/completions）。
 * 此函数负责将完整 endpoint 转换为 SDK 所需的 baseURL。
 *
 * @param endpoint - 完整的 API 端点 URL
 * @returns 提取后的 baseURL
 *
 * @example
 * deriveBaseURL("https://api.openai.com/v1/chat/completions")
 * // => "https://api.openai.com/v1"
 */
function deriveBaseURL(endpoint: string): string {
  // 移除查询参数并清理 API 路径后缀
  const [withoutQuery] = endpoint.split("?");
  return withoutQuery.replace(PATH_CLEANUP_REGEX, "");
}

/**
 * 检查端点是否为 OpenAI Responses API
 *
 * OpenAI 提供两种 API：
 * - Chat Completions API (/v1/chat/completions) - 传统对话 API
 * - Responses API (/v1/responses) - 新版 API，支持更多功能
 *
 * 两种 API 的调用方式不同，需要区分处理。
 *
 * @param endpoint - API 端点 URL
 * @returns 是否为 Responses API 端点
 */
function isResponsesEndpoint(endpoint: string | null | undefined): boolean {
  if (!endpoint) return false;
  // 移除查询参数后检查路径是否以 /responses 结尾
  const [withoutQuery] = endpoint.split("?");
  return /\/responses\/?$/.test(withoutQuery);
}

/**
 * 推理强度级别类型
 *
 * 用于 OpenAI 推理模型（如 o1、o3 系列）的 reasoning_effort 参数。
 * - low: 快速推理，消耗较少 token
 * - medium: 平衡模式（推理模型默认值）
 * - high: 深度推理，消耗较多 token 但结果更准确
 */
type ReasoningEffort = "low" | "medium" | "high";

/**
 * 推理强度别名映射表
 *
 * 支持多种别名以提高配置灵活性：
 * - mini/minimal → low
 * - medium → medium
 * - high → high
 */
const EFFORT_ALIAS_MAP: Record<string, ReasoningEffort> = {
  mini: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
};

/**
 * 推理模型识别正则表达式列表
 *
 * 用于自动识别推理模型，为其设置默认的 reasoning_effort。
 * 匹配的模型包括：
 * - OpenAI o1/o3 系列
 * - GPT-5 系列（预留）
 * - Codex 系列
 * - DeepSeek R1
 * - 通义千问 QwQ
 */
const REASONING_MODEL_HINTS = [
  /codex/i, // OpenAI Codex 系列
  /\bgpt-5/i, // GPT-5 系列（预留）
  /\bo[1-9](?:-|$)/i, // OpenAI o1/o3 等推理模型（后跟 - 或结尾）
  /\bdeepseek-r1/i, // DeepSeek R1 推理模型
  /\bqwq/i, // 通义千问 QwQ 推理模型
];

/**
 * 解析模型名称中的推理强度指令
 *
 * 支持在模型名称后使用 @ 或 # 符号指定推理强度：
 * - "o1@high" → 使用 high 推理强度
 * - "o1#low" → 使用 low 推理强度
 * - "o1" → 推理模型默认使用 medium
 *
 * @param model - 原始模型名称（可能包含指令后缀）
 * @returns 解析结果，包含实际模型 ID 和可选的推理强度
 *
 * @example
 * parseModelDirective("o1@high")
 * // => { modelId: "o1", reasoningEffort: "high" }
 *
 * @example
 * parseModelDirective("gpt-4o")
 * // => { modelId: "gpt-4o" }  // 非推理模型，无 reasoningEffort
 *
 * @example
 * parseModelDirective("o1")
 * // => { modelId: "o1", reasoningEffort: "medium" }  // 推理模型默认 medium
 */
function parseModelDirective(model: string): {
  modelId: string;
  reasoningEffort?: ReasoningEffort;
} {
  const trimmed = model.trim();
  if (!trimmed) return { modelId: model };

  // 尝试匹配 @directive 或 #directive 后缀
  // 例如: "o1@high" 或 "o1#medium"
  const match = trimmed.match(/^(.*?)[@#](mini|minimal|low|medium|high)$/i);
  if (match) {
    const [, base, effortRaw] = match;
    return {
      modelId: base.trim() || trimmed,
      reasoningEffort: EFFORT_ALIAS_MAP[effortRaw.toLowerCase()],
    };
  }

  // 对于推理模型，即使没有显式指定也使用默认的 medium
  if (REASONING_MODEL_HINTS.some((regex) => regex.test(trimmed))) {
    return { modelId: trimmed, reasoningEffort: "medium" };
  }

  // 普通模型不需要 reasoningEffort
  return { modelId: trimmed };
}

/**
 * 过滤 metadata 中与 SDK 冲突的字段
 */
function filterMetadata(
  metadata: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!metadata) return null;

  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!EXCLUDED_KEYS.has(key)) {
      filtered[key] = value;
    }
  }
  return Object.keys(filtered).length > 0 ? filtered : null;
}

/**
 * 创建自定义 fetch 函数
 *
 * 拦截 SDK 请求以注入 metadata 到请求体并覆盖请求头
 */
function createCustomFetch(
  metadata: Record<string, unknown> | null,
  headers: Record<string, string>
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    // 非 POST 请求直接透传
    if (init?.method?.toUpperCase() !== "POST" || !init.body) {
      return fetch(input, { ...init, headers: { ...init?.headers as Record<string, string>, ...headers } });
    }

    try {
      const originalBody =
        typeof init.body === "string" ? JSON.parse(init.body) : init.body;
      const mergedBody = metadata ? { ...originalBody, ...metadata } : originalBody;

      return fetch(input, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), ...headers },
        body: JSON.stringify(mergedBody),
      });
    } catch {
      // JSON 解析失败时，仍然注入 headers
      return fetch(input, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), ...headers },
      });
    }
  };
}

/**
 * 创建 AI SDK 模型实例
 *
 * 根据配置中的 Provider 类型创建对应的 AI SDK 模型实例。
 * 支持的 Provider 类型：
 * - openai: 使用 @ai-sdk/openai，支持 Chat Completions 和 Responses API
 * - anthropic: 使用 @ai-sdk/anthropic
 * - gemini: 使用 @ai-sdk/openai-compatible（OpenAI 兼容模式）
 *
 * 通过自定义 fetch 函数注入 metadata 参数到请求体中。
 *
 * @param config - Provider 配置，包含类型、API Key、端点等信息
 * @returns 包含模型实例、推理强度和 API 类型标识的对象
 * @throws 当 Provider 类型不支持时抛出错误
 */
function createModel(config: ProviderConfig) {
  // 获取端点 URL，优先使用配置中的端点，否则使用默认端点
  const endpoint = config.endpoint || DEFAULT_ENDPOINTS[config.type];
  // 从完整端点 URL 中提取 SDK 所需的 baseURL
  const baseURL = deriveBaseURL(endpoint);
  // 解析模型名称，提取可能的推理强度指令
  const { modelId, reasoningEffort } = parseModelDirective(config.model);

  // 构建请求头和自定义 fetch
  const headers: Record<string, string> = {
    "User-Agent": "check-cx/0.1.0",
    ...config.requestHeaders,
  };
  const filteredMetadata = filterMetadata(config.metadata);
  const customFetch = createCustomFetch(filteredMetadata, headers);

  switch (config.type) {
    case "openai": {
      const provider = createOpenAI({
        apiKey: config.apiKey,
        baseURL,
        fetch: customFetch,
      });

      // 根据端点类型选择不同的 API 调用方式
      if (isResponsesEndpoint(config.endpoint)) {
        // Responses API - 使用 provider.responses() 方法
        return {
          model: provider.responses(modelId),
          reasoningEffort,
          isResponses: true,
        };
      }

      // Chat Completions API - 直接调用 provider()
      return {
        model: provider(modelId),
        reasoningEffort,
        isResponses: false,
      };
    }

    case "anthropic": {
      const provider = createAnthropic({
        apiKey: config.apiKey,
        baseURL,
        fetch: customFetch,
      });
      // Anthropic 不支持 reasoning_effort 参数
      return {
        model: provider(modelId),
        reasoningEffort: undefined,
        isResponses: false,
      };
    }

    case "gemini": {
      const provider = createOpenAICompatible({
        name: "gemini",
        apiKey: config.apiKey,
        baseURL,
        fetch: customFetch,
      });
      // Gemini 不支持 reasoning_effort 参数
      return {
        model: provider(modelId),
        reasoningEffort: undefined,
        isResponses: false,
      };
    }

    default:
      // 不支持的 Provider 类型
      throw new Error(`Unsupported provider type: ${config.type}`);
  }
}

/**
 * 判断错误是否为超时错误
 *
 * 超时错误的判断依据：
 * 1. 错误名称为 "AbortError"（AbortController 触发的中止）
 * 2. 错误消息包含 "request was aborted"
 * 3. 错误消息包含 "timeout"
 *
 * @param error - 捕获的错误对象
 * @returns 是否为超时错误
 */
function isTimeoutError(error: Error & { name?: string }): boolean {
  if (!error) return false;
  // AbortController.abort() 触发的错误
  if (error.name === "AbortError") return true;
  // 请求被中止的错误消息
  if (/request was aborted/i.test(error.message || "")) return true;
  // 包含 timeout 关键词的错误消息
  if (/timeout/i.test(error.message || "")) return true;
  return false;
}

/**
 * AI SDK APICallError 类型
 */
interface AIApiCallError extends Error {
  statusCode?: number;
  responseBody?: string;
}

/**
 * 从 responseBody 中提取错误消息
 */
function extractMessageFromBody(body: string): string | null {
  // 尝试解析 SSE 格式: data:{"message":"xxx"}
  const match = body.match(/"message"\s*:\s*"([^"]+)"/);
  return match?.[1] ?? null;
}

/**
 * 从错误对象中提取用户友好的错误消息
 *
 * AI SDK 的 APICallError 包含：statusCode、responseBody、message
 */
function getErrorMessage(error: AIApiCallError): string {
  if (isTimeoutError(error)) return "请求超时";

  // 优先从 responseBody 提取详细信息
  if (error.responseBody) {
    const extracted = extractMessageFromBody(error.responseBody);
    if (extracted) {
      return error.statusCode ? `[${error.statusCode}] ${extracted}` : extracted;
    }
  }

  // 回退到基础 message
  if (error.message) {
    return error.statusCode ? `[${error.statusCode}] ${error.message}` : error.message;
  }

  return "未知错误";
}

/**
 * 检查结果构建器的基础参数
 */
interface ResultBuilderBase {
  config: ProviderConfig;
  endpoint: string;
  pingLatencyMs: number | null;
}

/**
 * 构建检查结果对象
 *
 * 统一的结果构建函数，避免重复代码
 *
 * @param base - 基础参数（config、endpoint、pingLatencyMs）
 * @param status - 健康状态
 * @param latencyMs - 请求延迟（失败时为 null）
 * @param message - 状态消息
 * @returns 完整的检查结果对象
 */
function buildCheckResult(
  base: ResultBuilderBase,
  status: HealthStatus | "validation_failed" | "failed" | "error",
  latencyMs: number | null,
  message: string
): CheckResult {
  return {
    id: base.config.id,
    name: base.config.name,
    type: base.config.type,
    endpoint: base.endpoint,
    model: base.config.model,
    status,
    latencyMs,
    pingLatencyMs: base.pingLatencyMs,
    checkedAt: new Date().toISOString(),
    message,
  };
}

/**
 * 打印调试日志
 */
function logCheckResult(
  config: ProviderConfig,
  prompt: string,
  response: string,
  expectedAnswer: string,
  isValid: boolean | null
): void {
  const validStatus =
    isValid === null ? "失败(空回复)" : isValid ? "通过" : "失败";
  console.log(
    `[${config.type}] ${config.groupName || "默认"} | ${config.name} | Q: ${prompt.replace(/\r?\n/g, ' ')} | A: ${response || "(空)"} | 期望: ${expectedAnswer} | 验证: ${validStatus}`
  );
}

/**
 * 统一的 AI Provider 健康检查函数
 *
 * 健康状态判定规则：
 * - operational: 请求成功且延迟 ≤ 6000ms
 * - degraded: 请求成功但延迟 > 6000ms
 * - validation_failed: 收到回复但答案验证失败
 * - failed: 请求失败、超时或回复为空
 */
export async function checkWithAiSdk(
  config: ProviderConfig
): Promise<CheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();

  const displayEndpoint = config.endpoint || DEFAULT_ENDPOINTS[config.type];
  const pingPromise = measureEndpointPing(displayEndpoint);
  const challenge = generateChallenge();

  // 辅助函数：构建结果基础参数
  const makeBase = async (): Promise<ResultBuilderBase> => ({
    config,
    endpoint: displayEndpoint,
    pingLatencyMs: await pingPromise,
  });

  try {
    const { model, reasoningEffort } = createModel(config);

    // 内联 providerOptions 构建（仅 OpenAI 推理模型需要）
    const providerOptions =
      reasoningEffort && config.type === "openai"
        ? { openai: { reasoningEffort } }
        : undefined;

    // 用于捕获 onError 回调中的错误
    let streamError: AIApiCallError | null = null;

    const result = streamText({
      model,
      prompt: challenge.prompt,
      abortSignal: controller.signal,
      ...(providerOptions && { providerOptions }),
      onError({ error }) {
        // AI SDK 的 error 是 AIApiCallError，直接保存
        streamError = error as AIApiCallError;
      },
    });

    let collectedResponse = "";
    for await (const chunk of result.textStream) {
      collectedResponse += chunk;
    }

    const latencyMs = Date.now() - startedAt;
    const base = await makeBase();

    // 检查流处理过程中是否有错误
    if (streamError) {
      logCheckResult(config, challenge.prompt, "", challenge.expectedAnswer, null);
      return buildCheckResult(base, "error", latencyMs, getErrorMessage(streamError));
    }

    // 空回复
    if (!collectedResponse.trim()) {
      logCheckResult(config, challenge.prompt, "", challenge.expectedAnswer, null);
      return buildCheckResult(base, "failed", latencyMs, "回复为空");
    }

    // 验证答案
    const { valid, extractedNumbers } = validateResponse(
      collectedResponse,
      challenge.expectedAnswer
    );
    logCheckResult(config, challenge.prompt, collectedResponse, challenge.expectedAnswer, valid);

    if (!valid) {
      return buildCheckResult(
        base,
        "validation_failed",
        latencyMs,
        `回复验证失败: 期望 ${challenge.expectedAnswer}, 实际: ${extractedNumbers?.join(", ") || "(无数字)"}`
      );
    }

    // 判定健康状态
    const status: HealthStatus =
      latencyMs <= DEGRADED_THRESHOLD_MS ? "operational" : "degraded";

    return buildCheckResult(
      base,
      status,
      latencyMs,
      status === "degraded" ? `响应成功但耗时 ${latencyMs}ms` : `验证通过 (${latencyMs}ms)`
    );
  } catch (error) {
    return buildCheckResult(await makeBase(), "error", null, getErrorMessage(error as Error));
  } finally {
    clearTimeout(timeout);
  }
}
