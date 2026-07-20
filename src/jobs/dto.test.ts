import { describe, it, expect } from "vitest";
import type { ProjectJob } from "@supagloo/database-lib";
import { toProjectJobDto } from "./dto";

// Stage-response shaping (design-delta §2.9/§6b): map a persisted ProjectJob row to
// the polling wire DTO — Date columns → ISO-8601 strings, the untyped Json `stages`
// validated/passed through as {key,label,state}[], nullable error/completedAt.

const baseRow = {
  id: "job-1",
  projectId: "p1",
  userId: "u1",
  versionId: null,
  kind: "scaffold",
  status: "running",
  stages: [
    { key: "mintInstallationToken", label: "Authenticating with GitHub", state: "done" },
    { key: "cloneToWorkspace", label: "Cloning repository", state: "running" },
  ],
  error: null,
  createdAt: new Date("2026-07-19T00:00:00.000Z"),
  completedAt: null,
} as unknown as ProjectJob;

describe("toProjectJobDto", () => {
  it("shapes an in-flight job (ISO createdAt, null completedAt, validated stages)", () => {
    expect(toProjectJobDto(baseRow)).toEqual({
      id: "job-1",
      projectId: "p1",
      kind: "scaffold",
      status: "running",
      stages: [
        {
          key: "mintInstallationToken",
          label: "Authenticating with GitHub",
          state: "done",
        },
        { key: "cloneToWorkspace", label: "Cloning repository", state: "running" },
      ],
      error: null,
      createdAt: "2026-07-19T00:00:00.000Z",
      completedAt: null,
    });
  });

  it("serializes error + completedAt for a terminal job", () => {
    const dto = toProjectJobDto({
      ...baseRow,
      status: "failed",
      error: "boom",
      completedAt: new Date("2026-07-19T00:01:00.000Z"),
    } as unknown as ProjectJob);
    expect(dto.status).toBe("failed");
    expect(dto.error).toBe("boom");
    expect(dto.completedAt).toBe("2026-07-19T00:01:00.000Z");
  });

  it("throws if the persisted stages Json is malformed (defensive)", () => {
    expect(() =>
      toProjectJobDto({
        ...baseRow,
        stages: [{ key: "k", state: "bogus" }],
      } as unknown as ProjectJob),
    ).toThrow();
  });
});
