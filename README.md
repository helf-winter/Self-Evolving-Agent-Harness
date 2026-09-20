# Self-Evolving Agent Harness

Agent Harness 是 Claude Code 内部的一层长期工程运行时：Skills 约束任务规划和执行方式，Hooks 记录生命周期事实，MCP 工具提供可验证的 Task Tree 与 Runtime State 操作。它不是独立管理 Claude 的后台系统。

当前版本实现 Runtime Foundation、Branch Confirmation、Node Execution & Evaluation、Artifact Graph & Plan Drift、Runtime Action & User Change、Failure Case Maturity、Experience & Skill Evolution、Task Node Replacement & Effect Disposal、Project Identity & Clone，以及 Plugin Composition Contract 十个纵向切片：

- 全局 SQLite Runtime Database（Node 内置 `node:sqlite`，无原生数据库依赖）；
- token 校验的 `.agent-harness-project.json` 最小身份 marker、路径别名、移动/重命名识别和可追溯 Project Clone；
- Task Tree 根任务、不可变修订、Leaf Task Contract、关系与 Artifact 校验；
- 规划、版本绑定的分支确认、Skeleton、实现和验证工作流状态；
- 分支确认记录不可变；节点确认状态与执行状态分离，支持 `draft`、`pending_user_confirmation`、`confirmed`、`partial_confirmed`；
- 修改一个已确认分支时，仅该分支重新确认，未变化兄弟分支保留确认；跨分支依赖未确认时节点处于 `blocked_by_unconfirmed_dependency`；
- Claude 生命周期 Hook 的幂等、脱敏 Trace 与 Artifact 投影；
- 修订绑定的 Artifact Graph：Task Link、Artifact Relation、Contract、规划基线和 Trace 来源；
- 确定性 Hook 自动识别未规划 Artifact，语义 Drift 可由 Agent 显式记录；阻断 Drift 会暂停节点等待用户确认；
- Snapshot、Task Tree、Artifact Graph、Artifact Detail、Plan Drift 与分页 Trace 查询，全部严格按 Project 隔离；
- 基于当前节点修订的 Execution Attempt、Trace 证据关联、不可变 Evaluation 与确定性生命周期策略；
- 未解决的阻断 Drift 会把成功提议记录为 `uncertain`，Evaluation 不能绕过确认门禁；
- Runtime Action 将自然语言意图转换为可校验的结构化状态变更；阻断 Drift Resolution 和 Scope Change 必须绑定明确的确认提示与用户回答 Trace；
- User Change Request 区分 `minor_change`、`priority_change` 和 `scope_change`，保留来源、影响、状态及关联动作；
- Scope Change 确认后产生新的 Task Tree 草稿修订并回到精炼阶段，不会直接授权代码执行；
- 应用后的失败 Evaluation 自动沉淀为 L0 Failure Case；相同结构化签名复用案例，但每次失败 occurrence 独立保留；
- 结构化复现以不可变 revision 演进，并由独立 Trace 证据确定性推进 L1 manual、L2 assisted、L3 automated 与 L4 regression；
- 同一 Task Node revision 在两次及以上应用失败后成功时自动产生 Experience；Skill Candidate 指令以不可变 revision 冻结；
- Replay、Variation、Holdout 与 Negative Applicability 测试先经过独立质量门禁，再分别记录 no-Skill baseline 与 Skill-enabled 重复运行；
- Validation Report 由代码聚合覆盖率、基线区分度、稳定性、负面适用性与副作用风险，全部硬门禁通过后自动晋升 Skill；
- Task Node Effect 绑定精确 revision，并按 reversible、version-reversible、compensatable、irreversible 分类；
- Task Node Replacement 通过不可变候选、契约差异、依赖影响闭包、逆序挂起、证据化 Effect 处置、原子激活和失败恢复推进；
- 目录复制会创建独立 Project，重写 Task Tree、Artifact 与 Contract 引用，保留 Clone provenance，但不会把源 Trace、Attempt 或 Evaluation 冒充为目标执行事实；
- Clone 后运行时暂停在重新验证阶段；源项目和目标项目使用不同 marker 与 `project_id`，可独立继续演进；
- Runtime Plugin 使用稳定 ID 和不可变 revision，通过精确 provides/requires contract、固定点依赖协调与 composition state 实现空间组合；
- Plugin registration 和 Effect 由 revision 生命周期拥有；替换/卸载只接受证据化 disposition，并支持影响闭包、冲突重试、失败恢复和 provider 恢复后的依赖重激活；
- Skeleton Gate 只接受真实成功的 Skeleton Attempt，不接受模型自行声明“完成”；
- Bash CLI、Claude 插件 Skills 和 57 个 MCP Runtime Tools。

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

### Project Identity 与 Clone

Project Runtime Records 统一存放在公共数据库中，项目目录只保存 `.agent-harness-project.json` 最小身份 marker。路径用于隔离与展示，稳定 `project_id` 用于识别目录移动、重命名和复制：

- 原路径已经不存在时，新的 marker 所在路径被判定为 `moved_or_renamed`，持久化操作会更新主路径并保留路径历史；
- 原路径仍存在时，新的路径被判定为 `copy_detected`；第一次需要 Runtime 状态的操作会事务化创建独立 Project、改写副本 marker，并克隆允许继承的工程记忆；
- 无效 marker、未知 Project 或 token 不匹配返回 `identity_conflict`，不会静默共享状态；
- `harness project inspect` 和 `harness_get_project_identity` 只检查，不创建或改写身份；
- `harness project clones [incoming|outgoing|all]`、`harness project clone-detail CLONE_ID`、`harness_get_project_clones` 和 `harness_get_project_clone_detail` 用于审计来源、实体 ID 映射与继承证据。

Clone 继承 Task Tree、不可变修订、Artifact Graph、Contract 和确认投影；目标 Artifact 回到 planned，运行中节点暂停，成功节点重新验证。源 Trace、Attempt 与 Evaluation 不会复制到目标项目，历史 Evaluation 只以明确的 `inherited_from_clone` provenance 保存。

### Plugin Composition Contract

Plugin Composition 是 Harness 数据目录级的运行时能力注册表，不随单个 Project Clone。它描述 Skill、Workflow、Hook、Binding 和 Runtime extension 如何组合，但不替代 Claude Code 的插件安装器，也不会动态导入或执行不可信代码。

- `harness_register_plugin_revision`：注册稳定 Plugin ID 下的首个不可变 revision；
- `harness_get_plugins`、`harness_get_plugin_detail`：查看 current revision、composition state、缺失契约、registration、Effect、依赖边和状态转换；
- `harness_reconcile_plugins`：按精确 `contractId@version` 反复协调到固定点；provider 缺失时 consumer 进入 `pending_dependency`，恢复后自动重激活；
- `harness_preview_plugin_replacement`：保存 candidate，展示 contract diff、反向依赖影响闭包、逆序挂起顺序和 Effect 风险，不改变 current revision；
- `harness_execute_plugin_replacement`：校验每个旧 registration/Effect 的 disposition 与证据，成功后原子切换 revision；冲突时保留旧 revision 供重试；
- `harness_recover_plugin_replacement`、`harness_get_plugin_replacement_detail`：恢复可逆的失败激活并审计全部处置尝试；
- `harness_dispose_plugin`、`harness_reactivate_plugin`：证据化卸载/重载，并向依赖者传播 provider 消失与恢复。

manifest 中的 disposer、inverse 和 compensation 字符串只是 Binding 声明。Harness 永远不会把它们当成 shell、JavaScript、MCP 或回调直接执行。`plugin-composition` Skill 指导 Agent 先由目标 Binding 真正完成动作、取得证据，再提交 Runtime 状态。

### Artifact Graph 与 Plan Drift

Artifact Graph 保存当前工程状态，Trace 保存追加式事实历史。文件或验证命令 Hook 会同步更新 Artifact 的状态与来源 Trace；规划修订则保存节点与 Artifact 的链接、Artifact 间关系和契约。两者不会重复承担事实历史与当前状态的职责。

Agent 可按需使用以下 Runtime Tools：

- `harness_get_artifact_graph`：分页查看当前 Artifact、节点链接、关系和契约；
- `harness_get_artifact_detail`：查看单个 Artifact 的当前状态、来源 Trace、关联任务和 Drift；
- `harness_get_plan_drift_summary`：按 Task Tree、Task Node、严重级别和处理状态筛选 Drift；
- `harness_record_plan_drift`：记录不能由 Hook 确定判断的语义偏移。

`warning` Drift 作为事实记录继续执行；`blocking` Drift 会把相关节点和活动 Attempt 置为 `blocked`，直到后续用户确认流程解决该偏移。所有查询都只返回当前目录所绑定 Project 的数据。

### Runtime Action 与 User Change

自然语言输入不会直接改写 Runtime State。Agent 先使用查询工具获取当前快照、Drift、Task Tree 与 Artifact 事实，再把意图提交为结构化 Runtime Action：

1. `harness_propose_plan_drift_resolution` 为一个待处理的阻断 Drift 提议 `accepted`、`rejected` 或 `branch_cancelled`；
2. `harness_propose_user_change` 记录 `minor_change`、`priority_change` 或 `scope_change`；
3. `harness_get_waiting_items` 返回当前 Project 中等待回答的明确提示；
4. 用户回答由 Hook 记录为 `UserPromptSubmit` Trace；
5. `harness_resolve_runtime_confirmation` 使用明确的 `confirmationId` 与回答 Trace 提交 `yes`、`no` 或 `pause`；
6. `harness_get_user_change_requests` 和 `harness_get_runtime_action_detail` 用于回看持久化结果。

`minor_change` 只记录事实，`priority_change` 只改变当前选中的后续节点；二者不修改 Task Tree revision。`scope_change` 和阻断 Drift Resolution 属于高风险动作，必须确认。确认 Scope Change 只会创建新草稿并回到 Task Tree refinement，仍需重新扫描就绪条件并确认受影响分支后才能执行代码。

### Failure Case 成熟度

当 Lifecycle Transition Policy 真正应用一个 `failed` Evaluation 时，Runtime 自动建立或复用 L0 Failure Case，并保存来源 Task Node、Attempt、Evaluation、Artifact 与证据。Failure Case 不会因为后续修复成功而被删除。

Agent 通过以下工具推进复现成熟度：

- `harness_get_failure_cases`：按 Tree、Node、L0-L4 和可用性状态筛选案例；
- `harness_get_failure_case_detail`：查看来源、所有 occurrence、复现 revision、验证结果和相关 Artifact；
- `harness_add_failure_reproduction`：追加 manual、assisted 或 automated 结构化复现契约；
- `harness_validate_failure_reproduction`：提交独立运行产生的 Trace 证据，并由代码计算允许的最高成熟度。

复现工具只保存声明的 `entryCommand`，不会自行执行任意 shell。生成复现步骤与验证结果必须分离：L3 需要稳定 pre-fix RED、可区分 Oracle、重复稳定和充分隔离；L4 还必须证明 post-fix GREEN。隔离可以使用 fixture、worktree、临时目录或项目原生测试环境，容器不是强制条件。

### Experience 与 Skill Evolution

当同一个 Task Node revision 的应用后 Evaluation 历史形成 `failed → failed → succeeded` 时，Runtime 自动保存一个 Experience，并保留来源 Project、Tree、Node、Attempt、Evaluation 和 Artifact 引用。一次成功最多生成一个 Experience；失败事实、成功事实和候选指令都不会被后续晋升改写。

Agent 通过以下工具完成可审计的进化闭环：

- `harness_get_skill_evolution_candidates`：按当前 Project、Tree 或 Node 查找合格 Experience；
- `harness_freeze_skill_candidate`：从 Experience 冻结不可变候选指令；
- `harness_propose_skill_test_case`：分别提出 real-failure replay、variation、holdout 和 negative-applicability 测试；
- `harness_validate_skill_test_quality`：用候选测试产生后的同 Project Trace 验证结构、隔离、复现、Oracle、区分度、稳定性和分片正确性；
- `harness_record_skill_validation_run`：为每个已接受测试保存 no-Skill baseline 与 Skill-enabled 重复运行、资源用量和副作用；
- `harness_generate_skill_validation_report`：聚合硬门禁并在全部通过时自动晋升；
- `harness_get_skill_candidate_detail`：查看来源 Experience、测试、质量结果、运行和报告。

每种必需分片的 baseline 与 Skill-enabled 模式都至少执行三次。Replay baseline 必须稳定失败而 Skill-enabled 稳定通过；Holdout 不接收候选指令快照并声明防泄漏策略；Negative Applicability 必须证明 Skill 不会在不适用场景中造成错误行为；任何 high 或 irreversible 副作用都会阻止晋升。

### Task Node Replacement 与 Effect Disposal

Task Node 的执行状态与组合状态相互独立。实现 revision 可以被替换，但历史 revision、Effect、Trace、确认和处置结果都保持不可变。Agent 通过以下 Runtime Tools 完成闭环：

- `harness_register_task_node_effect`：把一次工具行为产生的 Effect 绑定到当前 Task Node revision；
- `harness_get_task_node_effects`：按 Tree、Node、类型和处置状态分页查询 Effect；
- `harness_preview_task_node_replacement`：保存候选 revision，计算 Contract Diff、反向依赖影响闭包和 Effect 风险，并创建明确确认提示；
- `harness_confirm_task_node_replacement`：用提示之后的用户回答 Trace 提交 `yes`、`no` 或 `pause`；
- `harness_execute_task_node_replacement`：校验证据化处置结果，成功时原子激活新的 Tree revision 并重评估受影响节点；
- `harness_recover_task_node_replacement`：在激活失败且不存在不可恢复处置时恢复旧 revision 的组合状态；
- `harness_get_task_node_replacements` 与 `harness_get_task_node_replacement_detail`：查询完整替换历史、候选、确认、Effect、处置和状态转换。

Runtime 只记录 operation、inverse 和 compensation 的声明与执行证据，绝不把这些字符串当作 shell 命令执行。Version-reversible Effect 必须同时满足目标归属、基线一致且无共享活跃 owner；Compensation 是新的工程事实，不等同于回滚；Irreversible Effect 不允许自动处置。

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

完整人工验收见 [docs/acceptance.md](docs/acceptance.md)。当前切片尚不包含完整 AST/符号调用图、Codex Binding 和图形界面。
