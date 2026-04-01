/**
 * Ingest Safety Guard — Filters messages before they reach the brain.
 * 
 * This is the security boundary between conversations and memory.
 * NOTHING enters the brain without passing through here.
 */

// Minimum message length to ingest (skip noise)
const MIN_LENGTH = 15;

// Maximum message length (truncate, don't reject)
const MAX_LENGTH = 2000;

// Rate limiting
let lastIngestTime = 0;
const MIN_INTERVAL_MS = 5000; // 5 seconds between ingests

// Patterns that should NEVER be ingested
const CREDENTIAL_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/,           // OpenAI keys
  /ghp_[a-zA-Z0-9]{36,}/,          // GitHub PATs
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/, // Private keys
  /Bearer [a-zA-Z0-9\-._~+/]+=*/,  // Bearer tokens
  /password[:\s]*[^\s]{8,}/i,       // Passwords in text
  /token[:\s]*[a-zA-Z0-9\-._]{20,}/i, // Generic tokens
  /AKIA[0-9A-Z]{16}/,              // AWS keys
  /xoxb-[0-9]{10,}-/,              // Slack tokens
  /eyJ[a-zA-Z0-9_-]{20,}\./,       // JWTs
];

// Messages to skip entirely
const SKIP_PATTERNS = [
  /^HEARTBEAT_OK$/i,
  /^NO_REPLY$/i,
  /^\s*$/,
  /^Read HEARTBEAT\.md/,
  /^\[system\]/i,
  /^Pre-compaction memory flush/,
  /^Session was just compacted/,
];

export interface GuardResult {
  allowed: boolean;
  reason?: string;
  sanitizedText?: string;
  sender?: string;
}

export function guardIngest(text: string, sender: string): GuardResult {
  // 1. Skip system/heartbeat messages
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(text)) {
      return { allowed: false, reason: 'system_message' };
    }
  }

  // 2. Minimum length
  if (text.length < MIN_LENGTH) {
    return { allowed: false, reason: 'too_short' };
  }

  // 3. Rate limiting
  const now = Date.now();
  if (now - lastIngestTime < MIN_INTERVAL_MS) {
    return { allowed: false, reason: 'rate_limited' };
  }

  // 4. Credential detection — REJECT entirely
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) {
      return { allowed: false, reason: 'contains_credentials' };
    }
  }

  // 5. Sanitize: truncate, strip any remaining suspicious patterns
  let sanitized = text.substring(0, MAX_LENGTH);
  
  // Strip file paths that might contain secrets
  sanitized = sanitized.replace(/~\/\.agent\/secrets\/[^\s]*/g, '[REDACTED_PATH]');
  sanitized = sanitized.replace(/\/Users\/[^/]+\/\.ssh\/[^\s]*/g, '[REDACTED_PATH]');

  // Update rate limit timestamp
  lastIngestTime = now;

  return {
    allowed: true,
    sanitizedText: sanitized,
    sender: sender || 'unknown',
  };
}
