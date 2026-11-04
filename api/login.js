import { randomBytes } from 'node:crypto';

export default function handler(req, res) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('GITHUB_CLIENT_ID is not set.');
    return;
  }
  const state = randomBytes(16).toString('hex');
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const secure = proto === 'https' ? '; Secure' : '';
  const params = new URLSearchParams({ client_id: clientId, scope: 'public_repo', state, allow_signup: 'true' });
  res.statusCode = 302;
  res.setHeader('Set-Cookie', `rd_state=${state}; HttpOnly; SameSite=Lax; Path=/api; Max-Age=600${secure}`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Location', `https://github.com/login/oauth/authorize?${params.toString()}`);
  res.end();
}
