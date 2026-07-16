# 知识库扩充工作流 Skill（通用版）

## 概述

将一篇文档加入知识图谱的完整流程。程序化的步骤调脚本执行（观察 output 确认成功），需要语义判断的步骤由 Agent 处理。

## 项目路径

```
项目根目录: 当前工作目录
脚本目录:   src/scripts/
数据产物:   src/data/
向量库:     src/db/
可视化工具: tools/
知识库:     知识库/
查表文件:   硬链接查表.md
```

## 前置依赖

- **Python 3**：必须用 `python3`（不是 `python`）
- **sentence_transformers**：`pip install sentence-transformers numpy`
- **M3E 模型**：放在 `models/m3e-base` 目录（需自行下载），或缺省自动从 HuggingFace 下载
- **Node.js**：运行 JS 脚本

## 可用脚本速查

| 脚本 | 命令 | 用途 |
|------|------|------|
| `registry-builder.js` | `--full` / `--incremental --index <path>` | 扫描索引文档 → registry.json |
| `edge-resolver.js` | `--full` / `--incremental --index <path>` | 硬边解析 → hard-edges.json |
| `link-archiver.js` | `--url ... --title ... --source ...` / `--update-status ...` | 硬链接归档到查表 |
| `embed.py` | `embed` / `search` / `rebuild` | M3E 向量化 + SQLite 检索 |
| `graph-generator.js` | `--full` / `--incremental --index <path>` / `--merge-soft-edges <file>` | 组装 graph.json |
| `clean-reviewed-edges.js` | （无参数） | 清理已删除节点的软边记录 |
| `graph-to-md.js` | （无参数） | graph.json → 知识图谱-总索引地图.md |
| `build-graph-view.js` | （无参数） | graph.json → graph.html |

## 增量新增流程

### Step 1: 读取文档

直接 `Read` 本地文件。如果是网页文档，用 `WebFetch` 获取内容。

### Step 2: 提取所有出链

正则提取**明文 URL**（`https?://[^\s,\"\]]+`）和**本地路径**（绝对路径或以 `./` 开头的相对路径）。

### Step 3: 链接查表 + 归档

读 `硬链接查表.md`，对每个出链：
- 已注册 → 标注节点 ID
- 新链接 → `node src/scripts/link-archiver.js --url "{url}" --title "{标题}" --source "{源文档}"`
- 本地路径也归档（`--url` 填路径）

### Step 4: 写索引文档 + 落盘

按标准结构写 `.md` 文件，放入 `知识库/` 目录。

### Step 5: 注册节点

```bash
node src/scripts/registry-builder.js --incremental --index "{落盘的相对路径}"
```

### Step 6: 建硬边

```bash
node src/scripts/edge-resolver.js --incremental --index "{落盘的相对路径}"
```

### Step 7: 向量化 + 候选检索

```bash
python3 src/scripts/embed.py embed --id "{nodeId}" --title "{标题}" --text "{元数据拼接文本}"
python3 src/scripts/embed.py search --id "{nodeId}" --topk 15 --threshold 0.8
```

### Step 8: Agent 审查候选

对每个候选对 (N, M)，读双方索引文档的元数据和正文摘要，判断是否真有关联。

**审查标准（严格执行）**：
- **只通过高度相关的候选**：两篇文档在主题、技术方案、工作流程上有明确的协同或依赖关系
- **不能因置信度偏低就默认无关**
- **也不能因置信度高就默认通过**
- **reason 必须具体**

结果追加到 `src/data/reviewed-edges.json`（支持断点续审）。

### Step 9: 更新图谱

```bash
node src/scripts/graph-generator.js --incremental --index "{落盘的相对路径}"
node src/scripts/graph-generator.js --merge-soft-edges src/data/reviewed-edges.json
node tools/build-graph-view.js
```

### Step 10: 生成总索引地图

```bash
node src/scripts/graph-to-md.js
```

### Step 11: 输出报告

索引文档路径 + X 条硬边 + Y 条软边候选 → Z 条审查通过 + 待索引队列。

## 全量重建模式

```bash
node src/scripts/registry-builder.js --full
node src/scripts/edge-resolver.js --full
python3 src/scripts/embed.py rebuild --registry src/data/registry.json
# 遍历所有节点 search，过滤 similarity≥0.8，去重，去硬边对 → src/data/candidates.json
# Agent 分批审查，孤立节点优先，每批 30-50 对
node src/scripts/graph-generator.js --full
node src/scripts/graph-generator.js --merge-soft-edges src/data/reviewed-edges.json
node tools/build-graph-view.js
node src/scripts/graph-to-md.js
```

## 删除模式

```bash
# 1. 删除索引文件
# 2. 全量重建
node src/scripts/registry-builder.js --full
node src/scripts/edge-resolver.js --full
node src/scripts/clean-reviewed-edges.js
python3 src/scripts/embed.py rebuild --registry src/data/registry.json
node src/scripts/graph-generator.js --full
node src/scripts/graph-generator.js --merge-soft-edges src/data/reviewed-edges.json
node tools/build-graph-view.js
node src/scripts/graph-to-md.js
```

## 索引文档标准结构

```markdown
# 索引文档：{标题}

## 元数据

- **来源路径**: {文件路径或URL}
- **文档类型**: {A表格/B正文/C目录/D索引/F本地}
- **内容概要**: {一句话摘要}
- **关键信息**:
  - {要点1}
  - {要点2}
- **适用场景**:
  - {场景1}

## 正文结构化摘要
{结构化提炼}

## 子文档链接探测
| 链接 | 类型 | 已注册节点ID |
|------|------|-------------|
| {url} | 网页 | `nodeId` |

## 关联子索引
| 子索引 | 节点ID | 来源文档 |
|--------|--------|---------|
| {引用名} | `{nodeId}` | {上下文} |
```

## 关键阈值

| 参数 | 值 |
|------|-----|
| 软边候选阈值 | similarity ≥ 0.8 |
| 软边 top-K | 15 |
| 全量审查批量 | 30-50 对/批 |

## 注意事项

- 向量化文本来自 `## 元数据` 段（内容概要+关键信息+适用场景），不是全文
- 审查必须读双方索引文档内容，不能只看标题
- 所有脚本支持重复执行，增量模式自动去重
- reviewed-edges.json 支持跨会话断点续审
