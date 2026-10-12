import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import { InvalidJpegError, isJpeg, stripJpegMetadata } from "../_shared/jpeg.ts";

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
const segment = (marker: number, payload: number[]) => {
  const length = payload.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...payload];
};

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
const JFIF = segment(0xe0, [...ascii("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const JFXX = segment(0xe0, [...ascii("JFXX\0"), 0x10, ...ascii("thumbnail")]);
const EXIF = segment(0xe1, [...ascii("Exif\0\0"), ...ascii("GPSLatitude 51.0523 secret")]);
const XMP = segment(0xe1, ascii("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>secret</x:xmpmeta>"));
const COMMENT = segment(0xfe, ascii("comment secret"));
const ICC = segment(0xe2, [...ascii("ICC_PROFILE\0"), 1, 1, 9, 9, 9]);
const MPF = segment(0xe2, [...ascii("MPF\0"), ...ascii("secret")]);
const IPTC = segment(0xed, ascii("Photoshop 3.0\0secret"));
const ADOBE = segment(0xee, [...ascii("Adobe"), 0, 100, 0, 0, 0, 0, 1]);
const DQT = segment(0xdb, [0, ...Array(64).fill(1)]);
const SOF0 = segment(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]);
const DHT = segment(0xc4, [0, ...Array(16).fill(0)]);
const SOS = segment(0xda, [1, 1, 0, 0, 63, 0]);
// Entropy-coded data with a stuffed 0xFF00 and a restart marker.
const SCAN = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56];
const TRAILER = ascii("MOTION_PHOTO_VIDEO secret");

const bytes = (...parts: number[][]) => new Uint8Array(parts.flat());
const text = (data: Uint8Array) => new TextDecoder("latin1").decode(data);

Deno.test("strips EXIF, XMP, IPTC, comments, MPF, thumbnails and trailing data", () => {
  const input = bytes(
    SOI,
    JFIF,
    JFXX,
    EXIF,
    XMP,
    COMMENT,
    ICC,
    MPF,
    IPTC,
    ADOBE,
    DQT,
    SOF0,
    DHT,
    SOS,
    SCAN,
    EOI,
    TRAILER,
  );
  const output = stripJpegMetadata(input);
  assertEquals(output, bytes(SOI, JFIF, ICC, ADOBE, DQT, SOF0, DHT, SOS, SCAN, EOI));
  for (const leak of ["secret", "GPS", "Exif", "thumbnail"]) assertFalse(text(output).includes(leak), leak);
});

Deno.test("stripping is idempotent", () => {
  const once = stripJpegMetadata(bytes(SOI, EXIF, DQT, SOF0, DHT, SOS, SCAN, EOI));
  assertEquals(stripJpegMetadata(once), once);
});

Deno.test("keeps every scan of a progressive JPEG and drops metadata between scans", () => {
  const SOS2 = segment(0xda, [1, 1, 0, 1, 63, 0]);
  const input = bytes(SOI, DQT, SOF0, DHT, SOS, SCAN, DHT, COMMENT, SOS2, [0x99, 0xff, 0x00], EOI);
  assertEquals(stripJpegMetadata(input), bytes(SOI, DQT, SOF0, DHT, SOS, SCAN, DHT, SOS2, [0x99, 0xff, 0x00], EOI));
});

Deno.test("handles fill bytes before markers", () => {
  const input = bytes(SOI, [0xff], DQT, SOF0, DHT, SOS, SCAN, [0xff], EOI);
  const output = stripJpegMetadata(input);
  assertEquals(output.subarray(0, 4), new Uint8Array([0xff, 0xd8, 0xff, 0xdb]));
  assertEquals(output.subarray(-2), new Uint8Array(EOI));
});

Deno.test("rejects malformed input", () => {
  const cases: Record<string, Uint8Array> = {
    "not a JPEG": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
    "empty": new Uint8Array(),
    "segment longer than the file": bytes(SOI, [0xff, 0xdb, 0x10, 0x00, 1, 2, 3]),
    "missing end-of-image": bytes(SOI, DQT, SOF0, DHT, SOS, SCAN),
    "no image data": bytes(SOI, JFIF, EOI),
    "garbage between segments": bytes(SOI, DQT, [0x00], SOF0, SOS, SCAN, EOI),
    "nested start-of-image": bytes(SOI, SOI, DQT, SOS, SCAN, EOI),
  };
  for (const [name, input] of Object.entries(cases)) {
    assertThrows(() => stripJpegMetadata(input), InvalidJpegError, undefined, name);
  }
});

Deno.test("isJpeg checks the magic bytes", () => {
  assert(isJpeg(bytes(SOI, DQT)));
  assertFalse(isJpeg(new Uint8Array([0xff, 0xd8])));
  assertFalse(isJpeg(new TextEncoder().encode("GIF89a")));
});
