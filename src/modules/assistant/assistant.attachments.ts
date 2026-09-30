import path from 'node:path';
import mammoth from 'mammoth';
import multer from 'multer';
import { extractText, getDocumentProxy } from 'unpdf';
import { AppError } from '../../common/errors';

/** Longest document text handed to the model; the rest is cut and the reply says so. */
export const MAX_DOCUMENT_CHARS = 60_000;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

type Kind = 'pdf' | 'docx' | 'text';

/** Accepted by extension; the content is then checked for the real format. */
const KINDS: Record<string, Kind> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.txt': 'text',
  '.md': 'text',
  '.csv': 'text',
};

export const SUPPORTED_DOCUMENTS = 'PDF, Word (.docx), TXT, Markdown or CSV';

export const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0 },
  fileFilter: (_req, file, cb) => {
    if (KINDS[path.extname(file.originalname).toLowerCase()]) return cb(null, true);
    return cb(new AppError(400, 'UNSUPPORTED_FILE_TYPE', `Only ${SUPPORTED_DOCUMENTS} files can be read.`));
  },
});

const unreadable = (message: string) => new AppError(400, 'UNREADABLE_FILE', message);

async function pdfText(buffer: Buffer): Promise<string> {
  if (buffer.toString('ascii', 0, 5) !== '%PDF-') throw unreadable("That file isn't a valid PDF.");
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  } catch {
    throw unreadable("That PDF couldn't be read. It may be damaged or password protected.");
  }
}

async function docxText(buffer: Buffer): Promise<string> {
  // A .docx is a zip archive.
  if (buffer.readUInt32LE(0) !== 0x04034b50) throw unreadable("That file isn't a valid Word document.");
  try {
    return (await mammoth.extractRawText({ buffer })).value;
  } catch {
    throw unreadable("That Word document couldn't be read.");
  }
}

function plainText(buffer: Buffer): string {
  // NUL bytes mean a binary file renamed to .txt.
  if (buffer.includes(0)) throw unreadable("That file doesn't contain readable text.");
  return buffer.toString('utf8');
}

/** Pulls the text out of an uploaded document so the assistant can read it. Nothing is stored. */
export async function readDocument(file: { originalname: string; buffer: Buffer }) {
  const kind = KINDS[path.extname(file.originalname).toLowerCase()];
  if (!kind) throw new AppError(400, 'UNSUPPORTED_FILE_TYPE', `Only ${SUPPORTED_DOCUMENTS} files can be read.`);
  const raw = kind === 'pdf' ? await pdfText(file.buffer) : kind === 'docx' ? await docxText(file.buffer) : plainText(file.buffer);
  const text = raw.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) {
    throw unreadable(kind === 'pdf' ? 'No text was found in that PDF. Scanned pages can be attached as images instead.' : 'That file is empty.');
  }
  const truncated = text.length > MAX_DOCUMENT_CHARS;
  return { name: path.basename(file.originalname).slice(0, 200), text: truncated ? text.slice(0, MAX_DOCUMENT_CHARS) : text, truncated };
}
