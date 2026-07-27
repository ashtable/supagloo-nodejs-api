import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "../app";
import {
  __resetLogSecrets,
  API_BOOT_FAILED_LOG,
  buildLoggerOptions,
  dsnPasswords,
  LOG_REDACT_PATHS,
  redactForLog,
  redactSecretsFromText,
  redactUrlCredentials,
  registerLogSecrets,
  reportBootFailure,
} from "./redact";

// Plan row 43, the "redaction — secrets never logged" half (design-delta §2.10; brief §2).
//
// THE TECHNIQUE (design-delta §11.8:2467, the one already used to pin the worker's git
// wrapper): plant a SENTINEL inside each carrier a secret realistically travels in, then
// assert the sentinel is ABSENT from the serialized output. Asserting the presence of "***"
// would pass against a redactor that stamped the censor somewhere and left the secret in
// place; asserting the absence of the secret cannot.
//
// The row's Unit column: "log-redaction unit checks (serializer never emits key material)".

/** Token-shaped, unique, and long enough that an accidental substring match is impossible. */
const SENTINEL = "S3NT1NEL-7f4c9a2b6d8e0135-supagloo-secret-value";

afterEach(() => {
  __resetLogSecrets();
});

describe("plan row 43 — redactSecretsFromText", () => {
  it("U-RED-1: scrubs a GitHub installation token out of an error message", () => {
    const token = `ghs_${"A1b2C3d4E5f6G7h8".repeat(2)}`;
    const out = redactSecretsFromText(
      `push failed: remote rejected (auth ${token})`,
    );
    expect(out).not.toContain(token);
    expect(out).toContain("push failed");
  });

  it("U-RED-2: scrubs the credential from an authenticated clone URL, keeping the username", () => {
    const out = redactSecretsFromText(
      `fatal: could not read from https://x-access-token:${SENTINEL}@github.com/o/r.git`,
    );
    expect(out).not.toContain(SENTINEL);
    // Debuggability is not a permitted casualty: the host, the path and WHICH credential
    // kind was in play all survive.
    expect(out).toContain("x-access-token:***@github.com/o/r.git");
  });

  it("U-RED-2b: a bare userinfo with no user:pass split is redacted whole", () => {
    const out = redactSecretsFromText(`https://${SENTINEL}@github.com/o/r.git`);
    expect(out).not.toContain(SENTINEL);
    expect(out).toContain("https://***@github.com");
  });

  it("U-RED-3: scrubs the password from a Postgres DSN, keeping user and host", () => {
    const out = redactSecretsFromText(
      `connect ECONNREFUSED postgres://supagloo:${SENTINEL}@db:5432/supagloo`,
    );
    expect(out).not.toContain(SENTINEL);
    expect(out).toContain("postgres://supagloo:***@db:5432/supagloo");
  });

  it("U-RED-4: scrubs a PEM private-key block whole, not line by line", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\n" +
      `MIIEow${SENTINEL}\nAQEFAAOCAQ8A\n` +
      "-----END RSA PRIVATE KEY-----";
    const out = redactSecretsFromText(`bad key: ${pem}`);
    expect(out).not.toContain(SENTINEL);
    expect(out).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  it("U-RED-5: scrubs a 64-hex encryption key but NOT a 40-hex git SHA", () => {
    const key = "9f".repeat(32);
    expect(redactSecretsFromText(`key=${key}`)).not.toContain(key);
    // The threshold is a deliberate debuggability tradeoff, not an oversight: a 40-hex run
    // is a commit sha, and shas are the single most useful thing in a git-ops failure log.
    const sha = "a".repeat(40);
    expect(redactSecretsFromText(`merged ${sha}`)).toContain(sha);
  });

  it("U-RED-5b: scrubs an OpenRouter-shaped key and a Bearer header value", () => {
    const or = "sk-or-v1-0123456789abcdefghijklmnop";
    expect(redactSecretsFromText(`401 for ${or}`)).not.toContain(or);
    const bearer = "Bearer 0123456789abcdefghijklmnopqrstuv";
    const out = redactSecretsFromText(`authorization: ${bearer}`);
    expect(out).not.toContain("0123456789abcdefghijklmnopqrstuv");
  });

  it("U-RED-6: registered values catch the SHAPELESS secrets no pattern can match", () => {
    // An S3 secret key or a Gloo client secret is an arbitrary string. No shape identifies
    // it, so the only way to redact it is to know the configured value.
    const shapeless = "supagloo-dev-minio-secret";
    expect(redactSecretsFromText(`s3: ${shapeless}`)).toContain(shapeless);
    registerLogSecrets([shapeless]);
    expect(redactSecretsFromText(`s3: ${shapeless}`)).not.toContain(shapeless);
  });

  it("U-RED-6b: implausibly short and non-string values are ignored", () => {
    // Registering "dev" would blank that substring across every log line in the process.
    registerLogSecrets(["dev", "", undefined, null]);
    expect(redactSecretsFromText("developer environment")).toContain(
      "developer environment",
    );
  });
});

describe("plan row 43 — redactForLog (the pino `err` serializer)", () => {
  it("U-RED-7: projects onto a PLAIN object, keeps the classifier fields, DROPS cause", () => {
    // The sentinel is SHAPELESS on purpose here: this case is about the projection, so the
    // secret is registered rather than pattern-matched (layer 2, not layer 1).
    registerLogSecrets([SENTINEL]);
    const err = Object.assign(new Error(`boom ${SENTINEL}`), {
      statusCode: 502,
      code: "P2002",
      cause: new Error(`inner ${SENTINEL}`),
    });
    const out = redactForLog(err);

    // Plain-object projection is the point: an Error has no enumerable own properties, so a
    // logger handed one falls back to its own inspector and prints whatever is attached.
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.name).toBe("Error");
    expect(out.message).not.toContain(SENTINEL);
    expect(out.statusCode).toBe(502);
    expect(out.code).toBe("P2002");
    // `cause` is dropped rather than scrubbed — a nested object of arbitrary depth is not
    // something a serializer can promise to have cleaned.
    expect(out).not.toHaveProperty("cause");
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  it("U-RED-7b: scrubs the stack too, not only the message", () => {
    const err = new Error("plain");
    err.stack = `Error: plain\n  at clone (https://x-access-token:${SENTINEL}@github.com/o/r.git)`;
    const out = redactForLog(err);
    expect(out.stack).toBeDefined();
    expect(out.stack).not.toContain(SENTINEL);
  });

  it("U-RED-8: a non-Error throwable is stringified then scrubbed", () => {
    // An unknown key must not be able to escape by simply not being one of the projected
    // fields, so the whole value is serialized to text before scrubbing.
    registerLogSecrets([SENTINEL]);
    const out = redactForLog({ someUnexpectedField: SENTINEL });
    expect(out.name).toBe("NonError");
    expect(JSON.stringify(out)).not.toContain(SENTINEL);

    const fromString = redactForLog(
      `https://x-access-token:${SENTINEL}@github.com/o/r.git`,
    );
    expect(fromString.message).not.toContain(SENTINEL);
  });
});

/** Collect the JSON lines a pino instance writes, without touching stdout. */
function capture(): { lines: string[]; stream: { write(msg: string): void } } {
  const lines: string[] = [];
  return { lines, stream: { write: (msg: string) => void lines.push(msg) } };
}

describe("plan row 43 — the options pino actually receives", () => {
  it("U-RED-9: piped through a real logger, no key material is emitted", () => {
    // Testing the serializer function in isolation proves it works; this proves it is
    // SHAPED the way pino consumes (`serializers.err`, `redact.paths`), which is the half
    // that silently no-ops if a key name is wrong — and it goes through `buildApp`, so the
    // shape being proven is the one the running service uses.
    const { lines, stream } = capture();
    const log = buildApp({ logger: { stream } }).log;

    log.error(
      {
        err: new Error(`clone failed https://x-access-token:${SENTINEL}@github.com/o/r.git`),
        url: "/v1/projects",
        // A bare `headers` bag rather than `req.headers`: Fastify installs its OWN `req`
        // serializer, which projects a request down to method/url/host/remoteAddress and
        // drops headers before redaction is even reachable. That is a second, independent
        // reason the Authorization header does not reach the log — but it is Fastify's
        // guarantee, not this module's, and it evaporates the moment anyone logs a header
        // bag by hand. THAT is the case these paths exist for, so it is the case tested.
        headers: {
          authorization: `Bearer ${SENTINEL}`,
          cookie: `sg_session=${SENTINEL}`,
          "user-agent": "vitest",
        },
      },
      "unhandled error — replying with a generic 500",
    );

    const output = lines.join("\n");
    expect(output).not.toContain(SENTINEL);
    // …and the structural path list really fired (not merely the shape matcher).
    expect(output).toContain('"authorization":"***"');
    expect(output).toContain('"cookie":"***"');
    // Everything non-secret is still there — a redactor that blanked the line would "pass"
    // an absence assertion while destroying the log.
    expect(output).toContain("/v1/projects");
    expect(output).toContain("vitest");
    expect(output).toContain("unhandled error");
  });

  it("U-RED-9b: buildLoggerOptions exposes exactly the two slots pino reads", () => {
    const opts = buildLoggerOptions();
    // A typo in either key name is a silent no-op — pino ignores options it does not know.
    expect(opts.serializers.err).toBe(redactForLog);
    expect(opts.redact.censor).toBe("***");
    for (const path of ["req.headers.authorization", "req.headers.cookie"]) {
      expect(LOG_REDACT_PATHS).toContain(path);
      expect(opts.redact.paths).toContain(path);
    }
  });

  it("U-RED-10: buildApp's OWN logger redacts — the production wiring, end to end", () => {
    // The assertion that matters. `server.ts` passes `logger: true`, and if `app.ts` ever
    // stops folding `buildLoggerOptions()` in, every test above still passes while the
    // running service logs secrets. Passing a capture stream exercises the SAME code path
    // `true` takes (the options are merged, not replaced).
    const { lines, stream } = capture();
    const app = buildApp({ logger: { stream } });

    app.log.error(
      { err: new Error(`token leak ghs_${"A1b2C3d4E5f6G7h8".repeat(2)}`) },
      "boom",
    );
    app.log.info(
      { req: { headers: { authorization: `Bearer ${SENTINEL}` } } },
      "request",
    );

    const output = lines.join("\n");
    expect(output).not.toContain(SENTINEL);
    expect(output).not.toContain("ghs_A1b2C3d4E5f6G7h8");
    expect(output).toContain("boom");
  });

  it("U-RED-11: server.ts ARMS the exact-value layer, right after loadEnv", () => {
    // A source fence, for the reason `dockerfile-database-lib-pin.test.ts` is one: this
    // module cannot be imported in a unit test (`server.ts` ends in `void main()`, which
    // connects to Postgres and listens). The shapeless secrets — the S3 secret key, the App
    // OAuth client secret — are redacted ONLY if the configured values were registered, so
    // the absence of this call is a silent, total failure of layer 2.
    const source = readFileSync(join(__dirname, "..", "server.ts"), "utf8");
    expect(source).toContain("registerLogSecrets(");
    const registerAt = source.indexOf("registerLogSecrets(");
    const loadEnvAt = source.indexOf("const env = loadEnv()");
    expect(loadEnvAt).toBeGreaterThan(-1);
    expect(registerAt).toBeGreaterThan(loadEnvAt);
    // …before anything that could throw holding a secret. `createPrismaClient` takes the
    // DSN, so it is the first such call.
    expect(registerAt).toBeLessThan(source.indexOf("createPrismaClient("));
    for (const name of [
      "SECRETS_ENCRYPTION_KEY",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_APP_CLIENT_SECRET",
      "S3_SECRET_KEY",
    ]) {
      expect(
        source.slice(registerAt, source.indexOf("]", registerAt)),
        name,
      ).toContain(name);
    }
    // And the running server logs at all — redaction of a logger nobody enabled is a no-op.
    expect(source).toContain("logger: true");
  });

  it("U-RED-10b: logger:false still means no logger at all (tests stay quiet)", () => {
    const app = buildApp({});
    // Fastify substitutes a no-op abstract logger when logging is disabled; the assertion
    // is simply that building without a logger did not start emitting.
    expect(() => app.log.info("silent")).not.toThrow();
  });
});

// ---------------------------------------------------------------- Step-11 item 3 (R4344-3)
// `msg` IS A THIRD FIELD, and neither existing layer can reach it.
//
// `serializers.err` only ever sees the `err` KEY, and `redact.paths` is a list of object
// paths — but pino's `msg` is derived from the log call's own string argument, and for a
// positional `Error` it is derived from `err.message` AFTER serialization. So a message
// carrying a clone URL, a DSN or an upstream credential is written verbatim into the shared
// `docker compose logs` stream while the `err` copy beside it is perfectly redacted.
//
// WHICH PATH ACTUALLY REACHES IT (the reviewer's citation was `error-handler.ts:71-75`, and
// that is NOT the leak — the message argument on the generify branch is a static string).
// The reachable path is the DELEGATED branch: `carriesIntentionalStatus(err)` is true for
// every declared status in 400…599 except 500, so `error-handler.ts:74` does
// `reply.send(err)`, Fastify's own `defaultErrorHandler` runs, and
// `log-controller.js#defaultErrorLog` calls `reply.log.error({ req, res, err },
// error?.message)` for a 5xx. `GithubAppRequestError`'s 502 is the live instance.
describe("plan row 43 — pino's `msg` (the third field)", () => {
  it("U-RED-12: the DELEGATED 5xx path does not leak the raw message into `msg`", async () => {
    const { lines, stream } = capture();
    const app = buildApp({ logger: { stream } });
    app.get("/boom", async () => {
      throw Object.assign(
        new Error(
          `clone failed https://x-access-token:${SENTINEL}@github.com/o/r.git`,
        ),
        { statusCode: 502 },
      );
    });

    const res = await app.inject({ method: "GET", url: "/boom" });
    await app.close();

    // The delegation itself is unchanged — this is the branch, not a new one.
    expect(res.statusCode).toBe(502);
    const output = lines.join("\n");
    // Both copies. The `err` one was already clean; `"msg"` is the one this closes.
    expect(output).toContain('"msg"');
    expect(output).not.toContain(SENTINEL);
    // Non-destructive: a redactor that blanked the line would pass an absence assertion
    // while destroying the log.
    expect(output).toContain("clone failed");
  });

  it("U-RED-13: a BARE positional Error (`log.error(err)`) does not leak `msg` either", () => {
    const { lines, stream } = capture();
    const app = buildApp({ logger: { stream } });

    // `server.ts`'s listen catch used exactly this shape, and so does Fastify's own
    // `hooks.js` on a hook failure. pino derives `msg` from `err.message` after the
    // serializer has run, so `serializers.err` cannot reach it.
    app.log.error(
      new Error(
        `clone failed https://x-access-token:${SENTINEL}@github.com/o/r.git`,
      ),
    );

    const output = lines.join("\n");
    expect(output).not.toContain(SENTINEL);
    expect(output).toContain("clone failed");
    // …and the error survived as a structured `err`, not just as text.
    expect(output).toContain('"err"');
  });
});

// -------------------------------------------------------- Step-11 items 18, 19, 5, 25
describe("plan row 43 — the three hardenings the Step-7 review found", () => {
  it("U-RED-14: a non-string `message` does not throw (item 18)", () => {
    // MEASURED: `redactSecretsFromText(err.message)` with an object `message` threw
    // `TypeError: text.replace is not a function`. `stack`, `code` and `stderr` were
    // already guarded; `message` was the one unguarded read. A throwing pino serializer
    // propagates out of `log.error` and writes ZERO lines, so the consequence is not a bad
    // log line — it is the total disappearance of the line, at the moment it matters most.
    const weird = Object.assign(new Error(), { message: { tok: SENTINEL } });

    expect(() => redactForLog(weird)).not.toThrow();
    const out = redactForLog(weird);
    expect(typeof out.message).toBe("string");
    expect(JSON.stringify(out)).not.toContain(SENTINEL);

    const { lines, stream } = capture();
    const app = buildApp({ logger: { stream } });
    expect(() => app.log.error({ err: weird }, "boom")).not.toThrow();
    expect(lines.join("\n")).toContain("boom");
  });

  it("U-RED-15: a DSN password containing `@` is fully redacted (item 19)", () => {
    const dsn = "postgres://supagloo:p@ssw0rdLongEnough@db:5432/supagloo";
    // MEASURED, and the reason registering the value is not optional: the userinfo
    // character class stops at the FIRST `@`, so the tail survives shape matching.
    expect(redactUrlCredentials(dsn)).toContain("ssw0rdLongEnough");

    registerLogSecrets(dsnPasswords(dsn));
    const out = redactSecretsFromText(dsn);
    expect(out).not.toContain("ssw0rdLongEnough");
    expect(out).not.toContain("p@ssw0rd");
    // Still a debuggable line: host, port and database name are not secrets.
    expect(out).toContain("db:5432");
    expect(out).toContain("postgres://");
  });

  it("U-RED-15b: dsnPasswords yields BOTH serializations and never throws", () => {
    // `new URL(...).password` returns the PERCENT-ENCODED form whether or not the DSN was
    // written encoded, so registering only that would miss the raw text that actually
    // appears in a Prisma error.
    expect(dsnPasswords("postgres://u:p@ssw0rdLongEnough@db:5432/x")).toEqual(
      expect.arrayContaining(["p%40ssw0rdLongEnough", "p@ssw0rdLongEnough"]),
    );
    expect(dsnPasswords("postgres://u:s3cr3tpassword@db:5432/x")).toEqual([
      "s3cr3tpassword",
    ]);
    // No password, no URL, no value at all — a boot-time helper must never be the thing
    // that throws before the redactor is even armed.
    expect(dsnPasswords("postgres://u@db:5432/x")).toEqual([]);
    expect(dsnPasswords("not a url at all")).toEqual([]);
    expect(dsnPasswords(undefined)).toEqual([]);
  });

  it("U-RED-16: server.ts registers BOTH DSN passwords (item 19)", () => {
    // The companion to U-RED-11: shape matching cannot cover a DSN password (it has no
    // shape), and layer 1 provably mangles the URL before an exact match could fire, so
    // the ONLY thing that closes this is registering the parsed value at boot.
    const source = readFileSync(join(__dirname, "..", "server.ts"), "utf8");
    const registerAt = source.indexOf("registerLogSecrets(");
    const list = source.slice(registerAt, source.indexOf("]", registerAt));
    expect(list).toContain("dsnPasswords(env.DATABASE_URL)");
    expect(list).toContain("dsnPasswords(env.DBOS_DATABASE_URL)");
  });

  it("U-RED-17: the entry point catches its OWN boot failure (item 5)", () => {
    const source = readFileSync(join(__dirname, "..", "server.ts"), "utf8");
    // A bare `void main();` hands every rejection to Node's DEFAULT unhandled-rejection
    // handler, which prints the raw `Error`, its whole `cause` chain and every attached
    // property. `main()` runs `loadEnv`, `registerLogSecrets` and
    // `createPrismaClient({ connectionString: env.DATABASE_URL })` BEFORE the listen
    // try/catch, so the DSN is exactly what gets printed — and the exit code is 1 either
    // way, which is why E-BH1/E-BH2 could not see this.
    expect(source).not.toMatch(/^void main\(\);\s*$/m);
    expect(source).toMatch(/void main\(\)[\s\S]{0,40}\.catch\(/);
    expect(source).toContain("reportBootFailure");
    // …and the listen catch logs a structured `err` rather than a positional Error.
    expect(source).toContain('app.log.error({ err }, "listen failed")');
  });

  it("U-RED-18: reportBootFailure redacts the payload and exits 1 (item 5)", () => {
    const dsn = "postgres://supagloo:p@ssw0rdLongEnough@db:5432/supagloo";
    registerLogSecrets(dsnPasswords(dsn));
    // The measured boot failure: Prisma's initialization error echoes the datasource URL.
    const err = Object.assign(
      new Error(`Can't reach database server. datasource: ${dsn}`),
      {
        name: "PrismaClientInitializationError",
        clientVersion: "7.8.0",
        errorCode: "P1001",
      },
    );

    const printed: unknown[][] = [];
    const exits: number[] = [];
    reportBootFailure(err, {
      error: (...args: unknown[]) => printed.push(args),
      exit: (code: number) => exits.push(code),
    });

    expect(exits).toEqual([1]);
    const text = JSON.stringify(printed);
    expect(text).not.toContain("ssw0rdLongEnough");
    expect(text).not.toContain("p@ssw0rd");
    // Still diagnosable, and the label stays argument 0 and unprefixed (the same
    // discipline `WORKER_FAILED_LOG` is held to on the worker side).
    expect(text).toContain("Can't reach database server");
    expect(printed[0][0]).toBe(API_BOOT_FAILED_LOG);
  });

  it("U-RED-19: caller options cannot silently DROP the redaction (item 25)", () => {
    // `BuildAppOptions.logger`'s JSDoc promises caller options are merged on top of the
    // redaction "without being able to silently drop them". `{ ...base, ...logger }`
    // replaced `serializers` wholesale, so passing any serializer removed the `err` one —
    // a false security claim in the row that owns redaction.
    const { lines, stream } = capture();
    const app = buildApp({
      logger: { stream, serializers: { req: () => ({ shrunk: true }) } },
    });

    app.log.error(
      {
        err: new Error(
          `clone failed https://x-access-token:${SENTINEL}@github.com/o/r.git`,
        ),
        req: { headers: { authorization: `Bearer ${SENTINEL}` } },
      },
      "boom",
    );

    const output = lines.join("\n");
    expect(output).not.toContain(SENTINEL);
    // The caller's own serializer still took effect — this is a merge, not an override.
    expect(output).toContain("shrunk");
  });

  it("U-RED-19b: a caller `redact` block cannot drop the header path list (item 25)", () => {
    const { lines, stream } = capture();
    const app = buildApp({
      logger: { stream, redact: { paths: ["custom.field"], censor: "[gone]" } },
    });

    app.log.info(
      {
        headers: { authorization: `Bearer ${SENTINEL}`, "user-agent": "vitest" },
        custom: { field: SENTINEL },
      },
      "request",
    );

    const output = lines.join("\n");
    expect(output).not.toContain(SENTINEL);
    // The caller's added path fired…
    expect(output).toContain("custom");
    // …and row 43's own paths and censor survived alongside it.
    expect(output).toContain('"authorization":"***"');
    expect(output).toContain("vitest");
  });
});
