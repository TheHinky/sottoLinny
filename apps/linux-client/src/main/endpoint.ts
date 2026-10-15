import { isIP } from "node:net";

function permitsHTTP(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  if (isIP(host) !== 4) return host.startsWith("fd7a:115c:a1e0:");
  const [a, b] = host.split(".").map(Number) as [number, number];
  // Loopback, Tailscale, and private LAN literals (10/8, 172.16/12, 192.168/16).
  // Plain HTTP on a LAN is unencrypted: the token and audio are visible on that
  // network. Accepted deliberately for trusted home networks (gaming PC client).
  return (
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

export function normalizeServerEndpoint(value: string) {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("The server URL must use HTTP or HTTPS.");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("The server URL cannot contain credentials, a query, or a fragment.");
  }
  if (endpoint.protocol === "http:" && !permitsHTTP(endpoint.hostname)) {
    throw new Error("Use HTTPS, localhost, or a literal Tailscale or private LAN IP address.");
  }
  if (!endpoint.pathname.endsWith("/")) endpoint.pathname += "/";
  return endpoint;
}
