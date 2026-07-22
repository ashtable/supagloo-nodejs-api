import { describe, it, expect } from "vitest";
import {
  AI_GENERATION_QUEUE_NAME,
  GENERATE_SCRIPT_WORKFLOW_NAME,
} from "@supagloo/database-lib";
import { resolveAiGenerationWorkflow } from "./workflow-lookup";
import { UnsupportedGenerationKindError } from "./errors";

// The static AI-generation kind→workflow enqueue lookup (design-delta §7 workflow 5). It
// reads the SHARED db-lib table (AI_GENERATION_WORKFLOW_BY_KIND) — the same constant the
// dbos static registry pins — so the API and the worker can never disagree on the
// generation workflow name / queue. Only the two TEXT kinds are wired today
// (generateScript on the ai-generation queue); the four media kinds are matrix-valid but
// UNwired (their workflows land in #32-34), so they throw UnsupportedGenerationKindError
// (501) — a distinct, reachable "not built yet" gap, not the 422 matrix rejection.

describe("resolveAiGenerationWorkflow", () => {
  it("maps storyboard to generateScript on the ai-generation queue", () => {
    expect(resolveAiGenerationWorkflow("storyboard")).toEqual({
      workflowName: GENERATE_SCRIPT_WORKFLOW_NAME,
      queueName: AI_GENERATION_QUEUE_NAME,
    });
  });

  it("maps script to generateScript on the ai-generation queue", () => {
    expect(resolveAiGenerationWorkflow("script")).toEqual({
      workflowName: GENERATE_SCRIPT_WORKFLOW_NAME,
      queueName: AI_GENERATION_QUEUE_NAME,
    });
  });

  it("throws UnsupportedGenerationKindError (501) for the not-yet-built media kinds", () => {
    for (const kind of ["image", "narration", "music", "video"] as const) {
      expect(() => resolveAiGenerationWorkflow(kind)).toThrow(
        UnsupportedGenerationKindError,
      );
    }
  });

  it("the thrown error carries a 501 statusCode", () => {
    try {
      resolveAiGenerationWorkflow("image");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as UnsupportedGenerationKindError).statusCode).toBe(501);
    }
  });
});
