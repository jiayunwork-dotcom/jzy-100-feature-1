# 关键词抽取服务（graph-based extraction）

把分好词的文档喂进来，服务基于**词共现图 + 类 PageRank 迭代**给每个词打分，
返回按重要度排好序的关键词及分数。基于 Fastify、TypeScript、Node.js 20 实现，
图与迭代算法全部自行实现，不依赖任何图计算/搜索引擎类第三方库。

服务无状态：不落库、不缓存，每次请求现算现还。跨篇语料统计也只活在
单次请求的生命周期内，请求结束即释放，绝不跨请求记账。

## 算法（钉死的实现）

1. **分词与停用词过滤**：输入为“已分好词的句子数组”（`string[][]`），或原始文本（按
   句读标点切句、按空白切词）。停用词在分词阶段即被滤除，全服务只有
   `src/core/tokenize.ts` 中 `StopwordFilter` 一份判断逻辑，共现图构建只消费它的输出。
2. **建图**：在每条词序列上滑动固定宽度 `windowSize` 的窗口（句尾按实际剩余截断），
   窗口内任意两个不同词之间连一条**无向边、不连自环**；同一对词多次共现时边权累加。
   窗口宽度调大时，窗口集合只增不减，因此图中边数单调不减。
3. **迭代打分**（同步迭代，初始分均为 1）：

   ```
   S_new(i) = (1 - d) + d * Σ_{j ∈ N(i)} [ w(j,i) / W(j) ] * S_old(j)
   ```

   `d` 为阻尼系数，`w(j,i)` 为边权，`W(j)` 为邻居 j 的总出边权重。
   所有词一轮内分数差的最大绝对值 `< tolerance` 时收敛；达到 `maxIterations`
   仍未收敛则直接返回 `NOT_CONVERGED` 错误，绝不返回未稳定的半成品分数。
4. **截断排序**：按分数从高到低；同分时按词的字典序升序（稳定）；
   返回数量 = `min(topK, 实际入图词数)`。

### 语料感知重加权（仅 `/v1/corpus/keywords`，老接口一行不变）

当调用方一次提交一整批同主题文档并声明"这是一个语料整体"时，服务在**不改动
上述单篇算法**的前提下，额外走一条独立的**两趟流程**（先扫全批统计、再回头
给每篇定稿），在单篇原始分上叠加跨文档稀有度调节：

```
N     = 成功入图的文档篇数（失败的篇不进分母）
df(w) = 包含词 w 的成功文档篇数（同一篇出现多次只计 1）

idfFactor(w) = ln((N + 1) / (df(w) + 1)) + 1        （恒正，且 ≤ 1）
rarity(w)    = idfFactor(w) ^ rarityStrength         （α ∈ [0, 1]）
finalWeight_d(w) = 单篇原始分_d(w) × rarity(w)
```

由公式直接钉死、且被测试逐条卡住的关系：

- **单篇退化对齐**：`N = 1` 时所有词 `df = 1`，`idfFactor = ln(2/2)+1 = 1`，
  稀有度对每个词都一样（恒为 1），重加权后的关键词与把该篇丢给
  `/v1/keywords` 的结果**逐位一致**；
- **方向单调不反**：固定 N 时 df 只增不减，`idfFactor` 与 `rarity` 只降不升，
  因此把一个词人为塞进更多篇后，它在原篇的最终权重只能**下降或持平**；
  反之扩大语料使该词更稀有时权重上升；
- **α = 0 完全原样**：`rarity` 恒为 1，多篇语料中每篇结果与其单篇接口结果一致；
  α 越接近 1，跨篇公共词被压得越狠；
- **满批词不被加码**：`df = N` 时稀有度恒为 1，其权重只由本篇地位决定。

**语料级区分度视图**（与单篇关键词两码事，分别取用、互不覆盖）：

```
公共词 common     ：df(w) / N >= commonThreshold（θ ∈ (0, 1]，默认 0.8）
个性词 distinctive ：其余全部入图词，归属到每一个包含它的篇
区分度_d(w)       = 单篇原始分_d(w) × rarity(w)   （本篇突出 × 别篇沉默）
```

公共词单列并按覆盖率降序；每篇个性词按区分度降序。**公共词与个性词互斥，且
二者并集恰好穷尽所有成功篇图中的入图词**——一个词不会既是公共又是个性，也
不会两头不沾而消失。个性词不要求只在一篇出现：未达公共门槛的词可同时出现在
多篇的个性列表中。

**坏篇隔离**：某篇触发校验错误或算法错误（含 `NOT_CONVERGED`）时，该篇不进
分母 N、不贡献任何 df、不改变其它篇结果，但仍按提交顺序在 `results` 与
`corpusView.documents` 中占一个明确的错误位置（`ok:false` + 错误码）。

## 目录结构（按职责拆模块）

```
src/
  core/
    tokenize.ts        分词、切句、停用词过滤（唯一的停用词判断）
    graph.ts           共现图构建（滑窗、边权累加、孤立节点保留）
    rank.ts            迭代打分、收敛判定、未收敛报错
    select.ts          结果截断与排序
    corpusStats.ts     语料文档频次统计（两趟流程·第一趟，df/N）
    rarity.ts          稀有度因子与单篇分数重加权（两趟流程·第二趟）
    discriminative.ts  公共词/个性词划分与区分度视图（两趟流程·第二趟）
    errors.ts          错误码与统一错误类型
    types.ts           共享类型
  services/
    validation.ts      输入校验层（非法参数不进入图构建/语料统计）
    keywordService.ts  单篇流水线编排（语料流程复用同一底层分析）
    batchService.ts    批量调度（逐篇独立、互不影响）
    corpusService.ts   语料两趟编排（扫全批统计 -> 逐篇重加权定稿）
  routes/index.ts   Fastify 接口
  server.ts         服务入口（固定端口 8080）
test/               node:test 自动化测试
Dockerfile          容器内跑测试 + 构建 + 启动
```

`core/` 下分词、建图、迭代打分三个钉死模块新老接口共用，语料能力只做叠加，
核心算法一处未改、未另起炉灶。

## 本地运行

```bash
npm install
npm test            # 类型检查 + 全部自动化测试
npm run build
npm start           # 监听 0.0.0.0:8080
# 或开发模式：npm run dev
```

## Docker

```bash
docker build -t keyword-service .      # 构建过程中会在容器内执行 npm test
docker run --rm -p 8080:8080 keyword-service
```

镜像启动后接口绑定在固定端口 **8080**。

## 接口

### `POST /v1/keywords` —— 单篇关键词抽取

请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `document.sentences` | `string[][]` | 二选一 | 已分好词的句子，每个词是字符串 |
| `document.text` | `string` | 二选一 | 原始文本，服务内部分句、分词 |
| `stopwords` | `string[]` | 否 | 停用词表，默认空 |
| `windowSize` | integer ≥ 2 | 否 | 滑动窗口宽度，默认 2 |
| `damping` | number，开区间 `(0,1)` | 否 | 阻尼系数，默认 0.85 |
| `topK` | integer ≥ 1 | 否 | 返回词数上限，默认 10 |
| `tolerance` | number > 0 | 否 | 收敛阈值，默认 1e-6 |
| `maxIterations` | integer ≥ 1 | 否 | 步数上限，默认 200 |

同时给出 `sentences` 与 `text` 时优先使用 `sentences`。

请求示例：

```bash
curl -s -X POST localhost:8080/v1/keywords \
  -H 'content-type: application/json' \
  -d '{
    "document": {"sentences": [["排序","算法","迭代","算法","排序","收敛","算法","图","迭代","排序"]]},
    "stopwords": [],
    "windowSize": 3,
    "damping": 0.85,
    "topK": 4
  }'
```

响应：

```json
{
  "keywords": [
    { "word": "算法", "score": 1.3590227561119823 },
    { "word": "排序", "score": 1.212894630363191 },
    { "word": "迭代", "score": 1.06644094472292 },
    { "word": "图",   "score": 0.6812928378532241 }
  ],
  "nodeCount": 5,
  "edgeCount": 9,
  "converged": true,
  "iterations": 17
}
```

### `POST /v1/graph` —— 只分词 + 建图（不跑迭代打分）

请求参数同上。返回过滤停用词后的分词结果，以及共现图的节点与带权边，
便于调用方核对图结构：

```json
{
  "graph": {
    "nodes": ["橙子", "苹果", "香蕉"],
    "edges": [
      { "source": "橙子", "target": "香蕉", "weight": 1 },
      { "source": "苹果", "target": "香蕉", "weight": 2 }
    ]
  },
  "tokenizedSentences": [["苹果","香蕉","苹果"], ["香蕉","橙子"]],
  "nodeCount": 3,
  "edgeCount": 2
}
```

### `POST /v1/keywords/batch`、`POST /v1/graph/batch` —— 批量

请求体形如 `{"documents": [ <单篇请求体>, ... ]}`。各篇独立解析、独立建图、
独立迭代，某一篇失败只在该篇结果项中体现，不影响其它篇；结果顺序与提交顺序一致：

```json
{
  "results": [
    { "ok": true, "result": { "keywords": [ ... ], "nodeCount": 3, "...": "..." } },
    { "ok": false, "error": { "code": "INVALID_DAMPING", "message": "damping: ...", "field": "damping" } }
  ]
}
```

### `POST /v1/corpus/keywords` —— 语料感知关键词（跨篇稀有度 + 区分度视图）

请求体形如：

```json
{
  "documents": [ <单篇请求体>, <单篇请求体>, "..."],
  "rarityStrength": 1.0,
  "commonThreshold": 0.8
}
```

- `documents`：非空数组，每个元素是与 `/v1/keywords` 完全相同的单篇请求体
  （可各自带 `document` / `stopwords` / `windowSize` / `damping` / `topK` 等）；
  逐篇按单篇规则解析，某篇失败只影响它自己的结果项；
- `rarityStrength`（α）：可选，闭区间 **[0, 1]**，默认 `1`。
  `0` = 完全按单篇原样（稀有度恒为 1），越大对跨篇公共词惩罚越重。
  越界返回 `INVALID_RARITY_STRENGTH`（400，带字段名与原因）；
- `commonThreshold`（θ）：可选，开区间 **(0, 1]**，默认 `0.8`。
  词的成功篇覆盖率 `df/N >= θ` 判为公共词。
  越界返回 `INVALID_COMMON_THRESHOLD`（400）。

两个语料参数都在**校验层**拦下，越界不会进入任何统计阶段。

响应（`results` 与 `corpusView.documents` 均与提交顺序一一对齐）：

```json
{
  "results": [
    {
      "ok": true,
      "result": {
        "keywords": [ { "word": "专题A", "score": 2.2139 }, "..."],
        "nodeCount": 6, "edgeCount": 9, "converged": true, "iterations": 17
      }
    },
    { "ok": false, "error": { "code": "INVALID_DAMPING", "message": "...", "field": "damping" } }
  ],
  "corpusView": {
    "commonWords": [
      { "word": "背景", "documentFrequency": 3, "documentCount": 3, "ratio": 1 }
    ],
    "documents": [
      { "ok": true, "distinctiveWords": [
        { "word": "专题A", "baseScore": 1.3075, "rarity": 1.693, "distinctiveness": 2.2139 }
      ]},
      { "ok": false, "error": { "code": "INVALID_DAMPING", "message": "...", "field": "damping" } }
    ]
  },
  "corpusDocumentCount": 2,
  "rarityStrength": 1,
  "commonThreshold": 0.8
}
```

- `results[*].result.keywords` 是该篇**重加权后**的关键词（`score` 即最终权重），
  排序/截断规则与单篇接口一致；
- `corpusView` 是**语料级问题**的答案：`commonWords` 单列跨篇公共词，
  `documents[*].distinctiveWords` 是各篇个性词（含 `baseScore` / `rarity` /
  `distinctiveness`，按区分度降序），失败篇为 `ok:false` 错误位置；
- `corpusDocumentCount` 是真正参与统计的成功篇数 N。

### `GET /health`

返回 `{"status":"ok"}`。

## 错误码

错误响应统一为 `{"error": {"code", "message", "field?"}}`：

| code | HTTP | 含义 |
| --- | --- | --- |
| `INVALID_REQUEST` | 400 | 请求体/字段类型非法（格式问题） |
| `EMPTY_CONTENT` | 400 | 提交的内容本身为空（缺字段、空数组、空白文本） |
| `INVALID_WINDOW_SIZE` | 400 | 窗口宽度不是 ≥ 2 的整数 |
| `INVALID_DAMPING` | 400 | 阻尼系数不在开区间 (0, 1) |
| `INVALID_TOP_K` | 400 | 返回词数不是 ≥ 1 的整数 |
| `INVALID_TOLERANCE` | 400 | 收敛阈值不是 > 0 的数 |
| `INVALID_MAX_ITERATIONS` | 400 | 步数上限不是 ≥ 1 的整数 |
| `INVALID_RARITY_STRENGTH` | 400 | 语料稀有度合成强度 α 不在闭区间 [0, 1] |
| `INVALID_COMMON_THRESHOLD` | 400 | 公共词判定门槛 θ 不在开区间 (0, 1] |
| `NO_TOKENS_AFTER_FILTER` | 422 | 内容非空，但分词并过滤停用词后一个词都不剩（含全停用词退化情形） |
| `NOT_CONVERGED` | 422 | 达到步数上限仍未收敛 |

注意 `EMPTY_CONTENT`（内容/格式问题）与 `NO_TOKENS_AFTER_FILTER`（有内容但全被过滤）
是两个不同错误码，调用方可据此区分。

## 测试重点

`npm test` 覆盖（其中三条为需求点名的关系，可直接被测试验证）：

- **反复插入词分数不降**：同一文档只人为增加目标词出现次数（不改变其它词位置关系），
  在多种阻尼系数（0.7/0.85/0.9）与窗口（2/3/5）组合下，目标词分数严格上升
  （`test/core.test.ts` 中“关系一”两个夹具）；
- **全停用词报错**：分词结果为空、图节点/边数为 0，服务返回 `NO_TOKENS_AFTER_FILTER`；
- **阻尼趋零分数趋同**：`damping=1e-8` 时所有入图词分数趋近 1，
  剩余差异在浮点误差量级；
- 窗口宽度只调大时边数持平或增多；返回数量 = `min(topK, 节点数)`；
  分数降序、同分字典序；未收敛报错；批量逐篇隔离；建图接口不含分数；
  停用词在分词结果与图中都不出现（同一过滤逻辑）。

`test/corpus.test.ts` 与 `test/corpusApi.test.ts` 专门钉住语料能力的四条关系：

- **单篇退化与原接口一致**：语料只有一篇时，任意 α 下重加权关键词（词序与分数）
  与 `/v1/keywords` 逐位相等；α=0 时多篇语料的每一篇也与各自单篇结果一致；
- **稀有度方向单调**：纯函数级覆盖全部 α 与 df 相邻取值；服务级构造夹具验证
  固定 N 下把目标词塞进 0/1/2/3 篇后其权重严格递减、df=N 时回到原始单篇分，
  以及扩大语料（词变稀有）时权重上升；
- **公共词与个性词互斥且穷尽**：公共集 ∩ 个性集为空，二者并集恰好等于全部
  成功篇的入图词（节点由 `/v1/graph` 独立核对）；
- **坏篇不污染统计**：校验错误 / `NO_TOKENS_AFTER_FILTER` / `NOT_CONVERGED`
  三类坏篇都不进 `corpusDocumentCount`、不贡献 df、坏篇用词不出现在公共/个性
  列表，且在 `results` 与 `corpusView.documents` 中按提交顺序占错误位置；
  去掉坏篇后好篇结果与混入坏篇时完全一致。

另覆盖：α=1 时篇内稀有专题词可反超满篇背景词、区分度视图与重加权关键词结构
分离、语料参数越界在 400 校验层带 `field`/原因打回、语料请求无跨请求状态。
