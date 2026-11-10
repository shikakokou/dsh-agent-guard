# dsh-agent-guard

dsh-agent-guard 是 DeepSeek Harness 的插件，在 Host 里强制约束 agent 的行为，并在输入框的工具行里放一个面板，用来编辑这些约束。被委派出去的下级 agent 统称子 agent，teammate 和普通 subagent 都算。

## 七道约束

**子 agent**
- 启动参数：子 agent 的启动参数由插件强制，一律使用配置里的 provider、model 和 reasoningEffort，父 agent 传入的值会被替换。
- 并发上限：并发上限按活跃子 agent 的总数计算，到上限后新建会被拒绝并返回原因，已经结束的成员不占名额。
- 禁止 sleep 轮询：Lead 执行 Start-Sleep 或 sleep 会被拒绝。
- 步数限制：每轮步数预算用完后，子 agent 只能输出报告，预算在下一轮开始时重置。
- 写入上限：每轮文件写入上限同样按轮计算，子 agent 当前轮写入的不同文件数到上限后，只能继续改已经写过的文件，写入计数在下一轮开始时重置。

**Lead**
- 监督者与调度者角色：按「Lead 不自己改文件」的约束，Lead 调 write、edit、str_replace_editor 会被拒绝，提示把 task 拆给 teammate 或 subagent。
- 步数限制：Lead 每轮步数上限用完后，只剩 spawn、send_message、team_task 系列和汇报类工具可用。

这些拦截都由 Host 执行，模型无法绕过。

## 安装

前提是 `dsh` CLI 已经装好、pnpm 可用。把仓库克隆或复制到本机任意目录，在该目录执行：

```powershell
pnpm install
pnpm build
dsh plugin --profile web add .
```

停用方式是在 profile 的 cordis.patch.yml 里写入：

```yaml
- id: agent-guard
  disabled: true
```

## 配置

本插件的配置写在 profile 的 cordis.patch.yml 里，面板保存后写入同一处并立即生效：

```yaml
- id: agent-guard
  config:
    enabled: true
    scope: team
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: low
    maxConcurrentChildren: 4
    banSleepPolling: true
    stepBudget: 25
    maxFilesPerAgent: 12
    leadNoWrite: true
    leadStepBudget: 24
```

推理强度是自由文本，面板只给常见档位建议，实际能用的档位由 provider 适配器公布的模型能力决定。填了不支持的档位，DSH 的 LLM 服务会在发请求前报 UNSUPPORTED_REASONING_EFFORT；deepseek 系只接受 `off/low/high/max`，pi-ai 提供的模型可能有 `xhigh` 之类的自定义档位。

面板文案和拒绝原因都跟随 DSH 的界面语言，没有显式选过语言时用中文，改过语言后从下一次拒绝开始生效；日志保持英文。

## 开发

```powershell
pnpm build        # 产出 dist/client.js
pnpm typecheck    # tsc --noEmit
node test/guard-scenarios.mjs   # Lead 拦截矩阵回归，不依赖 DSH
```

改完 src 或 index.js 后执行 pnpm build，再重启 dsh web。Host 端代码和客户端 bundle 都在启动时加载。
