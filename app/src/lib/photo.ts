import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

const MAX_WIDTH = 1280;
const QUALITY = 0.7;

/**
 * Resizes and re-encodes a camera photo as JPEG. Re-encoding drops the EXIF
 * metadata (GPS, device); the server strips any metadata again regardless.
 */
export async function compressPhoto(uri: string): Promise<string> {
  const context = ImageManipulator.manipulate(uri);
  try {
    context.resize({ width: MAX_WIDTH });
    const image = await context.renderAsync();
    try {
      const result = await image.saveAsync({ format: SaveFormat.JPEG, compress: QUALITY });
      return result.uri;
    } finally {
      image.release();
    }
  } finally {
    context.release();
  }
}
