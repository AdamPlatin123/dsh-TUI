#!/usr/bin/env python3
"""从容错输出中提取平衡 JSON 审查结果并渲染为 markdown 评论。

输入：raw.out（claude -p 的原始输出，JSON 可能混在叙述/围栏中）
输出：review.md；verdict 非法时 exit 1（调用方走原始内容回退）。
"""
import json
import sys

VERDICTS = ('Mergeable', 'Need Minor Fix', 'Need Major Fix')

raw = open('raw.out', encoding='utf-8').read()
start = raw.find('{"verdict"')
obj = None
if start >= 0:
    depth, instr, esc = 0, False, False
    for i, ch in enumerate(raw[start:], start):
        if esc:
            esc = False
            continue
        if ch == '\\':
            esc = True
            continue
        if ch == '"':
            instr = not instr
            continue
        if instr:
            continue
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                try:
                    obj = json.loads(raw[start:i + 1])
                except Exception:
                    obj = None
                break

if not obj or obj.get('verdict') not in VERDICTS:
    sys.exit(1)

lines = ['## AI 审核参考：%s' % obj['verdict'], '', '### ✅ 验证过做对的部分']
lines += ['- %s' % c for c in (obj.get('correct') or ['（无）'])]
lines += ['', '### ⚠️ 发现清单']
issues = obj.get('issues') or []
for it in issues:
    lines.append('- **%s:%s** — %s' % (it.get('file'), it.get('line'), it.get('problem', '')))
    if it.get('fix'):
        lines.append('  建议：%s' % it['fix'])
if not issues:
    lines.append('-（无）')
lines += ['', '**理由**：%s' % obj.get('reason', ''), '',
          '_由 ai-review 生成（DeepSeek · 结构化输出 · 只读审查）_']
open('review.md', 'w', encoding='utf-8').write('\n'.join(lines))
