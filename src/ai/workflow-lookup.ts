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
 * on the generation workflow name / queue.
 *
 * CORRECTED 2026-07-28: this comment used to say "only the two TEXT kinds are wired
 * today". That has been stale since task #34 — ALL SIX kinds now route to a real
 * registered workflow (`generateScript` for storyboard/script, `generateImage`,
 * `generateAudio` for narration+music, `generateVideo`), and db-lib's routing table is a
 * complete record.
 *
 * The consequence is that the {@link UnsupportedGenerationKindError} (501) branch below is
 * currently UNREACHABLE through the routing table. It is kept rather than deleted because
 * the table is typed `Partial<Record<...>>` — adding a seventh kind to the Prisma enum
 * without adding its workflow entry would make it reachable again, and a 501 is the right
 * answer for "matrix-valid but not built yet", which is a genuinely different failure from
 * the 422 matrix rejection.
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
