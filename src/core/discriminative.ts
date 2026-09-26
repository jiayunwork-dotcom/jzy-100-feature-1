/**
 * 语料级区分度划分（两趟流程的第二趟之二）。
 *
 * 回答的是语料整体问题：哪些词是跨篇共享的“公共词”，哪些是各篇独有/突出的
 * “个性词”。这与单篇（重加权）关键词是两码事：
 *  - 单篇关键词看的是词在本篇内部的地位（分数排序）；
 *  - 区分度看的是词“在本篇突出、却在别篇沉默”的落差。
 * 两者分别计算、分别返回，互不覆盖。
 *
 * 划分规则（钉死，可逐条被测试卡住）：
 *   记 N  = 成功入图篇数，df(w) = 包含 w 的成功篇数，
 *       θ  = 公共词判定门槛 commonThreshold，θ ∈ 开区间 (0, 1]（校验层保证）。
 *
 *   - 公共词（common）：df(w) / N >= θ；
 *   - 个性词（distinctive）：其余全部入图词（df(w) / N < θ）。
 *     个性词归属到每一个包含它的篇 —— 一个词若在两篇都出现但未达公共门槛，
 *     它在这两篇的个性列表中各占一项（个性是“相对于其余文档的落差”，不要求独一篇）。
 *
 * 互斥且穷尽覆盖：对所有成功篇图中的词 w，
 *   w ∈ 公共词集  ⇔  w 不出现在任何一篇的个性列表中；
 *   二者并集恰好等于全部入图词，不允许重复、不允许漏词。
 *
 * 某篇个性词的区分度（distinctiveness）：
 *   distinctiveness_d(w) = baseScore_d(w) * rarity(w, α)
 *   即“本篇突出程度”乘以“跨篇沉默程度”，与重加权关键词同一合成方式，
 *   但公共词已在上一步被整体剔除，留下的纯粹是该篇相对其余文档的区分信号。
 */
import type { CorpusDocumentFrequency } from './corpusStats';
import { rarityWeight } from './rarity';

/** 默认公共词门槛：80% 及以上的成功篇都包含才算公共词。 */
export const DEFAULT_COMMON_THRESHOLD = 0.8;

/** 一个公共词及其跨篇统计。 */
export interface CommonWord {
  word: string;
  /** 包含该词的成功文档篇数。 */
  documentFrequency: number;
  /** 成功文档总数（统计分母）。 */
  documentCount: number;
  /** 文档覆盖率 df / N。 */
  ratio: number;
}

/** 某一篇的一个个性词及其区分度。 */
export interface DistinctiveWord {
  word: string;
  /** 该词在本篇的单篇原始分（钉死算法输出）。 */
  baseScore: number;
  /** 该词的语料稀有度权重。 */
  rarity: number;
  /** 本篇突出 × 别篇沉默 的合成区分度。 */
  distinctiveness: number;
}

/** 语料级区分度视图。 */
export interface DiscriminativeView {
  /** 跨篇公共词，按覆盖率降序、同分按词字典序排列。 */
  commonWords: CommonWord[];
  /** 与提交顺序对齐（失败篇为 null）：各篇个性词，按区分度降序、同分按词字典序。 */
  perDocument: (DistinctiveWord[] | null)[];
}

/** 判断一个词是否为公共词（df / N >= θ）。N 为成功篇数，恒 >= 1。 */
export function isCommonWord(
  documentCount: number,
  documentFrequency: number,
  commonThreshold: number,
): boolean {
  return documentFrequency / documentCount >= commonThreshold;
}

/**
 * 在文档频次表之上完成公共/个性划分，并给出每篇的个性词区分度排序。
 *
 * @param perDocumentScores 与提交顺序对齐；失败篇为 null，成功篇为该篇全部入图词的原始分
 * @param dfTable           跨篇文档频次（只基于成功篇）
 * @param commonThreshold   公共词门槛 θ ∈ (0, 1]
 * @param rarityStrength    稀有度合成强度 α ∈ [0, 1]
 */
export function buildDiscriminativeView(
  perDocumentScores: readonly (ReadonlyMap<string, number> | null)[],
  dfTable: CorpusDocumentFrequency,
  commonThreshold: number,
  rarityStrength: number,
): DiscriminativeView {
  const n = dfTable.documentCount;
  const commonSet = new Set<string>();
  const commonWords: CommonWord[] = [];

  for (const word of dfTable.words()) {
    const df = dfTable.documentFrequencyOf(word);
    if (isCommonWord(n, df, commonThreshold)) {
      commonSet.add(word);
      commonWords.push({
        word,
        documentFrequency: df,
        documentCount: n,
        ratio: df / n,
      });
    }
  }

  commonWords.sort((a, b) => {
    if (b.ratio !== a.ratio) return b.ratio - a.ratio; // 覆盖率降序
    if (b.documentFrequency !== a.documentFrequency) {
      return b.documentFrequency - a.documentFrequency;
    }
    return a.word < b.word ? -1 : a.word > b.word ? 1 : 0; // 字典序兜底
  });

  const perDocument: (DistinctiveWord[] | null)[] = perDocumentScores.map((scores) => {
    if (scores === null) {
      return null; // 坏篇在视图里同样占一个明确的空位置
    }
    const distinctive: DistinctiveWord[] = [];
    for (const [word, baseScore] of scores) {
      if (commonSet.has(word)) {
        continue; // 公共词与个性词互斥
      }
      const df = dfTable.documentFrequencyOf(word);
      const rarity = rarityWeight(n, df, rarityStrength);
      distinctive.push({
        word,
        baseScore,
        rarity,
        distinctiveness: baseScore * rarity,
      });
    }
    distinctive.sort((a, b) => {
      if (b.distinctiveness !== a.distinctiveness) {
        return b.distinctiveness - a.distinctiveness; // 区分度降序
      }
      return a.word < b.word ? -1 : a.word > b.word ? 1 : 0; // 同分字典序
    });
    return distinctive;
  });

  return { commonWords, perDocument };
}
