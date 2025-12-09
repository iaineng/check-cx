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

import { streamText, type JSONValue } from "ai";
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
 * streamText 函数支持的顶级参数集合
 * 这些参数应该直接传递给 streamText，而不是放入 providerOptions
 */
const STREAM_TEXT_TOP_LEVEL_KEYS = new Set([
  "system", // 系统提示词
  "maxTokens", // 最大生成 token 数
  "temperature", // 温度参数（随机性）
  "topP", // Top-P 采样参数
  "topK", // Top-K 采样参数
  "presencePenalty", // 存在惩罚
  "frequencyPenalty", // 频率惩罚
  "stopSequences", // 停止序列
  "seed", // 随机种子
  "maxRetries", // 最大重试次数
  "headers", // 自定义请求头
]);

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
  /\bo[1-9]/i, // OpenAI o1/o3 等推理模型
  /deepseek-r1/i, // DeepSeek R1 推理模型
  /qwq/i, // 通义千问 QwQ 推理模型
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
 * 创建 AI SDK 模型实例
 *
 * 根据配置中的 Provider 类型创建对应的 AI SDK 模型实例。
 * 支持的 Provider 类型：
 * - openai: 使用 @ai-sdk/openai，支持 Chat Completions 和 Responses API
 * - anthropic: 使用 @ai-sdk/anthropic
 * - gemini: 使用 @ai-sdk/openai-compatible（OpenAI 兼容模式）
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

  // 构建通用请求头
  // 包含默认的 User-Agent 和用户自定义的请求头
  const headers: Record<string, string> = {
    "User-Agent": "check-cx/0.1.0",
    ...(config.requestHeaders || {}),
  };

  switch (config.type) {
    case "openai": {
      // 创建 OpenAI SDK 实例
      const provider = createOpenAI({
        apiKey: config.apiKey,
        baseURL,
        headers,
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
      // 创建 Anthropic SDK 实例
      const provider = createAnthropic({
        apiKey: config.apiKey,
        baseURL,
        headers,
      });
      // Anthropic 不支持 reasoning_effort 参数
      return {
        model: provider(modelId),
        reasoningEffort: undefined,
        isResponses: false,
      };
    }

    case "gemini": {
      // Gemini 使用 OpenAI 兼容模式
      // 通过 @ai-sdk/openai-compatible 适配
      const provider = createOpenAICompatible({
        name: "gemini",
        apiKey: config.apiKey,
        baseURL,
        headers,
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
 * 从错误对象中提取用户友好的错误消息
 *
 * @param error - 捕获的错误对象
 * @returns 格式化后的错误消息
 */
function getErrorMessage(error: Error & { name?: string }): string {
  // 超时错误返回统一的中文提示
  if (isTimeoutError(error)) return "请求超时";
  // 其他错误返回原始消息或默认提示
  return error?.message || "未知错误";
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
  status: HealthStatus | "validation_failed" | "failed",
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
 *
 * @param config - Provider 配置
 * @param prompt - 挑战题目
 * @param response - 模型回复
 * @param expectedAnswer - 期望答案
 * @param isValid - 验证是否通过（null 表示空回复）
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
    `[${config.type}] ${config.groupName || "默认"} | ${config.name} | Q: ${prompt} | A: ${response || "(空)"} | 期望: ${expectedAnswer} | 验证: ${validStatus}`
  );
}

/**
 * 从 system 数组格式提取文本
 *
 * OpenAI 格式的 system 可能是数组：[{ type: "text", text: "..." }]
 * 此函数将其转换为字符串
 */
function extractSystemText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;

  const texts = value
    .filter(
      (item): item is { text: string; type: string } =>
        typeof item === "object" &&
        item !== null &&
        "text" in item &&
        typeof item.text === "string"
    )
    .map((item) => item.text);

  return texts.length > 0 ? texts.join("\n") : null;
}

/**
 * 分离 metadata 参数
 *
 * 将 metadata 中的参数分为两类：
 * - topLevelParams: 直接传递给 streamText 的参数
 * - providerSpecificParams: 放入 providerOptions 的 Provider 特定参数
 *
 * @param metadata - 原始 metadata 对象
 * @returns 分离后的参数对象
 */
function separateMetadataParams(metadata: Record<string, unknown> | undefined): {
  topLevelParams: Record<string, JSONValue>;
  providerSpecificParams: Record<string, JSONValue>;
} {
  const topLevelParams: Record<string, JSONValue> = {};
  const providerSpecificParams: Record<string, JSONValue> = {};

  if (!metadata) {
    return { topLevelParams, providerSpecificParams };
  }

  for (const [key, value] of Object.entries(metadata)) {
    // 跳过会导致冲突的字段
    if (EXCLUDED_KEYS.has(key)) continue;

    if (STREAM_TEXT_TOP_LEVEL_KEYS.has(key)) {
      // 特殊处理 system 字段：如果是数组格式，转换为字符串
      if (key === "system") {
        const systemText = extractSystemText(value);
        if (systemText) {
          topLevelParams[key] = systemText;
        }
      } else {
        topLevelParams[key] = value as JSONValue;
      }
    } else {
      providerSpecificParams[key] = value as JSONValue;
    }
  }

  return { topLevelParams, providerSpecificParams };
}

/**
 * 构建 providerOptions 对象
 *
 * @param providerType - Provider 类型
 * @param providerSpecificParams - Provider 特定参数
 * @param reasoningEffort - 推理强度（仅 OpenAI）
 * @returns providerOptions 对象，如果为空则返回 undefined
 */
function buildProviderOptions(
  providerType: string,
  providerSpecificParams: Record<string, JSONValue>,
  reasoningEffort?: ReasoningEffort
): Record<string, Record<string, JSONValue>> | undefined {
  const providerOptionsMap: Record<string, Record<string, JSONValue>> = {};
  const providerKey = providerType === "gemini" ? "gemini" : providerType;

  // 添加 Provider 特定参数
  if (Object.keys(providerSpecificParams).length > 0) {
    providerOptionsMap[providerKey] = { ...providerSpecificParams };
  }

  // 为 OpenAI 推理模型添加 reasoning_effort 参数
  if (reasoningEffort && providerType === "openai") {
    providerOptionsMap.openai = {
      ...(providerOptionsMap.openai || {}),
      reasoningEffort,
    };
  }

  return Object.keys(providerOptionsMap).length > 0
    ? providerOptionsMap
    : undefined;
}

/**
 * 统一的 AI Provider 健康检查函数
 *
 * 这是本模块的核心函数，执行以下步骤：
 * 1. 创建对应 Provider 的 SDK 模型实例
 * 2. 生成数学挑战题（如 "3 + 5 = ?"）
 * 3. 发送流式请求并收集完整回复
 * 4. 验证回复是否包含正确答案
 * 5. 根据响应时间判定健康状态
 *
 * 健康状态判定规则：
 * - operational: 请求成功且延迟 ≤ 6000ms
 * - degraded: 请求成功但延迟 > 6000ms
 * - validation_failed: 收到回复但答案验证失败
 * - failed: 请求失败、超时或回复为空
 *
 * @param config - Provider 配置对象
 * @returns 检查结果，包含状态、延迟、消息等信息
 */
export async function checkWithAiSdk(
  config: ProviderConfig
): Promise<CheckResult> {
  // 创建超时控制器
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();

  // 准备基础参数
  const displayEndpoint = config.endpoint || DEFAULT_ENDPOINTS[config.type];
  const pingPromise = measureEndpointPing(displayEndpoint);
  const challenge = generateChallenge();

  // 构建结果的基础参数（pingLatencyMs 后续填充）
  const getResultBase = async (): Promise<ResultBuilderBase> => ({
    config,
    endpoint: displayEndpoint,
    pingLatencyMs: await pingPromise,
  });

  try {
    // 创建 AI SDK 模型实例
    const { model, reasoningEffort } = createModel(config);

    // 分离 metadata 参数
    const { topLevelParams, providerSpecificParams } = separateMetadataParams(
      config.metadata
    );

    // 构建 providerOptions
    const providerOptions = buildProviderOptions(
      config.type,
      providerSpecificParams,
      reasoningEffort
    );

    // 构建请求参数
    const streamParams: Parameters<typeof streamText>[0] = {
      model,
      prompt: challenge.prompt,
      temperature: 0, // 使用确定性输出，便于验证
      abortSignal: controller.signal,
      ...topLevelParams,
      ...(providerOptions ? { providerOptions } : {}),
    };

    // 执行流式请求并收集响应
    const result = streamText(streamParams);
    let collectedResponse = "";
    for await (const chunk of result.textStream) {
      collectedResponse += chunk;
    }

    const latencyMs = Date.now() - startedAt;
    const base = await getResultBase();

    // 检查空回复
    if (!collectedResponse.trim()) {
      logCheckResult(config, challenge.prompt, "", challenge.expectedAnswer, null);
      return buildCheckResult(base, "failed", latencyMs, "回复为空");
    }

    // 验证答案
    const validationResult = validateResponse(
      collectedResponse,
      challenge.expectedAnswer
    );
    logCheckResult(
      config,
      challenge.prompt,
      collectedResponse,
      challenge.expectedAnswer,
      validationResult.valid
    );

    // 验证失败
    if (!validationResult.valid) {
      const extractedAnswer =
        validationResult.extractedNumbers?.join(", ") || "(无数字)";
      return buildCheckResult(
        base,
        "validation_failed",
        latencyMs,
        `回复验证失败: 期望 ${challenge.expectedAnswer}, 实际: ${extractedAnswer}`
      );
    }

    // 判定健康状态
    const status: HealthStatus =
      latencyMs <= DEGRADED_THRESHOLD_MS ? "operational" : "degraded";
    const message =
      status === "degraded"
        ? `响应成功但耗时 ${latencyMs}ms`
        : `验证通过 (${latencyMs}ms)`;

    return buildCheckResult(base, status, latencyMs, message);
  } catch (error) {
    const base = await getResultBase();
    return buildCheckResult(base, "failed", null, getErrorMessage(error as Error));
  } finally {
    clearTimeout(timeout);
  }
}
