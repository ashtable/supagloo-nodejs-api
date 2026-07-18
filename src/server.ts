import { buildApp } from "./app";
import { loadEnv } from "./config/env";

/**
 * Process entry point: validate the environment (fail-fast), build the app, and
 * listen. The `api` Compose service runs this via `node dist/server.js`.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const app = buildApp({ logger: true });

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
