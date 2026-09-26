/**
 * 语料重加权：把单篇分数与语料稀有度合成为最终权重（语料级独立模块）。
 *
 * 规则（钉死，可被测试逐条卡住）：
 *      final(w) = base(w) * (1 - λ + λ * rho(w))
 *  - base(w)：单篇流水线收敛后的原始分数（rankNodes 的输出，一字不改）；
 *  - rho(w)：语料稀有度（corpus/stats.ts），随 df 增大而单调不增；
 *  - λ = rarityStrength ∈ [0, 1]，合成强度：
 *      λ = 0  ->  final = base           完全按单篇原样；
 *      λ = 1  ->  final = base * rho     对公共词施加最大惩罚；
 *  - 单调性：合成因子 (1 - λ + λ * rho) 随 rho 单调不减，因此其它条件不变时，
 *    一个词被更多文档包含（df 变大）只会让它在任一篇里的最终权重下降或持平，
 *    绝不上升。
 */

/** 单个词的最终权重。 */
export function finalWeight(baseScore: number, rarity: number, rarityStrength: number): number {
  return baseScore * (1 - rarityStrength + rarityStrength * rarity);
}

/** 对一篇文档的全部单篇分数做重加权，返回新的分数表（不改入参）。 */
export function reweightScores(
  scores: ReadonlyMap<string, number>,
  rarityOf: (word: string) => number,
  rarityStrength: number,
): Map<string, number> {
  const reweighted = new Map<string, number>();
  for (const [word, baseScore] of scores) {
    reweighted.set(word, finalWeight(baseScore, rarityOf(word), rarityStrength));
  }
  return reweighted;
}
