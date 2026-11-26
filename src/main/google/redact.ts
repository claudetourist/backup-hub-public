/**
 * One place that removes secrets from any text before it is logged, shown, stored in a job or put
 * in an error. Tokens, authorization codes, client secrets and Authorization headers must never
 * leave the vault in any other way.
 */

const MASK = '[hidden]';

/** Shapes Google uses, plus key=value / "key":"value" pairs for the sensitive field names. */
const PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bya29\.[A-Za-z0-9._-]+/g,
  /\b1\/\/[A-Za-z0-9._-]+/g,
  /\b4\/[A-Za-z0-9._-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  /("?(?:access_token|refresh_token|id_token|client_secret|code_verifier|authorization|code)"?\s*[:=]\s*)"[^"]*"/gi,
  /((?:access_token|refresh_token|id_token|client_secret|code_verifier|code)=)[^&\s"']+/gi,
  /(Authorization\s*[:=]\s*)[^\r\n,;]+/gi,
  // The address of an upload in progress is a key to that upload.
  /(upload_id=)[A-Za-z0-9_.~-]+/gi,
];

const known = new Set<string>();

/** Registers a secret value so that every later `redact` removes it, whatever its shape. */
export function registerSecret(value: string | null | undefined): void {
  if (typeof value === 'string' && value.length >= 6) known.add(value);
}

export function forgetSecret(value: string | null | undefined): void {
  if (typeof value === 'string') known.delete(value);
}

/** Email addresses; shown as [email] in logs (the log files may be sent to someone who helps, and must not hold the household's addresses). */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

export function redact(text: string): string {
  let out = text;
  for (const secret of known) out = out.split(secret).join(MASK);
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (_all, prefix: unknown) => (typeof prefix === 'string' ? `${prefix}${MASK}` : MASK));
  }
  return out;
}

/** Everything `redact` removes, plus email addresses (replaced by [email]). Every log line goes through this (logger.ts). */
export function redactForLog(text: string): string {
  return redact(text).replace(EMAIL, '[email]');
}

/** Text of an unknown error with secrets removed, for logs and job warnings. */
export function safeMessage(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err));
}
