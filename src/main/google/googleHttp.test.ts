import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { assertAllowed, backoffDelayMs, GoogleApiError, GoogleHttp, NetworkError, parseRetryAfter, parseSessionUri, RequestAborted, RequestNotAllowedError } from './googleHttp';
import { forgetSecret, redact, registerSecret, safeMessage } from './redact';

const ok = (body: unknown = {}): Response => new Response(JSON.stringify(body), { status: 200 });

describe('the allowlist', () => {
  const allowed: [string, string][] = [
    ['POST', 'https://oauth2.googleapis.com/token'],
    // "Sign out" gives only this app's own permission back to Google (G1, 25 Nov 2026); it deletes and changes nothing in Drive.
    ['POST', 'https://oauth2.googleapis.com/revoke'],
    ['GET', 'https://www.googleapis.com/drive/v3/about?fields=user'],
    ['GET', 'https://www.googleapis.com/drive/v3/files?q=x&pageSize=1000&pageToken=t&fields=f'],
    ['GET', 'https://www.googleapis.com/drive/v3/changes?pageToken=1&includeRemoved=true&pageSize=1000&fields=f'],
    ['GET', 'https://www.googleapis.com/drive/v3/changes/startPageToken'],
    ['GET', 'https://openidconnect.googleapis.com/v1/userinfo'],
  ];
  it.each(allowed)('lets %s %s through', (method, url) => {
    expect(() => assertAllowed(method, url)).not.toThrow();
  });

  const refused: [string, string, string][] = [
    ['another host', 'GET', 'https://example.com/drive/v3/files'],
    ['a look-alike host', 'GET', 'https://www.googleapis.com.evil.example/drive/v3/files'],
    ['a sub-host', 'GET', 'https://evil.www.googleapis.com/drive/v3/files'],
    ['plain http', 'GET', 'http://www.googleapis.com/drive/v3/files'],
    ['a port', 'GET', 'https://www.googleapis.com:8443/drive/v3/files'],
    ['credentials in the address', 'GET', 'https://user:pw@www.googleapis.com/drive/v3/files'],
    ['a file id path', 'GET', 'https://www.googleapis.com/drive/v3/files/abc123'],
    ['a file id path with alt=media', 'GET', 'https://www.googleapis.com/drive/v3/files/abc123?alt=media'],
    ['the list with alt=media', 'GET', 'https://www.googleapis.com/drive/v3/files?alt=media'],
    ['the list with alt=json too', 'GET', 'https://www.googleapis.com/drive/v3/files?alt=json'],
    ['export', 'GET', 'https://www.googleapis.com/drive/v3/files/abc/export?mimeType=text/plain'],
    ['a trailing slash', 'GET', 'https://www.googleapis.com/drive/v3/files/'],
    ['dot segments', 'GET', 'https://www.googleapis.com/drive/v3/changes/../files/abc'],
    ['an encoded slash', 'GET', 'https://www.googleapis.com/drive/v3/files%2Fabc'],
    ['a GET on the upload API', 'GET', 'https://www.googleapis.com/upload/drive/v3/files'],
    ['a GET on a session address', 'GET', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc'],
    ['an older API version', 'GET', 'https://www.googleapis.com/drive/v2/files'],
    ['Gmail', 'GET', 'https://www.googleapis.com/gmail/v1/users/me/messages'],
    ['an unlisted option', 'GET', 'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&includeLabels=x'],
    ['a query on the token endpoint', 'POST', 'https://oauth2.googleapis.com/token?x=1'],
    ['the revoke endpoint with a GET', 'GET', 'https://oauth2.googleapis.com/revoke'],
    ['the revoke endpoint with a query', 'POST', 'https://oauth2.googleapis.com/revoke?token=abc'],
    ['a different token path', 'POST', 'https://oauth2.googleapis.com/tokeninfo'],
    ['not a web address', 'GET', 'file:///C:/Windows/win.ini'],
    ['garbage', 'GET', 'not a url'],
  ];
  it.each(refused)('refuses %s', (_why, method, url) => {
    expect(() => assertAllowed(method, url)).toThrow(RequestNotAllowedError);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])('refuses %s on every read-only Drive address', (method) => {
    for (const url of ['https://www.googleapis.com/drive/v3/about', 'https://www.googleapis.com/drive/v3/changes', 'https://www.googleapis.com/drive/v3/changes/startPageToken', 'https://openidconnect.googleapis.com/v1/userinfo']) {
      expect(() => assertAllowed(method, url)).toThrow(RequestNotAllowedError);
    }
  });

  it('refuses GET on the token endpoint', () => {
    expect(() => assertAllowed('GET', 'https://oauth2.googleapis.com/token')).toThrow(RequestNotAllowedError);
  });

  it('lets a POST, a start and a continue through only in their exact shapes', () => {
    const folder = { name: 'Reunion', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] };
    expect(() => assertAllowed('POST', 'https://www.googleapis.com/drive/v3/files?fields=id', folder)).not.toThrow();
    const meta = { name: 'a.mp4', parents: ['fold-1'] };
    expect(() => assertAllowed('POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,md5Checksum,size', meta)).not.toThrow();
    expect(() => assertAllowed('POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', meta)).not.toThrow();
    expect(() => assertAllowed('PUT', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=AEnB2Ur-x_y.z~1')).not.toThrow();
    expect(() => assertAllowed('PUT', 'https://www.googleapis.com/upload/drive/v3/files?upload_id=abc123')).not.toThrow();
    // Google may echo the start's options in the session address: only the one fields value passes.
    expect(() => assertAllowed('PUT', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,md5Checksum,size&upload_id=abc')).not.toThrow();
    expect(() => assertAllowed('PUT', 'https://www.googleapis.com/upload/drive/v3/files?fields=*&upload_id=abc')).toThrow(RequestNotAllowedError);
    // The real shape Google gave on 26 Nov 2026.
    expect(() => assertAllowed('PUT', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,md5Checksum,size&upload_id=abc&session_crd=Q2xp%2BZW50PTE%3D')).not.toThrow();
    expect(() => assertAllowed('PUT', 'https://www.googleapis.com/upload/drive/v3/files?upload_id=abc&session_crd=a&session_crd=b')).toThrow(RequestNotAllowedError);
    expect(() => assertAllowed('PUT', 'https://www.googleapis.com/upload/drive/v3/files?upload_id=abc&session_crd=')).toThrow(RequestNotAllowedError);
    expect(() => assertAllowed('PUT', 'https://www.googleapis.com/upload/drive/v3/files?upload_id=abc&session_crd=a%20b')).toThrow(RequestNotAllowedError);
  });

  const hostileWrites: [string, string, string, unknown][] = [
    ['a folder POST with another type', 'POST', 'https://www.googleapis.com/drive/v3/files', { name: 'x', mimeType: 'application/pdf', parents: ['root'] }],
    ['a folder POST that is a Google Doc', 'POST', 'https://www.googleapis.com/drive/v3/files', { name: 'x', mimeType: 'application/vnd.google-apps.document', parents: ['root'] }],
    ['a POST on the list with no type at all (a plain file)', 'POST', 'https://www.googleapis.com/drive/v3/files', { name: 'x', parents: ['root'] }],
    ['a folder POST with no body', 'POST', 'https://www.googleapis.com/drive/v3/files', undefined],
    ['a folder POST with an extra option', 'POST', 'https://www.googleapis.com/drive/v3/files', { name: 'x', mimeType: 'application/vnd.google-apps.folder', parents: ['root'], shared: true }],
    ['a folder POST with two parents', 'POST', 'https://www.googleapis.com/drive/v3/files', { name: 'x', mimeType: 'application/vnd.google-apps.folder', parents: ['a', 'b'] }],
    ['a folder POST on a file id', 'POST', 'https://www.googleapis.com/drive/v3/files/abc/copy', { name: 'x', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] }],
    ['a folder POST with a supportsAllDrives option', 'POST', 'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', { name: 'x', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] }],
    ['a start that is not resumable (multipart)', 'POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', { name: 'x', parents: ['root'] }],
    ['a start that is not resumable (media)', 'POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=media', { name: 'x', parents: ['root'] }],
    ['a start with no uploadType', 'POST', 'https://www.googleapis.com/upload/drive/v3/files', { name: 'x', parents: ['root'] }],
    ['a start with another answer option', 'POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=*', { name: 'x', parents: ['root'] }],
    ['a start with a type in the body', 'POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', { name: 'x', parents: ['root'], mimeType: 'application/vnd.google-apps.folder' }],
    ['a start that overwrites by id', 'POST', 'https://www.googleapis.com/upload/drive/v3/files/abc?uploadType=resumable', { name: 'x', parents: ['root'] }],
    ['a start on another host', 'POST', 'https://evil.example/upload/drive/v3/files?uploadType=resumable', { name: 'x', parents: ['root'] }],
    ['a session address on another host', 'PUT', 'https://evil.example/upload/drive/v3/files?uploadType=resumable&upload_id=abc', undefined],
    ['a session address on a look-alike host', 'PUT', 'https://www.googleapis.com.evil.example/upload/drive/v3/files?upload_id=abc', undefined],
    ['a session address on a sub-host', 'PUT', 'https://upload.www.googleapis.com/upload/drive/v3/files?upload_id=abc', undefined],
    ['a session address on http', 'PUT', 'http://www.googleapis.com/upload/drive/v3/files?upload_id=abc', undefined],
    ['a session address with a port', 'PUT', 'https://www.googleapis.com:444/upload/drive/v3/files?upload_id=abc', undefined],
    ['a session address with a user name', 'PUT', 'https://user:pw@www.googleapis.com/upload/drive/v3/files?upload_id=abc', undefined],
    ['a session address with a fragment', 'PUT', 'https://www.googleapis.com/upload/drive/v3/files?upload_id=abc#x', undefined],
    ['a session address with no upload_id', 'PUT', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', undefined],
    ['a session address with an empty upload_id', 'PUT', 'https://www.googleapis.com/upload/drive/v3/files?upload_id=', undefined],
    ['a session address with two upload_ids', 'PUT', 'https://www.googleapis.com/upload/drive/v3/files?upload_id=a&upload_id=b', undefined],
    ['a session address with another option', 'PUT', 'https://www.googleapis.com/upload/drive/v3/files?upload_id=abc&supportsAllDrives=true', undefined],
    ['a session address that overwrites by id', 'PUT', 'https://www.googleapis.com/upload/drive/v3/files/abc?upload_id=abc', undefined],
    ['a session address on the plain API path', 'PUT', 'https://www.googleapis.com/drive/v3/files?upload_id=abc', undefined],
    ['a session address with a body', 'PUT', 'https://www.googleapis.com/upload/drive/v3/files?upload_id=abc', { name: 'x' }],
    ['a session address with a multipart type', 'PUT', 'https://www.googleapis.com/upload/drive/v3/files?upload_id=abc&uploadType=multipart', undefined],
    ['PATCH on a file', 'PATCH', 'https://www.googleapis.com/drive/v3/files/abc', { trashed: true }],
    ['PATCH on the list', 'PATCH', 'https://www.googleapis.com/drive/v3/files', { name: 'x' }],
    ['PATCH on the upload address', 'PATCH', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', { name: 'x' }],
    ['DELETE on a file', 'DELETE', 'https://www.googleapis.com/drive/v3/files/abc', undefined],
    ['DELETE on the list', 'DELETE', 'https://www.googleapis.com/drive/v3/files', undefined],
    ['DELETE on a session address', 'DELETE', 'https://www.googleapis.com/upload/drive/v3/files?upload_id=abc', undefined],
    ['emptying the trash', 'DELETE', 'https://www.googleapis.com/drive/v3/files/trash', undefined],
    ['a PUT on the list', 'PUT', 'https://www.googleapis.com/drive/v3/files', undefined],
    ['a PUT on the token endpoint', 'PUT', 'https://oauth2.googleapis.com/token', undefined],
  ];
  it.each(hostileWrites)('refuses %s', (_why, method, url, body) => {
    expect(() => assertAllowed(method, url, body)).toThrow(RequestNotAllowedError);
  });

  it('accepts a session address only in the exact shape', () => {
    const good = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=AEnB2Ur-x_y';
    expect(parseSessionUri(good)).toBe(good);
    for (const bad of [null, '', 'not a url', 'https://example.com/upload/drive/v3/files?upload_id=a', 'https://www.googleapis.com/upload/drive/v3/files?foo=a', '/upload/drive/v3/files?upload_id=a']) {
      expect(parseSessionUri(bad)).toBeNull();
    }
  });

  it('sends nothing for any hostile write, and never follows a redirect', async () => {
    const fetchFn = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(ok({})));
    const http = new GoogleHttp({ fetchFn });
    const folder = { name: 'x', mimeType: 'application/pdf', parents: ['root'] };
    await expect(http.request({ method: 'POST', url: 'https://www.googleapis.com/drive/v3/files', json: folder })).rejects.toBeInstanceOf(RequestNotAllowedError);
    await expect(http.request({ method: 'PUT', url: 'https://evil.example/upload/drive/v3/files?upload_id=abc', bytes: new Uint8Array(4), contentRange: 'bytes 0-3/4' })).rejects.toBeInstanceOf(RequestNotAllowedError);
    await expect(http.request({ method: 'PUT', url: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=abc', bytes: new Uint8Array(4), contentRange: 'bytes 0-3/4; DROP' })).rejects.toBeInstanceOf(RequestNotAllowedError);
    await expect(http.request({ method: 'POST', url: 'https://oauth2.googleapis.com/token', bytes: new Uint8Array(1) })).rejects.toBeInstanceOf(RequestNotAllowedError);
    expect(fetchFn).not.toHaveBeenCalled();

    // A redirect from a session address (even to another host) is an error and is never followed.
    const redirecting = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(new Response('', { status: 307, headers: { Location: 'https://evil.example/steal' } })));
    const put = {
      method: 'PUT' as const,
      url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc',
      bytes: new Uint8Array(4),
      contentRange: 'bytes 0-3/4',
      acceptStatuses: [308],
      noRetry: true,
    };
    await expect(new GoogleHttp({ fetchFn: redirecting }).request(put)).rejects.toMatchObject({ status: 307, reason: 'redirect_refused' });
    expect(redirecting).toHaveBeenCalledTimes(1);
    expect(redirecting.mock.calls[0]![1].redirect).toBe('manual');
    // Even a 308 that carries a Location is a redirect, not "resume incomplete".
    const redirect308 = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(new Response('', { status: 308, headers: { Location: 'https://evil.example/x' } })));
    await expect(new GoogleHttp({ fetchFn: redirect308 }).request(put)).rejects.toMatchObject({ reason: 'redirect_refused' });
    // ...while the real 308 (no Location) is an answer.
    const resume = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(new Response('', { status: 308, headers: { Range: 'bytes=0-1' } })));
    const answer = await new GoogleHttp({ fetchFn: resume }).request(put);
    expect(answer.status).toBe(308);
    expect(answer.headers.range).toBe('bytes=0-1');
    // Every other request still fails at once on a redirect (fetch is told to error).
    const getFetch = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(ok({})));
    await new GoogleHttp({ fetchFn: getFetch }).request({ method: 'GET', url: 'https://www.googleapis.com/drive/v3/about' });
    expect(getFetch.mock.calls[0]![1].redirect).toBe('error');
  });

  it('does not retry a chunk by itself, and sends only the headers it was given', async () => {
    const fetchFn = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(new Response('{}', { status: 503 })));
    const http = new GoogleHttp({ fetchFn, sleep: () => Promise.resolve() });
    await expect(
      http.request({ method: 'PUT', url: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=abc', bytes: new Uint8Array(4), contentRange: 'bytes 0-3/4', noRetry: true, bearer: 'ya29.t' }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const headers = fetchFn.mock.calls[0]![1].headers as Record<string, string>;
    expect(Object.keys(headers).toSorted()).toEqual(['Accept', 'Authorization', 'Content-Range', 'Content-Type']);
  });

  it('sends nothing when a request is refused', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(ok()));
    const http = new GoogleHttp({ fetchFn });
    await expect(http.request({ method: 'GET', url: 'https://www.googleapis.com/drive/v3/files/abc', query: { alt: 'media' } })).rejects.toBeInstanceOf(RequestNotAllowedError);
    await expect(http.request({ method: 'POST', url: 'https://www.googleapis.com/drive/v3/files' })).rejects.toBeInstanceOf(RequestNotAllowedError);
    await expect(http.request({ method: 'GET', url: 'https://evil.example/', bearer: 'ya29.secret-token' })).rejects.toBeInstanceOf(RequestNotAllowedError);
    await expect(http.request({ method: 'GET', url: 'https://www.googleapis.com/drive/v3/files', query: { alt: 'media' } })).rejects.toBeInstanceOf(RequestNotAllowedError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('puts the token only in the Authorization header and never in the address', async () => {
    const fetchFn = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(ok({ files: [] })));
    await new GoogleHttp({ fetchFn }).request({ method: 'GET', url: 'https://www.googleapis.com/drive/v3/files', query: { pageSize: 5 }, bearer: 'ya29.abc' });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://www.googleapis.com/drive/v3/files?pageSize=5');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer ya29.abc');
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
  });
});

describe('downloading one file (only openDownload, only with alt=media)', () => {
  const id = 'abc123XYZ_-9';
  const okBytes = (): Response => new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  const url = (rest: string): string => `https://www.googleapis.com/drive/v3/files/${rest}`;

  it('allows GET files/<id>?alt=media only when a download is asked for', () => {
    expect(() => assertAllowed('GET', url(`${id}?alt=media`), undefined, { download: true })).not.toThrow();
    expect(() => assertAllowed('GET', url(`${id}?alt=media`))).toThrow(RequestNotAllowedError);
  });

  it.each([
    ['another option', url(`${id}?alt=media&fields=id`)],
    ['no alt', url(id)],
    ['alt=json', url(`${id}?alt=json`)],
    ['export', url(`${id}/export?alt=media`)],
    ['the list', 'https://www.googleapis.com/drive/v3/files?alt=media'],
    ['another host', `https://example.com/drive/v3/files/${id}?alt=media`],
    ['plain http', `http://www.googleapis.com/drive/v3/files/${id}?alt=media`],
    ['dot segments', 'https://www.googleapis.com/drive/v3/files/../about?alt=media'],
  ])('refuses a download with %s', (_why, address) => {
    expect(() => assertAllowed('GET', address, undefined, { download: true })).toThrow(RequestNotAllowedError);
  });

  it('refuses every other method and a body', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) expect(() => assertAllowed(method, url(`${id}?alt=media`), undefined, { download: true })).toThrow(RequestNotAllowedError);
    expect(() => assertAllowed('GET', url(`${id}?alt=media`), {}, { download: true })).toThrow(RequestNotAllowedError);
  });

  it('request() never downloads', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(okBytes()));
    await expect(new GoogleHttp({ fetchFn }).request({ method: 'GET', url: url(id), query: { alt: 'media' } })).rejects.toBeInstanceOf(RequestNotAllowedError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('sends the token only in the header, never follows a redirect, and hands back the body', async () => {
    const fetchFn = vi.fn((_u: string, _i: RequestInit) => Promise.resolve(okBytes()));
    const response = await new GoogleHttp({ fetchFn }).openDownload({ fileId: id, bearer: 'ya29.secret' });
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([1, 2, 3]);
    const [address, init] = fetchFn.mock.calls[0]!;
    expect(address).toBe(url(`${id}?alt=media`));
    expect(address).not.toContain('ya29');
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer ya29.secret');
  });

  it('refuses a file id that is not a Drive id, and sends nothing', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(okBytes()));
    await expect(new GoogleHttp({ fetchFn }).openDownload({ fileId: '../about', bearer: 'x' })).rejects.toBeInstanceOf(RequestNotAllowedError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('turns an error answer into GoogleApiError (404) and retries a rate limit', async () => {
    const answers = [new Response(JSON.stringify({ error: { message: 'slow down', errors: [{ reason: 'rateLimitExceeded' }] } }), { status: 403 }), okBytes()];
    const sleeps: number[] = [];
    const http = new GoogleHttp({
      fetchFn: () => Promise.resolve(answers.shift()!),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    expect((await http.openDownload({ fileId: id, bearer: 'x' })).status).toBe(200);
    expect(sleeps).toHaveLength(1);
    const gone = new GoogleHttp({ fetchFn: () => Promise.resolve(new Response(JSON.stringify({ error: { message: 'File not found' } }), { status: 404 })) });
    await expect(gone.openDownload({ fileId: id, bearer: 'x' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('retries', () => {
  it('waits 1 s, 2 s, 4 s, 8 s and then gives up after five tries', async () => {
    const sleeps: number[] = [];
    const fetchFn = vi.fn(() => Promise.resolve(new Response('{}', { status: 503 })));
    const http = new GoogleHttp({ fetchFn, sleep: (ms) => Promise.resolve(void sleeps.push(ms)) });
    await expect(http.request({ method: 'GET', url: 'https://www.googleapis.com/drive/v3/about' })).rejects.toMatchObject({ status: 503 });
    expect(fetchFn).toHaveBeenCalledTimes(5);
    expect(sleeps).toEqual([1000, 2000, 4000, 8000]);
  });

  it('honours Retry-After in seconds and as a date, never less than its own wait', async () => {
    expect(parseRetryAfter('3', 0)).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(parseRetryAfter('nonsense', 0)).toBeNull();
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(backoffDelayMs(1, null)).toBe(1000);
    expect(backoffDelayMs(2, 500)).toBe(2000);
    expect(backoffDelayMs(2, 9000)).toBe(9000);
    expect(backoffDelayMs(2, 999_000)).toBe(60_000);
  });

  it('retries 429 and rate-limit 403, but not other 4xx', async () => {
    const answers = [new Response('{}', { status: 429 }), new Response(JSON.stringify({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }), { status: 403 }), ok({ a: 1 })];
    const sleeps: number[] = [];
    const http = new GoogleHttp({ fetchFn: () => Promise.resolve(answers.shift()!), sleep: (ms) => Promise.resolve(void sleeps.push(ms)) });
    expect((await http.request({ method: 'GET', url: 'https://www.googleapis.com/drive/v3/about' })).json).toEqual({ a: 1 });
    expect(sleeps).toHaveLength(2);

    for (const status of [400, 401, 404, 410]) {
      const fetchFn = vi.fn(() => Promise.resolve(new Response('{}', { status })));
      await expect(new GoogleHttp({ fetchFn }).request({ method: 'GET', url: 'https://www.googleapis.com/drive/v3/about' })).rejects.toBeInstanceOf(GoogleApiError);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    }
    const plain403 = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: { errors: [{ reason: 'insufficientPermissions' }] } }), { status: 403 })));
    await expect(new GoogleHttp({ fetchFn: plain403 }).request({ method: 'GET', url: 'https://www.googleapis.com/drive/v3/about' })).rejects.toMatchObject({ status: 403, reason: 'insufficientPermissions' });
    expect(plain403).toHaveBeenCalledTimes(1);
  });

  it('turns a dead connection into a NetworkError and a stop into RequestAborted', async () => {
    const down = new GoogleHttp({ fetchFn: () => Promise.reject(new TypeError('fetch failed')) });
    await expect(down.request({ method: 'GET', url: 'https://www.googleapis.com/drive/v3/about' })).rejects.toBeInstanceOf(NetworkError);
    const controller = new AbortController();
    controller.abort();
    await expect(new GoogleHttp({ fetchFn: () => Promise.resolve(ok()) }).request({ method: 'GET', url: 'https://www.googleapis.com/drive/v3/about', signal: controller.signal })).rejects.toBeInstanceOf(RequestAborted);
  });
});

describe('redaction', () => {
  it('removes tokens, codes, secrets and Authorization headers from any text', () => {
    const text = [
      'Authorization: Bearer ya29.a0AfH6SMBabc-def_123',
      'header Bearer abc.def-ghi',
      'refresh 1//0gAbCdEfGhIjKlMnOp-qrstu',
      'code 4/0AX4XfWhabcdefghijkl',
      'jwt eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl',
      'form access_token=zzz111&refresh_token=yyy222&client_secret=xxx333&code_verifier=vvv444&code=ccc555&keep=this',
      '{"access_token":"json-token-1","refresh_token": "json-token-2","id_token":"json-token-3","other":"visible"}',
    ].join('\n');
    const out = redact(text);
    for (const leak of ['ya29', 'abc.def-ghi', '1//0gAbC', '4/0AX4', 'eyJhbGci', 'zzz111', 'yyy222', 'xxx333', 'vvv444', 'ccc555', 'json-token-1', 'json-token-2', 'json-token-3']) {
      expect(out).not.toContain(leak);
    }
    expect(out).toContain('keep=this');
    expect(out).toContain('"other":"visible"');
  });

  it('removes secrets registered by value, whatever they look like, until they are forgotten', () => {
    registerSecret('plain-looking-secret-value');
    expect(redact('error with plain-looking-secret-value inside')).toBe('error with [hidden] inside');
    expect(safeMessage(new Error('boom plain-looking-secret-value'))).toBe('boom [hidden]');
    forgetSecret('plain-looking-secret-value');
    expect(redact('plain-looking-secret-value')).toBe('plain-looking-secret-value');
  });

  it('is applied to error messages made from Google answers and from a broken network', async () => {
    const body = JSON.stringify({ error: { message: 'bad Bearer ya29.leaky-token and 1//leaky-refresh' } });
    const err = await new GoogleHttp({ fetchFn: () => Promise.resolve(new Response(body, { status: 400 })) }).request({ method: 'GET', url: 'https://www.googleapis.com/drive/v3/about', bearer: 'ya29.x' }).catch((e: unknown) => e);
    expect((err as Error).message).not.toMatch(/leaky/);
    const net = await new GoogleHttp({ fetchFn: () => Promise.reject(new Error('socket hang up for Bearer ya29.leaky-two')) }).request({ method: 'GET', url: 'https://www.googleapis.com/drive/v3/about' }).catch((e: unknown) => e);
    expect((net as Error).message).not.toMatch(/leaky/);
  });
});

describe('no other file touches the network', () => {
  const FORBIDDEN: [string, RegExp][] = [
    ['fetch(', /(^|[^\w.$])fetch\s*\(/],
    ['globalThis.fetch', /\b(?:globalThis|window|self)\.fetch\b/],
    ['net.request', /\bnet\.(?:request|fetch)\b/],
    ['http.request', /(^|[^\w.$])https?\.(?:request|get)\s*\(/],
    ['importing node:https', /from\s*'(?:node:)?https'/],
    ['importing node:http outside the sign-in server', /from\s*'(?:node:)?http'/],
    ['importing net from electron', /import\s*\{[^}]*\bnet\b[^}]*\}\s*from\s*'electron'/],
    ['XMLHttpRequest', /XMLHttpRequest/],
    ['WebSocket', /\bnew\s+WebSocket\b/],
    ['EventSource', /\bnew\s+EventSource\b/],
    ['sendBeacon', /sendBeacon/],
    ['net.connect', /\bnet\.(?:connect|createConnection|Socket)\b/],
  ];

  function walk(dir: string, out: string[]): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      // Shipped code only: tests (which may talk to a loopback server of their own) are not scanned.
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|testutil)\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it('finds network calls only in googleHttp.ts (all shipped code in src/main, src/renderer, src/shared and src/preload is scanned)', () => {
    const root = path.resolve(__dirname, '..', '..');
    const sources = [...walk(path.join(root, 'main'), []), ...walk(path.join(root, 'renderer'), []), ...walk(path.join(root, 'shared'), []), ...walk(path.join(root, 'preload'), [])];
    expect(sources.length).toBeGreaterThan(50);
    const allowedFile = path.join(root, 'main', 'google', 'googleHttp.ts');
    const signInFile = path.join(root, 'main', 'google', 'signIn.ts');
    const thisFile = path.resolve(__filename);
    const offences: string[] = [];
    for (const file of sources) {
      if (file === allowedFile || file === thisFile) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const [name, pattern] of FORBIDDEN) if (pattern.test(text) && !(file === signInFile && name === 'importing node:http outside the sign-in server')) offences.push(`${path.relative(root, file)}: ${name}`);
    }
    expect(offences).toEqual([]);
    // The one allowed file does contain the call, so the scan is not blind.
    expect(FORBIDDEN[1]![1].test(fs.readFileSync(allowedFile, 'utf8'))).toBe(true);
  });

  it('no shipped file but googleHttp (and the sign-in) names a Google address, and none asks for DELETE, PATCH, trash or a download', () => {
    const root = path.resolve(__dirname, '..', '..');
    const sources = [...walk(path.join(root, 'main'), []), ...walk(path.join(root, 'renderer'), []), ...walk(path.join(root, 'shared'), []), ...walk(path.join(root, 'preload'), [])];
    const allowedFile = path.join(root, 'main', 'google', 'googleHttp.ts');
    const signInFile = path.join(root, 'main', 'google', 'signIn.ts');
    const offences: string[] = [];
    for (const file of sources) {
      const text = fs.readFileSync(file, 'utf8');
      if (file !== allowedFile && file !== signInFile && /googleapis\.com/.test(text)) offences.push(`${path.relative(root, file)}: a Google address`);
      // The one way to read a file's bytes (`openDownload`, "Get files back") is in googleHttp.ts; no other file names it.
      const namesDownload = file !== allowedFile && /\balt:\s*'media'|\balt=media/.test(text);
      if (/method:\s*'(?:DELETE|PATCH)'|trashed:\s*true|\.trash\(|\bfiles\.delete/.test(text) || namesDownload) offences.push(`${path.relative(root, file)}: delete, patch, trash or download`);
    }
    expect(offences).toEqual([]);
  });

  it('googleHttp itself allows exactly GET, POST and PUT, and only the listed addresses', () => {
    const text = fs.readFileSync(path.resolve(__dirname, 'googleHttp.ts'), 'utf8');
    expect(text).toMatch(/type Method = 'GET' \| 'POST' \| 'PUT';/);
    expect(text).not.toMatch(/'DELETE'|'PATCH'|'HEAD'/);
    const methods = [...text.matchAll(/method: '(\w+)',/g)].map((m) => m[1]);
    expect(methods.toSorted((a, b) => (a! < b! ? -1 : 1))).toEqual(['GET', 'GET', 'GET', 'GET', 'GET', 'GET', 'POST', 'POST', 'POST', 'POST', 'PUT']);
    const addresses = [...text.matchAll(/^export const \w+_URL = '(https:\/\/[^']+)'/gm)].map((m) => m[1]);
    expect(addresses.toSorted((a, b) => (a! < b! ? -1 : 1))).toEqual(
      [
        'https://oauth2.googleapis.com/revoke',
        'https://oauth2.googleapis.com/token',
        'https://openidconnect.googleapis.com/v1/userinfo',
        'https://www.googleapis.com/drive/v3/about',
        'https://www.googleapis.com/drive/v3/changes',
        'https://www.googleapis.com/drive/v3/changes/startPageToken',
        'https://www.googleapis.com/drive/v3/files',
        'https://www.googleapis.com/upload/drive/v3/files',
      ].toSorted((a, b) => (a < b ? -1 : 1)),
    );
  });

  it('the scan patterns catch the calls they are meant to catch', () => {
    const samples: Record<string, string> = {
      'fetch(': 'const r = await fetch("https://x");',
      'globalThis.fetch': 'globalThis.fetch(url)',
      'net.request': 'net.request({ url })',
      'http.request': 'https.request(options, cb)',
      'importing node:https': "import https from 'node:https';",
      'importing node:http outside the sign-in server': "import http from 'node:http';",
      'importing net from electron': "import { app, net } from 'electron';",
      XMLHttpRequest: 'new XMLHttpRequest()',
      WebSocket: 'new WebSocket("wss://x")',
      EventSource: 'new EventSource(u)',
      sendBeacon: 'navigator.sendBeacon(u)',
      'net.connect': 'net.connect(80, host)',
    };
    for (const [name, pattern] of FORBIDDEN) expect(pattern.test(samples[name]!)).toBe(true);
    expect(FORBIDDEN[0]![1].test('this.fetchFn(address)')).toBe(false);
    expect(FORBIDDEN[0]![1].test('prefetch(1)')).toBe(false);
  });

  it('the sign-in server is the only place that listens, and only on 127.0.0.1', () => {
    const text = fs.readFileSync(path.resolve(__dirname, 'signIn.ts'), 'utf8');
    expect(text).toMatch(/listen\(0, '127\.0\.0\.1'/);
    expect(text).not.toMatch(/listen\(\s*\d{2,}/);
  });
});


describe('sessionUriProblem (what the report says about a refused upload address)', () => {
  it('names the rule and the shape, never the values', async () => {
    const { sessionUriProblem } = await import('./googleHttp');
    expect(sessionUriProblem(null)).toBe('Google gave no upload address');
    expect(sessionUriProblem('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc')).toBe('accepted');
    const why = sessionUriProblem('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=SECRET1&extra=zz');
    expect(why).toContain('extra');
    expect(why).not.toContain('SECRET1');
  });
});
