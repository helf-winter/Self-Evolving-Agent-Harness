# Self-Evolving Agent Harness 软件需求规格说明书（SRS）

## 1. 文档信息

### 1.1 文档基本信息

| 项目内容 | 说明 |
| --- | --- |
| 项目名称 | Self-Evolving Agent Harness |
| 文档名称 | 软件需求规格说明书 |
| 文档版本 | v0.29 |
| 创建日期 | 2026-09-13 |
| 作者 | 项目发起人、Codex |
| 状态 | 草稿 |

### 1.2 版本记录

| 版本 | 日期 | 修改内容 | 修改人 |
| --- | --- | --- | --- |
| v0.1 | 2026-09-13 | 初始整理项目路径、Task Tree、运行上下文边界 | Codex |
| v0.2 | 2026-09-13 | 增加工具事件驱动、Artifact Graph、Trace、Evaluation、Evolution 设计 | Codex |
| v0.3 | 2026-09-13 | 按标准 SRS 结构重写需求文档 | Codex |
| v0.4 | 2026-09-13 | 明确 Harness 面向多 Agent 运行时，不绑定 Claude 或 Codex | Codex |
| v0.5 | 2026-09-13 | 将 Execution Session 降级为 Trace 的 Execution Context 元信息 | Codex |
| v0.6 | 2026-09-13 | 补充 Project 当前目录归属、/taskroot 创建根任务、Trace/Artifact/Evaluation/Evolution 待讨论边界 | Codex |
| v0.7 | 2026-09-14 | 明确产品形态参考 Superpowers：跨 Agent 工程能力框架 + 自进化运行时 | Codex |
| v0.8 | 2026-09-14 | 明确 Task Tree 类似 OpenSpec tasks.md 的结构化计划，需用户确认后按计划执行 | Codex |
| v0.9 | 2026-09-14 | 增加骨架优先、分支深度执行策略与 execution_phase 调度规则 | Codex |
| v0.10 | 2026-09-14 | 明确 Task Relation Edges 是 Task Tree 内部关系层，用于表达跨分支调用、数据交换和共享契约 | Codex |
| v0.11 | 2026-09-14 | 明确 Artifact Graph 与 Task Tree 同步演进，跨任务约定通过共同关联计划态 Artifact 表达，不新增独立契约对象 | Codex |
| v0.12 | 2026-09-14 | 明确分支确认会将关联 Draft Artifact 晋升为 planned，并通过 plan drift 记录执行偏移 | Codex |
| v0.13 | 2026-09-14 | 明确 Plan Drift severity 分级与 blocking drift 的暂停、建议和用户确认流程 | Codex |
| v0.14 | 2026-09-14 | 新增 User Change Request，用于处理执行过程中用户主动变更目标、范围、优先级、Artifact 或验收标准 | Codex |
| v0.15 | 2026-09-14 | 调整用户输入处理方向，转向 Agent Runtime 内生交互模型 | Codex |
| v0.16 | 2026-09-15 | 精简 Runtime 交互模型，明确由 Harness Runtime Skill 触发自省工具、确认提示和安全规则 | Codex |
| v0.17 | 2026-09-15 | 明确 Runtime Introspection Tools 采用 Snapshot、Summary、Detail 三档查询粒度 | Codex |
| v0.18 | 2026-09-15 | 删除 Task Book 概念，统一为 draft Task Tree，并明确已确认分支可局部修改后重新确认 | Codex |
| v0.19 | 2026-09-15 | 修正执行策略：分支确认是授权边界，代码执行必须先搭建上层骨架，再分支细化，不从叶子节点直接开始 | Codex |
| v0.20 | 2026-09-15 | 重新梳理 Harness 与 Agent 的架构关系，明确 Harness 是 Agent Runtime 的增强能力层而非外部管理系统 | Codex |
| v0.21 | 2026-09-15 | 统一采用 Harness Runtime Layer 命名，并新增 Runtime Ownership Principle 与 Agent Runtime Binding 定位 | Codex |
| v0.22 | 2026-09-15 | 明确 Harness 是面向 Coding Agent 的约束系统与事件驱动生命周期运行时，通过约束和 Hooks 影响并记录 Agent coding 全流程 | Codex |
| v0.23 | 2026-09-16 | 明确 Skills、Workflows、Hooks、Runtime Records 的分工，引入 Workflow State Machine，并将 Task Tree 定位为 Workflow-first、Runtime-recorded | Codex |
| v0.24 | 2026-09-17 | 明确所有 coding 请求均进入 Task Tree Workflow，增加新建或归并确认、Task Tree revision 影响传播，以及基于任务专属标准与 Hook 证据的 Skeleton Gate | Codex |
| v0.25 | 2026-09-17 | 明确 Leaf Task Contract 的语义判断与代码硬校验边界，并将 Runtime Records 改为公共数据库集中存储、按 Project Path 强隔离查询 | Codex |
| v0.26 | 2026-09-17 | 增加稳定 Project Identity Marker 与 Project Clone 语义；引入框架中立的时间/空间可组合性、Task Node Replacement 和四级 Effect 分类 | Codex |
| v0.27 | 2026-09-18 | 明确自然语言状态提交边界、Trace 事实源与 Artifact 投影关系，并增加问题驱动的 Task Tree Refinement Loop | Codex |
| v0.28 | 2026-09-18 | 明确 Evaluation 与 Task Node 状态之间的确定性转换策略，并建立 AI 测试案例质量契约、Baseline 与独立 Holdout 验证流程 | Codex |
| v0.29 | 2026-09-18 | 明确 Failure Case L0-L4 成熟度、Task Tree 中心渐进视图、Artifact 自适应粒度与 Relation Edge 的 Artifact 绑定矩阵 | Codex |

## 2. 项目概述

### 2.1 项目背景

现有 AI Agent 工具通常以一次性任务执行为中心：用户提出请求，Agent 执行若干工具调用，返回结果，然后上下文逐渐消失。此模式在简单任务中足够有效，但在真实软件工程任务中存在明显问题：

- 任务目标、拆解过程和执行状态难以长期保存；
- Agent 实际修改了哪些文件、运行了哪些命令、产生了哪些结果，缺少结构化追踪；
- 成功经验难以沉淀为可复用能力；
- 失败案例难以转化为可复现测试；
- 多轮、多任务、多项目之间的上下文容易混淆；
- Agent 对自身执行过程缺少可验证的事实记忆。

Self-Evolving Agent Harness 的目标是构建一个面向 Coding Agent 的插件化约束系统与事件驱动生命周期运行时。它通过 Skills / Workflows 将用户期望的工程方法注入 Agent 的 coding 过程，通过 Lifecycle Hooks 记录 Agent 实际执行过程，并通过 Runtime Records 保存 Task Tree、Trace、Artifact、Evaluation 和 Evolution 等长期状态。

Harness 不是 Agent 外部的管理平台，也不是独立后台系统。它应被描述为安装到 Agent coding 环境中的 Harness Plugin：Agent 在 coding 时处在一套由 Skills / Workflows 提供的约束和帮助机制里，按照用户定义的工程方法进行规划、执行、验证和汇报，同时由 Lifecycle Hooks 记录全流程事实。

Harness 面向多 Agent Runtime 设计，不绑定 Claude、Codex 或任何单一 Agent。Claude、Codex、Cursor Agent、自研 Agent 或未来新的 Agent，都应通过各自的 Agent Runtime Binding 获得 Harness Runtime Layer。该运行层处理统一任务结构、运行事实、资产关系、评估和进化，不依赖某个 Agent 的私有协议作为核心架构。

产品形态上，Harness 参考 Superpowers 这类跨 Agent 工程能力框架：它不是单一 Agent，也不是单一 CLI 工具，而是通过插件、Skills、Workflows、初始化指令、Runtime Binding 和 Lifecycle Hooks，约束并增强不同 coding agent 的软件工程能力。

与 Superpowers 更偏“Skills + Workflow + Methodology”不同，Harness 还需要提供 Coding Constraint Runtime 与事件驱动生命周期能力：Task Tree、Trace System、Artifact Graph、Evaluation System 和 Evolution System。也就是说，Superpowers 更像是为 Agent 注入可复用技能和工作流；Harness 则在此基础上进一步规定 Agent coding 时应该怎样做，并用 Hooks 记录 Agent 实际做了什么。

### 2.2 项目目标

系统目标如下：

- 将用户的软件工程任务组织为可长期管理的 Task Tree；
- 将 Task Tree 首先设计为 Workflow 约束形式，再由 Runtime Records 保存结构化状态；
- 通过 Planning Constraints、Execution Constraints 和 Lifecycle Hooks 约束 Agent 的 coding 过程；
- 通过工具事件、项目状态变化和用户确认事件记录 Agent 的真实执行过程；
- 建立 Artifact Graph，描述任务影响到的代码、测试、配置、文档、接口和命令；
- 通过 Trace System 关联任务、工具调用、资产变化、验证结果和用户反馈；
- 通过 Evaluation System 判断任务是否真正完成、是否可靠、是否存在风险；
- 将成功执行沉淀为 Experience 和 Skill；
- 将失败执行沉淀为 Failure Case 和可复现测试；
- 支持同一项目下多个任务长期并存、恢复、切换和追踪；
- 通过稳定 Project Identity 支持目录移动、重命名和可追溯复制；
- 通过 provides / requires、生命周期 Effect 与 revision replacement 支持插件和 Task Node 的时空可组合；
- 支持 Claude、Codex、自研 Agent 等不同 Agent Runtime 通过兼容绑定层获得 Harness Runtime Layer；
- 以插件化 Skills 框架的形态分发到不同 Agent 环境；
- 在 Skills 和工作流方法论之上增加 Runtime、Trace、Evaluation 和 Evolution；
- 通过 Hooks 将 Agent coding 过程中的关键事件转化为 Trace、Artifact、Evaluation 和 Evolution 的事实来源；
- 通过 Workflow State Machine 保证 coding task 按阶段推进，并让 Hooks 校验 Agent 实际行为是否符合当前阶段；
- 减少对 LLM 意图判断的依赖，优先使用确定性规则记录事实和推进状态。

### 2.3 项目范围

#### 2.3.1 系统包含

本系统包含以下能力：

- 项目路径归属管理；
- Project Identity Marker、Project Path Alias 与 Project Clone；
- Task Collection 管理；
- Task Tree 与 Task Node 生命周期管理；
- 父子任务结构化通信；
- 工具事件分类与记录；
- Trace System；
- Artifact Graph；
- Evaluation System；
- Experience、Skill、Failure Case 的进化闭环；
- Execution Context 元信息记录；
- Agent Runtime Binding 兼容绑定边界；
- 跨 Agent 插件或能力包分发形态；
- 可组合 Skill 和工作流方法论；
- Coding Constraints；
- Lifecycle Hooks；
- Workflow State Machine；
- Plugin / Task Node Composition Contract；
- Effect 分类、处置与 revision replacement；
- Runtime Records；
- 任务、Trace、Artifact、Evaluation 的查询能力；
- Agent 运行过程中的事实记录与状态聚合。

#### 2.3.2 系统不包含

当前需求阶段不包含以下内容：

- 具体数据库选型；
- 具体前端 UI 设计；
- 具体模型供应商和模型路由策略；
- 某个特定 Agent 的私有协议实现细节；
- 复制 Superpowers 的完整技能库或安装机制；
- 完整语言级代码分析器；
- 替代 Git 的版本管理能力；
- 自动部署平台；
- 多用户协同权限系统的完整实现；
- 模型训练或微调；
- 对所有编程语言的深度语义分析。

### 2.4 核心设计原则

系统设计遵循以下原则：

- Harness 本质上是面向 Coding Agent 的约束系统与事件驱动生命周期运行时；
- Harness 的产品交付形态应优先是插件，而不是独立后台系统；
- Skills 负责让 Agent 知道在某个场景下应该怎么做；
- Workflows 负责定义一个 coding task 从开始到结束的阶段顺序；
- Hooks 负责校验和记录 Agent 实际做了什么；
- Runtime Records 负责保存 workflow 状态、任务结构和生命周期事实；
- Task Tree 应采用 Workflow-first、Runtime-recorded 的设计：先作为 Skill / Workflow 约束 Agent，再由 Runtime Records 保存结构化状态和执行事实；
- Workflow State Machine 负责记录当前 workflow、当前 stage、允许动作、禁止动作和下一步转移条件；
- 约束系统决定 Agent 在 coding 时应该怎样规划、修改、验证和汇报；
- Lifecycle Hooks 捕获 Agent coding 过程中的关键事件，并驱动 Trace、Artifact、Evaluation 和 Evolution 的生命周期记录；
- 约束和 Hooks 都发生在 Agent coding 过程中，而不是 Agent 执行结束后的外部补记；
- 监控对象是 coding 生命周期和工程事件，不是把 Agent 本体作为外部监管对象；
- 约束应分为 Planning Constraints、Execution Constraints 和 Lifecycle Hooks 三类；
- Planning Constraints 约束任务如何拆分、什么时候确认、什么时候停止拆分、什么时候允许执行；
- Execution Constraints 约束代码修改、工具调用、分支执行、测试验证、成功声明和阻塞处理；
- Lifecycle Hooks 监听工具调用、文件变化、命令执行、测试结果、用户确认、Plan Drift、User Change Request 等事件；
- 任务按照项目路径归属，而不是按照运行会话归属；
- Project 目录默认使用当前 Agent 运行目录；Claude 场景下即 Claude 当前工作目录；
- Runtime Records 统一存储在 Harness 公共数据库中，不在各项目目录创建 `.harness` 或其他运行时数据目录；
- 项目目录允许存在 `.agent-harness-project.json` 作为最小 Project Identity Marker；该文件只保存稳定项目身份，不保存 Task Tree、Trace、Artifact、Evaluation 或其他 Runtime Records；
- Project Path 是 Task Tree、Trace、Artifact、Evaluation 等数据的查询和展示隔离依据；公共数据库中的物理集中存储不改变项目间的逻辑隔离；
- Project Identity 与 Project Path 必须分离：路径用于当前数据可见范围，稳定 `project_id` 用于识别目录移动、重命名和复制；
- 目录移动或重命名时保留原 `project_id` 并更新 canonical_path；目录复制时创建新 `project_id`，复制必要的 Task Tree 与工程记忆，并让两个 Project 此后独立演进；
- Agent Runtime 默认只能查询当前 Project Path 绑定的数据，不得跨 Project 返回 Task Tree 候选或运行事实；
- 所有具有工程变更目标的 coding 请求都必须进入 Task Tree Workflow；普通问答、概念解释和不产生工程变更目标的代码阅读不进入 Task Tree；
- Agent 收到 coding 请求后，应先查询当前 Project 下已有 Task Tree 摘要，分析该需求应新建 Task Tree 还是归并到已有 Task Tree，并将推荐结果、理由和影响范围交给用户决定；
- 用户确认任务归属后，Agent 才能创建新的 Task Tree 或修改已有 Task Tree；`/taskroot [任务名称]` 用于用户显式强制新建并命名根任务；
- Agent 应按照 Task Tree 方法分解需求并与用户讨论目标、边界、方案、接口和验收条件，形成完整 draft Task Tree；用户确认计划前不得执行会修改项目的任务节点；
- 初始完整 Task Tree 只是可讨论的 draft 工作底稿；生成后必须进入问题驱动的局部精炼循环，而不是直接要求用户确认粗略初稿；
- 精炼阶段由 Agent 默认按照影响优先级推荐下一项讨论内容，用户可以随时点名其他分支、节点或决策并改变讨论方向；
- 每次真正改变 Task Tree 结构的讨论结果必须形成 Draft Change Set 和新的 draft revision；纯说明性对话不创建 revision；
- Plan Readiness 应按待确认范围判断，不要求整棵树同时就绪；未满足 readiness 的分支保持 draft，跨分支依赖继续按未确认依赖规则阻塞；
- 只有发生实质项目变更或任务执行事件时，才推进任务记录；
- Task Tree 描述 Agent 对任务的计划和拆解，类似 OpenSpec 中的 `tasks.md`，但以树/图结构表达；
- Task Tree 首先是一种 Agent coding workflow 约束，用于规定 Agent 在复杂 coding task 中如何拆解、确认、执行和验证任务；
- Runtime 中保存的 Task Tree 是该 workflow 执行后的结构化记录，而不是外部管理系统分配给 Agent 的任务清单；
- Task Tree 不是执行痕迹的反推结果，也不是 LLM 隐式思考链的完整记录；
- Task Tree 是主组织结构，以父子关系表达任务归属，同时允许 Task Relation Edges 表达跨节点交互关系；
- Task Relation Edges 属于 Task Tree 的内部关系层，不是独立于 Task Tree 的另一套图结构；
- Task Tree 可以一次性全量生成，后续在执行过程中按需修正；
- 叶子任务节点必须足够清晰，可以作为相对独立的实现与验收单元，不需要继续拆分；
- 叶子节点采用“Agent 语义判断 + Leaf Task Contract + 代码硬校验 + 用户确认”的判定机制；代码负责检查结构完整性和引用有效性，Agent 负责判断目标语义是否内聚，用户通过 Task Tree 确认最终边界；
- 规划阶段应记录 `required_evidence`，执行阶段产生 `completion_evidence`；两者不得混同；
- Task Tree 默认采用骨架优先、分支深度执行策略：分支确认只是授权边界，真实代码执行必须先搭建已确认范围内的上层结构和工程骨架，再按分支深入实现和验证；
- 同一 Task Tree 允许已确认分支与未确认分支并存；调度器只执行已确认且 ready 的节点，已确认节点依赖未确认节点时必须进入 `blocked_by_unconfirmed_dependency`；
- Task Node 应标记执行阶段，包括 skeleton、implementation、verification；
- Artifact Graph 描述工程资产和资产关系，既包含计划阶段的资产草案，也包含执行阶段形成的事实资产；
- Artifact Graph 首版采用自适应粒度：默认记录文件和工程结构资产，跨任务契约必须记录为 Contract Artifact，函数、类、类型等 Symbol Artifact 仅在交付、共享、故障定位、Drift 或验收需要时按需创建；
- 首版不得要求对整个项目建立完整 AST、符号图或调用图，只记录 planned、touched、shared、verified 或 failure-related 的关键资产；
- Task Relation Edges 描述轻量任务关系，详细接口、Schema、模块、测试、命令等跨任务约定通过多个 Task Node 共同关联同一个 Artifact 表达；
- `calls`、`exchanges_data_with`、`shares_artifact_with` 必须关联 Artifact；`depends_on` 与 `coordinates_with` 仅在关系依赖具体工程交付物时强制关联 Artifact；
- Task Relation Edge 默认不全部绘制：主视图保持 Task Tree，只直接提示阻塞、高风险、未确认依赖和 Contract 缺失；节点一跳关系与全局 Relation Overlay 按需展示；
- Artifact Graph 与 Task Tree 同步生成、同步演进，不只是任务执行后的事后审计图；
- 用户确认 Task Tree 分支时，该分支关联的 draft Artifact 应自动晋升为 planned，成为执行阶段的计划基准；
- 已确认 Task Tree 允许直接修改已有节点，但必须生成新的 Task Tree revision，不得覆盖旧 revision 和历史执行事实；
- 结构修改后应根据父子关系、Task Relation Edges 和共享 Artifact 计算影响范围：被修改节点和未完成的受影响子树回到 pending_user_confirmation，已完成但受影响的节点标记为 needs_revalidation，未受影响部分保持原状态；
- Skeleton Pass 的完成不能只由 Agent 声明；每个顶层功能分支必须在计划阶段生成任务专属 Skeleton Acceptance Criteria，并由 Lifecycle Hooks 使用文件、Artifact、命令和验证结果等事实证据判断 Skeleton Gate；
- 执行过程中允许 Artifact Graph 被细化、修正或扩展，但关键 Artifact 的新增、删除、替换或职责变化应记录为 plan drift；
- Plan Drift 默认不打断执行，只有 blocking 级别才暂停当前 Task Node 或分支，并要求 Agent 给出建议方案等待用户确认；
- 用户在已确认分支执行期间主动修改目标、范围、优先级、Artifact 或验收标准时，应记录为 User Change Request，而不是归类为 Plan Drift；
- User Change Request 根据影响程度分为 minor_change、scope_change 和 priority_change，并分别触发不同的更新、暂停或调度行为；
- 不应将用户输入处理设计为 Agent 外部的输入拦截器模式，而应设计为 Agent Runtime 内生的 Runtime Interaction Loop；
- 显式 slash command 应由 Runtime Native Command 系统直接处理；
- 自然语言理解是 Agent 的基础能力，不作为独立模块写入系统组件；
- Agent 需要当前任务、状态、Artifact、Drift 或等待确认项时，应通过 Harness Runtime Skill 使用 Runtime Introspection Tools，而不是依赖每轮预注入上下文；
- Runtime Introspection Tools 应采用 Snapshot、Summary、Detail 三档查询粒度，默认返回最小充分摘要，避免一次性返回完整历史；
- Harness Runtime Skill 的触发应依赖 Skill 自身的 description / trigger rules，不依赖外部提示词手动提醒；
- 需要用户确定性选择时，Agent 应发起 Runtime Confirmation Prompt；
- Runtime State Safety Rules 只定义哪些高风险状态变化必须确认，不替代 Agent 的自然语言判断；
- 自然语言直接进入 Agent Core；Agent 对自然语言的理解只能提出结构化 Runtime Action，是否提交状态变化由代码根据 action type、目标、expected revision 和 Safety Rules 确定；
- 只有改变用户授权边界、已确认计划基线、已有工作处置方式或高风险 Effect 的 Runtime Action 必须确认；只读查询、draft 内局部编辑、事实记录和已授权范围内的普通状态推进不重复确认；
- “可以”“继续”等短回复只能在存在唯一 pending confirmation 时绑定该确认项；存在多个或不存在待确认项时不得将其解释为新的执行授权；
- Trace System 是任务、资产、评估和进化之间的事实连接层；
- Trace 需要保留足够丰富的信息，因为它是后续经验抽象和能力进化的主要来源之一；
- Trace Event 是追加式时间事实源，回答“何时发生了什么”；Artifact Graph 是由计划 revision 与 Trace 投影形成的当前工程状态，回答“现在有哪些资产及关系”；
- Artifact 不重复保存完整工具输入、命令输出或 diff，Trace 不重复维护完整资产关系；Artifact 的每次状态变化必须追溯到 source Trace Event 或 planning revision；
- Evaluation 不能只依赖 Agent 的自然语言声明；
- Evaluation Result 是绑定 Task Node Revision 与 Execution Attempt 的不可变评估事实，不直接等同于 Task Node 当前生命周期状态；
- Task Node 状态只能由代码层 Lifecycle Transition Policy 基于适用 Evaluation、required evidence、依赖和 blocking drift 确定性推进；旧 revision 的 Evaluation 不得推进当前 revision；
- 父 Task Node 必须在必要子节点完成且父级集成验收通过后产生自己的 Evaluation，不得简单复制或平均子节点结论；
- LLM 可以用于总结、归纳和建议，但不能单独作为事实来源；
- 成功和失败都必须沉淀为长期资产；
- Failure Case 采用 L0 observed、L1 manual、L2 assisted、L3 automated、L4 regression 的渐进成熟度；人工复现与自动化复现是同一个 Failure Case 的 reproduction revisions，不是两个相互独立的案例；
- 自动化 Failure Case 必须证明 pre-fix RED、post-fix GREEN 和重复执行稳定；隔离优先使用 fixture、worktree、临时目录或项目原生测试环境，容器不是强制前提；
- AI 可以生成 Skill 验证测试，但不能自行宣告测试有效；测试必须通过结构、隔离、复现、Oracle、区分能力、稳定性和 Holdout Gate；
- Skill Candidate 必须在 revision 冻结后接受无 Skill baseline 与启用 Skill 的对照执行；独立 Holdout 不得暴露给 Skill 生成上下文；
- Harness Runtime Layer 不绑定 Claude、Codex 或其他具体 Agent Runtime；
- Agent Runtime Binding 是不同 Agent Runtime 的兼容绑定机制，用于将 Harness Runtime Layer 绑定到对应 Agent 环境；
- MCP、Hook、CLI Wrapper、日志监听、工具事件订阅等都只是 Agent Runtime Binding 或 Lifecycle Hooks 的可能实现方式，不是系统主架构；
- 产品形态应接近跨 Agent 的插件化工程能力框架；
- Skill 和工作流是 Agent 行为约束层，Lifecycle Hooks 是事实采集触发层，Runtime、Trace、Evaluation、Evolution 是 Harness 的工程闭环层。
- 用户查看运行状态时以 Task Tree 为导航骨架，Artifact 表达工程影响，Trace 表达过程证据，Evaluation 表达结果判断，Failure / Evolution 表达长期沉淀；展示采用 Snapshot、Summary、Detail 三级渐进披露。
- Harness 的组合机制采用 CORDIS-like 语义：空间可组合性由稳定身份、`provides`、`requires` 和依赖闭包表达，时间可组合性由 revision、生命周期、owned effects、disposer / compensation 和可恢复替换事务表达；
- CORDIS-like 表示借鉴其可组合性语义，不代表首版直接依赖 Cordis 框架；核心数据模型和状态机必须保持框架中立；
- Task Node 的执行生命周期与组合生命周期必须分离，避免把 `succeeded / failed` 与 `active / pending_dependency / replacing` 混为同一状态；
- Task Node 产生的 Effect 必须分类为 `reversible`、`version_reversible`、`compensatable` 或 `irreversible`；不可逆或仅可补偿的 Effect 不得被自动回滚；
- Task Node Replacement 必须通过新 revision、依赖影响闭包、逆序挂起、Effect 处置、候选激活、依赖重评估和失败恢复完成，不得原地覆盖旧节点事实。

### 2.5 产品形态定位

Harness 的产品形态不是传统 Web 系统，也不是单一 Agent 外部的后台平台，而是一个面向 Coding Agent 的插件化约束与生命周期记录系统。

可以将其理解为：

```text
Superpowers-like Agent Engineering Framework
  +
Coding Constraint Runtime
  +
Event-driven Lifecycle Hooks
  +
Runtime Records
```

其中，Superpowers-like 表示产品分发和使用形态参考跨 Agent 的 Skills / Plugin / Workflow 框架：

- 面向多个 coding agent，而不是绑定单个 Agent；
- 通过插件、能力包、初始化指令或 Agent Runtime Binding 绑定到不同 Agent Runtime 环境；
- 提供一组可组合 Skills；
- 通过方法论和工作流约束 Agent 的工程行为；
- 让 Agent 在真实开发任务中更可靠地规划、执行、验证和收尾。

Coding Constraint Runtime 与 Event-driven Lifecycle Hooks 表示 Harness 的核心差异：

- 通过 Task Tree 管理长期任务结构；
- 通过 Trace System 记录执行事实；
- 通过 Artifact Graph 记录工程资产关系；
- 通过 Evaluation System 判断结果是否可靠；
- 通过 Evolution System 将成功沉淀为 Skill，将失败沉淀为 Failure Case。

Coding Constraint Runtime 表示 Harness 会通过规则、Skill、Workflow 和 Runtime State 约束 Agent coding 过程；Event-driven Lifecycle Hooks 表示 Harness 会通过 Agent 执行过程中的事件触发全生命周期记录。

因此，Harness 不只是“给 Agent 装一组静态 Skills”，而是要让 Skills、Workflows、Constraints、Hooks、Workflow State Machine、Runtime Records、Trace、Evaluation 和 Evolution 共同成为 Agent Runtime 的长期工程能力。

插件内部结构应理解为：

```text
Harness Plugin
├── Skills / Workflows
│   ├── 约束 Agent 如何规划、执行、验证、汇报
│   ├── Task Tree Workflow
│   ├── Drift Handling Workflow
│   └── Evaluation / Reporting Workflow
├── Lifecycle Hooks
│   ├── 监听工具调用、文件变化、命令执行、测试结果
│   ├── 写入 Trace
│   ├── 更新 Artifact Graph
│   ├── 推进 Task Node / Workflow State
│   └── 触发 Evaluation / Evolution
├── Composition Runtime
│   ├── Plugin Composition Contract
│   ├── Task Node Composition Contract
│   ├── Dependency Resolution
│   ├── Effect Ownership / Disposal
│   └── Revision Replacement
└── Runtime Records
    ├── workflow_state
    ├── task_tree
    ├── trace
    ├── artifacts
    ├── evaluations
    ├── project_clone
    ├── experience
    ├── failure_case
    └── skill_candidate
```

多 Agent 适配应采用“同一套 Harness 语义，不同 Agent 的插件实现”的方式。当前 MVP 优先实现 Claude Code Harness Plugin，后续再扩展 Codex Plugin 或自研 Agent Runtime Binding。

### 2.6 Agent Runtime Architecture

Self-Evolving Agent Harness 的目标不是构建一个围绕 Agent 的管理系统，而是构建一种新的 Agent Runtime 形态。

传统 Agent 通常是：

```text
User
  ↓
Agent
  ↓
Tool
  ↓
Result
```

Self-Evolving Agent 应是：

```text
User
  ↓
Agent Runtime
  ↓
+-------------------------+
| Agent Core              |
| Harness Runtime Layer   |
+-------------------------+
  ↓
Tool / Project
```

Harness Runtime 与 Agent 的关系应按照“运行层”理解，而不是按照“两个独立系统通信”理解。

```text
Agent Runtime
├── Agent Core
│   ├── Reasoning
│   ├── Planning
│   ├── Natural Language Interaction
│   └── Tool Execution
└── Harness Runtime Layer
    ├── Skills / Workflows
    │   ├── Task Tree Workflow
    │   ├── Branch Execution Workflow
    │   ├── Drift Handling Workflow
    │   └── Verification / Reporting Workflow
    ├── Workflow State Machine
    ├── Coding Constraints
    │   ├── Planning Constraints
    │   └── Execution Constraints
    ├── Lifecycle Hooks
    ├── Runtime State
    ├── Task Tree
    ├── Trace Fact Memory
    ├── Artifact Graph
    ├── Evaluation
    ├── Evolution
    ├── Runtime Records
    ├── Runtime Introspection
    └── Runtime Confirmation
```

因此：

- Harness Runtime ≠ Agent；
- Harness Runtime ≠ Agent 外部的管理平台；
- Harness Runtime Layer ≠ Agent 的外挂系统；
- Harness Runtime Layer 与 Agent Core 共同组成完整 Agent Runtime。

Agent Core 负责理解用户需求、推理和规划、调用工具执行任务、进行自然语言交互。Harness Runtime Layer 负责提供持续运行所需状态、工程记忆、coding 约束和生命周期 Hooks，包括任务状态管理、Task Tree 生命周期、Trace 事实记忆、Artifact Graph、Evaluation、Evolution、运行时状态查询和确认机制。

参考 Superpowers 的思想：

```text
Superpowers:
Agent + Skills + Workflow

Harness:
Agent + Skills + Workflow + Coding Constraints + Lifecycle Hooks + Runtime State + Trace + Evaluation + Evolution
```

这意味着实现上不应演化为“一个 Agent 系统 + 一个 Harness 后台系统”，而应实现为“一个具备 Harness Runtime Layer 的 Self-Evolving Agent”。

### 2.7 Runtime Ownership Principle

Agent Runtime 由 Agent Core 与 Harness Runtime Layer 共同组成。二者不是两个相互调用的独立系统，而是在同一运行时中承担不同 ownership 的组成部分。

Agent Core 负责智能行为，包括：

- 理解用户需求；
- 推理；
- 规划；
- 决策；
- 工具调用；
- 自然语言交互。

Harness Runtime Layer 负责运行状态和工程闭环，包括：

- Coding Constraints；
- Lifecycle Hooks；
- Task 生命周期；
- Runtime State；
- Trace 事实记忆；
- Artifact 关系；
- Evaluation；
- Evolution。

核心原则如下：

- Harness 不负责替代 Agent 推理；
- Agent 不负责独自维护长期工程状态；
- Agent Core 与 Harness Runtime Layer 协同推进任务状态；
- Harness Runtime Layer 为 Agent 提供持续运行所需状态、工程记忆、coding 约束和生命周期事件记录。

应避免两个极端：

```text
错误：Harness = Agent 管理后台
错误：Agent 自己维护全部上下文

正确：Agent 负责思考
正确：Harness Runtime Layer 负责记忆、约束和生命周期记录
正确：Agent Runtime 负责持续运行
```

### 2.8 Spatiotemporal Composition Principle

Harness 需要同时支持空间可组合性和时间可组合性，使插件能力与 Task Node 能够在运行过程中安全装配、替换、暂停和恢复。

空间可组合性回答“当前组成部分与哪些能力共同工作”：

- 每个插件和 Task Node 使用稳定 ID；
- revision 声明 `provides_contracts` 与 `requires_contracts`；
- 依赖解析基于显式 contract，而不是仅依赖自然语言描述或加载顺序；
- provider 缺失时，依赖者进入 `pending_dependency`，不得在依赖不满足时继续执行；
- provider 被兼容 revision 替换后，依赖者应恢复并重新验证；不兼容时进入 `needs_replanning`。

时间可组合性回答“组成部分随时间变化时如何安全演进”：

- 插件和 Task Node 的注册、修改和外部动作都属于其生命周期拥有的 Effect；
- Effect 必须记录类型、目标、基线、证据和处置策略；
- revision 被卸载或替换时，只能自动处置明确属于该 revision 且允许处置的 Effect；
- replacement 必须是可追溯事务，保留旧 revision、影响范围、处置结果和恢复结果；
- 不得把代码文件、外部消息、部署、支付或删除等动作假定为天然可逆。

CORDIS-like 语义在本项目中的映射如下：

| 可组合概念 | Harness 对应结构 |
| --- | --- |
| Stable Entry ID | 稳定 `plugin_id` 或 `task_node_id` |
| Plugin Revision | Plugin Revision 或 Task Node Revision |
| Service Provider | `provides_contracts` |
| Dependency Injection | `requires_contracts` |
| Fiber / Composition State | `composition_state` |
| Effect | revision 拥有的 Runtime、Artifact 或外部 Effect |
| Disposer | inverse operation 或 compensation operation |
| Pending Dependency | `pending_dependency` |
| Hot Replacement | Task Node / Plugin Revision Replacement |
| Scope / Group | Plugin Scope 或 Task Branch Scope |

本项目借鉴上述语义，但不把 Cordis API、容器或运行模型写入领域核心。首版不直接依赖 Cordis；未来可以增加 Cordis Binding，而无需修改 Task Tree、Trace、Artifact 或 Effect 的核心语义。

## 3. 用户角色分析

| 角色 | 描述 | 主要权限或职责 |
| --- | --- | --- |
| 项目用户 | 使用 Harness 执行软件工程任务的人 | 发起任务、查看任务树、查看 Trace、确认结果、提供反馈 |
| Agent Core | Agent Runtime 中负责智能行为的核心部分 | 理解需求、推理、规划、自然语言交互、调用工具执行任务 |
| Agent Runtime Binding | 不同 Agent Runtime 的兼容绑定机制 | 将 Harness Runtime Layer 绑定到 Claude、Codex、Cursor Agent、自研 Agent 等环境 |
| Harness Runtime Layer | Agent Runtime 中负责 coding 约束、生命周期事件记录、长期状态和工程闭环的运行层 | 提供约束规则、维护 Task Tree、触发 Lifecycle Hooks、记录 Trace、维护 Artifact、评估结果、沉淀经验 |
| Skill Author | 编写或维护 Harness Skill 和工作流的人 | 定义可复用能力、验证 Skill、维护方法论 |
| 项目维护者 | 维护 Harness 自身或项目配置的人 | 配置运行环境、管理规则、审核 Skill 和 Failure Case |
| 外部工具 | Shell、Git、测试框架、构建工具、编辑工具等 | 被 Agent Runtime 调用，产生可记录事实 |

## 4. 业务流程设计

### 4.1 整体业务流程

```text
用户在项目路径中启动具备 Harness Runtime Layer 的 Agent Runtime
  ↓
Agent Runtime 识别 Project
  ↓
用户与 Agent Runtime 交互
  ↓
Planning Constraints 约束任务拆分、确认和执行边界
  ↓
Agent Core 理解需求、规划并执行工具调用
  ↓
Execution Constraints 约束代码修改、工具调用、验证和成功声明
  ↓
Lifecycle Hooks 捕获工具调用、文件变化、命令结果、测试结果和用户确认
  ↓
Harness Runtime Layer 同步维护 Runtime State / Task Tree / Trace / Artifact Graph
  ↓
基于事实执行 Evaluation
  ↓
沉淀 Experience / Skill / Failure Case
```

该流程中，用户输入进入的是 Agent Runtime，而不是先进入一个外部 Harness 再转发给 Agent。Agent Core 与 Harness Runtime Layer 在同一 Agent Runtime 中协同推进任务：Agent Core 负责理解、规划、交互和工具执行；Harness Runtime Layer 通过 Constraints 影响 Agent coding 方式，并通过 Lifecycle Hooks 同步维护长期状态、事实记忆、资产关系、结果评估和能力进化。

### 4.2 任务执行流程

```text
用户提出 coding 需求
  ↓
Agent 查询当前 Project 下已有 Task Tree 摘要
  ↓
Agent 分析并建议：新建 Task Tree / 归并到已有 Task Tree
  ↓
用户确认任务归属
  ↓
Agent 探索项目，并与用户讨论需求细节、边界、方案、接口和验收条件
  ↓
Planning Constraints 约束任务拆分、停止条件和确认边界
  ↓
Agent Core 形成完整 draft Task Tree、draft Artifact Graph 和各顶层分支的 Skeleton Acceptance Criteria
  ↓
Agent Runtime 展示 Task Tree 节点架构图并询问是否按计划执行
  ↓
用户确认整棵 Task Tree 或选定分支；Lifecycle Hooks 记录确认的 revision 和范围
  ↓
Agent Runtime 执行全部已确认范围的 Skeleton Pass；Lifecycle Hooks 同步维护 Trace / Artifact / Task Node
  ↓
Skeleton Gate 根据已确认的任务专属标准和 Hook 证据自动判断是否满足进入实现阶段的条件
  ↓
Agent Runtime 选择一个已确认分支，进入 Branch Deep Implementation 和 Branch Verification
  ↓
分支结果向父节点聚合，并继续下一个已确认分支
  ↓
所有已确认分支完成后执行父级或根级验证
  ↓
Evaluation 基于 Hooks 形成的事实判断根任务结果，并进入 Evolution 闭环
```

Lifecycle Hooks 贯穿任务归属、需求讨论、Task Tree revision、计划确认、Skeleton、分支实现、验证和完成阶段，而不是独立的事后记录步骤。在用户确认任务归属和执行计划前，Agent Core 可以读取项目、查询 Runtime State 并逐步提问，但不得执行会修改项目的任务节点。

### 4.3 Task Tree 归属、规划与确认流程

Agent 收到 coding 请求后，应先判断需求与已有 Task Tree 的关系，并将判断结果交给用户决定。Agent 不得静默归并任务。Task Tree 在执行计划确认前处于 draft 状态，可以被修改、重新生成或继续追问。用户可以确认整棵 Task Tree，也可以只确认其中一个或多个分支。

```text
coding request
  ↓
查询 Project 下已有 Task Tree 摘要
  ↓
Agent 推荐 new_tree / merge_into_existing_tree，并说明理由与影响范围
  ↓
用户确认任务归属
  ↓
Agent 讨论需求并生成完整 draft Task Tree
  ↓
用户审阅 Task Tree 节点架构图
  ├── 信息不足 → Agent Core 继续提问
  ├── 用户要求修改 → 生成新的 draft revision
  ├── 用户确认整棵树 → 全部计划范围进入可执行状态
  └── 用户确认选定分支 → 已确认分支进入可执行状态
                              ↓
                         Skeleton Pass
```

任务分支确认后，Agent Runtime 不应直接从叶子节点开始写代码。Agent Core 应先在已确认范围内执行 skeleton 节点，建立整体框架、模块边界、接口、入口和测试骨架；Harness Runtime Layer 同步维护节点状态、Trace 和 Artifact。Skeleton 完成后，Agent Runtime 再选择已确认分支进行深度实现，完成该分支的 implementation 节点和 verification 节点。父节点的状态由其子节点状态、Trace、Artifact 和 Evaluation 聚合得到。未确认分支不得被执行。

已确认 Task Tree 允许直接修改已有节点。每次结构修改都必须生成新 revision，并保留旧 revision、旧节点状态和旧执行证据。系统应根据父子关系、Task Relation Edges 和共享 Artifact 计算影响闭包：被修改节点与未完成的受影响子树回到 `pending_user_confirmation`；已经完成但受影响的节点标记为 `needs_revalidation`；未受影响节点保持原状态。受影响范围重新确认前不得继续执行其中会修改项目的任务节点。

```text
confirmed Task Tree revision
  ↓
直接修改已有节点并生成 new revision
  ↓
计算 affected nodes：子树 + relation edges + shared artifacts
  ↓
unfinished affected nodes -> pending_user_confirmation
completed affected nodes -> needs_revalidation
  ↓
用户重新确认 affected scope
  ↓
继续执行
```

### 4.4 任务与资产关联流程

```text
Task Node 执行
  ↓
读取 / 修改 / 创建 / 删除工程资产
  ↓
Trace Event 记录事实
  ↓
Artifact Graph 建立关联
  ↓
后续任务可查询资产历史
```

### 4.5 能力进化流程

```text
任务完成
  ↓
Evaluation 评估
  ├── 成功 → Experience → Skill 候选 → Skill
  └── 失败 → Failure Case L0 → 结构化人工复现 → 辅助 / 自动复现 → L4 回归案例
```

## 5. 功能需求

### 5.1 Project Path 管理

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-001 |
| 功能名称 | 项目路径归属管理 |
| 功能描述 | 系统应根据当前 Agent 运行目录确定任务归属空间。Claude 场景下使用 Claude 当前工作目录作为 Project 目录。 |
| 输入 | 当前 Agent 工作目录、用户显式指定路径、Git 仓库信息、`.agent-harness-project.json` Project Identity Marker |
| 处理 | 将当前工作目录规范化为 canonical_path，读取或创建 Project Identity Marker，在 Harness 公共数据库中识别、迁移或克隆 Project，并关联 Task Collection |
| 输出 | Project 标识、规范化路径、展示名称、identity resolution 结果 |
| 业务规则 | 同一物理目录不应因 Windows/WSL 路径差异被识别为多个 Project；当前阶段不默认向上查找 Git 仓库根目录覆盖当前目录；Project Path 是查询与展示范围的强隔离依据；项目目录中不得创建 `.harness` 作为 Runtime Records 存储；`.agent-harness-project.json` 只保存稳定身份，不保存 Runtime Records。 |

Project 解析顺序如下：

1. 精确读取当前 Project Root 下的 `.agent-harness-project.json`，不向父目录递归继承其他项目的 marker；
2. 使用 marker 中的 `project_id` 与 `identity_token` 查询公共数据库；
3. 当前路径与数据库中的 canonical_path 相同或属于已登记 Path Alias 时，解析为原 Project；
4. 当前路径不同且能够确定旧路径已不存在时，视为移动或重命名，保留 `project_id` 并更新 canonical_path；旧路径只是暂时不可访问或无法判断时返回 `identity_conflict`，不得自动迁移；
5. 当前路径不同且旧路径仍存在时，视为目录复制，创建新 Project 并启动 Project Clone；
6. marker 缺失时，根据当前路径和 Alias 识别已有 Project；仍无法识别时创建新 Project 与 marker。

### 5.2 Task Collection 管理

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-002 |
| 功能名称 | 项目任务集合管理 |
| 功能描述 | 一个 Project 下可以存在多个独立 Task Tree。 |
| 输入 | Project 标识、任务查询条件、任务创建事件 |
| 处理 | 创建、查询、归档、恢复 Task Tree |
| 输出 | Task Tree 列表、任务状态、任务摘要 |
| 业务规则 | Task Collection 归属于 Project，不归属于单次运行上下文；默认查询必须携带由当前 canonical_path 解析出的 project_id，不得返回其他 Project 的 Task Tree。 |

### 5.3 Task Tree 管理

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-003 |
| 功能名称 | 任务树管理 |
| 功能描述 | 系统应使用 Task Tree 表示 Agent 对一个独立目标的计划、拆解和执行顺序。Task Tree 首先是 Agent coding workflow 的约束结构，Runtime 中保存的是该 Workflow 执行后的结构化记录。 |
| 输入 | coding 请求、当前 Project 的已有 Task Tree 摘要、`/taskroot [任务名称]`、用户补充信息、任务约束、验收标准 |
| 处理 | 分析并请求用户确认新建或归并；创建根节点或更新已有节点；生成完整 draft Task Tree；维护 revision、父子关系、依赖关系和节点状态 |
| 输出 | Task Tree、节点状态、任务进度 |
| 业务规则 | 所有具有工程变更目标的 coding 请求必须进入 Task Tree Workflow；新建或归并必须由用户确认；`/taskroot [任务名称]` 用于显式强制新建并命名根任务；Task Tree 类似 OpenSpec 的 `tasks.md`，但以树/图结构表达；Task Tree 来源于 Agent 在 Workflow 约束下的规划判断，不是执行痕迹的反推结果，也不是外部系统分配给 Agent 的任务清单。 |

Task Tree 归属候选的检索流程如下：

```text
当前 Agent 工作目录
  ↓
规范化为 canonical_path
  ↓
在公共数据库中解析当前 Project
  ↓
只查询该 Project 的 Task Tree
  ↓
按显式 Tree ID / 名称、Artifact 路径、模块 / 符号、关键词、状态和更新时间确定性排序
  ↓
返回带匹配依据的候选摘要
  ↓
Agent 分析相关性并提出新建或归并建议
  ↓
用户最终决定
```

项目内 Task Tree 不超过 5 棵时，可以向 Agent 返回全部最小摘要；超过 5 棵时，默认最多返回 3 个候选。排序必须展示 `matched_by` 等可解释依据，不得只返回不透明的相关性分数。确定性检索只负责返回当前 Project 内的候选，不替代 Agent 的语义分析，也不替代用户的新建或归并决定。

### 5.4 Task Node 生命周期管理

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-004 |
| 功能名称 | 任务节点生命周期管理 |
| 功能描述 | 每个 Task Node 需要记录自身状态和状态变化依据。 |
| 输入 | 工具事件、Trace、子任务状态、验证结果、用户反馈 |
| 处理 | 根据事实事件推进状态 |
| 输出 | created、planned、pending_user_confirmation、ready、running、verifying、succeeded、needs_revalidation、blocked、blocked_by_unconfirmed_dependency、failed、cancelled、paused_after_clone 等状态 |
| 业务规则 | 节点成功不能只由 Agent 口头声明决定；修改已有节点必须生成新的 Task Tree revision；已完成节点受到新 revision 影响时应标记为 needs_revalidation，而不是删除原完成事实。 |

### 5.5 父子任务结构化通信

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-005 |
| 功能名称 | 父子任务通信 |
| 功能描述 | 父节点与子节点之间应通过结构化信息传递目标、上下文、结果和验证状态。 |
| 输入 | 父任务目标、子任务结果、Trace、Artifact、Evaluation |
| 处理 | 父节点下发子任务要求，子节点回传执行结果 |
| 输出 | 子任务报告、父任务聚合状态 |
| 业务规则 | 父节点状态应由子节点状态、Trace、Artifact 变更和 Evaluation 共同决定。 |

### 5.6 工具事件驱动记录

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-006 |
| 功能名称 | 工具事件驱动任务记录 |
| 功能描述 | 系统应根据统一工具事件和项目状态变化记录任务，而不是主要依赖 LLM 判断用户意图。 |
| 输入 | 工具调用、Shell 命令、文件变更、命令结果 |
| 处理 | 将事件分类为 read_only、mutation、verification、external_side_effect |
| 输出 | Trace Event、Task Node 状态变化、Artifact 关系 |
| 业务规则 | Task Node 在计划确认前由 Task Tree Workflow 创建或修改；mutation 是推进执行状态、生成 Trace 和更新 Artifact 的主要事实触发条件。 |

### 5.7 Agent Runtime Binding 管理

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-007 |
| 功能名称 | Agent Runtime Binding 管理 |
| 功能描述 | 系统应允许不同 Agent Runtime 通过 Agent Runtime Binding 绑定 Harness Runtime Layer。 |
| 输入 | Agent 私有事件、工具调用事件、运行上下文事件、文件变化事件、命令结果 |
| 处理 | 将 Harness Runtime Layer 绑定到 Claude、Codex、自研 Agent 等不同运行环境，并把环境内产生的事实事件规范化为统一 Runtime Event |
| 输出 | 统一 Agent Event、Tool Event、Run Event |
| 业务规则 | Agent Runtime Binding 不是 Agent 与 Harness 两个独立系统之间的中心通信层，而是不同 Agent Runtime 的兼容机制；MCP、Hook、CLI Wrapper、日志监听都只是不同 Agent Runtime Binding 的实现方式。 |

### 5.8 Skill 与工作流分发

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-008 |
| 功能名称 | Skill 与工作流分发 |
| 功能描述 | 系统应以类似 Superpowers 的方式，为不同 Agent 环境提供可安装、可组合、可触发的 Skills 和工作流规则。 |
| 输入 | Harness Skill、工作流规则、Agent Runtime Binding 能力、目标 Agent 环境 |
| 处理 | 将通用 Skill 或工作流转译、安装或暴露给对应 Agent |
| 输出 | Agent 可使用的 Skill、初始化指令、插件配置或运行时规则 |
| 业务规则 | Skill 和工作流不应绑定单一 Agent；不同 Agent 的安装方式可以不同，但语义应尽量保持一致。 |

### 5.9 Trace System

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-009 |
| 功能名称 | Trace 事实记忆层 |
| 功能描述 | 系统应将 Trace 作为 Agent Runtime 的事实记忆层，记录任务演化、工具调用、Artifact 变化、验证结果和用户反馈。 |
| 输入 | 用户请求、任务拆解、工具调用、文件读写、命令执行、验证结果、错误输出 |
| 处理 | 生成结构化 Trace Event，并关联 Task Node 与 Artifact |
| 输出 | 可查询、可引用、可评估、可沉淀的事实记忆链 |
| 业务规则 | Trace 不是聊天记录复制，也不是简单日志或审计系统；Trace 是追加式时间事实源，用于记录任务演化过程、关联工具调用、关联 Artifact 变化、支撑 Evaluation，并支撑后续 Experience、Skill 和 Failure Case 的抽象。已写入的事实事件不得被 Artifact 当前状态覆盖。 |

Trace Event 负责记录：

- 事件在何时、由哪个 Task Node、通过什么工具或用户决策发生；
- 文件或对象变化前后的 hash / version、diff 或证据引用；
- 命令输入摘要、输出摘要、退出状态和验证结果；
- Task Tree、Artifact 或 Runtime State 为什么发生变化。

Trace 不负责维护“当前完整工程资产图”。查询某个资产如何变化应读取 Trace；查询当前工程资产及关系应读取 Artifact Graph。

### 5.10 Artifact Graph

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-010 |
| 功能名称 | 工程资产图谱 |
| 功能描述 | 系统应记录项目中计划产生、计划修改、实际读取、实际修改、创建、删除、验证或依赖的工程资产。 |
| 输入 | Task Tree、Task Node、Agent 规划结果、Trace Event、文件变更、命令结果、测试结果 |
| 处理 | 在规划阶段根据 Task Tree Revision 生成 Draft Artifact Graph，在执行阶段将真实 Trace Event 投影为当前 Artifact 状态与关系，并建立 Artifact 与 Task Node、Trace Event 之间的引用 |
| 输出 | Artifact Graph、计划资产、实际资产、资产影响面、验证覆盖关系 |
| 业务规则 | Artifact Graph 不替代 Git，也不负责保存完整文件版本、工具输入输出或 diff；Artifact Graph 是可以从 planning revision 与 Trace Event 重建的当前工程状态投影，应与 Task Tree 同步演进，既表达计划阶段资产草案，也表达执行阶段事实资产。 |

Trace 与 Artifact Graph 的去重规则如下：

| 内容 | 唯一主记录位置 | 另一侧保存内容 |
| --- | --- | --- |
| 工具调用、命令执行、文件修改事件 | Trace Event | Artifact 保存 `last_trace_event_id` |
| before / after hash、diff、命令输出 | Trace Event 或外部 Evidence Blob | Artifact 只保存当前 hash / version 与 evidence ref |
| 当前资产身份、路径、类型和状态 | Artifact | Trace 引用 `artifact_id` |
| 当前接口、调用、依赖和验证关系 | Artifact Relation | Trace 记录关系形成或变化的事件 |
| 计划资产及计划关系 | Task Tree Revision + Artifact Graph | Trace 记录 planning decision / revision 事件 |

Artifact 状态或关系每次发生变化时，必须记录 `source_trace_event_id` 或 `source_planning_revision_id`。Trace 不复制完整 Artifact Graph；Artifact Graph 不复制完整事件历史。Artifact Graph 丢失时应能依据 planning revisions、Trace Events 和项目现状重建。

Artifact Graph 首版采用自适应三级粒度：

| granularity | 默认策略 | 典型 Artifact |
| --- | --- | --- |
| structural | 默认记录关键资产 | 目录、模块、package、文件、配置、命令、测试入口 |
| contract | 跨 Task Node 或跨分支时必须记录 | API、Interface、Schema、Event、Protocol、CLI Contract |
| symbol | 按需记录 | Function、Class、Method、Type、具体 Test Case |

Structural Artifact 不代表扫描并持久化项目全部文件。首版只记录 Task Tree 计划涉及、Agent 实际读取或变更、Skeleton 需要、任务验收使用或 Failure Case 关联的资产。

Symbol Artifact 只在以下条件之一成立时创建：

- 符号本身是 Task Node 的明确交付结果；
- 多个 Task Node 共同依赖或修改该符号；
- Failure Case 明确定位到该符号；
- Plan Drift 发生在具体符号边界；
- 验收或回归测试需要精确引用该符号。

首版不建设全项目 AST、完整符号索引或完整调用图。Artifact 可以通过 `parent_artifact_id` 形成 `module / directory → file → symbol` 层级；API 可以关联 Request Schema、Response Schema 和 Verification Test。逻辑 Contract Artifact 应具有稳定身份，不因文件移动自动生成新的契约实体。

Artifact Graph 的基础生命周期如下：

| artifact_status | 含义 |
| --- | --- |
| draft | Agent 在 draft Task Tree 阶段提出的资产草案，尚未确认 |
| planned | 所属任务分支被确认后，进入计划资产状态 |
| created | 执行过程中真实创建的资产 |
| modified | 执行过程中真实修改的资产 |
| verified | 已经被测试、构建、检查或用户确认验证的资产 |
| deprecated | 后续被废弃或替代的资产 |

跨 Task Node 的接口、数据结构、模块边界、命令、测试入口等约定，应优先建模为 Artifact，而不是引入独立的契约一级对象。多个 Task Node 可以通过不同关系共同指向同一个 Artifact：

```text
Task: 实现前端登录页面
  consumes -> Artifact: Login API

Task: 实现后端登录接口
  implements -> Artifact: Login API

Artifact: Login API
  uses_schema -> Artifact: LoginRequest
  returns_schema -> Artifact: LoginResponse
```

当用户确认某个 Task Tree 分支后，该分支关联的 `draft` Artifact 应自动晋升为 `planned`，作为执行阶段的计划基准。用户确认的是分支执行意图，不需要单独审批 Artifact Graph；但从这一刻开始，相关 Artifact Graph 草案应成为可追踪、可比较的计划对象。

执行过程中允许 Agent 根据真实项目情况细化、修正或扩展 Artifact Graph。如果实际工程资产与已确认的 `planned` Artifact 出现有意义偏移，系统应记录为 `plan_drift` Trace Event。Plan drift 不一定阻止执行，但必须可追踪，并应在验证或汇报阶段提示用户。

Artifact Drift 的典型场景包括：

- planned Artifact 未被创建、修改或验证；
- 实际创建了计划外的关键 Artifact；
- planned API、Schema、模块、命令或测试被另一个 Artifact 替代；
- Artifact 的职责、边界或关系发生明显变化；
- 原计划中某个 Task consumes / implements 的 Artifact 被转移到其他 Task 负责；
- 计划关系与实际关系明显不同，例如原计划复用某接口，实际执行中改为重新实现相同职责。

Plan Drift 的干预强度按 `severity` 分为三档：

| severity | 处理方式 | 典型场景 |
| --- | --- | --- |
| info | 只记录 Trace，不打断执行 | 新增辅助文件、文件名微调、多写工具函数、测试路径不同但覆盖目标不变 |
| warning | 继续执行，但在阶段汇报、分支 verification 或最终总结中提示 | 新增计划外关键 Artifact、planned Artifact 被等价替代、API 或 Schema 名称变化但语义不变、当前任务修改了其他分支相关资产 |
| blocking | 暂停当前 Task Node 或分支，生成 Drift Explanation 和 Agent 推荐方案，等待用户确认后继续 | 核心 API 或模块被替换、planned Artifact 被放弃、Artifact 职责根本变化、实际执行影响未确认分支、实际方案与用户确认目标不一致、需要删除或重写关键资产 |

`blocking` 不等同于失败，而表示当前执行已经偏离用户确认的计划基准，需要重新确认。出现 blocking drift 时，系统应暂停当前 Task Node 或分支，并要求 Agent 同时给出建议方案，而不是只向用户抛出问题。

blocking drift 的处理流程如下：

```text
检测到 blocking plan drift
  ↓
暂停当前 Task Node / 分支
  ↓
生成 Drift Explanation
  ↓
Agent 给出推荐处理方案
  ↓
等待用户确认
  ↓
根据用户选择更新 Task Tree / Artifact Graph / Drift 状态
```

用户可选择的处理方式包括：

- 接受新计划：更新 Task Tree 与 Artifact Graph，将 drift 标记为 accepted；
- 回到原计划：要求 Agent 撤回或调整当前实现方向，将 drift 标记为 rejected；
- 取消该分支：将分支状态改为 cancelled，将 drift 标记为 branch_cancelled。

### 5.11 Evaluation System

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-011 |
| 功能名称 | 结果评估系统 |
| 功能描述 | 系统应基于证据判断任务是否完成、完成质量如何、是否存在风险。 |
| 输入 | Task Node Revision、Execution Attempt、Trace、Artifact、验证结果、用户反馈、验收条件、required evidence |
| 处理 | 针对指定 revision 与 attempt 评估任务结果、证据覆盖和风险；由 Lifecycle Transition Policy 判断该 Evaluation 是否可以推进节点状态 |
| 输出 | succeeded、failed、blocked、uncertain 等不可变评估结论，以及适用性与证据覆盖信息 |
| 业务规则 | Evaluation 输出的是不可变评估事实，不直接等同于 Task Node 生命周期状态；每个 Evaluation 必须绑定 task_node_revision_id 与 execution_attempt_id；旧 revision、证据不完整或结果冲突的 Evaluation 不得把当前节点标记为成功。 |

Evaluation 与 Task Node 生命周期之间的关系如下：

```text
Trace / Artifact / Verification Evidence
  ↓
Evaluation Result（不可变事实）
  ↓
Lifecycle Transition Policy（确定性代码规则）
  ↓
Task Node Status（当前运行状态）
```

默认转换规则如下：

| Evaluation verdict | 附加条件 | Task Node 状态迁移 |
| --- | --- | --- |
| succeeded | revision 一致、required evidence 完整、依赖满足、无 blocking drift | `verifying → succeeded` |
| succeeded | evidence 不完整或父级集成验证未完成 | 保持 `verifying` |
| failed | 当前 execution attempt 验证明确失败 | `verifying → failed`；后续修复创建新 attempt |
| blocked | 存在外部依赖、未确认依赖或 blocking condition | 进入 `blocked` 或对应细分阻塞状态 |
| uncertain | 证据不足、结果冲突或 Oracle 无法判断 | 保持 `verifying` 并列出缺失证据 |
| 任意 verdict | Evaluation 属于旧 revision | 不推进当前状态；当前节点保持或进入 `needs_revalidation` |

Evaluation Result 不得覆盖。相同 Task Node 的重试必须创建新的 Execution Attempt，并保留完整序列，例如 `failed → failed → succeeded`，供 Evaluation 审计与 Evolution 判断使用。

父 Task Node 的状态不得仅由子节点状态聚合为成功。所有必要子节点完成后，仍需针对父级目标、跨分支契约和集成验收生成父级 Evaluation；只有父级 Lifecycle Transition Policy 通过后才能进入 `succeeded`。

### 5.12 Evolution System

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-012 |
| 功能名称 | 能力进化系统 |
| 功能描述 | 系统应将成功经验沉淀为 Experience 和 Skill，将失败案例沉淀为 Failure Case。 |
| 输入 | Evaluation Result、Execution Attempt 序列、Trace、Artifact、任务目标、验证结果、Skill Test Cases |
| 处理 | 提取经验、生成并冻结 Skill Candidate Revision、生成和验证测试案例、执行无 Skill baseline 与 Skill-enabled 对照、执行独立 Holdout、创建或更新 Failure Case 及其 Reproduction Revision |
| 输出 | Experience、Skill Candidate、Skill Validation Report、Failure Case、Reproduction Validation Result、可复现测试集 |
| 业务规则 | Evolution 的依据必须可追溯到 Trace 和 Evaluation；单次成功不能直接晋升为 Skill，必须在同一节点任务中经历 2 次及以上失败后成功，才可进入 Skill 候选；AI 生成测试不得由生成者的自然语言判断直接标记为有效或通过；Failure Case 是否可作为稳定 Replay 由 L0-L4 maturity 与独立验证结果决定。 |

Skill Test Case 必须满足 Test Case Quality Contract，至少包含：

- 来源 Failure / Requirement / Trace 引用；
- target behavior 与 applicable context；
- 可隔离的 setup、input 和清理方式；
- 明确 expected result 与独立 Oracle；
- reproduction command、timeout 和环境约束；
- test type、生成来源与质量验证状态。

每个 Skill Candidate 的验证集至少包含：

| test_type | 目的 |
| --- | --- |
| real_failure_replay | 重放形成该经验的真实失败案例 |
| variation | 改变输入、目录、局部条件或边界，防止只记住原案例 |
| holdout | Skill Candidate Revision 冻结后独立生成，用于检测过拟合 |
| negative_applicability | 验证不适用场景下 Skill 不误触发、不产生无关修改 |

AI 生成测试必须依次通过：

```text
Schema Validation
  ↓
Fixture Isolation
  ↓
Failure Reproduction
  ↓
Oracle Validation
  ↓
Discrimination Validation
  ↓
Stability Validation
  ↓
Holdout Classification
```

Oracle 应优先使用退出码、断言、Artifact 状态、Schema、diff 规则或明确结构化评分，不能只使用“由 AI 判断是否合理”。Discrimination Validation 必须证明正确行为可以通过，且故意破坏关键行为后测试会失败。测试不得依赖未声明的 API Key、用户本机状态或不稳定外部服务。

Skill Candidate Revision 冻结后，测试执行流程如下：

```text
真实任务至少两次失败后成功
  ↓
生成 Experience 与冻结的 Skill Candidate Revision
  ↓
构建 Replay / Variation / Negative Cases
  ↓
独立生成 Holdout Cases
  ↓
执行 No-Skill Baseline
  ↓
执行 Skill-Enabled Runs
  ↓
比较成功率、误触发率、风险、工具调用、token 与稳定性
  ↓
Promotion Policy 判断是否晋升
```

随机 Agent 执行默认至少重复三次；确定性测试的重复次数可由成本策略调整。精确成功率与收益阈值允许后续通过实验配置，但真实 Failure Replay、独立 Holdout、Negative Applicability、无高风险副作用以及测试自身稳定且具有区分能力必须作为硬门槛。

### 5.13 Execution Context 记录

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-013 |
| 功能名称 | 运行上下文记录 |
| 功能描述 | 系统应在 Trace Event 中记录事件发生时的运行环境元信息。 |
| 输入 | 运行标识、项目路径、Agent 类型、模型信息、工作目录、启动方式、环境信息 |
| 处理 | 将运行上下文作为 Trace Event 的元信息保存 |
| 输出 | 可用于审计、诊断、恢复和统计的 Execution Context |
| 业务规则 | Execution Context 不拥有任务，不参与任务生命周期，不作为一级核心业务对象。 |

### 5.14 查询与审计

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-014 |
| 功能名称 | 查询与审计 |
| 功能描述 | 用户应能查看任务树、任务状态、Trace、Artifact 影响面、Evaluation 结论和沉淀结果。 |
| 输入 | Project、Task、Artifact、Execution Context、时间范围等查询条件 |
| 处理 | 以 Task Tree 为导航骨架，按当前 Task Node 聚合 Artifact、Trace、Evaluation、Failure / Evolution，并通过 Snapshot、Summary、Detail 渐进披露 |
| 输出 | Task Tree Summary、Node Context、Artifact Impact、Trace Timeline、Evaluation Evidence、Failure / Evolution Detail |
| 业务规则 | 用户默认优先查看 Task Tree；Artifact、Trace、Evaluation 不是平级且割裂的默认入口，而是当前任务节点的上下文与证据视图。查询结果应支持双向跳转，并避免默认加载完整 Trace 或全项目 Artifact Graph。 |

展示层级与 Runtime Introspection Tools 对应如下：

| 展示层 | 默认内容 | 工具粒度 |
| --- | --- | --- |
| Tree Summary | 树结构、状态、execution phase、确认状态、阻塞、Drift、Artifact 数量、Evaluation 与 Evidence 摘要 | Snapshot |
| Node Context | 当前节点 Overview、Plan / Decisions、Artifacts、Activity / Trace、Evaluation、Failure / Evolution | Summary |
| Evidence Detail | 完整关系、diff、命令输出、Trace Event、Evaluation evidence 和 Execution Context | Detail |

Task Tree 节点默认只展示最小充分信息，不直接展开完整证据。节点至少可以显示状态、execution phase、confirmation status、阻塞或 Drift 标记、Artifact 变化数量、最新适用 Evaluation verdict 和 evidence coverage。

Artifact 辅助视图默认限定当前节点或分支，优先对比 planned 与 actual，并展示 Contract 缺失、Drift 和共享资产；只有用户主动切换时才展示全项目 Artifact Graph。

Trace 辅助视图默认按 Execution Attempt 与 Workflow Stage 聚合为时间线，并隐藏重复读取等低价值事件；完整工具输入输出、diff、stdout / stderr 和 Execution Context 只在 Detail 层展开。

Evaluation 辅助视图必须展示 verdict、task node revision、execution attempt、required evidence coverage、missing evidence 和 Lifecycle Transition Policy 结果，而不是只显示红绿状态。

视图之间必须支持从 Task Node 到 Artifact，从 Artifact 返回相关 Task Node，从 Evaluation 到证据 Trace，从 Trace 到变化 Artifact，以及从 Failure Case 返回来源 Attempt 和 Task Node。图形 UI、CLI 和 Agent 对话可以采用不同呈现形式，但必须保持相同的信息层次。

### 5.15 Task Tree 生成与确认

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-015 |
| 功能名称 | Task Tree 生成与确认 |
| 功能描述 | Agent 收到 coding 请求后，应先让用户决定新建或归并 Task Tree，再生成完整初始 draft，并通过问题驱动的局部精炼循环将待确认范围推进到 Plan Ready；用户确认执行计划后才进入对应范围的执行阶段。 |
| 输入 | coding 请求、已有 Task Tree 摘要、任务归属选择、用户补充信息、项目上下文、约束条件、验收要求 |
| 处理 | 推荐新建或归并并请求用户确认；生成全量初始任务树；执行 Plan Readiness Scan；Agent 按影响优先级推荐下一项讨论；根据用户回答生成局部 Draft Change Set 与 revision；判断叶子节点；生成 Skeleton Acceptance Criteria；展示达到 Plan Ready 的树或分支并等待确认 |
| 输出 | draft / partially confirmed / confirmed Task Tree |
| 业务规则 | 初始全量 Task Tree 是讨论工作底稿，不等同于可执行计划；精炼采用“Agent 推荐下一题、用户可随时点名其他范围”的混合方式；用户确认任务归属和执行计划前不得执行会修改项目的任务节点；确认后不应直接从叶子节点开始写代码，而应先进入已确认范围内的 skeleton 阶段；确认范围关联的 draft Artifact 应自动晋升为 planned；已确认节点允许直接修改，但必须形成新 revision，并重新确认受影响范围。 |

分支确认与 Artifact Graph 的关系如下：

```text
coding request
  ↓
用户确认新建 Task Tree / 归并到已有 Task Tree
  ↓
Agent Core 规划；Harness Runtime Layer 形成 draft Task Tree + Draft Artifact Graph + Skeleton Acceptance Criteria
  ↓
Plan Readiness Scan + 问题驱动的局部精炼循环
  ↓
待确认范围达到 Plan Ready
  ↓
用户按分支确认
  ↓
该分支 Task Node: approved
相关 Artifact: draft -> planned
  ↓
执行过程中 Harness Runtime Layer 持续维护 Artifact Graph
  ↓
如果实际资产偏离 planned Artifact
同步形成 plan_drift Trace Event
  ↓
验证与汇报时展示偏移
```

用户确认分支时，不需要额外逐项确认 Artifact Graph。Artifact Graph 的计划态是该分支的工程资产基准，用于后续执行对比、偏移记录、验证覆盖和结果汇报。

已确认分支发生结构修改时：

- 系统应创建新的 Task Tree revision，并保留旧 revision；
- 系统应基于父子关系、Task Relation Edges 和共享 Artifact 计算受影响节点闭包；
- 被修改节点和未完成的受影响节点状态回到 `pending_user_confirmation`；
- 已完成但受影响的节点状态变为 `needs_revalidation`，同时保留原完成证据；
- 未受影响节点保持原状态；
- 正在执行且被影响的 Task Node 应暂停；
- 受影响范围重新确认后才能继续执行其中会修改项目的任务节点。

同一 Task Tree 允许不同分支处于不同确认状态：

- `confirmed` / `approved`：允许进入后续调度；
- `running`：已确认且当前正在执行；
- `pending_user_confirmation`：结构已形成但等待用户确认；
- `draft`：仍在规划或讨论；
- `needs_revalidation`：曾经完成，但被新 revision 影响；
- `rejected`：用户拒绝，保留历史但不参与调度。

父节点存在已确认和未确认子分支时，聚合确认状态为 `partial_confirmed`。调度器只选择已确认、`ready` 且依赖已满足的节点。若已确认节点依赖未确认节点，则该节点进入 `blocked_by_unconfirmed_dependency`，直到依赖节点被确认并满足，而不是绕过依赖或隐式确认依赖分支。

叶子节点停止拆分的基础条件如下：

- 粒度应为目标级任务，而不是单个工具操作，也不是纯验收结果；
- 目标清晰，不需要进一步解释才能执行；
- 输入、输出和验收标准明确；
- 可以由 Agent 在一个相对独立的执行单元内完成；
- 可以通过 Trace、Artifact 或 Evaluation 证明完成情况；
- 不包含多个互相独立的大目标；
- 继续拆分不会显著提升可执行性或可验证性。

叶子节点判定采用以下责任分工：

```text
Agent 判断目标在语义上是否内聚
  ↓
生成 Leaf Task Contract
  ↓
代码执行结构硬校验
  ↓
用户随完整 Task Tree 确认最终边界
```

Leaf Task Contract 至少应包含 `objectives`、`expected_outputs`、`acceptance_criteria`、`unresolved_questions`、`unresolved_decisions`、`dependencies`、`required_evidence`、`execution_phase` 和 `stop_decomposition_reason`。代码应执行以下规划阶段硬校验：

```text
objectives.length == 1
AND expected_outputs.length >= 1
AND acceptance_criteria.length >= 1
AND unresolved_questions.length == 0
AND unresolved_decisions.length == 0
AND dependencies 全部指向有效节点
AND required_evidence.length >= 1
AND execution_phase 已定义
AND stop_decomposition_reason 已填写
AND children.length == 0
```

上述硬校验只能证明节点结构完整，不能证明 `objectives[0]` 在自然语言语义上确实只包含一个工程目标。Agent 负责语义内聚性判断；代码可以对“并且”“以及”“同时”“and”等并列词、多模块跨度和模糊验收条件产生警告，但不得把启发式规则当作语义真值。

`required_evidence` 属于规划阶段，表示任务完成时必须提供哪些证据；`completion_evidence` 属于执行阶段，表示实际获得了哪些证据。节点只有在验收条件通过，且 `completion_evidence` 覆盖全部 `required_evidence` 后，才能进入 succeeded 状态。

目标级叶子节点示例：

```text
定位登录失败原因
修复 token 解析逻辑
补充登录回归测试
运行登录相关验证
```

不推荐作为叶子节点的粒度：

```text
读取 src/auth/login.ts        # 过细，属于工具操作或 Trace
让所有认证测试通过          # 过抽象，属于验收结果
修复登录 Bug 并补测试并更新文档 # 包含多个并列目标
```

如果一个节点仍然目标模糊、包含多个独立目标、验收方式不清楚、依赖条件不明确或风险较高，则不应作为叶子节点，应继续拆分或向用户提问。

叶子节点只表示“无需继续拆分的目标级执行单元”，不表示代码执行必须从叶子开始。实际执行仍需遵守 skeleton → implementation → verification 的阶段顺序。

### 5.16 骨架优先、分支深度执行

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-016 |
| 功能名称 | 骨架优先、分支深度执行 |
| 功能描述 | 系统应先在已确认范围内搭建整体骨架，再按分支深度实现和验证。 |
| 输入 | 已确认 Task Tree 分支、Task Node、execution_phase、depends_on、Skeleton Acceptance Criteria、Hook 事实证据、节点状态 |
| 处理 | 先执行已确认范围内的 skeleton 节点；通过 Skeleton Gate 校验所有顶层分支的任务专属完成标准；Gate 通过后再选择分支深度执行 implementation 与 verification 节点 |
| 输出 | 分阶段执行结果、节点状态、Trace、Artifact、Evaluation |
| 业务规则 | 只允许调度已确认范围中依赖已满足的节点；未确认分支不参与执行调度；不得跳过上层 skeleton 或仅凭 Agent 声明进入 implementation；Skeleton Gate 默认根据已确认标准和 Hook 证据自动判断，只有失败、出现 blocking Drift 或无法判断时才请求用户处理。 |

`execution_phase` 的取值如下：

| execution_phase | 含义 | 示例 |
| --- | --- | --- |
| skeleton | 骨架任务，定义结构、边界和入口 | 创建目录结构、定义接口、建立测试入口、配置基础文件 |
| implementation | 实现任务，完成具体功能逻辑 | 实现加载器、实现 Runtime Binding、补充错误处理、实现数据结构 |
| verification | 验证任务，检查结果是否满足目标 | 运行测试、构建检查、回归验证、验收确认 |

默认调度规则如下：

```text
1. 在所有已确认分支范围内执行 skeleton 节点
   - 只执行 depends_on 已完成的 skeleton 节点
   - 建立目录、接口、模块边界、测试入口或配置骨架

2. 执行 Skeleton Gate
   - 检查每个顶层分支的 Skeleton Acceptance Criteria
   - 检查关键 Artifact、共享接口、数据结构和调用边界是否就绪
   - 检查基础构建、类型检查或等价结构验证是否通过
   - 检查 Lifecycle Hooks 是否存在对应文件、命令和验证证据
   - 检查是否存在未处理的 blocking Drift

3. 选择一个已确认分支进行深度实现
   - 执行该分支下 depends_on 已满足的 implementation 节点
   - 每个节点执行过程中同步维护 Trace、关联 Artifact、必要时触发 Evaluation

4. 执行该分支的 verification 节点
   - 验证该分支是否满足验收标准
   - 将结果聚合到父节点

5. 继续下一个已确认分支

6. 所有已确认分支完成后，执行父级或根级 verification
```

每个顶层功能分支的 `Skeleton Acceptance Criteria` 至少应包含：

- `expected_artifacts`：预期创建或确认存在的目录、模块、接口、Schema、测试入口和配置；
- `required_contracts`：跨分支共享的接口、数据结构、调用边界和依赖约定；
- `verification_commands`：用于证明骨架可加载、可构建或可类型检查的命令；
- `readiness_conditions`：进入分支实现前必须满足的结构性条件。

Skeleton Gate 的默认通过条件如下：

```text
所有已确认顶层分支 skeleton_ready
  AND 关键 Artifact 与共享契约已就绪
  AND 基础结构验证通过
  AND Hook 证据完整
  AND 无未处理的 blocking drift
  ↓
Skeleton Pass = completed
  ↓
允许进入 Branch Implementation
```

Skeleton 阶段不要求全部业务功能测试通过。采用测试先行时，尚未实现功能对应的测试可以处于“已创建且预期失败”状态，但项目的基础构建、类型检查、测试发现与加载过程必须正常，预期失败必须被显式标注并关联相应 implementation 节点。

可执行节点需要同时满足：

- 所属分支已被用户确认；
- 节点状态为 ready；
- 节点 `execution_phase` 符合当前调度阶段；
- 所有 `depends_on` 节点已经完成；
- 节点没有被阻塞、取消或标记为等待用户确认。

该策略不是简单广度优先，也不是简单深度优先，而是以工程开发习惯为导向：先建立整体框架、边界、接口和入口，再按分支深入实现目标级任务，最后按分支和父级逐步验证。

### 5.17 Task Relation Edges

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-017 |
| 功能名称 | 任务节点关系边 |
| 功能描述 | 系统应在 Task Tree 内部维护 Task Relation Edges，用于表达不同 Task Node 之间的执行依赖、调用关系、数据交换和协作关系。 |
| 输入 | Task Node、关系类型、目标 Task Node、关联 Artifact、关系说明 |
| 处理 | 在 Task Tree 内部维护 relation_edges，供任务调度、资产一致性检查、跨分支协作和集成验证使用 |
| 输出 | Tree-first 关系摘要、节点一跳关系、按需 Relation Overlay、关联 Artifact 引用与缺失告警 |
| 业务规则 | Task Relation Edges 是 Task Tree 的内部关系层，不是独立于 Task Tree 的另一套图结构；默认不绘制全部关系边，只直接提示阻塞、高风险、未确认依赖、关系循环和 Contract 缺失。 |

Task Tree 由三类关系共同构成：

```text
Task Tree
├── Task Nodes
├── Tree Edges          # 父子关系：表达任务归属与拆解层级
└── Relation Edges      # 节点关系：表达依赖、调用、数据交换和协作
```

`parent_id` 回答“这个节点属于哪个父任务”；`relation_edges` 回答“这个节点和哪些其他节点需要交互”。

Task Relation Edge 的基础类型如下：

| relation_type | 含义 | 示例 |
| --- | --- | --- |
| depends_on | 执行依赖，当前节点必须等待目标节点完成 | 实现功能前必须先完成接口定义 |
| calls | 运行时调用关系，当前节点负责的能力会调用目标节点负责的能力 | 前端登录表单调用认证 API |
| exchanges_data_with | 数据交换关系，两个节点需要共享输入、输出或数据结构 | 支付模块与订单模块交换订单状态 |
| shares_artifact_with | 共享工程资产关系，两个节点共同围绕同一个接口、Schema、协议、模块、测试或命令协作 | Claude Binding 与 Codex Binding 共同关联 AgentRuntimeBinding 接口 Artifact |
| coordinates_with | 协作关系，两个节点需要保持行为一致，但不一定存在强执行先后 | CLI 命令与文档说明需要保持一致 |

关系边不直接承载详细接口或数据结构定义。计划阶段的轻量节点关系应记录在 Task Relation Edges 中；接口、Schema、模块、测试、命令等具体约定应记录为 Artifact Graph 中的计划态 Artifact。两者通过 Task Node 与 Artifact 的关联产生连接。

关系边的展示采用三级策略：

1. 默认 Task Tree 只显示父子结构，并在节点旁展示关系数量与阻塞 / 风险标记；
2. 选择某个 Task Node 时展示其一跳入边、出边和关联 Artifact；
3. 用户主动开启 Relation Overlay 时展示当前树或范围内的完整关系，并支持按 relation type、方向、branch、状态和 Artifact 过滤。

CLI 与 Agent 对话中的 Snapshot 只显示阻塞关系，Summary 显示当前节点一跳关系，Detail 才返回完整关系和 Artifact 证据。

Task Relation Edge 对 Artifact 的要求如下：

| relation_type | Artifact 要求 | 规则 |
| --- | --- | --- |
| calls | 强制 | 必须关联 API、Interface、Function、Command、Event 等可调用 Artifact；source 为 caller / consumer，target 为 provider / implementer |
| exchanges_data_with | 强制 | 必须关联 Schema、Event、Protocol 或其他数据 Contract Artifact |
| shares_artifact_with | 强制 | 必须由两侧节点共同引用同一个 Artifact，不得创建两个同名副本 |
| depends_on | 条件强制 | 依赖具体交付物时必须关联 Artifact；仅表达执行顺序时可以不关联 |
| coordinates_with | 条件强制 | 依赖共同配置、规范、Contract 或测试时必须关联；纯行为协作可以只写关系说明 |

在 Task Tree Refinement 阶段，强制关系可以暂时指向 `draft` 占位 Artifact，但相关范围进入 Plan Ready 前必须满足：

```text
calls OR exchanges_data_with OR shares_artifact_with
  ↓
artifact_ref 存在
AND Artifact identity / type 明确
AND provider / consumer 或共享责任明确
AND 验证方式已定义
```

`depends_on` 与 `coordinates_with` 是否需要 Artifact 应由结构规则根据 `dependency_kind` / `coordination_kind` 判断，不交给 Agent 任意省略。多个 Relation Edge 可以共享同一个 Artifact，不要求每条边创建独立 Artifact。

### 5.18 User Change Request

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-018 |
| 功能名称 | 用户变更请求 |
| 功能描述 | 系统应识别并记录用户在 Task Tree 分支已确认或执行过程中主动提出的目标、范围、优先级、Artifact、验收标准或执行顺序变更。 |
| 输入 | 用户消息、当前 Task Tree、当前执行节点、关联 Artifact、当前调度状态 |
| 处理 | 判断变更类型，记录 User Change Request，根据影响范围更新 Task Tree、Artifact Graph 或调度队列 |
| 输出 | User Change Request Record、Trace Event、更新后的 Task Tree / Artifact Graph / 调度状态 |
| 业务规则 | 用户主动变更计划不应归类为 Plan Drift；Plan Drift 表示 Agent 执行偏离计划，User Change Request 表示用户主动修改计划。 |

User Change Request 的基础类型如下：

| change_type | 含义 | 处理方式 | 示例 |
| --- | --- | --- | --- |
| minor_change | 小修正，不改变任务目标和执行范围 | 记录 Trace，更新相关 Task Node 或 Artifact，继续执行 | 文案调整、文件命名偏好、补充一个边界测试、UI 细节微调 |
| scope_change | 范围变化，会影响当前分支计划、Artifact 或验收标准 | 暂停相关 Task Node，生成 Change Impact，更新 Task Tree / Artifact Graph 草案，请求用户确认后继续 | 不做验证码、接口路径改为 `/api/auth/login`、新增登录方式、删除 planned Artifact |
| priority_change | 优先级或执行顺序变化，不一定改变任务内容 | 更新调度队列，保留当前节点状态，切换执行目标 | 暂停当前分支先做另一个分支、先跑测试、先整理文档 |

User Change Request 与 Plan Drift 的边界如下：

```text
Plan Drift:
  Agent 执行过程中偏离已确认计划

User Change Request:
  用户主动修改已确认计划
```

如果用户输入发生在 confirmed branch 执行期间，并且影响目标、范围、Artifact、验收标准、优先级或执行顺序，系统应记录为 User Change Request。

scope_change 的处理流程如下：

```text
用户提出 scope_change
  ↓
暂停相关 Task Node
  ↓
生成 Change Impact
  ↓
更新 Task Tree / Artifact Graph 草案
  ↓
等待用户确认变更后的计划
  ↓
继续执行或调整分支状态
```

priority_change 的处理流程如下：

```text
用户提出 priority_change
  ↓
保留当前 Task Node 状态
  ↓
更新调度队列
  ↓
切换到新的执行目标
```

### 5.19 Runtime Interaction Loop

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-019 |
| 功能名称 | Runtime 交互循环 |
| 功能描述 | 系统应将用户输入处理设计为 Agent Runtime 内生的交互循环，而不是 Agent 外部的输入路由器。 |
| 输入 | 用户输入、Runtime State、Runtime Native Command、Runtime Introspection Tool 结果、用户确认结果 |
| 处理 | 用户输入进入 Agent Runtime；slash command 使用 Runtime Native Commands 直接处理；自然语言由 Agent Core 自行理解；需要改变 Runtime State 时，Agent 生成结构化 Runtime Action；代码依据 action type、目标 revision 与 Safety Rules 决定直接提交、拒绝或创建 Runtime Confirmation Prompt |
| 输出 | Agent 回复、Runtime State 更新、Trace Event、Task Tree / Artifact Graph 更新、Runtime Confirmation Prompt 或用户确认结果 |
| 业务规则 | 不应设计外部输入拦截器；不应每轮预注入完整运行时上下文；自然语言理解是 Agent 基础能力，但 Agent 的语言判断不能绕过代码层状态提交规则；Runtime 只提供原生命令、状态自省工具、结构化 Runtime Action、确认交互和安全规则。 |

Runtime Interaction Loop 的结构如下：

```text
用户输入
  ↓
Agent Runtime
  ├── Agent Core
  │   ├── Natural Language Understanding
  │   ├── Reasoning / Planning
  │   └── Tool Execution
  └── Harness Runtime Layer
      ├── Runtime Native Commands
      ├── Harness Runtime Skill
      ├── Runtime Introspection Tools
      ├── Runtime Confirmation Prompt
      └── Runtime State Safety Rules
  ↓
Agent 继续回复 / 规划 / 执行 / 等待确认
```

自然语言与状态提交的边界如下：

```text
用户自然语言
  ↓
Agent Core 理解、推理并提出 Runtime Action
  ↓
代码校验 action schema / target / expected_revision / Safety Rule
  ├── 低风险且已授权 → 原子提交
  ├── 必须确认 → 创建 Runtime Confirmation Prompt
  ├── revision 冲突 → 拒绝并要求重新读取状态
  └── 非法动作 → 拒绝并记录 Trace
```

#### Runtime Native Commands

Runtime Native Commands 是 Agent Runtime 暴露的原生命令能力，类似 Claude Code 中的 `/model`、`/resume`、`/rename`。它们不是普通自然语言，也不需要 LLM 判断。

示例命令包括：

```text
/taskroot [任务名称]       # 创建新的 Task Tree 根任务
/status                  # 查看当前 Runtime State、Task Tree、执行状态
/pause                   # 暂停当前执行
/resume                  # 恢复执行或恢复历史上下文
/approve branch [id]     # 确认分支
/reject branch [id]      # 拒绝分支
/cancel branch [id]      # 取消分支
```

Runtime Native Commands 应通过命令注册表进行处理，并直接进入对应 Runtime Flow。自然语言输入不应伪装成 slash command；未注册命令应提示用户而不是交给 LLM 猜测执行。

#### Harness Runtime Skill

Harness Runtime Skill 是 Agent 使用 Harness Runtime Layer 能力的行为规范入口。它不是 Harness Runtime Layer 本身，也不是 Agent 与 Harness 之间的通信桥梁；它用于让 Agent 在任务规划、执行、状态查询、Drift 和确认场景中以正确方式使用 Runtime Layer。

Harness Runtime Skill 不依赖外部提示词手动提醒，而应通过 Skill 自身的 description / trigger rules 被 Agent 环境发现和加载。

Harness Runtime Skill 的触发条件应覆盖以下场景：

- 处理 coding 请求的 Task Tree 归属判断、draft Task Tree 规划、问题驱动精炼或 `/taskroot` 后的任务拆解；
- 执行 confirmed branch；
- 判断用户输入是普通聊天、User Change Request、追加 Task Node、确认回复还是 Drift Resolution；
- 处理 Plan Drift、Artifact Drift、blocking drift；
- 等待分支确认、Drift Resolution 或 Change Confirmation；
- 需要当前 Runtime State、Task Tree、Artifact Graph、等待事项或可用 Runtime Actions。

Harness Runtime Skill 应使 Agent 在相关场景中遵守以下运行时工作方式：

- 不要凭记忆猜当前任务状态；
- 判断什么时候需要查询 Runtime State；
- 按 Task Tree 的生命周期规则处理任务规划、分支确认和执行状态；
- 按 Drift 规则处理计划偏移和用户变更；
- 需要任务、分支、Artifact、Drift 或等待确认信息时，使用对应 Runtime Introspection Tools；
- 遇到高风险状态变化时，按 Runtime State Safety Rules 触发 Confirmation Flow；
- 用户确认后，由 Agent 继续推进对应 Runtime Flow。

Harness Runtime Skill 的 description 应遵循 Skill 规范，使用明确的触发条件，例如：

```yaml
description: Use when handling Harness Runtime tasks, including task tree planning, confirmed branch execution, user change requests, plan drift, artifact drift, branch confirmation, runtime state lookup, pending confirmation handling, or deciding whether to call Runtime Introspection Tools.
```

#### Runtime Introspection Tools

Runtime Introspection Tools 是 Agent 按需查询运行时状态的工具集合。默认不向每轮自然语言输入注入完整 Runtime State、Task Tree、Artifact Graph 或 Trace；只有 Agent 判断需要运行时信息时，才使用这些工具。

Runtime Introspection Tools 的目的如下：

- 让 Agent 在需要时主动查看自己当前所处的 Harness Runtime 状态；
- 避免 Agent 凭记忆猜测当前任务、分支、Artifact、Drift 或等待确认项；
- 避免每轮预注入大量上下文；
- 支持 User Change Request、Plan Drift、Runtime Confirmation Prompt 等流程的事实判断；
- 支持将 Agent 决策前查询过的状态纳入 Trace。

Runtime Introspection Tools 应按三档粒度设计：

| 工具档位 | 目的 | 返回内容 | 示例 |
| --- | --- | --- | --- |
| Snapshot | 快速了解当前运行时位置 | 极短状态摘要，如 Runtime State、当前 Project、当前任务、等待事项、可用动作 | `get_runtime_snapshot()` |
| Summary | 获取某个对象或范围的中等粒度摘要 | Task Tree 摘要、Artifact Graph 摘要、Plan Drift 摘要、User Change Request 摘要 | `get_task_tree_summary(task_tree_id)`、`get_artifact_graph_summary(task_node_id)` |
| Detail | 仅在需要证据或完整细节时使用 | 单个 Task Node、Artifact、Trace Event、Plan Drift 的详细信息 | `get_task_node_detail(task_node_id)`、`get_trace_events(query)` |

推荐调用顺序如下：

```text
先查 Snapshot
  ↓
如果需要任务或资产上下文，再查 Summary
  ↓
如果需要证据、诊断或完整记录，再查 Detail
```

工具设计规则：

- 默认返回摘要，不返回完整历史；
- 任何可能返回大量数据的工具必须支持 `limit`、`cursor`、`filter`；
- Detail 工具应面向单个对象或明确查询条件，不应无条件返回全量 Trace；
- Agent 不需要运行时事实时，不应调用 Runtime Introspection Tools。

示例工具包括：

```text
get_runtime_snapshot()
get_task_tree_summary()
get_plan_readiness(scope_id)
get_recommended_planning_issue(scope_id)
get_artifact_graph_summary()
get_waiting_items()
get_available_runtime_actions()
get_plan_drift_summary()
get_user_change_requests()
get_task_node_detail(task_node_id)
get_artifact_detail(artifact_id)
get_trace_events(query)
```

#### Runtime Confirmation Prompt

Runtime Confirmation Prompt 是 Agent Runtime 的原生确认交互能力。当 Agent 判断某个动作需要用户确定性选择时，应像 Claude 类工具一样向用户发起确认问题，并提供明确选项。

示例：

```text
这个变更会把 planned API 从 POST /api/login 改为 POST /api/auth/login。

是否更新计划并继续？

- Yes，更新计划并继续
- No，保持原计划
- Pause，暂停该分支
```

用户选择后，Agent 应根据选择继续推进 Runtime Flow，例如记录 User Change Request、更新 Task Tree、更新 Artifact Graph、继续执行或暂停分支。

#### Runtime State Safety Rules

Runtime State Safety Rules 只规定哪些高风险状态变化必须向用户确认，不替代 Agent 的自然语言判断，也不作为外部审查器存在。

以下状态变更必须经过明确命令、明确确认语句或二次确认：

- 创建新的 Task Root；
- 确认或拒绝 Task Tree 分支；
- 取消分支；
- 删除或放弃 planned Artifact；
- 接受 blocking Plan Drift；
- 应用 scope_change；
- 执行可能影响未确认分支的变更；
- 执行不可逆或高风险操作。

以下动作默认不重复确认：

- 查询 Runtime State、Task Tree、Artifact 或 Trace；
- 解释当前状态或生成建议；
- 在尚未确认的 draft 范围内执行不跨分支的局部编辑；
- 记录工具事实、验证结果和 Trace Event；
- 在用户已授权范围内推进普通 running / verifying 状态；
- 创建尚未激活的 candidate revision。

所有由自然语言触发的状态变更必须先形成 Runtime Action，至少包含 `action_type`、`target_id`、`expected_revision`、`reason`、`source_message_ref` 和 `risk_level`。Safety Rules 判断的是结构化动作，不重新判断用户整句话的语义。

“可以”“继续”“就这样”等短回复只有在当前存在唯一 pending Runtime Confirmation Prompt 时，才能绑定该 Prompt。存在多个待确认项时，Agent 必须询问用户具体选择；不存在待确认项时，该回复不得产生新的修改授权。

Safety Rules 的原则如下：

```text
Agent 可以判断用户意图；
Safety Rules 只规定必须确认的高风险状态变化；
需要确认时，通过 Runtime Confirmation Prompt 让用户做确定性选择。
```

如果 Agent 判断用户可能想进行关键状态变更，但表达不够明确，应发起 Runtime Confirmation Prompt 或澄清问题，而不是直接执行。

### 5.20 Skills / Workflows

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-020 |
| 功能名称 | Skills / Workflows |
| 功能描述 | 系统应通过 Skills 和 Workflows 约束并帮助 Agent 完成 coding task。Skills 提供场景化行为规则，Workflows 提供完整任务的阶段编排。 |
| 输入 | 用户目标、项目上下文、当前 Workflow State、Task Tree、Runtime Records |
| 处理 | 根据任务场景触发对应 Skill，并由 Workflow State Machine 推进阶段 |
| 输出 | 当前阶段规则、允许动作、禁止动作、下一步转移条件、Task Tree / Runtime Record 更新 |
| 业务规则 | Skill 是局部能力入口，Workflow 是端到端阶段编排；二者不应混同。Task Tree Workflow 应采用 Workflow-first、Runtime-recorded 的设计。 |

首版建议内置 Skills：

| Skill | 触发场景 | 主要职责 |
| --- | --- | --- |
| task-tree-planning | 用户提出 coding task、`/taskroot`、需要任务拆解或精炼 | 生成完整初始 draft Task Tree，执行问题驱动局部精炼与 Plan Readiness Scan，判断叶子节点并请求用户确认就绪分支 |
| branch-execution | 用户确认分支后进入执行 | 按 skeleton → implementation → verification 推进分支 |
| verification-reporting | 节点、分支或根任务需要验收 | 汇总 Trace、Artifact、Evaluation 并生成结果报告 |
| drift-handling | 实际执行偏离 planned Artifact 或 confirmed branch | 解释偏移、生成建议、必要时请求用户确认 |

首版建议内置 Workflow：

```text
coding-task-workflow
├── intake
├── task_affiliation_confirmation
├── draft_task_tree
├── task_tree_refinement
├── branch_confirmation
├── skeleton_pass
├── skeleton_gate
├── branch_implementation
├── branch_verification
├── root_verification
└── final_report
```

Task Tree 在该设计中首先是 Workflow 约束形式，而不是外部调度系统。Runtime 中保存的 Task Tree 是 Workflow 执行后的结构化记录。

### 5.21 Workflow State Machine

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-021 |
| 功能名称 | Workflow State Machine |
| 功能描述 | 系统应维护当前 coding workflow 的状态机，用于确保 Agent 按阶段执行，并为 Hooks 提供行为校验依据。 |
| 输入 | Workflow、当前阶段、用户确认、工具事件、Task Node 状态、Runtime Actions |
| 处理 | 维护 current_workflow、current_stage、allowed_actions、forbidden_actions、transition_rules，并根据事件推进或阻止状态迁移 |
| 输出 | Workflow State、允许动作、禁止动作、下一阶段、违规事件或确认请求 |
| 业务规则 | Workflow State Machine 不是外部控制器，而是插件内维护的流程状态；它用于让 Agent 知道当前阶段应该做什么，也让 Hooks 能校验实际行为。 |

示例 Workflow State：

```json
{
  "current_workflow": "coding-task-workflow",
  "current_stage": "draft_task_tree",
  "allowed_actions": ["read_file", "ask_user_question", "update_draft_tree"],
  "forbidden_actions": ["file_write", "mutation_command"],
  "next": ["branch_confirmation"]
}
```

成功走完 Workflow 依赖三件事：

```text
1. Skill 让 Agent 知道当前场景下应该怎么做
2. Workflow State Machine 让系统知道现在处于哪一步
3. Hooks 检查 Agent 实际行为是否符合当前阶段
```

### 5.22 Coding Constraints

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-022 |
| 功能名称 | Coding Constraints |
| 功能描述 | 系统应提供面向 Coding Agent 的约束规则，使 Agent 在规划、执行、验证和汇报时按照用户期望的工程方法工作。 |
| 输入 | 用户目标、项目上下文、Task Tree、Artifact Graph、Runtime State、用户确认结果、工具事件 |
| 处理 | 根据当前 Runtime State 和任务阶段应用对应约束，影响 Agent 的规划、执行、验证和汇报方式 |
| 输出 | 符合约束的 Task Tree、执行计划、工具调用行为、验证行为、汇报结果 |
| 业务规则 | Constraints 不是外部审批系统，也不替代 Agent 推理；Constraints 是 Agent Runtime 中约束 coding 行为的运行时规则。 |

Coding Constraints 分为三类：

| 类型 | 约束对象 | 典型规则 |
| --- | --- | --- |
| Planning Constraints | 任务归属、任务拆分、Task Tree、确认边界 | coding 请求先请求用户确认新建或归并；随后生成完整 draft Task Tree；叶子节点必须是开发任务级；未确认范围不得执行会修改项目的节点 |
| Execution Constraints | 代码修改、工具调用、分支执行、测试验证 | 先 skeleton 再 implementation；修改 planned Artifact 时检查 Drift；成功声明必须有验证依据 |
| Reporting Constraints | 结果汇报、阻塞说明、风险提示 | 汇报必须引用 Trace / Artifact / Evaluation；失败或阻塞必须说明原因、影响范围和下一步建议 |

约束系统的核心作用如下：

```text
约束决定 Agent 应该怎么做
Hooks 记录 Agent 实际做了什么
Evaluation 判断做得怎么样
Evolution 沉淀下次如何做得更好
```

### 5.23 Lifecycle Hooks

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-023 |
| 功能名称 | Lifecycle Hooks |
| 功能描述 | 系统应通过 Agent coding 过程中的事件触发 Hooks，将关键行为转化为 Trace、Artifact、Evaluation 和 Evolution 的事实来源。 |
| 输入 | 工具调用事件、文件读写事件、命令执行事件、测试结果、Git diff、用户确认、用户变更、Plan Drift、Runtime State 变化 |
| 处理 | 根据事件类型触发对应 Hook，生成或更新 Trace Event、Artifact Record、Task Node 状态、Evaluation 输入或 Evolution 候选 |
| 输出 | Trace Event、Artifact Graph 更新、Runtime State 更新、Evaluation 输入、Experience / Failure Case / Skill 候选 |
| 业务规则 | Hooks 监听的是 coding 生命周期事件，不是外部监控 Agent 本体；Hooks 应与 Agent Runtime 同步工作，而不是在任务结束后补记。 |

Lifecycle Hooks 的基础事件类型如下：

| Hook 类型 | 触发事件 | 主要产物 |
| --- | --- | --- |
| task_lifecycle_hook | Task Root 创建、revision 生成、分支确认、节点开始/完成/阻塞/待重新验证 | Task Tree Revision、Task Node 状态、Trace Event |
| task_refinement_hook | Plan Readiness Scan、讨论项选择、Draft Change Set 应用、Decision Record 形成 | Draft Revision、Plan Readiness Result、planning Trace Event |
| task_affiliation_hook | coding 请求进入、Task Tree 候选查询、Agent 提出新建或归并建议、用户确认归属 | Task Tree 归属决策、Trace Event、Runtime State |
| project_identity_hook | Project 启动、marker 读取、路径变化、重复 identity 检测 | Project Identity Resolution、Path Alias、Project Clone 候选 |
| project_clone_hook | Project Clone 开始、实体复制、引用重写、marker 改写、恢复 | Project Clone Record、目标 Project、Trace provenance |
| tool_event_hook | 工具调用、文件读取、文件修改、命令执行 | Trace Event、Execution Context |
| artifact_hook | 文件创建、修改、删除、接口/Schema/测试变化 | Artifact Graph 更新、Plan Drift 候选 |
| verification_hook | 测试、构建、lint、人工验收结果 | Evaluation 输入、Trace Event |
| skeleton_gate_hook | skeleton 节点完成、关键 Artifact 形成、结构验证命令结束、blocking Drift 变化 | Skeleton Gate Evidence、Workflow State 迁移或阻塞原因 |
| user_decision_hook | 分支确认、变更确认、Drift 处理、暂停/恢复 | Runtime State、User Change Request |
| composition_hook | contract provider 出现/消失、依赖满足/缺失、scope 激活/处置 | Composition State、Dependency Resolution、Trace Event |
| replacement_hook | candidate revision、影响闭包、Effect 处置、revision 激活/恢复 | Replacement Record、Effect Disposal Result、受影响节点状态 |
| evolution_hook | 失败后成功、重复修复、稳定通过验证 | Experience、Failure Case、Skill 候选 |

Hooks 与核心结构的关系如下：

```text
Agent coding event
  ↓
Lifecycle Hook
  ↓
Trace Fact Memory
  ↓
Artifact / Task / Evaluation
  ↓
Evolution
```

### 5.24 Project Identity 与 Project Clone

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-024 |
| 功能名称 | 稳定项目身份与项目复制 |
| 功能描述 | 系统应使用最小 Project Identity Marker 区分目录移动、重命名和复制，并在复制时建立独立但可追溯的新 Project。 |
| 输入 | 当前 canonical_path、Project Identity Marker、数据库中的原 canonical_path、源 Project Runtime Records |
| 处理 | 判断原路径是否仍存在；移动/重命名时更新路径；复制时创建新 `project_id`、改写复制目录 marker，并按克隆策略复制必要记录 |
| 输出 | identity resolution、Project Path Alias 更新、Project Clone Record、目标 Project 与克隆后的 Task Tree |
| 业务规则 | 移动/重命名必须保持原 `project_id`；复制必须生成新 `project_id`；源项目和目标项目此后独立演进；不得把源 Trace 伪装为目标项目的新执行事实。 |

`.agent-harness-project.json` 的最小结构如下：

```json
{
  "schema_version": 1,
  "project_id": "project_xxx",
  "identity_token": "random-unforgeable-token"
}
```

marker 不保存绝对路径，避免目录移动后自身失效。绝对路径、Path Alias 和 clone provenance 只保存在公共数据库中。marker 中不得保存 Task Tree、Trace、Artifact、Evaluation、Skill、API Key 或其他敏感运行数据。

Project Clone 的复制范围如下：

| 数据 | Clone 行为 |
| --- | --- |
| Task Tree / Revision / Task Node | 复制并生成新 ID，保留 `cloned_from_*` 来源 |
| Task Relation Edge / Leaf Task Contract / Skeleton Acceptance Criteria | 随对应 Task Tree 复制并重写内部引用 |
| draft / planned Artifact Graph | 复制；相对路径保持不变，项目内绝对路径重绑定到新 Project，项目外路径标记为 external_reference |
| Trace Event | 不复制成新执行事实；只保留来源引用或必要的 inherited evidence snapshot |
| Evaluation / completion evidence | 作为继承证据复制引用，并标记 `inherited_from_clone`；需要按新项目内容重新验证 |
| Experience / Skill / Failure Case | 继续保存在公共数据库中，按既有全局共享策略使用，不重复克隆实体 |
| Runtime State / Execution Context | 不延续为正在执行；在目标 Project 中创建新的运行状态 |

克隆后的 Task Node 状态映射至少满足：

- `draft` 保持 `draft`；
- `pending_user_confirmation` 保持 `pending_user_confirmation`；
- `ready` 保持 `ready`；
- `succeeded` 只有在目标 Project 的相关 Artifact hash 与源基线一致时才可保留，否则进入 `needs_revalidation`；
- `running` 变为 `paused_after_clone`；
- `verifying` 变为 `needs_revalidation`；
- `failed`、`blocked` 和 `rejected` 保留事实状态，但必须重写 Project 与 Task 引用。

Project Clone 必须在数据库事务中完成。事务失败时不得改写目标目录 marker；marker 改写失败时必须将 Clone Record 标记为 `incomplete` 并在下次启动时恢复或提示用户处理。

### 5.25 Task Node 时空可组合与 Revision Replacement

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-025 |
| 功能名称 | Task Node 时空可组合与 revision 替换 |
| 功能描述 | 系统应让 Task Node 通过显式 contract、composition state 和 owned effects 进行组合，并支持在保留稳定节点身份的前提下替换 revision。 |
| 输入 | 当前 Task Node Revision、候选 Revision、provides / requires contracts、Relation Edges、Artifact Graph、owned effects、用户确认 |
| 处理 | 比较契约、计算影响闭包、挂起依赖者、处置旧 revision effects、激活候选 revision、重评估依赖者并执行失败恢复 |
| 输出 | 新 Task Node Revision、Replacement Record、composition state 变化、Effect Disposal Result、受影响节点状态 |
| 业务规则 | `task_node_id` 在 replacement 中保持稳定；旧 revision 和事实记录不得覆盖；执行状态与组合状态分离；不可逆 Effect 不得自动回滚；受影响范围必须交给用户确认。 |

每个可组合 Task Node Revision 至少声明：

- `provides_contracts`：该 revision 为其他节点提供的接口、Schema、命令、能力或数据约定；
- `requires_contracts`：该 revision 激活和执行所需的契约；
- `owned_effects`：由该 revision 产生并由其生命周期负责处置的 Effect；
- `composition_state`：`pending_dependency`、`active`、`suspending`、`replacing`、`needs_replanning`、`disposed` 等；
- `execution_status`：继续使用 draft、ready、running、verifying、succeeded、failed 等执行生命周期状态。

Task Node Replacement 必须按以下事务执行：

1. 创建 candidate Task Node Revision，不修改当前 active revision；
2. 比较旧 revision 与 candidate 的 `provides_contracts`、`requires_contracts`；
3. 结合 Task Relation Edges 和 Artifact Graph 计算 dependency impact closure；
4. 向用户展示 replacement 内容、Effect 风险和影响范围并请求确认；
5. 按依赖逆序将受影响依赖者转为 `suspending`；
6. 按 Effect 分类处置旧 revision 的可处置 Effect；
7. 激活并验证 candidate revision；
8. 重评估依赖者：契约兼容则恢复并进入 revalidation，缺少依赖则进入 `pending_dependency`，契约不兼容则进入 `needs_replanning`；
9. candidate 激活失败且旧 revision 可恢复时，重新激活旧 revision；无法恢复时标记 `replacement_failed` 并保留完整证据。

Effect 分类与处置规则如下：

| effect_type | 含义 | 自动处置规则 | 示例 |
| --- | --- | --- | --- |
| reversible | 存在确定性 inverse operation | 可在 ownership 与基线校验通过后自动回滚 | 临时注册、草案关系、内存状态 |
| version_reversible | 依赖版本、patch 或快照恢复 | 只有目标未被其他 revision 修改且 hash / version 基线匹配时可自动恢复 | 代码文件、配置文件、生成文件 |
| compensatable | 无法真正恢复原状，但存在补偿动作 | 只执行显式 compensation，并记录残余影响 | 已发布但可撤回的资源、可补发的通知 |
| irreversible | 无安全 inverse 或 compensation | 禁止自动处置，必须请求用户确认并保留审计事实 | 支付、不可撤销消息、生产数据删除、不可逆部署 |

共享文件或共享 Artifact 不能因为某个 Task Node 被替换就直接反向应用 patch。只有 Effect ownership 唯一、目标 hash 与记录基线一致、且没有后续 revision 或其他节点写入时，才可执行自动恢复；否则必须进入 conflict / manual_resolution。

### 5.26 Harness Plugin Composition Contract

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-026 |
| 功能名称 | Harness 插件组合契约 |
| 功能描述 | Harness Plugin 内部的 Skill、Workflow、Hook、Binding 和 Runtime 扩展应通过统一的组合契约注册与卸载。 |
| 输入 | plugin ID、revision、provides / requires、registrations、effects、lifecycle callbacks |
| 处理 | 解析依赖、激活插件、登记 Effect disposer、暂停缺失依赖的插件、执行兼容替换或失败恢复 |
| 输出 | Plugin Composition State、Dependency Resolution、Effect Disposal Result、Plugin Replacement Record |
| 业务规则 | Plugin ID 必须稳定；所有动态注册必须返回或登记 disposer；清理由插件 revision 生命周期拥有；Binding 只是目标 Agent 环境的绑定方式，不改变组合契约语义。 |

首版组合运行时必须是框架中立的。允许未来提供 Cordis Binding 或迁移层，但 Harness 的 Plugin Composition Contract 不得暴露 Cordis 专属类型作为核心数据模型，也不得要求 Claude、Codex 或其他 Agent Runtime 安装同一个第三方容器才能使用 Harness。

### 5.27 Task Tree Refinement Loop

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-027 |
| 功能名称 | 问题驱动的任务树精炼循环 |
| 功能描述 | 系统应在完整初始 draft Task Tree 生成后，通过高影响问题的逐项讨论和局部 Change Set，将树或选定分支推进到可确认、可执行状态。 |
| 输入 | 当前 draft revision、unresolved questions / decisions、Task Relation Edges、Artifact Contracts、Leaf Task Contracts、Skeleton Acceptance Criteria、风险 Effect、用户指定讨论范围 |
| 处理 | 执行 Plan Readiness Scan；对待讨论项进行确定性优先级计算；Agent 解释最高优先级问题并给出建议；用户回答后生成局部 Draft Change Set、Decision Record 和新 draft revision；循环直到待确认范围 Plan Ready |
| 输出 | Draft Change Set、Decision Record、新 Task Tree Revision、Plan Readiness Result、下一项推荐讨论内容或分支确认请求 |
| 业务规则 | 默认由 Agent 按影响优先级推荐下一题，用户可以随时点名其他分支或问题；每轮只聚焦一个内聚决策；不得保存隐藏思维链；尚未 Plan Ready 的范围不得进入分支确认。 |

精炼循环如下：

```text
完整 Draft Task Tree v1
  ↓
Plan Readiness Scan
  ↓
计算待讨论项影响优先级
  ↓
Agent 展示当前理解、推荐方案、备选方案、影响范围和一个聚焦问题
  ↓
用户回答或点名其他讨论范围
  ↓
生成并应用局部 Draft Change Set
  ↓
写入 Decision Record + Draft Revision
  ↓
重新执行 Plan Readiness Scan
  ├── 未就绪 → 继续精炼
  └── 已就绪 → 请求确认对应树或分支
```

默认讨论优先级从高到低为：

1. 根目标、范围边界和明确排除项；
2. 影响多个分支的架构决策；
3. 跨分支接口、Schema、数据交换和 Artifact Contract；
4. `irreversible` / `compensatable` 等高风险 Effect；
5. 分支职责、任务边界和依赖阻塞；
6. 验收标准、required evidence 和 Skeleton Acceptance Criteria；
7. 局部叶子任务实现细节。

代码可以依据受影响节点数量、跨分支范围、阻塞节点数量、unresolved 标记、风险等级和验收缺失情况计算优先级；Agent 负责理解问题语义、提出建议并与用户讨论。用户点名其他范围时，用户选择立即覆盖默认推荐，但不删除原待讨论项。

Draft Change Set 至少包含 `base_revision_id`、结构化 operations、affected branches / nodes / artifacts、decision_summary 和 source user message。只有实际改变节点、关系、Artifact、Contract、验收条件或执行阶段的结果才生成新 revision；纯解释、重复确认或没有结构变化的对话只记录 planning Trace / Decision Record。

局部 draft 修改可以直接应用并在回复中展示精简 diff；涉及跨分支大范围重构时，应先展示 Change Set 影响再应用。已确认范围的任何修改继续使用既有 revision、影响闭包和重新确认流程。

Plan Readiness 按待确认范围评估，至少要求：

```text
目标与范围明确
AND blocking unresolved_questions 为空
AND blocking unresolved_decisions 为空
AND Leaf Task Contract 硬校验通过
AND dependencies 与 relation references 有效
AND 跨分支关系存在对应 planned Artifact Contract
AND Skeleton Acceptance Criteria 完整
AND 高风险 Effect 已识别
AND 验收条件与 required_evidence 完整
```

一个分支 Plan Ready 不代表整棵树都必须就绪。该分支可以进入用户确认；其他分支继续保持 draft。若 Plan Ready 分支依赖未确认分支，确认后仍进入 `blocked_by_unconfirmed_dependency`，不得绕过依赖。

### 5.28 Failure Case Reproduction Maturity

| 项目 | 内容 |
| --- | --- |
| 功能编号 | FR-028 |
| 功能名称 | Failure Case 渐进复现与回归成熟度 |
| 功能描述 | 系统应允许失败事实先被捕获，再从结构化人工复现逐步提升为稳定自动化回归，而不因暂时无法自动化而丢失有价值案例。 |
| 输入 | 失败 Evaluation、Execution Attempt、Trace、Artifact、环境、source revision、修复 revision、人工步骤、自动化命令 |
| 处理 | 创建 Failure Case；维护 Reproduction Revision；验证人工复现；尝试自动化；验证 pre-fix RED、post-fix GREEN、重复稳定性与隔离性；晋升或标记异常状态 |
| 输出 | L0-L4 maturity、Failure Reproduction Revision、Reproduction Validation Result、Active Regression Case |
| 业务规则 | 人工与自动化复现属于同一 Failure Case 的不同 revision；L1 可以作为经验来源，只有达到 L3/L4 才能作为稳定自动回归或 Skill Promotion Replay；容器不是强制隔离方式。 |

Failure Case 成熟度如下：

| level | 名称 | 要求 |
| --- | --- | --- |
| L0 | observed | Trace / Evaluation 中已观察到失败，但复现契约尚不完整 |
| L1 | manual | 具有结构化前置条件、环境、步骤、expected / actual、Oracle、证据和清理方式 |
| L2 | assisted | 大部分步骤可由命令执行，仍需要少量人工或 Agent 判断 |
| L3 | automated | 单一入口可以自动准备、执行、判断和清理，并稳定复现失败 |
| L4 | regression | 已验证 pre-fix RED、post-fix GREEN 与重复稳定性，进入长期回归测试集 |

异常状态包括 `flaky`、`environment_blocked`、`quarantined` 和 `obsolete`。异常状态与 L0-L4 maturity 分离，避免把“自动化程度”和“当前可用性”混为一个字段。

结构化人工复现至少包含：

- preconditions 与 environment manifest；
- source revision / fixture refs；
- setup steps、reproduction steps 和 cleanup steps；
- expected result、actual failure 与 failure Oracle；
- Trace、Artifact、命令输出或截图等 evidence refs。

自动化复现还必须声明 entry command、timeout、isolation strategy、expected failure signature、pre-fix baseline、post-fix baseline 和 repeat policy。L4 晋升必须满足：

```text
在 pre-fix revision / fixture 上稳定 RED
AND 在 post-fix revision 上 GREEN
AND Oracle 具有区分能力
AND 重复执行稳定
AND setup / cleanup 可隔离
```

隔离策略按 fixture、Git worktree、临时目录、项目原生测试环境、容器或虚拟环境的顺序选择适合方式。系统不得把容器作为所有 Failure Case 的强制前提；具体策略由项目和失败环境决定。

## 6. 非功能需求

### 6.1 可追溯性

- 每个任务状态变化应能追溯到对应 Trace；
- 每个 Evaluation 结论应能追溯到证据；
- 每个 Skill 或 Failure Case 应能追溯到来源任务；
- 每个 Artifact 关系应尽量来自工具事件和项目状态变化。

### 6.2 可靠性

- Harness 不应因单次 Agent 运行结束而丢失任务；
- 工具事件记录失败时，应尽量保留原始上下文用于恢复；
- 任务状态聚合应具备确定性；
- 证据不足时不应伪造成功结论。

### 6.3 可维护性

- Task Tree、Trace、Artifact、Evaluation、Evolution 应保持清晰边界；
- 各模块应能独立理解、测试和替换；
- LLM 归纳逻辑不得混入基础状态机；
- Agent Runtime Binding 不得污染 Harness Runtime Layer 的核心语义；
- 文档、数据结构和后续实现应保持一致。

### 6.4 安全性

- 需要区分 read_only、mutation、verification、external_side_effect；
- 外部副作用事件应有高风险标记；
- 敏感信息不应被直接写入可复用 Skill；
- 清理运行上下文记录不应误删长期经验资产；
- 对危险命令和不可逆操作应保留审计记录。

### 6.5 兼容性

- 优先支持 Bash 环境；
- 需要考虑 Windows 路径与 WSL 路径的规范化；
- 需要兼容 Git 项目和非 Git 项目；
- 不应绑定单一模型供应商；
- 不应绑定单一 Agent；
- 需要支持通过 Agent Runtime Binding 将 Harness Runtime Layer 绑定到 Claude、Codex、Cursor Agent、自研 Agent 或未来新的 Agent Runtime。

### 6.6 可扩展性

- 后续应能扩展新的 Artifact 类型；
- 后续应能扩展新的 Evaluation 策略；
- 后续应能扩展新的 Skill 晋升规则；
- 后续应能绑定不同 Agent Runtime、模型、工具和执行环境。

## 7. 数据需求

### 7.1 核心数据实体

#### Project

| 字段 | 描述 |
| --- | --- |
| project_id | Project 唯一标识 |
| canonical_path | 规范化后的项目路径 |
| display_path | 向用户展示的原始或友好路径 |
| display_name | 展示名称 |
| platform | Windows、WSL、Linux 等 |
| cloned_from_project_id | 复制来源 Project，可为空 |
| cloned_at | Project Clone 时间，可为空 |
| created_at | 创建时间 |
| updated_at | 更新时间 |

#### Project Identity Marker

| 字段 | 描述 |
| --- | --- |
| schema_version | marker schema 版本 |
| project_id | 稳定 Project 标识 |
| identity_token | 用于校验身份记录的随机不可预测 token |

Project Identity Marker 是项目目录中的最小身份文件，不是 Runtime Records 存储。公共数据库保存其 token 校验值、路径历史和最近解析结果；敏感 token 不应出现在 Trace 明文或用户可复制的诊断输出中。

#### Project Clone Record

| 字段 | 描述 |
| --- | --- |
| project_clone_id | Project Clone 唯一标识 |
| source_project_id | 源 Project |
| target_project_id | 新 Project |
| source_path | 复制发生时的源 canonical_path |
| target_path | 目标 canonical_path |
| cloned_entity_counts | 各实体复制数量 |
| provenance_policy | Trace、Evaluation 和 evidence 的继承策略 |
| status | pending、cloning、completed、incomplete、failed、recovered |
| error_summary | 失败或不完整原因，可为空 |
| created_at | 创建时间 |
| completed_at | 完成时间，可为空 |

#### Project Path Alias

| 字段 | 描述 |
| --- | --- |
| project_path_alias_id | Project Path Alias 唯一标识 |
| project_id | 所属 Project |
| observed_path | Agent Runtime 实际观察到的工作目录 |
| normalized_path | 规范化后的别名路径 |
| platform | Windows、WSL、Linux 等 |
| is_primary | 是否为当前主要展示路径 |
| created_at | 创建时间 |

#### Task Tree

| 字段 | 描述 |
| --- | --- |
| task_tree_id | Task Tree 唯一标识 |
| project_id | 所属 Project |
| bound_project_path | Task Tree 创建或最近确认时绑定的 canonical_path 快照，用于路径隔离审计 |
| root_task_node_id | 根任务节点 |
| status | 聚合状态 |
| title | 任务标题 |
| approval_status | Task Tree 确认状态，如 draft、partial_confirmed、confirmed、rejected |
| revision | Task Tree 当前结构版本 |
| cloned_from_task_tree_id | Project Clone 来源 Task Tree，可为空 |
| confirmed_at | 用户确认 Task Tree 或分支的时间 |
| created_at | 创建时间 |
| updated_at | 更新时间 |

#### Task Tree Revision

| 字段 | 描述 |
| --- | --- |
| revision_id | Task Tree Revision 唯一标识 |
| task_tree_id | 所属 Task Tree |
| revision_number | 单调递增的结构版本号 |
| based_on_revision_id | 前一 revision，可为空 |
| change_type | create、merge_request、node_update、user_change_request、drift_resolution 等 |
| change_summary | 本次结构变化摘要 |
| affected_task_node_ids | 本次变化直接或间接影响的 Task Node |
| confirmation_status | draft、pending_user_confirmation、confirmed、rejected、superseded |
| confirmed_scope | 用户确认的整棵树或分支范围 |
| created_at | 创建时间 |
| confirmed_at | 用户确认时间，可为空 |

#### Draft Change Set

| 字段 | 描述 |
| --- | --- |
| draft_change_set_id | Draft Change Set 唯一标识 |
| task_tree_id | 所属 Task Tree |
| base_revision_id | 变更基于的 draft revision |
| operations | add / update / move / remove node、relation、Artifact、Contract 或验收条件等结构化操作 |
| affected_task_node_ids | 受影响节点 |
| affected_branch_ids | 受影响分支 |
| affected_artifact_ids | 受影响 Artifact |
| decision_summary | 用户讨论结论摘要 |
| source_message_ref | 产生变更的用户消息引用 |
| apply_mode | direct_draft_apply、preview_required |
| result_revision_id | 应用后形成的 Task Tree Revision |
| created_at | 创建时间 |

#### Planning Decision Record

| 字段 | 描述 |
| --- | --- |
| planning_decision_id | Planning Decision 唯一标识 |
| task_tree_id | 所属 Task Tree |
| discussion_topic | 本轮聚焦问题 |
| current_understanding | 向用户展示的当前理解摘要 |
| considered_options | Agent 向用户展示的可选方案 |
| agent_recommendation | Agent 推荐方案与理由摘要 |
| user_decision | 用户明确选择或补充内容 |
| affected_refs | 受影响 Task Node、Artifact、Contract 或验收标准 |
| draft_change_set_id | 由该决策产生的 Change Set，可为空 |
| trace_event_id | 对应 planning Trace Event |
| created_at | 创建时间 |

Planning Decision Record 只保存可向用户解释的决策信息，不保存模型隐藏思维链或完整内部推理过程。

#### Plan Readiness Result

| 字段 | 描述 |
| --- | --- |
| plan_readiness_result_id | Plan Readiness Result 唯一标识 |
| task_tree_revision_id | 被检查 draft revision |
| scope_type | tree、branch、subtree |
| scope_id | 待确认范围标识 |
| verdict | ready、not_ready、blocked |
| blocking_issue_refs | 阻止确认的问题 |
| warning_issue_refs | 不阻止确认但需要提示的问题 |
| recommended_next_issue_ref | 默认推荐的下一项讨论内容，可为空 |
| evaluated_at | 判断时间 |

#### Task Node

| 字段 | 描述 |
| --- | --- |
| task_node_id | Task Node 唯一标识 |
| task_tree_id | 所属 Task Tree |
| parent_id | 父节点 |
| description | 任务描述 |
| status | 当前状态 |
| current_revision_id | 当前 active Task Node Revision |
| composition_state | pending_dependency、active、suspending、replacing、needs_replanning、disposed 等组合状态 |
| context | 任务上下文 |
| acceptance_criteria | 节点验收标准 |
| branch_approval_status | 分支确认状态，如 draft、pending_user_confirmation、approved、rejected |
| branch_confirmed_at | 当前节点作为分支根被用户确认的时间 |
| affected_by_revision | 当前节点受哪个 Task Tree revision 影响，可为空 |
| requires_reconfirmation | 当前节点或子树是否因结构变更需要重新确认 |
| execution_phase | 执行阶段，如 skeleton、implementation、verification |
| depends_on | 当前节点依赖的其他 Task Node |
| relation_edges | 当前节点与其他 Task Node 的关系边，如 calls、exchanges_data_with、shares_artifact_with、coordinates_with |
| artifact_refs | 当前节点计划或实际关联的 Artifact，如接口、Schema、模块、测试、命令、配置 |
| leaf_task_contract_id | 叶子节点关联的 Leaf Task Contract，可为空 |
| is_leaf | 是否为叶子任务节点 |
| stop_decomposition_reason | 停止继续拆分的原因 |
| completion_evidence_refs | 执行阶段实际产生的完成证据引用，用于覆盖 Leaf Task Contract.required_evidence |
| result | 执行结果 |
| created_at | 创建时间 |
| updated_at | 更新时间 |

#### Task Node Revision

| 字段 | 描述 |
| --- | --- |
| task_node_revision_id | Task Node Revision 唯一标识 |
| task_node_id | 稳定 Task Node 标识 |
| revision_number | 单调递增 revision |
| based_on_revision_id | 前一 revision，可为空 |
| description | 本 revision 的目标与边界 |
| provides_contracts | 对外提供的 Artifact Contract 引用 |
| requires_contracts | 激活和执行所需的 Artifact Contract 引用 |
| owned_effect_ids | 本 revision 生命周期拥有的 Effect |
| execution_status | draft、ready、running、verifying、succeeded、failed 等 |
| composition_state | pending_dependency、active、suspending、replacing、needs_replanning、disposed |
| confirmation_status | draft、pending_user_confirmation、confirmed、rejected、superseded |
| created_at | 创建时间 |
| activated_at | 激活时间，可为空 |
| disposed_at | 处置时间，可为空 |

#### Leaf Task Contract

| 字段 | 描述 |
| --- | --- |
| leaf_task_contract_id | Leaf Task Contract 唯一标识 |
| task_node_id | 关联的叶子 Task Node |
| objectives | 工程目标列表；叶子节点必须且只能有一个目标 |
| expected_outputs | 预期代码、接口、Schema、测试、配置、诊断结论或其他交付结果 |
| acceptance_criteria | 可执行或可观察的验收条件 |
| unresolved_questions | 尚未回答的需求问题；叶子节点必须为空 |
| unresolved_decisions | 尚未确定的设计选择；叶子节点必须为空 |
| dependency_refs | 依赖的 Task Node 引用，必须全部有效 |
| required_evidence | 规划阶段声明的必需完成证据 |
| execution_phase | skeleton、implementation 或 verification |
| stop_decomposition_reason | 停止继续拆分的原因 |
| structural_validation_status | pending、passed、failed |
| structural_validation_errors | 代码硬校验产生的错误列表 |
| semantic_warnings | 并列目标、多模块跨度、模糊验收条件等启发式警告 |
| confirmed_revision_id | 用户确认该叶子边界时对应的 Task Tree Revision |

#### Skeleton Acceptance Criteria

| 字段 | 描述 |
| --- | --- |
| skeleton_acceptance_id | Skeleton Acceptance Criteria 唯一标识 |
| task_tree_revision_id | 所属 Task Tree Revision |
| branch_task_node_id | 所属顶层功能分支 |
| expected_artifacts | 预期存在或形成的目录、模块、接口、Schema、测试入口和配置 |
| required_contracts | 跨分支接口、数据结构、调用边界和依赖约定 |
| verification_commands | 基础构建、类型检查、测试加载或其他结构验证命令 |
| readiness_conditions | 允许进入该分支 implementation 的结构性条件 |
| evidence_refs | Lifecycle Hooks 采集的文件、Artifact、命令和验证证据 |
| gate_status | pending、running、passed、failed、blocked、uncertain |
| failure_reason | Gate 未通过或无法判断的原因，可为空 |
| evaluated_at | 最近判断时间 |

#### Task Relation Edge

| 字段 | 描述 |
| --- | --- |
| task_relation_edge_id | Task Relation Edge 唯一标识 |
| task_tree_id | 所属 Task Tree |
| source_task_node_id | 来源 Task Node |
| target_task_node_id | 目标 Task Node |
| relation_type | depends_on、calls、exchanges_data_with、shares_artifact_with、coordinates_with 等 |
| artifact_ref | 关联的 Artifact，可为空 |
| artifact_requirement | required、conditional、not_required；由 relation_type 与 dependency_kind / coordination_kind 的确定性矩阵计算 |
| dependency_kind | depends_on 的细分类，如 execution_order、contract_ready、test_fixture_ready、environment_ready，可为空 |
| coordination_kind | coordinates_with 的细分类，如 schedule_only、review_sync、shared_decision、integration_check，可为空 |
| relation_validation_status | valid、missing_required_artifact、invalid_artifact、unresolved |
| description | 关系说明 |
| created_at | 创建时间 |
| updated_at | 更新时间 |

#### Trace Event

| 字段 | 描述 |
| --- | --- |
| trace_event_id | Trace Event 唯一标识 |
| project_id | 所属 Project |
| task_node_id | 关联 Task Node |
| execution_context | 事件发生时的运行环境元信息 |
| event_type | 事件类型 |
| event_time | 事件时间 |
| input_summary | 输入摘要 |
| output_summary | 输出摘要 |
| artifact_refs | 该事件涉及的 Artifact 引用 |
| evidence | 证据引用 |

`event_type` 应至少支持 `plan_drift` 和 `user_change_request`。`plan_drift` 用于记录实际执行与已确认计划基准之间的有意义偏移；`user_change_request` 用于记录用户主动提出的计划变更。

#### Artifact

| 字段 | 描述 |
| --- | --- |
| artifact_id | Artifact 唯一标识 |
| project_id | 所属 Project |
| granularity | structural、contract、symbol |
| artifact_type | 目录、文件、模块、包、配置、命令、测试入口、接口、Schema、事件、协议、函数、类、方法、类型、测试用例等 |
| artifact_status | draft、planned、created、modified、verified、deprecated |
| path_or_name | 路径或名称 |
| parent_artifact_id | 上级 Artifact，可为空；用于表达目录—文件、模块—接口、文件—符号等层级 |
| locator | 在项目中的稳定定位信息，如路径、导出名、qualified name、行列范围或命令标识 |
| identity_strategy | path、logical_contract_id、qualified_symbol、command_signature 等身份策略 |
| confidence | planned、observed、verified 等来源可信度或计算结果 |
| planned_by_task_node_id | 将该 Artifact 从 draft 晋升为 planned 的 Task Node，可为空 |
| plan_baseline_at | Artifact 成为计划基准的时间，可为空 |
| current_hash_or_version | 当前资产 hash、version 或状态摘要，可为空 |
| source_trace_event_id | 最近一次事实状态变化来源 Trace，可为空 |
| source_planning_revision_id | 当前计划状态来源 Task Tree Revision，可为空 |
| metadata | 资产元信息 |
| created_at | 创建时间 |
| updated_at | 更新时间 |

#### Artifact Relation

| 字段 | 描述 |
| --- | --- |
| relation_id | 关系唯一标识 |
| source_type | 来源对象类型 |
| source_id | 来源对象标识 |
| target_type | 目标对象类型 |
| target_id | 目标对象标识 |
| relation_type | plans、implements、consumes、reads、modifies、creates、deletes、imports、calls、uses_schema、returns_schema、verified_by、fails_with 等工程资产关系 |

Artifact Relation 描述工程资产之间，或工程资产与任务、Trace、验证之间的计划关系和事实关系。Task Node 之间的轻量执行依赖、调用、数据交换和协作关系应记录为 Task Relation Edge；具体接口、Schema、模块、测试、命令等约定应记录为 Artifact 及 Artifact Relation。

#### Artifact Contract

| 字段 | 描述 |
| --- | --- |
| artifact_contract_id | Artifact Contract 唯一标识 |
| project_id | 所属 Project |
| artifact_id | 作为契约载体的计划态或事实态 Artifact |
| contract_name | 稳定契约名称 |
| contract_version | 契约版本 |
| compatibility_policy | exact、backward_compatible、custom_validation 等兼容策略 |
| schema_or_signature | 接口、Schema、命令、事件或数据交换约定 |
| provided_by_revision_ids | 提供该契约的 Task Node Revision |
| consumer_revision_ids | 依赖该契约的 Task Node Revision |
| validation_refs | 契约验证方式或证据 |

Artifact Contract 不是新的独立 Shared Contract 系统。它是 Artifact Graph 中可被 Task Node Revision `provides_contracts` / `requires_contracts` 引用的计划态或事实态 Artifact 约定。

#### Task Node Effect

| 字段 | 描述 |
| --- | --- |
| task_node_effect_id | Effect 唯一标识 |
| owner_revision_id | 生命周期拥有该 Effect 的 Task Node Revision |
| effect_type | reversible、version_reversible、compensatable、irreversible |
| target_ref | 受影响 Runtime State、Artifact 或外部资源 |
| operation | 已执行动作 |
| baseline_ref | 操作前 hash、version、snapshot 或状态引用，可为空 |
| inverse_operation | reversible / version_reversible 的逆操作，可为空 |
| compensation_operation | compensatable 的补偿动作，可为空 |
| evidence_refs | Effect 发生、验证和处置证据 |
| disposal_status | active、disposed、compensated、conflict、manual_resolution、not_disposable |
| created_at | 创建时间 |
| disposed_at | 处置时间，可为空 |

#### Task Node Replacement Record

| 字段 | 描述 |
| --- | --- |
| replacement_id | Replacement 唯一标识 |
| task_node_id | 保持稳定身份的 Task Node |
| old_revision_id | 原 active revision |
| candidate_revision_id | 候选 revision |
| affected_task_node_ids | 依赖影响闭包 |
| contract_diff | provides / requires 的差异与兼容判断 |
| effect_risk_summary | 各 Effect 的处置风险 |
| user_confirmation_ref | 用户对 replacement 和影响范围的确认 |
| status | pending_confirmation、suspending、disposing、activating、completed、rolled_back、replacement_failed |
| disposal_result_refs | Effect Disposal Result 引用 |
| recovery_result | 失败恢复结果，可为空 |
| trace_event_ids | replacement 全流程 Trace |
| created_at | 创建时间 |
| completed_at | 完成时间，可为空 |

#### Plan Drift Record

| 字段 | 描述 |
| --- | --- |
| plan_drift_id | Plan Drift 记录唯一标识 |
| project_id | 所属 Project |
| task_tree_id | 所属 Task Tree |
| task_node_id | 发生偏移的 Task Node |
| planned_artifact_id | 原计划 Artifact，可为空 |
| actual_artifact_id | 实际 Artifact，可为空 |
| drift_type | missing_planned_artifact、unexpected_artifact、artifact_replaced、responsibility_changed、relation_changed 等 |
| severity | info、warning、blocking |
| trace_event_id | 对应的 plan_drift Trace Event |
| drift_explanation | 对偏移原因、影响范围和风险的说明 |
| agent_recommendation | Agent 对 blocking drift 的推荐处理方案，可为空 |
| resolution_status | pending_user_confirmation、accepted、rejected、branch_cancelled、recorded 等 |
| user_decision | 用户对 blocking drift 的选择，可为空 |
| description | 偏移说明 |
| created_at | 创建时间 |

#### User Change Request Record

| 字段 | 描述 |
| --- | --- |
| user_change_request_id | User Change Request 唯一标识 |
| project_id | 所属 Project |
| task_tree_id | 所属 Task Tree |
| task_node_id | 用户提出变更时关联的 Task Node，可为空 |
| change_type | minor_change、scope_change、priority_change |
| user_message_ref | 用户原始消息引用 |
| affected_task_node_ids | 受影响的 Task Node 列表 |
| affected_artifact_ids | 受影响的 Artifact 列表 |
| impact_summary | 变更影响说明 |
| required_confirmation | 是否需要用户确认后继续 |
| resolution_status | recorded、pending_user_confirmation、accepted、rejected、applied |
| trace_event_id | 对应的 user_change_request Trace Event |
| created_at | 创建时间 |

#### Execution Attempt

| 字段 | 描述 |
| --- | --- |
| execution_attempt_id | Task Node 的一次执行或修复尝试标识 |
| task_node_id | 所属 Task Node |
| task_node_revision_id | 本次执行使用的 Task Node Revision |
| attempt_number | 同一 revision 下单调递增的尝试序号 |
| status | running、verifying、succeeded、failed、blocked、aborted |
| trace_event_ids | 本次尝试关联的 Trace |
| started_at | 开始时间 |
| completed_at | 完成时间，可为空 |

#### Evaluation Result

| 字段 | 描述 |
| --- | --- |
| evaluation_id | Evaluation 唯一标识 |
| task_node_id | 被评估任务 |
| task_node_revision_id | 被评估的 Task Node Revision |
| execution_attempt_id | 被评估的 Execution Attempt |
| verdict | succeeded、failed、blocked、uncertain |
| evidence_refs | 证据引用 |
| required_evidence_coverage | required evidence 覆盖情况 |
| missing_evidence | uncertain 或不能成功转换时缺失的证据 |
| risk_summary | 风险说明 |
| created_at | 创建时间 |

#### Lifecycle Transition Policy

| 字段 | 描述 |
| --- | --- |
| transition_policy_id | 转换策略唯一标识 |
| from_status | Task Node 起始状态 |
| evaluation_verdict | 适用 Evaluation verdict |
| required_conditions | revision、evidence、dependency、drift 等硬条件 |
| target_status | 条件满足后的目标状态 |
| rejection_reason | 条件不满足时的确定性原因 |
| policy_version | 策略版本 |

#### Experience

| 字段 | 描述 |
| --- | --- |
| experience_id | Experience 唯一标识 |
| source_task_id | 来源任务 |
| summary | 经验摘要 |
| applicable_context | 适用条件 |
| verification | 验证方式 |
| related_artifacts | 相关 Artifact |

#### Skill

| 字段 | 描述 |
| --- | --- |
| skill_id | Skill 唯一标识 |
| source_experience_ids | 来源 Experience |
| trigger_context | 触发场景 |
| instruction | 可复用指导 |
| validation_status | 验证状态 |

#### Skill Candidate Revision

| 字段 | 描述 |
| --- | --- |
| skill_candidate_revision_id | Skill Candidate Revision 唯一标识 |
| skill_id | 对应 Skill 身份 |
| source_experience_ids | 来源 Experience |
| instruction_snapshot | 冻结的候选 Skill 内容 |
| frozen_at | 冻结时间；Holdout 必须在此后独立生成 |
| validation_status | draft、frozen、validating、passed、failed、promoted |

#### Skill Test Case

| 字段 | 描述 |
| --- | --- |
| skill_test_case_id | 测试案例唯一标识 |
| skill_candidate_revision_id | 被验证的候选 revision |
| test_type | real_failure_replay、variation、holdout、negative_applicability |
| source_refs | Failure Case、Requirement 或 Trace 来源 |
| target_behavior | 目标行为 |
| applicable_context | 适用条件 |
| fixture_setup | 隔离环境与准备步骤 |
| input | 测试输入 |
| expected_result | 期望结果 |
| oracle | 独立判断规则 |
| reproduction_command | 复现命令或执行入口 |
| timeout | 超时限制 |
| generated_by | 测试生成者与运行上下文 |
| quality_status | draft、schema_valid、reproducible、discriminative、stable、accepted、rejected |
| leakage_policy | 测试与 Skill Candidate 上下文隔离策略 |

#### Skill Validation Run

| 字段 | 描述 |
| --- | --- |
| skill_validation_run_id | 验证运行唯一标识 |
| skill_candidate_revision_id | 候选 revision |
| skill_test_case_id | 测试案例 |
| run_mode | no_skill_baseline、skill_enabled |
| repetition_index | 重复执行序号 |
| verdict | passed、failed、blocked、invalid |
| token_usage | token 使用量，可为空 |
| tool_call_count | 工具调用数量，可为空 |
| side_effect_summary | 副作用与风险摘要 |
| evidence_refs | 命令、Trace、Artifact 和 Oracle 证据 |
| created_at | 创建时间 |

#### Skill Validation Report

| 字段 | 描述 |
| --- | --- |
| skill_validation_report_id | 验证报告唯一标识 |
| skill_candidate_revision_id | 候选 revision |
| baseline_summary | 无 Skill baseline 汇总 |
| enabled_summary | 启用 Skill 后的汇总 |
| replay_result | 真实失败重放结果 |
| holdout_result | 独立 Holdout 结果 |
| negative_applicability_result | 误触发与无关修改结果 |
| stability_result | 多次运行稳定性 |
| risk_summary | 高风险副作用摘要 |
| promotion_verdict | pass、fail、uncertain |
| evidence_refs | 证据引用 |
| created_at | 创建时间 |

#### Skill Package

| 字段 | 描述 |
| --- | --- |
| package_id | Skill Package 唯一标识 |
| target_agent_type | 目标 Agent 类型 |
| included_skills | 包含的 Skill 列表 |
| bootstrap_instructions | 启动或初始化指令 |
| install_method | 插件、配置文件、CLI 安装、手动复制等安装方式 |
| compatibility_status | 兼容状态 |

#### Workflow Rule

| 字段 | 描述 |
| --- | --- |
| workflow_rule_id | Workflow Rule 唯一标识 |
| trigger_condition | 触发条件 |
| required_skill_ids | 需要激活的 Skill |
| expected_behavior | 期望 Agent 行为 |
| validation | 规则验证方式 |

#### Workflow

| 字段 | 描述 |
| --- | --- |
| workflow_id | Workflow 唯一标识 |
| workflow_name | Workflow 名称，如 coding-task-workflow |
| stages | 阶段列表，如 intake、draft_task_tree、branch_confirmation、skeleton_pass 等 |
| entry_conditions | 进入 Workflow 的条件 |
| exit_conditions | 完成 Workflow 的条件 |
| related_skill_ids | Workflow 关联的 Skill 列表 |
| transition_rules | 阶段迁移规则 |
| default_constraints | 默认适用的 Coding Constraints |

#### Workflow State

| 字段 | 描述 |
| --- | --- |
| workflow_state_id | Workflow State 唯一标识 |
| workflow_id | 所属 Workflow |
| project_id | 所属 Project |
| task_tree_id | 当前关联 Task Tree，可为空 |
| current_stage | 当前阶段，如 task_affiliation_confirmation、draft_task_tree、task_tree_refinement、branch_confirmation、skeleton_pass、skeleton_gate |
| allowed_actions | 当前阶段允许的动作 |
| forbidden_actions | 当前阶段禁止的动作 |
| next_stages | 可进入的下一阶段 |
| violation_events | 当前阶段发生的违规事件列表 |
| gate_evidence_refs | 当前阶段 Gate 使用的 Hook 证据引用 |
| updated_at | 更新时间 |

#### Runtime Record

| 字段 | 描述 |
| --- | --- |
| runtime_record_id | Runtime Record 唯一标识 |
| record_type | workflow_state、task_tree、draft_change_set、planning_decision、plan_readiness、runtime_action、execution_attempt、trace、artifact、evaluation、skill_test_case、skill_validation_run、experience、failure_case、failure_reproduction_revision、reproduction_validation_result、skill_candidate 等 |
| project_id | 所属 Project |
| source_event_id | 来源事件，可为空 |
| storage_ref | 公共数据库中的表、主键或受数据库管理的外部对象引用 |
| status | active、archived、deleted、superseded |
| created_at | 创建时间 |
| updated_at | 更新时间 |

#### Failure Case

| 字段 | 描述 |
| --- | --- |
| failure_case_id | Failure Case 唯一标识 |
| project_id | 所属 Project |
| source_task_node_id | 来源 Task Node |
| source_execution_attempt_id | 首次观察到失败的 Execution Attempt |
| source_evaluation_id | 首次确认失败的 Evaluation，可为空 |
| failure_goal | 失败目标 |
| failure_signature | 用于识别同类失败的结构化签名 |
| maturity_level | L0_observed、L1_manual、L2_assisted、L3_automated、L4_regression |
| availability_status | active、flaky、environment_blocked、quarantined、obsolete |
| current_reproduction_revision_id | 当前有效的 Reproduction Revision，可为空 |
| related_artifacts | 相关 Artifact |
| created_at | 创建时间 |
| updated_at | 更新时间 |

#### Failure Reproduction Revision

| 字段 | 描述 |
| --- | --- |
| reproduction_revision_id | 复现版本唯一标识 |
| failure_case_id | 所属 Failure Case |
| revision_number | 单调递增版本号 |
| reproduction_mode | observed、manual、assisted、automated |
| preconditions | 复现前提 |
| environment_manifest | 运行时、依赖、操作系统、环境变量名等环境摘要；不得明文保存密钥 |
| source_revision_ref | 失败发生时的代码或 Artifact 基准 |
| fixture_refs | 复现所需 fixture、样例数据或快照引用 |
| setup_steps | 结构化准备步骤 |
| reproduction_steps | 结构化复现步骤 |
| cleanup_steps | 清理步骤 |
| entry_command | 自动或辅助复现入口，可为空 |
| timeout | 最大执行时长，可为空 |
| isolation_strategy | fixture、worktree、temporary_directory、project_native、container、virtual_environment 等 |
| expected_result | 正确行为或预期结果 |
| actual_failure | 实际失败结果 |
| failure_oracle | 判断目标失败是否出现的 Oracle |
| expected_failure_signature | 自动复现预期匹配的失败签名，可为空 |
| pre_fix_baseline_ref | 证明修复前 RED 的基准与证据，可为空 |
| post_fix_baseline_ref | 证明修复后 GREEN 的基准与证据，可为空 |
| repeat_policy | 重复次数、允许波动与稳定性要求 |
| evidence_refs | 命令输出、日志、diff、测试结果等证据引用 |
| validation_status | draft、verified_manual、verified_automated、rejected、stale |
| created_at | 创建时间 |

#### Reproduction Validation Result

| 字段 | 描述 |
| --- | --- |
| reproduction_validation_result_id | 验证结果唯一标识 |
| failure_case_id | 所属 Failure Case |
| reproduction_revision_id | 被验证的复现版本 |
| pre_fix_verdict | 修复前是否稳定得到目标失败 |
| post_fix_verdict | 修复后是否通过且目标失败消失 |
| oracle_discrimination_verdict | Oracle 是否能区分目标失败与无关失败或恒真结果 |
| repeat_stability_verdict | 重复执行稳定性结论 |
| isolation_verdict | 隔离是否充分、是否污染工作区或外部状态 |
| evidence_refs | 验证证据引用 |
| maturity_promotion_verdict | 可晋升的最高 L0-L4 等级及拒绝原因 |
| created_at | 创建时间 |

#### Execution Context

| 字段 | 描述 |
| --- | --- |
| run_id | 一次运行上下文标识 |
| agent_type | Agent 类型 |
| runtime_binding_id | 使用的 Agent Runtime Binding |
| model_info | 模型信息 |
| cwd | 事件发生时的工作目录 |
| launch_method | 启动方式 |
| environment | 运行环境摘要 |

#### Runtime State

| 字段 | 描述 |
| --- | --- |
| runtime_state_id | Runtime State 唯一标识 |
| project_id | 所属 Project |
| task_tree_id | 当前关联 Task Tree，可为空 |
| workflow_state_id | 当前关联 Workflow State，可为空 |
| current_task_node_id | 当前执行或等待的 Task Node，可为空 |
| state | idle、waiting_for_task_affiliation_confirmation、drafting_task_tree、refining_task_tree、waiting_for_branch_confirmation、executing_skeleton、evaluating_skeleton_gate、executing_branch、waiting_for_drift_resolution、waiting_for_change_confirmation、paused 等 |
| waiting_item_type | 当前等待事项类型，如 branch_confirmation、drift_resolution、change_confirmation，可为空 |
| waiting_item_id | 当前等待事项标识，可为空 |
| available_runtime_actions | 当前状态下允许的 Runtime Actions |
| updated_at | 更新时间 |

#### Harness Runtime Skill

| 字段 | 描述 |
| --- | --- |
| harness_runtime_skill_id | Harness Runtime Skill 唯一标识 |
| skill_name | Skill 名称 |
| description | Skill description / trigger rules |
| trigger_scenarios | 触发场景，如任务规划、分支执行、User Change Request、Plan Drift、运行时状态查询 |
| available_introspection_tools | Skill 说明 Agent 在哪些场景使用 Runtime Introspection Tools |
| confirmation_guidance | 需要 Runtime Confirmation Prompt 的场景说明 |
| target_agent_types | 适配的 Agent 类型 |
| validation_status | Skill 验证状态 |

#### Runtime Introspection Tool

| 字段 | 描述 |
| --- | --- |
| introspection_tool_id | Runtime Introspection Tool 唯一标识 |
| tool_name | 工具名称，如 get_runtime_snapshot、get_task_tree_summary、get_task_node_detail |
| tool_level | snapshot、summary、detail |
| query_scope | 查询范围，如 runtime_state、task_tree、artifact_graph、plan_drift、user_change_request |
| input_schema | 工具输入结构 |
| output_schema | 工具输出结构 |
| pagination_policy | 是否支持 limit、cursor、filter |
| default_result_size | 默认返回规模 |
| access_policy | 工具访问和脱敏策略 |

#### Runtime Confirmation Prompt

| 字段 | 描述 |
| --- | --- |
| confirmation_prompt_id | Runtime Confirmation Prompt 唯一标识 |
| prompt_type | branch_confirmation、drift_resolution、change_confirmation、high_risk_action 等 |
| related_task_node_id | 关联 Task Node，可为空 |
| related_artifact_ids | 关联 Artifact 列表 |
| message | 展示给用户的确认说明 |
| options | 用户可选择项，如 Yes、No、Pause 或自定义选项 |
| selected_option | 用户选择结果 |
| status | pending、answered、cancelled |
| created_at | 创建时间 |
| answered_at | 用户响应时间 |

#### Runtime Action

| 字段 | 描述 |
| --- | --- |
| runtime_action_id | Runtime Action 唯一标识 |
| action_type | 状态变化动作类型 |
| target_type | Task Tree、Task Node、Artifact、Drift、Replacement、Effect 等目标类型 |
| target_id | 目标对象标识 |
| expected_revision | Agent 作出判断时读取的目标 revision / version |
| reason | Agent 提出的动作理由摘要 |
| source_message_ref | 触发该动作的用户消息引用 |
| risk_level | low、medium、high、irreversible |
| confirmation_requirement | none、required、ambiguous |
| confirmation_prompt_id | 对应 Runtime Confirmation Prompt，可为空 |
| status | proposed、validated、pending_confirmation、committed、rejected、revision_conflict |
| created_at | 创建时间 |
| committed_at | 提交时间，可为空 |

#### Runtime State Safety Rule

| 字段 | 描述 |
| --- | --- |
| safety_rule_id | Safety Rule 唯一标识 |
| rule_name | 规则名称 |
| trigger_condition | 必须发起确认的条件 |
| required_confirmation_prompt_type | 对应 Runtime Confirmation Prompt 类型 |
| applies_to_states | 适用 Runtime State |
| severity | info、warning、blocking |

#### Runtime Native Command

| 字段 | 描述 |
| --- | --- |
| command_id | Runtime Native Command 唯一标识 |
| command_name | 命令名称，如 /taskroot、/status、/pause、/resume |
| arguments_schema | 命令参数结构 |
| required_state | 允许执行该命令的 Runtime State |
| effect | 命令触发的 Runtime Flow 或状态变化 |
| safety_policy | 命令涉及关键状态时的确认策略 |

#### Coding Constraint

| 字段 | 描述 |
| --- | --- |
| constraint_id | Coding Constraint 唯一标识 |
| constraint_type | planning、execution、reporting |
| applies_to_phase | 适用阶段，如 drafting、skeleton、implementation、verification、reporting |
| trigger_condition | 约束触发条件 |
| rule_description | 约束规则说明 |
| required_behavior | Agent Runtime 应遵循的行为 |
| blocking_policy | 不满足约束时是否阻断、警告或仅记录 |
| related_runtime_actions | 关联 Runtime Action |
| evidence_required | 是否需要 Trace、Artifact、Evaluation 等证据 |

#### Lifecycle Hook

| 字段 | 描述 |
| --- | --- |
| hook_id | Lifecycle Hook 唯一标识 |
| hook_type | task_lifecycle、task_refinement、task_affiliation、project_identity、project_clone、tool_event、artifact、verification、skeleton_gate、user_decision、composition、replacement、evolution |
| trigger_event_type | 触发事件类型 |
| input_event_schema | 输入事件结构 |
| produced_records | 产出记录，如 Trace Event、Artifact Update、Evaluation Input |
| related_task_node_id | 关联 Task Node，可为空 |
| related_artifact_ids | 关联 Artifact，可为空 |
| idempotency_policy | 幂等与重复事件处理策略 |
| failure_policy | Hook 失败时的降级或恢复策略 |

#### Agent Runtime Binding

| 字段 | 描述 |
| --- | --- |
| runtime_binding_id | Agent Runtime Binding 唯一标识 |
| agent_type | Claude、Codex、Cursor Agent、Custom Agent 等 |
| binding_strategy | Harness Runtime Layer 在目标 Agent Runtime 中的绑定方式 |
| event_mapping | 目标 Agent Runtime 事实事件到统一 Runtime Event 的映射说明 |
| capabilities | 支持的能力，如 Skill 绑定、工具事件、文件事件、命令事件、运行上下文事件、确认交互 |
| status | 启用、禁用或实验状态 |

#### Plugin Composition Contract

| 字段 | 描述 |
| --- | --- |
| plugin_id | 稳定插件标识 |
| plugin_revision_id | 插件 revision 标识 |
| plugin_type | skill、workflow、hook、binding、runtime_extension 等 |
| provides | 对其他插件或 Runtime 提供的能力契约 |
| requires | 激活所需能力契约 |
| scope | 插件实例所属 scope |
| registration_effects | 插件动态注册产生的 Effect |
| disposer_refs | Effect disposer |
| composition_state | pending_dependency、active、suspending、replacing、disposed、failed |
| compatibility_policy | revision replacement 兼容策略 |
| created_at | 创建时间 |

### 7.2 公共数据库与项目隔离

Harness 的 Runtime Records 应统一存储在 Harness Global Data Home 下的公共数据库中。公共数据库面向同一 Harness 安装范围内的 Claude、Codex 和其他 Agent Runtime Binding 共享，不应在每个代码项目中创建 `.harness` 数据目录。

```text
Harness Global Data Home
└── Runtime Database
    ├── projects
    ├── project_clone_records
    ├── project_path_aliases
    ├── task_trees
    ├── task_tree_revisions
    ├── draft_change_sets
    ├── planning_decisions
    ├── plan_readiness_results
    ├── task_nodes
    ├── task_node_revisions
    ├── task_relation_edges
    ├── task_node_effects
    ├── task_node_replacements
    ├── trace_events
    ├── artifacts
    ├── artifact_relations
    ├── artifact_contracts
    ├── execution_attempts
    ├── evaluations
    ├── lifecycle_transition_policies
    ├── skill_candidate_revisions
    ├── skill_test_cases
    ├── skill_validation_runs
    ├── skill_validation_reports
    ├── failure_cases
    ├── failure_reproduction_revisions
    ├── reproduction_validation_results
    ├── runtime_actions
    ├── plugin_composition_contracts
    └── evolution_records
```

集中存储与数据可见范围必须分离：

- 公共数据库负责统一持久化和跨 Agent Runtime Binding 共享；
- 当前 Agent 工作目录规范化后的 `canonical_path` 负责解析 Project；
- Project Path 是 Task Tree、Trace、Artifact、Evaluation 和 Evolution 记录的强隔离依据；
- 查询接口默认必须携带当前 `project_id`，并在数据库层应用 Project 过滤条件；
- Agent Runtime 不得仅凭 Task Tree 标题或语义相似度跨 Project 返回候选；
- Windows 与 WSL 指向同一物理目录时，可通过 Project Path Alias 归属于同一 Project；
- `.agent-harness-project.json` 是稳定身份依据，但 marker 本身不扩大查询边界；查询和展示仍以 marker 所解析到的当前 `project_id` 为范围；
- Git remote 和仓库名称只能作为身份冲突诊断的辅助证据，不能自动覆盖当前目录与 Project Identity Marker 共同决定的 Project 边界；
- 同一有效 Project Identity Marker 出现在两个同时存在的 canonical_path 时，必须走 Project Clone，不得让两个目录共享一个可写 Project；
- marker 文件是项目身份元数据，不是项目内 Runtime Database；除该 marker 外，项目目录不得保存 Harness 私有运行数据副本。

公共数据库的具体技术选型不在本版 SRS 中确定，但实现必须支持事务、结构版本迁移、备份恢复和多 Agent 进程的并发访问。

## 8. 接口需求

### 8.1 Agent 执行接口

系统需要在 Agent Runtime 中获得执行过程的事实事件，包括用户消息、工具调用、命令执行、文件变化和结果反馈。

### 8.2 Agent Runtime Binding 接口

系统需要支持不同 Agent Runtime 通过 Agent Runtime Binding 绑定 Harness Runtime Layer。Binding 的作用不是隔离 Agent 和 Harness，也不是两个独立系统之间的数据通信层，而是让目标 Agent Runtime 具备 Harness Runtime Layer 的运行结构，并将运行过程中产生的事实事件规范化为统一 Runtime Event。

Agent Runtime Binding 可以基于 Hook、MCP、CLI Wrapper、日志监听、工具事件订阅或其他机制实现，但这些机制只是不同 Agent Runtime Binding 的实现方式，不应成为系统主架构中心。

### 8.3 Skill / Plugin 分发接口

系统需要支持将 Harness Skill、工作流规则和初始化指令分发到不同 Agent 环境。

不同 Agent 的分发方式可以不同，例如插件、扩展、配置文件、命令安装或手动同步，但同一 Skill 在不同 Agent 中应尽量保持一致语义。

### 8.4 工具事件接口

系统需要接收并分类以下工具事件：

- read_only；
- mutation；
- verification；
- external_side_effect。

### 8.5 Coding Constraint 接口

系统需要支持按 Runtime State、Task Node、execution_phase、Artifact 影响面和风险等级查询适用的 Coding Constraints。

Coding Constraint 接口不应被理解为外部审批接口，而是 Agent Runtime 在 coding 过程中识别当前应遵循规则的运行时能力。

### 8.6 Workflow State 接口

系统需要支持创建、查询和更新 Workflow State，包括 current_workflow、current_stage、allowed_actions、forbidden_actions 和 transition_rules。

Workflow State 接口用于让 Agent Runtime 明确当前应该处于哪一步，并为 Lifecycle Hooks 提供行为校验依据。

### 8.7 Lifecycle Hook 接口

系统需要支持通过 Lifecycle Hooks 接收和处理 Agent coding 过程中的关键事件，包括工具调用、文件变化、命令结果、测试结果、Git diff、用户确认、Plan Drift 和 User Change Request。

Hook 处理结果应能写入或更新 Trace Event、Artifact Graph、Runtime State、Evaluation 输入和 Evolution 候选。

### 8.8 Runtime Record 接口

系统需要支持查询和持久化 Runtime Records，包括 workflow_state、task_tree、trace、artifact、evaluation、experience、failure_case、failure_reproduction_revision、reproduction_validation_result 和 skill_candidate。

Runtime Record 接口必须读写 Harness 公共数据库，并根据当前 Agent 工作目录解析出的 project_id 强制限定查询范围。不同 Agent Runtime Binding 应共享同一套存储语义，不得各自在代码项目中维护彼此不可见的 `.harness` 数据副本。

### 8.9 任务查询接口

系统需要支持按当前 Project、Task Tree、Task Node、Execution Context、Artifact 查询任务和执行记录。Task Tree 候选查询必须先按 canonical_path 隔离 Project，再按显式 Tree ID / 名称、Artifact 路径、模块 / 符号、关键词、状态和更新时间执行确定性排序，并返回匹配依据。

Task Node 创建或更新接口应支持提交 Leaf Task Contract，并返回结构硬校验结果、错误字段和启发式警告。结构校验通过不代表语义判断通过；叶子边界仍需包含在用户确认的 Task Tree Revision 中。

任务查询必须支持以 Task Tree 为主导航的三档结果：Snapshot 返回树、当前节点、状态、阻塞项和风险计数；Summary 返回选中节点的一跳父子关系、Relation Edge 摘要、planned / actual Artifact 和最近 Evaluation；Detail 返回限定范围的 Trace、Evidence、revision 与历史 Attempt。默认查询不得展开整棵关系图或全部事实明细。

### 8.10 Artifact 查询接口

系统需要支持从 Artifact 查询相关任务、Trace、Evaluation 和 Failure Case。

Artifact 查询必须支持按 `granularity`、`artifact_type`、`artifact_status`、Task Node、规划 revision、Execution Attempt 和影响范围过滤。默认只返回当前 Task Tree 计划涉及、实际触及、Skeleton / 验收使用或 Failure Case 关联的 Artifact；只有显式请求时才扩大范围，不要求建立全项目 AST、符号表或调用图。

### 8.11 Evaluation 接口

系统需要支持对指定 Task Node Revision 与 Execution Attempt 发起评估，并返回不可变 Evaluation Result、required evidence coverage、missing evidence、风险和证据引用。

Evaluation 接口不得直接写入 Task Node Status。状态变化必须提交给 Lifecycle Transition Policy；接口需要返回转换是否适用、目标状态或拒绝原因。旧 revision 的 Evaluation 必须返回 `stale_evaluation`，不得推进当前节点。

### 8.12 Evolution 接口

系统需要支持从适用 Evaluation 序列生成 Experience、冻结 Skill Candidate Revision、Skill Test Case、Skill Validation Run、Skill Validation Report 和 Failure Case。

测试生成接口与测试评判接口必须分离。Holdout 生成接口不得接收 Skill Candidate 的完整 instruction snapshot；验证接口必须支持 no-skill baseline、skill-enabled、重复运行、Oracle evidence、token / tool usage 和副作用对比。Promotion 接口只能接受通过 Test Case Quality Gate 的案例。

### 8.13 用户交互接口

系统需要允许用户查看、确认、修正或拒绝任务结果、Skill 候选和 Failure Case。

### 8.14 Project Identity / Clone 接口

系统需要支持读取、创建、验证和原子改写 Project Identity Marker，并返回 `same_project`、`moved_or_renamed`、`copy_detected`、`new_project`、`identity_conflict` 等确定性解析结果。

Project Clone 接口必须在事务中创建目标 Project、复制允许克隆的数据、重写内部引用并生成 Project Clone Record。接口不得把源 Trace 复制成目标项目的新执行事实；必须明确区分 `source_provenance`、`inherited_evidence` 与 `target_execution_fact`。

### 8.15 Composition / Replacement 接口

系统需要支持注册和查询 Plugin / Task Node 的 `provides`、`requires`、composition state 与 owned effects，并能计算依赖影响闭包。

Task Node Replacement 接口必须支持 preview、confirm、execute、recover 四个阶段。preview 返回 contract diff、受影响节点和 Effect 风险；execute 只能在用户确认后进行；recover 必须优先恢复旧 revision，无法恢复时返回 `replacement_failed` 和人工处理证据。

### 8.16 Effect Disposal 接口

系统需要根据 Effect 分类返回 `auto_reversible`、`requires_baseline_check`、`compensation_only`、`manual_confirmation_required` 等处置能力。任何文件自动恢复都必须验证 owner、baseline hash / version 和后续写入冲突；外部不可逆 Effect 不得暴露自动 rollback 动作。

### 8.17 Task Tree Refinement 接口

系统需要支持对指定 tree、branch 或 subtree 执行 Plan Readiness Scan，返回 blocking issues、warnings、可解释的优先级依据和 recommended next issue。

系统需要支持以 `base_revision_id` 提交 Draft Change Set，并通过 optimistic revision check 防止并发讨论覆盖更新。局部 draft 变更可以直接应用；跨分支结构重构必须返回 preview 和影响范围。每次成功应用必须生成新 draft revision、Planning Decision Record 和 planning Trace Event。

Runtime Action 接口必须对 `action_type`、`target_id`、`expected_revision`、`risk_level` 和 confirmation requirement 进行代码校验。Agent 的自然语言判断只能提出动作，不得绕过接口直接提交关键 Runtime State。

### 8.18 Failure Case Reproduction 接口

系统需要支持从失败 Execution Attempt 创建 L0 Failure Case，为同一案例追加 manual、assisted、automated Reproduction Revision，并保留旧 revision 与验证证据。接口不得因复现方式变化而创建语义重复的 Failure Case。

人工复现验证必须检查前提、环境摘要、fixture、准备步骤、复现步骤、预期结果、实际失败、Oracle、清理步骤和证据完整性。自动化复现验证必须分别在 pre-fix baseline 与 post-fix baseline 上执行，并返回 RED、GREEN、Oracle 区分能力、重复稳定性和隔离性结论。

成熟度晋升接口只能根据 Reproduction Validation Result 确定性推进 L0-L4；达到 L4 必须满足修复前稳定 RED、修复后稳定 GREEN、Oracle 有区分能力、重复执行稳定且隔离充分。容器只能作为可选 isolation strategy，接口不得把容器可用性作为所有案例晋升的通用前提。

### 8.19 Tree-centered View Query 接口

系统需要提供统一的 Tree-centered 查询模型，供图形 UI、CLI 与 Agent 对话复用。接口至少支持 `snapshot`、`summary`、`detail` 三种深度，以及 selected node、one-hop relation、global relation overlay、relation type、risk、status、artifact granularity 等过滤条件。

默认响应以 Task Tree 为骨架，只突出阻塞、高风险、未确认依赖、关系循环和 Contract 缺失。全局 Relation Overlay 必须由调用方显式请求。返回结果必须包含稳定引用，以支持 Task Node、Artifact、Trace、Evaluation、Failure Case 和 Execution Attempt 之间的双向跳转。

## 9. 系统约束

- 优先支持 Bash 环境；
- 需要支持 WSL 场景下的 Windows 路径与 Linux 路径映射；
- 当前 Claude Code Binding 以 `2.1.251` 为最低兼容版本；模型切换事实依赖该版本引入的 `PostModelSwitch` Hook，旧版本不得被误报为完整支持；
- 初期以本地项目为主，不要求云端多用户协作；
- Runtime Records 必须集中存储在 Harness 公共数据库中，不得要求每个代码项目生成 `.harness` 数据目录；
- 允许每个 Project Root 存在一个 `.agent-harness-project.json` 最小身份文件；除此之外不得在项目中保存 Harness Runtime Records；
- 所有面向 Agent 的 Runtime 查询必须默认限定在当前 Project Path，不允许隐式跨项目检索；
- 首版组合运行时不得直接依赖 Cordis；核心 contract、effect、composition state 和 replacement 模型必须保持框架中立；
- 不绑定单一模型或单一 Agent；
- 不替代 Git 的版本管理职责；
- 不把 LLM 输出作为唯一事实来源；
- 首版 Artifact Graph 采用自适应粒度，不要求扫描并持久化全项目 AST、完整符号表或完整调用图；
- Failure Case 隔离策略必须按项目条件自适应，不强制所有项目安装或使用容器；
- 不要求首版具备自动 Skill 晋升的最终阈值策略。

## 10. 验收标准

| 模块 | 验收标准 |
| --- | --- |
| Project Path | 同一项目在 Windows/WSL 路径下能归属到同一 Project 或明确提示冲突 |
| 公共数据库 | Task Tree、Trace、Artifact、Evaluation、Evolution 等 Runtime Records 集中存储，并能被同一安装范围内的不同 Agent Runtime Binding 共享；代码项目中不生成 `.harness` 数据目录 |
| Project Identity Marker | Project Root 只生成一个不含 Runtime Records 和敏感数据的 `.agent-harness-project.json`；移动或重命名目录后仍能解析到原 `project_id` |
| Project Clone | 同一 marker 同时出现在两个仍存在的路径时，系统创建新 Project、改写复制目录 marker、克隆 Task Tree 与必要工程记忆并保留 provenance；源、目标随后可独立演进 |
| Clone 事实边界 | 源 Trace 不得出现在目标 Project 中冒充新执行事件；继承证据必须标记 `inherited_from_clone`，running / verifying 节点必须暂停或重新验证 |
| Project 数据隔离 | 切换到不同 Project Path 后，任务查询和候选展示不得返回前一 Project 的 Task Tree 或运行事实 |
| Task Tree | 能为一个项目维护多个独立 Task Tree |
| Task Tree 归属 | 每个 coding 请求都能查询已有 Task Tree，并在用户确认后新建 Task Tree 或归并到已有 Task Tree；不得静默归并 |
| Task Tree 候选检索 | 候选检索先按 canonical_path 限定当前 Project，再返回带 matched_by 等匹配依据的确定性排序结果；Agent 只提出建议，用户最终决定新建或归并 |
| Task Node | 能记录节点状态，并能追溯状态变化依据 |
| /taskroot | 用户能通过 `/taskroot [任务名称]` 强制新建并命名 Task Tree 根任务 |
| Task Tree 生成与确认 | 用户确认任务归属后，Agent 能生成完整初始 draft Task Tree，并在精炼后支持整树或按分支确认；未确认范围保持 draft 状态 |
| Task Tree Refinement Loop | 初始 draft 生成后能执行 Plan Readiness Scan；Agent 默认推荐影响最高的一个问题，用户可随时点名其他范围；每次结构变化形成局部 Draft Change Set、Decision Record 和新 revision |
| Plan Readiness Gate | 只有目标范围、未决问题、Leaf Contract、依赖、Artifact Contract、Skeleton 标准、高风险 Effect、验收条件和 required evidence 满足规则时，该范围才能进入确认 |
| 已确认节点修改 | 允许直接修改已有节点并生成新 revision；未完成的受影响范围回到 pending_user_confirmation，已完成的受影响节点进入 needs_revalidation，未受影响部分保持原状态 |
| Task Tree Revision | 每次结构修改都保留旧 revision、确认范围和历史执行证据，能够追溯 revision 之间的变化与影响范围 |
| 分支确认 | 用户确认分支后，关联 draft Artifact 能自动晋升为 planned |
| 混合确认状态 | 已确认与未确认分支可在同一 Task Tree 并存；父节点显示 partial_confirmed；调度器忽略未确认节点；已确认节点依赖未确认节点时进入 blocked_by_unconfirmed_dependency |
| 叶子节点 | Agent 能判断目标语义内聚性；每个叶子节点具有通过代码硬校验的 Leaf Task Contract，并由用户随 Task Tree 确认最终边界 |
| Leaf Task Contract | 能校验单一 objective、expected_outputs、acceptance_criteria、空 unresolved_questions / unresolved_decisions、有效 dependencies、required_evidence、execution_phase、stop_decomposition_reason 和无 children |
| 叶子节点完成证据 | 能区分规划阶段 required_evidence 与执行阶段 completion_evidence，只有实际证据覆盖规划要求且验收条件通过后才能将节点标记为 succeeded |
| 执行调度 | 能先执行已确认范围内的 skeleton 节点，再按分支深度执行 implementation 和 verification 节点；不得把叶子节点当作代码执行的起点 |
| Skeleton Acceptance Criteria | 每个已确认顶层分支都具有 expected_artifacts、required_contracts、verification_commands 和 readiness_conditions |
| Skeleton Gate | 只有所有已确认顶层分支的任务专属标准、基础结构验证、Hook 证据和 blocking Drift 检查均通过后，Workflow 才能自动进入 branch_implementation；失败或 uncertain 时不得越级 |
| Task Relation Edges | 能在 Task Tree 内记录和查询节点间 depends_on、calls、exchanges_data_with、shares_artifact_with、coordinates_with 等关系 |
| Relation Edge 展示 | 默认视图只展示 Task Tree 并提示阻塞、高风险、未确认依赖、关系循环和 Contract 缺失；用户能查看选中节点一跳关系并显式打开可过滤的全局 Relation Overlay |
| Relation Artifact 绑定 | calls、exchanges_data_with、shares_artifact_with 必须绑定有效 Artifact；depends_on、coordinates_with 能根据细分类确定是否必须绑定，并在 Plan Readiness Gate 阻止缺失的强关系 |
| 父子任务通信 | 子任务结果能被父任务结构化聚合 |
| Agent Runtime Binding | Claude、Codex 或自研 Agent Runtime 能通过兼容绑定机制具备 Harness Runtime Layer，并产生统一 Runtime Event |
| Skill / Plugin 分发 | 同一 Harness Skill 能以对应方式分发到至少两个不同 Agent 环境 |
| Skills / Workflows | 能通过 task-tree-planning、branch-execution、verification-reporting、drift-handling 等 Skill 约束 Agent 行为，并通过 coding-task-workflow 编排完整 coding task |
| Workflow State Machine | 能记录 current_workflow、current_stage、allowed_actions、forbidden_actions，并能被 Hooks 用于校验实际行为 |
| Runtime Records | 能持久化 workflow_state、task_tree、trace、artifact、evaluation、experience、failure_case、failure_reproduction_revision、reproduction_validation_result、skill_candidate 等记录 |
| 工具事件分类 | 能区分 read_only、mutation、verification、external_side_effect |
| Trace System | 能作为追加式事实源，从任务追溯到工具调用、文件变更、验证结果和能力沉淀依据；历史事件不会被当前 Artifact 状态覆盖 |
| Artifact Graph | 能作为 planning revision 与 Trace 的当前状态投影，展示任务计划和实际影响的工程资产，并能追溯到 source Trace / planning revision |
| Artifact 自适应粒度 | Structural Artifact 默认建立；跨任务接口、Schema、事件、协议和命令约定建立 Contract Artifact；只有定位、验收、失败复现或影响分析需要时才建立 Symbol Artifact |
| Artifact 范围 | 默认只记录计划涉及、实际触及、Skeleton / 验收使用或 Failure Case 关联的资产；首版无需扫描并持久化全项目 AST、符号表或调用图 |
| Trace / Artifact 去重 | 工具输入输出、diff 和时间事实只保存在 Trace / Evidence；当前资产身份、状态与关系只保存在 Artifact Graph；任一侧通过引用关联另一侧 |
| Plan Drift | 当实际执行与 planned Artifact 出现关键偏移时，能记录 plan_drift Trace Event 和 Plan Drift Record |
| Plan Drift Severity | 能区分 info、warning、blocking；blocking drift 能暂停当前 Task Node 或分支，并要求 Agent 给出推荐方案等待用户确认 |
| User Change Request | 能将执行中用户主动提出的 minor_change、scope_change、priority_change 记录为独立事件，并与 Plan Drift 区分 |
| Runtime Native Commands | slash command 能通过原生命令注册表触发对应 Runtime Flow，不依赖 LLM 猜测 |
| Harness Runtime Skill | 能通过 Skill description / trigger rules 在任务规划、分支执行、Plan Drift、User Change Request、运行时状态查询等场景触发 |
| Runtime Introspection Tools | Agent 能按需查询 Runtime State、当前任务、Task Tree、Artifact Graph、等待事项、Plan Drift 和 User Change Request，并支持 Snapshot、Summary、Detail 三档粒度 |
| Runtime Confirmation Prompt | 需要用户确定性选择时，能以 Yes / No / 自定义选项形式发起确认，并记录用户选择 |
| Runtime State Safety Rules | 能定义确认分支、取消分支、接受 blocking drift、应用 scope_change 等高风险状态变化必须触发确认 |
| Runtime Action 提交边界 | 自然语言只能产生结构化 Runtime Action；代码依据 expected revision 和 Safety Rules 原子提交、请求确认或拒绝；短回复不会在多个或零待确认项时产生新授权 |
| Coding Constraints | 能按 planning、execution、reporting 三类约束影响 Agent 的任务拆分、执行、验证和汇报行为 |
| Lifecycle Hooks | 能从工具调用、文件变化、命令结果、测试结果、用户确认等事件同步生成 Trace、Artifact、Runtime State 或 Evaluation 输入 |
| 空间可组合性 | Plugin 与 Task Node Revision 能通过稳定 ID、provides / requires contracts 解析依赖；provider 缺失时依赖者进入 pending_dependency，provider 恢复后能够重评估并恢复或进入 needs_replanning |
| 时间可组合性 | Plugin / Task Node Revision 的 Effect 由生命周期 owner 管理，卸载或替换时只处置 ownership 和安全条件均满足的 Effect |
| Task Node Replacement | replacement 能生成 candidate revision、展示影响闭包并请求确认，按逆依赖顺序挂起、处置、激活、重评估；失败时恢复旧 revision 或明确进入 replacement_failed |
| Effect 分类 | reversible、version_reversible、compensatable、irreversible 四类均有不同处置策略；共享文件冲突和不可逆外部动作不会被自动回滚 |
| 框架中立 | 未安装 Cordis 时首版核心组合、Effect 和 replacement 验收仍全部通过；未来 Binding 不改变领域模型 |
| Evaluation | 能针对指定 Task Node Revision 与 Execution Attempt 输出不可变评估事实；旧 revision、证据不足或 uncertain 结论不得把当前节点标记为成功 |
| Lifecycle Transition Policy | 能依据 Evaluation、revision、required evidence、依赖和 blocking drift 确定性推进 Task Node；状态变化能追溯到 policy version 和 Evaluation |
| 多次执行尝试 | 同一节点的 failed、failed、succeeded 等 Execution Attempt 与 Evaluation 序列全部保留，不被最后一次成功覆盖 |
| 父节点评估 | 必要子节点完成后仍需执行父级目标、契约和集成评估；不得仅通过子节点状态聚合直接成功 |
| Evolution | 同一节点任务中经历 2 次及以上失败后的成功，能进入 Skill 候选流程 |
| Skill Test Case Quality | AI 生成案例能通过 schema、fixture isolation、failure reproduction、Oracle、discrimination、stability 与 holdout classification Gate |
| Skill Validation Splits | 每个候选至少包含 real failure replay、variation、independent holdout 和 negative applicability；Holdout 在候选 revision 冻结后生成且不接收完整 Skill 内容 |
| Skill Baseline 对照 | 同一测试能执行 no-skill baseline 与 skill-enabled runs，并比较成功率、误触发、高风险副作用、工具调用、token 和稳定性 |
| Skill 晋升硬门槛 | Failure Replay、独立 Holdout、Negative Applicability、无高风险副作用和测试区分能力任一不满足时不得晋升 |
| Failure Case 成熟度 | 同一 Failure Case 能从 L0 observed 经 L1 manual、L2 assisted、L3 automated 推进到 L4 regression；人工与自动复现作为不可变 Reproduction Revision 保留，不创建重复案例 |
| Failure Case 结构化复现 | L1 及以上包含前提、环境、fixture、准备、复现、清理、预期、实际失败、Oracle 和证据；缺失关键字段时不得宣称已验证复现 |
| Failure Case RED / GREEN | L4 晋升必须以同一 Reproduction Revision 证明 pre-fix 稳定 RED、post-fix 稳定 GREEN、Oracle 具有区分能力且重复执行稳定 |
| Failure Case 隔离 | 能根据项目选择 fixture、worktree、临时目录、项目原生测试环境、容器或虚拟环境；未使用容器不构成通用失败条件 |
| Execution Context | 清理运行上下文记录不删除 Experience、Skill、Failure Case 和测试案例 |
| Tree-centered 查询 | Snapshot、Summary、Detail 三档都以 Task Tree 为导航骨架；能在 Task Node、Artifact、Trace、Evaluation、Failure Case 和 Attempt 之间双向定位，默认不加载整图或全部证据 |
| 查询 | 能从任务查资产，也能从资产查任务 |

## 11. 风险分析

| 风险 | 影响 | 应对方式 |
| --- | --- | --- |
| 过度依赖 LLM 判断任务 | 状态不稳定、难以复现 | 基础状态迁移使用确定性规则 |
| 未确认 Task Tree 分支就开始执行 | 用户失去对计划的控制 | Task Tree 分支必须经用户确认后才能执行该分支下会修改项目的任务节点 |
| coding 请求未进入 Task Tree Workflow | Agent 在普通请求中绕过用户定义的工程方法 | 所有具有工程变更目标的 coding 请求必须先完成 Task Tree 新建或归并确认及计划确认 |
| Agent 静默归并到错误 Task Tree | 任务边界和 Trace 归属错误 | Agent 只能提出新建或归并建议，最终归属由用户确认 |
| 修改已有节点覆盖历史 | 已完成事实、确认基准和影响范围无法追溯 | 每次结构修改生成新 revision，保留旧 revision，并计算 affected scope |
| 初始 Task Tree 直接进入确认 | 粗略树缺少边界、契约和验收细节，用户只能整体接受或反复推翻 | 生成初始全量 draft 后进入问题驱动的 Refinement Loop，并用 Plan Readiness Gate 控制确认 |
| 精炼循环逐节点机械询问 | 大型 Task Tree 产生大量低价值问题 | 根据跨分支影响、阻塞范围、风险和未决项计算优先级，每轮只讨论一个高影响问题，且允许用户覆盖方向 |
| 每次讨论重新生成整棵树 | 已确定内容丢失，难以追溯具体变化 | 使用基于 base revision 的局部 Draft Change Set 和 immutable draft revisions |
| 直接从叶子节点开始写代码 | 上层结构、接口和依赖尚未建立，导致下层实现缺少边界并产生返工 | 分支确认后必须先执行已确认范围内的 skeleton 节点，再进入分支 implementation |
| Task Tree 和 Artifact Graph 混淆 | 计划结构与资产关系边界不清 | Task Tree 表达计划，Artifact Graph 表达工程资产 |
| Task Tree 拆分过细或过粗 | 执行效率下降或验收困难 | 使用叶子节点停止条件约束拆分粒度 |
| 执行顺序失控 | 同时修改多个方向导致中间状态不稳定 | 使用 execution_phase、depends_on 和分支深度执行约束调度 |
| 跨分支交互未显式建模 | 分支并行开发后接口、数据结构或调用方式不一致 | 使用 Task Relation Edges 标记调用、数据交换和共享资产关系，并在 Artifact Graph 中记录接口、Schema、模块或测试等计划态 Artifact |
| Task Relation Edges 过度泛化 | Task Tree 退化成难以理解的复杂图 | 默认视图仍以 Task Tree 为主，只提示关键异常；一跳关系和全局 Relation Overlay 按需展示并支持过滤 |
| 所有 Relation Edge 都强制建立 Artifact | 调度或弱协作关系被过度建模，规划成本失控 | 使用 relation-to-artifact 矩阵；calls、exchanges_data_with、shares_artifact_with 强制绑定，depends_on 与 coordinates_with 按细分类判断 |
| 强跨分支关系未绑定 Artifact | 调用、数据交换和共享边界只有自然语言描述，无法独立实现和验证 | Plan Readiness Gate 校验强关系的 Artifact、provider / consumer 职责和验证方式 |
| 执行过程偏离计划但未被发现 | Agent 边做边改计划，导致用户以为仍在执行原计划 | 将关键 Artifact 偏移记录为 plan_drift，并在验证或汇报阶段提示 |
| 频繁中断影响执行体验 | 轻微偏移也暂停会让 Agent 难以连续工作 | 只有 blocking drift 暂停；info 只记录，warning 汇报提示 |
| blocking drift 只抛问题不给方案 | 用户需要额外分析偏移原因和处理方式 | blocking drift 必须生成 Drift Explanation 和 Agent 推荐方案 |
| 用户主动变更被误判为 Agent 偏移 | 责任来源混淆，后续评估和追责不准确 | 将用户主动修改目标、范围、优先级、Artifact 或验收标准记录为 User Change Request，而不是 Plan Drift |
| 用户 scope_change 未暂停确认 | Agent 按过期计划继续执行，造成返工 | scope_change 必须生成 Change Impact，并在需要时等待用户确认 |
| 用户 priority_change 丢失当前状态 | 切换任务后无法恢复原执行现场 | priority_change 只更新调度队列，当前 Task Node 状态必须保留 |
| 将 Runtime 交互设计成外部输入拦截器 | Agent Core 与 Harness Runtime Layer 被实现成两个割裂系统 | 使用 Runtime Interaction Loop、Harness Runtime Skill、Runtime Introspection Tools 和 Runtime Confirmation Prompt 表达内生运行时 |
| slash command 被当作普通自然语言 | 原生命令行为不稳定，依赖模型猜测 | Runtime Native Commands 通过命令注册表直接处理 |
| Agent 判断直接修改关键状态 | 模糊输入导致误确认、误取消或误执行 | 高风险状态变化必须按 Runtime State Safety Rules 触发 Runtime Confirmation Prompt |
| 短回复绑定错误确认项 | “可以”“继续”在多个等待事项中导致误授权 | 只有唯一 pending confirmation 时允许绑定；否则要求用户明确选择 |
| Runtime Introspection Tools 返回过多上下文 | 普通交互消耗大量 token，甚至重新形成隐性上下文注入 | 默认使用 Snapshot，Summary 和 Detail 按需调用；大结果必须支持 limit、cursor、filter |
| 约束系统未真正影响 Agent coding 行为 | Harness 退化为事后记录工具，无法让 Agent 按用户工程方法工作 | 将 Coding Constraints 绑定到任务规划、执行、验证、汇报关键阶段，并在验收中检查约束是否改变行为 |
| Workflow 只是文档没有状态机 | Agent 可能跳阶段执行，Hooks 无法判断行为是否违规 | 维护 Workflow State Machine，明确 current_stage、allowed_actions、forbidden_actions 和 transition_rules |
| Skill 与 Workflow 混淆 | Skill 过大或 Workflow 过碎，导致 Agent 不知道该按哪个规则行动 | 明确 Skill 是局部能力入口，Workflow 是端到端阶段编排 |
| Hooks 漏记关键事件 | 生命周期记录不完整，Evaluation 和 Evolution 缺少事实依据 | 定义基础 Hook 类型、事件 schema、幂等策略和失败降级策略 |
| 将 Hooks 理解为外部监控 Agent | 实现重新变成割裂的监管系统 | 明确 Hooks 监听 coding 生命周期事件，不监控 Agent 本体 |
| 骨架任务空转 | 只创建空文件或占位，不产生真实工程价值 | skeleton 节点必须定义结构、边界、接口或测试入口，并可被 Trace 与 Artifact 证明 |
| Agent 主观声明 Skeleton 完成 | 分支在结构和共享契约未就绪时进入实现，导致返工 | 使用任务专属 Skeleton Acceptance Criteria，并由 Hooks 提供 Artifact、命令和验证证据驱动 Skeleton Gate |
| Artifact Graph 设计过重 | 首版难以落地，采集与维护成本超过收益 | 使用 structural 默认、contract 必需、symbol 按需的自适应粒度；只记录计划涉及、实际触及和验证相关资产，不做全仓 AST / 调用图索引 |
| Artifact 粒度过粗 | 跨分支契约或具体失败位置无法定位 | 跨任务边界强制提升到 contract 粒度；验收、失败复现和影响分析需要时再提升到 symbol 粒度 |
| 辅助视图彼此割裂 | 用户在 Task、Artifact、Trace 和 Evaluation 之间丢失上下文 | 以 Task Tree 为导航骨架，采用 Snapshot / Summary / Detail 渐进披露和稳定双向引用 |
| Trace 数据过多 | 查询困难、存储膨胀 | 区分原始记录和结构化摘要 |
| Trace 与 Artifact 边界不清 | 事实记录和资产关系重复维护 | Trace 作为追加式时间事实源，Artifact Graph 作为可重建的当前状态投影；通过 ID 和 source reference 关联而不复制内容 |
| Evaluation 证据不足 | 错误判断任务成功 | 支持 uncertain 结论 |
| Evaluation 直接等同 Task 状态 | 旧 revision 或单次评估错误推进当前任务 | Evaluation 绑定 revision 与 attempt，由代码层 Lifecycle Transition Policy 校验适用性、证据、依赖和 drift 后推进状态 |
| 最后一次成功覆盖历史失败 | Evolution 无法识别真实修复过程 | Execution Attempt 和 Evaluation Result 只追加不覆盖，保留完整 failed → succeeded 序列 |
| 父节点由子节点自动成功 | 跨分支集成问题没有被验证 | 父节点必须产生独立的父级 Evaluation 并验证目标、契约和集成条件 |
| AI 生成测试并自行判定有效 | 测试与 Skill 共同过拟合或形成自证循环 | 分离生成与评判，使用独立 Oracle、真实执行、Baseline 对照和冻结后 Holdout |
| 测试无区分能力 | 无论实现是否正确都通过 | 执行 discrimination validation，故意破坏关键行为后测试必须失败 |
| Skill 在不适用场景误触发 | Agent 产生无关修改或风险 | 强制 Negative Applicability Cases，并将误触发和副作用作为晋升硬门槛 |
| Skill 过早晋升 | 错误经验污染后续任务 | Skill 晋升必须基于验证 |
| 只停留在静态 Skill 框架 | 无法体现 Harness 的长期进化价值 | Runtime、Trace、Evaluation、Evolution 必须成为核心闭环 |
| 多 Agent 分发语义不一致 | 同一 Skill 在不同 Agent 中行为偏差 | 为 Skill 定义统一语义，再由 Agent Runtime Binding 做平台绑定与转译 |
| Failure Case 不可复现 | 无法形成回归价值 | 使用 L0-L4 成熟度与结构化 Reproduction Revision，允许从观察事实逐步推进到稳定自动回归 |
| 自动复现只验证修复后通过 | 恒真测试或错误 Oracle 被误认为有效回归 | L4 必须同时证明 pre-fix RED、post-fix GREEN，并执行 Oracle discrimination validation |
| 人工复现仅保存自由文本 | 环境、步骤和判定标准缺失，无法自动化或移交 | L1 起强制保存前提、环境、fixture、步骤、Oracle、清理和证据字段 |
| 强制使用容器复现 | 简单项目接入成本过高，或受限环境无法运行 | 隔离策略按 fixture、worktree、临时目录、项目原生环境、容器或虚拟环境自适应选择 |
| 多任务交叉混淆 | Trace 和结果归属错误 | Task Node 与 Trace Event 必须显式关联 |
| 路径识别错误 | 同一项目被拆成多个 Project | 路径规范化并结合 Git 信息 |
| 公共数据库发生跨项目数据泄漏 | Agent 在当前项目看到其他路径的 Task Tree 或 Trace，造成错误归并和上下文污染 | 所有 Runtime 查询必须先根据 canonical_path 解析 project_id，并在数据库层强制应用 Project 过滤条件 |
| 在每个项目生成运行时数据目录 | 污染代码仓库，并导致多个 Agent 产生彼此割裂的数据副本 | Runtime Records 只写入 Harness 公共数据库，项目目录不创建 `.harness` |
| Project marker 被复制后共享同一可写身份 | 两个目录的 Task、Trace 和 Artifact 相互污染 | 检测旧路径是否仍存在；若同时存在则执行 Project Clone、生成新 project_id 并改写复制目录 marker |
| Project Clone 复制 Trace 事实 | 目标项目出现从未执行过的工具调用和成功证据 | Trace 只保留 provenance 引用；继承证据显式标记，目标项目重新验证 |
| Clone 过程中数据库与 marker 部分成功 | 产生孤儿 Project 或错误身份 | 使用数据库事务、incomplete Clone Record 和启动恢复流程；事务未完成前不提交 marker 改写 |
| Task Node replacement 原地覆盖 | 历史计划、完成事实和失败恢复点丢失 | 使用稳定 task_node_id + 不可变 revision + Replacement Record |
| 自动回滚覆盖其他节点修改 | 共享文件或 Artifact 的后续工作丢失 | version_reversible Effect 必须校验 owner、baseline hash / version 和后续写入；冲突转人工处理 |
| 把补偿误当回滚 | 外部系统状态无法真正恢复但被错误标记成功 | 明确 compensatable 与 irreversible；记录残余影响，不声明恢复原状 |
| 直接绑定 Cordis 导致运行时锁定 | 多 Agent 适配和领域模型受第三方框架约束 | 仅借鉴 CORDIS-like 语义，首版实现框架中立 contract / effect / composition state；Cordis 仅可作为未来 Binding |
| 叶子语义完全交给代码判断 | 启发式规则无法可靠识别自然语言中的多个工程目标 | Agent 负责语义内聚判断，代码只执行 Leaf Task Contract 硬校验和启发式警告，用户确认最终边界 |

## 12. Agent 设计需求

### 12.1 Agent 角色定义

Agent Core 是执行软件工程任务的智能主体，负责理解用户目标、探索项目、拆解任务、调用工具、修改资产、运行验证和汇报结果。

Harness Runtime Layer 不是替代 Agent Core，也不是外部管理系统，而是 Agent Runtime 中提供 coding 约束、生命周期 Hooks、长期结构、事实记忆、结果评估和经验进化能力的运行层。

### 12.2 Agent Runtime Binding 设计需求

Agent Runtime Binding 是不同 Agent Runtime 的兼容绑定机制，用于将 Harness Runtime Layer 绑定到目标 Agent 环境。Binding 是兼容机制，不是系统边界，也不是 Agent 与 Harness 两个独立系统之间的数据通信桥梁。

不同 Agent Runtime 可以通过不同方式绑定 Harness Runtime Layer：

- Claude Runtime 可以通过 Hook、CLI Wrapper、CCR、MCP、Skill 或日志事件实现绑定；
- Codex Runtime 可以通过工具事件、运行上下文事件、Skill 或运行时事件获得能力绑定；
- 自研 Agent Runtime 可以原生实现 Harness Runtime Layer；
- 未来新的 Agent Runtime 只需要实现对应 Agent Runtime Binding，不应修改 Harness Runtime Layer 的核心语义。

Agent Runtime Binding 的职责是：

- 将 Harness Runtime Skill、Runtime Introspection Tools、Runtime Confirmation Prompt 等能力映射到目标 Agent 环境；
- 将目标 Agent Runtime 内产生的工具调用、文件事件、命令结果和运行上下文规范化为统一 Runtime Event；
- 标记 Agent 类型、运行上下文、工具调用、文件事件和命令结果；
- 屏蔽具体 Agent Runtime 的私有协议差异；
- 保持 Harness Runtime Layer 的核心语义在不同 Agent 环境中一致。

Agent Runtime Binding 不应成为系统架构中心，也不负责 Task Tree 生命周期判断、Evaluation 结论或 Skill 晋升。它只负责兼容绑定与事件规范化。

### 12.3 Prompt 设计需求

Agent 的提示词需要强调：

- 执行任务时保持 Task Tree 意识；
- coding 过程中应遵守 Planning、Execution、Reporting Constraints；
- 工具调用和项目变化会进入 Trace 事实记忆层；
- 工具调用、文件变化、测试结果和用户确认会触发 Lifecycle Hooks；
- 成功声明必须有验证依据；
- 失败和阻塞也需要明确记录；
- 不应将普通聊天伪装成任务完成；
- 不应绕过 Harness Runtime Layer 的事实记忆和安全边界。

### 12.4 Skill 设计需求

Harness Skill 是 Agent 行为约束和能力复用的载体，产品形态上参考 Superpowers 的可组合 Skill 框架。

Skill 应描述：

- 适用场景；
- 触发条件；
- 行为原则；
- 输入输出；
- 验证方式；
- 风险边界；
- 与 Trace、Artifact、Evaluation 的关系。

Skill 不应只是一次成功操作的记录。它必须能被后续任务触发、执行和验证，并且要能追溯到来源 Experience 和 Evaluation。

Harness Runtime Skill 是 Agent 使用 Harness Runtime Layer 的行为规范入口。它应通过 Skill 自身的 `description` / trigger rules 描述触发条件，而不是依赖外部提示词手动提醒。其触发条件应覆盖任务规划、已确认分支执行、Coding Constraints、Lifecycle Hooks、运行时状态查询、User Change Request、Plan Drift、Artifact Drift、分支确认、等待事项处理和 Runtime Introspection Tools 使用决策。

当目标 Agent 环境支持 Skill 机制时，应优先使用 Skill 原生机制触发 Harness Runtime Skill。当目标 Agent 环境不支持 Skill 机制时，才由 Agent Runtime Binding 提供等效的运行时规则绑定方式。

首版 Harness Plugin 至少应包含以下 Skill：

- `task-tree-planning`：负责 draft Task Tree、叶子节点边界、分支确认；
- `branch-execution`：负责 skeleton → implementation → verification 的分支执行；
- `verification-reporting`：负责根据 Trace、Artifact、Evaluation 汇报结果；
- `drift-handling`：负责 Plan Drift、Artifact Drift、User Change Request 的处理建议和确认流程。

这些 Skill 不直接替代 Workflow。Skill 是局部场景能力，Workflow 是完整 coding task 的阶段编排。

### 12.5 Tool 设计需求

工具设计应支持 Agent Runtime 将以下事实事件交给 Lifecycle Hooks 处理，并纳入 Trace 事实记忆层：

- 文件读取；
- 文件修改；
- 命令执行；
- 测试和构建；
- Git 操作；
- 外部副作用操作；
- 用户确认。

工具事件需要尽量结构化，便于 Lifecycle Hooks 触发 Trace 记录、Artifact 更新、Evaluation 输入和 Runtime State 更新。

Runtime Introspection Tools 属于 Agent 主动查询运行时状态的工具能力，应支持按需查询，而不是每轮预注入完整上下文。Runtime Confirmation Prompt 属于用户确认交互能力，应支持明确选项、用户选择记录和后续 Runtime Flow 关联。

Runtime Introspection Tools 应共享 Tree-centered View Query 的信息层次：默认使用 Task Tree Snapshot，选中节点后按需请求 Node Context Summary，只有诊断、复现、审核或争议处理时才请求 Evidence Detail。关系查询默认限制为 selected node 的一跳范围；全局 Relation Overlay 必须显式开启。

### 12.6 Memory 设计需求

Agent Runtime 的长期工程记忆由以下结构组成：

- Project；
- Task Tree；
- Trace Event；
- Artifact Graph；
- Evaluation Result；
- Experience；
- Skill；
- Failure Case。

聊天上下文不是唯一记忆来源。长期记忆必须能够脱离单次 Agent 运行上下文存在。

### 12.7 Workflow 编排需求

Agent Runtime 工作流应遵循以下顺序：

```text
接收 coding 请求并查询已有 Task Tree
  ↓
提出新建或归并建议，等待用户确认任务归属
  ↓
应用 Planning Constraints
  ↓
探索项目并与用户讨论需求细节
  ↓
生成完整 draft Task Tree、draft Artifact Graph 和 Skeleton Acceptance Criteria
  ↓
Task Tree Refinement Loop：扫描未决问题并按影响优先级逐项讨论
  ↓
局部 Draft Change Set → Decision Record → 新 draft revision
  ↓
待确认范围通过 Plan Readiness Gate
  ↓
展示 Task Tree 节点架构图，等待用户确认整棵树或选定分支
  ↓
Skeleton Pass：在已确认范围内搭建整体骨架
  ↓
应用 Execution Constraints，并通过 Lifecycle Hooks 记录工具和文件事件
  ↓
Skeleton Gate：依据已确认标准和 Hook 事实证据判断是否允许进入实现
  ↓
Branch Deep Implementation：选择一个已确认分支深度实现
  ↓
Branch Verification：验证该分支
  ↓
Parent / Root Verification：聚合并验证父级或根任务
  ↓
执行过程中由 Lifecycle Hooks 同步维护 Trace / Artifact / Runtime State
  ↓
基于运行事实执行 Evaluation
  ↓
成功路径沉淀 Experience / Skill Candidate
  ↓
失败路径创建或更新 Failure Case：L0 observed → L1 manual → L2 assisted → L3 automated → L4 regression
```

其中 Task Tree Refinement Loop 采用问题驱动的局部精炼：Agent 默认推荐影响最高的下一项讨论内容，用户可以随时点名其他分支；每次结构性讨论结论只修改受影响范围，并形成 Draft Change Set 与新 revision。Plan Readiness Gate 按待确认范围判断，只有就绪范围才能进入 branch_confirmation。

Skeleton Pass 作用于全部已确认范围内的结构性任务；Implementation 和 Verification 以分支为单位深度推进。Skeleton Gate 以任务专属验收标准为判断基准，以 Lifecycle Hooks 采集的 Artifact、文件、命令和验证结果为事实证据，默认自动判断阶段迁移；只有失败、blocking Drift 或无法判断时才请求用户处理。所有阶段都只能在已确认范围中执行，并且需要遵守 `depends_on` 依赖关系。Coding Constraints 约束 Agent 在各阶段应该如何行动；Lifecycle Hooks 记录 Agent 实际做了什么。Trace、Artifact 和 Runtime State 不是执行结束后的旁观记录，而是 Agent Runtime 执行过程中由 Harness Runtime Layer 同步维护的工程记忆。

Workflow State Machine 应维护以下内容：

```text
current_workflow
current_stage
allowed_actions
forbidden_actions
transition_rules
next_stages
```

例如在 `draft_task_tree` 阶段：

```text
允许：读取文件、询问用户、更新 draft Task Tree
禁止：修改项目文件、执行 mutation command、进入 implementation
下一步：task_tree_refinement
```

例如在 `task_tree_refinement` 阶段：

```text
允许：查询 draft、运行 Plan Readiness Scan、向用户提出一个聚焦问题、应用局部 Draft Change Set
禁止：修改项目文件、跳过 blocking issue、确认未达到 Plan Ready 的范围
默认选择：按影响优先级推荐下一项讨论内容
用户覆盖：用户可以随时点名其他分支、节点或决策
下一步：继续 task_tree_refinement 或 branch_confirmation
```

例如在 `skeleton_gate` 阶段：

```text
允许：读取 Skeleton Acceptance Criteria、聚合 Hook 证据、运行声明过的结构验证命令
禁止：进入 branch_implementation、将缺少证据的分支标记为 skeleton_ready
自动通过：所有已确认顶层分支通过任务专属标准，且不存在 blocking drift
需要用户处理：Gate failed、Gate uncertain 或出现 blocking drift
下一步：branch_implementation
```

Agent 成功走完整个 Workflow 依赖以下机制：

```text
Skill 让 Agent 知道当前场景下应该怎么做
Workflow State Machine 让系统知道现在处于哪一步
Lifecycle Hooks 检查 Agent 实际行为是否符合当前阶段
Runtime Records 保存 workflow 状态和生命周期事实
```

首版 Runtime Records 也必须写入 Harness 公共数据库，不使用项目内文件目录作为主存储：

```text
Harness Global Data Home
└── Runtime Database
    ├── Project / Project Path Alias
    ├── Project Clone Record
    ├── Workflow State
    ├── Task Tree / Revision / Draft Change Set / Planning Decision / Plan Readiness
    ├── Task Node / Task Node Revision / Leaf Task Contract
    ├── Execution Attempt / Trace / Artifact / Artifact Contract / Evaluation
    ├── Lifecycle Transition Policy
    ├── Runtime Action / Task Node Effect / Replacement Record / Plugin Composition Contract
    └── Experience / Failure Case / Reproduction Revision / Reproduction Validation / Skill Candidate Revision / Skill Test / Validation Report
```

Agent Runtime Binding 在启动时以当前工作目录和 Project Identity Marker 解析 Project，并将 `project_id` 注入后续 Hook 写入和 Runtime 查询。集中存储不能带来跨项目可见性：当前 marker 所解析出的 Project 仍然是检索、展示和候选树筛选的唯一默认范围。

### 12.8 Agent 评测指标

系统后续可围绕以下指标评估 Agent 和 Harness：

- 任务完成率；
- 验证通过率；
- Trace 完整度；
- Artifact 影响面准确率；
- Evaluation 结论准确率；
- Experience 复用价值；
- Skill 触发准确率；
- Failure Case 复现率；
- 多任务归属准确率；
- 用户纠错次数。

### 12.9 Composition 与 Replacement 设计需求

Agent 在规划 Task Tree 时，应把跨节点接口、Schema、命令和数据交换约定写入 Artifact Graph，并由 Task Node Revision 通过 `provides_contracts` / `requires_contracts` 引用。Agent 不需要学习某个依赖注入框架的 API，但必须遵循以下行为规范：

- provider 缺失时，不得假设依赖已经满足；
- 修改已确认节点时，先生成 candidate revision 和 contract diff；
- replacement 前向用户说明受影响范围、可回滚性与不可逆风险；
- replacement 期间不得并发执行受影响依赖者；
- candidate 激活后必须重新验证依赖者；
- 失败恢复不能删除旧 Trace、Evaluation 或 Effect 处置事实；
- 不得把 compensation 描述为完全 rollback。

Lifecycle Hooks 应将 contract provider 变化、composition state 迁移、Effect 创建与处置、replacement 各阶段和恢复结果写入 Trace Fact Memory。代码层状态机负责依赖解析、Effect 分类与合法迁移；Agent 负责理解变更目的、解释影响、提出方案和与用户确认，不得让 LLM 单独决定文件是否可以安全回滚。

## 13. 附录

### 13.1 术语说明

| 术语 | 说明 |
| --- | --- |
| Project | 由项目路径确定的长期项目空间 |
| Project Identity Marker | 位于 Project Root 的 `.agent-harness-project.json` 最小身份文件，只保存 schema version、稳定 project_id 和 identity token，不保存 Runtime Records |
| Project Clone | 目录复制时创建新 project_id、复制允许继承的 Task Tree 与工程记忆并保留来源关系的事务；源与目标此后独立演进 |
| Harness Global Data Home | Harness 的公共数据目录，用于存放集中式 Runtime Database，不属于任何单个代码项目 |
| Runtime Database | 集中持久化 Task Tree、Trace、Artifact、Evaluation、Evolution 等 Runtime Records 的公共数据库 |
| Project Path Alias | Windows、WSL 等不同运行环境中指向同一物理项目目录的规范化路径别名 |
| Coding Constraint Runtime | 面向 Coding Agent 的约束运行时，用于规定 Agent 在规划、执行、验证和汇报时应遵循的工程方法 |
| Coding Constraint | Agent coding 过程中的运行时约束规则，分为 Planning、Execution、Reporting 等类型 |
| Planning Constraint | 约束任务拆分、确认边界、停止拆分条件和执行授权的规则 |
| Execution Constraint | 约束代码修改、工具调用、分支执行、测试验证和成功声明的规则 |
| Reporting Constraint | 约束结果汇报、阻塞说明、风险提示和证据引用的规则 |
| Lifecycle Hook | Agent coding 生命周期中的事件触发机制，用于将工具调用、文件变化、测试结果、用户确认等事件转化为事实记录 |
| Task Collection | 一个 Project 下所有 Task Tree 的集合 |
| Task Tree | Workflow-first、Runtime-recorded 的任务结构；首先是 Agent coding workflow 约束，随后作为 Runtime Record 保存结构化状态 |
| Task Tree Refinement Loop | 初始完整 draft 生成后，以高影响问题为驱动、通过局部 Change Set 和逐轮讨论将指定范围推进到 Plan Ready 的精炼循环 |
| Draft Change Set | 基于指定 draft revision 对 Task Node、Relation、Artifact、Contract 或验收条件执行的结构化局部变更集合 |
| Planning Decision Record | 保存讨论主题、可展示选项、Agent 建议、用户决定、影响范围与变更结果的记录，不包含隐藏思维链 |
| Plan Readiness Scan | 对 tree、branch 或 subtree 的未决问题、契约、依赖、验收和风险进行确定性检查并推荐下一讨论项 |
| Plan Readiness Gate | 决定某个范围是否可以进入用户确认的规划阶段门禁 |
| Task Node | Task Tree 中的一个任务节点 |
| Task Node Revision | 保持稳定 task_node_id 前提下的一版不可变节点定义，包含 provides / requires contracts、owned effects、执行与组合状态 |
| Tree Edge | Task Node 的父子关系，用于表达任务归属和拆解层级 |
| Task Relation Edge | Task Tree 内部的跨节点关系边，用于表达执行依赖、调用关系、数据交换、共享资产和协作关系 |
| Relation Overlay | 在 Task Tree 主结构之上按需叠加并过滤 Task Relation Edges 的全局关系视图；默认不打开 |
| Node Context | 以选中 Task Node 为中心的一跳父子关系、Relation、Artifact、Evaluation、风险与阻塞摘要 |
| Leaf Task Node | 经 Agent 语义内聚判断、Leaf Task Contract 代码硬校验和用户确认后，不需要继续拆分的目标级任务节点；不代表代码执行必须从叶子开始 |
| Leaf Task Contract | 叶子节点的结构化可执行契约，包含单一目标、预期输出、验收条件、未决问题、依赖、required_evidence、执行阶段和停止拆分原因 |
| required_evidence | 规划阶段定义的必需完成证据 |
| completion_evidence | 执行阶段实际产生的完成证据，用于检查是否覆盖 required_evidence |
| execution_phase | Task Node 的执行阶段，包含 skeleton、implementation、verification |
| depends_on | Task Relation Edge 的一种类型，表示 Task Node 对其他节点的执行依赖，用于调度顺序控制 |
| Artifact | 代码、测试、配置、文档、命令等工程资产 |
| Artifact Graph | Artifact 及其关系构成的工程资产图谱，与 Task Tree 同步演进，既包含计划态资产，也包含执行事实资产 |
| Artifact Granularity | Artifact 的建模层级，包括 structural、contract 和 symbol，按任务需要自适应提升而非全项目一次性扫描 |
| Structural Artifact | 目录、文件、模块、包、配置、命令、测试入口等工程结构资产，是默认记录粒度 |
| Contract Artifact | 接口、Schema、事件、协议、CLI 约定等跨任务边界资产；强跨分支关系必须引用 |
| Symbol Artifact | 函数、类、方法、类型或测试用例等符号级资产，仅在定位、验收、失败复现或影响分析需要时创建 |
| Artifact Contract | Artifact Graph 中可被 Task Node Revision 提供或依赖的接口、Schema、命令、事件或数据交换约定，不是独立 Shared Contract 系统 |
| Planned Artifact | 用户确认分支后，由 draft 晋升而来的计划基准资产 |
| Plan Drift | 执行过程中实际 Task、Artifact 或 Relation 与用户已确认计划基准发生的有意义偏移 |
| Plan Drift Severity | Plan Drift 的干预强度，包含 info、warning、blocking |
| Blocking Drift | 需要暂停当前 Task Node 或分支并等待用户确认的计划偏移 |
| Artifact Drift | Plan Drift 的一种，特指实际工程资产与 planned Artifact 之间的新增、缺失、替换、职责变化或关系变化 |
| User Change Request | 用户在 Task Tree 分支已确认或执行过程中主动提出的目标、范围、优先级、Artifact、验收标准或执行顺序变更 |
| Change Impact | User Change Request 对 Task Tree、Artifact Graph、验收标准、调度队列或当前执行节点造成的影响说明 |
| Trace Event | Agent Runtime 中不可由当前状态覆盖的追加式时间事实，记录何时发生了什么以及证据引用 |
| Execution Attempt | 指定 Task Node Revision 的一次执行、修复或验证尝试；多次尝试按序保留 |
| Evaluation | 绑定 Task Node Revision 与 Execution Attempt 的不可变评估事实，不直接等于 Task Node Status |
| Lifecycle Transition Policy | 基于 Evaluation、revision、evidence、dependency 和 drift 确定性推进 Task Node 状态的代码规则 |
| Experience | 从成功任务中沉淀出的经验 |
| Skill | 可复用、可触发、可验证的局部场景能力单元，用于告诉 Agent 在某类场景下应该怎么做 |
| Skill Candidate Revision | 在验证前被冻结的候选 Skill 内容版本，作为 Baseline、Holdout 和晋升判断的稳定目标 |
| Test Case Quality Contract | 规定 Skill 测试的来源、目标行为、fixture、input、expected result、Oracle、复现方式、隔离和质量状态的结构化契约 |
| Holdout Case | Skill Candidate Revision 冻结后独立生成且不向候选生成上下文暴露的验证案例 |
| Negative Applicability Case | 用于验证 Skill 在不适用场景下不触发、不干预或不产生无关修改的案例 |
| Skill Validation Run | 某个 Test Case 在 no-skill baseline 或 skill-enabled 模式下的一次有证据执行 |
| Skill Validation Report | 汇总 Baseline、Skill-enabled、Replay、Holdout、Negative、稳定性和风险的候选晋升报告 |
| Skill Package | 面向特定 Agent 环境分发的一组 Skill、初始化指令和工作流规则 |
| Workflow | 端到端阶段编排，用于定义一个 coding task 从开始到结束的执行顺序 |
| Workflow Rule | 约束 Agent 在特定场景下应如何调用 Skill 和执行流程的规则 |
| Workflow State Machine | 维护 current_workflow、current_stage、allowed_actions、forbidden_actions 和 transition_rules 的流程状态机 |
| Runtime Record | 插件持久化保存的运行记录，包括 workflow_state、task_tree、trace、artifact、evaluation、experience、failure_case、skill_candidate 等 |
| Failure Case | 从失败 Execution Attempt 中沉淀并通过多个 Reproduction Revision 逐步成熟的长期案例 |
| Failure Case Maturity | Failure Case 从 L0 observed、L1 manual、L2 assisted、L3 automated 到 L4 regression 的成熟度等级 |
| Failure Reproduction Revision | 同一 Failure Case 的一版不可变复现契约，可为 observed、manual、assisted 或 automated，并保留环境、步骤、Oracle 和证据 |
| Reproduction Validation Result | 对某一 Reproduction Revision 的 RED、GREEN、Oracle 区分能力、重复稳定性和隔离性所做的不可变验证事实 |
| Active Regression Case | 达到 L4 且状态为 active、可持续纳入回归执行的 Failure Case |
| RED / GREEN Reproduction | 同一复现契约在修复前稳定触发目标失败（RED），并在修复后稳定通过且目标失败消失（GREEN） |
| Execution Context | Trace Event 的运行环境元信息，用于审计、诊断、恢复和统计 |
| Agent Runtime Binding | 不同 Agent Runtime 的兼容绑定机制，用于绑定 Harness Runtime Layer，并规范化运行时事实事件 |
| Runtime Interaction Loop | Agent Runtime 内生的用户交互循环，用于处理命令、自然语言、状态迁移和继续执行 |
| Runtime Native Command | Agent Runtime 暴露的 slash command 原生命令能力，不需要 LLM 判断 |
| Harness Runtime Skill | Agent 使用 Harness Runtime Layer 的行为规范入口，通过 description / trigger rules 在任务规划、分支执行、约束应用、Hooks 记录、状态查询、Drift 和用户变更等场景触发 |
| Runtime Introspection Tool | Agent 按需查询运行时状态、任务、Artifact、Drift、等待事项和可用动作的工具 |
| Snapshot Tool | Runtime Introspection Tool 的轻量档位，用于快速返回当前 Runtime 位置和最小状态摘要 |
| Summary Tool | Runtime Introspection Tool 的中等档位，用于返回某个任务、资产图、Drift 或用户变更的摘要 |
| Detail Tool | Runtime Introspection Tool 的详细档位，用于在需要证据、诊断或完整记录时查询单个对象或限定范围的细节 |
| Runtime Confirmation Prompt | Agent 在需要用户确定性选择时发起的原生确认交互 |
| Runtime State Safety Rule | 定义哪些高风险 Runtime State 变化必须发起确认的安全规则 |
| Runtime Action | Agent 根据自然语言理解提出的结构化状态变化请求；由代码依据目标 revision 和 Safety Rules 决定提交、确认或拒绝 |
| Spatial Composability | 通过稳定身份、provides / requires contracts 和依赖闭包，让 Plugin 或 Task Node 能在不同 scope 中安全组合的能力 |
| Temporal Composability | 通过 revision、生命周期、Effect ownership、disposer / compensation 和恢复事务，让组成部分随时间安全替换和演进的能力 |
| Composition State | 与任务执行状态分离的组合生命周期状态，如 pending_dependency、active、suspending、replacing、needs_replanning、disposed |
| Task Node Effect | 由某个 Task Node Revision 生命周期拥有的 Runtime、Artifact 或外部状态变化 |
| Task Node Replacement | 使用 candidate revision、影响闭包、Effect 处置、激活验证和失败恢复替换节点实现的可追溯事务 |
| Plugin Composition Contract | Skill、Workflow、Hook、Binding 或 Runtime Extension 的稳定 ID、provides、requires、scope、effects 与 disposer 声明 |
| CORDIS-like Semantics | 对稳定身份、反应式依赖、生命周期 Effect 和可替换 revision 等可组合思想的框架中立借鉴，不表示直接依赖 Cordis |

### 13.2 待确认问题

当前已识别的需求架构问题均已完成讨论并形成明确规则。本节暂不保留未决项；后续发现新问题时再按版本追加。

### 13.3 设计参考

- [DeepSeek Harness Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)：插件化构成、共享上下文与可替换实现；
- [Cordis Primer](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.md)：Plugin、Service、Inject、Event 与 Effect 基础语义；
- [Cordis Lifecycle and Effects](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/02-lifecycle-and-effects.md)：生命周期拥有的可处置 Effect；
- [Cordis Services](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/03-services.md)：依赖出现、消失和 provider replacement；
- [Cordis Composition and HMR](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/06-composition-and-hmr.md)：稳定 entry identity 与 revision replacement；
- [Cordis Paper](https://github.com/cordiverse/paper)：时间可组合性与空间可组合性的理论来源。

以上资料只作为设计语义参考。本 SRS 的核心领域模型必须保持框架中立，不能把第三方框架的实现细节升级为产品依赖。
