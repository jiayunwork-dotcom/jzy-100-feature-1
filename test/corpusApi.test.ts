/**
 * 语料接口 POST /v1/corpus/keywords 的 HTTP 层测试：
 *  - 语料重加权关键词 + 语料级区分度视图的响应结构；
 *  - 四条核心关系在 HTTP 链路上成立（单篇退化对齐 / 单调 / 互斥穷尽 / 坏篇隔离）；
 *  - 语料参数越界在 400 校验层被带原因打回；
 *  - 老接口行为完全不变；服务无跨请求状态。
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/routes';

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

const CORPUS = {
  documents: [
    { document: { sentences: [['背景','甲','背景','乙','专题A','丙','专题A','丁','背景','甲','背景']] }, windowSize: 2, topK: 10 },
    { document: { sentences: [['背景','丁','背景','戊','专题B','背景','丁','戊','背景']] }, windowSize: 2, topK: 10 },
    { document: { sentences: [['背景','己','专题C','背景','庚','背景','己','庚','背景']] }, windowSize: 2, topK: 10 },
  ],
  rarityStrength: 1,
  commonThreshold: 0.8,
};

test('POST /v1/corpus/keywords：返回重加权结果与语料视图，结构完整', async () => {
  const res = await post('/v1/corpus/keywords', CORPUS);
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.equal(body.corpusDocumentCount, 3);
  assert.equal(body.rarityStrength, 1);
  assert.equal(body.commonThreshold, 0.8);
  assert.equal(body.results.length, 3);
  assert.equal(body.corpusView.documents.length, 3);

  for (const r of body.results) {
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.result.keywords));
    assert.ok(r.result.nodeCount > 0);
    for (const k of r.result.keywords) {
      assert.equal(typeof k.word, 'string');
      assert.equal(typeof k.score, 'number');
    }
  }
  // 背景三篇都有 -> 公共词；专题词各自成个性
  assert.deepEqual(body.corpusView.commonWords.map((w: { word: string }) => w.word), ['背景']);
  const common = body.corpusView.commonWords[0];
  assert.equal(common.documentFrequency, 3);
  assert.equal(common.documentCount, 3);
  assert.equal(common.ratio, 1);
  for (const d of body.corpusView.documents) {
    assert.equal(d.ok, true);
    assert.ok(!d.distinctiveWords.some((x: { word: string }) => x.word === '背景'));
  }
  const d0Words = body.corpusView.documents[0].distinctiveWords.map((x: { word: string }) => x.word);
  assert.ok(d0Words.includes('专题A'));
});

test('单篇退化（HTTP）：语料接口一篇的重加权结果 == /v1/keywords 单篇结果', async () => {
  const doc = {
    document: {
      sentences: [['猫','线','球','猫','线','球','沙发','猫','线','垫子','沙发','猫']],
    },
    windowSize: 3,
    topK: 5,
  };
  const singleRes = await post('/v1/keywords', doc);
  const single = singleRes.json();

  for (const rarityStrength of [0, 0.37, 1]) {
    const corpusRes = await post('/v1/corpus/keywords', { documents: [doc], rarityStrength });
    assert.equal(corpusRes.statusCode, 200);
    const corpus = corpusRes.json();
    assert.equal(corpus.corpusDocumentCount, 1);
    assert.deepEqual(corpus.results[0].result.keywords, single.keywords);
  }
});

test('稀有度方向（HTTP）：目标词进入更多篇后权重下降', async () => {
  const target = { document: { sentences: [['目标','x','目标','y','x','目标','z','y']] }, topK: 50 };
  const plain = { document: { sentences: [['填充','别的','填充','内容','别的','填充']] }, topK: 50 };
  const withTarget = { document: { sentences: [['填充','目标','别的','填充','目标','内容','别的','填充']] }, topK: 50 };

  async function targetScore(withCount: number): Promise<number> {
    const docs = [target];
    for (let i = 0; i < 3; i += 1) docs.push(i < withCount ? withTarget : plain);
    const res = await post('/v1/corpus/keywords', { documents: docs, rarityStrength: 1, commonThreshold: 1 });
    return res.json().results[0].result.keywords.find((k: { word: string }) => k.word === '目标').score;
  }
  const w0 = await targetScore(0);
  const w1 = await targetScore(1);
  const w3 = await targetScore(3);
  assert.ok(w0 > w1 && w1 > w3, `${w0} > ${w1} > ${w3}`);
});

test('互斥且穷尽（HTTP）：公共 ∪ 个性 == 全部入图词', async () => {
  const res = await post('/v1/corpus/keywords', CORPUS);
  const body = res.json() as {
    corpusView: {
      commonWords: { word: string }[];
      documents: { distinctiveWords: { word: string }[] }[];
    };
  };
  const common = new Set<string>(body.corpusView.commonWords.map((w) => w.word));
  const distinctive = new Set<string>();
  for (const d of body.corpusView.documents) {
    for (const x of d.distinctiveWords) distinctive.add(x.word);
  }
  for (const w of common) assert.ok(!distinctive.has(w));

  const graphWords = new Set<string>();
  for (const docReq of CORPUS.documents) {
    const g = await post('/v1/graph', docReq);
    for (const n of (g.json() as { graph: { nodes: string[] } }).graph.nodes) graphWords.add(n);
  }
  assert.deepEqual([...new Set([...common, ...distinctive])].sort(), [...graphWords].sort());
});

test('坏篇隔离（HTTP）：错误篇占顺序位、不进 N、不污染统计', async () => {
  const docs = {
    documents: [
      { document: { sentences: [['共享','苹果','共享','香蕉','共享']] }, topK: 10 },
      { document: { sentences: [['共享','坏']] }, damping: 1 },
      { document: { sentences: [['共享','橙子','共享','葡萄','共享']] }, topK: 10 },
      { document: { sentences: [['的']] }, stopwords: ['的'] },
      { document: { sentences: [['a','b','c','d']] }, maxIterations: 1, tolerance: 1e-18 },
    ],
    commonThreshold: 0.6,
  };
  const res = await post('/v1/corpus/keywords', docs);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.corpusDocumentCount, 2);
  assert.equal(body.results.length, 5);
  assert.equal(body.results[0].ok, true);
  assert.equal(body.results[1].ok, false);
  assert.equal(body.results[1].error.code, 'INVALID_DAMPING');
  assert.equal(body.results[2].ok, true);
  assert.equal(body.results[3].ok, false);
  assert.equal(body.results[3].error.code, 'NO_TOKENS_AFTER_FILTER');
  assert.equal(body.results[4].ok, false);
  assert.equal(body.results[4].error.code, 'NOT_CONVERGED');

  // 视图错误位置与 results 对齐
  assert.equal(body.corpusView.documents[1].ok, false);
  assert.equal(body.corpusView.documents[1].error.code, 'INVALID_DAMPING');
  // 坏篇里的词不进统计
  assert.ok(!body.corpusView.commonWords.some((w: { word: string }) => ['坏', '的', 'a'].includes(w.word)));
});

test('语料参数越界 -> 400 校验层错误，带 field 与原因', async () => {
  const good = { documents: [{ document: { sentences: [['a', 'b']] } }] };

  const r1 = await post('/v1/corpus/keywords', { ...good, rarityStrength: 1.1 });
  assert.equal(r1.statusCode, 400);
  assert.equal(r1.json().error.code, 'INVALID_RARITY_STRENGTH');
  assert.equal(r1.json().error.field, 'rarityStrength');
  assert.ok(r1.json().error.message.includes('[0, 1]'));

  const r2 = await post('/v1/corpus/keywords', { ...good, rarityStrength: -0.01 });
  assert.equal(r2.json().error.code, 'INVALID_RARITY_STRENGTH');

  const r3 = await post('/v1/corpus/keywords', { ...good, commonThreshold: 0 });
  assert.equal(r3.statusCode, 400);
  assert.equal(r3.json().error.code, 'INVALID_COMMON_THRESHOLD');
  assert.equal(r3.json().error.field, 'commonThreshold');

  const r4 = await post('/v1/corpus/keywords', { ...good, commonThreshold: 1.01 });
  assert.equal(r4.json().error.code, 'INVALID_COMMON_THRESHOLD');
});

test('语料请求级形态错误 -> 400 顶层错误', async () => {
  assert.equal((await post('/v1/corpus/keywords', { documents: [] })).statusCode, 400);
  assert.equal((await post('/v1/corpus/keywords', {})).statusCode, 400);
  assert.equal((await post('/v1/corpus/keywords', [1, 2, 3])).statusCode, 400);
  const invalidJson = await app.inject({
    method: 'POST',
    path: '/v1/corpus/keywords',
    payload: '"x"',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(invalidJson.statusCode, 400);
  assert.equal(invalidJson.json().error.code, 'INVALID_REQUEST');
});

test('服务无跨请求状态：同一语料重复请求结果完全一致', async () => {
  const r1 = await post('/v1/corpus/keywords', CORPUS);
  const r2 = await post('/v1/corpus/keywords', CORPUS);
  assert.deepEqual(r1.json(), r2.json());
});

test('老接口行为零变化：/v1/keywords 与 /v1/keywords/batch 仍按原样返回', async () => {
  const single = await post('/v1/keywords', {
    document: { sentences: [['苹果','香蕉','苹果','香蕉','橙子','苹果']] },
    topK: 3,
  });
  assert.equal(single.statusCode, 200);
  const kws = single.json().keywords;
  assert.equal(kws[0].word, '苹果');
  // 单篇响应不含任何语料字段
  assert.equal('corpusView' in single.json(), false);
  assert.equal('corpusDocumentCount' in single.json(), false);

  const batch = await post('/v1/keywords/batch', {
    documents: [
      { document: { sentences: [['a', 'b']] } },
      { document: { sentences: [] } },
    ],
  });
  const results = batch.json().results;
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.equal(results[1].error.code, 'EMPTY_CONTENT');
});
