# dsh-agent-guard

给 DeepSeek Harness 加一层护栏，约束被委派出去的子 agent 和 Lead，并在输入框的工具行提供一个面板，方便调整这些规则。拦截全部在 Host 侧的 DSH 工具调用上执行；shell 命令的内容暂不解析（见「限制基于哪些工具/命令」）。

## 作用范围

| 对象 | 约束 | 效果 |
| --- | --- | --- |
| 子 agent | 启动参数 | 强制使用插件指定的 provider、model 和推理强度，不接受子 agent 自行选择 |
| 子 agent | 并发 | 预占 + 活跃子 agent 达到数量上限时拒绝新建并说明原因，已经结束的不占名额 |
| 子 agent | sleep 轮询 | Lead 执行 sleep 或 Start-Sleep 会被拒绝 |
| 子 agent | 步数 | 每轮预算用完后只能输出报告，下一轮开始时重置，设为 0 表示不限制 |
| 子 agent | 写入 | 每轮可写的不同文件数达到上限后，只能继续修改已经写过的文件，设为 0 表示不限制 |
| Lead | 直接执行 | Lead 调用 read、grep、glob、write、edit 等工具会被拒绝，只允许读取用户明确引用的路径，可以运行 tsc、build、test、git diff 这类验证命令。调查和执行一律委派给 subagent，只读调查回结论与证据，执行任务交产物与自检 |
| Lead | 步数 | 每轮预算用完后仅保留派发、消息、任务和汇报类工具，设为 0 表示不限制 |
| Lead | 每轮提醒 | 每轮第一步注入一条提醒，界面显示为上下文注入 · agent-guard，默认收起，提醒本步只委派或复核 |

## 限制基于哪些工具/命令

所有限制都在同一个 Host 钩子上判定：`ctx.on('tools/pre-execute')`（index.js:983-987）。这里只按工具名匹配，命中的工具才计入预算或门禁，其余工具一律放行。

- 读：`READ_TOOLS` 为 read、grep、glob（index.js:141）。每次调用让 `readCalls` +1，其中只有 read 会额外记一个不同的 `readFiles` 条目（index.js:265-276、681-702）。缺少 `file_path` 时仍算作一个文件。
- 写：`WRITE_TOOLS` 为 write、edit、str_replace_editor（index.js:140）。只有 `file_path` 的不同原始值才计入 `writeFiles`（index.js:704-719），空路径不计。
- 委派：subagent、subagent_fork（index.js:139）只受委派名前缀（`exec-` / `probe-`）和并发上限约束。
- 步数：从会话事件流计费，每个 `step/start` 加一，`turn/start` 时清零（index.js:854-859），不按工具调用计数；一步里调用十次工具也只算一步。
- Lead 门禁：只拦 read、grep、glob、write、edit、str_replace_editor（index.js:143）；唯一豁免是读取用户明确引用过的路径上的 read（index.js:723-727）。pwsh / bash 不在 Lead 门禁范围内。
- 其余工具（workflow、skill、web_fetch、web_search、MCP/office 工具、pwsh、bash 等）都不会命中上面的集合，因此不计费，也不被门禁拦截。

读写预算只对子 agent（depth 大于等于 1）计费；子 agent 的步数预算同样按 depth 计费，而 Lead 的步数由单独的 Lead 预算（leadStepBudget）约束，两者都在 turn/start 时清零。

### 已知缺口（暂未处理）

- pwsh / bash 只做 sleep 轮询的文本匹配（`Start-Sleep`、`sleep N`，index.js:137/654-665），命令内容不会被解析成读或写。
- 因此 shell 读取不计费：`pwsh Get-Content`、`Select-String`、`rg`、`cat` 都不计入 `readCalls` / `readFiles`。
- shell 写入同样不计费：`Set-Content`、`Out-File`、`New-Item` 和重定向都不计入 `writeFiles`，Lead 门禁也拦不住。
- 同理，`git`、`node -e`、`rm` / `Remove-Item` 都不会被归类为读或写。
- 这是已知限制，目前尚未修复。

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

    # investigate 组，name=probe-* 的只读调查
    investigateProvider: deepseek-account
    investigateModel: deepseek-flash
    investigateReasoningEffort: high

    # execute 组，name=exec-* 的执行任务
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

scope 决定约束在哪生效。team 为默认值，只作用于开启 Team 模式的根会话，all 对所有 agent 生效，并发上限也按这个范围计算。

模型参数只有两组，按委派名字的前缀选择。以 exec 开头的用 execute 组，以 probe 开头的用 investigate 组。subagent 和 subagent_fork 必须带上这两个前缀之一，否则调用会被拒绝，并在原因里给出正确的模板。

把 inheritLeadConfig 设为 true 可以跳过强制分配，让子 agent 沿用 Lead 的配置。

插件对 Lead 的判定方式随 DSH 版本调整。
- DSH 0.2.1-rc.2 起 Team 不再提供成员名册，插件改用根节点和启用状态判定 Lead，模型分组则由名字前缀决定。
- 并发上限同时统计两类名额：已经启动且尚未结束的子 agent（活跃），以及已通过 pre-execute、尚未启动完成的调用（预占）。

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
