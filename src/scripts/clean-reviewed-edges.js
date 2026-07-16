// clean-reviewed-edges.js
// 清理 reviewed-edges.json 中涉及已删除节点的条目
// 在删除索引文档后、重建图谱前执行
//
// 用法: node src/scripts/clean-reviewed-edges.js

const fs = require('fs');
const path = require('path');

const BASE = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = path.join(BASE, 'src', 'data', 'registry.json');
const REVIEWED_PATH = path.join(BASE, 'src', 'data', 'reviewed-edges.json');

function main() {
  // 加载 registry 获取当前有效节点 ID 集合
  let regNodeIds;
  try {
    const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
    const nodes = registry.nodes || [];
    regNodeIds = new Set(nodes.map(n => n.id));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: '无法读取 registry.json: ' + e.message }));
    process.exit(1);
  }

  // 加载 reviewed-edges.json
  let reviewed;
  try {
    reviewed = JSON.parse(fs.readFileSync(REVIEWED_PATH, 'utf-8'));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: '无法读取 reviewed-edges.json: ' + e.message }));
    process.exit(1);
  }

  const results = reviewed.results || [];
  const before = results.length;

  // 过滤：保留 from 和 to 都在 registry 中的条目
  const kept = results.filter(r => regNodeIds.has(r.from) && regNodeIds.has(r.to));
  const removed = before - kept.length;

  // 更新统计
  reviewed.results = kept;
  reviewed.reviewed = kept.length;
  reviewed.approved = kept.filter(r => r.verdict === 'approved').length;
  reviewed.rejected = kept.filter(r => r.verdict === 'rejected').length;

  fs.writeFileSync(REVIEWED_PATH, JSON.stringify(reviewed, null, 2), 'utf-8');

  console.log(JSON.stringify({
    ok: true,
    before,
    after: kept.length,
    removed,
    approved: reviewed.approved,
    rejected: reviewed.rejected
  }, null, 2));
}

main();
