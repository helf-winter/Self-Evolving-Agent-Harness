# Self-Evolving Agent Harness

Agent Harness 是 Claude Code 内部的一层长期工程运行时：Skills 约束任务规划和执行方式，Hooks 记录生命周期事实，MCP 工具提供可验证的 Task Tree 与 Runtime State 操作。它不是独立管理 Claude 的后台系统。

当前版本实现 Runtime Foundation、Branch Confirmation 以及 Node Execution & Evaluation 三个纵向切片：

- 全局 SQLite Runtime Database（Node 内置 `node:sqlite`，无原生数据库依赖）；
- 项目路径隔离和 `.agent-harness-project.json` 身份 marker；
- Task Tree 根任务、不可变修订、Leaf Task Contract、关系与 Artifact 校验；
- 规划、版本绑定的分支确认、Skeleton、实现和验证工作流状态；
- 分支确认记录不可变；节点确认状态与执行状态分离，支持 `draft`、`pending_user_confirmation`、`confirmed`、`partial_confirmed`；
- 修改一个已确认分支时，仅该分支重新确认，未变化兄弟分支保留确认；跨分支依赖未确认时节点处于 `blocked_by_unconfirmed_dependency`；
- Claude 生命周期 Hook 的幂等、脱敏 Trace 与 Artifact 投影；
- Snapshot、Summary、Detail 与分页 Trace 查询；
- 基于当前节点修订的 Execution Attempt、Trace 证据关联、不可变 Evaluation 与确定性生命周期策略；
- Skeleton Gate 只接受真实成功的 Skeleton Attempt，不接受模型自行声明“完成”；
- Bash CLI、Claude 插件 Skills 和 15 个 MCP Runtime Tools。

## 环境要求

- Bash / WSL 优先；Windows PowerShell 也可用于开发。
- Node.js `22.13.0` 或更高版本。
- Claude Code。模型登录和 API 配置仍由 Claude Code 自己负责，Harness 不保存模型密钥。

## 安装与验证

在 Bash 中进入仓库：

```bash
cd '/mnt/d/code/创业/Agent-Harness'
npm ci
npm run check
```

让 `harness` 命令在当前 Node 环境全局可用：

```bash
npm link
harness doctor
```

`npm link` 只链接当前项目，不复制项目目录。若切换了 WSL 用户或 Node/NVM 版本，需要在对应环境重新执行一次。

## CLI 快速体验

在任意待开发项目目录中运行：

```bash
cd /path/to/your-project
harness project inspect
harness taskroot '实现健康检查接口'
harness tree candidates health
harness tree snapshot
```

`project inspect` 不会创建 marker。第一次 `taskroot` 或第一次被观察到的实质变更才会创建 `.agent-harness-project.json` 和全局 Project 记录。

默认数据目录：

- Linux/WSL：`$XDG_DATA_HOME/agent-harness`，未设置时为 `$HOME/.local/share/agent-harness`；
- Windows：`%LOCALAPPDATA%/AgentHarness`；
- 测试或自定义：设置 `AGENT_HARNESS_DATA_HOME`。

节点执行由已确认的 Task Tree 驱动。Agent/插件通常通过 MCP 调用；对应的 CLI 诊断入口为：

```bash
harness node attempt-start NODE_ID TREE_REVISION_ID
harness node verify ATTEMPT_ID
harness node evidence ATTEMPT_ID REQUIRED_EVIDENCE_KEY TRACE_EVENT_ID
harness node evaluate ATTEMPT_ID succeeded
```

`evaluate ... succeeded` 只是提出成功结论。Runtime 会核对当前修订、所需证据、依赖节点与子节点状态；条件不完整时会把 Evaluation 记录为 `uncertain`，不会把节点标成成功。

### 分支确认链路

Agent 通过 Runtime Tools 执行下列链路：

1. 调用 `harness_scan_plan_readiness`，传入 `treeId`；只确认某一分支时同时传入 `scopeRootNodeId`。
2. 使用返回的 `resultId` 调用 `harness_create_confirmation_prompt`，将其作为 `readinessResultId`，并原样传入同一个 `scopeRootNodeId`。
3. 用户回答由 Hook 记录成 `UserPromptSubmit` Trace Event。
4. 调用 `harness_confirm_scope`，传入该 Trace Event ID。
5. 通过 `harness_get_task_tree_summary` 查看每个节点的 `confirmationState` 和聚合 `confirmationCounts`。

Readiness 结果和确认提示都绑定创建时的 Task Tree revision。树结构发生变化后，旧提示会返回 `revision_conflict`，不会被套用到新版本。部分分支确认不会自动确认兄弟分支，也不会让未确认节点进入执行阶段。

## 在 Claude Code 中加载

先构建，再从仓库目录启动：

```bash
npm run build
claude --plugin-dir ./plugin
```

可使用 `/agent-harness:taskroot 任务名称` 显式新建根任务。普通 coding 请求会由 `task-tree-planning` Skill 引导：先判断新建还是归并、精炼完整树、运行就绪扫描、请求确认，再先做 Skeleton、后按分支深入执行。普通问答不会自动创建 Task Tree。

MCP 和 Hooks 使用 `${CLAUDE_PLUGIN_ROOT}/runtime` 内的自包含构建产物，不依赖启动目录中的相对脚本。

## 开发命令

```bash
npm run typecheck
npm test
npm run build
npm run plugin:validate
npm run check
claude plugin validate ./plugin
```

完整人工验收见 [docs/acceptance.md](docs/acceptance.md)。当前切片尚不包含 Evolution、失败案例自动晋升、Task Node Replacement/Drift、项目克隆、Codex Binding 和图形界面。
