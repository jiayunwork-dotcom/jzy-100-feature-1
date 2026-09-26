/**
 * 语料级关键词抽取：两趟流水线，独立于单篇编排（keywordService）成型。
 *
 * 第一趟（扫描全批）：逐篇复用单篇流水线的构件（校验 -> 分词 -> 建图 ->
 *   迭代打分），收集成功篇的图与分数；失败篇（校验错误/算法错误）只记录
 *   错误位，不参与语料统计 —— 既不进稀有度分母，也不贡献 df。
 * 语料统计：只基于成功篇计算 df 与稀有度；统计量是请求内临时量，用完即弃，
 *   不落库、不跨请求记账。
 * 第二趟（逐篇定稿）：用稀有度对单篇分数做重加权、截断排序，并划分
 *   公共词/个性词视图；最后按提交顺序装配结果，失败篇占明确的错误位。
 */
import { AppError } from '../core/errors';
import type { CooccurrenceGraph } from '../core/graph';
import { rankNodes } from '../core/rank';
import { selectTopKeywords } from '../core/select';
import type { ExtractionOptions, KeywordScore, RankResult } from '../core/types';
import { computeCommonWords, computeDistinctiveWords, type CommonWord } from '../corpus/distinctiveness';
import { reweightScores } from '../corpus/reweight';
import { computeCorpusStats, corpusRarity } from '../corpus/stats';
import type { BatchItem } from './batchService';
import { buildGraphFromRequest } from './keywordService';
import { parseDocumentRequest, type ParsedCorpusRequest } from './validation';

/** 一篇文档在语料接口下的成功结果。 */
export interface CorpusDocumentResult {
  /** 重加权后的关键词：最终权重降序、同分字典序，数量 min(topK, 入图词数) */
  keywords: KeywordScore[];
  /** 个性词视图：本篇非公共词按区分度降序（与 keywords 各自独立、互不覆盖） */
  distinctive: KeywordScore[];
  nodeCount: number;
  edgeCount: number;
  converged: boolean;
  iterations: number;
}

/** 语料级视图。 */
export interface CorpusView {
  /** 参与语料统计的成功篇数 N（稀有度分母） */
  documentCount: number;
  /** 本次请求实际使用的稀有度合成强度 λ */
  rarityStrength: number;
  /** 本次请求实际使用的公共词判定门槛 τ */
  commonThreshold: number;
  /** 公共词列表：df/N >= τ，按 df 降序、同 df 字典序 */
  commonWords: CommonWord[];
}

export interface CorpusExtractionResponse {
  /** 与提交顺序一一对应；失败篇为 { ok: false, error } 错误位 */
  results: BatchItem<CorpusDocumentResult>[];
  corpus: CorpusView;
}

interface SuccessfulDoc {
  index: number;
  options: ExtractionOptions;
  graph: CooccurrenceGraph;
  rank: RankResult;
}

function toFailure(err: AppError): BatchItem<CorpusDocumentResult> {
  const error: { code: string; message: string; field?: string } = {
    code: err.code,
    message: err.message,
  };
  if (err.field !== undefined) {
    error.field = err.field;
  }
  return { ok: false, error };
}

export function extractKeywordsCorpus(req: ParsedCorpusRequest): CorpusExtractionResponse {
  const { rarityStrength, commonThreshold } = req;

  // ---- 第一趟：逐篇跑单篇流水线构件，成功/失败分桶 ----
  const successes: SuccessfulDoc[] = [];
  const failures = new Map<number, BatchItem<CorpusDocumentResult>>();
  req.documents.forEach((body, index) => {
    try {
      const parsed = parseDocumentRequest(body);
      const { graph } = buildGraphFromRequest(parsed);
      const rank = rankNodes(
        graph,
        parsed.options.damping,
        parsed.options.tolerance,
        parsed.options.maxIterations,
      );
      successes.push({ index, options: parsed.options, graph, rank });
    } catch (err) {
      if (err instanceof AppError) {
        failures.set(index, toFailure(err));
      } else {
        throw err; // 非预期错误继续上抛，由全局错误处理器兜底
      }
    }
  });

  // ---- 语料统计：只基于成功篇；请求内临时量，用完即弃 ----
  const stats = computeCorpusStats(successes.map((doc) => doc.graph.toData().nodes));
  const rarityOf = (word: string): number => {
    const df = stats.documentFrequency.get(word);
    // word 来自成功篇的图，df 必然存在；防御性按“仅出现 1 篇”处理
    return corpusRarity(df ?? 1, stats.documentCount);
  };

  // ---- 第二趟：逐篇定稿（重加权 + 截断 + 区分度划分） ----
  const finalized = new Map<number, CorpusDocumentResult>();
  for (const doc of successes) {
    const reweighted = reweightScores(doc.rank.scores, rarityOf, rarityStrength);
    const keywords = selectTopKeywords(
      { scores: reweighted, converged: doc.rank.converged, iterations: doc.rank.iterations },
      doc.options.topK,
    );
    finalized.set(doc.index, {
      keywords,
      distinctive: computeDistinctiveWords(doc.rank.scores, stats, commonThreshold),
      nodeCount: doc.graph.nodeCount,
      edgeCount: doc.graph.edgeCount,
      converged: doc.rank.converged,
      iterations: doc.rank.iterations,
    });
  }

  // ---- 按提交顺序装配：失败篇占明确的错误位 ----
  const results: BatchItem<CorpusDocumentResult>[] = req.documents.map((_, index) => {
    const failure = failures.get(index);
    if (failure !== undefined) {
      return failure;
    }
    const result = finalized.get(index);
    if (result === undefined) {
      // 逻辑上不可达：既无错误位又无定稿结果
      throw new Error(`corpus pipeline lost document at index ${index}`);
    }
    return { ok: true, result };
  });

  return {
    results,
    corpus: {
      documentCount: stats.documentCount,
      rarityStrength,
      commonThreshold,
      commonWords: computeCommonWords(stats, commonThreshold),
    },
  };
}
