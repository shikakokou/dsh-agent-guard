import assert from 'node:assert/strict'
import { apply } from '../index.js'

const BASE = {
  enabled: true,
  scope: 'team',
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  reasoningEffort: 'low',
  inheritLeadConfig: false,
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

function makeTeams() {
  return {
    tryMembership(agent) {
      if (agent?.role === 'lead') return { role: 'lead' }
      if (agent?.role === 'teammate') return { role: 'teammate' }
      return undefined
    },
  }
}

function createHarness(config, { teamsAvailable = true } = {}) {
  const handlers = new Map()
  const teams = makeTeams()
  const activations = []
  const ctx = {
    subagents: {
      async startActivation(spec) {
        activations.push(spec)
        return { childId: 'child-1', spec }
      },
    },
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
    start(spec) {
      return ctx.subagents.startActivation(spec)
    },
    activations,
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

await check('team scope: Lead write denied', async () => {
  assert.equal(await writeOutcome({}), 'deny')
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
  const harness = createHarness({ scope: 'all' })
  assert.equal(await harness.tool('write', { agent: makeAgent('teammate', 'member-1'), args: writeArgs }), 'allow')
})

const runTwoSteps = harness => {
  const agent = makeAgent()
  harness.event(agent, 'turn/start')
  harness.event(agent, 'step/start')
  harness.event(agent, 'step/start')
  return agent
}

await check('team scope: lead step budget enforced', async () => {
  const harness = createHarness({ leadStepBudget: 1 })
  const agent = runTwoSteps(harness)
  assert.equal(await harness.tool('read', { agent, args: readArgs }), 'deny')
})

await check('all scope: lead step budget enforced', async () => {
  const harness = createHarness({ scope: 'all', leadStepBudget: 1 })
  const agent = runTwoSteps(harness)
  assert.equal(await harness.tool('read', { agent, args: readArgs }), 'deny')
})

const startSpec = (parent, agentOptions) => ({
  provider: 'in-process',
  label: 'child',
  request: {
    prompt: [],
    parent,
    ...(agentOptions === undefined ? {} : { agentOptions: { ...agentOptions } }),
  },
})

const requestAgentOptions = harness => harness.activations.at(-1)?.request?.agentOptions

await check('inheritLeadConfig off + Lead parent: provider/model/reasoningEffort are forced', async () => {
  const harness = createHarness({})
  await harness.start(startSpec(makeAgent(), { provider: 'caller-provider', model: 'caller-model', reasoningEffort: 'high' }))
  const agentOptions = requestAgentOptions(harness)
  assert.equal(agentOptions.provider, 'deepseek-account')
  assert.equal(agentOptions.model, 'deepseek-flash')
  assert.equal(agentOptions.reasoningEffort, 'low')
})

await check('inheritLeadConfig on + Lead parent: child keeps the caller provider/model/reasoningEffort', async () => {
  const harness = createHarness({ inheritLeadConfig: true })
  await harness.start(startSpec(makeAgent(), { provider: 'lead-provider', model: 'lead-model', reasoningEffort: 'high' }))
  assert.deepEqual(requestAgentOptions(harness), {
    provider: 'lead-provider',
    model: 'lead-model',
    reasoningEffort: 'high',
  })
})

await check('inheritLeadConfig off + non-lead parent in team scope: caller options are not overridden', async () => {
  const harness = createHarness({})
  await harness.start(startSpec(makeAgent('teammate', 'member-1'), { provider: 'caller-provider', model: 'caller-model', reasoningEffort: 'high' }))
  assert.deepEqual(requestAgentOptions(harness), {
    provider: 'caller-provider',
    model: 'caller-model',
    reasoningEffort: 'high',
  })
})

const childAgent = (id = 'child-member') => makeAgent('teammate', id)

const startTurn = (harness, agent, steps = 0) => {
  harness.event(agent, 'turn/start')
  for (let index = 0; index < steps; index += 1) harness.event(agent, 'step/start')
}

await check('stepBudget 0: child agent keeps running past any step count', async () => {
  const harness = createHarness({ stepBudget: 0 })
  const agent = childAgent()
  startTurn(harness, agent, 40)
  assert.equal(await harness.tool('read', { agent, args: readArgs }), 'allow')
})

await check('stepBudget N: N steps allowed, step N+1 denied, turn/start resets', async () => {
  const harness = createHarness({ stepBudget: 3 })
  const agent = childAgent()
  harness.event(agent, 'turn/start')
  const outcomes = []
  for (let index = 0; index < 4; index += 1) {
    harness.event(agent, 'step/start')
    outcomes.push(await harness.tool('read', { agent, args: readArgs }))
  }
  assert.deepEqual(outcomes, ['allow', 'allow', 'allow', 'deny'])
  startTurn(harness, agent, 1)
  assert.equal(await harness.tool('read', { agent, args: readArgs }), 'allow')
})

const writeFile = (harness, agent, path) => harness.tool('write', { agent, args: { file_path: path } })

await check('maxFilesPerAgent 0: unlimited distinct files', async () => {
  const harness = createHarness({ maxFilesPerAgent: 0 })
  const agent = childAgent()
  for (let index = 0; index < 20; index += 1) {
    assert.equal(await writeFile(harness, agent, `src/f${index}.ts`), 'allow')
  }
})

await check('maxFilesPerAgent N: N distinct files allowed, N+1 denied, repeats free, turn reset', async () => {
  const harness = createHarness({ maxFilesPerAgent: 2 })
  const agent = childAgent()
  assert.equal(await writeFile(harness, agent, 'src/a.ts'), 'allow')
  assert.equal(await writeFile(harness, agent, 'src/b.ts'), 'allow')
  assert.equal(await writeFile(harness, agent, 'src/a.ts'), 'allow')
  assert.equal(await writeFile(harness, agent, 'src/c.ts'), 'deny')
  harness.event(agent, 'turn/start')
  assert.equal(await writeFile(harness, agent, 'src/c.ts'), 'allow')
})

await check('maxFilesPerAgent also counts str_replace_editor (path argument)', async () => {
  const harness = createHarness({ maxFilesPerAgent: 1 })
  const agent = childAgent()
  assert.equal(await harness.tool('str_replace_editor', { agent, args: { command: 'create', path: 'src/a.ts' } }), 'allow')
  assert.equal(await writeFile(harness, agent, 'src/b.ts'), 'deny')
})

await check('leadStepBudget 0: Lead is not step-limited', async () => {
  const harness = createHarness({ leadStepBudget: 0 })
  const agent = makeAgent()
  startTurn(harness, agent, 40)
  assert.equal(await harness.tool('read', { agent, args: readArgs }), 'allow')
})

await check('leadStepBudget N: N steps allowed, N+1 denied, coordination tools still allowed', async () => {
  const harness = createHarness({ leadStepBudget: 2 })
  const agent = makeAgent()
  harness.event(agent, 'turn/start')
  const outcomes = []
  for (let index = 0; index < 3; index += 1) {
    harness.event(agent, 'step/start')
    outcomes.push(await harness.tool('read', { agent, args: readArgs }))
  }
  assert.deepEqual(outcomes, ['allow', 'allow', 'deny'])
  assert.equal(await harness.tool('send_message', { agent, args: { target: 'member-1', message: 'status?' } }), 'allow')
  assert.equal(await harness.tool('team_task_create', { agent, args: { subject: 's', description: 'd' } }), 'allow')
  assert.equal(await harness.tool('list_agents', { agent, args: {} }), 'allow')
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
