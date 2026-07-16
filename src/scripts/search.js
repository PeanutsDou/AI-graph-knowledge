// search.js — 知识图谱检索
// 关键词匹配 → 图谱扩散 → 可解释路径输出
//
// 用法:
//   node src/scripts/search.js --query "shader源代码拉取"          关键词搜索 + 图谱扩散
//   node src/scripts/search.js --query "shader" --depth 3          指定扩散深度（默认2）
//   node src/scripts/search.js --node "wvvv5nae:xxx"               从指定节点扩散
//   node src/scripts/search.js --query "shader" --no-expand       只匹配不扩散

const fs = require('fs');
const path = require('path');

const BASE = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = path.join(BASE, 'src', 'data', 'registry.json');
const GRAPH_PATH = path.join(BASE, 'src', 'data', 'graph.json');

// ---- 加载数据 ----

function loadData() {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
  const graph = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf-8'));
  const nodes = registry.nodes || [];
  const regMap = {};
  nodes.forEach(n => { regMap[n.id] = n; });

  // 合并 graph 节点（可能有额外的 indexFile 等信息）
  const graphNodes = graph.nodes || [];
  graphNodes.forEach(n => {
    if (!regMap[n.id]) regMap[n.id] = n;
    else {
      // 合并字段
      Object.assign(regMap[n.id], n);
    }
  });

  // 构建邻接表（双向）
  const adjacency = {};
  (graph.edges || []).forEach(e => {
    if (!adjacency[e.from]) adjacency[e.from] = [];
    if (!adjacency[e.to]) adjacency[e.to] = [];
    adjacency[e.from].push({ to: e.to, type: e.type || 'explicit', name: e.name, context: e.context, direction: 'out' });
    adjacency[e.to].push({ to: e.from, type: e.type || 'explicit', name: e.name, context: e.context, direction: 'in' });
  });

  return { regMap, adjacency, nodes: Object.values(regMap), edges: graph.edges || [] };
}

// ---- 关键词匹配 ----

function searchByKeyword(nodes, query) {
  const q = query.toLowerCase();
  const tokens = q.split(/[\s,，、]+/).filter(t => t.length > 0);

  const results = [];
  for (const n of nodes) {
    const title = (n.title || '').toLowerCase();
    const summary = (n.summary || '').toLowerCase();
    const keywords = (n.keywords || []).join(' ').toLowerCase();
    const id = (n.id || '').toLowerCase();

    let score = 0;
    let matchedField = '';

    // 标题精确包含
    if (title.includes(q)) {
      score = 100;
      matchedField = '标题';
    } else {
      // 分词匹配
      let titleHits = 0, summaryHits = 0, kwHits = 0;
      for (const t of tokens) {
        if (title.includes(t)) titleHits++;
        if (summary.includes(t)) summaryHits++;
        if (keywords.includes(t)) kwHits++;
      }
      if (titleHits > 0) {
        score = 60 + titleHits * 10;
        matchedField = '标题(分词)';
      } else if (kwHits > 0) {
        score = 40 + kwHits * 10;
        matchedField = '关键词';
      } else if (summaryHits > 0) {
        score = 30 + summaryHits * 5;
        matchedField = '摘要';
      }
    }

    if (score > 0) {
      results.push({ node: n, score, matchedField });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ---- 图谱扩散（BFS，收集路径） ----

function expandFromNode(startId, adjacency, regMap, depth) {
  const visited = new Map(); // nodeId → { path: [...], distance: 0 }
  visited.set(startId, { path: [{ id: startId, title: regMap[startId]?.title || startId, type: 'start' }], distance: 0 });

  const queue = [{ id: startId, distance: 0, path: [{ id: startId, title: regMap[startId]?.title || startId, type: 'start' }] }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current.distance >= depth) continue;

    const neighbors = adjacency[current.id] || [];
    for (const edge of neighbors) {
      if (visited.has(edge.to)) continue;

      const targetNode = regMap[edge.to];
      if (!targetNode) continue;

      const newPath = [...current.path, {
        id: edge.to,
        title: targetNode.title || edge.to,
        type: edge.type,
        edgeName: edge.name,
        edgeContext: edge.context,
        direction: edge.direction
      }];
      visited.set(edge.to, { path: newPath, distance: current.distance + 1 });
      queue.push({ id: edge.to, distance: current.distance + 1, path: newPath });
    }
  }

  // 移除起点
  visited.delete(startId);
  return visited;
}

// ---- 格式化输出 ----

function formatResult(entry, regMap) {
  const n = entry.node;
  const lines = [];

  lines.push(`### ${n.title || n.id}`);
  lines.push(`  检索路径: 关键词命中（${entry.matchedField}, 分数${entry.score}）`);
  if (n.source) lines.push(`  来源: ${n.source}`);
  if (n.summary) lines.push(`  摘要: ${n.summary.substring(0, 150)}`);

  // 图谱扩散结果
  if (entry.expansion && entry.expansion.size > 0) {
    lines.push(`  关联节点（${entry.expansion.size} 个）:`);
    const sorted = [...entry.expansion.entries()].sort((a, b) => a[1].distance - b[1].distance);
    for (const [nid, info] of sorted.slice(0, 15)) {
      const pathStr = info.path.slice(1).map(p => {
        const arrow = p.direction === 'in' ? '←' : '→';
        const edgeLabel = p.edgeName ? `(${p.edgeName})` : '';
        const typeLabel = p.type === 'semantic' ? ' [软边]' : ' [硬边]';
        return `${arrow} ${p.title}${edgeLabel}${typeLabel}`;
      }).join(' ');
      lines.push(`    [${info.distance}跳] ${pathStr}`);
      const targetNode = regMap[nid];
      if (targetNode?.source) lines.push(`      链接: ${targetNode.source}`);
    }
  }

  return lines.join('\n');
}

// ---- 主逻辑 ----

function main() {
  const args = process.argv.slice(2);
  const data = loadData();

  let query = null, startNodeId = null, depth = 2, noExpand = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--query' && args[i+1]) { query = args[++i]; }
    else if (args[i] === '--node' && args[i+1]) { startNodeId = args[++i]; }
    else if (args[i] === '--depth' && args[i+1]) { depth = parseInt(args[++i]); }
    else if (args[i] === '--no-expand') { noExpand = true; }
  }

  let results = [];

  if (startNodeId) {
    // 从指定节点扩散
    const node = data.regMap[startNodeId];
    if (!node) {
      console.log(`未找到节点: ${startNodeId}`);
      process.exit(1);
    }
    results.push({ node, score: 100, matchedField: '指定节点' });
  } else if (query) {
    // 关键词搜索
    results = searchByKeyword(data.nodes, query);
    if (results.length === 0) {
      console.log(`未找到匹配 "${query}" 的文档`);
      process.exit(0);
    }
  } else {
    console.log('用法: node search.js --query "关键词" [--depth N] [--no-expand]');
    console.log('      node search.js --node "节点ID" [--depth N]');
    process.exit(1);
  }

  // 图谱扩散
  if (!noExpand) {
    for (const r of results.slice(0, 5)) { // 只对前5个命中结果扩散
      r.expansion = expandFromNode(r.node.id, data.adjacency, data.regMap, depth);
    }
  }

  // 输出
  console.log(`\n${'='.repeat(60)}`);
  console.log(`搜索: "${query || startNodeId}"`);
  console.log(`命中: ${results.length} 个文档${!noExpand ? ` (扩散深度 ${depth})` : ' (不扩散)'}`);
  console.log(`${'='.repeat(60)}\n`);

  results.slice(0, 10).forEach((r, i) => {
    console.log(formatResult(r, data.regMap));
    console.log('');
  });

  // 输出 JSON 供脚本解析
  if (args.includes('--json')) {
    const jsonOut = results.slice(0, 10).map(r => ({
      id: r.node.id,
      title: r.node.title,
      source: r.node.source,
      summary: r.node.summary,
      score: r.score,
      matchedField: r.matchedField,
      expansion: r.expansion ? [...r.expansion.entries()].map(([nid, info]) => ({
        id: nid,
        title: data.regMap[nid]?.title,
        source: data.regMap[nid]?.source,
        distance: info.distance,
        path: info.path.map(p => ({ id: p.id, title: p.title, type: p.type, edgeName: p.edgeName, direction: p.direction }))
      })) : []
    }));
    console.log('---JSON---');
    console.log(JSON.stringify(jsonOut, null, 2));
  }
}

main();
