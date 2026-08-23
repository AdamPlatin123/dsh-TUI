#!/usr/bin/env python3
"""单轮 HTTP 审查：材料一次调用 DeepSeek anthropic 端点，tools 结构化输出。

用法：python3 review-api.py <materials.json>  → 写 review.out.json（tool_use 输入）+ raw.out（text 诊断）
materials.json: {"title": str, "body": str, "diff": str, "diff_truncated": bool,
                 "files": {"path": "content"}, "referenced": {"path": exists_bool},
                 "callers": {"symbol": "grep 上下文"}}
失败语义：HTTP 重试 2 次后仍失败、或响应无 tool_use 且 text 为空 → 非零退出
（让 workflow 步骤红掉，而不是走回退发一条空评论）。
"""
import json
import os
import sys
import time
import urllib.request

materials = json.load(open(sys.argv[1], encoding='utf-8'))
files_section = '\n\n'.join(
    '### FILE: %s\n```\n%s\n```' % (p, c)
    for p, c in materials.get('files', {}).items())
ref = materials.get('referenced') or {}
ref_section = '\n'.join(
    '- %s: %s' % (p, '存在' if e else '不存在') for p, e in ref.items()) or '（无）'
callers = materials.get('callers') or {}
callers_section = '\n\n'.join(
    '### 调用方: %s\n```\n%s\n```' % (s, ctx) for s, ctx in callers.items()) or '（无——grep 未命中或 diff 未改导出）'

prompt = f"""你是资深 PR 审查员。审查以下 PR（材料：标题、描述、权威 diff、涉及文件全文、引用路径存在性表、被改导出的调用方上下文）。
对照文件全文核实 diff 中的注释/文案/常量引用是否与源码一致；跑不了测试就如实说明。
审查完成后，必须且只能通过调用 submit_review 工具提交结论（不要在正文里另外输出 JSON 或叙述）。

## PR 标题
{materials.get('title', '')}

## PR 描述
{(materials.get('body') or '')[:2000]}

## 权威 diff
```
{materials['diff']}
```

## 涉及文件全文（仅 diff 涉及的文件）
{files_section}

## diff 中引用的其他仓库路径存在性（在 PR head 检出中实测的权威事实）
{ref_section}

## 被改导出的调用方上下文（git grep 实证，排除 diff 涉及文件自身）
{callers_section}

## 认知边界契约（必须遵守）
1. 你的源码视野 = 涉及文件全文 + 引用存在性表 + 调用方上下文，三者之外你没有事实依据。
2. 禁止对视野外的文件下"不存在/缺失"类结论。被引用路径若表中标注"存在"，即视为存在，
   不得要求"补上该文件"（上游 #435 曾因此误判：CI 引用的脚本在 main 已有，却因不在 diff
   中被误报缺失）。
3. 调用方上下文是判断间接影响（改了导出后调用处是否仍成立）的事实依据；
   grep 未命中不表示无调用方（动态调用 grep 不到），只表示无静态命中。
4. 无法核实的点在 issues 中标注"（未验证）"，让人类决定是否追查——宁可标注，不可臆断。
"""

SCHEMA = {
    'name': 'submit_review',
    'description': '提交 PR 审查结论（verdict 三档、验证过的正确点、问题清单、一句话理由）',
    'input_schema': {
        'type': 'object',
        'properties': {
            'verdict': {'type': 'string', 'enum': ['Mergeable', 'Need Minor Fix', 'Need Major Fix']},
            'correct': {'type': 'array', 'items': {'type': 'string'}},
            'issues': {
                'type': 'array',
                'items': {
                    'type': 'object',
                    'properties': {
                        'file': {'type': 'string'},
                        'line': {'type': 'integer'},
                        'problem': {'type': 'string'},
                        'fix': {'type': 'string'},
                    },
                    'required': ['file', 'line', 'problem'],
                },
            },
            'reason': {'type': 'string'},
        },
        'required': ['verdict', 'correct', 'issues', 'reason'],
    },
}

payload = {
    'model': os.environ['ANTHROPIC_MODEL'],
    # DeepSeek 官方文档（api-docs.deepseek.com/quick_start/pricing）：三模型统一
    # 上下文 1M / 输出上限 384K。思考模型的 thinking 计入输出预算。实测历史：
    # 4096 全被思考吃光（text 0B）→ 384K 满配可行但失控代价高；128K = 131072
    # 为折中——正常审查结论远用不到，失控上限降到 1/3。若再撞 max_tokens，
    # 优先看 stderr 的 stop_reason 诊断再上调。
    'max_tokens': 131072,
    'messages': [{'role': 'user', 'content': prompt}],
    # 端点 tools 完全支持（模型思考后主动调用 submit_review，实测 stop=tool_use）；
    # tool_choice 强制被拒——"Thinking mode does not support this tool_choice"，
    # 且非思考模型名同样报该错（端点把所有模型按思考模式处理，文档与实现不符，
    # 2026-08-24 实测）。因此靠 prompt 指令 + 提取器双路兜底保证结构化。
    'tools': [SCHEMA],
}
req = urllib.request.Request(
    os.environ['ANTHROPIC_BASE_URL'].rstrip('/') + '/v1/messages',
    data=json.dumps(payload).encode(),
    headers={
        'Content-Type': 'application/json',
        'x-api-key': os.environ['ANTHROPIC_AUTH_TOKEN'],
        'anthropic-version': '2023-06-01',
    })

data = None
for attempt in range(3):
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            data = json.load(resp)
        break
    except Exception as e:
        if attempt == 2:
            sys.stderr.write('HTTP 失败（重试 %d 次后）：%s\n' % (attempt, e))
            sys.exit(3)
        wait = (5, 15)[attempt]
        sys.stderr.write('HTTP 失败（第 %d 次）：%s——%ds 后重试\n' % (attempt + 1, e, wait))
        time.sleep(wait)

tool_input = None
for b in data.get('content', []):
    if b.get('type') == 'tool_use' and b.get('name') == 'submit_review':
        tool_input = b.get('input')
        break
text = ''.join(b.get('text', '') for b in data.get('content', []) if b.get('type') == 'text')
open('raw.out', 'w', encoding='utf-8').write(text)
if tool_input is not None:
    json.dump(tool_input, open('review.out.json', 'w', encoding='utf-8'), ensure_ascii=False)
    sys.stderr.write('stop_reason=%s tool_use=ok text=%dB\n' % (data.get('stop_reason'), len(text)))
else:
    sys.stderr.write('stop_reason=%s tool_use=缺失 text=%dB——' % (data.get('stop_reason'), len(text))
                     + ('max_tokens 被思考吃光；上调 max_tokens 或换非思考模型\n'
                        if data.get('stop_reason') == 'max_tokens' else '模型未按 tool_choice 提交\n'))
    sys.exit(2)
