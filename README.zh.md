# dsh-agent-guard

DeepSeek Harness 插件：把 agent 的行为约束变成硬规则，并在输入框底部放一个状态浮窗（React + Vite）。

## 四道约束

**Host 半边（`index.js`）** 在 Host 执行，模型绕不过去：

| # | 约束 | 拦截点 | 行为 |
| --- | --- | --- | --- |
| 1 | 子智能体启动参数 | `ctx.subagents.startActivation` | 覆盖 `agentOptions`：`provider=deepseek-account`、`model=deepseek-flash`、`reasoningEffort=low`。`spawn_teammate` 与 `subagent` 两条路径都覆盖；父 agent 传什么都盖掉 |
| 2 | 团队并发上限 | `tools/pre-execute`（`spawn_teammate`） | 活跃 teammate（running/provisioning）≥ 上限时拒绝新建，返回原因 |
| 3 | 禁 sleep 轮询 | `tools/pre-execute`（`pwsh`/`bash`） | 团队有活跃成员时，拒绝 Lead 的 `Start-Sleep …` / `sleep N`，提示改用 `wait_agent` 或结束本轮 |
| 4 | 步数预算 | `tools/pre-execute`（所有工具）+ `session/event` 计步 | 子 agent 每轮 step 数到上限后拒绝继续调用工具，逼它输出「已完成 / 未完成 / 下一步」 |

- 约束 1 默认只作用于**团队模式**（父 agent 是 Team Lead），普通会话的 `subagent` 调用不受影响；
- 约束 2、3 只作用于团队；约束 4 作用于所有子 agent（`delegationDepth ≥ 1`）；
- 子会话 `subagent/descriptor` 里的 `agentModel` / `agentReasoningEffort` 会记录约束 1 的实际值。

**客户端半边（`src/` → `dist/client.js`）**：输入框底部（`conversation.composer.dock`）一颗 `● Guard` 按钮，
点开浮窗显示四道约束的当前参数、范围、当前 Lead 模型；点浮窗外或按 Esc 关闭。

## 目录

```
index.js              Host 半边（Cordis 插件，纯 JS）
src/client.tsx        客户端入口：Guard 按钮 + 浮窗（React）
src/guard.ts          浮窗展示的约束常量（与 index.js DEFAULTS 保持一致）
src/styles.css        样式（?raw 内联进 bundle，apply 时注入 <style>）
src/types.ts          宿主 kit / 客户端上下文的类型声明
vite.config.ts        lib 构建 + __ModuleLoader__.load 包装
cordis.patch.yml      bundle 补丁（插入 agent-guard 条目）
dist/client.js        构建产物（浏览器半边）
```

## 安装

```powershell
dsh plugin --profile web add "D:\KokoroAme workspace\dsh-agent-guard"
```

装完确认 profile 里有两行：`dependencies` 的 `"dsh-agent-guard": "link:..."` 和
`dsh.profile.bundles` 的 `"dsh-agent-guard"`。**Host 半边是启动时加载的，改完必须重启 `dsh web`。**

停用：

```yaml
- id: agent-guard
  disabled: true
```

## 开发

```powershell
pnpm install      # 首次：安装 vite / typescript / @types
pnpm build        # 产出 dist/client.js
pnpm typecheck    # tsc --noEmit
```

改完 `src/` 或 `index.js` 后：重新 `pnpm build`，然后重启 `dsh web`（Host 半边和客户端 bundle 都是启动时加载的）。

## 配置

默认值写死在 `index.js` 的 `DEFAULTS`，在 `~/.dsh/profiles/web/cordis.patch.yml` 覆盖：

```yaml
- id: agent-guard
  config:
    scope: team                  # team（默认，只限团队模式）| all（所有 agent）
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: low         # off | low | high | max
    maxConcurrentTeammates: 4    # 活跃 teammate 上限；0 = 关闭
    banSleepPolling: true        # 团队有活跃成员时禁止 sleep 轮询
    stepBudget: 25               # 子 agent 每轮最多 step 数；0 = 关闭
```

浮窗里的 `src/guard.ts` 只用于展示，改约束时两处一起改。

## 验证

重启 `dsh web` 后开一个团队会话：

1. **启动参数**：`spawn_teammate` 一次，子会话第 0 条 `subagent/descriptor` 应为
   `agentModel: deepseek-flash`、`agentReasoningEffort: low`；
2. **并发上限**：连开 5 个 teammate，第 5 个会收到拒绝（"团队并发上限 4…"）；
3. **禁 sleep**：有 teammate 在跑时让 Lead 执行 `Start-Sleep -Seconds 10`，会被拒绝并提示用 `wait_agent`；
   团队空闲时 sleep 仍然允许；
4. **步数预算**：子 agent 单轮步数到 25 后，再调工具会被拒绝，只能输出报告；下一轮（`turn/start`）预算清零。

Host 日志里每条拒绝/强制都会打印一行 `[agent-guard] …`。

## 后续

- 浮窗接 Host 实时数据（现在两侧常量写死一致）；
- 需要新的硬规则时往 `index.js` 的 `refusalFor` 里加一段即可。
