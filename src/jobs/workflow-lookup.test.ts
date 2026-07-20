import { describe, it, expect } from "vitest";
import {
  GIT_OPS_QUEUE_NAME,
  SCAFFOLD_PROJECT_WORKFLOW_NAME,
} from "@supagloo/database-lib";
import { resolveGitOpsWorkflow } from "./workflow-lookup";
import { UnsupportedJobKindError } from "./errors";

// The static kind→workflow enqueue lookup (design-delta §7). It reads the SHARED
// db-lib routing table (GIT_OPS_WORKFLOW_BY_KIND) — the same constant the dbos
// registry test pins — so the API and the worker can never disagree on the scaffold
// workflow name / queue. Only `scaffold` is wired today; the other three git-ops
// kinds get real workflows in tasks 19/21/22.

describe("resolveGitOpsWorkflow", () => {
  it("maps scaffold to the shared scaffold workflow on the git-ops queue", () => {
    expect(resolveGitOpsWorkflow("scaffold")).toEqual({
      workflowName: SCAFFOLD_PROJECT_WORKFLOW_NAME,
      queueName: GIT_OPS_QUEUE_NAME,
    });
  });

  it("throws for a kind whose workflow does not exist yet", () => {
    expect(() => resolveGitOpsWorkflow("commit")).toThrow(UnsupportedJobKindError);
    expect(() => resolveGitOpsWorkflow("publish")).toThrow(UnsupportedJobKindError);
    expect(() => resolveGitOpsWorkflow("import_verify")).toThrow(
      UnsupportedJobKindError,
    );
  });
});
