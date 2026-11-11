/**
 * Secret redaction utility.
 * Replaces sensitive patterns with [REDACTED].
 */

const REDACTED = "[REDACTED]";

const TS_TYPES_OR_KEYWORDS = new Set([
  "string",
  "number",
  "boolean",
  "any",
  "unknown",
  "never",
  "void",
  "null",
  "undefined",
  "true",
  "false",
  "object",
  "symbol",
  "bigint",
]);

function isLikelyCodeIdentifierOrType(val: string): boolean {
  const clean = val.replace(/[;,)\]]+$/, "").trim();
  if (!clean || clean === REDACTED) return true;
  if (TS_TYPES_OR_KEYWORDS.has(clean.toLowerCase())) return true;
  // Property chains or function calls like req.headers.token, user.password, getToken()
  if (/[.()[\]{}]/.test(clean)) return true;
  return false;
}

/**
 * Redact secrets from input text (used for logs and session summaries).
 * Patterns covered:
 * - AWS keys: AKIA[0-9A-Z]{16} and ASIA[0-9A-Z]{16}
 * - AWS secret access keys: 40-char base64-ish in key=value context
 * - JWT tokens: eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+
 * - PEM private key blocks: -----BEGIN [A-Z ]*PRIVATE KEY-----...-----END [A-Z ]*PRIVATE KEY-----
 * - OpenAI/Anthropic-style: sk-[A-Za-z0-9_-]{16,}, sk-proj-[A-Za-z0-9_-]{40,}, sk-ant-[A-Za-z0-9_-]{40,}
 * - GitHub: ghp_[A-Za-z0-9]{20,}, gho_/ghu_/ghs_/ghr_[A-Za-z0-9]{36,}
 * - Google: AIza[0-9A-Za-z_-]{35}, ya29\.[A-Za-z0-9_-]{20,}
 * - npm: npm_[A-Za-z0-9]{30,}
 * - PyPI: pypi-[A-Za-z0-9_-]{30,}
 * - Generic assignments: password, secret, token, api_key key-value assignments
 */
export function redactSecrets(input: string): string {
  let result = input;

  // AWS Access Key IDs (AKIA/ASIA)
  result = result.replace(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED);

  // AWS Secret Access Keys (40-char base64-ish) in key=value context (with optional quotes)
  result = result.replace(
    /\b(aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*["']?[A-Za-z0-9+/=]{40}["']?\b/g,
    (match) => match.replace(/["']?[A-Za-z0-9+/=]{40}["']?$/, REDACTED)
  );

  // JWT tokens (three base64url parts separated by dots)
  result = result.replace(
    /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    REDACTED
  );

  // PEM private key blocks (multi-line)
  result = result.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    REDACTED
  );

  // OpenAI/Anthropic-style keys: sk-proj-, sk-ant- (including sk-ant-api03-), then generic sk-
  // Order matters: specific prefixes first, then generic sk- to avoid double-redaction
  result = result.replace(/\bsk-proj-[A-Za-z0-9_-]{40,}\b/g, REDACTED);
  result = result.replace(/\bsk-ant-[A-Za-z0-9_-]{40,}\b/g, REDACTED);
  result = result.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, REDACTED);

  // GitHub tokens: gho_, ghu_, ghs_, ghr_ (36+ chars), then ghp_ (20+ chars)
  result = result.replace(/\bgho_[A-Za-z0-9]{36,}\b/g, REDACTED);
  result = result.replace(/\bghu_[A-Za-z0-9]{36,}\b/g, REDACTED);
  result = result.replace(/\bghs_[A-Za-z0-9]{36,}\b/g, REDACTED);
  result = result.replace(/\bghr_[A-Za-z0-9]{36,}\b/g, REDACTED);
  result = result.replace(/\bghp_[A-Za-z0-9]{20,}\b/g, REDACTED);

  // Google API keys (AIza...)
  result = result.replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED);

  // Google OAuth tokens (ya29.)
  result = result.replace(/\bya29\.[A-Za-z0-9_-]{20,}\b/g, REDACTED);

  // npm tokens (npm_)
  result = result.replace(/\bnpm_[A-Za-z0-9]{30,}\b/g, REDACTED);

  // PyPI tokens (pypi-)
  result = result.replace(/\bpypi-[A-Za-z0-9_-]{30,}\b/g, REDACTED);

  const quotedPatterns = [
    /(\bpassword["']?\s*[:=]\s*)(["'])([^"']+)\2/gi,
    /(\bsecret["']?\s*[:=]\s*)(["'])([^"']+)\2/gi,
    /(\btoken["']?\s*[:=]\s*)(["'])([^"']+)\2/gi,
    /(\bapi[_-]?key["']?\s*[:=]\s*)(["'])([^"']+)\2/gi,
  ];

  for (const pattern of quotedPatterns) {
    result = result.replace(pattern, (match, prefix, quote, value) => {
      if (
        value === REDACTED ||
        isLikelyCodeIdentifierOrType(value) ||
        String(value).startsWith("${")
      ) {
        return match;
      }
      return `${prefix}${quote}${REDACTED}${quote}`;
    });
  }

  const unquotedPatterns = [
    /(\bpassword\s*[:=]\s*)([^"'\s,};)]+)/gi,
    /(\bsecret\s*[:=]\s*)([^"'\s,};)]+)/gi,
    /(\btoken\s*[:=]\s*)([^"'\s,};)]+)/gi,
    /(\bapi[_-]?key\s*[:=]\s*)([^"'\s,};)]+)/gi,
  ];

  for (const pattern of unquotedPatterns) {
    result = result.replace(pattern, (match, prefix, value) => {
      if (isLikelyCodeIdentifierOrType(value)) return match;
      return `${prefix}${REDACTED}`;
    });
  }

  return result;
}

/**
 * High-confidence secret detector for source code files during workspace verification.
 * Avoids false-positive rollbacks on normal TypeScript/JavaScript code (e.g. `token: string`,
 * `const token = req.token`, or short test placeholders).
 */
export function hasLeakedSecrets(content: string): boolean {
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(?<![:\\])\/\/[^\r\n]*/g, " ");

  if (/\b(AKIA|ASIA)[0-9A-Z]{16}\b/.test(stripped)) return true;
  if (/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(stripped)) {
    return true;
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(stripped)) return true;

  // AWS Secret Access Key in key=value context (with optional quotes)
  if (/\b(aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*["']?[A-Za-z0-9+/=]{40}["']?\b/.test(stripped)) {
    return true;
  }

  const skMatches = stripped.match(/\bsk-[A-Za-z0-9_-]{16,}\b/g);
  if (skMatches) {
    for (const token of skMatches) {
      const body = token.replace(/^sk-(?:proj-|ant-(?:api\d+-)?)?/, "");
      const hasDigitOrUpper = /[0-9A-Z]/.test(body);
      const hasLongContiguousRun = /[A-Za-z0-9]{14,}/.test(body);
      if (hasDigitOrUpper || hasLongContiguousRun) {
        return true;
      }
    }
  }

  // GitHub tokens: gho_, ghu_, ghs_, ghr_ (36+ chars), ghp_ (20+ chars)
  if (/\bgho_[A-Za-z0-9]{36,}\b/.test(stripped)) return true;
  if (/\bghu_[A-Za-z0-9]{36,}\b/.test(stripped)) return true;
  if (/\bghs_[A-Za-z0-9]{36,}\b/.test(stripped)) return true;
  if (/\bghr_[A-Za-z0-9]{36,}\b/.test(stripped)) return true;
  if (/\bghp_[A-Za-z0-9]{20,}\b/.test(stripped)) return true;

  // Google API keys (AIza...)
  if (/\bAIza[0-9A-Za-z_-]{35}\b/.test(stripped)) return true;

  // Google OAuth tokens (ya29.)
  if (/\bya29\.[A-Za-z0-9_-]{20,}\b/.test(stripped)) return true;

  // npm tokens (npm_)
  if (/\bnpm_[A-Za-z0-9]{30,}\b/.test(stripped)) return true;

  // PyPI tokens (pypi-)
  if (/\bpypi-[A-Za-z0-9_-]{30,}\b/.test(stripped)) return true;

  return false;
}
