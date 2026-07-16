# 知识库检索 Skill（通用版）

基于知识图谱的结构化检索。关键词匹配 → 沿图谱扩散关联文档 → 输出可解释的检索路径。

## 项目路径

```
项目根目录: 当前工作目录
搜索脚本:   src/scripts/search.js
数据:       src/data/registry.json + src/data/graph.json
```

## 搜索方法

```bash
# 关键词搜索 + 图谱扩散（默认2跳）
node src/scripts/search.js --query "关键词"

# 指定扩散深度
node src/scripts/search.js --query "关键词" --depth 3

# 从指定节点扩散
node src/scripts/search.js --node "节点ID" --depth 2

# 只匹配不扩散
node src/scripts/search.js --query "关键词" --no-expand
```

## 检索流程

1. **关键词匹配**：在 registry.json 的 title + summary + keywords 中搜索，按匹配度排序
2. **图谱扩散**：对命中的前 5 个结果，沿 graph.json 的边（硬边+软边）BFS 遍历 1-2 跳
3. **输出可解释路径**：每个结果标注检索路径——从哪个文档出发、经过哪条边、是硬边还是软边

## 结果格式

```
### 文档标题
  检索路径: 关键词命中（标题, 分数100）
  来源: /path/to/file

  关联节点（N 个）:
    [1跳] → 关联文档名 [硬边]
    [2跳] → 间接关联文档名 [软边]
```

## 边类型说明

| 类型 | 含义 | 可信度 |
|------|------|--------|
| 硬边 (explicit) | 文档作者写的显式引用 | 100% 确定 |
| 软边 (semantic) | 向量相似度 ≥ 0.8 + Agent 审查通过 | 已审查确认 |

## 注意事项

- 关键词没命中时，尝试换词或缩短
- 扩散深度 2 通常够用，深度 3 返回更多间接关联但可能不够精准
