import { HarnessError } from "../domain/errors.js";
import { evaluateExperienceEligibility, type EvolutionEvaluationFact } from "../domain/evolution.js";
import { newId, nowIso } from "../domain/ids.js";
import type { TaskNodeInput } from "../domain/task-tree.js";
import { canonicalJson } from "../domain/trace.js";
import type { RuntimeDatabase } from "../storage/database.js";

export type ExperienceCaptureView = {
  eligible: false;
  reason: "no_applied_success" | "insufficient_failures";
} | {
  eligible: true;
  experienceId: string;
  created: boolean;
  projectId: string;
  treeId: string;
  nodeId: string;
  nodeRevisionId: string;
  successEvaluationId: string;
  successAttemptId: string;
  failureEvaluationIds: string[];
  failureAttemptIds: string[];
};

export interface SkillCandidateView {
  skillId: string;
  candidateRevisionId: string;
  stableKey: string;
  revisionNumber: number;
  validationStatus: "frozen";
  created: boolean;
  frozenAt: string;
}

export class EvolutionService {
  constructor(private readonly database: RuntimeDatabase) {}

  captureEligibleExperienceWithinTransaction(input: {
    projectId: string;
    successEvaluationId: string;
  }): ExperienceCaptureView {
    const success = this.database.get<{
      evaluation_id: string; project_id: string; tree_id: string; task_node_id: string;
      task_node_revision_id: string; execution_attempt_id: string; verdict: string;
      evidence_refs_json: string; task_title: string; body_json: string;
      applied: number; target_status: string;
    }>(`
      SELECT e.id AS evaluation_id, e.project_id, e.tree_id, e.task_node_id,
             e.task_node_revision_id, e.execution_attempt_id, e.verdict, e.evidence_refs_json,
             n.title AS task_title, nr.body_json, l.applied, l.target_status
      FROM evaluations e
      JOIN task_nodes n ON n.id = e.task_node_id
      JOIN task_node_revisions nr ON nr.id = e.task_node_revision_id
      JOIN lifecycle_transition_records l ON l.evaluation_id = e.id
      WHERE e.id = ? AND e.project_id = ?
    `, input.successEvaluationId, input.projectId);
    if (!success) throw new HarnessError("not_found", "successful Evaluation was not found in this Project");
    if (success.verdict !== "succeeded" || success.applied !== 1 || success.target_status !== "succeeded") {
      throw new HarnessError("evolution_not_eligible", "Experience requires an applied succeeded Evaluation");
    }
    const facts = this.database.all<{
      evaluation_id: string; execution_attempt_id: string; task_node_revision_id: string;
      verdict: EvolutionEvaluationFact["verdict"]; applied: number; created_at: string; attempt_number: number;
    }>(`
      SELECT e.id AS evaluation_id, e.execution_attempt_id, e.task_node_revision_id,
             e.verdict, l.applied, e.created_at, a.attempt_number
      FROM evaluations e
      JOIN lifecycle_transition_records l ON l.evaluation_id = e.id
      JOIN execution_attempts a ON a.id = e.execution_attempt_id
      WHERE e.project_id = ? AND e.task_node_id = ? AND e.task_node_revision_id = ?
        AND a.attempt_number <= (SELECT attempt_number FROM execution_attempts WHERE id = ?)
      ORDER BY a.attempt_number, e.created_at, e.id
    `, input.projectId, success.task_node_id, success.task_node_revision_id, success.execution_attempt_id)
      .map((row) => ({
        evaluationId: row.evaluation_id,
        attemptId: row.execution_attempt_id,
        nodeRevisionId: row.task_node_revision_id,
        verdict: row.verdict,
        applied: row.applied === 1,
        occurredAt: `${String(row.attempt_number).padStart(12, "0")}:${row.created_at}`,
      }));
    const eligibility = evaluateExperienceEligibility(facts);
    if (!eligibility.eligible) return eligibility;
    const existing = this.database.get<{ id: string }>(
      "SELECT id FROM experiences WHERE source_success_evaluation_id = ? AND source_project_id = ?",
      input.successEvaluationId, input.projectId,
    );
    if (existing) return { ...eligibility, experienceId: existing.id, created: false, projectId: input.projectId, treeId: success.tree_id, nodeId: success.task_node_id };

    const relatedArtifactIds = this.database.all<{ artifact_id: string }>(`
      SELECT DISTINCT artifact_id FROM task_node_artifact_links
      WHERE project_id = ? AND task_node_revision_id = ? ORDER BY artifact_id
    `, input.projectId, success.task_node_revision_id).map((row) => row.artifact_id);
    const body = JSON.parse(success.body_json) as TaskNodeInput;
    const experienceId = newId();
    const createdAt = nowIso();
    this.database.run(`
      INSERT INTO experiences (
        id, source_project_id, source_tree_id, source_task_node_id, source_task_node_revision_id,
        source_success_attempt_id, source_success_evaluation_id, source_failure_attempt_ids_json,
        source_failure_evaluation_ids_json, summary, applicable_context_json, verification_json,
        related_artifact_ids_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, experienceId, input.projectId, success.tree_id, success.task_node_id, success.task_node_revision_id,
    eligibility.successAttemptId, eligibility.successEvaluationId,
    canonicalJson(eligibility.failureAttemptIds), canonicalJson(eligibility.failureEvaluationIds),
    `Recovered ${success.task_title} after ${eligibility.failureAttemptIds.length} failed attempts`,
    canonicalJson({ taskTitle: success.task_title, objectives: body.objectives ?? [], executionPhase: body.executionPhase ?? null }),
    canonicalJson({ successEvidenceRefs: JSON.parse(success.evidence_refs_json) as string[], successEvaluationId: success.evaluation_id }),
    canonicalJson(relatedArtifactIds), createdAt);
    return {
      ...eligibility,
      experienceId,
      created: true,
      projectId: input.projectId,
      treeId: success.tree_id,
      nodeId: success.task_node_id,
    };
  }

  freezeSkillCandidate(input: {
    projectId: string;
    experienceId: string;
    stableKey: string;
    name: string;
    triggerContext: Record<string, unknown>;
    instructionSnapshot: string;
  }): SkillCandidateView {
    const stableKey = input.stableKey.trim();
    const name = input.name.trim();
    const instruction = input.instructionSnapshot.trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(stableKey) || !name || !instruction) {
      throw new HarnessError("skill_candidate_invalid", "Skill candidate requires a kebab-case stable key, name, and instruction snapshot");
    }
    const triggerContextJson = canonicalJson(input.triggerContext);
    return this.database.transaction(() => {
      const experience = this.database.get<{ id: string }>(
        "SELECT id FROM experiences WHERE id = ? AND source_project_id = ?", input.experienceId, input.projectId,
      );
      if (!experience) throw new HarnessError("not_found", "Experience was not found in this Project");
      let skill = this.database.get<{ id: string; name: string; trigger_context_json: string }>(
        "SELECT id, name, trigger_context_json FROM skills WHERE stable_key = ?", stableKey,
      );
      const now = nowIso();
      if (!skill) {
        const skillId = newId();
        this.database.run(
          "INSERT INTO skills (id, stable_key, name, trigger_context_json, validation_status, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?)",
          skillId, stableKey, name, triggerContextJson, now, now,
        );
        skill = { id: skillId, name, trigger_context_json: triggerContextJson };
      } else if (skill.name !== name || skill.trigger_context_json !== triggerContextJson) {
        throw new HarnessError("skill_candidate_invalid", "existing Skill identity has different name or trigger context");
      }
      const sourceExperienceIdsJson = canonicalJson([experience.id]);
      const existing = this.database.get<{ id: string; revision_number: number; frozen_at: string }>(`
        SELECT id, revision_number, frozen_at FROM skill_candidate_revisions
        WHERE skill_id = ? AND source_experience_ids_json = ? AND instruction_snapshot = ?
      `, skill.id, sourceExperienceIdsJson, instruction);
      if (existing) {
        return {
          skillId: skill.id, candidateRevisionId: existing.id, stableKey,
          revisionNumber: existing.revision_number, validationStatus: "frozen" as const,
          created: false, frozenAt: existing.frozen_at,
        };
      }
      const revisionNumber = (this.database.get<{ maximum: number | null }>(
        "SELECT MAX(revision_number) AS maximum FROM skill_candidate_revisions WHERE skill_id = ?", skill.id,
      )?.maximum ?? 0) + 1;
      const candidateRevisionId = newId();
      this.database.run(`
        INSERT INTO skill_candidate_revisions (
          id, skill_id, revision_number, source_experience_ids_json,
          instruction_snapshot, frozen_at, validation_status
        ) VALUES (?, ?, ?, ?, ?, ?, 'frozen')
      `, candidateRevisionId, skill.id, revisionNumber, sourceExperienceIdsJson, instruction, now);
      this.database.run(
        "UPDATE skills SET current_candidate_revision_id = ?, validation_status = 'frozen', updated_at = ? WHERE id = ?",
        candidateRevisionId, now, skill.id,
      );
      return {
        skillId: skill.id, candidateRevisionId, stableKey, revisionNumber,
        validationStatus: "frozen" as const, created: true, frozenAt: now,
      };
    });
  }
}
