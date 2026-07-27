import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Plan row 44 — the RED PATH: "a deliberate mismatch fails the build" (design-delta §9-Q11).
//
// WHAT WAS ALREADY DONE (brief finding S2), and is asserted next door in `prisma-pin.test.ts`
// rather than re-litigated here: this package pins both Prisma packages to database-lib's
// exact version and runs `check-prisma-version` as a `postinstall` hook. That is the GREEN
// path, and it has been green since task 8.
//
// WHAT THIS FILE ADDS is the half nothing proved: that a MISMATCH actually fails, through the
// real executable, with the real exit code, in the exact way `npm install` consumes it. The
// existing test calls `checkPrismaVersion()` — a pure function whose return value nothing in
// the build inspects. A build fails on an EXIT CODE, and no test asserted one.
//
// D44.1 — THERE IS NO CI, AND THIS FILE IS THE "CI-SIM" THE ROW ASKS FOR. The row's own E2E
// column says "CI-sim run", and design-delta §9-Q11:1642-1643 offers a CI check *or* a
// postinstall hook as ALTERNATIVES — the postinstall arm is the one that shipped. Authoring a
// `.github/workflows` file would reopen §9-Q12 (secrets-into-CI, deliberately not designed),
// drag in §10.9's real-money e2e spend, and falsify current-design §5.4 item 7's "No CI exists
// in any of the five repos". So: no CI, and U-PIN-CLI-7 pins that as a DECISION rather than
// leaving the absence of `.github/` to read as an oversight.
//
// HARD RULE: every mutation happens in an `os.tmpdir()` scratch directory. The nested
// `supagloo-database-lib/` submodule checkout is READ (for the real CLI) and never written.

const REPO_ROOT = process.cwd();
const CLI = resolve(
  REPO_ROOT,
  "supagloo-database-lib",
  "dist",
  "check-prisma-version.cli.js",
);
const OWN_PACKAGE_JSON = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"),
) as {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/**
 * Run the REAL CLI in `cwd` and report its exit code + streams.
 *
 * `execFileSync` on `node <cli>` rather than the bin shim, so the test does not depend on a
 * `node_modules/.bin` symlink being present in a scratch directory.
 */
function runCli(cwd: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      code: e.status ?? -1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

/**
 * A scratch copy of THIS package's own package.json, optionally with the Prisma pins
 * rewritten. Copying the real file (rather than inventing a fixture) is what makes the green
 * case meaningful: it is the same document `npm install` reads in this repo.
 */
function scratchConsumer(
  mutate: (pkg: Record<string, any>) => void = () => {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "supagloo-prisma-pin-"));
  const pkg = JSON.parse(JSON.stringify(OWN_PACKAGE_JSON)) as Record<string, any>;
  // The scratch copy must not run a postinstall of its own if anything ever installs it.
  delete pkg.scripts;
  mutate(pkg);
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  return dir;
}

/** Rewrite a pin wherever it is declared (dependencies or devDependencies). */
function setPin(pkg: Record<string, any>, name: string, spec: string): void {
  for (const section of ["dependencies", "devDependencies"]) {
    if (pkg[section]?.[name] !== undefined) {
      pkg[section][name] = spec;
      return;
    }
  }
  throw new Error(`${name} is not declared in this package.json — fixture is stale`);
}

describe("plan row 44 — Prisma pin CI-sim (api consumer)", () => {
  it("U-PIN-CLI-1: this package's REAL package.json passes with exit 0", () => {
    const { code, stdout } = runCli(scratchConsumer());
    expect(code).toBe(0);
    expect(stdout).toContain("OK");
  });

  it("U-PIN-CLI-2: a drifted `prisma` pin exits 1 and names the required version", () => {
    // The row, verbatim: "mismatched consumer pin → build fails". This is that run.
    const dir = scratchConsumer((pkg) => setPin(pkg, "prisma", "7.9.0"));
    const { code, stderr } = runCli(dir);
    expect(code).toBe(1);
    expect(stderr).toContain("7.8.0");
    expect(stderr).toContain("prisma");
  });

  it("U-PIN-CLI-3: a drifted `@prisma/client` pin exits 1 — BOTH packages are enforced", () => {
    // Enforcing only the CLI would let the generated client drift away from the schema
    // engine, which is the failure mode the pin exists for.
    const dir = scratchConsumer((pkg) => setPin(pkg, "@prisma/client", "7.7.0"));
    const { code, stderr } = runCli(dir);
    expect(code).toBe(1);
    expect(stderr).toContain("@prisma/client");
  });

  it("U-PIN-CLI-4: a RANGE exits 1 even though it resolves correctly today", () => {
    // `^7.8.0` installs 7.8.0 right now, so a resolved-version check would pass it. The pin
    // is about tomorrow's install, so the DECLARED spec is what is checked.
    for (const spec of ["^7.8.0", "~7.8.0", "7.8.x", "latest"]) {
      const dir = scratchConsumer((pkg) => setPin(pkg, "prisma", spec));
      const { code, stderr } = runCli(dir);
      expect(code, spec).toBe(1);
      expect(stderr, spec).toContain("exact");
    }
  });

  it("U-PIN-CLI-5: the shipped CLI is executable and has a shebang", () => {
    // `postinstall` invokes it as a BIN. A dist build that dropped the exec bit or the
    // shebang fails at `npm install` time with an exec-format error rather than a pin
    // report — and would look like a broken install, not a pin drift.
    accessSync(CLI, constants.X_OK);
    expect(readFileSync(CLI, "utf8").startsWith("#!")).toBe(true);
  });

  it("U-PIN-CLI-6: the exit code is genuinely wired to the build (postinstall + Dockerfile)", () => {
    // Without this, the exit code above is ceremonial: it proves the tool can fail, not that
    // anything fails WITH it. D44.2 — "fails the build" means `postinstall`, and the place
    // that consumes it is the image build.
    expect(OWN_PACKAGE_JSON.scripts?.postinstall ?? "").toContain(
      "check-prisma-version",
    );

    const dockerfile = readFileSync(resolve(REPO_ROOT, "Dockerfile"), "utf8");
    const installs = dockerfile
      .split("\n")
      .filter((l) => /^RUN\s+npm\s+(install|ci)\b/.test(l.trim()));
    expect(installs.length).toBeGreaterThan(0);
    for (const line of installs) {
      // `--ignore-scripts` on the api's own install would skip `postinstall` and let a
      // drifted pin ship. (db-lib's own `npm ci` is a different line and may carry it.)
      expect(line, line).not.toContain("--ignore-scripts");
    }
  });

  it("U-PIN-CLI-7: D44.1 — no CI workflow is authored, and that is the decision", () => {
    // current-design §5.4 item 7 and §6 both state plainly that no CI exists in any of the
    // five repos, and design-delta §9-Q12 defers the secrets-into-CI design on purpose. This
    // row satisfies "enforcement everywhere" through the postinstall arm §9-Q11 offers as
    // the alternative, so the absence below is load-bearing: adding a workflow here would
    // silently falsify two design sections a doc pass would then have to rewrite.
    let hasWorkflows = true;
    try {
      accessSync(join(REPO_ROOT, ".github"), constants.F_OK);
    } catch {
      hasWorkflows = false;
    }
    expect(hasWorkflows).toBe(false);
  });
});
