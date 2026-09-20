# Runtime Foundation 人工验收

## 1. 自动检查

```bash
cd '/mnt/d/code/创业/Agent-Harness'
npm ci
npm run check
claude plugin validate ./plugin
```

预期：类型检查、全部测试、三个运行时 bundle、插件合约校验和 Claude manifest 校验通过。

## 2. CLI 与项目隔离

```bash
npm link
mkdir -p /tmp/harness-project-a /tmp/harness-project-b
cd /tmp/harness-project-a
harness project inspect --json
test ! -e .agent-harness-project.json
harness taskroot 'Project A task' --json
test -e .agent-harness-project.json
harness tree snapshot --json

cd /tmp/harness-project-b
harness project inspect --json
harness tree candidates --json
```

预期：inspect 返回 `new_project` 且不写 marker；taskroot 后创建 marker；Project B 看不到 Project A 的树。

## 3. Claude 插件

```bash
cd '/mnt/d/code/创业/Agent-Harness'
npm run build
claude --plugin-dir ./plugin
```

在 Claude 中：

1. 输入 `/agent-harness:taskroot 实现一个可测试的健康检查接口`。
2. 要求展示当前 Runtime Snapshot。
3. 提供一个小型 coding 需求，检查 Claude 是否先询问“新建还是归并”。
4. 完成局部精炼后，检查是否给出完整 Task Tree 并等待执行确认。
5. 确认后检查是否先建立 Skeleton，再实现分支。
6. 退出并重新进入同一目录，查询 Snapshot 和 Trace，确认状态仍存在。

## 4. 节点执行与 Evaluation

在已完成规划、确认并进入相应执行阶段的 Task Tree 中，记录当前修订 ID、节点 ID 和随后返回的 Attempt ID：

```bash
harness node attempt-start NODE_ID TREE_REVISION_ID --json
harness node verify ATTEMPT_ID --json
harness node evidence ATTEMPT_ID REQUIRED_EVIDENCE_KEY TRACE_EVENT_ID --json
harness node evaluate ATTEMPT_ID succeeded --json
```

预期：

- Attempt 与精确的 Task Node Revision 绑定，同一节点不能同时启动两个活跃 Attempt；
- 开始 Attempt 后，该节点自动成为 Hook Trace 的当前节点；
- Evidence 只能引用 Attempt 开始后产生的同 Project、同 Tree、同 Node Trace；
- 缺少 required evidence 时，提出 `succeeded` 会得到 `uncertain`，节点继续保持 `verifying`；
- 失败后可以创建新 Attempt，`failed -> failed -> succeeded` 的全部历史在重启后仍能通过 Task Node Detail 查询；
- Skeleton Gate 只能引用状态为 `succeeded` 的 Skeleton Attempt。

## 5. Artifact Graph 与 Plan Drift

在 Claude 插件会话中完成一棵包含 `artifactLinks` 的 Task Tree 规划并确认分支，然后通过 Runtime Tools 验收：

1. 调用 `harness_get_artifact_graph`，确认返回当前 revision 的 Artifact、Task Link、Relation 和 Contract，且分页结果不包含其他 Project 的 ID。
2. 在活跃 Attempt 中修改当前节点已规划的文件；调用 `harness_get_artifact_detail`，确认状态更新为 `modified`，并能追溯到来源 Trace Event，且不会产生 unexpected Artifact Drift。
3. 在活跃 Attempt 中修改未规划文件；调用 `harness_get_plan_drift_summary`，确认产生 `warning` Drift，并与一个 `plan_drift` Trace Event 配对。
4. 修改仅由另一个尚未确认分支规划的文件；确认产生 `blocking` Drift，当前节点与 Attempt 进入 `blocked`，resolution 为 `pending_user_confirmation`。
5. 对上述 blocked Attempt 提出 `succeeded` Evaluation；确认结果被记录为 `uncertain`，transition 的 rejection code 为 `blocking_drift`，节点不会变为成功。
6. 重启 Claude 后再次查询 Artifact Detail 和 Plan Drift Summary；确认状态、来源和 Drift 记录仍存在。

## 6. Runtime Action 与 User Change

在已经确认的 Task Tree 中制造一个 `blocking` Drift，然后使用 Claude 插件中的 Runtime Tools 验收：

1. 查询 Runtime Snapshot 和 Plan Drift Summary，记录当前 Tree revision 与 Drift ID。
2. 提交 `harness_propose_plan_drift_resolution`；确认产生 `drift_resolution` 等待项，且 Drift 尚未解决。
3. 用户回答后，以明确的 confirmation ID 和回答 Trace 调用 `harness_resolve_runtime_confirmation`；确认 Drift 已按决策解决，节点进入相应的重新验证、修正或取消状态。
4. 分别提交 `minor_change` 和 `priority_change`；确认前者不改变 Tree revision，后者只改变选中的后续节点。
5. 提交包含完整候选 Task Tree 文档的 `scope_change`；确认当前 revision 在回答前不变，并产生 `change_confirmation` 等待项。
6. 回答 `yes` 后确认只产生一个新草稿 revision，workflow 回到 `task_tree_refinement`，受影响分支需要重新扫描和确认，不能立即执行代码。
7. 退出并重启 Claude，调用 `harness_get_user_change_requests` 和 `harness_get_runtime_action_detail`；确认三类变更、动作结果、确认答案与关联 Drift 均可恢复，且 `harness_get_waiting_items` 不再返回已解决提示。

额外验证 `no`、`pause`、重复回答、旧 revision、其他 Project 的 ID 和早于提示的回答 Trace：均不得产生跨 Project、重复或部分状态写入。

## 7. Failure Case L0-L4

在一个已确认、可执行的 Task Node 上制造一次有明确测试输出的失败：

1. 启动 Attempt、附加失败命令 Trace、进入 verifying 并提交 `failed` Evaluation；确认 `harness_get_failure_cases` 自动返回 L0，且能反查 Node、Attempt 与 Evaluation。
2. 再次制造相同结构化失败；确认复用同一个 Failure Case，同时 occurrence 数量增加，首次来源不被覆盖。
3. 使用 `harness_add_failure_reproduction` 添加完整 manual revision；实际执行人工复现并让 Hook 记录证据，再调用 `harness_validate_failure_reproduction`，确认晋升 L1。
4. 添加 assisted revision 并以新的运行证据验证，确认最高晋升 L2。
5. 添加 automated revision，声明 entry command、timeout、isolation、失败签名、pre-fix baseline 与重复策略；在隔离环境中取得稳定 RED、Oracle discrimination、重复稳定和 isolation 证据，确认晋升 L3。
6. 修复后创建新的成功 Attempt，在 post-fix baseline 上取得稳定 GREEN；用 RED 与 GREEN Trace 一起验证同一 automated revision，确认晋升 L4。
7. 重启 Claude，通过 `harness_get_failure_case_detail` 确认全部 occurrence、不可变 revision、validation result、当前有效 revision 和 L4 状态均保留。

额外验证：缺少 setup/cleanup/Oracle/evidence 的契约被拒绝；跨 Project、早于 revision 的验证证据被拒绝；重复 idempotency key 不产生第二条结果；后续低成熟度验证不能让 L4 降级；`flaky` 等可用性状态不会改变成熟度。

## 8. 安全检查

- 在 Hook 输入的 `apiKey`、`authorization`、`token`、`cookie` 或 `password` 字段中放入测试字符串；数据库 Trace 中只能出现 `[REDACTED]`。
- 在未确认范围时触发实质变更；Trace 应出现 `workflow_violation`，工具本身不应被 Harness 阻塞。
- 将一个项目的 marker 复制到无关目录；解析结果应为 `identity_conflict`，不得共享可写状态。

## 9. 当前不作为验收失败的范围

- Experience / Skill Candidate 的完整 Evolution 与自动晋升；
- Task Node Replacement 与 Effect Disposal；
- 项目 Clone/迁移自动改写；
- 完整 AST/符号调用图；
- Codex 等其他 Agent Runtime Binding；
- 图形界面。
