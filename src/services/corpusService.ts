/**
 * 语料感知关键词抽取编排：独立于“一篇进、一篇出”的单篇流水线的两趟流程。
 *
 * 第一趟（扫全批）：逐篇复用单篇的 分词 -> 建图 -> 迭代打分
 *   （src/services/keywordService.ts 的 analyzeDocument，底层核心算法一处未改），
 *   收集每篇成功入图的节点集合与全量原始分；坏篇只登记错误，不参与统计。
 *   在成功篇之上构建语料文档频次表（core/corpusStats.ts）。
 *
 * 第二趟（回头定稿）：对每篇成功文档
 *   - 用语料稀有度因子重加权全量原始分，再按与单篇完全一致的排序/截断规则
 *     （core/select.ts）给出该篇的重加权关键词；
 *   - 语料整体按公共词门槛划分公共词 / 各篇个性词（core/discriminative.ts）。
 *
 * 隔离与生命周期：
 *  - 某篇校验错误或算法错误（含 NOT_CONVERGED）时，该篇既不进稀有度分母 N，
 *    也不贡献任何 df，更不会污染其它篇；它仍按提交顺序在 results 与
 *    corpusView.documents 中占一个明确的错误位置；
 *  - 跨篇统计仅存在于本次函数调用内，返回即释放：服务照旧不落库、不跨请求记账。
 */
import { buildCorpusDocumentFrequency } from '../core/corpusStats';
import { AppError } from '../core/errors';
import { buildDiscriminativeView } from '../core/discriminative';
import type { CommonWord, DistinctiveWord } from '../core/discriminative';
import { reweightScores } from '../core/rarity';
import { selectTopKeywords } from '../core/select';
import type { KeywordScore, RankResult } from '../core/types';
import { analyzeDocument } from './keywordService';
import type { BatchItemFailure } from './batchService';
import type { CorpusOptions } from './validation';
import { parseDocumentRequest } from './validation';

/** 语料中单篇重加权后的成功结果。 */
export interface CorpusKeywordExtractionResult {
  /** 语料稀有度重加权后的关键词（分数即最终权重）。 */
  keywords: KeywordScore[];
  nodeCount: number;
  edgeCount: number;
  converged: boolean;
  iterations: number;
}

/** 语料结果列表中的一项：成功（重加权结果）或失败（错误位置）。 */
export type CorpusItem =
  | { ok: true; result: CorpusKeywordExtractionResult }
  | BatchItemFailure;

/** 语料级视图中的单篇条目：成功时携带该篇全部个性词（区分度已排序）。 */
export type CorpusViewItem =
  | { ok: true; distinctiveWords: DistinctiveWord[] }
  | { ok: false; error: BatchItemFailure['error'] };

/** 语料级视图：跨篇公共词 + 逐篇个性词。 */
export interface CorpusView {
  commonWords: CommonWord[];
  /** 与提交顺序对齐；失败篇为明确的错误位置。 */
  documents: CorpusViewItem[];
}

/** 语料接口完整响应。 */
export interface CorpusKeywordsResponse {
  results: CorpusItem[];
  corpusView: CorpusView;
  /** 实际参与语料统计的成功篇数（稀有度分母 N）。 */
  corpusDocumentCount: number;
  /** 本次生效的语料参数（回显，便于核对）。 */
  rarityStrength: number;
  commonThreshold: number;
}

function toFailure(err: unknown): BatchItemFailure {
  if (err instanceof AppError) {
    const error: { code: string; message: string; field?: string } = {
      code: err.code,
      message: err.message,
    };
    if (err.field !== undefined) {
      error.field = err.field;
    }
    return { ok: false, error };
  }
  throw err; // 非预期错误继续上抛，由全局错误处理器兜底
}

/**
 * 执行语料两趟流程。
 * @param bodies 逐篇请求体（已通过语料层形态校验，各篇内部参数仍逐篇校验）
 */
export function extractKeywordsCorpus(
  bodies: readonly Record<string, unknown>[],
  corpusOptions: CorpusOptions,
): CorpusKeywordsResponse {
  // 与提交顺序逐一对齐的逐篇工作槽：成功装分析结果，失败装错误。
  const slots: (
    | { ok: true; rank: RankResult; topK: number; nodeCount: number; edgeCount: number }
    | { ok: false; failure: BatchItemFailure }
  )[] = [];
  // 第一趟统计输入：成功篇给节点集合与全量原始分，失败篇给 null。
  const nodeSets: (Set<string> | null)[] = [];
  const baseScoreMaps: (Map<string, number> | null)[] = [];

  // ---- 第一趟：扫过所有文档 ----
  for (const body of bodies) {
    try {
      const req = parseDocumentRequest(body);
      const { graph, rank, options } = analyzeDocument(req);
      slots.push({
        ok: true,
        rank,
        topK: options.topK,
        nodeCount: graph.nodeCount,
        edgeCount: graph.edgeCount,
      });
      nodeSets.push(new Set(graph.toData().nodes));
      baseScoreMaps.push(rank.scores);
    } catch (err) {
      slots.push({ ok: false, failure: toFailure(err) });
      nodeSets.push(null);
      baseScoreMaps.push(null);
    }
  }

  // 跨篇统计：分母 N 与 df 只来自成功入图的篇（坏篇一律排除）。
  const dfTable = buildCorpusDocumentFrequency(nodeSets);
  const { rarityStrength, commonThreshold } = corpusOptions;

  // ---- 第二趟：回头给每篇定稿 ----
  const results: CorpusItem[] = slots.map((slot) => {
    if (!slot.ok) {
      return slot.failure; // 坏篇保留明确的错误位置
    }
    const weighted = reweightScores(slot.rank.scores, dfTable, rarityStrength);
    // 排序/截断复用单篇同一份 select 规则，仅把分数换成重加权后的最终权重
    const weightedRank: RankResult = {
      scores: weighted,
      converged: slot.rank.converged,
      iterations: slot.rank.iterations,
    };
    return {
      ok: true,
      result: {
        keywords: selectTopKeywords(weightedRank, slot.topK),
        nodeCount: slot.nodeCount,
        edgeCount: slot.edgeCount,
        converged: slot.rank.converged,
        iterations: slot.rank.iterations,
      },
    };
  });

  // 区分度视图：公共词单列，各篇个性词按“本篇突出 × 别篇沉默”排序。
  const view = buildDiscriminativeView(baseScoreMaps, dfTable, commonThreshold, rarityStrength);
  const documents: CorpusViewItem[] = slots.map((slot, i) => {
    if (!slot.ok) {
      return { ok: false, error: slot.failure.error };
    }
    return { ok: true, distinctiveWords: view.perDocument[i] ?? [] };
  });

  return {
    results,
    corpusView: { commonWords: view.commonWords, documents },
    corpusDocumentCount: dfTable.documentCount,
    rarityStrength,
    commonThreshold,
  };
}
