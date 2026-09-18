---
name: taskroot
description: Use when the user explicitly requests a new named Task Tree root with taskroot or /agent-harness:taskroot.
---

# Create Task Root

Interpret the user's remaining command text as the exact root goal name. If it is empty, ask for the name. Call `harness_create_task_root` once for the current working directory, report its tree ID and initial revision, then continue with `task-tree-planning`. Do not infer an existing-tree merge because this command explicitly requests a new root.
