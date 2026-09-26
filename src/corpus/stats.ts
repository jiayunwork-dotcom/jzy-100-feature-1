/**
 * 跨篇统计：语料稀有度（语料级独立模块，不进单篇流水线）。
 *
 * 定义（钉死，可被测试逐条卡住）：
 *  - N = 成功完成单篇流水线（校验、分词建图、迭代打分全部通过）的文档篇数。
 *    校验失败或算法失败的篇不参与统计：既不进分母 N，也不贡献任何 df。
 *  - df(w) = 成功篇中共现图包含词 w 的篇数（1 <= df(w) <= N）。
 *    篇内出现多少次都只算一篇，与篇内频次无关。
 *  - 出现比例 r(w) = df(w) / N；稀有度由它的拉普拉斯平滑形式推导：
 *        r~(w) = df(w) / (N + 1)
 *        rho(w) = 1 - r~(w) = 1 - df(w) / (N + 1)  ∈ (0, 1)
 *    （平滑等价于假设语料之外还有一篇包含所有词的“幻影文档”，保证 rho 恒为正：
 *      单篇语料时每个词 rho 同为 1/2，重加权退化为整体等比缩放，排序不变。）
 *  - 方向：df 越大（越公共）rho 越低；df 越小（越稀有）rho 越高。
 *
 * 统计量只活在单次请求内：每次调用重新计算，请求结束即丢弃，不落库、不跨请求记账。
 */

/** 语料统计结果。 */
export interface CorpusStats {
  /** 参与统计的成功篇数 N（稀有度的分母） */
  documentCount: number;
  /** 词 -> 包含它的成功篇篇数 df */
  documentFrequency: ReadonlyMap<string, number>;
}

/**
 * 统计 df。
 * @param vocabularies 每篇成功文档的入图词表（每篇一个词表；篇内重复词只计一次）
 */
export function computeCorpusStats(vocabularies: readonly (readonly string[])[]): CorpusStats {
  const documentFrequency = new Map<string, number>();
  for (const vocabulary of vocabularies) {
    for (const word of new Set(vocabulary)) {
      documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
    }
  }
  return { documentCount: vocabularies.length, documentFrequency };
}

/** 语料稀有度 rho = 1 - df / (N + 1)，恒落在 (0, 1)。 */
export function corpusRarity(documentFrequency: number, documentCount: number): number {
  return 1 - documentFrequency / (documentCount + 1);
}

/** 未平滑的出现比例 r = df / N（用于公共词判定与响应展示）。 */
export function occurrenceRatio(documentFrequency: number, documentCount: number): number {
  return documentFrequency / documentCount;
}
