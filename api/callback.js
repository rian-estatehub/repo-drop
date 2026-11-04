import { timingSafeEqual } from 'node:crypto';

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return '';
}

function sameState(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

function send(res, status, headers, body = '') {
  res.statusCode = status;
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(body);
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  const cookie = readCookie(req.headers.cookie, 'rd_state');
  const clear = 'rd_state=; HttpOnly; SameSite=Lax; Path=/api; Max-Age=0';

  if (!sameState(state, cookie)) {
    send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8', 'Set-Cookie': clear, 'Cache-Control': 'no-store' }, 'Sign in could not be verified. Go back and try again.');
    return;
  }
  if (!code) {
    send(res, 302, { Location: '/#error=missing_code', 'Set-Cookie': clear, 'Cache-Control': 'no-store' });
    return;
  }

  let token = '';
  let failure = 'sign_in_failed';
  try {
    const reply = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code
      })
    });
    const data = await reply.json();
    if (data && data.access_token) token = data.access_token;
    else if (data && data.error) failure = String(data.error);
  } catch (err) {
    failure = 'network_error';
  }

  if (!token) {
    send(res, 302, { Location: `/#error=${encodeURIComponent(failure)}`, 'Set-Cookie': clear, 'Cache-Control': 'no-store' });
    return;
  }
  send(res, 302, { Location: `/#token=${encodeURIComponent(token)}`, 'Set-Cookie': clear, 'Cache-Control': 'no-store' });
}
