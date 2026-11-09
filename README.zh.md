# dsh-agent-guard

DeepSeek Harness 插件。把 agent 的行为约束放到 Host 进程执行，并在输入框底部提供一个可编辑这些约束的浮窗。

## 术语

- 子 agent：所有被委派的下级 agent 的统称，包含 teammate 与普通 subagent，判定条件是 delegationDepth 大于等于 1。
- teammate：团队模式里由 spawn_teammate 创建、进入团队花名册的成员，可以 send_message，可跨轮存活。
- 普通 subagent：subagent 工具创建的后台子 agent，没有团队身份。

团队模式不强制使用 teammate。会话里有 Team Lead 身份时，用 subagent 工具启动的普通子 agent 同样受启动参数约束。

## 五道约束

Host 侧实现在 index.js，模型无法绕过。

| # | 约束 | 执行位置 | 行为 |
| --- | --- | --- | --- |
| 1 | 子 agent 启动参数 | ctx.subagents.startActivation | 覆盖 agentOptions 的 provider、model、reasoningEffort。spawn_teammate 与 subagent 工具共用这个入口，父 agent 传入的值被替换 |
| 2 | 并发上限 | tools/pre-execute 拦截 spawn_teammate、subagent、subagent_fork | 活跃 teammate 与活跃子 agent 的总数达到上限时拒绝新建，并返回拒绝原因 |
| 3 | 禁止 sleep 轮询 | tools/pre-execute 拦截 pwsh 与 bash | 存在活跃 teammate 或活跃子 agent 时拒绝 Lead 执行 Start-Sleep 或 sleep 命令，提示改用 wait_agent 或结束本轮 |
| 4 | 步数预算 | tools/pre-execute 拦截全部工具，session/event 计步 | 子 agent 当前轮 step 数达到上限后拒绝继续调用工具，只能输出报告 |
| 5 | 文件写入上限 | tools/pre-execute 拦截 write 与 edit，session/event 记文件 | 子 agent 当前轮已写入的不同文件达到上限后拒绝新的写入，重复修改同一文件不重复计数 |

- 约束 1 的覆盖条件是父 agent 是 Team Lead，spawn_teammate 与 subagent 工具启动的子 agent 都覆盖。普通会话里的 subagent 调用不受影响。
- 约束 2 统计活跃 teammate 与活跃子 agent 的总数，spawn_teammate、subagent、subagent_fork 三个入口都受限制；已结束的子 agent 不占名额。
- 约束 3 的判定条件是存在活跃 teammate 或活跃子 agent，两者都没有时允许 sleep。活跃子 agent 由 startActivation 记录、subagent/end 移除。
- 约束 4 与约束 5 对所有子 agent 生效，计数在下一轮 turn/start 后重置。
- 约束 5 只统计不同文件路径，拒绝发生在写入执行前；命令里写文件不受这条限制，由 sandbox 负责。
- 子会话日志的 subagent/descriptor 记录约束 1 的 agentModel 与 agentReasoningEffort。

客户端半边由 src 构建为 dist/client.js。输入框底部有 Guard 按钮，面板可以查看并修改上述约束。面板的数值来自 Host 下发的 agentGuard 会话投影，修改配置后面板显示同一份值。

## 目录

```
index.js              Host 半边，五道约束、Config schema 与 agentGuard 投影
src/client.tsx        客户端入口，Guard 按钮与可编辑面板
src/guard.ts          配置类型、默认值、投影值归一化
src/locales/          面板文案字典，zh.json 与 en.json
src/styles.css        样式，以 ?raw 内联进 bundle
src/types.ts          宿主接口类型声明
vite.config.ts        lib 构建与 __ModuleLoader__.load 包装
cordis.patch.yml      bundle 补丁，插入 agent-guard 条目
dist/client.js        构建产物，浏览器半边
```

## 安装

```powershell
dsh plugin --profile web add "D:\KokoroAme workspace\dsh-agent-guard"
```

安装后确认 profile 里有两行：dependencies 的 `dsh-agent-guard` 链接依赖，以及 dsh.profile.bundles 里的 `dsh-agent-guard`。Host 半边在启动时加载，修改后需要重启 dsh web。

停用方式是在 profile 的 cordis.patch.yml 里写入：

```yaml
- id: agent-guard
  disabled: true
```

## 开发

```powershell
pnpm install      # 首次执行，安装 vite、typescript 与类型包
pnpm build        # 产出 dist/client.js
pnpm typecheck    # tsc --noEmit
```

修改 src 或 index.js 后执行 pnpm build，再重启 dsh web。Host 半边与客户端 bundle 都在启动时加载。

## 配置

在浮窗里直接修改。每个字段都可编辑，包括启用、作用范围、强制 provider、模型、推理强度、并发上限、步数预算、文件写入上限、禁止 sleep 轮询。点保存后写入 profile 并立即生效，重新打开浮窗或刷新页面显示同一份值。

也可以直接编辑 profile 的 cordis.patch.yml，浮窗保存的值写在同一处：

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
    maxFilesPerAgent: 8
```

Config schema 的默认值与 index.js 的 DEFAULTS 一致。src/guard.ts 的 DEFAULT_GUARD 只在设置服务返回前使用。旧的 `maxConcurrentTeammates` 键仍能读取，`maxConcurrentChildren` 优先。

## 多语言

面板文案走 DSH 的 locale 服务。apply 注册 zh 与 en 字典，文件位于 src/locales；用 bind 取 t，并订阅 locale revision，切换语言时重渲染。Host 侧的拒绝原因和日志是给模型的固定中文，不进入字典。

## 验证

重启 dsh web 后开一个团队会话。

1. 启动参数：spawn_teammate 一次，子会话第 0 条 subagent/descriptor 的 agentModel 为 deepseek-flash，agentReasoningEffort 为 low。
2. 并发上限：连续启动 5 个 teammate 或 subagent，第 5 个返回拒绝原因；已结束的不占名额。
3. 禁止 sleep：有 teammate 在运行时，Lead 执行 Start-Sleep -Seconds 10 被拒绝并提示改用 wait_agent；团队空闲时允许执行。
4. 步数预算：子 agent 单轮 step 数达到 25 后，再调工具被拒绝，只能输出报告；下一轮 turn/start 后预算重置。
5. 文件写入上限：让子 agent 连续写 9 个不同文件，第 9 个被拒绝并提示停止写文件；重复修改同一文件不占新名额，下一轮 turn/start 后重置。

Host 日志里每条拒绝与每次覆盖都会打印一行前缀为 agent-guard 的记录。

## 后续

- 新增约束：在 index.js 的 refusalFor 增加判断，在 src/client.tsx 增加字段，同时更新 Config schema 与 src/guard.ts 的 GuardConfig。
- 配置位置：profile 的 cordis.patch.yml。
