import { createPrismaClient } from "@supagloo/database-lib";
import { buildApp } from "./app";
import { loadEnv } from "./config/env";
import { AuthService } from "./auth/auth-service";
import { makeYouVersionVerifier } from "./auth/youversion";
import { SESSION_TTL_MS } from "./auth/tokens";
import { makeInteractiveGithubAppClient } from "./connections/github-app-client";
import { GithubConnectionService } from "./connections/github-connection-service";
import { makeOpenRouterClient } from "./connections/openrouter-client";
import { makeGlooClient } from "./connections/gloo-client";
import { OpenRouterConnectionService } from "./connections/openrouter-connection-service";
import { GlooConnectionService } from "./connections/gloo-connection-service";
import { ConnectionsService } from "./connections/connections-service";
import { makeS3Client } from "./files/s3-client";
import { FilesService } from "./files/files-service";
import { ProjectsService } from "./projects/projects-service";
import { ManifestService } from "./manifests/manifest-service";
import { makeDbosEnqueuer } from "./jobs/enqueuer";
import { ProjectJobsService } from "./jobs/project-jobs-service";
import { AiGenerationsService } from "./ai/ai-generations-service";
import { makeGithubUserAuthClient } from "./connections/github-user-auth-client";
import { RepoProvisioningService } from "./projects/repo-provisioning-service";
import { RendersService } from "./renders/renders-service";
import { GalleryService } from "./gallery/gallery-service";

/**
 * Process entry point: validate the environment (fail-fast), build the app with
 * the real Prisma-backed AuthService + YouVersion verifier, and listen. The `api`
 * Compose service runs this via `node dist/server.js`.
 */
async function main(): Promise<void> {
  const env = loadEnv();

  const prisma = createPrismaClient({ connectionString: env.DATABASE_URL });
  const authService = new AuthService({
    prisma,
    verifyToken: makeYouVersionVerifier({ baseUrl: env.YOUVERSION_BASE_URL }),
    sessionTtlMs: SESSION_TTL_MS,
  });

  // INTERACTIVE, not the workflow default (deferred review finding DR3). Every route
  // this client serves — `GET /v1/github/repos` (the repo picker AND the web client's
  // per-page-load repo count), `POST /v1/connections/github/callback`,
  // `GET /v1/projects/:id/manifest` — has a browser waiting on it. Plan row 64's
  // unbounded budget could hold one of those requests open for over twenty minutes on a
  // throttled installation; the interactive factory caps attempts AND the whole call's
  // sleeping. db-lib's full budget is untouched and still applies to every DBOS workflow.
  const githubAppClient = makeInteractiveGithubAppClient({
    apiBaseUrl: env.GITHUB_API_BASE_URL,
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
  });
  const githubService = new GithubConnectionService({
    prisma,
    verifyInstallation: githubAppClient.verifyInstallation,
    listInstallationRepos: githubAppClient.listInstallationRepos,
    oauthBaseUrl: env.GITHUB_OAUTH_BASE_URL,
    appSlug: env.GITHUB_APP_SLUG,
  });

  const openrouterClient = makeOpenRouterClient({
    apiBaseUrl: env.OPENROUTER_BASE_URL,
  });
  const openrouterService = new OpenRouterConnectionService({
    prisma,
    getCredits: openrouterClient.getCredits,
    encryptionKey: env.SECRETS_ENCRYPTION_KEY,
  });

  const glooClient = makeGlooClient({ apiBaseUrl: env.GLOO_BASE_URL });
  const glooService = new GlooConnectionService({
    prisma,
    verifyClientCredentials: glooClient.verifyClientCredentials,
    encryptionKey: env.SECRETS_ENCRYPTION_KEY,
  });

  const connectionsService = new ConnectionsService({ prisma });

  // Presign against the PUBLIC endpoint (browser-reachable). forcePathStyle is
  // applied inside the factory. The API only ever builds the `presign` client;
  // server-to-server ops (the internal endpoint) are reserved for the workers.
  const s3 = makeS3Client(
    {
      internalEndpoint: env.S3_ENDPOINT,
      publicEndpoint: env.S3_PUBLIC_ENDPOINT,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKey: env.S3_ACCESS_KEY,
      secretKey: env.S3_SECRET_KEY,
    },
    "presign",
  );
  const filesService = new FilesService({ prisma, s3, bucket: env.S3_BUCKET });

  const projectsService = new ProjectsService({ prisma });

  // Manifest read (design-delta §5.3): resolve the project (owner-scoped), mint a
  // fresh installation token, and read `supagloo.project.json` via the GitHub Contents
  // API. Reuses the already-wired github App client + projects resolver.
  const manifestService = new ManifestService({
    getProject: (userId, id) => projectsService.getProject(userId, id),
    prisma,
    getFileContents: githubAppClient.getRepositoryFileContents,
  });

  // Enqueue-only DBOS client against the system DB (`supagloo_dbos`); the API never
  // runs the DBOS runtime. Closed on shutdown alongside Prisma.
  //
  // DBOS_SYSTEM_DATABASE_SCHEMA is unset in Compose, so this forwards `undefined` and
  // the SDK's default "dbos" schema stands. It MUST carry the same value as the dbos
  // worker's: a schema set on one service only would have the api enqueueing into a
  // namespace nothing polls.
  const jobEnqueuer = makeDbosEnqueuer({
    systemDatabaseUrl: env.DBOS_DATABASE_URL,
    systemDatabaseSchemaName: env.DBOS_SYSTEM_DATABASE_SCHEMA,
  });
  const projectJobsService = new ProjectJobsService({
    prisma,
    enqueue: jobEnqueuer.enqueue,
  });

  // AI generations (design-delta §2.8/§7/§8): create + enqueue on the ai-generation
  // queue, poll, and cancel. Reuses the same enqueue-only DBOS client (its `cancel` seam
  // backs POST /:id/cancel → DBOSClient.cancelWorkflow).
  const aiGenerationsService = new AiGenerationsService({
    prisma,
    enqueue: jobEnqueuer.enqueue,
    cancel: jobEnqueuer.cancel,
  });

  // Renders (design-delta §2.7/§6c/§8): create + enqueue on the `render` queue, poll,
  // cancel, and presign the completed output. Reuses the same enqueue-only DBOS client
  // (its `cancel` seam backs POST /:id/cancel → DBOSClient.cancelWorkflow) and delegates
  // download presigning to the already-built FilesService, so `renders/{id}/…` keys have
  // exactly ONE ownership rule and ONE signer in the process.
  const rendersService = new RendersService({
    prisma,
    enqueue: jobEnqueuer.enqueue,
    cancel: jobEnqueuer.cancel,
    presignDownload: (userId, key) => filesService.presignDownload(userId, key),
  });

  // Gallery + upvotes (design-delta §2.7/§6c/§8): publish, the public listing, stream-url
  // and the vote transaction. No enqueuer — §7 lists gallery publish under "deliberately
  // NOT workflows" (it is a single Postgres insert), so nothing here touches DBOS.
  //
  // `presignPublic` is the ONE ownership-free signer, handed over as a narrow seam so the
  // gallery's "published, not owned" rule cannot leak onto GET /v1/files/presign-download —
  // and so the process still has exactly ONE S3 URL signer. The 120 s stream TTL and the
  // 24-row page size are GalleryService defaults, deliberately not env vars: neither is
  // deployment-specific, and adding them to env.ts would mean compose/.env.example churn for
  // two constants.
  const galleryService = new GalleryService({
    prisma,
    presignPublic: (key, ttlSeconds) =>
      filesService.presignPublicKey(key, ttlSeconds),
  });

  // Create-new-repo JIT hop (design-delta §2.3/§6b): the zero-storage user-token
  // dance that creates the repo before delegating to the scaffold create path.
  const githubUserAuthClient = makeGithubUserAuthClient({
    // PUBLIC (the browser opens it) vs INTERNAL (this process POSTs to it) — plan
    // row 66. Unset, the internal one resolves to the public one in `loadEnv`, so
    // production and every existing deployment are unchanged.
    oauthBaseUrl: env.GITHUB_OAUTH_BASE_URL,
    oauthInternalBaseUrl: env.GITHUB_OAUTH_INTERNAL_BASE_URL,
    apiBaseUrl: env.GITHUB_API_BASE_URL,
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET,
  });
  const repoProvisioningService = new RepoProvisioningService({
    prisma,
    userAuthClient: githubUserAuthClient,
    createProject: (userId, req) =>
      projectJobsService.createProjectWithScaffold(userId, req),
  });

  const app = buildApp({
    logger: true,
    auth: {
      authService,
      env: {
        NODE_ENV: env.NODE_ENV,
        SUPAGLOO_ENABLE_TEST_SEED: env.SUPAGLOO_ENABLE_TEST_SEED,
      },
    },
    // TEST-ONLY (plan row 66). Passing the wiring does NOT enable the route: it is
    // registered only when NODE_ENV !== 'production' AND SUPAGLOO_ENABLE_TEST_SEED
    // === '1', and it throws at boot rather than register without its credential.
    // The App's OAuth client pair is the SECOND factor (round-4 review R5): the route
    // verifies the POSTed client_id/client_secret against it, so the credential is not
    // handed to anyone who can merely reach the published port. It is the same pair
    // `githubUserAuthClient` above sends, which is why the product path is unaffected.
    testGithubOauth: {
      env: {
        NODE_ENV: env.NODE_ENV,
        SUPAGLOO_ENABLE_TEST_SEED: env.SUPAGLOO_ENABLE_TEST_SEED,
        GITHUB_E2E_EXCHANGE_TOKEN: env.GITHUB_E2E_EXCHANGE_TOKEN,
        GITHUB_APP_CLIENT_ID: env.GITHUB_APP_CLIENT_ID,
        GITHUB_APP_CLIENT_SECRET: env.GITHUB_APP_CLIENT_SECRET,
      },
    },
    github: { service: githubService },
    connections: {
      openrouter: openrouterService,
      gloo: glooService,
      reader: connectionsService,
    },
    files: { service: filesService },
    projects: { service: projectsService },
    manifests: { service: manifestService },
    projectJobs: { service: projectJobsService },
    aiGenerations: { service: aiGenerationsService },
    repoProvisioning: { service: repoProvisioningService },
    renders: { service: rendersService },
    gallery: { service: galleryService },
  });

  app.addHook("onClose", async () => {
    await jobEnqueuer.close().catch(() => {});
    await prisma.$disconnect();
  });

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
  } catch (err) {
    app.log.error(err);
    await prisma.$disconnect();
    process.exit(1);
  }
}

void main();
