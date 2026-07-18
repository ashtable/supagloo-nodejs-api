import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { registerHealthRoutes } from "./routes/health";

export interface BuildAppOptions {
  /** Enable Fastify's request logger (on for the running server, off in tests). */
  logger?: boolean;
}

/**
 * Construct the Fastify application with the shared Zod type provider wired as
 * the validator + serializer (design-delta §2.11 — API DTO schemas are Zod,
 * shared with the Next.js BFF for end-to-end type safety). Returned un-listened
 * so tests can `inject` or `listen` on an ephemeral port.
 */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerHealthRoutes(app);

  return app;
}
