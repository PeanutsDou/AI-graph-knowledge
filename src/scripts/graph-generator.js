// graph-generator.js
// 解析所有索引文档 → 提取节点元数据 + 关联子索引边 → 输出 graph.json
//
// 模式:
//   node graph-generator.js                              全量模式（默认）
//   node graph-generator.js --incremental --index <path> 增量模式：追加单文档节点+边
//   node graph-generator.js --merge-soft-edges <file>    合并审查通过的软边到 graph.json
//
// 边类型:
//   explicit — 硬边（文档显式引用），从 edge-resolver 的 hard-edges.json 读取
//   semantic — 软边（向量相似度 + Agent 审查通过），从 reviewed-edges.json 读取

const fs = require('fs');
const path = require('path');

const BASE = path.resolve(__dirname, '..', '..');
const OUT = path.join(BASE, 'src', 'data', 'graph.json');
const HARD_EDGES_PATH = path.join(BASE, 'src', 'data', 'hard-edges.json');
const REGISTRY_PATH = path.join(BASE, 'src', 'data', 'registry.json');

const INDEX_DIRS = ['知识库'];

function readFile(p) { try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; } }
function matchOne(text, re, g = 1) { const m = text.match(re); return m ? m[g].trim() : null; }

// ---- 从 registry.json 加载节点 ID 映射 ----

function loadRegistryIdMap() {
  try {
    const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
    const nodes = registry.nodes || [];
    // indexFile → node ID
    const fileToId = {};
    // title → node ID（回退用）
    const titleToId = {};
    for (const n of nodes) {
      if (n.indexFile) fileToId[n.indexFile] = n.id;
      if (n.title) titleToId[n.title] = n.id;
    }
    return { fileToId, titleToId, nodes };
  } catch {
    return { fileToId: {}, titleToId: {}, nodes: [] };
  }
}

// ---- Parse a single index doc ----

function parseDoc(filePath, relPath, regIdMap) {
  const text = readFile(filePath);
  if (!text) return null;

  const title = matchOne(text, /^# 索引文档：(.+)$/m) || path.basename(filePath, '.md');
  const title2 = matchOne(text, /^# (.+)$/m);
  const displayTitle = title || title2 || path.basename(filePath, '.md');

  const date = matchOne(text, /> \*\*更新日期\*\*: (.+)/);
  const category = matchOne(text, /> \*\*所属分类\*\*: (.+)/);
  const keywordsRaw = matchOne(text, /> \*\*检索关键词\*\*: (.+)/);
  const keywords = keywordsRaw ? keywordsRaw.split(/[、,，]/).map(k => k.trim()).filter(Boolean) : [];

  const metaSection = (text.match(/## 元数据\n\n([\s\S]*?)(?=\n## )/) || [])[1] || '';
  const sourceUrl = matchOne(metaSection, /\*\*来源URL\*\*:\s*(https?:\/\/[^\s\n]+)/);
  const localPath = matchOne(metaSection, /\*\*来源路径\*\*:\s*(.+)/);
  const docType = matchOne(metaSection, /\*\*文档类型\*\*: (.+)/);
  const summary = matchOne(metaSection, /\*\*内容概要\*\*: (.+)/);

  // 节点 ID：优先从 registry.json 读取（保证和 registry/edge-resolver/embed.py 一致）
  const relPathNormalized = relPath.replace(/\\/g, '/');
  let nodeId = regIdMap.fileToId[relPathNormalized]
            || regIdMap.titleToId[displayTitle]
            || null;

  // 回退：自己生成（和 registry-builder 逻辑一致）
  if (!nodeId) {
    if (sourceUrl) {
      let m = sourceUrl.match(/\/pageDetail\/([a-f0-9]+)/);
      if (m) nodeId = `doc:${m[1]}`;
      else m = sourceUrl.match(/lingxi\/([a-f0-9]+)/);
      if (m) nodeId = `doc:${m[1]}`;
      if (!nodeId) nodeId = `url:${sourceUrl.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 60)}`;
    }
    if (!nodeId && localPath) {
      let p = localPath.replace(/`/g, '').replace(/\\/g, '/').trim();
      nodeId = `local:${p}`;
    }
    if (!nodeId) nodeId = `local:index:${relPathNormalized}`;
  }

  // 关联子索引 — extract edges with node IDs
  const refsSection = (text.match(/## 关联子索引\n((?:(?!\n## )[\s\S])*)/) || [])[1] || '';
  const edges = [];
  if (refsSection) {
    const lines = refsSection.split('\n');
    for (const line of lines) {
      if (!line.startsWith('|') || line.includes('---') || line.includes('子索引')) continue;
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length < 2) continue;
      const refName = cols[0];
      const idMatch = cols[1].match(/`([^`]+)`/);
      if (!idMatch) continue;
      const targetId = idMatch[1];
      const context = cols[2] || '';
      edges.push({ target: targetId, name: refName, context });
    }
  }

  return {
    id: nodeId,
    title: displayTitle,
    type: docType || 'unknown',
    source: sourceUrl || localPath || null,
    summary: summary || '',
    keywords,
    category: category || '',
    date: date || '',
    indexFile: relPath.replace(/\\/g, '/'),
    edgeCount: edges.length,
    edges
  };
}

// ---- Collect all files ----

function findIndexFiles() {
  const files = [];
  for (const dir of INDEX_DIRS) {
    const full = path.join(BASE, dir);
    if (!fs.existsSync(full)) continue;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) walk(fp);
        else if (e.name.endsWith('.md')) files.push(fp);
      }
    };
    walk(full);
  }
  for (const e of fs.readdirSync(BASE, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.md') && e.name.includes('索引节点')) {
      files.push(path.join(BASE, e.name));
    }
  }
  return files;
}

// ---- 加载硬边 ----

function loadHardEdges() {
  try {
    const data = JSON.parse(fs.readFileSync(HARD_EDGES_PATH, 'utf-8'));
    return data.edges || [];
  } catch {
    return null; // hard-edges.json 不存在时返回 null，回退到旧逻辑
  }
}

// ---- 全量模式 ----

function runFull() {
  const files = findIndexFiles();
  console.log(`Scanning ${files.length} index files...`);

  const regIdMap = loadRegistryIdMap();
  const nodes = [];
  const nodeMap = {};
  for (const fp of files) {
    const rel = path.relative(BASE, fp);
    const doc = parseDoc(fp, rel, regIdMap);
    if (!doc) continue;
    nodes.push(doc);
    nodeMap[doc.id] = doc;
  }

  // 优先从 hard-edges.json 读取硬边；回退到旧逻辑（从 parseDoc 的 edges 构建）
  const hardEdges = loadHardEdges();
  let edges;
  let edgeSource;

  if (hardEdges) {
    edges = hardEdges.filter(e => nodeMap[e.from] && nodeMap[e.to]);
    edgeSource = 'hard-edges.json';
  } else {
    edges = [];
    for (const node of nodes) {
      for (const e of node.edges) {
        if (nodeMap[e.target]) {
          edges.push({ from: node.id, to: e.target, name: e.name, context: e.context, type: 'explicit' });
        }
      }
    }
    edgeSource = 'parseDoc (fallback)';
  }

  // 确保所有边都有 type 字段（向后兼容）
  edges = edges.map(e => ({ ...e, type: e.type || 'explicit' }));

  const connected = new Set();
  edges.forEach(e => { connected.add(e.from); connected.add(e.to); });
  const isolated = nodes.filter(n => !connected.has(n.id));

  const graph = {
    meta: {
      generated: new Date().toISOString(),
      edgeSource,
      totalNodes: nodes.length,
      totalEdges: edges.length,
      connectedNodes: connected.size,
      isolatedNodes: isolated.length
    },
    nodes,
    edges
  };

  fs.writeFileSync(OUT, JSON.stringify(graph, null, 2), 'utf-8');
  console.log(`Nodes: ${nodes.length}, Edges: ${edges.length} (source: ${edgeSource})`);
  console.log(`Connected: ${connected.size}, Isolated: ${isolated.length}`);
  console.log(`Graph written to ${OUT}`);
}

// ---- 增量模式 ----

function runIncremental(indexPath) {
  const fullPath = path.isAbsolute(indexPath) ? indexPath : path.join(BASE, indexPath);
  if (!fs.existsSync(fullPath)) {
    console.log(JSON.stringify({ ok: false, error: `文件不存在: ${fullPath}` }));
    process.exit(1);
  }

  const rel = path.relative(BASE, fullPath).replace(/\\/g, '/');
  const regIdMap = loadRegistryIdMap();
  const doc = parseDoc(fullPath, rel, regIdMap);
  if (!doc) {
    console.log(JSON.stringify({ ok: false, error: '无法解析文档' }));
    process.exit(1);
  }

  // 读取现有 graph.json
  let graph;
  try {
    graph = JSON.parse(fs.readFileSync(OUT, 'utf-8'));
  } catch {
    graph = { meta: {}, nodes: [], edges: [] };
  }

  const nodeMap = {};
  for (const n of graph.nodes) nodeMap[n.id] = n;

  // 追加或更新节点
  let nodeAction = 'added';
  if (nodeMap[doc.id]) {
    nodeMap[doc.id] = doc;
    nodeAction = 'updated';
  } else {
    nodeMap[doc.id] = doc;
    graph.nodes.push(doc);
  }

  // 从 hard-edges.json 读取该节点的硬边
  const hardEdges = loadHardEdges();
  let addedEdges = 0;
  if (hardEdges) {
    const existingEdgeKeys = new Set(graph.edges.map(e => `${e.from}→${e.to}`));
    for (const e of hardEdges) {
      if (e.from === doc.id && nodeMap[e.to] && !existingEdgeKeys.has(`${e.from}→${e.to}`)) {
        graph.edges.push({ ...e, type: e.type || 'explicit' });
        addedEdges++;
        existingEdgeKeys.add(`${e.from}→${e.to}`);
      }
    }
  }

  // 更新 meta
  graph.meta.generated = new Date().toISOString();
  graph.meta.totalNodes = graph.nodes.length;
  graph.meta.totalEdges = graph.edges.length;

  fs.writeFileSync(OUT, JSON.stringify(graph, null, 2), 'utf-8');
  console.log(JSON.stringify({
    ok: true,
    nodeAction,
    nodeId: doc.id,
    title: doc.title,
    addedEdges,
    totalNodes: graph.nodes.length,
    totalEdges: graph.edges.length
  }, null, 2));
}

// ---- 合并软边 ----

function runMergeSoftEdges(softEdgesPath) {
  const fullPath = path.isAbsolute(softEdgesPath) ? softEdgesPath : path.join(BASE, softEdgesPath);
  if (!fs.existsSync(fullPath)) {
    console.log(JSON.stringify({ ok: false, error: `文件不存在: ${fullPath}` }));
    process.exit(1);
  }

  const softData = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
  const softEdges = (softData.results || softData || [])
    .filter(r => r.verdict === 'approved')
    .map(r => ({
      from: r.from,
      to: r.to,
      type: 'semantic',
      similarity: r.similarity,
      reason: r.reason,
      reviewed: true,
      reviewDate: r.date || new Date().toISOString().split('T')[0]
    }));

  let graph;
  try {
    graph = JSON.parse(fs.readFileSync(OUT, 'utf-8'));
  } catch {
    graph = { meta: {}, nodes: [], edges: [] };
  }

  const existingKeys = new Set(graph.edges.map(e => `${e.from}→${e.to}`));
  let added = 0;
  for (const se of softEdges) {
    const key = `${se.from}→${se.to}`;
    const keyRev = `${se.to}→${se.from}`;
    if (!existingKeys.has(key) && !existingKeys.has(keyRev)) {
      graph.edges.push(se);
      existingKeys.add(key);
      added++;
    }
  }

  graph.meta.totalEdges = graph.edges.length;
  graph.meta.softEdges = (graph.edges.filter(e => e.type === 'semantic')).length;

  fs.writeFileSync(OUT, JSON.stringify(graph, null, 2), 'utf-8');
  console.log(JSON.stringify({
    ok: true,
    softEdgesAdded: added,
    totalEdges: graph.edges.length,
    softEdgesTotal: graph.meta.softEdges
  }, null, 2));
}

// ---- CLI ----

const args = process.argv.slice(2);

if (args.includes('--merge-soft-edges')) {
  const idx = args.indexOf('--merge-soft-edges');
  if (!args[idx + 1]) {
    console.log(JSON.stringify({ ok: false, error: '需要指定软边文件路径' }));
    process.exit(1);
  }
  runMergeSoftEdges(args[idx + 1]);
} else if (args.includes('--incremental')) {
  const idx = args.indexOf('--index');
  if (idx < 0 || !args[idx + 1]) {
    console.log(JSON.stringify({ ok: false, error: '--incremental 模式需要 --index <path>' }));
    process.exit(1);
  }
  runIncremental(args[idx + 1]);
} else {
  runFull();
}
