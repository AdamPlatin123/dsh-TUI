/**
 * Real Cordis lifecycle boundary regression. Public extension services must
 * never let ctx.root turn a plugin-owned effect into a root-owned effect.
 *
 * Run: node --import tsx/esm scripts/verify-plugin-lifecycle.ts
 */

import { Context } from '@deepseek-ai/cordis'
import { TuiDialogRuntime, getHostDialogStore } from '../src/dsh-adapter/dialogs.js'
import { TuiStatusRuntime, getHostStatusStore } from '../src/dsh-adapter/status.js'
import TuiShortcutRuntime, { getHostShortcuts } from '../src/dsh-adapter/shortcuts.js'
import { TuiRendererRuntime, getHostRenderers } from '../src/dsh-adapter/renderers.js'
import TuiSceneRuntime, { getHostSceneRuntime } from '../src/dsh-adapter/scenes.js'
import TuiSettingsSectionsRuntime, { getHostSettingsSections } from '../src/dsh-adapter/settings-sections.js'
import TuiWorkspaceRuntime from '../src/dsh-adapter/workspaces.js'
import TuiCommandTreeRuntime from '../src/dsh-adapter/command-trees.js'

let failures = 0
let checks = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === '' ? '' : `: ${detail}`}`)
}

const root = new Context()
await root.plugin(TuiDialogRuntime)
await root.plugin(TuiStatusRuntime)
await root.plugin(TuiShortcutRuntime)
await root.plugin(TuiRendererRuntime)
await root.plugin(TuiSceneRuntime)
await root.plugin(TuiSettingsSectionsRuntime)
await root.plugin(TuiWorkspaceRuntime)
await root.plugin(TuiCommandTreeRuntime)

const dialogs = getHostDialogStore(root.get('tuiDialogs'))
const status = getHostStatusStore(root.get('tuiStatus'))
const shortcuts = getHostShortcuts(root.get('tuiShortcuts'))
const renderers = getHostRenderers(root.get('tuiRenderers'))
const scenes = getHostSceneRuntime(root.get('tuiScenes'))
const sections = getHostSettingsSections(root.get('tuiSettingsSections'))
if (dialogs === undefined || status === undefined || shortcuts === undefined || renderers === undefined || scenes === undefined || sections === undefined) {
  throw new Error('lifecycle battery could not resolve host accessors')
}

// A plugin can read ctx.root, but cannot use it to attach an effect to the
// host fiber. Mutating entries reject or return their documented inert result.
let rootSceneRejected = false
let rootSettingsRejected = false
let rootWorkspaceRejected = false
let rootTreeRejected = false
let rootDialog: Promise<boolean> | undefined
const rootProbe = root.inject(
  ['tuiDialogs', 'tuiStatus', 'tuiShortcuts', 'tuiRenderers', 'tuiScenes', 'tuiSettingsSections', 'tuiWorkspaces', 'tuiCommandTrees'],
  (pluginCtx) => {
    const rootCtx = pluginCtx.root
    rootCtx.get('tuiStatus')?.set('root-leak', 'must not persist')
    rootCtx.get('tuiShortcuts')?.register('alt+z', { description: 'root leak', handler: () => {} })
    rootCtx.get('tuiRenderers')?.register('root/leak', () => ({ lines: ['must not persist'] }))
    rootDialog = rootCtx.get('tuiDialogs')?.confirm({ title: 'must not queue' })
    try {
      rootCtx.get('tuiScenes')?.register({ id: 'root-leak', component: () => null })
    } catch {
      rootSceneRejected = true
    }
    try {
      rootCtx.get('tuiSettingsSections')?.register({ ns: 'root-leak', title: 'Root leak', fields: [] })
    } catch {
      rootSettingsRejected = true
    }
    try {
      rootCtx.get('tuiWorkspaces')?.register({
        schemes: ['root-leak'],
        list: () => [],
        resolve: () => undefined,
        describe: () => undefined,
      })
    } catch {
      rootWorkspaceRejected = true
    }
    try {
      rootCtx.get('tuiCommandTrees')?.register({ root: 'root-leak', children: () => [] })
    } catch {
      rootTreeRejected = true
    }
  },
)
await rootProbe
check('root status call leaves no contribution', status.getSnapshot().length === 0)
check('root shortcut call leaves no binding', shortcuts.dispatch('z', { meta: true }) === false)
check('root renderer call leaves no renderer', renderers.render('root/leak', {}) === undefined)
check('root dialog call leaves no queue entry', dialogs.getSnapshot() === null && (await rootDialog) === false)
check('root scene registration is rejected', rootSceneRejected)
check('root settings registration is rejected', rootSettingsRejected)
check('root workspace registration is rejected', rootWorkspaceRejected)
check('root command-tree registration is rejected', rootTreeRejected)
await rootProbe.dispose()

let pluginDialog: Promise<boolean> | undefined
const pluginFiber = root.inject(
  ['tuiDialogs', 'tuiStatus', 'tuiShortcuts', 'tuiRenderers', 'tuiScenes', 'tuiSettingsSections', 'tuiWorkspaces', 'tuiCommandTrees'],
  (pluginCtx) => {
    pluginCtx.tuiStatus.set('lifecycle', 'active')
    pluginCtx.tuiShortcuts.register('alt+x', { description: 'lifecycle', handler: () => {} })
    pluginCtx.tuiRenderers.register('lifecycle/note', () => ({ lines: ['active'] }))
    pluginCtx.tuiScenes.register({ id: 'lifecycle', component: () => null })
    pluginCtx.tuiScenes.open('lifecycle')
    pluginCtx.tuiSettingsSections.register({ ns: 'lifecycle', title: 'Lifecycle', fields: [] })
    pluginCtx.tuiWorkspaces.register({
      schemes: ['lifecycle'],
      list: () => [],
      resolve: () => undefined,
      describe: () => undefined,
      commands: [{ name: 'lifecycle', description: 'Lifecycle', run: () => ({ kind: 'choices', title: 'Lifecycle', choices: [] }) }],
    })
    pluginCtx.tuiCommandTrees.register({ root: 'lifecycle', children: () => [{ name: 'child', description: 'Child' }] })
    pluginDialog = pluginCtx.tuiDialogs.confirm({ title: 'Dispose me' })
  },
)
await pluginFiber
check('live plugin effects are visible before dispose',
  status.getSnapshot().some(entry => entry.key === 'lifecycle')
  && scenes.active?.id === 'lifecycle'
  && sections.list().some(section => section.ns === 'lifecycle')
  && shortcuts.dispatch('x', { meta: true })
  && renderers.render('lifecycle/note', {})?.lines[0] === 'active'
  && root.get('tuiWorkspaces')?.commands().some(command => command.name === 'lifecycle') === true
  && root.get('tuiCommandTrees')?.children(['lifecycle']).length === 1
  && dialogs.getSnapshot()?.kind === 'confirm')

await pluginFiber.dispose()
check('plugin dialog is cancelled on its fiber dispose', (await pluginDialog) === false)
check('fiber dispose releases every registered extension effect',
  status.getSnapshot().length === 0
  && scenes.active === undefined
  && sections.list().length === 0
  && shortcuts.dispatch('x', { meta: true }) === false
  && renderers.render('lifecycle/note', {}) === undefined
  && root.get('tuiWorkspaces')?.commands().some(command => command.name === 'lifecycle') === false
  && root.get('tuiCommandTrees')?.children(['lifecycle']).length === 0
  && dialogs.getSnapshot() === null)

await root.fiber.dispose()
if (failures > 0) {
  console.error(`plugin lifecycle battery FAILED (${failures}/${checks})`)
  process.exit(1)
}
console.log(`plugin lifecycle battery OK (${checks} checks)`)
