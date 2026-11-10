import assert from 'node:assert/strict'
import { apply } from '../index.js'

const BASE = {
  enabled: true,
  scope: 'team',
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  reasoningEffort: 'low',
  maxConcurrentChildren: 4,
  banSleepPolling: true,
  stepBudget: 0,
  maxFilesPerAgent: 0,
  leadNoWrite: true,
  leadStepBudget: 0,
}

function makeAgent(role = 'lead', id = 'lead-1') {
  const depth = role === 'teammate' ? 1 : 0
  return {
    id,
    role,
    session: { id, header: { delegationDepth: depth }, snapshotEvents: () => [] },
    options: {},
  }
}

function makeTeams({ teammate = false, task = false } = {}) {
  return {
    tryMembership(agent) {
      if (agent?.role === 'lead') return { role: 'lead' }
      if (agent?.role === 'teammate') return { role: 'teammate' }
      return undefined
    },
    listMembers() {
      return [{ role: 'lead' }, ...(teammate ? [{ role: 'teammate', status: 'inactive' }] : [])]
    },
    listTasks() {
      return task ? [{ id: 'task-1' }] : []
    },
  }
}

function createHarness(config, { teamsAvailable = true, teammate = false, task = false } = {}) {
  const handlers = new Map()
  const teams = makeTeams({ teammate, task })
  const ctx = {
    subagents: { startActivation: async spec => ({ childId: 'child-1', spec }) },
    logger: { info() {}, warn() {}, error() {} },
    get(name, fallback) {
      return name === 'agentTeams' ? (teamsAvailable ? teams : undefined) : fallback
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => {}
    },
    effect() {
      return () => {}
    },
    inject(_deps, callback) {
      callback({
        effect() { return () => {} },
        sessionProjections: { register() { return () => {} } },
      })
    },
  }
  apply(ctx, { ...BASE, ...config })
  const pre = handlers.get('tools/pre-execute')
  const sessionEvent = handlers.get('session/event')
  assert.equal(typeof pre, 'function', 'tools/pre-execute handler was not registered')
  assert.equal(typeof sessionEvent, 'function', 'session/event handler was not registered')

  return {
    async tool(name, { agent, args = {} }) {
      const result = await pre({ name, arguments: args, agent }, () => ({ kind: 'allow' }))
      return result.kind
    },
    event(agent, type) {
      sessionEvent(agent.session, { type })
    },
  }
}

const writeArgs = { file_path: 'src/example.ts' }
const readArgs = { file_path: 'src/example.ts' }

const results = []
async function check(title, fn) {
  try {
    await fn()
    results.push({ title, ok: true })
  } catch (error) {
    results.push({ title, ok: false, error })
  }
}

const writeOutcome = async (config, options = {}) => {
  const harness = createHarness(config, options)
  return await harness.tool('write', { agent: makeAgent(), args: writeArgs })
}

await check('disabled + all scope: lead write allowed', async () => {
  assert.equal(await writeOutcome({ enabled: false, scope: 'all' }), 'allow')
})

await check('enabled + Lead cannot edit files off + all: allowed', async () => {
  assert.equal(await writeOutcome({ leadNoWrite: false, scope: 'all' }), 'allow')
})

await check('team scope, no teammate or task: denied', async () => {
  assert.equal(await writeOutcome({}), 'deny')
})

await check('team scope, roster has teammate: denied', async () => {
  assert.equal(await writeOutcome({}, { teammate: true }), 'deny')
})

await check('team scope, non-deleted task exists: denied', async () => {
  assert.equal(await writeOutcome({}, { task: true }), 'deny')
})

await check('all scope, no agent team capability: denied', async () => {
  assert.equal(await writeOutcome({ scope: 'all' }, { teamsAvailable: false }), 'deny')
})

await check('all scope, team session: denied', async () => {
  assert.equal(await writeOutcome({ scope: 'all' }), 'deny')
})

await check('team scope, no agent team capability: allowed', async () => {
  assert.equal(await writeOutcome({}, { teamsAvailable: false }), 'allow')
})

await check('all scope, teammate writes: allowed', async () => {
  const harness = createHarness({ scope: 'all' }, { teammate: true })
  assert.equal(await harness.tool('write', { agent: makeAgent('teammate', 'member-1'), args: writeArgs }), 'allow')
})

const runTwoSteps = harness => {
  const agent = makeAgent()
  harness.event(agent, 'turn/start')
  harness.event(agent, 'step/start')
  harness.event(agent, 'step/start')
  return agent
}

await check('team scope, no teammate or task: lead step budget enforced', async () => {
  const harness = createHarness({ leadStepBudget: 1 })
  const agent = runTwoSteps(harness)
  assert.equal(await harness.tool('read', { agent, args: readArgs }), 'deny')
})

await check('team scope, teammate present: lead step budget enforced', async () => {
  const harness = createHarness({ leadStepBudget: 1 }, { teammate: true })
  const agent = runTwoSteps(harness)
  assert.equal(await harness.tool('read', { agent, args: readArgs }), 'deny')
})

await check('all scope: lead step budget enforced', async () => {
  const harness = createHarness({ scope: 'all', leadStepBudget: 1 })
  const agent = runTwoSteps(harness)
  assert.equal(await harness.tool('read', { agent, args: readArgs }), 'deny')
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
