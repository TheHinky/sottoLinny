import { describe, expect, test } from "bun:test";
import { normalizeServerEndpoint } from "./endpoint.js";

describe("server endpoint", () => {
  test("normalizes an HTTP endpoint for relative API paths", () => {
    const endpoint = normalizeServerEndpoint("http://127.0.0.1:8391");
    expect(endpoint.href).toBe("http://127.0.0.1:8391/");
    expect(new URL("v1/health", endpoint).href).toBe("http://127.0.0.1:8391/v1/health");
  });

  test("preserves an explicit path prefix", () => {
    const endpoint = normalizeServerEndpoint("https://dictation.example/sotto");
    expect(new URL("v1/health", endpoint).href).toBe("https://dictation.example/sotto/v1/health");
  });

  test("allows HTTP only for loopback and literal Tailscale addresses", () => {
    expect(normalizeServerEndpoint("http://100.64.1.2:8391").hostname).toBe("100.64.1.2");
    expect(normalizeServerEndpoint("http://[fd7a:115c:a1e0::1]:8391").hostname).toBe(
      "[fd7a:115c:a1e0::1]",
    );
    expect(() => normalizeServerEndpoint("http://192.168.1.2:8391")).toThrow();
    expect(() => normalizeServerEndpoint("http://sotto.example:8391")).toThrow();
  });

  test("rejects credentials, queries, fragments, and unsupported schemes", () => {
    for (const value of [
      "ftp://example.test",
      "https://user@example.test",
      "https://example.test?token=secret",
      "https://example.test#fragment",
    ]) {
      expect(() => normalizeServerEndpoint(value)).toThrow();
    }
  });
});
