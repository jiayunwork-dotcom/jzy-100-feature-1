# 关键词抽取服务（graph-based extraction）

把分好词的文档喂进来，服务基于**词共现图 + 类 PageRank 迭代**给每个词打分，
返回按重要度排好序的关键词及分数。基于 Fastify、TypeScript、Node.js 20 实现，
图与迭代算法全部自行实现，不依赖任何图计算/搜索引擎类第三方库。

服务无状态：不落库、不缓存，每次请求现算现还。

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

## 目录结构（按职责拆模块）

```
src/
  core/
    tokenize.ts     分词、切句、停用词过滤（唯一的停用词判断）
    graph.ts        共现图构建（滑窗、边权累加、孤立节点保留）
    rank.ts         迭代打分、收敛判定、未收敛报错
    select.ts       结果截断与排序
    errors.ts       错误码与统一错误类型
    types.ts        共享类型
  corpus/
    stats.ts        跨篇统计：df 与语料稀有度（请求内临时量）
    reweight.ts     稀有度重加权合成规则
    distinctiveness.ts 公共词/个性词划分
  services/
    validation.ts   输入校验层（非法参数不进入图构建）
    keywordService.ts  单篇流水线编排
    batchService.ts    批量调度（逐篇独立、互不影响）
    corpusService.ts   语料两趟流水线编排（独立于单篇编排）
  routes/index.ts   Fastify 接口
  server.ts         服务入口（固定端口 8080）
test/               node:test 自动化测试
Dockerfile          容器内跑测试 + 构建 + 启动
```

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

### `POST /v1/keywords/corpus` —— 语料级关键词抽取（跨篇重加权 + 区分度视图）

把一批同主题文档作为**一个语料整体**提交：第一趟逐篇复用单篇流水线
（校验 -> 分词 -> 建图 -> 迭代打分），随后基于成功篇计算跨篇统计，
第二趟再逐篇定稿（稀有度重加权 + 公共词/个性词划分）。两趟流程独立于单篇
流水线；统计量只活在单次请求内，请求结束即弃，不落库、不跨请求记账。

请求体：`{"documents": [ <单篇请求体>, ... ], "rarityStrength": λ, "commonThreshold": τ}`，
`documents` 中每篇与 `/v1/keywords` 请求体同构（各自独立校验、独立成败，
失败篇在 `results` 中按提交顺序占错误位，且不参与语料统计）。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `documents` | array | 是 | 单篇请求体数组，非空 |
| `rarityStrength` | number，闭区间 `[0,1]` | 否 | 稀有度合成强度 λ，默认 1。`0` = 完全按单篇原样；`1` = 对公共词最大惩罚 |
| `commonThreshold` | number，区间 `(0,1]` | 否 | 公共词判定门槛 τ，默认 0.8。`df/N ≥ τ` 的词判为公共词 |

规则（钉死，可被测试逐条卡住）：

- `N` = 成功完成单篇流水线的篇数（校验/算法失败的篇不进分母、不贡献 df）；
- `df(w)` = 成功篇中共现图包含 w 的篇数（篇内重复只算一篇）；
- 语料稀有度 `ρ(w) = 1 − df(w)/(N+1)`（拉普拉斯平滑，恒落在 `(0,1)`；
  单篇语料时每个词 ρ 同为 1/2，重加权退化为等比缩放，排序与单篇接口一致）；
- 最终权重 `final(w) = base(w) · (1 − λ + λ·ρ(w))`，`base` 为单篇收敛分数。
  合成因子随 df 单调不增：词被越多篇包含，其在任一篇里的权重只降不升；
- 公共词：`df(w)/N ≥ τ`，全部列入语料级 `commonWords`（df 降序、同 df 字典序）；
- 个性词：篇内非公共词按区分度 `s_d(w)·ρ(w)` 降序列入该篇 `distinctive`
  （不截断）。公共词与个性词互斥且穷尽覆盖全部入图词。

响应：

```json
{
  "results": [
    {
      "ok": true,
      "result": {
        "keywords":    [ { "word": "猫", "score": 1.011 } ],
        "distinctive": [ { "word": "猫", "score": 1.011 } ],
        "nodeCount": 4, "edgeCount": 4, "converged": true, "iterations": 31
      }
    },
    { "ok": false, "error": { "code": "NOT_CONVERGED", "message": "..." } }
  ],
  "corpus": {
    "documentCount": 2,
    "rarityStrength": 1,
    "commonThreshold": 0.8,
    "commonWords": [ { "word": "追", "documentCount": 2, "ratio": 1 } ]
  }
}
```

- `results[i].result.keywords`：该篇重加权后的关键词（与单篇接口同构，
  `score` 为最终权重）——看的是词在本篇内部的地位；
- `results[i].result.distinctive`：该篇个性词视图（区分度降序）——看的是
  “本篇突出、别篇沉默”的落差。两套视图分别取用、互不覆盖；
- `corpus.commonWords`：语料级公共词列表；`corpus.documentCount` 为参与
  统计的成功篇数 N。

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
| `INVALID_RARITY_STRENGTH` | 400 | 稀有度合成强度不在闭区间 [0, 1] |
| `INVALID_COMMON_THRESHOLD` | 400 | 公共词判定门槛不在区间 (0, 1] |
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

语料级能力（`test/corpus.test.ts`）压住需求点名的四条关系：

- **单篇退化与原接口一致**：语料只有一篇时，每个词稀有度相同，任意合成强度下
  重加权排序都与 `/v1/keywords` 完全一致（λ=0 时逐位一致）；
- **稀有度方向单调**：固定其它条件，把目标词人为塞进更多篇（df 变大），
  它在原篇的最终权重只降不升（λ=1 时精确等于 `base·(1−df/(N+1))`，严格下降）；
- **公共词与个性词互斥且穷尽**：多档门槛下，每个入图词非公共即个性，
  两个视图并起来恰好覆盖全部入图词；
- **坏篇不污染统计**：校验错误/算法错误的篇不进稀有度分母、不贡献 df，
  好篇结果与语料视图和“没有坏篇时”逐位一致，坏篇按提交顺序占错误位。

另覆盖：稀有度/合成/划分的单元规则、`rarityStrength` 与 `commonThreshold`
的取值范围校验（越界在校验层带原因打回）、默认参数、服务无跨请求状态。
