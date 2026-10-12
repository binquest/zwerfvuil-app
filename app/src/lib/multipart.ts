// Builds a multipart/form-data body by hand.
//
// In Expo SDK 57 the global fetch is expo/fetch, which cannot send React
// Native's `{ uri, name, type }` file parts: it throws "Unsupported
// FormDataPart implementation" before any request is made. So the photo is
// read into memory and encoded here. Pure and dependency-free, so the Deno
// tests can feed the exact same bytes to the edge function.

export interface MultipartFile {
  field: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface MultipartBody {
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
}

const CRLF = '\r\n';
const BOUNDARY_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function randomBoundary(): string {
  let boundary = '----ZwerfvuilBoundary';
  for (let i = 0; i < 24; i++) boundary += BOUNDARY_CHARS[Math.floor(Math.random() * BOUNDARY_CHARS.length)];
  return boundary;
}

/** Quotes and line breaks are not allowed in header parameter values. */
function headerSafe(value: string): string {
  return value.replace(/["\r\n]/g, '_');
}

export function buildMultipart(
  fields: Record<string, string>,
  file: MultipartFile,
  boundary: string = randomBoundary(),
): MultipartBody {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      encoder.encode(
        `--${boundary}${CRLF}Content-Disposition: form-data; name="${headerSafe(name)}"${CRLF}${CRLF}${value}${CRLF}`,
      ),
    );
  }
  chunks.push(
    encoder.encode(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="${headerSafe(file.field)}"; ` +
        `filename="${headerSafe(file.filename)}"${CRLF}Content-Type: ${headerSafe(file.contentType)}${CRLF}${CRLF}`,
    ),
  );
  chunks.push(file.bytes);
  chunks.push(encoder.encode(`${CRLF}--${boundary}--${CRLF}`));

  const body = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
