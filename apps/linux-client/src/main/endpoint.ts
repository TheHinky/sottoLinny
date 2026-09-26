import { isIP } from "node:net";

function permitsHTTP(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  if (isIP(host) !== 4) return host.startsWith("fd7a:115c:a1e0:");
  const octets = host.split(".").map(Number);
  return octets[0] === 127 || (octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127);
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
    throw new Error("Use HTTPS, localhost, or a literal Tailscale IP address.");
  }
  if (!endpoint.pathname.endsWith("/")) endpoint.pathname += "/";
  return endpoint;
}
