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
json.dump({'title': meta['title'], 'body': meta.get('body') or '', 'diff': diff, 'files': files},
          open('materials.json', 'w', encoding='utf-8'))
print('materials: diff=%dB files=%d' % (len(diff), len(files)))
