import http from 'node:http';
import { createHash } from 'node:crypto';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, accept, x-github-api-version',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'Access-Control-Max-Age': '600'
};

const AVATAR =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f3e3c8"/><stop offset="1" stop-color="#8a7556"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><circle cx="32" cy="25" r="11" fill="#1b1712"/><path d="M10 64c2-14 12-22 22-22s20 8 22 22Z" fill="#1b1712"/></svg>';

export async function startMock({ login = 'testuser', taken = [], buildsBeforeBuilt = 1, failPages = false, stallQueued = false } = {}) {
  const calls = [];
  const commits = [];
  const repos = new Set(taken.map((n) => n.toLowerCase()));
  const blobs = new Map();
  const state = { builds: 0, stall: stallQueued, run: { status: 'queued', conclusion: null } };
  let origin = '';

  const sha = (text) => createHash('sha1').update(text).digest('hex');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch (err) {
          body = raw;
        }
      }
      const json = (status, data, extra = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...CORS, ...extra });
        res.end(JSON.stringify(data));
      };
      const html = (text) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS });
        res.end(text);
      };

      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        res.end();
        return;
      }

      const path = url.pathname;

      if (req.method === 'GET' && path === '/avatar.svg') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', ...CORS });
        res.end(AVATAR);
        return;
      }
      let m = path.match(/^\/site\/([^/]+)\/([^/]+)\/?$/);
      if (req.method === 'GET' && m) return html(`<!doctype html><title>${m[2]}</title><h1>mock site ${m[1]}/${m[2]}</h1>`);
      m = path.match(/^\/gh\/([^/]+)\/([^/]+)\/?$/);
      if (req.method === 'GET' && m) return html(`<!doctype html><title>${m[2]}</title><h1>mock repo ${m[1]}/${m[2]}</h1>`);

      const call = { method: req.method, path, body, auth: req.headers.authorization || '', at: calls.length };
      calls.push(call);

      if (req.method === 'GET' && path === '/user') {
        return json(200, { login, avatar_url: `${origin}/avatar.svg` });
      }

      if (req.method === 'POST' && path === '/user/repos') {
        const name = body && body.name;
        if (!name) return json(422, { message: 'Repository creation failed.' });
        if (repos.has(name.toLowerCase())) {
          return json(422, { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] });
        }
        repos.add(name.toLowerCase());
        return json(201, {
          name,
          full_name: `${login}/${name}`,
          html_url: `${origin}/gh/${login}/${name}`,
          default_branch: 'main',
          owner: { login }
        });
      }

      m = path.match(/^\/repos\/([^/]+)\/([^/]+)$/);
      if (req.method === 'GET' && m) {
        return repos.has(decodeURIComponent(m[2]).toLowerCase()) ? json(200, { name: m[2] }) : json(404, { message: 'Not Found' });
      }

      m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/blobs$/);
      if (req.method === 'POST' && m) {
        const content = Buffer.from(body.content || '', 'base64');
        const id = sha(`blob ${content.length}\0${content.toString('latin1')}`);
        blobs.set(id, content);
        return json(201, { sha: id });
      }

      m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/trees$/);
      if (req.method === 'POST' && m) {
        const bad = (body.tree || []).find((t) => !blobs.has(t.sha) || t.mode !== '100644');
        if (bad) return json(422, { message: 'GitRPC::BadObjectState' });
        return json(201, { sha: sha(JSON.stringify(body.tree)) });
      }

      m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/commits$/);
      if (req.method === 'POST' && m) {
        const commitSha = sha(JSON.stringify(body));
        commits.push(commitSha);
        return json(201, { sha: commitSha });
      }

      m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/([^/]+)$/);
      if (req.method === 'PATCH' && m) {
        return json(200, { ref: `refs/heads/${m[3]}`, object: { sha: body.sha } });
      }

      m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/pages$/);
      if (req.method === 'POST' && m) {
        if (failPages) return json(422, { message: 'Pages is not available for this repository.' });
        return json(201, { html_url: `${origin}/site/${m[1]}/${m[2]}/`, status: null });
      }

      m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/pages\/builds\/latest$/);
      if (req.method === 'GET' && m) {
        state.builds += 1;
        if (state.stall) return json(404, { message: 'Not Found' });
        return json(200, { status: state.builds > buildsBeforeBuilt ? 'built' : 'building' });
      }

      m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/actions\/runs$/);
      if (req.method === 'GET' && m) {
        if (!state.stall) return json(200, { total_count: 0, workflow_runs: [] });
        return json(200, { total_count: 1, workflow_runs: [{ name: 'pages build and deployment', status: state.run.status, conclusion: state.run.conclusion }] });
      }

      json(404, { message: 'Not Found' });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  origin = `http://127.0.0.1:${port}`;

  return {
    port,
    origin,
    calls,
    commits,
    login,
    blobs,
    setRun: (status, conclusion = null) => {
      state.run = { status, conclusion };
    },
    release: () => {
      state.stall = false;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
    callsTo: (method, pattern) => calls.filter((c) => c.method === method && pattern.test(c.path))
  };
}
