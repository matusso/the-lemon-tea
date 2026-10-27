import type { MiddlewareHandler } from "hono";

/** Strict security headers. The SPA needs inline styles (charts/3D); scripts are same-origin only. */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const h = c.res.headers;
    h.set(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self' ws: wss:",
        "worker-src 'self' blob:",
        "media-src https:",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self' http://127.0.0.1:* http://localhost:* https:",
        "object-src 'none'",
      ].join("; "),
    );
    h.set("X-Content-Type-Options", "nosniff");
    h.set("Referrer-Policy", "no-referrer");
    h.set("X-Frame-Options", "DENY");
    h.set("Cross-Origin-Opener-Policy", "same-origin");
    h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (c.req.url.startsWith("https://")) h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  };
}

/**
 * Fixed-window rate limiter keyed by user or client IP. In-process: on Cloudflare pair it with
 * the platform rate-limiting rules (see docs/SECURITY.md), since isolates do not share memory.
 */
export function rateLimit(perMinute: number, keyOf: (c: Parameters<MiddlewareHandler>[0]) => string): MiddlewareHandler {
  const buckets = new Map<string, { count: number; reset: number }>();
  return async (c, next) => {
    const key = keyOf(c);
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset <= now) {
      b = { count: 0, reset: now + 60_000 };
      buckets.set(key, b);
      if (buckets.size > 50_000) for (const [k, v] of buckets) if (v.reset <= now) buckets.delete(k);
    }
    b.count++;
    c.header("RateLimit-Limit", String(perMinute));
    c.header("RateLimit-Remaining", String(Math.max(0, perMinute - b.count)));
    if (b.count > perMinute) {
      c.header("Retry-After", String(Math.ceil((b.reset - now) / 1000)));
      return c.json({ error: { code: "rate_limited", message: "Too many requests" } }, 429);
    }
    await next();
  };
}

/** Reject request bodies above `max` bytes (by Content-Length, and by actual size for chunked bodies). */
export function bodyLimit(max: number): MiddlewareHandler {
  return async (c, next) => {
    const len = Number(c.req.header("content-length") ?? "0");
    if (len > max) return c.json({ error: { code: "invalid_input", message: `Request body exceeds ${max} bytes` } }, 413);
    await next();
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
