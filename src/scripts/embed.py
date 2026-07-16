#!/usr/bin/env python3
"""
embed.py — M3E 向量化 + SQLite 向量库

从索引文档的 ## 元数据 段（或 ## 一、元数据）提取结构化文本，
用 M3E-base 生成 768 维 L2 归一化向量，存入 SQLite。
支持单条 embed / 相似度 search / 全量 rebuild / 删除。

用法:
  python3 embed.py embed --id "wvvv5nae:abc" --title "标题" --text "拼接文本"
  python3 embed.py search --id "wvvv5nae:abc" --topk 15 --threshold 0.8
  python3 embed.py rebuild --registry src/data/registry.json
  python3 embed.py remove --id "wvvv5nae:abc"
"""

import argparse
import json
import os
import re
import sqlite3
import sys

import numpy as np
from sentence_transformers import SentenceTransformer

# ── 路径常量 ──
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(os.path.dirname(SCRIPT_DIR))  # 项目根目录
DATA_DIR = os.path.join(BASE, "src", "data")
DB_DIR = os.path.join(BASE, "src", "db")
DB_PATH = os.path.join(DB_DIR, "embeddings.db")

# M3E 模型路径：优先本地 models/m3e-base，其次自动下载
_LOCAL_MODEL = os.path.join(BASE, "models", "m3e-base")
if os.path.isdir(_LOCAL_MODEL):
    MODEL_PATH = _LOCAL_MODEL
else:
    MODEL_PATH = "moka-ai/m3e-base"  # 首次自动下载到 ~/.cache/huggingface/

# ── 全局模型实例（延迟加载，避免每次命令都重新加载）──
_model = None


def get_model():
    global _model
    if _model is None:
        _model = SentenceTransformer(MODEL_PATH)
    return _model


# ── SQLite 操作 ──

def get_conn():
    os.makedirs(DB_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS nodes (
            id        TEXT PRIMARY KEY,
            title     TEXT,
            text      TEXT,
            embedding BLOB
        )
    """)
    conn.commit()
    return conn


def embed_text(text):
    """生成 L2 归一化的 768 维向量，返回 float32 bytes。"""
    model = get_model()
    vec = model.encode([text], normalize_embeddings=True)[0]
    return vec.astype(np.float32).tobytes()


# ── 元数据段提取 ──

def extract_metadata_text(filepath):
    """
    从索引文档中提取 ## 元数据 段（或 ## 一、元数据），
    拼接成用于向量化的纯文本。

    提取字段：内容概要、关键信息、适用场景。
    如果文档没有元数据段，返回空字符串（调用方退化为 registry 的 title+summary）。
    """
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            text = f.read()
    except Exception:
        return ""

    lines = text.split("\n")

    # 找元数据段起始位置（兼容两种格式）
    start = -1
    for i, line in enumerate(lines):
        if line.strip().startswith("## 元数据") or line.strip().startswith("## 一、元数据"):
            start = i + 1
            break

    if start < 0:
        return ""

    # 找元数据段结束位置（下一个 ## 开头的行）
    end = len(lines)
    for i in range(start, len(lines)):
        if lines[i].startswith("## ") and i > start:
            end = i
            break

    metadata_lines = lines[start:end]

    # 提取关键字段，拼接成纯文本
    parts = []
    current_field = None
    current_value = []

    for line in metadata_lines:
        # 匹配 "- **字段名**: 值" 格式
        m = re.match(r"-\s+\*\*(.+?)\*\*\s*[:：]\s*(.*)", line)
        if m:
            # 保存上一个字段
            if current_field and current_value:
                parts.append(" ".join(current_value).strip())
            current_field = m.group(1)
            current_value = [m.group(2)] if m.group(2) else []
        elif line.strip().startswith("- ") and current_field:
            # 子项（关键信息/适用场景的列表项）
            current_value.append(line.strip().lstrip("- ").strip())
        elif line.strip() and current_field:
            current_value.append(line.strip())

    # 保存最后一个字段
    if current_field and current_value:
        parts.append(" ".join(current_value).strip())

    return " ".join(p for p in parts if p)


def build_text_for_node(node, base_dir):
    """
    构建节点的向量化文本。
    优先从索引文档元数据段提取；退化时用 registry 的 title + summary。
    """
    title = node.get("title", "")

    # 尝试从索引文档提取元数据
    index_file = node.get("indexFile", "")
    if index_file:
        full_path = os.path.join(base_dir, index_file)
        metadata_text = extract_metadata_text(full_path)
        if metadata_text:
            return title + " " + metadata_text

    # 退化：用 registry 的 summary
    summary = node.get("summary") or ""
    return (title + " " + summary).strip()


# ── 命令实现 ──

def cmd_embed(args):
    """为单个节点生成 embedding 并存入 SQLite。"""
    text = args.text
    blob = embed_text(text)
    conn = get_conn()
    conn.execute(
        "INSERT OR REPLACE INTO nodes (id, title, text, embedding) VALUES (?, ?, ?, ?)",
        (args.id, args.title, text, blob),
    )
    conn.commit()
    conn.close()
    print(json.dumps({"ok": True, "dim": 768}))


def cmd_search(args):
    """检索 top-K 相似节点（只返回 similarity >= threshold 的）。"""
    conn = get_conn()

    # 获取查询节点的向量
    row = conn.execute("SELECT embedding FROM nodes WHERE id = ?", (args.id,)).fetchone()
    if row is None:
        print(json.dumps({"error": f"节点 {args.id} 不在向量库中"}))
        conn.close()
        sys.exit(1)

    query_vec = np.frombuffer(row[0], dtype=np.float32)

    # 全量加载所有节点向量
    rows = conn.execute("SELECT id, title, embedding FROM nodes WHERE id != ?", (args.id,)).fetchall()
    conn.close()

    if not rows:
        print(json.dumps({"candidates": []}))
        return

    # 计算点积（L2 归一化后 = 余弦相似度）
    candidates = []
    for nid, ntitle, nblob in rows:
        vec = np.frombuffer(nblob, dtype=np.float32)
        sim = float(np.dot(query_vec, vec))
        if sim >= args.threshold:
            candidates.append({"id": nid, "title": ntitle, "similarity": round(sim, 4)})

    # 按相似度降序，取 top-K
    candidates.sort(key=lambda x: x["similarity"], reverse=True)
    candidates = candidates[: args.topk]

    print(json.dumps({"candidates": candidates}, ensure_ascii=False))


def cmd_rebuild(args):
    """全量重建向量库（从 registry.json 批量生成）。"""
    registry_path = args.registry
    if not os.path.isabs(registry_path):
        registry_path = os.path.join(BASE, registry_path)

    try:
        with open(registry_path, "r", encoding="utf-8") as f:
            registry = json.load(f)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"读取 registry 失败: {e}"}))
        sys.exit(1)

    nodes = registry.get("nodes", registry) if isinstance(registry, dict) else registry
    if not isinstance(nodes, list):
        nodes = list(nodes.values())

    # 清空旧数据
    conn = get_conn()
    conn.execute("DROP TABLE IF EXISTS nodes")
    conn.execute("""
        CREATE TABLE nodes (
            id        TEXT PRIMARY KEY,
            title     TEXT,
            text      TEXT,
            embedding BLOB
        )
    """)
    conn.commit()

    model = get_model()

    count = 0
    for node in nodes:
        nid = node.get("id", "")
        if not nid:
            continue

        title = node.get("title", "")
        text = build_text_for_node(node, BASE)

        if not text.strip():
            text = title  # 最后退化：至少有标题

        vec = model.encode([text], normalize_embeddings=True)[0]
        blob = vec.astype(np.float32).tobytes()

        conn.execute(
            "INSERT INTO nodes (id, title, text, embedding) VALUES (?, ?, ?, ?)",
            (nid, title, text, blob),
        )
        count += 1

        if count % 50 == 0:
            conn.commit()
            print(f"  已处理 {count}/{len(nodes)}...", file=sys.stderr)

    conn.commit()
    conn.close()
    print(json.dumps({"ok": True, "count": count}, ensure_ascii=False))


def cmd_remove(args):
    """删除单个节点向量。"""
    conn = get_conn()
    conn.execute("DELETE FROM nodes WHERE id = ?", (args.id,))
    conn.commit()
    conn.close()
    print(json.dumps({"ok": True}))


# ── CLI ──

def main():
    parser = argparse.ArgumentParser(description="M3E 向量化 + SQLite 向量库")
    sub = parser.add_subparsers(dest="command", required=True)

    p_embed = sub.add_parser("embed", help="单条向量化")
    p_embed.add_argument("--id", required=True)
    p_embed.add_argument("--title", required=True)
    p_embed.add_argument("--text", required=True)
    p_embed.set_defaults(func=cmd_embed)

    p_search = sub.add_parser("search", help="相似度检索")
    p_search.add_argument("--id", required=True)
    p_search.add_argument("--topk", type=int, default=15)
    p_search.add_argument("--threshold", type=float, default=0.8)
    p_search.set_defaults(func=cmd_search)

    p_rebuild = sub.add_parser("rebuild", help="全量重建")
    p_rebuild.add_argument("--registry", default="src/data/registry.json")
    p_rebuild.set_defaults(func=cmd_rebuild)

    p_remove = sub.add_parser("remove", help="删除节点")
    p_remove.add_argument("--id", required=True)
    p_remove.set_defaults(func=cmd_remove)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
