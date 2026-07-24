import { describe, it, expect } from "vitest";
import {
  YOUVERSION_E2E_TOKEN_VAR,
  resolveYouVersionLiveGate,
} from "./youversion-live-e2e";

// Unit tests for the loud-skip gate of the OPTIONAL live YouVersion sign-in e2e
// (design-delta §10.4b/§10.8). Fast, docker-free unit lane with an INJECTED env —
// no live provider. `YOUVERSION_E2E_ACCESS_TOKEN` is the SOLE e2e secret permitted
// to skip its spec when unset, but the skip must be LOUD (a visible warning naming
// the var), never a silent no-op: "a gating suite that silently skips its provider
// tests is a green lie." This pins that gating decision.

describe("resolveYouVersionLiveGate", () => {
  it("is ENABLED (runs the live spec) when the token var is present", () => {
    const gate = resolveYouVersionLiveGate({
      [YOUVERSION_E2E_TOKEN_VAR]: "yv-live-access-token-abc",
    });
    expect(gate).toEqual({
      enabled: true,
      token: "yv-live-access-token-abc",
      skipWarning: null,
    });
  });

  it("is DISABLED with a LOUD, actionable skip warning when the token var is unset", () => {
    const gate = resolveYouVersionLiveGate({});
    expect(gate.enabled).toBe(false);
    expect(gate.token).toBeNull();
    // The warning must NAME the var, point at .env.example + design-delta §10.4b,
    // and make clear this is a deliberate, loud skip — not a silent absence.
    expect(gate.skipWarning).toBeTypeOf("string");
    expect(gate.skipWarning).toMatch(new RegExp(YOUVERSION_E2E_TOKEN_VAR));
    expect(gate.skipWarning).toMatch(/\.env\.example/);
    expect(gate.skipWarning).toMatch(/§?10\.4b/);
    expect(gate.skipWarning).toMatch(/skip/i);
  });

  it("treats a whitespace-only token as MISSING (skips loudly)", () => {
    const gate = resolveYouVersionLiveGate({
      [YOUVERSION_E2E_TOKEN_VAR]: "   ",
    });
    expect(gate.enabled).toBe(false);
    expect(gate.token).toBeNull();
    expect(gate.skipWarning).toMatch(new RegExp(YOUVERSION_E2E_TOKEN_VAR));
  });

  it("exposes the var name that .env.example / design-delta §10.8 pin", () => {
    expect(YOUVERSION_E2E_TOKEN_VAR).toBe("YOUVERSION_E2E_ACCESS_TOKEN");
  });
});
