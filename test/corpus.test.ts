/**
 * 语料感知层测试。
 *
 * 重点钉死需求点名的四条关系：
 *   关系一  单篇退化：语料只有一篇时，稀有度对每个词恒为 1，
 *           重加权关键词与原单篇接口返回逐位一致；
 *   关系二  稀有度方向单调：某词被人为塞进更多篇（df 上升、N 不变）后，
 *           它在原篇的最终权重只能下降或持平，绝不反升；
 *   关系三  公共词与个性词互斥且穷尽覆盖全部入图词，不漏不重；
 *   关系四  坏篇不进分母、不贡献 df、不污染其它篇，且按提交顺序占据错误位置。
 * 另覆盖：α=0 完全等价单篇、稀有度确实能让个性词反超公共词、
 * 区分度视图与单篇关键词互不覆盖、参数校验边界等。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AppError, ErrorCodes } from '../src/core/errors';
import { buildCorpusDocumentFrequency, CorpusDocumentFrequency } from '../src/core/corpusStats';
import { idfFactor, rarityWeight, reweightScores } from '../src/core/rarity';
import { buildDiscriminativeView, isCommonWord } from '../src/core/discriminative';
import { extractKeywords } from '../src/services/keywordService';
import { extractKeywordsCorpus } from '../src/services/corpusService';
import {
  CORPUS_DEFAULTS,
  parseCorpusRequest,
  parseDocumentRequest,
} from '../src/services/validation';

/** 构造一个简单的文档频次表（词 -> df），N 单独给出。 */
function dfTable(n: number, df: Record<string, number>): CorpusDocumentFrequency {
  return new CorpusDocumentFrequency(n, new Map(Object.entries(df)));
}

test('稀有度规则：df=N（满批出现）时因子恒为 1；df 越小因子越大', () => {
  const N = 5;
  assert.equal(idfFactor(N, N), 1, 'df=N 时 ln((N+1)/(N+1))+1 = 1');
  for (let df = 1; df < N; df += 1) {
    assert.ok(idfFactor(N, df) > 1, `df=${df} < N 时因子应大于 1`);
  }
  assert.ok(idfFactor(N, 1) > idfFactor(N, 2));
  assert.ok(idfFactor(N, 4) > idfFactor(N, 5));
});

test('α=0 时稀有度恒为 1；α 越大，低频词权重越高、高频词贴近 1', () => {
  assert.equal(rarityWeight(5, 2, 0), 1);
  const r = rarityWeight(5, 2, 1);
  assert.ok(r > 1);
  // 单调：α 越大，df 低的词因子越大
  assert.ok(rarityWeight(5, 2, 0.5) < rarityWeight(5, 2, 1));
  // df=N 时任何 α 都是 1（0^? 规避：底数 1）
  assert.equal(rarityWeight(5, 5, 0.7), 1);
});

test('关系二（纯函数级）：固定 N，df 只增则稀有度因子单调不增', () => {
  const N = 8;
  for (const alpha of [0, 0.25, 0.5, 1]) {
    for (let df = 1; df < N; df += 1) {
      assert.ok(
        rarityWeight(N, df, alpha) >= rarityWeight(N, df + 1, alpha) - 1e-15,
        `α=${alpha} df=${df} -> ${df + 1} 因子反升`,
      );
    }
  }
  // 固定 df 而增大 N（词在语料中占比变小）时，因子应不降
  assert.ok(rarityWeight(9, 2, 1) > rarityWeight(8, 2, 1));
});

test('reweightScores：最终权重 = 单篇分 × 稀有度，原映射不被修改', () => {
  const base = new Map([
    ['公共', 1.2],
    ['个性', 0.8],
  ]);
  const table = dfTable(4, { 公共: 4, 个性: 1 });
  const out = reweightScores(base, table, 1);
  assert.ok(Math.abs(out.get('公共')! - 1.2) < 1e-12, 'df=N 的词权重不变');
  assert.ok(Math.abs(out.get('个性')! - 0.8 * idfFactor(4, 1)) < 1e-12);
  assert.equal(base.get('公共'), 1.2, '不得修改入参');
});

test('文档频次统计：同一篇内多次出现只计一次；失败篇（null）不进分母不贡献 df', () => {
  const table = buildCorpusDocumentFrequency([
    new Set(['a', 'b']),
    null, // 坏篇
    new Set(['b', 'c']),
    new Set(['b']),
    null, // 坏篇
  ]);
  assert.equal(table.documentCount, 3);
  assert.equal(table.documentFrequencyOf('a'), 1);
  assert.equal(table.documentFrequencyOf('b'), 3);
  assert.equal(table.documentFrequencyOf('c'), 1);
  assert.equal(table.documentFrequencyOf('不存在'), 0);
});

test('关系三（划分）：公共词与个性词互斥，并穷尽覆盖全部入图词', () => {
  // N=5：公共（df>=4，θ=0.8）/ 半公共 / 个性
  const scores = [
    new Map([['背景', 1], ['甲', 1], ['独1', 1]]),
    new Map([['背景', 1], ['甲', 1], ['独2', 1]]),
    new Map([['背景', 1], ['甲', 1], ['独3', 1]]),
    new Map([['背景', 1], ['独4', 1]]),
    new Map([['背景', 1], ['独5', 1]]),
  ];
  const table = buildCorpusDocumentFrequency(scores.map((s) => new Set(s.keys())));
  const view = buildDiscriminativeView(scores, table, 0.8, 1);

  const common = view.commonWords.map((w) => w.word);
  assert.deepEqual(common, ['背景']); // 5/5=1.0 >= 0.8；甲 3/5=0.6 不是公共

  const distinctiveUnion = new Set<string>();
  for (const list of view.perDocument) {
    assert.ok(list !== null);
    for (const d of list!) distinctiveUnion.add(d.word);
  }
  // 互斥
  for (const w of common) {
    assert.ok(!distinctiveUnion.has(w), `${w} 不能既是公共又是个性`);
  }
  // 穷尽覆盖
  const allInGraph = new Set<string>();
  for (const s of scores) for (const w of s.keys()) allInGraph.add(w);
  const covered = new Set<string>([...common, ...distinctiveUnion]);
  assert.deepEqual([...covered].sort(), [...allInGraph].sort(), '必须全覆盖入图词');

  // 个性词可跨篇重复归属（甲出现在 3 篇，未达门槛，三篇列表中都应出现）
  const jiaDocs = view.perDocument.filter((l) => l!.some((d) => d.word === '甲'));
  assert.equal(jiaDocs.length, 3);
});

test('区分度 = 本篇分 × 稀有度；公共词不进任何一篇的个性列表', () => {
  const scores = [new Map([['背景', 1.5], ['独1', 0.5]]), new Map([['背景', 0.9], ['独2', 2.0]])];
  const table = buildCorpusDocumentFrequency(scores.map((s) => new Set(s.keys())));
  const view = buildDiscriminativeView(scores, table, 1, 1); // θ=1：只有 2/2 才算公共
  assert.deepEqual(view.commonWords.map((w) => w.word), ['背景']);
  const d0 = view.perDocument[0]!;
  const du = d0.find((d) => d.word === '独1')!;
  assert.ok(Math.abs(du.rarity - idfFactor(2, 1)) < 1e-12);
  assert.ok(Math.abs(du.distinctiveness - 0.5 * idfFactor(2, 1)) < 1e-12);
  assert.ok(!d0.some((d) => d.word === '背景'));
  // 个性列表按区分度降序、同分字典序
  for (let i = 1; i < d0.length; i += 1) {
    assert.ok(d0[i - 1].distinctiveness >= d0[i].distinctiveness);
  }
});

test('门槛边界：θ=1 要求满篇覆盖；θ→0+ 时只要不是 0 覆盖都可能公共（df/N 恒正）', () => {
  assert.equal(isCommonWord(5, 5, 1), true);
  assert.equal(isCommonWord(5, 4, 1), false);
  assert.equal(isCommonWord(5, 1, 0.2), true);
  assert.equal(isCommonWord(5, 1, 0.21), false);
});

// ---------- 服务级两趟流程 ----------

const CORPUS_FIXTURE = [
  { document: { sentences: [['背景','甲','背景','乙','专题A','丙','专题A','丁','背景','甲','背景']] }, windowSize: 2, topK: 10 },
  { document: { sentences: [['背景','丁','背景','戊','专题B','背景','丁','戊','背景']] }, windowSize: 2, topK: 10 },
  { document: { sentences: [['背景','己','专题C','背景','庚','背景','己','庚','背景']] }, windowSize: 2, topK: 10 },
];

test('关系一：语料只有一篇时，重加权结果与原单篇接口逐位一致', () => {
  const body = {
    document: {
      sentences: [['猫','线','球','猫','线','球','沙发','猫','线','垫子','沙发','猫']],
    },
    windowSize: 3,
    damping: 0.85,
    topK: 5,
  };
  const single = extractKeywords(parseDocumentRequest(body));

  for (const alpha of [0, 0.5, 1]) {
    const corpus = extractKeywordsCorpus([body], { rarityStrength: alpha, commonThreshold: 0.8 });
    assert.equal(corpus.corpusDocumentCount, 1);
    const item = corpus.results[0];
    assert.ok(item.ok);
    if (!item.ok) return;
    // 关键词（词与分数）、节点/边数、收敛信息全部一致
    assert.deepEqual(item.result.keywords, single.keywords, `α=${alpha} 排序/分数需逐位一致`);
    assert.equal(item.result.nodeCount, single.nodeCount);
    assert.equal(item.result.edgeCount, single.edgeCount);
    assert.equal(item.result.iterations, single.iterations);
    // 单篇语料（θ=0.8）下所有词覆盖率都是 1，全部判为公共词，个性列表为空
    const viewDoc = corpus.corpusView.documents[0];
    assert.ok(viewDoc.ok);
    if (viewDoc.ok) {
      assert.equal(viewDoc.distinctiveWords.length, 0);
    }
  }
});

test('关系一（视图）：N=1 且 θ<1 时唯一词是公共词；θ=1 时所有词公共，个性列表为空', () => {
  const body = { document: { sentences: [['a', 'b', 'c', 'a', 'b']] }, topK: 10 };
  const v8 = extractKeywordsCorpus([body], { rarityStrength: 1, commonThreshold: 0.8 });
  assert.deepEqual(v8.corpusView.commonWords.map((w) => w.word), ['a', 'b', 'c']);
  const doc = v8.corpusView.documents[0];
  assert.ok(doc.ok && doc.distinctiveWords.length === 0, '全部公共则个性为空');
  // 覆盖仍穷尽
  const v1 = extractKeywordsCorpus([body], { rarityStrength: 1, commonThreshold: 1 });
  assert.equal(v1.corpusView.commonWords.length, 3);
});

test('α=0：多篇语料中每篇关键词与该篇走原单篇接口完全一致', () => {
  const corpus = extractKeywordsCorpus(CORPUS_FIXTURE, { rarityStrength: 0, commonThreshold: 0.8 });
  assert.equal(corpus.corpusDocumentCount, 3);
  CORPUS_FIXTURE.forEach((b, i) => {
    const single = extractKeywords(parseDocumentRequest(b));
    const item = corpus.results[i];
    assert.ok(item.ok);
    if (item.ok) {
      assert.deepEqual(item.result.keywords, single.keywords, `第 ${i} 篇 α=0 必须等于单篇结果`);
    }
  });
});

test('稀有度确实改变排序：α=0 时背景词居首；α=1 时篇内稀有专题词反超背景词', () => {
  const a0 = extractKeywordsCorpus(CORPUS_FIXTURE, { rarityStrength: 0, commonThreshold: 0.8 });
  const a1 = extractKeywordsCorpus(CORPUS_FIXTURE, { rarityStrength: 1, commonThreshold: 0.8 });
  const i0 = a0.results[0];
  const i1 = a1.results[0];
  assert.ok(i0.ok && i1.ok);
  if (!i0.ok || !i1.ok) return;
  assert.equal(i0.result.keywords[0].word, '背景');
  assert.equal(i1.result.keywords[0].word, '专题A');
  // 背景词三篇都在 -> df=N -> 权重在两个 α 下完全相同
  const bg0 = i0.result.keywords.find((k) => k.word === '背景')!;
  const bg1 = i1.result.keywords.find((k) => k.word === '背景')!;
  assert.ok(Math.abs(bg0.score - bg1.score) < 1e-12);
});

test('关系二（服务级，固定 N）：把目标词塞进更多篇后，它在原篇的最终权重单调不增', () => {
  // 目标篇固定（baseScore 由此恒定），其余篇只用来抬高 df，N 保持不变（都成功入图）。
  const target = { document: { sentences: [['目标','x','目标','y','x','目标','z','y']] }, topK: 50 };
  const filler = { document: { sentences: [['填充','别的','填充','内容','别的','填充']] }, topK: 50 };
  // 通过把“目标”加入填充篇来抬 df（其余词与目标篇不相交，不影响目标篇内部图）
  const fillerWith = { document: { sentences: [['填充','目标','别的','填充','目标','内容','别的','填充']] }, topK: 50 };
  const N = 4;

  function weightOfTarget(withCount: number): number {
    const docs = [target];
    for (let i = 0; i < N - 1; i += 1) {
      docs.push(i < withCount ? fillerWith : filler);
    }
    const corpus = extractKeywordsCorpus(docs, { rarityStrength: 1, commonThreshold: 1 });
    assert.equal(corpus.corpusDocumentCount, N);
    const item = corpus.results[0];
    assert.ok(item.ok);
    if (!item.ok) throw new Error('target doc failed');
    return item.result.keywords.find((k) => k.word === '目标')!.score;
  }

  const w0 = weightOfTarget(0); // df=1
  const w1 = weightOfTarget(1); // df=2
  const w2 = weightOfTarget(2); // df=3
  const w3 = weightOfTarget(3); // df=4=N -> 因子=1，等于原始单篇分
  assert.ok(w0 > w1 && w1 > w2 && w2 > w3, `期望严格递减：${w0} > ${w1} > ${w2} > ${w3}`);

  // df=N 时等于该篇完全不做语料重加权的原始分
  const single = extractKeywords(parseDocumentRequest(target)).keywords.find((k) => k.word === '目标')!;
  assert.ok(Math.abs(w3 - single.score) < 1e-12);
});

test('关系二（追加新篇，N 增大）：目标词覆盖率下降时权重不得降低', () => {
  const target = { document: { sentences: [['目标','x','目标','y','x','目标']] }, topK: 50 };
  const corpus1 = extractKeywordsCorpus([target], { rarityStrength: 1, commonThreshold: 1 });
  const w1 = (corpus1.results[0] as { ok: true; result: { keywords: { word: string; score: number }[] } })
    .result.keywords.find((k) => k.word === '目标')!.score;
  const other = { document: { sentences: [['无关','别的','无关','别的','内容']] }, topK: 50 };
  const corpus2 = extractKeywordsCorpus([target, other, other, other, other], { rarityStrength: 1, commonThreshold: 1 });
  const w2 = (corpus2.results[0] as { ok: true; result: { keywords: { word: string; score: number }[] } })
    .result.keywords.find((k) => k.word === '目标')!.score;
  assert.ok(w2 > w1, '词在更大语料中更稀有，权重应上升');
});

test('关系三（服务级）：语料视图公共/个性互斥且穷尽覆盖所有成功篇入图词', () => {
  const corpus = extractKeywordsCorpus(CORPUS_FIXTURE, { rarityStrength: 1, commonThreshold: 0.8 });
  const graphWords = new Set<string>();
  // 用建图信息核对：直接收集各篇关键词不足以覆盖全部节点，这里改用语料接口的个性全集 + 公共集
  const common = new Set(corpus.corpusView.commonWords.map((w) => w.word));
  const distinctive = new Set<string>();
  corpus.corpusView.documents.forEach((d) => {
    if (d.ok) d.distinctiveWords.forEach((x) => distinctive.add(x.word));
  });
  // 与 /v1/graph 等价的节点集：对每篇跑单篇解析拿全节点
  CORPUS_FIXTURE.forEach((b) => {
    const r = extractKeywords(parseDocumentRequest({ ...b, topK: 1000 }));
    r.keywords.forEach((k) => graphWords.add(k.word));
  });
  for (const w of common) assert.ok(!distinctive.has(w), `${w} 互斥失败`);
  assert.deepEqual(
    [...new Set([...common, ...distinctive])].sort(),
    [...graphWords].sort(),
    '公共 ∪ 个性 必须恰好等于全部入图词',
  );
});

test('关系四：坏篇不进分母、不污染统计，且按提交顺序占据错误位置', () => {
  const goodA = { document: { sentences: [['共享','苹果','共享','香蕉','共享']] }, topK: 10 };
  const goodB = { document: { sentences: [['共享','橙子','共享','葡萄','共享']] }, topK: 10 };
  const goodC = { document: { sentences: [['共享','芒果','共享','梨','共享']] }, topK: 10 };
  const badValidation = { document: { sentences: [['共享', '污染']] }, damping: 1 }; // 校验错误
  const badEmpty = { document: { sentences: [['的']] }, stopwords: ['的'] }; // NO_TOKENS
  // badConverged：制造 NOT_CONVERGED（步数 1、极严阈值）
  const badConverged = { document: { sentences: [['a', 'b', 'c', 'd', 'e']] }, maxIterations: 1, tolerance: 1e-18 };

  // 提交顺序：好、坏、好、坏、好 —— N 必须为 3（坏的不进分母）
  const docs = [goodA, badValidation, goodB, badEmpty, goodC];
  const corpus = extractKeywordsCorpus(docs, { rarityStrength: 1, commonThreshold: 0.6 });
  assert.equal(corpus.corpusDocumentCount, 3);

  const { results } = corpus;
  assert.equal(results.length, 5);
  assert.ok(results[0].ok);
  assert.equal(results[1].ok, false);
  assert.equal((results[1] as { ok: false; error: { code: string } }).error.code, 'INVALID_DAMPING');
  assert.ok(results[2].ok);
  assert.equal(results[3].ok, false);
  assert.equal((results[3] as { ok: false; error: { code: string } }).error.code, 'NO_TOKENS_AFTER_FILTER');
  assert.ok(results[4].ok);

  // 视图同样按顺序占位
  const vd = corpus.corpusView.documents;
  assert.equal(vd.length, 5);
  assert.ok(vd[0].ok);
  assert.equal(vd[1].ok, false);
  assert.ok(vd[2].ok);
  assert.equal(vd[3].ok, false);
  assert.ok(vd[4].ok);

  // “污染”“的”“a/b/c…”不得出现在公共词或任何成功篇个性词中
  const common = corpus.corpusView.commonWords;
  for (const banned of ['污染', '的', 'a', 'b', 'c', 'd', 'e']) {
    assert.ok(!common.some((w) => w.word === banned), `${banned} 不应入语料统计`);
    for (const d of vd) {
      if (d.ok) assert.ok(!d.distinctiveWords.some((x) => x.word === banned), `${banned} 泄漏到个性词`);
    }
  }

  // 共享在 3 篇成功篇中出现 -> df/N = 1.0 >= 0.6 -> 公共词
  const shared = common.find((w) => w.word === '共享');
  assert.ok(shared);
  assert.equal(shared!.documentFrequency, 3);
  assert.equal(shared!.documentCount, 3);
  assert.equal(shared!.ratio, 1);

  // 对照组：去掉坏篇后结果（N=3）应与本次成功篇的稀有度统计一致。
  const clean = extractKeywordsCorpus([goodA, goodB, goodC], { rarityStrength: 1, commonThreshold: 0.6 });
  for (const [i, goodIdx] of [0, 2, 4].entries()) {
    const a = results[goodIdx];
    const b = clean.results[i];
    assert.ok(a.ok && b.ok);
    if (a.ok && b.ok) assert.deepEqual(a.result.keywords, b.result.keywords, '坏篇不得改变好篇结果');
  }
});

test('NOT_CONVERGED 的篇同样被隔离且占错误位置', () => {
  const good = { document: { sentences: [['x', 'y', 'x', 'z']] }, topK: 3 };
  const bad = { document: { sentences: [['a', 'b', 'c', 'd', 'e']] }, maxIterations: 1, tolerance: 1e-18 };
  const corpus = extractKeywordsCorpus([good, bad], { rarityStrength: 1, commonThreshold: 0.5 });
  assert.equal(corpus.corpusDocumentCount, 1);
  assert.ok(corpus.results[0].ok);
  assert.equal(corpus.results[1].ok, false);
  assert.equal(
    (corpus.results[1] as { ok: false; error: { code: string } }).error.code,
    'NOT_CONVERGED',
  );
});

test('区分度视图与单篇（重加权）关键词是两套数据，分别取用', () => {
  const corpus = extractKeywordsCorpus(CORPUS_FIXTURE, { rarityStrength: 1, commonThreshold: 0.8 });
  const item = corpus.results[0];
  const viewItem = corpus.corpusView.documents[0];
  assert.ok(item.ok && viewItem.ok);
  if (!item.ok || !viewItem.ok) return;
  // 重加权关键词包含公共背景词，个性词列表不包含
  assert.ok(item.result.keywords.some((k) => k.word === '背景'));
  assert.ok(!viewItem.distinctiveWords.some((d) => d.word === '背景'));
  // 个性词条目带独立的三字段结构
  const first = viewItem.distinctiveWords[0];
  for (const k of ['word', 'baseScore', 'rarity', 'distinctiveness'] as const) {
    assert.ok(k in first);
  }
});

test('语料参数校验：默认值、合法边界通过；越界在校验层带原因打回', () => {
  assert.deepEqual(parseCorpusRequest({ documents: [{ document: { sentences: [['a']] } }] }).corpusOptions, CORPUS_DEFAULTS);

  for (const v of [-0.0001, 1.0001, NaN, '0.5', true, null]) {
    assert.throws(
      () => parseCorpusRequest({ documents: [{ document: { sentences: [['a']] } }], rarityStrength: v }),
      (err: unknown) => err instanceof AppError && err.code === ErrorCodes.INVALID_RARITY_STRENGTH && err.field === 'rarityStrength' && err.message.length > 0,
      `rarityStrength=${String(v)} 应被拒`,
    );
  }
  for (const v of [0, -1, 1.0001, NaN, '0.8']) {
    assert.throws(
      () => parseCorpusRequest({ documents: [{ document: { sentences: [['a']] } }], commonThreshold: v }),
      (err: unknown) => err instanceof AppError && err.code === ErrorCodes.INVALID_COMMON_THRESHOLD && err.field === 'commonThreshold',
      `commonThreshold=${String(v)} 应被拒`,
    );
  }
  // 合法边界
  assert.equal(parseCorpusRequest({ documents: [{ document: { sentences: [['a']] } }], rarityStrength: 0 }).corpusOptions.rarityStrength, 0);
  assert.equal(parseCorpusRequest({ documents: [{ document: { sentences: [['a']] } }], rarityStrength: 1 }).corpusOptions.rarityStrength, 1);
  assert.equal(parseCorpusRequest({ documents: [{ document: { sentences: [['a']] } }], commonThreshold: 1 }).corpusOptions.commonThreshold, 1);
});

test('语料请求体形态非法 / 空数组 -> 顶层错误，不进入统计阶段', () => {
  assert.throws(() => parseCorpusRequest(null), (e: unknown) => e instanceof AppError && e.code === 'INVALID_REQUEST');
  assert.throws(() => parseCorpusRequest({}), (e: unknown) => e instanceof AppError && e.code === 'INVALID_REQUEST');
  assert.throws(() => parseCorpusRequest({ documents: [] }), (e: unknown) => e instanceof AppError && e.code === 'EMPTY_CONTENT');
  assert.throws(
    () => parseCorpusRequest({ documents: ['nope'] }),
    (e: unknown) => e instanceof AppError && e.code === 'INVALID_REQUEST',
  );
});

test('全部篇都失败：N=0，结果槽仍是明确错误；公共词为空且不抛异常', () => {
  const corpus = extractKeywordsCorpus(
    [
      { document: { sentences: [['的']] }, stopwords: ['的'] },
      { document: { sentences: [] } },
    ],
    { rarityStrength: 1, commonThreshold: 0.5 },
  );
  assert.equal(corpus.corpusDocumentCount, 0);
  assert.equal(corpus.results.length, 2);
  assert.equal(corpus.results[0].ok, false);
  assert.equal(corpus.results[1].ok, false);
  assert.deepEqual(corpus.corpusView.commonWords, []);
});
