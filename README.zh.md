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
浮窗里的数值来自 Host 下发的 `agentGuard` 会话投影，**不是写死的**——改 profile 配置后重启，浮窗跟着变。

## 目录

```
index.js              Host 半边（Cordis 插件，纯 JS；四道约束 + Config schema + `agentGuard` 投影）
src/client.tsx        客户端入口：Guard 按钮 + 可编辑浮窗（React）
src/guard.ts          配置类型、兜底默认值、投影值归一化
src/locales/          浮窗文案字典（zh.json / en.json）
src/styles.css        样式（?raw 内联进 bundle，apply 时注入 <style>）
src/types.ts          宿主 kit / configForms / 客户端上下文的类型声明
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

**在浮窗里直接改**：点输入框底部的 `● Guard`，浮窗里的每个字段都可编辑（启用 / 强制 provider / 模型 / 推理强度 / 范围 / 并发上限 / 步数预算 / 禁 sleep），点「保存」写入 profile 并立即生效；重新打开或刷新页面即可看到新值。

也可以在 `~/.dsh/profiles/web/cordis.patch.yml` 手改（浮窗保存的也是这里）：

```yaml
- id: agent-guard
  config:
    enabled: true
    scope: team                  # team（默认，只限团队模式）| all（所有 agent）
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: low         # off | low | high | max
    maxConcurrentTeammates: 4    # 活跃 teammate 上限；0 = 关闭
    banSleepPolling: true        # 团队有活跃成员时禁止 sleep 轮询
    stepBudget: 25               # 子 agent 每轮最多 step 数；0 = 关闭
```

`schema` 里的默认值与 `DEFAULTS` 一致；`src/guard.ts` 的 `DEFAULT_GUARD` 只在投影未就绪时兜底。

## 多语言

浮窗文案全部走 DSH 的 locale 服务（`ctx.locale`）：`apply` 里注册 `zh` / `en` 字典（`src/locales/*.json`），用 `bind(NS)` 取 `t`，并订阅 locale revision 在切换语言时重渲染——不需要刷新页面。Host 侧的拒绝原因和日志是给模型看的固定中文，不进字典。

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

- 需要新的硬规则时往 `index.js` 的 `refusalFor` 里加一段，并在 `src/guard.ts` 的 `guardRows` 补一行展示；
- 配置目前在 profile 的 `cordis.patch.yml`；要进 GUI 设置页需要给插件加 schemastery `Config` 声明。
