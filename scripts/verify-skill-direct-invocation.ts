/**
 * 内置技能命令确定性直调回归（issue #496，关联上游 #416）：
 *
 *   1. `LOCAL_COMMANDS` 不再收录打包技能名 —— audit / bug / practice /
 *      review / pr-comments / release-notes / vuln-check 必须全部交还给
 *      refreshSkillCommands 注册为确定性直调命令（旧的下划线拼写
 *      pr_comments 一并不允许回潮）；
 *   2. 打包技能目录里的每个 SKILL.md 名字都能通过 channel 的两道注册门
 *      （parseCommandName 可解析 + 不与本地命令撞名）；
 *   3. registerPackagedSkills 在源码与构建两种产物层级下都能找到
 *      skills/ 并把 7 个技能注册进注册表（skillsRoot 候选路径）；
 *   4. 旧提示词路径彻底移除：Chat.tsx 无 SKILL_PROMPTS，i18n.ts 无
 *      skill-*-prompt 键；
 *   5. zh 菜单描述键与注册名对齐（cmd-desc-pr-comments 存在，
 *      cmd-desc-pr_comments 不再存在）。
 *
 * 运行：node --import tsx/esm scripts/verify-skill-direct-invocation.ts
 */
import { readFileSync } from 'node:fs'

const {
  LOCAL_COMMANDS,
  isLocalCommandName,
  parseCommandName,
} = await import('../src/commands.js')
const { registerPackagedSkills } = await import('../src/dsh-adapter/packaged-skills.js')

let failures = 0
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`)
  } else {
    failures++
    console.error(`  ✗ ${msg}`)
  }
}

const PACKAGED_SKILL_NAMES = ['audit', 'bug', 'practice', 'pr-comments', 'release-notes', 'review', 'vuln-check']

// --- 1. 本地名单不再截留打包技能名 ---
console.log('\n[1] LOCAL_COMMANDS 不含打包技能名（交还直调路径）')
for (const name of PACKAGED_SKILL_NAMES) {
  assert(!isLocalCommandName(name), `isLocalCommandName('${name}') === false`)
}
assert(!LOCAL_COMMANDS.some(command => command.name === 'pr_comments'),
  "下划线旧名 'pr_comments' 已从 LOCAL_COMMANDS 移除")

// --- 2. 每个打包技能都能过 channel 注册门 ---
console.log('\n[2] 打包技能全部通过 parseCommandName + 撞名过滤')
for (const name of PACKAGED_SKILL_NAMES) {
  const parsed = parseCommandName(`/${name}`)
  assert(parsed?.name === name, `'${name}' 可被命令文法解析`)
  assert(!isLocalCommandName(name), `'${name}' 不与本地命令撞名`)
}

// --- 3. registerPackagedSkills 双层级候选路径 ---
console.log('\n[3] registerPackagedSkills 注册 7 个打包技能')
{
  const registered: { name: string; source?: string }[] = []
  const fakeRegistry = {
    register(skill: { name: string; source?: string }) {
      registered.push({ name: skill.name, source: skill.source })
      return () => {}
    },
  }
  const fakeCtx = {
    get(key: string) {
      return key === 'skills' ? fakeRegistry : undefined
    },
    logger: { warn() {} },
  }
  // 类型上收窄为 any：测试只依赖结构兼容的最小 ctx 面。
  registerPackagedSkills(fakeCtx as never)
  const names = registered.map(entry => entry.name).sort()
  assert(
    JSON.stringify(names) === JSON.stringify([...PACKAGED_SKILL_NAMES].sort()),
    `注册名集合 === 打包技能目录（实际：${names.join(', ') || '∅'}）`,
  )
  // 构建布局（lib/types/dsh-adapter/*.js）需要再向上一级：源码必须像
  // packaged-presets.ts 一样给出两层候选路径，单路径在发布包内会落空。
  const self = readFileSync('src/dsh-adapter/packaged-skills.ts', 'utf8').replace(/\s+/g, '')
  assert(
    self.includes("join(moduleDir,'..','..','skills')")
    && self.includes("join(moduleDir,'..','..','..','skills')"),
    'skillsRoot 采用双层候选路径（src 与 lib 布局都能命中）',
  )
}

// --- 4. 旧提示词路径已移除 ---
console.log('\n[4] SKILL_PROMPTS 与 skill-*-prompt i18n 键不再存在')
{
  const chat = readFileSync('src/screens/Chat.tsx', 'utf8')
  assert(!chat.includes('SKILL_PROMPTS'), 'Chat.tsx 无 SKILL_PROMPTS')
  const i18n = readFileSync('src/i18n.ts', 'utf8')
  for (const key of [
    'skill-audit-prompt', 'skill-bug-prompt', 'skill-practice-prompt',
    'skill-review-prompt', 'skill-pr-comments-prompt',
    'skill-release-notes-prompt', 'skill-vuln-check-prompt',
  ]) {
    assert(!i18n.includes(`'${key}'`), `i18n.ts 无 '${key}'`)
  }
}

// --- 5. zh 描述键与新注册名对齐 ---
console.log('\n[5] cmd-desc 键对齐连字符注册名')
{
  const i18n = readFileSync('src/i18n.ts', 'utf8')
  assert(i18n.includes("'cmd-desc-pr-comments'"), "存在 'cmd-desc-pr-comments'")
  assert(!i18n.includes("'cmd-desc-pr_comments'"), "不存在 'cmd-desc-pr_comments'")
}

if (failures > 0) {
  console.error(`\n${failures} 项断言失败`)
  process.exit(1)
}
console.log('\n全部断言通过')
process.exit(0)
