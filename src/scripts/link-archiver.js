// link-archiver.js
// 链接归档器 — 去重 + 追加到查表 + 更新索引状态
//
// 用法:
//   node link-archiver.js --url "..." --title "..." --source "..."          归档单个链接
//   node link-archiver.js --batch src/data/new-links.json                   批量归档
//   node link-archiver.js --update-status --url "..." --status "已索引" --node-id "..."
//
// 查表路径: G66_POPO文档链接查表.md
// 归档格式: 在末尾追加 ## 补录批次 {日期} — {来源} section

const fs = require('fs');
const path = require('path');

const BASE = path.resolve(__dirname, '..', '..');
const TABLE_PATH = path.join(BASE, 'G66_POPO文档链接查表.md');

// ---- 读取查表 ----

function readTable() {
  return fs.readFileSync(TABLE_PATH, 'utf-8');
}

// ---- 提取已有 URL 集合 ----

function extractExistingUrls(text) {
  const urls = new Set();
  for (const m of text.matchAll(/https:\/\/docs\.popo\.netease\.com\/[^\s|)]+/g)) {
    urls.add(m[0]);
  }
  return urls;
}

// ---- 提取最大序号 ----

function extractMaxSeq(text) {
  let max = 0;
  for (const m of text.matchAll(/^\|\s*(\d+)\s/gm)) {
    const n = parseInt(m[1]);
    if (n > max) max = n;
  }
  return max;
}

// ---- 推断链接类型 ----

function inferType(url) {
  if (/\/team\/pc\//.test(url)) return 'POPO文档';
  if (/\/lingxi\//.test(url)) return '灵犀文档';
  if (/\/pages\//.test(url)) return '云空间文档';
  return '文档';
}

// ---- 更新头部链接总数 ----

function updateHeaderCount(text, newTotal) {
  return text.replace(
    /> \*\*链接总数\*\*: .+/,
    `> **链接总数**: ${newTotal}`
  );
}

// ---- 归档 ----

function archive(links) {
  // links: [{url, title, source}]
  const text = readTable();
  const existingUrls = extractExistingUrls(text);
  const maxSeq = extractMaxSeq(text);

  const toArchive = [];
  let skipped = 0;

  for (const link of links) {
    if (!link.url || !link.url.startsWith('http')) {
      skipped++;
      continue;
    }
    if (existingUrls.has(link.url)) {
      skipped++;
      continue;
    }
    existingUrls.add(link.url); // 防止同批次重复
    toArchive.push(link);
  }

  if (toArchive.length === 0) {
    console.log(JSON.stringify({ ok: true, archived: 0, skipped, total: existingUrls.size }));
    return;
  }

  // 构建追加内容
  const today = new Date().toISOString().slice(0, 10);
  const sourceDesc = toArchive[0].source || '自动归档';
  let seq = maxSeq;
  const lines = [
    '',
    `## 补录批次 ${today} — ${sourceDesc}`,
    '',
    '| 序号 | 文档名 | POPO链接 | 类型 | 索引状态 | 节点ID | 发现来源 |',
    '|------|--------|----------|------|---------|--------|---------|'
  ];

  for (const link of toArchive) {
    seq++;
    const type = inferType(link.url);
    const title = link.title || '(未知)';
    const source = link.source || '—';
    lines.push(`| ${seq} | ${title} | ${link.url} | ${type} | 待索引 | — | ${source} |`);
  }

  lines.push('');

  const newText = updateHeaderCount(text + lines.join('\n'), existingUrls.size);
  fs.writeFileSync(TABLE_PATH, newText, 'utf-8');

  console.log(JSON.stringify({
    ok: true,
    archived: toArchive.length,
    skipped,
    total: existingUrls.size
  }));
}

// ---- 更新索引状态 ----

function updateStatus(url, status, nodeId) {
  const text = readTable();

  // 找到包含该 URL 的行
  const lines = text.split('\n');
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(url)) continue;
    if (!lines[i].startsWith('|')) continue;

    // 解析列
    const cols = lines[i].split('|');
    // cols[0] = '', cols[1] = 序号, cols[2] = 文档名, cols[3] = 链接, cols[4] = 类型, cols[5] = 索引状态, cols[6] = 节点ID, cols[7] = 发现来源, cols[8] = ''
    if (cols.length < 7) continue;

    // 更新索引状态（cols[5]）和节点ID（cols[6]）
    cols[5] = ` ${status} `;
    if (nodeId) {
      cols[6] = ` \`${nodeId}\` `;
    }

    lines[i] = cols.join('|');
    found = true;
    break;
  }

  if (!found) {
    console.log(JSON.stringify({ ok: false, error: `未在查表中找到 URL: ${url}` }));
    process.exit(1);
  }

  fs.writeFileSync(TABLE_PATH, lines.join('\n'), 'utf-8');
  console.log(JSON.stringify({ ok: true, url, status, nodeId }));
}

// ---- CLI ----

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--update-status')) {
    const urlIdx = args.indexOf('--url');
    const statusIdx = args.indexOf('--status');
    const nodeIdIdx = args.indexOf('--node-id');
    if (urlIdx < 0 || !args[urlIdx + 1]) {
      console.log(JSON.stringify({ ok: false, error: '需要 --url 参数' }));
      process.exit(1);
    }
    updateStatus(
      args[urlIdx + 1],
      statusIdx >= 0 ? args[statusIdx + 1] : '已索引',
      nodeIdIdx >= 0 ? args[nodeIdIdx + 1] : null
    );
    return;
  }

  if (args.includes('--batch')) {
    const idx = args.indexOf('--batch');
    const batchPath = path.isAbsolute(args[idx + 1]) ? args[idx + 1] : path.join(BASE, args[idx + 1]);
    const links = JSON.parse(fs.readFileSync(batchPath, 'utf-8'));
    archive(links);
    return;
  }

  // 单条归档
  const urlIdx = args.indexOf('--url');
  const titleIdx = args.indexOf('--title');
  const sourceIdx = args.indexOf('--source');
  if (urlIdx < 0 || !args[urlIdx + 1]) {
    console.log(JSON.stringify({ ok: false, error: '需要 --url 参数' }));
    process.exit(1);
  }
  archive([{
    url: args[urlIdx + 1],
    title: titleIdx >= 0 ? args[titleIdx + 1] : '',
    source: sourceIdx >= 0 ? args[sourceIdx + 1] : ''
  }]);
}

main();
