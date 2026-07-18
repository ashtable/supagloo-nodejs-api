import { defineConfig } from "prisma/config";

// Prisma 7 CLI config for the API's `migrate` service (`prisma migrate deploy`).
//
// The schema + migrations are NOT authored here — they ship inside
// @supagloo/database-lib (files: ["dist","prisma"]) and land at
// node_modules/@supagloo/database-lib/prisma/ after install. We point the CLI
// there so the API applies exactly the migrations the shared lib defines.
//
// Prisma 7's `datasource` block cannot carry a `url` (P1012), so the connection
// string comes from here via DATABASE_URL. Prisma 7 does not auto-load .env, so
// we load it ourselves (no `dotenv` dep) using Node's built-in loader; an
// already-set env var (Compose / CI) wins, and a missing .env is fine.
try {
  process.loadEnvFile();
} catch {
  // No local .env — rely on the ambient environment (Compose sets DATABASE_URL).
}

const DB_LIB_PRISMA = "node_modules/@supagloo/database-lib/prisma";

export default defineConfig({
  schema: `${DB_LIB_PRISMA}/schema.prisma`,
  migrations: {
    path: `${DB_LIB_PRISMA}/migrations`,
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
