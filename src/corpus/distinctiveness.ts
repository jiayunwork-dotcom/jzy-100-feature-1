/**
 * 区分度划分：公共词 vs 个性词（语料级独立模块）。
 *
 * 规则（钉死，可被测试逐条卡住）：
 *  - 公共词：r(w) = df(w)/N >= τ（τ = commonThreshold ∈ (0,1]）的词，
 *    全部列入语料级 commonWords，按 df 降序、同 df 按字典序升序；
 *  - 个性词：非公共词按所属篇归入各篇 distinctive 列表，篇内按区分度
 *        distinct_d(w) = s_d(w) * rho(w)
 *    降序、同分按字典序（s_d 为单篇收敛分数，rho 为语料稀有度 ——
 *    在本篇突出、又在别篇沉默的词排在最前）；
 *  - 互斥且穷尽：公共词不出现在任何 distinctive 列表；每个非公共词至少
 *    出现在它实际所属那一篇的 distinctive 列表里 —— 两个视图并起来恰好
 *    覆盖全部入图词，不多不少。
 *
 * 注意：个性词视图与重加权关键词是两套独立视图 —— 关键词看词在本篇内部的
 * 地位（重加权后的最终权重），个性词看“本篇突出、别篇沉默”的落差，
 * 分别取用、互不覆盖。
 */
import type { KeywordScore } from '../core/types';
import { corpusRarity, occurrenceRatio, type CorpusStats } from './stats';

/** 公共词判定：df/N >= τ（等号算公共）。 */
export function isCommonWord(documentFrequency: number, documentCount: number, commonThreshold: number): boolean {
  return occurrenceRatio(documentFrequency, documentCount) >= commonThreshold;
}

/** 语料级公共词条目。 */
export interface CommonWord {
  word: string;
  /** 包含该词的成功篇篇数 df */
  documentCount: number;
  /** 出现比例 df/N */
  ratio: number;
}

/** 语料级公共词列表：df 降序，同 df 按字典序升序。 */
export function computeCommonWords(stats: CorpusStats, commonThreshold: number): CommonWord[] {
  const common: CommonWord[] = [];
  for (const [word, df] of stats.documentFrequency) {
    if (isCommonWord(df, stats.documentCount, commonThreshold)) {
      common.push({ word, documentCount: df, ratio: occurrenceRatio(df, stats.documentCount) });
    }
  }
  common.sort((a, b) => {
    if (b.documentCount !== a.documentCount) return b.documentCount - a.documentCount;
    if (a.word < b.word) return -1;
    if (a.word > b.word) return 1;
    return 0;
  });
  return common;
}

/**
 * 一篇文档的个性词列表：本篇入图词中的非公共词，按区分度 s_d(w) * rho(w)
 * 降序、同分按字典序。不做数量截断 —— 每个非公共词都必须露面（覆盖性）。
 */
export function computeDistinctiveWords(
  scores: ReadonlyMap<string, number>,
  stats: CorpusStats,
  commonThreshold: number,
): KeywordScore[] {
  const distinctive: KeywordScore[] = [];
  for (const [word, baseScore] of scores) {
    const df = stats.documentFrequency.get(word);
    // word 来自成功篇的图，df 必然存在；防御性跳过
    if (df === undefined || isCommonWord(df, stats.documentCount, commonThreshold)) {
      continue;
    }
    distinctive.push({ word, score: baseScore * corpusRarity(df, stats.documentCount) });
  }
  distinctive.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.word < b.word) return -1;
    if (a.word > b.word) return 1;
    return 0;
  });
  return distinctive;
}
