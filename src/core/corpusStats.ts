/**
 * 语料级跨篇统计（两趟流程的第一趟）。
 *
 * 只做一件事：在全部【成功入图】的文档之上，统计每个入图词的文档频次
 * （document frequency：有多少篇文档的图里包含该词），以及成功篇数 N。
 *
 * 统计口径（钉死）：
 *  - 入图词集合 = 分词、停用词过滤后幸存的词（含孤立节点），与单篇共现图节点完全一致；
 *  - 同一篇里一个词出现多次只计一次 df（df 是“篇数”，不是总词频）；
 *  - 失败（校验错误或算法错误）的篇既不进分母 N，也不贡献任何 df；
 *  - 本统计结构只活在一次语料请求的生命周期内，服务不持有任何跨请求状态。
 */

/** 语料文档频次表。 */
export class CorpusDocumentFrequency {
  /** 成功入图的文档篇数 N（稀有度统计的分母）。 */
  readonly documentCount: number;
  private readonly df: ReadonlyMap<string, number>;

  constructor(documentCount: number, df: ReadonlyMap<string, number>) {
    this.documentCount = documentCount;
    this.df = df;
  }

  /** 包含某词的成功文档篇数；词不在任何成功篇图中时为 0。 */
  documentFrequencyOf(word: string): number {
    return this.df.get(word) ?? 0;
  }

  /** 所有成功篇图中出现过的词。 */
  words(): IterableIterator<string> {
    return this.df.keys();
  }
}

/**
 * 汇总各篇成功入图的节点集合，构建文档频次表。
 * @param nodeSets 与提交顺序对齐的节点集合；失败篇传 null，不参与统计
 */
export function buildCorpusDocumentFrequency(
  nodeSets: readonly (ReadonlySet<string> | null)[],
): CorpusDocumentFrequency {
  const df = new Map<string, number>();
  let documentCount = 0;

  for (const nodes of nodeSets) {
    if (nodes === null) {
      continue; // 坏篇：不进分母、不贡献 df
    }
    documentCount += 1;
    for (const word of nodes) {
      df.set(word, (df.get(word) ?? 0) + 1);
    }
  }

  return new CorpusDocumentFrequency(documentCount, df);
}
