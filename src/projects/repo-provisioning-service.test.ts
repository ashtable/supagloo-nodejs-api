import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@supagloo/database-lib";
import type { CreateRepoRequest } from "@supagloo/database-lib";
import { RepoProvisioningService } from "./repo-provisioning-service";
import { RepoCreationError } from "./repo-provisioning-errors";
import { GithubNotConnectedError } from "../connections/errors";
import type { GithubUserAuthClient } from "../connections/github-user-auth-client";

// The create-new-repo JIT orchestration (Task #26, design-delta §2.3/§6b): read the
// user's installation, exchange the code for a user token, create the repo, add it to
// a `selected`-mode installation, discard the token, then delegate to the existing
// create-project+scaffold path — returning the SAME { projectId, jobId }. A pure
// DB reader + injected user-auth client + injected createProject seam, so every
// branch is unit-testable with fakes.

const REQ: CreateRepoRequest = {
  code: "gh-code",
  name: "Psalm 121",
  repoName: "psalm-121",
  visibility: "private",
  createdFrom: "blank",
};

interface Connection {
  installationId: string;
  repositorySelection: string;
}

function makeFakePrisma(connection: Connection | null) {
  return {
    githubConnection: {
      findUnique: async () => connection,
    },
  } as unknown as PrismaClient;
}

function recordingUserAuthClient(overrides: Partial<GithubUserAuthClient> = {}) {
  const calls: string[] = [];
  const client: GithubUserAuthClient = {
    buildAuthorizeUrl: ({ redirectUri, state }) => {
      calls.push("buildAuthorizeUrl");
      return `https://github.com/login/oauth/authorize?redirect_uri=${redirectUri}&state=${state}`;
    },
    exchangeCode: async (code) => {
      calls.push(`exchangeCode:${code}`);
      return { token: "ghu_stub_user_1" };
    },
    createUserRepo: async ({ token, name, private: priv }) => {
      calls.push(`createUserRepo:${token}:${name}:${priv}`);
      return {
        id: 7,
        name: "psalm-121",
        fullName: "acme/psalm-121",
        owner: "acme",
        private: priv,
        defaultBranch: "main",
        cloneUrl: "http://git-server:8080/acme/psalm-121.git",
      };
    },
    addRepoToInstallation: async ({ installationId, repositoryId }) => {
      calls.push(`addRepoToInstallation:${installationId}:${repositoryId}`);
    },
    ...overrides,
  };
  return { client, calls };
}

function recordingCreateProject() {
  const calls: { userId: string; req: unknown }[] = [];
  const createProject = async (userId: string, req: unknown) => {
    calls.push({ userId, req });
    return { projectId: "cprj1", jobId: "job-1" };
  };
  return { createProject, calls };
}

describe("RepoProvisioningService.authorizeUrl", () => {
  it("delegates to the user-auth client's buildAuthorizeUrl", () => {
    const { client } = recordingUserAuthClient();
    const { createProject } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma(null),
      userAuthClient: client,
      createProject,
    });
    const url = svc.authorizeUrl({
      redirectUri: "https://app.example/cb",
      state: "n1",
    });
    expect(url).toContain("state=n1");
    expect(url).toContain("redirect_uri=https://app.example/cb");
  });
});

describe("RepoProvisioningService.createRepoAndProject", () => {
  it("rejects with GithubNotConnectedError when the user has no connection", async () => {
    const { client } = recordingUserAuthClient();
    const { createProject } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma(null),
      userAuthClient: client,
      createProject,
    });
    await expect(svc.createRepoAndProject("u1", REQ)).rejects.toThrow(
      GithubNotConnectedError,
    );
  });

  it("selected-mode: exchanges, creates repo, adds to installation, delegates create", async () => {
    const { client, calls } = recordingUserAuthClient();
    const { createProject, calls: createCalls } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "selected" }),
      userAuthClient: client,
      createProject,
    });

    const result = await svc.createRepoAndProject("u1", REQ);

    expect(result).toEqual({ projectId: "cprj1", jobId: "job-1" });
    expect(calls).toEqual([
      "exchangeCode:gh-code",
      "createUserRepo:ghu_stub_user_1:psalm-121:true",
      "addRepoToInstallation:42:7",
    ]);
    // delegates to createProject with the CREATED repo's owner + name (from GitHub).
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].userId).toBe("u1");
    expect(createCalls[0].req).toMatchObject({
      repoOwner: "acme",
      repoName: "psalm-121",
      visibility: "private",
      createdFrom: "blank",
      name: "Psalm 121",
    });
  });

  it("all-mode installation: skips the installation-add step", async () => {
    const { client, calls } = recordingUserAuthClient();
    const { createProject } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "all" }),
      userAuthClient: client,
      createProject,
    });

    await svc.createRepoAndProject("u1", REQ);

    expect(calls).toEqual([
      "exchangeCode:gh-code",
      "createUserRepo:ghu_stub_user_1:psalm-121:true",
    ]);
    expect(calls.some((c) => c.startsWith("addRepoToInstallation"))).toBe(false);
  });

  it("wraps a user-auth/create failure as RepoCreationError", async () => {
    const { client } = recordingUserAuthClient({
      exchangeCode: async () => {
        throw new Error("boom");
      },
    });
    const { createProject } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "selected" }),
      userAuthClient: client,
      createProject,
    });
    await expect(svc.createRepoAndProject("u1", REQ)).rejects.toThrow(RepoCreationError);
  });
});
