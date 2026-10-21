import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, asUser } from '../lib/database.mjs';
import { processDocument } from '../lib/ingestion.mjs';

const email = String(process.argv[2] || '').trim().toLowerCase();
if (!email) throw new Error('Usage: npm run db:import-local -- your-account@example.com');
const root = fileURLToPath(new URL('../', import.meta.url));
const index = JSON.parse(await readFile(join(root, 'data', 'documents.json'), 'utf8'));
const userResult = await pool.query('select id, email from users where email = $1', [email]);
if (!userResult.rowCount) throw new Error(`No DocuMind account found for ${email}. Register first, then run this command again.`);
const user = userResult.rows[0];
let imported = 0;

for (const legacy of index) {
  const source = await readFile(join(root, 'data', 'documents', `${legacy.id}.txt`));
  const originalName = basename(legacy.name || 'document');
  const stem = originalName.slice(0, originalName.length - extname(originalName).length) || 'document';
  const name = `${stem.slice(0, 165)} (extracted text).txt`;
  const buffer = Buffer.from(source.toString('utf8'), 'utf8');
  const processed = await processDocument({ name, mimeType: 'text/plain', buffer });
  const id = randomUUID();
  await asUser(user.id, async (db) => {
    await db.query('insert into documents (id, user_id, name, mime_type, file_data, extracted_text, page_count) values ($1, $2, $3, $4, $5, $6, $7)',
      [id, user.id, name, 'text/plain', buffer, processed.extractedText, processed.pageCount]);
    for (let chunkIndex = 0; chunkIndex < processed.chunks.length; chunkIndex++) {
      const chunk = processed.chunks[chunkIndex];
      await db.query('insert into document_chunks (user_id, document_id, chunk_index, page_number, content, embedding) values ($1, $2, $3, $4, $5, $6::extensions.vector)',
        [user.id, id, chunkIndex, chunk.pageNumber, chunk.content, JSON.stringify(chunk.embedding)]);
    }
  });
  imported++;
  console.log(`Imported: ${name}`);
}

await pool.end();
console.log(`Imported ${imported} extracted-text document(s) for ${user.email}. Original PDF bytes were not stored by the previous local-only version.`);
