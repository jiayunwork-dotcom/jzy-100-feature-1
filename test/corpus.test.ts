/**
 * 语料级能力测试：跨篇稀有度重加权 + 公共词/个性词视图。
 *
 * 重点压住需求点名的四条关系：
 *   1) 单篇退化：语料只有一篇时，重加权排序与原单篇接口完全一致；
 *   2) 稀有度方向单调：词被塞进更多篇后，其在原篇的最终权重只降不升；
 *   3) 公共词与个性词互斥且穷尽覆盖全部入图词；
 *   4) 坏篇（校验错误/算法错误）不污染语料统计，且按提交顺序占错误位。
 * 另外覆盖：两个语料参数的校验边界与默认值、区分度语义、无跨请求状态。
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { computeCommonWords, computeDistinctiveWords, isCommonWord } from '../src/corpus/distinctiveness';
import { finalWeight, reweightScores } from '../src/corpus/reweight';
import { computeCorpusStats, corpusRarity } from '../src/corpus/stats';
import { AppError } from '../src/core/errors';
import { buildApp } from '../src/routes';
import { extractKeywordsCorpus } from '../src/services/corpusService';
import { extractKeywords, inspectGraph } from '../src/services/keywordService';
import { parseCorpusRequest, parseDocumentRequest } from '../src/services/validation';

// ---------------------------------------------------------------------------
// 单元：跨篇统计 / 重加权合成 / 区分度划分
// ---------------------------------------------------------------------------

test('df 统计：按篇计数，篇内重复只算一篇', () => {
  const stats = computeCorpusStats([['a', 'b', 'a'], ['b'], ['c', 'c', 'c']]);
  assert.equal(stats.documentCount, 3);
  assert.equal(stats.documentFrequency.get('a'), 1);
  assert.equal(stats.documentFrequency.get('b'), 2);
  assert.equal(stats.documentFrequency.get('c'), 1);
});

test('稀有度随 df 单调不增且恒在 (0,1)；单篇语料时所有词稀有度相同', () => {
  for (const N of [1, 2, 3, 10, 100]) {
    let prev = Infinity;
    for (let df = 1; df <= N; df += 1) {
      const rho = corpusRarity(df, N);
      assert.ok(rho > 0 && rho < 1, `rho 必须落在 (0,1): N=${N} df=${df} rho=${rho}`);
      assert.ok(rho <= prev, `rho 必须随 df 单调不增: N=${N} df=${df}`);
      prev = rho;
    }
  }
  assert.ok(corpusRarity(2, 10) < corpusRarity(1, 10), 'df 增大时 rho 严格下降');

  // 单篇语料：df 恒为 1，每个词稀有度相同（退化为等比缩放的前提）
  const stats = computeCorpusStats([['甲', '乙', '丙']]);
  const rhos = [...stats.documentFrequency.values()].map((df) => corpusRarity(df, stats.documentCount));
  assert.equal(new Set(rhos).size, 1, '单篇语料时每个词稀有度必须相同');
  assert.equal(rhos[0], 0.5);
});

test('finalWeight 合成规则：λ=0 原样、λ=1 全惩罚、随稀有度单调不减', () => {
  assert.equal(finalWeight(2, 0.5, 0), 2, 'λ=0 完全按单篇原样');
  assert.equal(finalWeight(2, 0.5, 1), 1, 'λ=1 时 final = base * rho');
  assert.equal(finalWeight(2, 0.5, 0.5), 1.5);
  assert.ok(finalWeight(2, 0.8, 0.7) > finalWeight(2, 0.2, 0.7), 'λ>0 时随稀有度严格上升');
  assert.equal(finalWeight(2, 0.8, 0), finalWeight(2, 0.2, 0), 'λ=0 时与稀有度无关');
});

test('reweightScores 逐词应用合成规则且不改入参', () => {
  const scores = new Map([['a', 2], ['b', 4]]);
  const out = reweightScores(scores, (w) => (w === 'a' ? 0.5 : 0.25), 1);
  assert.equal(out.get('a'), 1);
  assert.equal(out.get('b'), 1);
  assert.equal(scores.get('a'), 2, '入参不被修改');
  assert.equal(scores.get('b'), 4);
});

test('公共词判定边界：df/N >= τ（等号算公共）', () => {
  assert.equal(isCommonWord(3, 4, 0.75), true, '等号算公共');
  assert.equal(isCommonWord(3, 4, 0.76), false);
  assert.equal(isCommonWord(1, 1, 1), true, '单篇语料所有词都是公共词');
});

test('个性词排序体现“本篇突出、别篇沉默”的落差；公共词被排除', () => {
  // N=4，df: x=1, y=3, z=2, w=1
  const stats = computeCorpusStats([['x', 'y', 'z'], ['y'], ['z', 'y'], ['w']]);
  const scores = new Map([['x', 2], ['y', 2], ['z', 2], ['w', 0.5]]);

  // τ=0.9：没有公共词。x/y/z 篇内分数相同，排名完全由跨篇沉默度决定
  const d = computeDistinctiveWords(scores, stats, 0.9);
  assert.deepEqual(d.map((k) => k.word), ['x', 'z', 'y', 'w']);
  assert.ok(Math.abs(d[0].score - 1.6) < 1e-12); // 2 * (1 - 1/5)
  assert.ok(Math.abs(d[2].score - 0.8) < 1e-12); // 2 * (1 - 3/5)

  // τ=0.7：y（df=3，比例 0.75）被判公共，从个性列表消失
  const d2 = computeDistinctiveWords(scores, stats, 0.7);
  assert.deepEqual(d2.map((k) => k.word), ['x', 'z', 'w']);
  assert.deepEqual(computeCommonWords(stats, 0.7), [{ word: 'y', documentCount: 3, ratio: 0.75 }]);
});

// ---------------------------------------------------------------------------
// 关系一：单篇退化 —— 语料只有一篇时，排序与原单篇接口完全一致
// ---------------------------------------------------------------------------

const DOC1 = {
  document: {
    sentences: [
      ['猫','坐','在','垫子','上','猫','追','线','球','线','球','滚','到','沙发','下','猫','趴','下','休息'],
      ['垫子','很','软','线','球','很','轻','猫','喜欢','线','球','沙发','很','大','猫','在','沙发','上','睡觉'],
    ],
  },
  stopwords: [],
  topK: 5,
  damping: 0.85,
  windowSize: 3,
};

test('关系一：一篇语料的重加权排序与单篇接口完全一致（任意合成强度）', () => {
  const single = extractKeywords(parseDocumentRequest(DOC1));

  for (const rarityStrength of [0, 0.3, 0.5, 1]) {
    const res = extractKeywordsCorpus(parseCorpusRequest({ documents: [DOC1], rarityStrength }));
    assert.equal(res.corpus.documentCount, 1);
    const item = res.results[0];
    if (!item.ok) assert.fail('单篇语料不应失败');
    assert.deepEqual(
      item.result.keywords.map((k) => k.word),
      single.keywords.map((k) => k.word),
      `λ=${rarityStrength} 时关键词排序必须与单篇接口一致`,
    );
    assert.equal(item.result.nodeCount, single.nodeCount);
    assert.equal(item.result.edgeCount, single.edgeCount);
    assert.equal(item.result.iterations, single.iterations);
  }

  // λ=0 时连分数都与单篇接口逐位一致
  const zero = extractKeywordsCorpus(parseCorpusRequest({ documents: [DOC1], rarityStrength: 0 }));
  const zeroItem = zero.results[0];
  if (!zeroItem.ok) assert.fail('不应失败');
  assert.deepEqual(zeroItem.result.keywords, single.keywords);

  // 单篇语料：所有词 df/N = 1，全是公共词，个性词列表为空（语料层不凭空造词）
  const one = extractKeywordsCorpus(parseCorpusRequest({ documents: [DOC1] }));
  const oneItem = one.results[0];
  if (!oneItem.ok) assert.fail('不应失败');
  assert.equal(oneItem.result.distinctive.length, 0);
  assert.equal(one.corpus.commonWords.length, single.nodeCount);
});

// ---------------------------------------------------------------------------
// 关系二：稀有度方向单调 —— 词被塞进更多篇后，其在原篇的最终权重只降不升
// ---------------------------------------------------------------------------

const TARGET_DOC = {
  document: { sentences: [['猫','追','老鼠','猫','睡觉','猫','追','老鼠','猫','睡觉']] },
  topK: 50,
};
/** 不含目标词的填充篇；extra 用于把目标词人为塞进去 */
const filler = (extra: string[]) => ({
  document: { sentences: [['苹果','香蕉','苹果','橙子','香蕉', ...extra]] },
  topK: 50,
});
// 三份语料：唯一差别是“老鼠”被塞进了 0 / 1 / 2 篇其它文档（N 恒为 3）
const K_DF1 = [TARGET_DOC, filler([]), filler([])];
const K_DF2 = [TARGET_DOC, filler(['老鼠']), filler([])];
const K_DF3 = [TARGET_DOC, filler(['老鼠']), filler(['老鼠'])];

function targetWeightInFirstDoc(docs: unknown[], rarityStrength: number): number {
  const res = extractKeywordsCorpus(parseCorpusRequest({ documents: docs, rarityStrength }));
  const item = res.results[0];
  if (!item.ok) assert.fail('第一篇不应失败');
  const kw = item.result.keywords.find((k) => k.word === '老鼠');
  assert.ok(kw, '老鼠 必须在第一篇的关键词里');
  return kw.score;
}

test('关系二：词被塞进更多篇后，其在原篇的最终权重只降不升', () => {
  const singleA = extractKeywords(parseDocumentRequest(TARGET_DOC));
  const s = singleA.keywords.find((k) => k.word === '老鼠')!.score;

  // λ=1：精确等于 s * (1 - df/(N+1))，随 df=1,2,3 严格下降
  const w1 = targetWeightInFirstDoc(K_DF1, 1);
  const w2 = targetWeightInFirstDoc(K_DF2, 1);
  const w3 = targetWeightInFirstDoc(K_DF3, 1);
  assert.ok(Math.abs(w1 - s * 0.75) < 1e-12, `${w1} 应等于 s*0.75`);
  assert.ok(Math.abs(w2 - s * 0.5) < 1e-12, `${w2} 应等于 s*0.5`);
  assert.ok(Math.abs(w3 - s * 0.25) < 1e-12, `${w3} 应等于 s*0.25`);
  assert.ok(w1 > w2 && w2 > w3, 'λ=1 时 df 增大必须严格压低权重');

  // 任意中间强度：单调不增
  for (const rarityStrength of [0.2, 0.5, 0.9]) {
    const m1 = targetWeightInFirstDoc(K_DF1, rarityStrength);
    const m2 = targetWeightInFirstDoc(K_DF2, rarityStrength);
    const m3 = targetWeightInFirstDoc(K_DF3, rarityStrength);
    assert.ok(m1 >= m2 && m2 >= m3, `λ=${rarityStrength} 时权重只能下降或持平`);
  }

  // λ=0：完全按单篇原样，df 变化不影响
  assert.equal(targetWeightInFirstDoc(K_DF1, 0), s);
  assert.equal(targetWeightInFirstDoc(K_DF3, 0), s);
});

// ---------------------------------------------------------------------------
// 关系三：公共词与个性词互斥且穷尽覆盖全部入图词
// ---------------------------------------------------------------------------

const D1 = { document: { sentences: [['平台','红包','平台','补贴','红包']] } };
const D2 = { document: { sentences: [['平台','优惠','平台','折扣','优惠']] } };
const D3 = { document: { sentences: [['平台','红包','物流','红包','物流','优惠']] } };
const D4 = { document: { sentences: [['苹果','平台','香蕉']] } };
const ALL_DOCS = [D1, D2, D3, D4];

function checkPartition(commonThreshold: number, expectedCommon: string[], expectedDistinctive: string[][]) {
  const res = extractKeywordsCorpus(parseCorpusRequest({ documents: ALL_DOCS, commonThreshold }));
  assert.equal(res.corpus.documentCount, 4);
  assert.deepEqual(res.corpus.commonWords.map((w) => w.word), expectedCommon, '公共词列表');

  const commonSet = new Set(expectedCommon);
  const distinctiveUnion = new Set<string>();
  res.results.forEach((item, i) => {
    if (!item.ok) assert.fail(`第 ${i} 篇不应失败`);
    const words = item.result.distinctive.map((k) => k.word);
    assert.deepEqual([...words].sort(), [...expectedDistinctive[i]].sort(), `第 ${i} 篇个性词`);
    for (const w of words) {
      assert.ok(!commonSet.has(w), `${w} 既被判公共又被判个性（互斥被破坏）`);
      distinctiveUnion.add(w);
    }
  });

  // 穷尽：公共 ∪ 个性 == 全部入图词，且每个词非此即彼
  const nodeUnion = new Set<string>();
  for (const d of ALL_DOCS) {
    for (const n of inspectGraph(parseDocumentRequest(d)).graph.nodes) {
      nodeUnion.add(n);
    }
  }
  for (const w of nodeUnion) {
    assert.ok(commonSet.has(w) !== distinctiveUnion.has(w), `${w} 必须非公共即个性，不能两头不沾`);
  }
  assert.equal(commonSet.size + distinctiveUnion.size, nodeUnion.size, '两个视图合起来恰好覆盖全部入图词');
}

test('关系三：公共词与个性词互斥且穷尽覆盖（多档门槛）', () => {
  // df：平台=4，红包/优惠=2，补贴/折扣/物流/苹果/香蕉=1
  checkPartition(0.8, ['平台'], [['红包','补贴'], ['优惠','折扣'], ['红包','优惠','物流'], ['苹果','香蕉']]);
  checkPartition(0.5, ['平台','优惠','红包'], [['补贴'], ['折扣'], ['物流'], ['苹果','香蕉']]);
  checkPartition(1, ['平台'], [['红包','补贴'], ['优惠','折扣'], ['红包','优惠','物流'], ['苹果','香蕉']]);

  // 公共词条目内容：df 降序、同 df 字典序，附带篇数与比例
  const res = extractKeywordsCorpus(parseCorpusRequest({ documents: ALL_DOCS, commonThreshold: 0.5 }));
  assert.deepEqual(res.corpus.commonWords, [
    { word: '平台', documentCount: 4, ratio: 1 },
    { word: '优惠', documentCount: 2, ratio: 0.5 },
    { word: '红包', documentCount: 2, ratio: 0.5 },
  ]);
});

// ---------------------------------------------------------------------------
// 关系四：坏篇不污染语料统计，且按提交顺序占明确的错误位
// ---------------------------------------------------------------------------

const GOOD_A = { document: { sentences: [['猫','追','老鼠','猫','老鼠','沙发']] }, topK: 10 };
const GOOD_B = { document: { sentences: [['狗','啃','骨头','狗','骨头','院子']] }, topK: 10 };
const BAD_VALIDATION = { document: { sentences: [['坏词甲','坏词乙','坏词甲','坏词乙']] }, damping: 1 };
const BAD_ALGORITHM = {
  document: { sentences: [['坏词丙','坏词丁','坏词戊','坏词丙','坏词戊']] },
  maxIterations: 1,
  tolerance: 1e-18,
};
const BAD_EMPTY = { document: { sentences: [] } };

test('关系四：校验错误/算法错误的篇不进统计、不污染其它篇，且占错误位', () => {
  const base = extractKeywordsCorpus(parseCorpusRequest({ documents: [GOOD_A, GOOD_B], rarityStrength: 1 }));
  assert.equal(base.corpus.documentCount, 2);

  const mixed = extractKeywordsCorpus(
    parseCorpusRequest({
      documents: [GOOD_A, BAD_VALIDATION, GOOD_B, BAD_ALGORITHM, BAD_EMPTY],
      rarityStrength: 1,
    }),
  );
  assert.equal(mixed.results.length, 5, '结果数与提交数一致');

  // 坏篇按提交顺序占明确的错误位
  const e1 = mixed.results[1];
  const e3 = mixed.results[3];
  const e4 = mixed.results[4];
  if (e1.ok) assert.fail('第 1 篇应是错误位');
  if (e3.ok) assert.fail('第 3 篇应是错误位');
  if (e4.ok) assert.fail('第 4 篇应是错误位');
  assert.equal(e1.error.code, 'INVALID_DAMPING');
  assert.equal(e3.error.code, 'NOT_CONVERGED');
  assert.equal(e4.error.code, 'EMPTY_CONTENT');

  // 好篇结果与“没有坏篇时”逐位一致：坏篇不进分母、不贡献 df
  assert.deepEqual(mixed.results[0], base.results[0]);
  assert.deepEqual(mixed.results[2], base.results[1]);
  assert.deepEqual(mixed.corpus, base.corpus);
  assert.equal(mixed.corpus.documentCount, 2, '稀有度分母只算成功篇');

  // 坏篇的专属词没有混进语料视图
  const common = mixed.corpus.commonWords.map((w) => w.word);
  for (const bad of ['坏词甲', '坏词乙', '坏词丙', '坏词丁', '坏词戊']) {
    assert.ok(!common.includes(bad), `${bad} 不应出现在公共词里`);
  }
});

test('全部篇失败：语料视图退化（N=0、无公共词），结果全为错误位', () => {
  const res = extractKeywordsCorpus(
    parseCorpusRequest({
      documents: [
        { document: { sentences: [] } },
        { document: { sentences: [['a', 'b']] }, damping: 2 },
      ],
    }),
  );
  assert.equal(res.results.length, 2);
  assert.ok(res.results.every((r) => !r.ok));
  assert.equal(res.corpus.documentCount, 0);
  assert.deepEqual(res.corpus.commonWords, []);
});

// ---------------------------------------------------------------------------
// 区分度语义：公共词不进个性列表，每篇独有词按“突出且沉默”排序
// ---------------------------------------------------------------------------

const SEM_A = { document: { sentences: [['猫','追','老鼠','猫','老鼠','猫','沙发','猫','追','老鼠']] }, topK: 10 };
const SEM_B = { document: { sentences: [['狗','追','骨头','狗','骨头','狗','院子','狗','追','骨头']] }, topK: 10 };

test('个性词语义：全批共享词进公共列表，各篇独有词进各篇个性列表', () => {
  const res = extractKeywordsCorpus(parseCorpusRequest({ documents: [SEM_A, SEM_B] }));
  // 默认 λ=1、τ=0.8；“追”出现在全部 2 篇 -> 公共词
  assert.deepEqual(res.corpus.commonWords.map((w) => w.word), ['追']);

  const [itemA, itemB] = res.results;
  if (!itemA.ok || !itemB.ok) assert.fail('不应失败');
  assert.deepEqual(itemA.result.distinctive.map((k) => k.word).sort(), ['沙发', '猫', '老鼠'].sort());
  assert.deepEqual(itemB.result.distinctive.map((k) => k.word).sort(), ['院子', '狗', '骨头'].sort());
  // 区分度最高的是本篇最突出的独有词
  assert.equal(itemA.result.distinctive[0].word, '猫');
  assert.equal(itemB.result.distinctive[0].word, '狗');

  // 重加权关键词里公共词被压下去：猫 必须排在 追 之前
  const wordsA = itemA.result.keywords.map((k) => k.word);
  assert.equal(itemA.result.keywords[0].word, '猫');
  assert.ok(wordsA.indexOf('猫') < wordsA.indexOf('追'), '公共词 追 的权重必须被压到 猫 之后');
});

// ---------------------------------------------------------------------------
// 语料参数校验：越界在校验层带原因打回，不混到统计阶段
// ---------------------------------------------------------------------------

const DOC_MIN = { document: { sentences: [['a', 'b']] } };

function expectAppError(fn: () => unknown, code: string, field?: string) {
  assert.throws(fn, (err: unknown) => {
    if (!(err instanceof AppError)) return false;
    if (err.code !== code) return false;
    if (field !== undefined && err.field !== field) return false;
    return err.message.length > 0;
  });
}

test('rarityStrength 必须落在闭区间 [0,1]', () => {
  for (const v of [-0.1, 1.1, NaN, '0.5', null, true]) {
    expectAppError(
      () => parseCorpusRequest({ documents: [DOC_MIN], rarityStrength: v }),
      'INVALID_RARITY_STRENGTH',
      'rarityStrength',
    );
  }
  for (const v of [0, 0.5, 1]) {
    assert.equal(parseCorpusRequest({ documents: [DOC_MIN], rarityStrength: v }).rarityStrength, v);
  }
});

test('commonThreshold 必须落在区间 (0,1]', () => {
  for (const v of [0, -0.2, 1.5, NaN, '0.8', null]) {
    expectAppError(
      () => parseCorpusRequest({ documents: [DOC_MIN], commonThreshold: v }),
      'INVALID_COMMON_THRESHOLD',
      'commonThreshold',
    );
  }
  for (const v of [0.01, 0.5, 1]) {
    assert.equal(parseCorpusRequest({ documents: [DOC_MIN], commonThreshold: v }).commonThreshold, v);
  }
});

test('缺省语料参数取默认值；信封格式错误在校验层打回', () => {
  const parsed = parseCorpusRequest({ documents: [DOC_MIN] });
  assert.equal(parsed.rarityStrength, 1);
  assert.equal(parsed.commonThreshold, 0.8);
  assert.equal(parsed.documents.length, 1);

  expectAppError(() => parseCorpusRequest('nope'), 'INVALID_REQUEST');
  expectAppError(() => parseCorpusRequest({}), 'INVALID_REQUEST');
  expectAppError(() => parseCorpusRequest({ documents: [] }), 'EMPTY_CONTENT', 'documents');
  expectAppError(() => parseCorpusRequest({ documents: 'x' }), 'INVALID_REQUEST', 'documents');
  expectAppError(() => parseCorpusRequest({ documents: [42] }), 'INVALID_REQUEST', 'documents');
});

// ---------------------------------------------------------------------------
// HTTP 接口层
// ---------------------------------------------------------------------------

let app: FastifyInstance;

before(async () => {
  app = buildApp();
  await app.ready();
});

after(async () => {
  await app.close();
});

async function post(path: string, body: unknown) {
  return app.inject({ method: 'POST', path, payload: body as Record<string, never> });
}

test('POST /v1/keywords/corpus 基本结构：重加权关键词 + 个性词 + 语料视图', async () => {
  const res = await post('/v1/keywords/corpus', { documents: [SEM_A, SEM_B] });
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.equal(body.results.length, 2);
  assert.equal(body.corpus.documentCount, 2);
  assert.equal(body.corpus.rarityStrength, 1, '默认合成强度');
  assert.equal(body.corpus.commonThreshold, 0.8, '默认公共词门槛');
  assert.deepEqual(body.corpus.commonWords.map((w: { word: string }) => w.word), ['追']);

  for (const item of body.results) {
    assert.equal(item.ok, true);
    const ks = item.result.keywords;
    for (let i = 1; i < ks.length; i += 1) {
      assert.ok(ks[i - 1].score >= ks[i].score, '关键词按最终权重降序');
    }
    const ds = item.result.distinctive;
    for (let i = 1; i < ds.length; i += 1) {
      assert.ok(ds[i - 1].score >= ds[i].score, '个性词按区分度降序');
    }
    // 两套视图分别取用、互不覆盖
    assert.ok(!ds.some((d: { word: string }) => d.word === '追'), '公共词不进个性词视图');
  }
});

test('HTTP：单篇退化 —— 语料接口与 /v1/keywords 排序完全一致', async () => {
  const single = (await post('/v1/keywords', DOC1)).json();
  for (const rarityStrength of [0, 0.5, 1]) {
    const body = (await post('/v1/keywords/corpus', { documents: [DOC1], rarityStrength })).json();
    assert.deepEqual(
      body.results[0].result.keywords.map((k: { word: string }) => k.word),
      single.keywords.map((k: { word: string }) => k.word),
      `λ=${rarityStrength} 时排序必须一致`,
    );
  }
  const zero = (await post('/v1/keywords/corpus', { documents: [DOC1], rarityStrength: 0 })).json();
  assert.deepEqual(zero.results[0].result.keywords, single.keywords, 'λ=0 时逐位一致');
});

test('HTTP：稀有度方向 —— 词被塞进更多篇后权重下降', async () => {
  const weightOf = async (docs: unknown[]) => {
    const body = (await post('/v1/keywords/corpus', { documents: docs, rarityStrength: 1 })).json();
    return body.results[0].result.keywords.find((k: { word: string }) => k.word === '老鼠').score;
  };
  const w1 = await weightOf(K_DF1);
  const w2 = await weightOf(K_DF2);
  const w3 = await weightOf(K_DF3);
  assert.ok(w1 > w2 && w2 > w3, 'df 越大权重必须越低');
});

test('HTTP：坏篇不污染统计且占错误位', async () => {
  const base = (await post('/v1/keywords/corpus', { documents: [GOOD_A, GOOD_B] })).json();
  const mixed = (
    await post('/v1/keywords/corpus', { documents: [GOOD_A, BAD_ALGORITHM, GOOD_B] })
  ).json();

  assert.equal(mixed.results[1].ok, false);
  assert.equal(mixed.results[1].error.code, 'NOT_CONVERGED');
  assert.deepEqual(mixed.results[0], base.results[0]);
  assert.deepEqual(mixed.results[2], base.results[1]);
  assert.deepEqual(mixed.corpus, base.corpus);
  assert.equal(mixed.corpus.documentCount, 2);
});

test('HTTP：语料参数越界 -> 400 带原因；信封错误 -> 对应错误码', async () => {
  const r1 = await post('/v1/keywords/corpus', { documents: [DOC_MIN], rarityStrength: 2 });
  assert.equal(r1.statusCode, 400);
  assert.equal(r1.json().error.code, 'INVALID_RARITY_STRENGTH');
  assert.equal(r1.json().error.field, 'rarityStrength');
  assert.match(r1.json().error.message, /\[0, 1\]/);

  const r2 = await post('/v1/keywords/corpus', { documents: [DOC_MIN], commonThreshold: 0 });
  assert.equal(r2.statusCode, 400);
  assert.equal(r2.json().error.code, 'INVALID_COMMON_THRESHOLD');
  assert.equal(r2.json().error.field, 'commonThreshold');

  const r3 = await post('/v1/keywords/corpus', { documents: [] });
  assert.equal(r3.statusCode, 400);
  assert.equal(r3.json().error.code, 'EMPTY_CONTENT');

  const r4 = await post('/v1/keywords/corpus', {});
  assert.equal(r4.statusCode, 400);
  assert.equal(r4.json().error.code, 'INVALID_REQUEST');
});

test('无跨请求状态：语料请求重复发送结果一致，且不影响单篇接口', async () => {
  const corpusReq = { documents: [SEM_A, SEM_B], rarityStrength: 0.7 };
  const p1 = (await post('/v1/keywords/corpus', corpusReq)).json();
  const p2 = (await post('/v1/keywords/corpus', corpusReq)).json();
  assert.deepEqual(p1, p2);

  // 语料请求过后，单篇接口行为不变
  const s1 = (await post('/v1/keywords', DOC1)).json();
  const s2 = (await post('/v1/keywords', DOC1)).json();
  assert.deepEqual(s1, s2);
});
