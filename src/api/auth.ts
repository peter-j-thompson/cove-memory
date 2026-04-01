/**
 * Cove Brain API — Authentication & Rate Limiting Middleware
 *
 * Tiers:
 *   none    — No auth required (health check)
 *   public  — API key required (code-brain / stats endpoints)
 *   private — API key + X-Brain-Scope: full (personal memory endpoints)
 *
 * Dev mode: If BRAIN_API_KEY env var is NOT set, ALL auth is bypassed.
 * Production: Set BRAIN_API_KEY to enforce auth.
 */

import http from 'node:http';

// ─── Tier Definitions ────────────────────────────────────────────────────────

export type AuthTier = 'none' | 'public' | 'private';

// Maps "METHOD /path" → tier
const ENDPOINT_TIERS: Record<string, AuthTier> = {
  // No auth ever (Fly health check)
  'GET /api/health': 'none',

  // Public tier — API key only
  'GET /api/stats': 'public',
  'GET /api/code-brain/history': 'public',
  'POST /api/code-brain/sync': 'public',

  // Private tier — API key + X-Brain-Scope: full
  'POST /api/ingest': 'private',
  'POST /api/query': 'private',
  'POST /api/compare': 'private',
  'POST /api/sleep': 'private',
  'POST /api/backfill': 'private',
  'GET /api/maintenance/reweight': 'private',
};

// ─── Rate Limiting ────────────────────────────────────────────────────────────

const WINDOW_MS = 60 * 1000; // 1 minute sliding window
const RATE_LIMITS: Record<Exclude<AuthTier, 'none'>, number> = {
  public: 100,
  private: 1000,
};

interface WindowEntry {
  count: number;
  windowStart: number;
}

const rateLimitMap = new Map<string, WindowEntry>();

// Clean up stale entries every 5 minutes (use unref so it doesn't block exit)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap.entries()) {
    if (now - entry.windowStart >= WINDOW_MS * 2) {
      rateLimitMap.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

function checkRateLimit(ip: string, tier: Exclude<AuthTier, 'none'>): { allowed: boolean; retryAfter?: number } {
  const limit = RATE_LIMITS[tier];
  const key = `${ip}:${tier}`;
  const now = Date.now();

  let entry = rateLimitMap.get(key);
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    entry = { count: 0, windowStart: now };
  }

  entry.count++;
  rateLimitMap.set(key, entry);

  if (entry.count > limit) {
    const retryAfter = Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfter };
  }

  return { allowed: true };
}

// ─── CORS ─────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  'https://your-domain.com',
];

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // https://*.vercel.app
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin)) return true;
  // http://localhost (any port)
  if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return true;
  return false;
}

/**
 * Resolve the correct Access-Control-Allow-Origin value for this request.
 * - Local dev mode (no BRAIN_API_KEY): allow any origin.
 * - Production: strict whitelist only.
 */
export function resolveAllowedOrigin(req: http.IncomingMessage): string | null {
  const origin = req.headers['origin'];
  if (!origin) return null;

  // Dev mode — allow all
  if (!process.env.BRAIN_API_KEY) return origin;

  // Production — strict whitelist
  return isAllowedOrigin(origin) ? origin : null;
}

// ─── Auth Check ───────────────────────────────────────────────────────────────

export interface AuthResult {
  allowed: boolean;
  status?: number;
  error?: string;
  retryAfter?: number;
}

/**
 * Check authentication for an incoming request.
 * Called ONCE per request before any business logic.
 */
export function checkAuth(req: http.IncomingMessage, path: string): AuthResult {
  const method = req.method || 'GET';

  // OPTIONS preflight — always pass through (CORS headers handled separately)
  if (method === 'OPTIONS') return { allowed: true };

  // Determine tier
  const endpointKey = `${method} ${path}`;
  const tier: AuthTier = ENDPOINT_TIERS[endpointKey] ?? 'public';

  // /api/health (and any 'none' tier) — no auth, no rate limiting
  if (tier === 'none') return { allowed: true };

  const apiKey = process.env.BRAIN_API_KEY;

  // ── Rate limiting (only when auth is active) ──
  if (apiKey) {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      ?? req.socket?.remoteAddress
      ?? 'unknown';

    const rl = checkRateLimit(ip, tier);
    if (!rl.allowed) {
      return {
        allowed: false,
        status: 429,
        error: 'Too Many Requests — slow down',
        retryAfter: rl.retryAfter,
      };
    }
  }

  // ── Dev mode (no BRAIN_API_KEY set) — skip auth entirely ──
  if (!apiKey) return { allowed: true };

  // ── API key check ──
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      allowed: false,
      status: 401,
      error: 'Authorization: Bearer <api-key> header required',
    };
  }

  const providedKey = authHeader.slice(7).trim();
  if (providedKey !== apiKey) {
    return { allowed: false, status: 401, error: 'Invalid API key' };
  }

  // ── Private tier — also requires X-Brain-Scope: full ──
  if (tier === 'private') {
    const scope = req.headers['x-brain-scope'];
    if (scope !== 'full') {
      return {
        allowed: false,
        status: 403,
        error: 'This endpoint requires X-Brain-Scope: full header',
      };
    }
  }

  return { allowed: true };
}
