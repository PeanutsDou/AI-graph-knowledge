// build-graph-view.js
// 读取 graph.json → 替换 template.html 中的 __DATA__ → 输出两个 HTML
const fs = require('fs');
const path = require('path');

const BASE = path.resolve(__dirname, '..');
const graph = JSON.parse(fs.readFileSync(path.join(BASE, 'src', 'data', 'graph.json'), 'utf-8'));

function typeColor(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('表格') || t.includes('sheet')) return '#3fb950';
  if (t.includes('目录') || t.includes('容器')) return '#bc8cff';
  if (t.includes('ppt') || t.includes('excel')) return '#d29922';
  if (t.includes('正文') || t.includes('文档')) return '#58a6ff';
  if (t.includes('索引')) return '#f85149';
  return '#8b949e';
}
graph.nodes.forEach(n => { n._color = typeColor(n.type); });

const template = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf-8');
const html = template.replace('__DATA__', JSON.stringify(graph));

const out = path.join(BASE, 'graph.html');
fs.writeFileSync(out, html, 'utf-8');
console.log(`Generated: graph.html (${(fs.statSync(out).size/1024).toFixed(1)} KB)`);
console.log(`Nodes: ${graph.nodes.length}, Edges: ${graph.edges.length}`);
