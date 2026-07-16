// registry-builder.js
// 扫描所有索引文档 → 提取节点元数据 → 分配节点 ID → 输出 registry.json
//
// 用法: node registry-builder.js                 全量模式
//       node registry-builder.js --incremental --index <path>  增量模式（单文件追加）

const fs = require('fs');
const path = require('path');

const INDEX_DIRS = ['知识库'];   // 递归遍历

const BASE = path.resolve(__dirname, '..', '..');
const OUT_PATH = path.join(BASE, 'src', 'data', 'registry.json');

// ---- helpers ----

function readFile(p) {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; }
}

function matchOne(text, re, group = 1) {
  const m = text.match(re);
  return m ? m[group].trim() : null;
}

function matchAll(text, re) {
  return [...text.matchAll(re)].map(m => m[1].trim());
}

function extractKeywords(text) {
  const line = matchOne(text, /> \*\*检索关键词\*\*: (.+)/);
  if (!line) return [];
  return line.split(/[、,，]/).map(k => k.trim()).filter(Boolean);
}

function extractSource(metaSection) {
  const url = matchOne(metaSection, /\*\*来源URL\*\*:\s*(https?:\/\/[^\s\n]+)/);
  if (url) return { type: 'url', url };
  const rpath = matchOne(metaSection, /\*\*来源路径\*\*:\s*(.+)/);
  if (rpath) return { type: 'local', path: rpath };
  return null;
}

function extractType(metaSection) {
  const t = matchOne(metaSection, /\*\*文档类型\*\*: (.+)/) || '';
  if (t.includes('表格') || t.includes('POPO表格')) return 'B';
  if (t.includes('目录') || t.includes('容器')) return 'C';
  if (t.includes('PPT') || t.includes('Excel')) return 'A';
  if (t.includes('本地正文') || t.includes('文档') || t.includes('F')) return 'F';
  if (t.includes('索引')) return 'E';
  return 'A';
}

function generateNodeID(source) {
  if (!source) return null;
  if (source.type === 'url') {
    const url = source.url;
    let m = url.match(/\/pageDetail\/([a-f0-9]+)/);
    if (m) return `doc:${m[1]}`;
    m = url.match(/lingxi\/([a-f0-9]+)/);
    if (m) return `doc:${m[1]}`;
    return `url:${url.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 60)}`;
  }
  if (source.type === 'local') {
    let p = source.path.replace(/`/g, '').replace(/\\/g, '/').trim();
    const prefixes = [
      /^[A-Za-z]:[\/\\].*?[\/\\](?=知识库|docs|src|data)/,
    ];
    for (const px of prefixes) {
      p = p.replace(px, '');
    }
    return `local:${p}`;
  }
  return null;
}

// ---- parse index doc ----

function parseIndexDoc(filePath, relPath) {
  const text = readFile(filePath);
  if (!text) return null;

  const title = matchOne(text, /^# 索引文档：(.+)$/m) || path.basename(filePath, '.md');
  const metaSection = (text.match(/## 元数据\n\n([\s\S]*?)(?=\n## )/) || [])[1] || '';
  const source = extractSource(metaSection);
  const docType = extractType(metaSection);
  const summary = matchOne(metaSection, /\*\*内容概要\*\*: (.+)/);
  const keywords = extractKeywords(text);
  const category = matchOne(text, /> \*\*所属分类\*\*: (.+)/);
  const date = matchOne(text, /> \*\*更新日期\*\*: (.+)/);
  const nodeId = generateNodeID(source);

  const refsSection = (text.match(/## 关联子索引\n\n([\s\S]*?)(?=\n## |\n---\s|\n$)/) || [])[1] || '';
  const subRefs = [];
  if (refsSection) {
    const lines = refsSection.split('\n').filter(l => l.startsWith('|') && !l.includes('---') && !l.includes('子索引'));
    for (const line of lines) {
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length >= 2) {
        subRefs.push({ name: cols[0], context: cols[1] || '' });
      }
    }
  }

  return {
    id: nodeId,
    title,
    type: docType,
    source: source ? (source.url || source.path) : null,
    sourceType: source ? source.type : null,
    summary,
    keywords,
    category,
    date,
    indexFile: relPath,
    subRefs
  };
}

// ---- title index ----

function buildTitleIndex(nodes) {
  const titleIndex = {};
  for (const n of nodes) {
    const words = (n.title || '').toLowerCase().split(/[\s\-_、，]+/).filter(w => w.length > 1);
    for (const w of words) {
      if (!titleIndex[w]) titleIndex[w] = [];
      titleIndex[w].push(n.id);
    }
  }
  return titleIndex;
}

function writeRegistry(nodes, stats) {
  const output = {
    meta: {
      generated: new Date().toISOString().split('T')[0],
      totalScanned: stats.total,
      uniqueNodes: nodes.length,
      urlNodes: stats.url,
      localNodes: stats.local,
      noSourceFallback: stats.noSource
    },
    nodes,
    titleIndex: buildTitleIndex(nodes)
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
}

function runFull() {
  const idMap = {};
  const stats = { total: 0, withId: 0, noSource: 0, url: 0, local: 0 };

  for (const dir of INDEX_DIRS) {
    const fullDir = path.join(BASE, dir);
    if (!fs.existsSync(fullDir)) continue;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { walk(full); }
        else if (e.name.endsWith('.md')) {
          const rel = path.relative(BASE, full).replace(/\\/g, '/');
          const node = parseIndexDoc(full, rel);
          if (node) {
            stats.total++;
            if (node.id) {
              stats.withId++;
              if (node.sourceType === 'url') stats.url++;
              else stats.local++;
              if (idMap[node.id]) {
                const existing = idMap[node.id];
                if ((node.summary?.length || 0) > (existing.summary?.length || 0)) {
                  idMap[node.id] = node;
                }
              } else {
                idMap[node.id] = node;
              }
            } else {
              stats.noSource++;
              node.id = `local:index:${rel}`;
              idMap[node.id] = node;
            }
          }
        }
      }
    };
    walk(fullDir);
  }

  const nodes = Object.values(idMap);
  writeRegistry(nodes, stats);
  console.log(`Registry written to ${OUT_PATH}`);
  console.log(`Scanned: ${stats.total}, Unique: ${nodes.length}, URL: ${stats.url}, Local: ${stats.local}, Fallback: ${stats.noSource}`);
}

function runIncremental(indexPath) {
  const fullPath = path.isAbsolute(indexPath) ? indexPath : path.join(BASE, indexPath);
  if (!fs.existsSync(fullPath)) {
    console.log(JSON.stringify({ ok: false, error: `文件不存在: ${fullPath}` }));
    process.exit(1);
  }

  const rel = path.relative(BASE, fullPath).replace(/\\/g, '/');
  const node = parseIndexDoc(fullPath, rel);
  if (!node) {
    console.log(JSON.stringify({ ok: false, error: '无法解析文档' }));
    process.exit(1);
  }

  if (!node.id) {
    node.id = `local:index:${rel}`;
  }

  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(OUT_PATH, 'utf-8'));
  } catch {
    registry = { nodes: [], titleIndex: {} };
  }

  const nodes = registry.nodes || [];
  const idMap = {};
  for (const n of nodes) idMap[n.id] = n;

  let action = 'added';
  if (idMap[node.id]) {
    const existing = idMap[node.id];
    if ((node.summary?.length || 0) > (existing.summary?.length || 0)) {
      idMap[node.id] = node;
      action = 'updated';
    } else {
      action = 'skipped';
    }
  } else {
    idMap[node.id] = node;
  }

  const mergedNodes = Object.values(idMap);
  const stats = {
    total: mergedNodes.length,
    url: mergedNodes.filter(n => n.sourceType === 'url').length,
    local: mergedNodes.filter(n => n.sourceType === 'local').length
  };
  writeRegistry(mergedNodes, stats);

  console.log(JSON.stringify({
    ok: true,
    action,
    nodeId: node.id,
    title: node.title,
    totalNodes: mergedNodes.length
  }, null, 2));
}

// ---- CLI ----

const args = process.argv.slice(2);
if (args.includes('--incremental')) {
  const idx = args.indexOf('--index');
  if (idx < 0 || !args[idx + 1]) {
    console.log(JSON.stringify({ ok: false, error: '--incremental 模式需要 --index <path>' }));
    process.exit(1);
  }
  runIncremental(args[idx + 1]);
} else {
  runFull();
}
