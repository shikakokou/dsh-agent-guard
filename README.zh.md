# dsh-agent-guard

给 DeepSeek Harness 加一层护栏，约束被委派出去的子 agent 和 Lead 的行为，并在输入框的工具行放一个面板，方便调整这些规则。拦截全部在 Host 侧执行，模型无法绕过。

## 作用范围

| 对象 | 约束 | 效果 |
| --- | --- | --- |
| 子 agent | 启动参数 | 强制使用插件指定的 provider、model 和推理强度，不接受子 agent 自行选择 |
| 子 agent | 并发 | 活跃子 agent 数量达到上限时拒绝新建并说明原因，已经结束的不占名额 |
| 子 agent | sleep 轮询 | Lead 执行 sleep 或 Start-Sleep 会被拒绝 |
| 子 agent | 步数 | 每轮预算用完后只能输出报告，下一轮开始时重置，设为 0 表示不限制 |
| 子 agent | 写入 | 每轮可写的不同文件数达到上限后，只能继续修改已经写过的文件，设为 0 表示不限制 |
| Lead | 直接执行 | Lead 调用 read、grep、glob、write、edit 等工具会被拒绝，只允许读取用户明确引用的路径，可以运行 tsc、build、test、git diff 这类验证命令。调查交给 subagent，执行交给 teammate |
| Lead | 步数 | 每轮预算用完后仅保留派发、消息、任务和汇报类工具，设为 0 表示不限制 |

## 安装

前提是 dsh CLI 已经就绪且 pnpm 可用。在插件仓库目录下依次执行

```bash
pnpm install
pnpm build
dsh plugin --profile web add .
```

## 配置

配置写在 profile 的 cordis.patch.yml 文件中。面板保存后写回同一位置并立即生效。

```yaml
- id: agent-guard
  config:
    enabled: true
    scope: team

    # 基础三元组，未归类的子 agent 使用
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: low

    # investigate 组，subagent 的只读调查
    investigateProvider: deepseek-account
    investigateModel: deepseek-flash
    investigateReasoningEffort: high

    # execute 组，teammate 的执行任务
    executeProvider: deepseek-account
    executeModel: deepseek-flash
    executeReasoningEffort: low

    inheritLeadConfig: false
    maxConcurrentChildren: 4
    banSleepPolling: true
    stepBudget: 40
    maxFilesPerAgent: 24
    leadNoExecute: true
    leadStepBudget: 24
```

模型的三个字段分为两组，按用途覆盖基础三元组。subagent 和 subagent_fork 使用 investigate 组，spawn_teammate 使用 execute 组。任意一项留空则回退到该组自己的默认值，也就是示例中的六项。把 inheritLeadConfig 设为 true 可以跳过强制覆盖，让子 agent 沿用 Lead 的配置，这是 DSH 的默认行为。

推理强度是自由文本，面板只提供常见档位作为提示，实际可用档位由 provider 公布的模型能力决定。填入不支持的档位会在发送请求前报错，deepseek 系接受 off、low、high、max。面板文案和拒绝原因跟随 DSH 界面语言，未设置时使用中文。

## 停用

```yaml
- id: agent-guard
  disabled: true
```

## 开发

```bash
pnpm build        # 产出 dist/client.js
pnpm typecheck    # tsc --noEmit
```

改动 src 或 index.js 之后需要重新构建并重启 dsh web。Host 端代码和客户端 bundle 都在启动时加载。