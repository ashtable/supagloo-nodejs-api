import { describe, it, expect } from "vitest";
import {
  COMMIT_VERSION_WORKFLOW_NAME,
  GIT_OPS_QUEUE_NAME,
  IMPORT_PROJECT_WORKFLOW_NAME,
  SCAFFOLD_PROJECT_WORKFLOW_NAME,
} from "@supagloo/database-lib";
import { resolveGitOpsWorkflow } from "./workflow-lookup";
import { UnsupportedJobKindError } from "./errors";

// The static kind→workflow enqueue lookup (design-delta §7). It reads the SHARED
// db-lib routing table (GIT_OPS_WORKFLOW_BY_KIND) — the same constant the dbos
// registry test pins — so the API and the worker can never disagree on a workflow
// name / queue. `scaffold` (task 18) + `import_verify` (task 19) are wired; `commit`/
// `publish` get real workflows in tasks 21/22.

describe("resolveGitOpsWorkflow", () => {
  it("maps scaffold to the shared scaffold workflow on the git-ops queue", () => {
    expect(resolveGitOpsWorkflow("scaffold")).toEqual({
      workflowName: SCAFFOLD_PROJECT_WORKFLOW_NAME,
      queueName: GIT_OPS_QUEUE_NAME,
    });
  });

  it("maps import_verify to the shared import workflow on the git-ops queue (Task #19)", () => {
    expect(resolveGitOpsWorkflow("import_verify")).toEqual({
      workflowName: IMPORT_PROJECT_WORKFLOW_NAME,
      queueName: GIT_OPS_QUEUE_NAME,
    });
  });

  it("maps commit to the shared commit workflow on the git-ops queue (Task #21)", () => {
    expect(resolveGitOpsWorkflow("commit")).toEqual({
      workflowName: COMMIT_VERSION_WORKFLOW_NAME,
      queueName: GIT_OPS_QUEUE_NAME,
    });
  });

  it("throws for a kind whose workflow does not exist yet", () => {
    expect(() => resolveGitOpsWorkflow("publish")).toThrow(UnsupportedJobKindError);
  });
});
