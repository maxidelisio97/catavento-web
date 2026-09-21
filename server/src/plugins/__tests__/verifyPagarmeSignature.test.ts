/**
 * sdd/asaas-pagarme-migration design (obs #257), decision A8 — unit tests
 * for `verifyPagarmeSignature.ts`. Uses a SYNTHETIC test secret/signature
 * constructed here (HMAC-SHA256 over a raw body string), never a real
 * Pagar.me payload — legitimate and expected per the design/task brief:
 * the real header name and algorithm are unverified until the account
 * goes live (B2, tasks artifact).
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isValidPagarmeSignature, PAGARME_SIGNATURE_ALGORITHM } from '../verifyPagarmeSignature.js';

const SECRET = 'pagarme-test-webhook-secret';
const RAW_BODY = JSON.stringify({ type: 'order.paid', data: { id: 'or_1' } });

function sign(secret: string, body: string): string {
  return createHmac(PAGARME_SIGNATURE_ALGORITHM, secret).update(body).digest('hex');
}

describe('isValidPagarmeSignature', () => {
  it('accepts a signature computed with the correct secret over the exact raw body', () => {
    const signature = sign(SECRET, RAW_BODY);
    expect(isValidPagarmeSignature(RAW_BODY, signature, SECRET)).toBe(true);
  });

  it('rejects a tampered body (signature computed over a different payload)', () => {
    const signature = sign(SECRET, RAW_BODY);
    const tamperedBody = JSON.stringify({ type: 'order.paid', data: { id: 'or_2' } });
    expect(isValidPagarmeSignature(tamperedBody, signature, SECRET)).toBe(false);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const signature = sign('wrong-secret', RAW_BODY);
    expect(isValidPagarmeSignature(RAW_BODY, signature, SECRET)).toBe(false);
  });

  it('rejects a missing signature header value', () => {
    expect(isValidPagarmeSignature(RAW_BODY, undefined, SECRET)).toBe(false);
  });

  it('rejects a non-string signature header value', () => {
    expect(isValidPagarmeSignature(RAW_BODY, ['sig1', 'sig2'], SECRET)).toBe(false);
  });

  it('rejects a signature of the wrong length without throwing', () => {
    expect(isValidPagarmeSignature(RAW_BODY, 'deadbeef', SECRET)).toBe(false);
  });

  it('rejects an empty secret (never verifies against an unconfigured secret)', () => {
    const signature = sign('', RAW_BODY);
    expect(isValidPagarmeSignature(RAW_BODY, signature, '')).toBe(false);
  });
});
