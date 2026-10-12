// Minimal JPEG metadata stripper (no decoding, no dependencies).
//
// Keeps everything needed to decode the image (quantisation and Huffman
// tables, frame and scan headers, entropy-coded data), the JFIF header, ICC
// colour profiles and the Adobe colour-transform segment. Drops EXIF/XMP
// (APP1), IPTC (APP13), comments, every other APPn segment, and anything after
// the end-of-image marker (e.g. embedded motion-photo videos).

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const COM = 0xfe;
const APP0 = 0xe0;
const APP2 = 0xe2;
const APP14 = 0xee;

export class InvalidJpegError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJpegError";
  }
}

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === SOI && bytes[2] === 0xff;
}

function startsWithAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** Whether to keep an APPn segment whose payload starts at `payload`. */
function keepAppSegment(marker: number, bytes: Uint8Array, payload: number): boolean {
  if (marker === APP0) return startsWithAscii(bytes, payload, "JFIF\0"); // not JFXX thumbnails
  if (marker === APP2) return startsWithAscii(bytes, payload, "ICC_PROFILE\0"); // not MPF/FlashPix
  if (marker === APP14) return startsWithAscii(bytes, payload, "Adobe");
  return false;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Returns a copy of the JPEG without metadata. Throws InvalidJpegError on malformed input. */
export function stripJpegMetadata(input: Uint8Array): Uint8Array {
  if (!isJpeg(input)) throw new InvalidJpegError("not a JPEG");
  const len = input.length;
  const parts: Uint8Array[] = [input.subarray(0, 2)];
  let sawScan = false;
  let i = 2;

  while (true) {
    if (i >= len) throw new InvalidJpegError("missing end-of-image marker");
    if (input[i] !== 0xff) throw new InvalidJpegError(`expected a marker at byte ${i}`);
    let m = i + 1;
    while (m < len && input[m] === 0xff) m++; // fill bytes
    if (m >= len) throw new InvalidJpegError("truncated marker");
    const marker = input[m];

    if (marker === EOI) {
      if (!sawScan) throw new InvalidJpegError("no image data");
      parts.push(new Uint8Array([0xff, EOI]));
      return concat(parts); // anything after EOI is dropped
    }
    if (marker === SOI || marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      throw new InvalidJpegError(`unexpected marker 0x${marker.toString(16)} at byte ${m}`);
    }
    if (m + 2 >= len) throw new InvalidJpegError("truncated segment length");
    const segmentLength = (input[m + 1] << 8) | input[m + 2];
    const end = m + 1 + segmentLength;
    if (segmentLength < 2 || end > len) throw new InvalidJpegError(`bad segment length at byte ${m}`);

    const isApp = marker >= 0xe0 && marker <= 0xef;
    if (marker === COM || (isApp && !keepAppSegment(marker, input, m + 3))) {
      i = end;
      continue;
    }
    parts.push(new Uint8Array([0xff, marker]), input.subarray(m + 1, end));
    i = end;

    if (marker === SOS) {
      sawScan = true;
      // Entropy-coded data runs until a marker that is not a stuffed 0xFF00,
      // a restart marker or a fill byte.
      let k = end;
      while (k < len) {
        if (input[k] !== 0xff) {
          k++;
          continue;
        }
        const next = input[k + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          k += 2;
        } else if (next === 0xff) {
          k++;
        } else {
          break;
        }
      }
      parts.push(input.subarray(end, k));
      i = k;
    }
  }
}
