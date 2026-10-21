import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, asUser } from './lib/database.mjs';
import { clearSession, getSession, hashPassword, issueSession, verifyPassword } from './lib/auth.mjs';
import { aiProvider, embedTexts, streamAnswer } from './lib/ai.mjs';
import { processDocument } from './lib/ingestion.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 3000);
const maxUploadBytes = 20 * 1024 * 1024;
const authAttempts = new Map();

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

async function readBody(request, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function readJson(request, limit) {
  const body = await readBody(request, limit);
  return JSON.parse(body.toString('utf8'));
}

function authRateLimit(request) {
  const ip = request.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const attempts = (authAttempts.get(ip) || []).filter((timestamp) => now - timestamp < 15 * 60 * 1000);
  if (attempts.length >= 20) return false;
  attempts.push(now);
  authAttempts.set(ip, attempts);
  return true;
}

async function authRoute(request, response, pathname) {
  if (pathname === '/api/auth/me' && request.method === 'GET') {
    const user = getSession(request);
    return sendJson(response, user ? 200 : 401, user ? { user } : { error: 'Sign in to continue.' });
  }
  if (pathname === '/api/auth/logout' && request.method === 'POST') {
    clearSession(response);
    return sendJson(response, 200, { ok: true });
  }
  if (!['/api/auth/register', '/api/auth/login'].includes(pathname) || request.method !== 'POST') return null;
  if (!authRateLimit(request)) return sendJson(response, 429, { error: 'Too many sign-in attempts. Try again in 15 minutes.' });
  let payload;
  try { payload = await readJson(request); }
  catch { return sendJson(response, 400, { error: 'Enter a valid email address and password.' }); }
  const email = String(payload.email || '').trim().toLowerCase();
  const password = String(payload.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return sendJson(response, 400, { error: 'Enter a valid email address.' });
  if (password.length < 10 || password.length > 200) return sendJson(response, 400, { error: 'Your password must be between 10 and 200 characters.' });
  try {
    let user;
    if (pathname.endsWith('/register')) {
      const passwordHash = await hashPassword(password);
      const result = await pool.query('insert into users (email, password_hash) values ($1, $2) returning id, email', [email, passwordHash]);
      user = result.rows[0];
    } else {
      const result = await pool.query('select id, email, password_hash from users where email = $1', [email]);
      if (!result.rowCount || !await verifyPassword(password, result.rows[0].password_hash)) return sendJson(response, 401, { error: 'Email or password is incorrect.' });
      user = { id: result.rows[0].id, email: result.rows[0].email };
    }
    issueSession(response, user);
    return sendJson(response, pathname.endsWith('/register') ? 201 : 200, { user });
  } catch (error) {
    if (error.code === '23505') return sendJson(response, 409, { error: 'An account with this email already exists.' });
    throw error;
  }
}

async function uploadRoute(request, response, user) {
  let form;
  try {
    const body = await readBody(request, maxUploadBytes + 128 * 1024);
    form = await new Request('http://localhost/api/documents', { method: 'POST', headers: request.headers, body }).formData();
  } catch (error) {
    return sendJson(response, error.message === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'The upload could not be read or exceeds 20 MB.' });
  }
  const uploaded = form.get('file');
  if (!uploaded || typeof uploaded.arrayBuffer !== 'function') return sendJson(response, 400, { error: 'Choose a PDF or text file to upload.' });
  if (uploaded.size > maxUploadBytes) return sendJson(response, 413, { error: 'Files must be smaller than 20 MB.' });
  const name = basename(uploaded.name || 'document').replace(/[\x00-\x1f]/g, '').slice(0, 180);
  const extension = extname(name).toLowerCase();
  const mimeType = extension === '.pdf' ? 'application/pdf' : extension === '.md' ? 'text/markdown' : extension === '.txt' ? 'text/plain' : '';
  if (!mimeType) return sendJson(response, 415, { error: 'Upload a PDF, TXT, or Markdown file.' });
  const buffer = Buffer.from(await uploaded.arrayBuffer());
  if (mimeType === 'application/pdf' && buffer.subarray(0, 5).toString() !== '%PDF-') return sendJson(response, 400, { error: 'This file does not look like a PDF.' });
  const id = randomUUID();
  try {
    const processed = await processDocument({ name, mimeType, buffer });
    const document = await asUser(user.id, async (db) => {
      const created = await db.query(
        'insert into documents (id, user_id, name, mime_type, file_data, extracted_text, page_count) values ($1, $2, $3, $4, $5, $6, $7) returning id, name, mime_type, octet_length(file_data) as size, page_count, uploaded_at',
        [id, user.id, name, mimeType, buffer, processed.extractedText, processed.pageCount],
      );
      const inserted = created.rows[0];
      for (let index = 0; index < processed.chunks.length; index++) {
        const chunk = processed.chunks[index];
        await db.query(
          'insert into document_chunks (user_id, document_id, chunk_index, page_number, content, embedding) values ($1, $2, $3, $4, $5, $6::extensions.vector)',
          [user.id, id, index, chunk.pageNumber, chunk.content, JSON.stringify(chunk.embedding)],
        );
      }
      return inserted;
    });
    return sendJson(response, 201, { document: { ...document, type: extension.slice(1).toUpperCase() } });
  } catch (error) {
      return sendJson(response, /API_KEY/.test(error.message) ? 503 : 422, { error: error.message || 'The document could not be processed.' });
  }
}

async function chatRoute(request, response, user) {
  let payload;
  try { payload = await readJson(request); }
  catch { return sendJson(response, 400, { error: 'The chat request was not valid JSON.' }); }
  const question = String(payload.question || '').trim().slice(0, 4000);
  const ids = Array.isArray(payload.documentIds) ? payload.documentIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 20) : [];
  if (!question) return sendJson(response, 400, { error: 'Enter a question first.' });
  if (!ids.length) return sendJson(response, 400, { error: 'Select at least one document to chat with.' });
  try {
    const [queryVector] = await embedTexts([question]);
    const chunks = await asUser(user.id, async (db) => {
      const result = await db.query(
        'select c.document_id, d.name, c.page_number, c.content, (1 - (c.embedding OPERATOR(extensions.<=>) $1::extensions.vector))::float as similarity from document_chunks c join documents d on d.id = c.document_id and d.user_id = c.user_id where c.document_id = any($2::uuid[]) order by c.embedding OPERATOR(extensions.<=>) $1::extensions.vector limit 10',
        [JSON.stringify(queryVector), ids],
      );
      return result.rows;
    });
    if (!chunks.length) return sendJson(response, 404, { error: 'No searchable text was found in the selected documents.' });
    const sources = chunks.map((chunk, index) => ({ ref: index + 1, id: chunk.document_id, name: chunk.name, page: chunk.page_number, content: chunk.content }));
    const context = sources.map((source) => `[${source.ref}] ${source.name}, page ${source.page}\n${source.content}`).join('\n\n');
    const history = Array.isArray(payload.history) ? payload.history.slice(-8).map((message) => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: String(message.content || '').slice(0, 4000) })) : [];
    const upstream = await streamAnswer([
      { role: 'system', content: `Answer from the retrieved source passages only. If they do not contain the answer, say so. Cite claims using the passage numbers exactly, for example [1]. Never invent citations.\n\n${context}` },
      ...history,
      { role: 'user', content: question },
    ]);
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    response.write(`event: sources\ndata: ${JSON.stringify(sources.map(({ ref, id, name, page }) => ({ ref, id, name, page })))}\n\n`);
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
            const chunk = JSON.parse(data);
            const token = aiProvider === 'gemini'
              ? chunk.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('')
              : chunk.choices?.[0]?.delta?.content;
          if (token) response.write(`event: token\ndata: ${JSON.stringify(token)}\n\n`);
        } catch {}
      }
      if (done) break;
    }
    response.write('event: done\ndata: {}\n\n');
    response.end();
  } catch (error) {
        if (!response.headersSent) return sendJson(response, /API_KEY/.test(error.message) ? 503 : 502, { error: error.message || 'The AI service could not answer right now.' });
    response.write(`event: error\ndata: ${JSON.stringify({ error: 'The response stream was interrupted.' })}\n\n`);
    response.end();
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/auth/')) {
      const result = await authRoute(request, response, url.pathname);
      if (result !== null) return result;
    }
    if (url.pathname === '/api/health' && request.method === 'GET') {
      await pool.query('select 1');
      return sendJson(response, 200, { ok: true });
    }
    if (url.pathname.startsWith('/api/')) {
      const user = getSession(request);
      if (!user) return sendJson(response, 401, { error: 'Sign in to continue.' });
      if (url.pathname === '/api/documents' && request.method === 'GET') {
        const result = await asUser(user.id, (db) => db.query('select id, name, mime_type, octet_length(file_data) as size, page_count, uploaded_at from documents order by uploaded_at desc'));
        return sendJson(response, 200, { documents: result.rows.map((doc) => ({ ...doc, type: doc.mime_type === 'application/pdf' ? 'PDF' : doc.mime_type === 'text/markdown' ? 'MD' : 'TXT' })) });
      }
      if (url.pathname === '/api/documents' && request.method === 'POST') return uploadRoute(request, response, user);
      if (url.pathname === '/api/chat' && request.method === 'POST') return chatRoute(request, response, user);
      const fileMatch = url.pathname.match(/^\/api\/documents\/([0-9a-f-]{36})\/file$/i);
      if (fileMatch && request.method === 'GET') {
        const file = await asUser(user.id, (db) => db.query('select name, mime_type, file_data from documents where id = $1', [fileMatch[1]]));
        if (!file.rowCount) return sendJson(response, 404, { error: 'Document not found.' });
        response.writeHead(200, { 'Content-Type': file.rows[0].mime_type, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.rows[0].name)}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
        return response.end(file.rows[0].file_data);
      }
      const documentMatch = url.pathname.match(/^\/api\/documents\/([0-9a-f-]{36})$/i);
      if (documentMatch && request.method === 'DELETE') {
        const result = await asUser(user.id, (db) => db.query('delete from documents where id = $1 returning id', [documentMatch[1]]));
        if (!result.rowCount) return sendJson(response, 404, { error: 'Document not found.' });
        return sendJson(response, 200, { ok: true });
      }
      return sendJson(response, 404, { error: 'Not found.' });
    }
    const staticFiles = { '/': ['public/index.html', 'text/html; charset=utf-8'], '/styles.css': ['public/styles.css', 'text/css; charset=utf-8'], '/auth.css': ['public/auth.css', 'text/css; charset=utf-8'], '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'] };
    if (request.method === 'GET' && staticFiles[url.pathname]) {
      const [path, contentType] = staticFiles[url.pathname];
      response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
      return response.end(await readFile(join(root, path)));
    }
    sendJson(response, 404, { error: 'Not found.' });
  } catch (error) {
    console.error(error);
    if (!response.headersSent) sendJson(response, 500, { error: 'The server could not complete that request.' });
    else response.end();
  }
});

server.listen(port, '0.0.0.0', () => console.log(`DocuMind is running on port ${port}`));
