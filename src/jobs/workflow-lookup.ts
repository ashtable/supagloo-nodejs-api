import {
  GIT_OPS_WORKFLOW_BY_KIND,
  type GitOpsWorkflowTarget,
  type ProjectJobKind,
} from "@supagloo/database-lib";
import { UnsupportedJobKindError } from "./errors";

/**
 * The static kind→workflow enqueue lookup (design-delta §7). Reads the SHARED db-lib
 * routing table (`GIT_OPS_WORKFLOW_BY_KIND`) — the same constant the dbos static
 * registry test pins — so the API and the worker can never disagree on a workflow
 * name or queue. Only `scaffold` is wired today; the other three git-ops kinds throw
 * {@link UnsupportedJobKindError} until their workflows land (tasks 19/21/22).
 */
export function resolveGitOpsWorkflow(
  kind: ProjectJobKind,
): GitOpsWorkflowTarget {
  const target = (
    GIT_OPS_WORKFLOW_BY_KIND as Partial<
      Record<ProjectJobKind, GitOpsWorkflowTarget>
    >
  )[kind];
  if (!target) {
    throw new UnsupportedJobKindError(
      `no git-ops workflow is registered for kind "${kind}"`,
    );
  }
  return target;
}
