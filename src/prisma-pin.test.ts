import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  checkPrismaVersion,
  type PackageJsonLike,
} from "@supagloo/database-lib/check-prisma-version";

// The pin requirement (design-delta §9-Q11): the API must pin `prisma` and
// `@prisma/client` to the EXACT version database-lib ships, and enforce it. We
// run database-lib's OWN check tool against our OWN package.json — the same
// check the `postinstall` hook runs at install time.
const pkg = JSON.parse(
  readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
) as PackageJsonLike & { scripts?: Record<string, string> };

describe("Prisma version pin wiring", () => {
  it("pins prisma and @prisma/client to database-lib's exact version", () => {
    const result = checkPrismaVersion(pkg);

    expect(result.expected).toBe("7.8.0");
    expect(result.ok).toBe(true);

    const prisma = result.findings.find((f) => f.name === "prisma");
    expect(prisma).toMatchObject({ status: "ok", spec: "7.8.0" });

    const client = result.findings.find((f) => f.name === "@prisma/client");
    expect(client).toMatchObject({ status: "ok", spec: "7.8.0" });
  });

  it("wires the check-prisma-version bin as a postinstall hook", () => {
    expect(pkg.scripts?.postinstall ?? "").toContain("check-prisma-version");
  });
});
