// graph-to-md.js
// 将 graph.json 转化为可读的文字文档（Markdown），输出到项目根目录
// 包含：统计概览、节点目录（按分类）、边关系表
//
// 用法: node src/scripts/graph-to-md.js

const fs = require('fs');
const path = require('path');

const BASE = path.resolve(__dirname, '..', '..');
const GRAPH_PATH = path.join(BASE, 'src', 'data', 'graph.json');
const OUT_PATH = path.join(BASE, 'G66知识图谱-总索引地图.md');

function esc(s) {
  if (!s) return '';
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function main() {
  const graph = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf-8'));
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];

  // 构建邻接表
  const outEdges = {};  // from → [{to, name, context, type}]
  const inEdges = {};   // to → [{from, name, context, type}]
  edges.forEach(e => {
    if (!outEdges[e.from]) outEdges[e.from] = [];
    if (!inEdges[e.to]) inEdges[e.to] = [];
    outEdges[e.from].push(e);
    inEdges[e.to].push(e);
  });

  // 统计
  const connected = new Set();
  edges.forEach(e => { connected.add(e.from); connected.add(e.to); });
  const isolated = nodes.filter(n => !connected.has(n.id));

  const hardEdges = edges.filter(e => (e.type || 'explicit') === 'explicit');
  const softEdges = edges.filter(e => e.type === 'semantic');

  // 按分类分组
  const groups = {};
  nodes.forEach(n => {
    // 从 indexFile 推断分类
    const idx = n.indexFile || '';
    let group = '其他';
    if (idx.includes('G66 TA资料库')) group = 'G66 TA资料库';
    else if (idx.includes('G66 TA&Art资料库')) group = 'G66 TA&Art资料库';
    else if (idx.includes('场景流程规范')) group = 'G66 场景流程规范';
    else if (idx.includes('美术资源流程规范教学')) group = 'G66 美术资源流程规范教学';
    else if (n.source && n.source.includes('popo')) group = 'POPO文档（其他）';
    else if (n.source) group = '本地文档（其他）';

    if (!groups[group]) groups[group] = [];
    groups[group].push(n);
  });

  // 构建文档
  const lines = [];
  const today = new Date().toISOString().split('T')[0];

  lines.push('# G66 知识图谱 — 总索引地图');
  lines.push('');
  lines.push(`> **生成日期**: ${today} / **自动生成**: graph-to-md.js`);
  lines.push(`> **项目**: G66 shader 知识库`);
  lines.push(`> **用途**: 知识图谱的文字化快照，每次更新图谱后自动生成`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // 统计概览
  lines.push('## 一、统计概览');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('|------|------|');
  lines.push(`| 总节点 | ${nodes.length} |`);
  lines.push(`| 连通节点 | ${connected.size} (${(connected.size/nodes.length*100).toFixed(1)}%) |`);
  lines.push(`| 孤立节点 | ${isolated.length} (${(isolated.length/nodes.length*100).toFixed(1)}%) |`);
  lines.push(`| 总边数 | ${edges.length} |`);
  lines.push(`| 硬边（显式引用） | ${hardEdges.length} |`);
  lines.push(`| 软边（语义关联） | ${softEdges.length} |`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // 节点目录（按分类）
  lines.push('## 二、节点目录');
  lines.push('');

  for (const [group, groupNodes] of Object.entries(groups)) {
    // 按 edgeCount 降序
    groupNodes.sort((a, b) => (b.edgeCount || 0) - (a.edgeCount || 0));

    lines.push(`### ${group}（${groupNodes.length} 个节点）`);
    lines.push('');
    lines.push('| 标题 | 类型 | 边数 | 来源 |');
    lines.push('|------|------|------|------|');

    for (const n of groupNodes) {
      const edgeCount = (outEdges[n.id]?.length || 0) + (inEdges[n.id]?.length || 0);
      const source = n.source ? esc(n.source.substring(0, 50)) : '—';
      lines.push(`| ${esc(n.title)} | ${esc(n.type || '?')} | ${edgeCount} | ${source} |`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  // 关键关联关系
  lines.push('## 三、关键关联关系');
  lines.push('');
  lines.push('> 硬边 = 文档显式引用（URL链接、关联子索引）');
  lines.push('> 软边 = 向量相似度≥0.8 + Agent审查通过');
  lines.push('');

  // 按节点列出边（只列出有边的节点，按 edgeCount 降序）
  const nodesWithEdges = nodes
    .filter(n => (outEdges[n.id]?.length || 0) + (inEdges[n.id]?.length || 0) > 0)
    .sort((a, b) => {
      const ac = (outEdges[a.id]?.length || 0) + (inEdges[a.id]?.length || 0);
      const bc = (outEdges[b.id]?.length || 0) + (inEdges[b.id]?.length || 0);
      return bc - ac;
    });

  // 只列出 edgeCount 前 100 的节点（避免文档过长）
  const topNodes = nodesWithEdges.slice(0, 100);

  for (const n of topNodes) {
    const outs = outEdges[n.id] || [];
    const ins = inEdges[n.id] || [];
    const totalEdges = outs.length + ins.length;
    if (totalEdges === 0) continue;

    lines.push(`### ${n.title}`);
    lines.push('');

    if (outs.length > 0) {
      lines.push(`**引用关联（${outs.length} 条）**:`);
      lines.push('');
      lines.push('| 方向 | 目标文档 | 边类型 | 关联说明 |');
      lines.push('|------|---------|--------|---------|');
      for (const e of outs) {
        const target = nodes.find(nn => nn.id === e.to);
        const tName = target ? esc(target.title) : esc(e.to);
        const eType = e.type === 'semantic' ? '软边' : '硬边';
        const ctx = e.context ? esc(e.context.substring(0, 60)) : '—';
        lines.push(`| → | ${tName} | ${eType} | ${ctx} |`);
      }
      lines.push('');
    }

    if (ins.length > 0) {
      lines.push(`**被引用（${ins.length} 条）**:`);
      lines.push('');
      lines.push('| 方向 | 来源文档 | 边类型 | 关联说明 |');
      lines.push('|------|---------|--------|---------|');
      for (const e of ins) {
        const src = nodes.find(nn => nn.id === e.from);
        const sName = src ? esc(src.title) : esc(e.from);
        const eType = e.type === 'semantic' ? '软边' : '硬边';
        const ctx = e.context ? esc(e.context.substring(0, 60)) : '—';
        lines.push(`| ← | ${sName} | ${eType} | ${ctx} |`);
      }
      lines.push('');
    }
  }

  // 孤立节点
  if (isolated.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## 四、孤立节点');
    lines.push('');
    lines.push(`共 ${isolated.length} 个节点无任何连接：`);
    lines.push('');
    for (const n of isolated) {
      lines.push(`- ${esc(n.title)}`);
    }
    lines.push('');
  }

  fs.writeFileSync(OUT_PATH, lines.join('\n'), 'utf-8');
  console.log(`已生成: ${OUT_PATH}`);
  console.log(`节点: ${nodes.length}, 边: ${edges.length} (硬边 ${hardEdges.length} + 软边 ${softEdges.length})`);
  console.log(`连通: ${connected.size}, 孤立: ${isolated.length}`);
}

main();
