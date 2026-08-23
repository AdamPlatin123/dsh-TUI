#!/usr/bin/env node
/**
 * Regression: the compiled npm layout must resolve the package-root skills/
 * directory and register every bundled SKILL.md through the host registry.
 *
 * Run after compile: `node scripts/verify-packaged-skills.mjs`.
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerPackagedSkills } from '../lib/types/dsh-adapter/packaged-skills.js'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const skillsRoot = join(packageRoot, 'skills')
const expectedNames = readdirSync(skillsRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, 'SKILL.md')))
  .map(entry => entry.name)
  .sort()

const registered = []
const warnings = []
registerPackagedSkills({
  get(name) {
    if (name !== 'skills') return undefined
    return {
      register(skill) {
        registered.push(skill)
        return () => {}
      },
    }
  },
  logger: {
    warn(message) { warnings.push(message) },
  },
})

assert.ok(expectedNames.length > 0, 'the package must contain at least one bundled skill')
assert.deepEqual(registered.map(skill => skill.name).sort(), expectedNames)
assert.deepEqual(warnings, [])
for (const skill of registered) {
  assert.equal(skill.provider, 'dsh-tui')
  assert.equal(skill.source, 'bundled')
  assert.equal(skill.path, join(skillsRoot, skill.name, 'SKILL.md'))
}

console.log(`packaged skills OK (${registered.length} registered)`)
