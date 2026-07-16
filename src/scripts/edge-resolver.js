// edge-resolver.js
// 通用硬边解析器 — 浏览索引文档提取显式引用，与注册表匹配生成显式边
//
// 用法: node edge-resolver.js --full                      全量重建
//       node edge-resolver.js --incremental --index <path>  增量解析单文档

const fs = require('fs');
const path = require('path');

const BASE = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = path.join(BASE, 'src', 'data', 'registry.json');
const INDEX_DIRS = ['知识库'];

// ---- 概念检测 ----
const CONCEPT_PATTERNS = [
  /^（无）/,
  /^无直接/,
  /^【详情查看/,
  /^本目录下全部/,
  /^同目录/,
  /^无$/,
];

function isLikelyConcept(refName) {
  if (!refName) return true;
  for (const p of CONCEPT_PATTERNS) {
    if (p.test(refName)) return true;
  }
  if (refName.length > 60) return true;
  if (/\d+条$/.test(refName)) return true;
  return false;
}

// ---- 标题模糊匹配 ----
function scoreMatch(refName, node) {
  const ref = (refName || '').toLowerCase().replace(/索引节点|索引文档|索引/g, '').trim();
  const title = (node.title || '').toLowerCase().replace(/索引节点|索引文档|索引/g, '').trim();
  const keywords = (node.keywords || []).join(' ').toLowerCase();
  const summary = (node.summary || '').toLowerCase();

  if (ref === title) return 100;
  if (title.includes(ref) || ref.includes(title)) return 85;

  let score = 0;
  const refWords = ref.split(/[\s\-_、，()]+/).filter(w => w.length > 1);
  for (const w of refWords) {
    if (title.includes(w)) score += 15;
    if (keywords.includes(w)) score += 10;
    if (summary.includes(w)) score += 3;
  }
  return Math.min(score, 99);
}

function normalizeLocalId(id) {
  if (!id || !id.startsWith('local:')) return id;
  let p = id.slice('local:'.length);
  p = p.replace(/`/g, '').replace(/\\/g, '/').trim();
  const prefixes = [
    /^[A-Za-z]:[\/\\].*?[\/\\](?=docs|src|data|知识库)/,
  ];
  for (const px of prefixes) {
    p = p.replace(px, '');
  }
  return 'local:' + p;
}

function buildRegistryIndex(nodes) {
  const idToNode = {};
  const normIdToNode = {};
  const urlToNode = {};
  const titleIndex = {};

  for (const n of nodes) {
    idToNode[n.id] = n;
    const normId = normalizeLocalId(n.id);
    if (normId !== n.id) normIdToNode[normId] = n;

    if (n.source && n.sourceType === 'url') {
      urlToNode[n.source] = n;
    }

    const cleanTitle = (n.title || '').toLowerCase().replace(/索引节点|索引文档|索引/g, '').trim();
    if (cleanTitle) titleIndex[cleanTitle] = n;
  }

  return { idToNode, normIdToNode, urlToNode, titleIndex, nodes };
}

function lookupNodeId(targetId, regIndex) {
  if (regIndex.idToNode[targetId]) return regIndex.idToNode[targetId];
  const normId = normalizeLocalId(targetId);
  if (normId !== targetId && regIndex.normIdToNode[normId]) return regIndex.normIdToNode[normId];
  return null;
}

function matchUrl(url, regIndex) {
  if (!url) return null;
  if (regIndex.urlToNode[url]) return regIndex.urlToNode[url];
  return null;
}

function matchByTitle(refName, regIndex) {
  const cleanRef = (refName || '').toLowerCase().replace(/索引节点|索引文档|索引/g, '').trim();
  if (!cleanRef) return null;
  if (regIndex.titleIndex[cleanRef]) return regIndex.titleIndex[cleanRef];

  let best = null;
  let bestScore = 0;
  for (const n of regIndex.nodes) {
    const s = scoreMatch(refName, n);
    if (s > bestScore) { bestScore = s; best = n; }
  }
  return bestScore >= 80 ? best : null;
}

function isExternalUrl(url) {
  return /^https?:\/\//.test(url);
}

function parseIndexDoc(filePath, relPath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  if (!text) return null;

  const title = (text.match(/^# 索引文档：(.+)$/m) || text.match(/^# (.+)$/m) || [])[1];
  if (!title) return null;

  const metaSection = (text.match(/## 元数据\n\n([\s\S]*?)(?=\n## )/) || text.match(/## 一、元数据\n([\s\S]*?)(?=\n## )/) || [])[1] || '';
  const sourceUrl = (metaSection.match(/\*\*来源URL\*\*:\s*(https?:\/\/[^\s\n]+)/) || [])[1];
  const localPath = (metaSection.match(/\*\*来源路径\*\*:\s*(.+)/) || [])[1];

  let nodeId;
  if (sourceUrl) {
    let m = sourceUrl.match(/\/pageDetail\/([a-f0-9]+)/);
    if (m) nodeId = `doc:${m[1]}`;
    else m = sourceUrl.match(/lingxi\/([a-f0-9]+)/);
    if (m) nodeId = `doc:${m[1]}`;
    else nodeId = `url:${sourceUrl.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 60)}`;
  }
  if (!nodeId && localPath) {
    let p = localPath.replace(/`/g, '').replace(/\\/g, '/').trim();
    nodeId = `local:${p}`;
  }
  if (!nodeId) nodeId = `index:${relPath}`;

  const edges = [];
  const pendingUrls = [];
  const externalUrls = [];
  const conceptRefs = [];

  const linkSection = text.match(/## 子文档链接探测\n([\s\S]*?)(?=\n## |$)/);
  if (linkSection) {
    const body = linkSection[1];
    const lines = body.split('\n');
    for (const line of lines) {
      if (!line.includes('|')) continue;
      const urlMatch = line.match(/(https?:\/\/[^\s|]+)|([A-Za-z]:[\/\\][^\s|]+)/);
      if (!urlMatch) continue;
      const url = (urlMatch[1] || urlMatch[2]).replace(/[,\s]+$/, '');
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      const docName = cols[0] || '';

      const target = matchUrl(url, regIndex);
      if (target) {
        edges.push({
          from: nodeId, to: target.id, name: docName,
          context: `子文档链接: ${url}`, type: 'explicit'
        });
      } else if (isExternalUrl(url)) {
        pendingUrls.push({ from: nodeId, url, title: docName });
      } else {
        externalUrls.push({ from: nodeId, url, title: docName });
      }
    }
  }

  const refsSection = text.match(/## 关联子索引\n([\s\S]*?)(?=\n## |$)/);
  if (refsSection) {
    const lines = refsSection[1].split('\n');
    for (const line of lines) {
      if (!line.startsWith('|') || line.includes('---') || line.includes('子索引')) continue;
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length < 2) continue;
      const refName = cols[0];
      const context = cols[2] || '';
      const idMatch = cols[1].match(/`([^`]+)`/);
      if (idMatch) {
        const targetId = idMatch[1];
        const target = lookupNodeId(targetId, regIndex);
        if (target) {
          edges.push({ from: nodeId, to: target.id, name: refName, context, type: 'explicit' });
        } else {
          pendingUrls.push({ from: nodeId, url: '', title: refName, nodeId: targetId });
        }
      } else {
        if (isLikelyConcept(refName)) {
          conceptRefs.push({ from: nodeId, ref: refName });
        } else {
          const target = matchByTitle(refName, regIndex);
          if (target) {
            edges.push({ from: nodeId, to: target.id, name: refName, context, type: 'explicit' });
          }
        }
      }
    }
  }

  return { nodeId, title, edges, pendingUrls, externalUrls, conceptRefs };
}

let regIndex = null;

function loadRegistry() {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
  const nodes = registry.nodes || registry;
  regIndex = buildRegistryIndex(Array.isArray(nodes) ? nodes : Object.values(nodes));
  return regIndex;
}

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
  return files;
}

function runIncremental(indexPath) {
  const fullPath = path.isAbsolute(indexPath) ? indexPath : path.join(BASE, indexPath);
  if (!fs.existsSync(fullPath)) {
    console.log(JSON.stringify({ ok: false, error: `文件不存在: ${fullPath}` }));
    process.exit(1);
  }
  const rel = path.relative(BASE, fullPath).replace(/\\/g, '/');
  const result = parseIndexDoc(fullPath, rel);
  if (!result) {
    console.log(JSON.stringify({ ok: false, error: '无法解析文档' }));
    process.exit(1);
  }
  const output = {
    ok: true,
    node: { id: result.nodeId, title: result.title },
    edges: result.edges,
    pendingQueue: result.pendingUrls,
    stats: {
      total: result.edges.length + result.pendingUrls.length + result.externalUrls.length,
      matched: result.edges.length,
      pending: result.pendingUrls.length,
      external: result.externalUrls.length,
      concept: result.conceptRefs.length
    }
  };
  console.log(JSON.stringify(output, null, 2));
}

function runFull() {
  const files = findIndexFiles();
  const allEdges = [];
  const pendingQueue = [];
  const externalUrls = [];
  const conceptRefs = [];

  for (const fp of files) {
    const rel = path.relative(BASE, fp).replace(/\\/g, '/');
    const result = parseIndexDoc(fp, rel);
    if (!result) continue;
    allEdges.push(...result.edges);
    pendingQueue.push(...result.pendingUrls);
    externalUrls.push(...result.externalUrls);
    conceptRefs.push(...result.conceptRefs);
  }

  const edgeMap = new Map();
  for (const e of allEdges) {
    const key = `${e.from}→${e.to}`;
    if (!edgeMap.has(key) || (e.context && !edgeMap.get(key).context)) {
      edgeMap.set(key, e);
    }
  }
  const dedupedEdges = [...edgeMap.values()];

  const seenUrls = new Set();
  const dedupedPending = pendingQueue.filter(p => {
    if (!p.url) return false;
    if (seenUrls.has(p.url)) return false;
    seenUrls.add(p.url);
    return true;
  });

  const output = {
    edges: dedupedEdges,
    pendingQueue: dedupedPending,
    brokenCount: dedupedPending.length,
    stats: {
      total: dedupedEdges.length + dedupedPending.length + externalUrls.length,
      matched: dedupedEdges.length,
      pending: dedupedPending.length,
      external: externalUrls.length,
      concept: conceptRefs.length
    }
  };

  const outPath = path.join(BASE, 'src', 'data', 'hard-edges.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`硬边: ${dedupedEdges.length}, 待索引: ${dedupedPending.length}, 外部: ${externalUrls.length}`);
  console.log(`输出: ${outPath}`);
}

const args = process.argv.slice(2);
loadRegistry();
if (args.includes('--full')) {
  runFull();
} else if (args.includes('--incremental')) {
  const idx = args.indexOf('--index');
  if (idx < 0 || !args[idx + 1]) {
    console.log(JSON.stringify({ ok: false, error: '--incremental 模式需要 --index <path>' }));
    process.exit(1);
  }
  runIncremental(args[idx + 1]);
} else {
  console.log('用法: node edge-resolver.js --full | --incremental --index <path>');
  process.exit(1);
}
