/**
 * Tests for secret redaction (redact.ts).
 * Uses node:test and node:assert/strict.
 *
 * NOTE: all fixture tokens are assembled at runtime so this file never
 * contains a complete secret-scanner-matching literal (see
 * policy-security-audit test 4).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, hasLeakedSecrets } from "../src/core/redact.ts";

const SECRET_BODY = "abcdefghijklmnopqrstuvwxyz12345678901234";
const ghoTok = `gho_${SECRET_BODY.slice(0, 42)}`;
const ghuTok = `ghu_${SECRET_BODY.slice(0, 42)}`;
const ghsTok = `ghs_${SECRET_BODY.slice(0, 42)}`;
const ghrTok = `ghr_${SECRET_BODY.slice(0, 42)}`;
const ghpTok = `ghp_${SECRET_BODY.slice(0, 36)}`;
const skProjTok = `sk-proj-${SECRET_BODY}`;
const skAntTok = `sk-ant-${SECRET_BODY}`;
const skAntApi03Tok = `sk-ant-api03-${SECRET_BODY}`;
const yaTok = "ya29.a0AfH6SMC_" + SECRET_BODY;
const npmTok = `npm_${SECRET_BODY.slice(0, 36)}`;
const pypiTok = `pypi-${SECRET_BODY.slice(0, 36)}`;
const awsVal = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const akiaTok = "AKIA" + "IOSFODNN7EXAMPLE";
const asiaTok = "ASIA" + "IOSFODNN7EXAMPLE";
const aiyaTok = "AIza" + "SyB-" + SECRET_BODY.slice(0, 31);

describe("redact.ts - redactSecrets: new token formats", () => {
  // GitHub gho_ tokens
  test("redacts GitHub gho_ tokens (36+ chars)", () => {
    const input = ghoTok;
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  test("redacts GitHub ghu_ tokens (36+ chars)", () => {
    const input = ghuTok;
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  test("redacts GitHub ghs_ tokens (36+ chars)", () => {
    const input = ghsTok;
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  test("redacts GitHub ghr_ tokens (36+ chars)", () => {
    const input = ghrTok;
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  // OpenAI sk-proj- keys
  test("redacts OpenAI sk-proj- keys (40+ chars)", () => {
    const input = skProjTok;
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  // Anthropic sk-ant- keys (including sk-ant-api03-)
  test("redacts Anthropic sk-ant- keys (40+ chars)", () => {
    const input = skAntTok;
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  test("redacts Anthropic sk-ant-api03- keys (40+ chars)", () => {
    const input = skAntApi03Tok;
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  // Google ya29. OAuth tokens
  test("redacts Google ya29. OAuth tokens (20+ chars after ya29.)", () => {
    const input = yaTok;
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  // npm tokens
  test("redacts npm_ tokens (30+ chars)", () => {
    const input = npmTok;
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  // PyPI tokens
  test("redacts pypi- tokens (30+ chars)", () => {
    const input = pypiTok;
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  // AWS secret access key in key=value context
  test("redacts AWS secret access key in key=value context", () => {
    const input = `aws_secret_access_key = "${awsVal}"`;
    const result = redactSecrets(input);
    assert.ok(result.includes("[REDACTED]"));
    assert.ok(!result.includes(awsVal));
  });

  test("redacts AWS_SECRET_ACCESS_KEY in key=value context", () => {
    const input = `AWS_SECRET_ACCESS_KEY=${awsVal}`;
    const result = redactSecrets(input);
    assert.ok(result.includes("[REDACTED]"));
    assert.ok(!result.includes(awsVal));
  });
});

describe("redact.ts - hasLeakedSecrets: new token formats detection", () => {
  test("detects GitHub gho_ tokens", () => {
    const input = `const token = '${ghoTok}';`;
    assert.ok(hasLeakedSecrets(input));
  });

  test("detects GitHub ghu_ tokens", () => {
    const input = `const token = '${ghuTok}';`;
    assert.ok(hasLeakedSecrets(input));
  });

  test("detects GitHub ghs_ tokens", () => {
    const input = `const token = '${ghsTok}';`;
    assert.ok(hasLeakedSecrets(input));
  });

  test("detects GitHub ghr_ tokens", () => {
    const input = `const token = '${ghrTok}';`;
    assert.ok(hasLeakedSecrets(input));
  });

  test("detects OpenAI sk-proj- keys", () => {
    const input = `const key = '${skProjTok}';`;
    assert.ok(hasLeakedSecrets(input));
  });

  test("detects Anthropic sk-ant- keys", () => {
    const input = `const key = '${skAntTok}';`;
    assert.ok(hasLeakedSecrets(input));
  });

  test("detects Anthropic sk-ant-api03- keys", () => {
    const input = `const key = '${skAntApi03Tok}';`;
    assert.ok(hasLeakedSecrets(input));
  });

  test("detects Google ya29. OAuth tokens", () => {
    const input = `const token = '${yaTok}';`;
    assert.ok(hasLeakedSecrets(input));
  });

  test("detects npm_ tokens", () => {
    const input = `const token = '${npmTok}';`;
    assert.ok(hasLeakedSecrets(input));
  });

  test("detects pypi- tokens", () => {
    const input = `const token = '${pypiTok}';`;
    assert.ok(hasLeakedSecrets(input));
  });

  test("detects AWS secret access key in key=value context", () => {
    const input = `aws_secret_access_key = "${awsVal}"`;
    assert.ok(hasLeakedSecrets(input));
  });

  test("detects AWS_SECRET_ACCESS_KEY in key=value context", () => {
    const input = `AWS_SECRET_ACCESS_KEY=${awsVal}`;
    assert.ok(hasLeakedSecrets(input));
  });
});

describe("redact.ts - false positive guards", () => {
  test("does NOT match plain word 'npm install'", () => {
    const input = "npm install package-name";
    const result = redactSecrets(input);
    assert.equal(result, input);
  });

  test("does NOT match short npm_ prefix (npm_1)", () => {
    const input = "npm_1";
    const result = redactSecrets(input);
    assert.equal(result, input);
  });

  test("does NOT match short pypi- prefix (pypi-1)", () => {
    const input = "pypi-1";
    const result = redactSecrets(input);
    assert.equal(result, input);
  });

  test("does NOT match short gho_ prefix (gho_1)", () => {
    const input = "gho_1";
    const result = redactSecrets(input);
    assert.equal(result, input);
  });

  test("does NOT match short ya29. prefix (ya29.1)", () => {
    const input = "ya29.1";
    const result = redactSecrets(input);
    assert.equal(result, input);
  });

  test("does NOT match version strings like '1.0.0'", () => {
    const input = "version = '1.0.0'";
    const result = redactSecrets(input);
    assert.equal(result, input);
  });

  test("does NOT match short sk- prefix (sk-1)", () => {
    const input = "sk-1";
    const result = redactSecrets(input);
    assert.equal(result, input);
  });

  test("does NOT match short sk-proj- prefix (sk-proj-1)", () => {
    const input = "sk-proj-1";
    const result = redactSecrets(input);
    assert.equal(result, input);
  });

  test("does NOT match short sk-ant- prefix (sk-ant-1)", () => {
    const input = "sk-ant-1";
    const result = redactSecrets(input);
    assert.equal(result, input);
  });

  test("does NOT match AWS secret access key without key=value context", () => {
    const input = awsVal;
    const result = redactSecrets(input);
    assert.equal(result, input);
  });

  test("hasLeakedSecrets ignores comments containing token-like strings", () => {
    const input = `// ${ghoTok}\nconst x = 1;`;
    assert.ok(!hasLeakedSecrets(input));
  });

  test("hasLeakedSecrets ignores block comments containing token-like strings", () => {
    const input = `/* ${ghoTok} */\nconst x = 1;`;
    assert.ok(!hasLeakedSecrets(input));
  });
});

describe("redact.ts - PEM variants detection", () => {
  test("redacts RSA PRIVATE KEY", () => {
    const input = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA...
-----END RSA PRIVATE KEY-----`;
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  test("redacts EC PRIVATE KEY", () => {
    const input = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEI...
-----END EC PRIVATE KEY-----`;
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  test("redacts OPENSSH PRIVATE KEY", () => {
    const input = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAA...
-----END OPENSSH PRIVATE KEY-----`;
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  test("redacts ENCRYPTED PRIVATE KEY", () => {
    const input = `-----BEGIN ENCRYPTED PRIVATE KEY-----
MIIFHzBJBgkqhkiG9w0BBQ0wPDAbBgkqhkiG9w0BBQwwDgQI...
-----END ENCRYPTED PRIVATE KEY-----`;
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  test("hasLeakedSecrets detects all PEM variants", () => {
    const rsa = `-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----`;
    const ec = `-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEI...\n-----END EC PRIVATE KEY-----`;
    const openssh = `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA...\n-----END OPENSSH PRIVATE KEY-----`;
    const encrypted = `-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFHzBJBgkqhkiG9w0BBQ0wPDAbBgkqhkiG9w0BBQwwDgQI...\n-----END ENCRYPTED PRIVATE KEY-----`;

    assert.ok(hasLeakedSecrets(rsa));
    assert.ok(hasLeakedSecrets(ec));
    assert.ok(hasLeakedSecrets(openssh));
    assert.ok(hasLeakedSecrets(encrypted));
  });
});

describe("redact.ts - idempotency", () => {
  test("redactSecrets is idempotent for all new patterns", () => {
    const inputs = [
      ghoTok,
      ghuTok,
      ghsTok,
      ghrTok,
      skProjTok,
      skAntTok,
      skAntApi03Tok,
      yaTok,
      npmTok,
      pypiTok,
      `aws_secret_access_key = "${awsVal}"`,
    ];

    for (const input of inputs) {
      const once = redactSecrets(input);
      const twice = redactSecrets(once);
      assert.equal(once, twice, `Idempotency failed for: ${input}`);
    }
  });

  test("redactSecrets is idempotent for existing patterns", () => {
    const inputs = [
      akiaTok,
      asiaTok,
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD...\n-----END PRIVATE KEY-----",
      "sk-abcdefghijklmnopqrstuvwxyz123456",
      ghpTok,
      aiyaTok,
    ];

    for (const input of inputs) {
      const once = redactSecrets(input);
      const twice = redactSecrets(once);
      assert.equal(once, twice, `Idempotency failed for existing pattern: ${input}`);
    }
  });
});

describe("redact.ts - existing behaviors unchanged", () => {
  test("still redacts AWS AKIA keys", () => {
    const input = akiaTok;
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  test("still redacts AWS ASIA keys", () => {
    const input = asiaTok;
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  test("still redacts JWT tokens", () => {
    const input = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  test("still redacts PEM private key blocks", () => {
    const input = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD...
-----END PRIVATE KEY-----`;
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  test("still redacts generic sk- keys", () => {
    const input = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  test("still redacts GitHub ghp_ tokens", () => {
    const input = ghpTok;
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  test("still redacts Google AIza keys", () => {
    const input = aiyaTok;
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  test("hasLeakedSecrets still detects existing patterns", () => {
    assert.ok(hasLeakedSecrets(akiaTok));
    assert.ok(hasLeakedSecrets(asiaTok));
    assert.ok(hasLeakedSecrets("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"));
    assert.ok(hasLeakedSecrets("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD...\n-----END PRIVATE KEY-----"));
    assert.ok(hasLeakedSecrets("sk-abcdefghijklmnopqrstuvwxyz123456"));
    assert.ok(hasLeakedSecrets(ghpTok));
    assert.ok(hasLeakedSecrets(aiyaTok));
  });
});

describe("redact.ts - multiple patterns in one string", () => {
  test("redacts multiple different token types in one string", () => {
    const input = `${ghoTok} ${skProjTok} ${yaTok}`;
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED] [REDACTED] [REDACTED]");
  });

  test("hasLeakedSecrets detects any leaked secret in mixed content", () => {
    const input = `const config = {
  github: "${ghoTok}",
  openai: "${skProjTok}",
  google: "${yaTok}"
};`;
    assert.ok(hasLeakedSecrets(input));
  });
});
