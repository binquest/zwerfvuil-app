import { describe, expect, it } from '@jest/globals';
import { convertFormDataAsync } from 'expo/src/winter/fetch/convertFormData';

import { buildMultipart } from '../multipart';

const latin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join('');

describe('buildMultipart', () => {
  const photo = new Uint8Array(256).map((_, i) => i); // every byte value, including CR, LF and '-'
  const { body, contentType } = buildMultipart(
    { bin_id: '7', lat: '51.05', accuracy_m: '' },
    { field: 'photo', filename: 'photo.jpg', contentType: 'image/jpeg', bytes: photo },
    'BOUNDARY',
  );
  const text = latin1(body);

  it('declares the boundary in the content type', () => {
    expect(contentType).toBe('multipart/form-data; boundary=BOUNDARY');
  });

  it('writes the fields and the file part in multipart format', () => {
    expect(text.startsWith('--BOUNDARY\r\nContent-Disposition: form-data; name="bin_id"\r\n\r\n7\r\n')).toBe(true);
    expect(text).toContain('Content-Disposition: form-data; name="accuracy_m"\r\n\r\n\r\n');
    expect(text).toContain(
      '--BOUNDARY\r\nContent-Disposition: form-data; name="photo"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n',
    );
    expect(text.endsWith('\r\n--BOUNDARY--\r\n')).toBe(true);
  });

  it('copies the photo bytes unchanged', () => {
    const start = text.indexOf('Content-Type: image/jpeg\r\n\r\n') + 'Content-Type: image/jpeg\r\n\r\n'.length;
    expect(Array.from(body.subarray(start, start + photo.length))).toEqual(Array.from(photo));
    expect(body.byteLength).toBe(start + photo.length + '\r\n--BOUNDARY--\r\n'.length);
  });

  it('uses a random boundary by default', () => {
    const a = buildMultipart({}, { field: 'f', filename: 'f', contentType: 'x/y', bytes: new Uint8Array() });
    const b = buildMultipart({}, { field: 'f', filename: 'f', contentType: 'x/y', bytes: new Uint8Array() });
    expect(a.contentType).not.toBe(b.contentType);
  });
});

describe('expo/fetch (the global fetch in SDK 57)', () => {
  it('cannot send a React Native { uri } file part, which broke the first check-in upload', async () => {
    const formData = {
      entries: () => [['photo', { uri: 'file:///photo.jpg', name: 'photo.jpg', type: 'image/jpeg' }]],
    } as unknown as FormData;
    await expect(convertFormDataAsync(formData)).rejects.toThrow('Unsupported FormDataPart implementation');
  });
});
