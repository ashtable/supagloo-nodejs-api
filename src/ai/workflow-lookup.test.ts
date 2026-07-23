import { describe, it, expect } from "vitest";
import {
  AI_GENERATION_QUEUE_NAME,
  GENERATE_AUDIO_WORKFLOW_NAME,
  GENERATE_IMAGE_WORKFLOW_NAME,
  GENERATE_SCRIPT_WORKFLOW_NAME,
  GENERATE_VIDEO_WORKFLOW_NAME,
  type AiGenerationKind,
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

  it("maps image to generateImage on the ai-generation queue (Task #32 — now wired)", () => {
    expect(resolveAiGenerationWorkflow("image")).toEqual({
      workflowName: GENERATE_IMAGE_WORKFLOW_NAME,
      queueName: AI_GENERATION_QUEUE_NAME,
    });
  });

  it("maps BOTH audio kinds to generateAudio on the ai-generation queue (Task #33 — now wired)", () => {
    for (const kind of ["narration", "music"] as const) {
      expect(resolveAiGenerationWorkflow(kind)).toEqual({
        workflowName: GENERATE_AUDIO_WORKFLOW_NAME,
        queueName: AI_GENERATION_QUEUE_NAME,
      });
    }
  });

  it("maps video to generateVideo on the ai-generation queue (Task #34 — now wired)", () => {
    expect(resolveAiGenerationWorkflow("video")).toEqual({
      workflowName: GENERATE_VIDEO_WORKFLOW_NAME,
      queueName: AI_GENERATION_QUEUE_NAME,
    });
  });

  // Every REAL AiGenerationKind is now wired (#30/#32/#33/#34), so the 501 "not built yet" gap is
  // no longer reachable via a real kind — but the defensive path still throws for any kind with no
  // registered workflow. Exercise it with a synthetic kind cast so the guard stays covered.
  it("throws UnsupportedGenerationKindError (501) for a kind with no registered workflow", () => {
    expect(() =>
      resolveAiGenerationWorkflow("hologram" as AiGenerationKind),
    ).toThrow(UnsupportedGenerationKindError);
  });

  it("the thrown error carries a 501 statusCode", () => {
    try {
      resolveAiGenerationWorkflow("hologram" as AiGenerationKind);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as UnsupportedGenerationKindError).statusCode).toBe(501);
    }
  });
});
