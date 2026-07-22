import {
  AI_GENERATION_WORKFLOW_BY_KIND,
  type AiGenerationKind,
  type AiGenerationWorkflowTarget,
} from "@supagloo/database-lib";
import { UnsupportedGenerationKindError } from "./errors";

/**
 * The static AI-generation kind→workflow enqueue lookup (design-delta §7 workflow 5).
 * Reads the SHARED db-lib routing table (`AI_GENERATION_WORKFLOW_BY_KIND`) — the same
 * constant the dbos static registry pins — so the API and the worker can never disagree
 * on the generation workflow name / queue. Only the two TEXT kinds (`storyboard`/`script`
 * → `generateScript` on the `ai-generation` queue) are wired today; the four media kinds
 * are matrix-valid but UNwired (their workflows land in #32–34), so they throw
 * {@link UnsupportedGenerationKindError} (501) — a reachable "not built yet" gap, distinct
 * from the 422 matrix rejection.
 */
export function resolveAiGenerationWorkflow(
  kind: AiGenerationKind,
): AiGenerationWorkflowTarget {
  const target = (
    AI_GENERATION_WORKFLOW_BY_KIND as Partial<
      Record<AiGenerationKind, AiGenerationWorkflowTarget>
    >
  )[kind];
  if (!target) {
    throw new UnsupportedGenerationKindError(
      `no generation workflow is registered for kind "${kind}" yet`,
    );
  }
  return target;
}
