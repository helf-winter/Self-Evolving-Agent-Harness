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

## 6. 安全检查

- 在 Hook 输入的 `apiKey`、`authorization`、`token`、`cookie` 或 `password` 字段中放入测试字符串；数据库 Trace 中只能出现 `[REDACTED]`。
- 在未确认范围时触发实质变更；Trace 应出现 `workflow_violation`，工具本身不应被 Harness 阻塞。
- 将一个项目的 marker 复制到无关目录；解析结果应为 `identity_conflict`，不得共享可写状态。

## 7. 当前不作为验收失败的范围

- Evolution 自动结论与经验晋升；
- 失败案例 L0-L4 自动化；
- blocking Drift Resolution、User Change Request、Task Node Replacement 与 Effect Disposal；
- 项目 Clone/迁移自动改写；
- 完整 AST/符号调用图；
- Codex 等其他 Agent Runtime Binding；
- 图形界面。
