#!/usr/bin/env python3
"""组装审查材料：PR 元数据 + 权威 diff + diff 涉及文件的全文（截断）。

用法：python3 assemble-materials.py <pr_number>  → 写 materials.json
"""
import json
import os
import subprocess
import sys


def gh(*args: str) -> str:
    return subprocess.run(['gh', *args], capture_output=True, text=True).stdout


prn = sys.argv[1]
repo = os.environ['GITHUB_REPOSITORY']
meta = json.loads(gh('pr', 'view', prn, '--repo', repo, '--json', 'title,body'))
diff = gh('pr', 'diff', prn, '--repo', repo)
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
import re
referenced = {}
for m in re.finditer(r'[\w.-]+(?:/[\w.-]+)+\.(?:tsx|jsx|ts|js|mjs|cjs|md|markdown|ya?ml|json|py)', diff):
    path = m.group(0).rstrip('`"\',')
    if path and path not in files and path not in referenced:
        referenced[path] = os.path.exists(path)
json.dump({'title': meta['title'], 'body': meta.get('body') or '', 'diff': diff,
           'files': files, 'referenced': referenced},
          open('materials.json', 'w', encoding='utf-8'))
print('materials: diff=%dB files=%d' % (len(diff), len(files)))
