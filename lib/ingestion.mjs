import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { createWorker } from 'tesseract.js';
import { embedTexts } from './ai.mjs';

let ocrWorkerPromise;
async function getOcrWorker() {
  if (!ocrWorkerPromise) ocrWorkerPromise = createWorker(process.env.OCR_LANGUAGE || 'eng');
  return ocrWorkerPromise;
}

function chunkPages(pages, chunkSize = 1400, overlap = 180) {
  const chunks = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const text = pages[pageIndex].replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const paragraphs = text.split(/(?<=[.!?])\s+/);
    let part = '';
    for (const paragraph of paragraphs) {
      const next = `${part}${part ? ' ' : ''}${paragraph}`;
      if (next.length > chunkSize && part) {
        chunks.push({ content: part, pageNumber: pageIndex + 1 });
        part = `${part.slice(-overlap)} ${paragraph}`.trim();
      } else part = next;
    }
    if (part) chunks.push({ content: part, pageNumber: pageIndex + 1 });
  }
  return chunks;
}

async function extractPdf(buffer) {
  const pdf = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  if (pdf.numPages > 150) throw new Error('PDFs are limited to 150 pages in this MVP.');
  const pages = [];
  try {
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const page = await pdf.getPage(pageNo);
      const textContent = await page.getTextContent();
      let text = textContent.items.map((item) => item.str || '').join(' ').replace(/\s+/g, ' ').trim();
      if (text.length < 25) {
        const viewport = page.getViewport({ scale: 1.6 });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        const worker = await getOcrWorker();
        const result = await worker.recognize(canvas.toBuffer('image/png'));
        text = result.data.text.replace(/\s+/g, ' ').trim();
      }
      pages.push(text);
      page.cleanup();
    }
    return { pages, pageCount: pdf.numPages };
  } finally { await pdf.destroy(); }
}

export async function processDocument(file) {
  let pages;
  let pageCount = 1;
  if (file.mimeType === 'application/pdf') {
    ({ pages, pageCount } = await extractPdf(file.buffer));
  } else {
    pages = file.buffer.toString('utf8').replace(/\u0000/g, '').split(/\f|\n\s*\n/);
    pageCount = pages.length;
  }
  const extractedText = pages.map((page) => page.trim()).filter(Boolean).join('\n\n');
  if (!extractedText) throw new Error('No text could be extracted. The PDF may be scanned or password protected.');
  if (extractedText.length > 1_000_000) throw new Error('Extracted text exceeds the 1 MB document limit.');
  const chunks = chunkPages(pages);
  if (!chunks.length) throw new Error('No searchable text was found in the file.');
  const vectors = [];
  for (let offset = 0; offset < chunks.length; offset += 64) {
    vectors.push(...await embedTexts(chunks.slice(offset, offset + 64).map((chunk) => chunk.content)));
  }
  return { pages, pageCount, extractedText, chunks: chunks.map((chunk, index) => ({ ...chunk, embedding: vectors[index] })) };
}
