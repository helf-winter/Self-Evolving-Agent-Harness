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

## 8. Experience 与 Skill 自动晋升

在同一个已确认 Task Node revision 上依次完成两次失败 Attempt 和一次成功 Attempt：

1. 每次运行都通过正常工具产生 Trace，附加 required evidence 并提交 Evaluation；确认只有第三次应用成功后，`harness_get_skill_evolution_candidates` 才出现一个 Experience，且引用两次失败和一次成功。
2. 使用 `harness_freeze_skill_candidate` 创建候选；重复相同输入应返回同一 revision，修改指令应产生新的不可变 revision。
3. 分别用 `harness_propose_skill_test_case` 创建 real-failure replay、variation、holdout、negative-applicability；确认测试初始为 draft，且 holdout API 不接收 candidate instruction。
4. 实际执行测试质量检查并让 Hooks 记录 Trace，再调用 `harness_validate_skill_test_quality`；缺少 schema、隔离、failure reproduction、Oracle、区分度、稳定性或 split 校验时不得 accepted。
5. 对四种 accepted case 分别记录三次 no-Skill baseline 和三次 Skill-enabled run；Replay baseline 稳定失败，所有 Skill-enabled 与 negative-applicability 运行稳定通过，且记录 token、tool call 与 side-effect risk。
6. 调用 `harness_generate_skill_validation_report`；确认报告覆盖四类测试、24 个运行证据并自动将 candidate 与 Skill 晋升为 `promoted`。
7. 退出并重启 Claude，调用 `harness_get_skill_candidate_detail`；确认 Experience、冻结指令、测试定义、质量结果、24 次运行、报告和晋升状态完整恢复。

额外验证：一次失败后成功不产生 Experience；跨 Project Experience、candidate、test 或 Trace 被拒绝；早于 test 创建的证据被拒绝；同一 repetition 不可被不同结果覆盖；缺少任一分片、任一模式少于三次、结果不稳定、Replay baseline 不具区分度、Negative 失败或出现 high/irreversible 副作用时报告必须 fail，不能晋升。

## 9. Task Node Replacement 与 Effect Disposal

在一个已确认 Task Tree 中准备 provider 节点、依赖该 provider 的 consumer 节点和一个共享 Artifact Contract：

1. 让 provider 通过普通工具产生 material Effect，并调用 `harness_register_task_node_effect`；确认 Effect 绑定精确的当前 Task Node revision 和来源 Trace。
2. 调用 `harness_preview_task_node_replacement` 提交同一节点 ID、父节点和 children 的候选实现；确认返回不可变 candidate、Contract Diff、完整反向依赖影响闭包、逆序 suspension order、Effect risk 和 Runtime Confirmation Prompt，当前 Tree revision 尚未变化。
3. 用提示之后的 `UserPromptSubmit` Trace 调用 `harness_confirm_task_node_replacement`；确认回答 `yes` 后 consumer 先于 provider 挂起，活动 Attempt 被阻断，而 `no` 不产生任何挂起或激活。
4. 使用普通 Agent 工具执行 inverse 或 compensation 并产生 Trace，再调用 `harness_execute_task_node_replacement`；确认 Runtime 没有执行所保存的 operation 字符串。
5. 对 version-reversible Effect 验证 baseline mismatch 和 shared active owner：必须返回持久化 conflict，不能部分激活；冲突解决后可以用新证据重试，并保留每次处置结果。
6. 成功执行后确认新 Tree revision 原子激活，旧 revision 仍可查询，候选 Contract Binding 生效，受影响节点进入 `needs_revalidation`、`pending_dependency` 或 `pending_user_confirmation` 的确定性状态。
7. 让候选激活失败；确认旧 revision 仍为当前 revision。仅当全部已处置 Effect 可逆时，使用新的恢复证据调用 `harness_recover_task_node_replacement`，恢复原组合状态。
8. 重启 Claude，调用 `harness_get_task_node_replacements`、`harness_get_task_node_replacement_detail` 和 `harness_get_task_node_effects`；确认候选、确认答案、Effect、全部处置尝试、组合状态转换、激活/恢复结果与 Trace 引用完整保留。

额外验证：旧 revision、跨 Project ID、拓扑变化、未知 Contract、缺失/过早证据、遗漏 Effect disposition、irreversible 自动处置均被拒绝，且不得留下部分 Tree 激活。

## 10. 安全检查

- 在 Hook 输入的 `apiKey`、`authorization`、`token`、`cookie` 或 `password` 字段中放入测试字符串；数据库 Trace 中只能出现 `[REDACTED]`。
- 在未确认范围时触发实质变更；Trace 应出现 `workflow_violation`，工具本身不应被 Harness 阻塞。
- 将一个项目的 marker 复制到无关目录；解析结果应为 `identity_conflict`，不得共享可写状态。

## 11. 当前不作为验收失败的范围

- 项目 Clone/迁移自动改写；
- 完整 AST/符号调用图；
- Codex 等其他 Agent Runtime Binding；
- 图形界面。
