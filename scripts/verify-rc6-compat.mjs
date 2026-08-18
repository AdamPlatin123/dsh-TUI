/**
 * rc.6 向下兼容门禁：把全部 `@deepseek-ai/*` 依赖用 pnpm overrides 钉到
 * `0.1.0-rc.6` 线重装，然后在 rc.6 线上跑完整编译（typecheck）与上游契约
 * 门禁（verify:contract）。
 *
 * 证明「rc.6 核心也能装能跑」的承诺不烂：blessed 符号只在 rc.7 存在、
 * 或 peer 范围把 rc.6 拒之门外，都会在这里先爆，而不是在用户机器上爆。
 * CI 的 verify-rc6 job 直接调它（`pnpm run verify:rc6`）。
 *
 * 两个防假阳性要点：
 * - 安装前删除 pnpm-lock.yaml：仅改 overrides 时 pnpm 会判定 lockfile
 *   "up to date" 跳过重解析，overrides 静默不生效（实测踩过）；
 * - 安装后逐一断言每个被钉包的 node_modules 版本确实是 0.1.0-rc.6。
 *
 * overrides 必须写进 pnpm-workspace.yaml：pnpm 11 起 package.json 的
 * `pnpm.overrides` 字段已不再读取（会被静默忽略）。
 *
 * 前置条件：pnpm 版本需满足 vendor/dsh-std 的 `packageManager` 钉死
 * （当前 11.21.0，corepack 会直接拒绝低版本）。
 *
 * 注意：本脚本会改写 pnpm-workspace.yaml / pnpm-lock.yaml 并把 node_modules
 * 切到 rc.6（CI 里是临时 checkout，无影响）。本地跑完想恢复，请执行：
 *   git checkout pnpm-workspace.yaml pnpm-lock.yaml && pnpm install --frozen-lockfile
 *
 * 运行：node scripts/verify-rc6-compat.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspaceYamlPath = path.join(root, 'pnpm-workspace.yaml')
const lockfilePath = path.join(root, 'pnpm-lock.yaml')

/** Every @deepseek-ai/* entry whose spec lives on the 0.1.0-rc line. */
function collectRcSpecs(manifest) {
  const specs = []
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
      if (name.startsWith('@deepseek-ai/') && /0\.1\.0-rc\./.test(spec)) specs.push(name)
    }
  }
  return [...new Set(specs)].sort()
}

/** Insert an `overrides` block into pnpm-workspace.yaml before `allowBuilds:`. */
function withOverrides(yaml, overrides) {
  const block = ['overrides:', ...Object.entries(overrides).map(([name, version]) => `  '${name}': ${version}`)].join('\n')
  const marker = '\nallowBuilds:'
  const index = yaml.indexOf(marker)
  if (index === -1) throw new Error('pnpm-workspace.yaml: cannot locate `allowBuilds:` to insert overrides')
  return `${yaml.slice(0, index)}\n${block}${yaml.slice(index)}`
}

const run = (cmd, args) => {
  console.log(`+ ${cmd} ${args.join(' ')}`)
  if (process.platform === 'win32') {
    // Windows cannot spawn .cmd directly (EINVAL), and shell:true trips the
    // DEP0190 unescaped-args warning; go through cmd.exe explicitly.
    execFileSync('cmd.exe', ['/d', '/s', '/c', `${cmd} ${args.join(' ')}`], { cwd: root, stdio: 'inherit' })
  } else {
    execFileSync(cmd, args, { cwd: root, stdio: 'inherit' })
  }
}

function main() {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const targets = collectRcSpecs(manifest)
  if (targets.length === 0) {
    throw new Error('no @deepseek-ai/* rc-line specs found — nothing to pin')
  }

  console.log(`verify-rc6-compat: pinning ${targets.length} @deepseek-ai/* packages to 0.1.0-rc.6`)
  // Overrides-only changes are skipped by pnpm's "lockfile up to date" check;
  // delete the lockfile so resolution actually re-runs with the overrides.
  if (existsSync(lockfilePath)) rmSync(lockfilePath)
  run('pnpm', ['install', '--no-frozen-lockfile'])

  // Assert the override really landed — a skipped re-resolution would leave
  // rc.7 installed and silently falsify the whole gate.
  const mismatched = []
  for (const name of targets) {
    const installedPath = path.join(root, 'node_modules', ...name.split('/'), 'package.json')
    if (!existsSync(installedPath)) {
      mismatched.push(`${name}: not installed (missing ${path.relative(root, installedPath)})`)
      continue
    }
    const installed = JSON.parse(readFileSync(installedPath, 'utf8')).version
    if (installed !== '0.1.0-rc.6') mismatched.push(`${name}: installed=${installed}`)
  }
  if (mismatched.length > 0) {
    throw new Error(`override did not land on the rc.6 line:\n  - ${mismatched.join('\n  - ')}`)
  }
  console.log(`verify-rc6-compat: confirmed ${targets.length} packages at 0.1.0-rc.6`)

  run('pnpm', ['compile'])
  run('pnpm', ['verify:contract'])
  console.log('verify-rc6-compat: rc.6 install compiles and matches the upstream contract — OK')
}

const originalWorkspace = readFileSync(workspaceYamlPath, 'utf8')
const originalLockfile = existsSync(lockfilePath) ? readFileSync(lockfilePath, 'utf8') : undefined
writeFileSync(
  workspaceYamlPath,
  withOverrides(originalWorkspace, Object.fromEntries(collectRcSpecs(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))).map(name => [name, '0.1.0-rc.6']))),
)
try {
  main()
} finally {
  writeFileSync(workspaceYamlPath, originalWorkspace)
  if (originalLockfile !== undefined) writeFileSync(lockfilePath, originalLockfile)
}
