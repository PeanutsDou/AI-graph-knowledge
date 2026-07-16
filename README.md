# AI Graph Knowledge — 基于知识图谱的 AI 知识库构建与检索工具

把本地文档转化为结构化知识图谱，支持图检索（比纯向量 RAG 更可解释、更准确）。

打开 `graph.html` 可以查看当前知识图谱的可视化效果。

## 特性

- 📝 **索引文档**: 把任意文档（Markdown/PDF/网页内容）转化为标准化的索引文档
- 🔗 **知识图谱**: 自动构建硬边（显式引用）+ 软边（向量相似度 + Agent 审查）
- 🔍 **图检索**: 关键词匹配 → 图谱扩散 → 可解释检索路径
- 📊 **可视化**: 力向图可视化（`graph.html`）+ 总索引地图（Markdown）
- 🤖 **AI 工作流**: Agent 负责索引构建 + 软边审查，脚本负责程序化操作

## 快速开始

### 1. 准备工作

```bash
# 安装 Python 依赖
pip install sentence-transformers numpy

# 安装 Node.js（运行 JS 脚本）
# 下载地址: https://nodejs.org/
```

### 2. 下载 M3E 模型

```bash
# 在项目根目录创建 models 目录
mkdir models

# 方式1: 使用 git-lfs 下载
cd models
git clone https://huggingface.co/moka-ai/m3e-base

# 方式2: 首次运行 embed.py 时自动下载
# SentenceTransformer("moka-ai/m3e-base") 会自动下载到 ~/.cache/huggingface/
# 下载后可以移动到 models/m3e-base 以便离线使用
```

### 3. 创建索引文档

参考 `知识库/001_示例索引节点.md`，为你的文档创建标准化的索引文档。

每篇索引文档包含：
- **元数据**: 来源路径、文档类型、内容概要、关键信息、适用场景
- **正文结构化摘要**: 按层级提炼的核心内容
- **子文档链接探测**: 文档中引用的所有外链
- **关联子索引**: 与其他索引文档的引用关系

### 4. 构建知识图谱

```bash
# 全量重建
node src/scripts/registry-builder.js --full           # 扫描索引文档 → registry.json
node src/scripts/edge-resolver.js --full              # 硬边解析 → hard-edges.json
python3 src/scripts/embed.py rebuild                  # 全量向量化
node src/scripts/graph-generator.js --full            # 生成 graph.json
node tools/build-graph-view.js                        # 生成 graph.html
node src/scripts/graph-to-md.js                       # 生成 知识图谱-总索引地图.md
```

### 5. 图谱检索

```bash
# 关键词搜索 + 图谱扩散（默认 2 跳）
node src/scripts/search.js --query "关键词"

# 从指定节点扩散
node src/scripts/search.js --node "节点ID" --depth 2
```

## 项目结构

```
AI-graph-knowledge/
├── src/scripts/                    # 管线脚本
│   ├── registry-builder.js         # 扫描索引文档 → registry.json
│   ├── edge-resolver.js            # 硬边解析 → hard-edges.json
│   ├── graph-generator.js          # 组装 graph.json
│   ├── embed.py                    # M3E 向量化 + SQLite 检索
│   ├── search.js                   # 图谱检索
│   ├── clean-reviewed-edges.js     # 清理已删除节点的软边
│   ├── graph-to-md.js             # graph.json → 总索引地图.md
│   └── link-archiver.js            # 硬链接查表管理
├── tools/                          # 可视化工具
│   ├── build-graph-view.js         # graph.json → graph.html
│   └── template.html               # 图谱前端模板
├── skills/                         # AI Skill（供 AI Agent 使用）
│   ├── kb-generator/               # 知识库扩充工作流
│   └── kb-searcher/                # 知识库检索
├── 知识库/                         # 放索引文档的地方
├── models/                         # M3E 模型（自行下载）
├── graph.html                      # 图谱可视化（打开即可查看）
├── README.md
└── LICENSE
```

## 索引文档标准结构

```markdown
# 索引文档：{标题}

## 元数据

- **来源路径**: `{文件路径或URL}`
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

## 工作流

### 增量新增（加一篇文档）
1. 创建索引文档 → 2. 落盘到 `知识库/` → 3. 注册节点 → 4. 建硬边 → 5. 向量化 → 6. Agent 审查软边 → 7. 更新图谱 → 8. 生成总索引地图

### 全量重建
从头重建整个知识图谱，包括硬边、向量化、软边候选生成和 Agent 审查。

### 删除清理
删除过期文档后，执行全量重建 + 清理软边记录。

## License

MIT
