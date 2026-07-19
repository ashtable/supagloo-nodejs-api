import { createPrismaClient } from "@supagloo/database-lib";
import { buildApp } from "./app";
import { loadEnv } from "./config/env";
import { AuthService } from "./auth/auth-service";
import { makeYouVersionVerifier } from "./auth/youversion";
import { SESSION_TTL_MS } from "./auth/tokens";
import { makeGithubAppClient } from "./connections/github-app-client";
import { GithubConnectionService } from "./connections/github-connection-service";
import { makeOpenRouterClient } from "./connections/openrouter-client";
import { makeGlooClient } from "./connections/gloo-client";
import { OpenRouterConnectionService } from "./connections/openrouter-connection-service";
import { GlooConnectionService } from "./connections/gloo-connection-service";
import { ConnectionsService } from "./connections/connections-service";
import { makeS3Client } from "./files/s3-client";
import { FilesService } from "./files/files-service";
import { ProjectsService } from "./projects/projects-service";

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

  const githubAppClient = makeGithubAppClient({
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

  const app = buildApp({
    logger: true,
    auth: {
      authService,
      env: {
        NODE_ENV: env.NODE_ENV,
        SUPAGLOO_ENABLE_TEST_SEED: env.SUPAGLOO_ENABLE_TEST_SEED,
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
  });

  app.addHook("onClose", async () => {
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
