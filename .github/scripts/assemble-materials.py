#!/usr/bin/env python3
"""组装审查材料：PR 元数据 + 权威 diff（截断）+ diff 涉及文件的全文（截断）
+ 引用路径存在性实测 + 被改导出的调用方 grep 上下文。

用法：python3 assemble-materials.py <pr_number>  → 写 materials.json
"""
import json
import os
import re
import subprocess
import sys


def gh(*args: str) -> str:
    return subprocess.run(['gh', *args], capture_output=True, text=True).stdout


def git_grep(symbol: str) -> str:
    return subprocess.run(
        ['git', 'grep', '-n', '-B2', '-A2', '--no-color', symbol],
        capture_output=True, text=True).stdout


prn = sys.argv[1]
repo = os.environ['GITHUB_REPOSITORY']
meta = json.loads(gh('pr', 'view', prn, '--repo', repo, '--json', 'title,body'))
diff = gh('pr', 'diff', prn, '--repo', repo)

# 巨型 diff（锁文件/全量重排）会爆材料与上下文窗口：截断并显式标记，
# 模型看到标记即知视野受限，不会误以为看全了。
DIFF_LIMIT = 400_000
diff_truncated = False
if len(diff) > DIFF_LIMIT:
    diff = diff[:DIFF_LIMIT] + '\n...（diff 截断，原 %d 字节——视野受限，结论需人工复核）\n' % len(diff)
    diff_truncated = True

files = {}
for line in diff.splitlines():
    if line.startswith('+++ b/'):
        path = line[6:]
        try:
            files[path] = open(path, encoding='utf-8', errors='replace').read()[:20000]
        except OSError:
            pass
# diff 中引用、但不在 diff 涉及文件里的仓库路径：在 PR head 检出中实测存在性。
# 根因修复（上游 #435 误判）：被引用文件（如 CI 引用的脚本）不在 diff 中时，
# bot 看不见就保守误报"可能不存在"——把实测存在性作为事实喂给它。
referenced = {}
for m in re.finditer(r'[\w.-]+(?:/[\w.-]+)+\.(?:tsx|jsx|ts|js|mjs|cjs|md|markdown|ya?ml|json|py)', diff):
    path = m.group(0).rstrip('`"\',')
    if path and path not in files and path not in referenced:
        referenced[path] = os.path.exists(path)

# 调用方视野（盲测实证短板）：diff 改了导出，模型却看不到谁在调用它。
# 从 + 行提取被改的导出符号（≤10 个），在 PR head 检出里 git grep 调用处
# （排除 diff 涉及文件自身，≤5 处/符号，带 ±2 行上下文），总量封顶防爆炸。
# 未命中≠无调用方（动态调用/字符串引用 grep 不到）——契约由 prompt 侧声明。
EXPORT_RE = re.compile(r'^\+.*export\s+(?:async\s+)?(?:function|const|class|type|interface)\s+([A-Za-z_$][\w$]*)')
symbols = []
for line in diff.splitlines():
    m = EXPORT_RE.match(line)
    if m and m.group(1) not in symbols:
        symbols.append(m.group(1))
    if len(symbols) >= 10:
        break
callers = {}
budget = 30_000
BLOCK_HEAD = re.compile(r'-?(.+?)[:-]\d+[:-]')
for sym in symbols:
    if budget <= 0:
        break
    hits = []
    for block in git_grep(sym).split('\n--\n'):
        # 块首行形如 path:42:命中行 或 -path-40-上下文行；非贪婪到行号，
        # 含 '-' 的路径（如 dsh-tui-wt/x.ts）不会被截错。
        m = BLOCK_HEAD.match(block)
        if not m or m.group(1) in files:
            continue  # 解析不了或 diff 涉及文件自身（全文已在视野里）
        hits.append(block.rstrip())
        if len(hits) >= 5:
            break
    if hits:
        text = ('\n--\n'.join(hits))
        if budget - len(text) < 0:
            text = text[:budget]
        callers[sym] = text
        budget -= len(text)

json.dump({'title': meta['title'], 'body': meta.get('body') or '', 'diff': diff,
           'diff_truncated': diff_truncated, 'files': files, 'referenced': referenced,
           'callers': callers},
          open('materials.json', 'w', encoding='utf-8'))
print('materials: diff=%dB(trunc=%s) files=%d callers=%d' % (
    len(diff), diff_truncated, len(files), len(callers)))
