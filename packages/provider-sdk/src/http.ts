/**
 * Shared HTTP client for provider adapters:
 *  - token-bucket rate limiting per provider (protects provider quotas)
 *  - retries with exponential backoff + jitter on 429/5xx/network errors, honouring Retry-After
 *  - SSRF protection: only https (or explicitly allowed http for local dev) to allow-listed hosts,
 *    never private/link-local IP literals
 *  - response size cap
 */

export class RateLimiter {
  private tokens: number;
  private last = Date.now();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly perSecond: number, private readonly burst: number) {
    this.tokens = burst;
  }

  take(): Promise<void> {
    const run = async () => {
      for (;;) {
        const now = Date.now();
        this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
        this.last = now;
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        await sleep(((1 - this.tokens) / this.perSecond) * 1000);
      }
    };
    this.queue = this.queue.then(run);
    return this.queue;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class ProviderHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

/** Throws unless the URL is an allowed outbound target. */
export function assertSafeUrl(raw: string, allowedHosts: readonly string[], allowHttp = false): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Invalid provider URL");
  }
  if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) throw new Error(`Blocked protocol ${u.protocol}`);
  if (u.username || u.password) throw new Error("Credentials in URL are not allowed");
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.includes(":")) {
    if (!allowedHosts.includes(host)) throw new Error(`Blocked host ${host}`);
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && PRIVATE_V4.some((r) => r.test(host)) && !allowedHosts.includes(host)) {
    throw new Error(`Blocked private address ${host}`);
  }
  if (!allowedHosts.includes(host)) throw new Error(`Host ${host} is not allow-listed for this provider`);
  return u;
}

export interface HttpClientOptions {
  allowedHosts: string[];
  allowHttp?: boolean;
  requestsPerSecond: number;
  burst?: number;
  maxRetries?: number;
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
  /** Returns an Authorization header value; credentials stay server-side. */
  authorization?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

export class ProviderHttpClient {
  private limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: HttpClientOptions) {
    this.limiter = new RateLimiter(o.requestsPerSecond, o.burst ?? 1);
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  async getJson<T>(url: string): Promise<T> {
    return JSON.parse(await this.getText(url, "application/json")) as T;
  }

  async getText(url: string, accept = "*/*"): Promise<string> {
    const u = assertSafeUrl(url, this.o.allowedHosts, this.o.allowHttp);
    const maxRetries = this.o.maxRetries ?? 5;
    let attempt = 0;
    for (;;) {
      await this.limiter.take();
      // Credential lookup failures (e.g. no connected account) are not transient: never retried.
      const auth = await this.o.authorization?.();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 60_000);
      try {
        const headers: Record<string, string> = { accept, "user-agent": this.o.userAgent ?? "the-lemon-tea/0.1 (+https://github.com/)" };
        if (auth) headers.authorization = auth;
        const res = await this.fetchImpl(u, { headers, signal: ctrl.signal, redirect: "error" });
        if (res.status === 429 || res.status >= 500) {
          if (attempt >= maxRetries) throw new ProviderHttpError(res.status, `Provider responded ${res.status} after ${attempt} retries`);
          const ra = Number(res.headers.get("retry-after"));
          await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff(attempt));
          attempt++;
          continue;
        }
        if (!res.ok) throw new ProviderHttpError(res.status, `Provider responded ${res.status} for ${u.pathname}`);
        const text = await res.text();
        if (text.length > (this.o.maxBytes ?? 200_000_000)) throw new ProviderHttpError(413, "Provider response too large");
        return text;
      } catch (e) {
        if (e instanceof ProviderHttpError) throw e;
        if (attempt >= maxRetries) throw new ProviderHttpError(0, `Provider request failed: ${(e as Error).message}`);
        await sleep(backoff(attempt));
        attempt++;
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

function backoff(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
}
