import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import reactPlugin from '@vitejs/plugin-react';
import { DEV_CSP, DEV_REACT_REFRESH_PREAMBLE_HASH, PRODUCTION_CSP } from './csp';

const directive = (policy: string, name: string): string[] =>
  (policy.split(';').map((d) => d.trim().split(/\s+/)).find((d) => d[0] === name) ?? []).slice(1);

describe('PRODUCTION_CSP', () => {
  it('has no unsafe-* keyword, no remote host and no wildcard', () => {
    expect(PRODUCTION_CSP).not.toMatch(/unsafe-/);
    expect(PRODUCTION_CSP).not.toMatch(/https?:|wss?:|\*/);
    expect(PRODUCTION_CSP).not.toMatch(/\/\/|\.com|\.net|\.org/);
  });
  it('allows only its own files, data: images, and nothing else', () => {
    expect(directive(PRODUCTION_CSP, 'default-src')).toEqual(["'self'"]);
    expect(directive(PRODUCTION_CSP, 'script-src')).toEqual(["'self'"]);
    expect(directive(PRODUCTION_CSP, 'style-src')).toEqual(["'self'"]);
    expect(directive(PRODUCTION_CSP, 'connect-src')).toEqual(["'self'"]);
    expect(directive(PRODUCTION_CSP, 'img-src')).toEqual(["'self'", 'data:']);
    expect(directive(PRODUCTION_CSP, 'object-src')).toEqual(["'none'"]);
  });
});

describe('DEV_CSP', () => {
  it('differs from production only in the Vite dev needs: the preamble hash, inline styles, the local web socket', () => {
    expect(directive(DEV_CSP, 'script-src')).toEqual(["'self'", `'${DEV_REACT_REFRESH_PREAMBLE_HASH}'`]);
    expect(directive(DEV_CSP, 'style-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directive(DEV_CSP, 'connect-src')).toEqual(["'self'", 'ws://localhost:*']);
    for (const name of ['default-src', 'img-src', 'font-src', 'object-src', 'base-uri', 'form-action']) {
      expect(directive(DEV_CSP, name)).toEqual(directive(PRODUCTION_CSP, name));
    }
  });
  it('lets no script run unchecked and reaches no remote host', () => {
    expect(directive(DEV_CSP, 'script-src')).not.toContain("'unsafe-inline'");
    expect(directive(DEV_CSP, 'script-src')).not.toContain("'unsafe-eval'");
    expect(DEV_CSP).not.toMatch(/https?:|\*\.|wss:/);
  });
  it('the preamble hash matches the script the installed React plugin injects (update csp.ts when the plugin changes it)', () => {
    const preamble = (reactPlugin as unknown as { preambleCode: string }).preambleCode.replace('__BASE__', '/');
    expect(`sha256-${createHash('sha256').update(preamble).digest('base64')}`).toBe(DEV_REACT_REFRESH_PREAMBLE_HASH);
  });
});
