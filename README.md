# dsh-agent-guard

给 DeepSeek Harness 加一层护栏，约束被委派出去的子 agent 和 Lead，并在输入框的工具行提供调整面板。拦截全部在 Host 侧的 DSH 工具调用上执行。

## 作用范围

| 对象 | 约束 | 效果 |
| --- | --- | --- |
| 子 agent | 启动参数 | 强制使用插件指定的 `provider`、`model` 和推理强度，不接受子 agent 自行选择 |
| 子 agent | 并发 | 预占 + 活跃子 agent 达到数量上限时拒绝新建并说明原因，已经结束的不占名额 |
| 子 agent | 步数 | 每轮预算用完后只能输出报告，提示结束本轮 |
| 子 agent | 读取 | 每轮可读的不同文件数达到上限后，不能读取更多文件，提示结束本轮 |
| 子 agent | 写入 | 每轮可写的不同文件数达到上限后，只能继续修改已经写过的文件，提示结束本轮 |
| Lead | 直接执行 | Lead 调用 `read`、`grep`、`glob`、`write`、`edit` 等工具会被拒绝，只允许读取用户明确引用的路径，可以运行 `tsc`、`build`、`test`、`git diff` 这类验证命令。调查和执行一律委派给 `subagent`，只读调查回结论与证据，执行任务交产物与自检 |
| Lead | 步数 | 每轮预算用完后仅保留派发、消息、任务和汇报类工具，提示结束本轮 |
| Lead | 每轮提醒 | 每轮第一步注入一条提醒，界面显示为上下文注入 |
| Lead | sleep 轮询 | Lead 执行 `sleep` 或 `Start-Sleep` 会被拒绝 |


## 安装

前提是 dsh CLI 已经就绪且 pnpm 可用。在插件仓库目录下依次执行

```bash
pnpm install
pnpm build
dsh plugin --profile web add .
```

## 配置

配置写在 profile 的 cordis.patch.yml 文件中。面板保存后写回同一位置并立即生效。

默认示例：

```yaml
- id: agent-guard
  name: dsh-agent-guard
  config:
    enabled: true
    scope: team
    investigateProvider: deepseek-account
    investigateModel: deepseek-flash
    investigateReasoningEffort: high
    executeProvider: deepseek-account
    executeModel: deepseek-flash
    executeReasoningEffort: low
    inheritLeadConfig: false
    maxConcurrentChildren: 4
    banSleepPolling: true
    budgets:
      probe-: { stepBudget: 20, readCalls: 15, readFiles: 15, writeFiles: 15, reminders: [10] }
      exec-: { stepBudget: 40, readCalls: 30, readFiles: 20, writeFiles: 20, reminders: [12, 28] }
    leadNoExecute: true
    leadStepBudget: 24
    # leadSchedulingText / contractText / leadReminderText 默认取 src/prompts.js
```

`scope` 决定约束在哪生效。`team` 为默认值，只作用于开启 Team 模式的根会话，`all` 对所有 agent 生效，并发上限也按这个范围计算。

模型参数只有两组，按委派名字的前缀选择。以 exec 开头的用 execute 组，以 probe 开头的用 investigate 组。`subagent` 和 `subagent_fork` 必须带上这两个前缀之一，否则调用会被拒绝，并在原因里给出正确的模板。

把 `inheritLeadConfig` 设为 `true` 可以跳过强制分配，让子 agent 沿用 Lead 的配置。

插件对 Lead 的判定方式随 DSH 版本调整。
- DSH 0.2.1-rc.2 起 Team 不再提供成员名册，插件改用根节点和启用状态判定 Lead，模型分组则由名字前缀决定。
- 并发上限同时统计两类名额：已经启动且尚未结束的子 agent（活跃），以及已通过 `pre-execute`、尚未启动完成的调用（预占）。

推理强度是自由文本，面板只提供常见档位作为提示，实际可用档位由 provider 公布的模型能力决定。填入不支持的档位会在发送请求前报错，deepseek 系接受 `off`、`low`、`high`、`max`。面板文案和拒绝原因跟随 DSH 界面语言，未设置时使用中文。

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

改动 src 或 index.js 之后需要重新构建并重启 `dsh web`。Host 端代码和客户端 bundle 都在启动时加载。

## 限制基于哪些工具/命令

这里只按工具名匹配，命中的工具才计入预算或门禁，其余工具一律放行。

- 读：`read`、`grep`、`glob`。
- 写：`write`、`edit`、`str_replace_editor`。
- 委派：`subagent`、`subagent_fork`只受委派名前缀（`exec-` / `probe-`）和并发上限约束。
- Lead 门禁：只拦 `read`、`grep`、`glob`、`write`、`edit`、`str_replace_editor`；唯一豁免是读取用户明确引用过的路径上的 `read`。

## 已知缺口

- 其余工具（`workflow`、`skill`、`web_fetch`、`web_search`、MCP/office 工具、`pwsh`、`bash` 等）都不会命中上面的集合，目前不被门禁拦截。
- 命令读取不计入预算：`Get-Content`、`Select-String`、`rg`、`cat` 都不计入。
- 命令写入同样不入预算：`Set-Content`、`Out-File`、`New-Item` 和重定向都不计入。
- 同理，`git`、`node -e`、`rm` / `Remove-Item` 都不会被归类为读或写。
- 这是已知限制，AI 花式违规情况自测频率较小，目前尚未修复。