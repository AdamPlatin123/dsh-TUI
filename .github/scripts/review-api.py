#!/usr/bin/env python3
"""单轮 HTTP 审查：材料（diff + 涉及文件全文）打包一次调用 DeepSeek anthropic 端点。

用法：python3 review-api.py <materials.json>  → 写 raw.out
materials.json: {"title": str, "body": str, "diff": str, "files": {"path": "content"}}
"""
import json
import os
import sys
import urllib.request

materials = json.load(open(sys.argv[1], encoding='utf-8'))
files_section = '\n\n'.join(
    '### FILE: %s\n```\n%s\n```' % (p, c)
    for p, c in materials.get('files', {}).items())

prompt = """你是资深 PR 审查员。审查以下 PR（材料：标题、描述、权威 diff、涉及文件全文）。
对照文件全文核实 diff 中的注释/文案/常量引用是否与源码一致；跑不了测试就如实说明。
最终输出必须且只能是一个 JSON 对象（不要 markdown 围栏、不要叙述）：
{"verdict":"Mergeable|Need Minor Fix|Need Major Fix 三选一","correct":["验证过做对的点"],"issues":[{"file":"路径","line":行号,"problem":"问题","fix":"建议"}],"reason":"一句话"}

## PR 标题
%s

## PR 描述
%s

## 权威 diff
```
%s
```

## 涉及文件全文
%s
""" % (materials.get('title', ''), materials.get('body', '')[:2000], materials['diff'], files_section)

req = urllib.request.Request(
    os.environ['ANTHROPIC_BASE_URL'].rstrip('/') + '/v1/messages',
    data=json.dumps({
        'model': os.environ['ANTHROPIC_MODEL'],
        # DeepSeek 官方文档（api-docs.deepseek.com/quick_start/pricing）：
        # 三模型统一 上下文 1M / 输出上限 384K。思考模型的 thinking 计入输出预算，
        # 小额会被思考吃光（text 0B、stop_reason=max_tokens）。384K = 393216，
        # 已实测端点接受该边界值。
        'max_tokens': 393216,
        'messages': [{'role': 'user', 'content': prompt}],
    }).encode(),
    headers={
        'Content-Type': 'application/json',
        'x-api-key': os.environ['ANTHROPIC_AUTH_TOKEN'],
        'anthropic-version': '2023-06-01',
    })
with urllib.request.urlopen(req, timeout=300) as resp:
    data = json.load(resp)
text = ''.join(b.get('text', '') for b in data.get('content', []) if b.get('type') == 'text')
open('raw.out', 'w', encoding='utf-8').write(text)
sys.stderr.write('stop_reason=%s output=%dB\n' % (data.get('stop_reason'), len(text)))
