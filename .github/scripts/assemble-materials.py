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
# fork 复测语境修正：本 PR 若是「[上游#N] …」复测样本，其 body 是我方复测标注
#（"勿合并"等）而非上游作者原文——bot 会把标注误读为 PR 意图（#489 复测实证）。
# 解析上游号，改拉上游原 PR 的 title/body 进材料。
UPSTREAM_REPO = 'ccch1mneyyy/dsh-TUI'  # 仅 fork 复测场景使用
m = re.match(r'\[上游#(\d+)\]', meta.get('title') or '')
if m:
    try:
        up = json.loads(gh('pr', 'view', m.group(1), '--repo', UPSTREAM_REPO, '--json', 'title,body'))
        meta = {'title': up.get('title') or meta['title'], 'body': up.get('body') or ''}
    except Exception:
        pass  # 上游拉取失败则退回 fork 元数据
# diff 语境修正（#489 作者纠错）：fork main 领先于上游 PR 的 base 时，fork 上的
# pr diff 会混入 base 差异（把 main 新增内容算成 PR 改动、体积虚增、伪超范围）。
# 复测场景必须用上游 PR 的权威 diff（其 base 即作者声明的 base）。
diff = gh('pr', 'diff', m.group(1) if m else prn, '--repo', UPSTREAM_REPO if m else repo)

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
# 白名单化（自审实证修复）：裸正则会把 diff 头 a//b/ 前缀、注释示例路径、
# URL 路径段当成"仓库引用"并测得全 False——污染存在性表为假"不存在"。
TOP_DIRS = ('src/', 'scripts/', 'docs/', 'presets/', 'bin/', '.github/', 'vendor/', 'skills/')
referenced = {}
for m in re.finditer(r'[\w.-]+(?:/[\w.-]+)+\.(?:tsx|jsx|ts|js|mjs|cjs|md|markdown|ya?ml|json|py)', diff):
    path = re.sub(r'^[ab]/', '', m.group(0).rstrip('`"\','))
    if '://' in m.group(0) or not path.startswith(TOP_DIRS):
        continue
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

# ── v24① CI 结果与失败日志（实证材料，非猜测）─────────────────────────
# bot 此前每次自白"无法运行测试"——而 CI 红/绿与失败断言是现成权威事实。
# 归因规则（真回归/flaky/预存）交给 prompt 契约侧。
checks = gh('pr', 'checks', prn, '--repo', repo)
ci = {'summary': checks.strip()[:4000], 'failed_log_tail': ''}
if checks and 'fail' in checks:
    m = re.search(r'runs/(\d+)', checks)
    if m:
        log = subprocess.run(
            ['gh', 'run', 'view', m.group(1), '--repo', repo, '--log-failed'],
            capture_output=True, text=True).stdout
        ci['failed_log_tail'] = '\n'.join(log.splitlines()[-80:])
# ── v24③ 往轮人工反馈（防重复报已澄清/已修复项）───────────────────────
# 只取人类评论（排除 bot 与我方转发），最近 6 条、每条截 400 字。
meta_full = json.loads(gh('pr', 'view', prn, '--repo', repo, '--json', 'comments'))
prior = []
for c in reversed(meta_full.get('comments') or []):
    if len(prior) >= 6:
        break
    if c['author']['login'] in ('github-actions', 'AdamPlatin123'):
        continue
    prior.append({'author': c['author']['login'], 'body': (c['body'] or '')[:400]})
materials = json.load(open('materials.json', encoding='utf-8'))
materials['ci'] = ci
materials['prior_comments'] = prior
json.dump(materials, open('materials.json', 'w', encoding='utf-8'), ensure_ascii=False)
print('materials+: ci_fail=%s prior_comments=%d' % ('fail' if ci['failed_log_tail'] else 'none/pass', len(prior)))
