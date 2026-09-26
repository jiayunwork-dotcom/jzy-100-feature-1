/**
 * 语料稀有度重加权（两趟流程的第二趟之一）。
 *
 * 在原单篇迭代分数（src/core/rank.ts，钉死不动）之上，叠加跨文档稀有度调节：
 * 一个词在越多篇文档里出现，稀有度越低、最终权重被压得越低；
 * 只在少数几篇冒头的词稀有度高，权重被抬起来。
 *
 * 规则（钉死，可逐条被测试卡住）：
 *   记 N  = 成功入图的文档篇数（坏篇不计入）
 *       df = 包含该词的成功文档篇数（1 <= df <= N，对入图词恒成立）
 *
 *     idfFactor(w)  = ln((N + 1) / (df(w) + 1)) + 1      （始终为正）
 *     rarity(w)     = idfFactor(w) ^ rarityStrength       （稀有度权重）
 *     finalWeight_d(w) = baseScore_d(w) * rarity(w)
 *
 *   - baseScore_d(w) 是该词在第 d 篇里由钉死的单篇迭代算法算出的原始分数；
 *   - rarityStrength α ∈ 闭区间 [0, 1]（校验层保证）：
 *       α = 0 时 rarity 恒为 1，最终权重完全等于单篇原始分（“完全按单篇原样”）；
 *       α 越大，跨篇越常见的词被压得越狠（“重度惩罚公共词”）。
 *
 * 由此直接得到、且被测试钉住的关系：
 *   1. 单篇退化：N = 1 时所有入图词 df = 1，idfFactor = ln(2/2) + 1 = 1，
 *      rarity ≡ 1，重加权后的分数与排序与原单篇接口逐位一致；
 *   2. 方向单调：固定 N 与 α（α ≥ 0），df 只增时 (N+1)/(df+1) 只减，
 *      rarity 只降不升，因此把一个词人为塞进更多篇后，它在原篇的最终权重
 *      只能下降或持平，绝不允许因“更常见”反而被抬高；
 *   3. 跨篇全覆盖词（df = N）稀有度恒为 ln((N+1)/(N+1)) + 1 = 1，
 *      其权重只由本篇地位决定，既不被加码也不被额外惩罚。
 */
import type { CorpusDocumentFrequency } from './corpusStats';

/** 默认的稀有度合成强度：完整启用 IDF 式稀有度。 */
export const DEFAULT_RARITY_STRENGTH = 1;

/**
 * 计算单个词的 IDF 式稀有度因子（取强度 α 次幂前的底数）。
 * 对入图词恒有 1 <= df <= N，故 0 < 因子 <= 1。
 */
export function idfFactor(documentCount: number, documentFrequency: number): number {
  return Math.log((documentCount + 1) / (documentFrequency + 1)) + 1;
}

/** 计算单个词的稀有度权重：idfFactor ^ α。 */
export function rarityWeight(
  documentCount: number,
  documentFrequency: number,
  rarityStrength: number,
): number {
  return idfFactor(documentCount, documentFrequency) ** rarityStrength;
}

/**
 * 对一篇文档的单篇分数施加语料稀有度重加权。
 * 不修改原分数映射，返回一张全新的“词 -> 最终权重”映射。
 */
export function reweightScores(
  baseScores: ReadonlyMap<string, number>,
  dfTable: CorpusDocumentFrequency,
  rarityStrength: number,
): Map<string, number> {
  const n = dfTable.documentCount;
  const result = new Map<string, number>();
  for (const [word, baseScore] of baseScores) {
    const factor = rarityWeight(n, dfTable.documentFrequencyOf(word), rarityStrength);
    result.set(word, baseScore * factor);
  }
  return result;
}
