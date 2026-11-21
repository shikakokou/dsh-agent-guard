import assert from 'node:assert/strict'
import path from 'node:path'
import { Config, apply } from '../index.js'

const cwd = process.cwd()

function mount({ config = { leadNoExecute: true }, preference = 'zh' } = {}) {
  const handlers = new Map()
  apply({
    logger: { info() {}, warn() {}, error() {} },
    get: name => {
      if (name === 'agentTeams') {
        return {
          tryMembership: agent => (agent?.role === 'lead' ? { role: 'lead' } : undefined),
          listMembers: () => [],
        }
      }
      if (name === 'settings') {
        return { describe: () => ({ namespaces: [{ ns: 'locale', value: { preference } }] }) }
      }
      return undefined
    },
    on: (event, handler) => handlers.set(event, handler),
    effect() {},
    inject() {},
  }, config)
  const preExecute = handlers.get('tools/pre-execute')
  assert.equal(typeof preExecute, 'function', 'tools/pre-execute handler registered')
  return async function decide(exec) {
    let passed = false
    const result = await preExecute(exec, async () => { passed = true })
    if (passed) return 'allow'
    assert.equal(result?.kind, 'deny', 'a blocked call must come back as a deny')
    return result.reason
  }
}

function agent({ role = 'lead', depth = 0, said = '' } = {}) {
  const messages = said === ''
    ? []
    : [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: said }] }]
  return {
    role,
    session: {
      id: `${role}-${depth}-${said}`,
      header: { cwd, delegationDepth: depth },
      deriveMessages: () => messages,
    },
    options: {},
  }
}

const results = []
async function check(title, fn) {
  try {
    await fn()
    results.push({ title, ok: true })
  } catch (error) {
    results.push({ title, ok: false, error })
  }
}

const read = (filePath, owner = agent()) => ({ name: 'read', arguments: { file_path: filePath }, agent: owner })
const write = (filePath, owner = agent()) => ({ name: 'write', arguments: { file_path: filePath }, agent: owner })

await check('the Lead is refused write/edit/str_replace_editor/grep/glob, and the reason names the tool', async () => {
  const decide = mount()
  for (const name of ['write', 'edit', 'str_replace_editor', 'grep', 'glob']) {
    const reason = await decide({ name, arguments: { file_path: 'index.js' }, agent: agent() })
    assert.notEqual(reason, 'allow', `${name} must be refused`)
    assert.ok(reason.includes(name), `${name} refusal should name the tool: ${reason}`)
  }
})

await check('a refusal carries a fill-in delegation template naming goal/ctx/acceptance/output', async () => {
  const decide = mount()
  const cases = [
    { name: 'read', target: 'subagent' },
    { name: 'grep', target: 'subagent' },
    { name: 'glob', target: 'subagent' },
    { name: 'write', target: 'spawn_teammate' },
    { name: 'edit', target: 'spawn_teammate' },
    { name: 'str_replace_editor', target: 'spawn_teammate' },
  ]
  for (const { name, target } of cases) {
    const reason = await decide({ name, arguments: { file_path: 'index.js' }, agent: agent() })
    assert.notEqual(reason, 'allow', `${name} must be refused`)
    assert.ok(reason.includes(name), `${name} refusal should name the tool: ${reason}`)
    // Locate the template by its fields (not by a heading string), then assert the
    // whole contract on that segment only: target + four fields + ≤3 lines.
    const lines = reason.split('\n')
    const start = lines.findIndex(line => line.includes('goal='))
    assert.ok(start !== -1, `${name} refusal should carry a goal= field: ${reason}`)
    const template = lines.slice(start)
    for (const field of [target, 'goal=', 'ctx=', 'acceptance=', 'output=']) {
      assert.ok(template.join('\n').includes(field), `${name} template should mention ${field}: ${template.join('\n')}`)
    }
    assert.ok(template.length <= 3, `${name} template should stay within 3 lines: ${template.join('\n')}`)
  }
})

await check('the Lead may read a file the user @-referenced, and not its sibling', async () => {
  const decide = mount()
  const said = '@src/client.tsx 看一下这个'
  assert.equal(await decide(read('src/client.tsx', agent({ said }))), 'allow')
  assert.equal(await decide(read(path.resolve(cwd, 'src/client.tsx'), agent({ said }))), 'allow')
  assert.notEqual(await decide(read('src/other.ts', agent({ said }))), 'allow')
})

await check('a referenced directory covers its subtree but not a sibling prefix', async () => {
  const decide = mount()
  const said = '看 `src/locales` 里的字符串'
  assert.equal(await decide(read('src/locales/zh.json', agent({ said }))), 'allow')
  assert.notEqual(await decide(read('src/localesx/zh.json', agent({ said }))), 'allow')
})

await check('quoted paths with spaces, bare Windows paths and trailing punctuation resolve', async () => {
  const decide = mount()
  const quoted = String.raw`@"D:\a b\c.ts" 打开它`
  assert.equal(await decide(read(String.raw`D:\a b\c.ts`, agent({ said: quoted }))), 'allow')
  const bareWindows = String.raw`open D:\work\file.ts and check it`
  assert.equal(await decide(read(String.raw`D:\work\file.ts`, agent({ said: bareWindows }))), 'allow')
  assert.equal(await decide(read('src/client.tsx', agent({ said: '@src/client.tsx, please review this' }))), 'allow')
})

await check('a URL in the message does not reference a file', async () => {
  const decide = mount()
  assert.notEqual(await decide(read('src/client.tsx', agent({ said: 'see https://example.com/x for details' }))), 'allow')
})

await check('with no user message the Lead may not read a file', async () => {
  const decide = mount()
  assert.notEqual(await decide(read('index.js')), 'allow')
})

await check('a teammate at depth 1 reads and writes freely', async () => {
  const decide = mount()
  const teammate = agent({ role: 'teammate', depth: 1 })
  assert.equal(await decide(read('index.js', teammate)), 'allow')
  assert.equal(await decide(write('index.js', teammate)), 'allow')
})

await check('leadNoExecute: false lets the Lead write', async () => {
  const decide = mount({ config: { leadNoExecute: false } })
  assert.equal(await decide(write('index.js')), 'allow')
})

await check('the deprecated leadNoWrite: false still disables the Lead gate', async () => {
  const decide = mount({ config: Config({ leadNoWrite: false }) })
  assert.equal(await decide(write('index.js')), 'allow')
})

await check('enabled: false disables every guard', async () => {
  const decide = mount({ config: { enabled: false } })
  assert.equal(await decide(write('index.js')), 'allow')
})

for (const { title, ok } of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${title}`)
}
const failed = results.filter(result => !result.ok)
if (failed.length > 0) {
  console.error('')
  for (const result of failed) console.error(result.error)
  process.exitCode = 1
} else {
  console.log(`\n${results.length}/${results.length} passed`)
}
