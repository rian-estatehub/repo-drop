import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import callback from '../api/callback.js';
import login from '../api/login.js';

function fakeRes() {
  const headers = {};
  return {
    statusCode: 200,
    body: '',
    headers,
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
    end(b = '') {
      this.body = b;
    }
  };
}

describe('api/callback', () => {
  const realFetch = globalThis.fetch;
  let calls;

  beforeEach(() => {
    calls = [];
    process.env.GITHUB_CLIENT_ID = 'cid';
    process.env.GITHUB_CLIENT_SECRET = 'sec';
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('a state that does not match the cookie is refused and GitHub is never called', async () => {
    globalThis.fetch = async (...a) => (calls.push(a), { json: async () => ({ access_token: 'x' }) });
    const res = fakeRes();
    await callback({ url: '/api/callback?code=abc&state=forged', headers: { cookie: 'rd_state=real' } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
    assert.ok(!res.headers.location);
  });

  test('a missing cookie is refused', async () => {
    globalThis.fetch = async (...a) => (calls.push(a), { json: async () => ({}) });
    const res = fakeRes();
    await callback({ url: '/api/callback?code=abc&state=s1', headers: {} }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
  });

  test('an empty state with an empty cookie is refused', async () => {
    const res = fakeRes();
    await callback({ url: '/api/callback?code=abc', headers: { cookie: 'rd_state=' } }, res);
    assert.equal(res.statusCode, 400);
  });

  test('a good state exchanges the code and redirects to /#token=', async () => {
    globalThis.fetch = async (url, init) => {
      calls.push([url, JSON.parse(init.body)]);
      return { json: async () => ({ access_token: 'gho_abc123' }) };
    };
    const res = fakeRes();
    await callback({ url: '/api/callback?code=thecode&state=s1', headers: { cookie: 'other=1; rd_state=s1' } }, res);
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/#token=gho_abc123');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'https://github.com/login/oauth/access_token');
    assert.deepEqual(calls[0][1], { client_id: 'cid', client_secret: 'sec', code: 'thecode' });
    assert.match(res.headers['set-cookie'], /rd_state=;.*Max-Age=0/);
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  test('a GitHub error comes back as /#error=', async () => {
    globalThis.fetch = async () => ({ json: async () => ({ error: 'bad_verification_code' }) });
    const res = fakeRes();
    await callback({ url: '/api/callback?code=c&state=s1', headers: { cookie: 'rd_state=s1' } }, res);
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/#error=bad_verification_code');
  });

  test('a network failure comes back as /#error=network_error', async () => {
    globalThis.fetch = async () => {
      throw new Error('down');
    };
    const res = fakeRes();
    await callback({ url: '/api/callback?code=c&state=s1', headers: { cookie: 'rd_state=s1' } }, res);
    assert.equal(res.headers.location, '/#error=network_error');
  });
});

describe('api/login', () => {
  test('sets an httpOnly state cookie that matches the state in the redirect', () => {
    process.env.GITHUB_CLIENT_ID = 'cid';
    const res = fakeRes();
    login({ headers: { 'x-forwarded-proto': 'https' } }, res);
    assert.equal(res.statusCode, 302);
    const target = new URL(res.headers.location);
    assert.equal(target.origin + target.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(target.searchParams.get('scope'), 'public_repo');
    assert.equal(target.searchParams.get('client_id'), 'cid');
    const state = target.searchParams.get('state');
    assert.match(state, /^[0-9a-f]{32}$/);
    const cookie = res.headers['set-cookie'];
    assert.ok(cookie.startsWith(`rd_state=${state};`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
  });

  test('two logins get different states', () => {
    process.env.GITHUB_CLIENT_ID = 'cid';
    const a = fakeRes();
    const b = fakeRes();
    login({ headers: {} }, a);
    login({ headers: {} }, b);
    assert.notEqual(a.headers['set-cookie'], b.headers['set-cookie']);
  });
});
