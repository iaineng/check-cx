/**
 * 随机挑战生成器
 *
 * 生成随机数学题用于验证 AI 回复的真实性，
 * 防止假站点用固定回复绕过检测
 */

export interface Challenge {
  /** 发送给模型的问题 */
  prompt: string;
  /** 期望的正确答案 */
  expectedAnswer: string;
}

/**
 * 构建带有 few-shot 示例的 prompt
 *
 * 通过示例引导模型仅输出数字结果，减少验证失败率
 *
 * @param question - 实际的数学问题
 * @returns 包含示例的完整 prompt
 */
function buildPromptWithExamples(question: string): string {
  return `Calculate and respond with ONLY the number, nothing else.

Q: 3 + 5 = ?
A: 8

Q: 12 - 7 = ?
A: 5

Q: ${question}
A:`;
}

/**
 * 生成一个随机数学挑战
 *
 * 使用简单的加减法，确保所有 LLM 都能正确计算
 */
export function generateChallenge(): Challenge {
  // 生成 1-50 范围内的随机数，避免数字太大或太小
  const a = Math.floor(Math.random() * 50) + 1;
  const b = Math.floor(Math.random() * 50) + 1;

  // 随机选择加法或减法
  const isAddition = Math.random() > 0.5;

  if (isAddition) {
    const answer = a + b;
    return {
      prompt: buildPromptWithExamples(`${a} + ${b} = ?`),
      expectedAnswer: String(answer),
    };
  } else {
    // 确保结果为正数（大数减小数）
    const larger = Math.max(a, b);
    const smaller = Math.min(a, b);
    const answer = larger - smaller;
    return {
      prompt: buildPromptWithExamples(`${larger} - ${smaller} = ?`),
      expectedAnswer: String(answer),
    };
  }
}

/** 验证结果 */
export interface ValidationResult {
  /** 是否验证通过 */
  valid: boolean;
  /** 从回复中提取到的数字(用于显示) */
  extractedNumbers: string[] | null;
}

/**
 * 验证模型回复是否包含正确答案
 *
 * @param response 模型的回复内容
 * @param expectedAnswer 期望的答案
 * @returns 验证结果,包含是否通过和提取到的数字
 */
export function validateResponse(
  response: string,
  expectedAnswer: string
): ValidationResult {
  if (!response || !expectedAnswer) {
    return { valid: false, extractedNumbers: null };
  }

  // 从回复中提取所有数字
  const numbers = response.match(/-?\d+/g);
  if (!numbers) {
    return { valid: false, extractedNumbers: null };
  }

  // 检查是否包含正确答案
  const valid = numbers.includes(expectedAnswer);
  return { valid, extractedNumbers: numbers };
}
