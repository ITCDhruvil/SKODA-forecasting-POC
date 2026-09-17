import 'dotenv/config';
import http from 'node:http';

const PORT = process.env.API_PORT || 3001;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function withHelpers(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };
  return res;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve(undefined);
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith('/api/')) {
    send(res, 404, { error: 'not found' });
    return;
  }
  try {
    req.body = await readBody(req);
  } catch {
    send(res, 400, { error: 'invalid JSON body' });
    return;
  }
  withHelpers(res);
  try {
    const mod = await import(new URL('../api/chat.ts', import.meta.url).href);
    await mod.default(req, res);
  } catch (err) {
    console.error('[dev-api] handler error', err);
    send(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, () => {
  console.log(`[dev-api] listening on http://localhost:${PORT}`);
});
