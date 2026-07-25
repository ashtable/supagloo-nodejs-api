import { describe, it, expect } from "vitest";
import { RenderJobDtoSchema, type RenderJob } from "@supagloo/database-lib";
import { toRenderJobDto } from "./dto";

// Unit tests for the RenderJob → wire DTO projection (Task #37, design-delta §2.7).
// Pure mapping: dates → ISO-8601, nullables passed through, the five flat spec columns
// re-nested into one `outputSpec`, and `userId` dropped (the caller is the owner).

const ROW: RenderJob = {
  id: "render-1",
  projectId: "proj-1",
  versionId: "ver-1",
  userId: "user-1",
  status: "encoding",
  framesDone: 612,
  framesTotal: 840,
  width: 1080,
  height: 1920,
  fps: 30,
  aspectRatio: "9:16",
  codec: "h264",
  outputAssetKey: null,
  thumbnailAssetKey: null,
  runInBackground: false,
  error: null,
  createdAt: new Date("2026-07-24T10:00:00.000Z"),
  startedAt: new Date("2026-07-24T10:00:05.000Z"),
  completedAt: null,
} as RenderJob;

describe("toRenderJobDto", () => {
  it("U-RD1: re-nests the five spec columns into one outputSpec and ISO-stringifies the dates", () => {
    const dto = toRenderJobDto(ROW);
    expect(dto.outputSpec).toEqual({
      width: 1080,
      height: 1920,
      fps: 30,
      aspectRatio: "9:16",
      codec: "h264",
    });
    expect(dto.createdAt).toBe("2026-07-24T10:00:00.000Z");
    expect(dto.startedAt).toBe("2026-07-24T10:00:05.000Z");
    expect(dto.completedAt).toBeNull();
  });

  it("U-RD2: omits userId (the caller is the owner — connection-DTO precedent)", () => {
    const dto = toRenderJobDto(ROW) as Record<string, unknown>;
    expect("userId" in dto).toBe(false);
  });

  it("U-RD3: passes the asset keys / error through raw and parses under RenderJobDtoSchema", () => {
    const completed = toRenderJobDto({
      ...ROW,
      status: "completed",
      framesDone: 840,
      outputAssetKey: "renders/render-1/output.mp4",
      thumbnailAssetKey: "renders/render-1/thumb.jpg",
      completedAt: new Date("2026-07-24T10:04:00.000Z"),
    } as RenderJob);

    expect(completed.outputAssetKey).toBe("renders/render-1/output.mp4");
    expect(completed.thumbnailAssetKey).toBe("renders/render-1/thumb.jpg");
    expect(RenderJobDtoSchema.safeParse(completed).success).toBe(true);

    const failed = toRenderJobDto({
      ...ROW,
      status: "failed",
      error: "renderMedia exited 1",
    } as RenderJob);
    expect(failed.error).toBe("renderMedia exited 1");
    expect(RenderJobDtoSchema.safeParse(failed).success).toBe(true);
  });
});
