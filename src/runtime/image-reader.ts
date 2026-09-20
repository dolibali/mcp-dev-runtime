import { open } from 'node:fs/promises';
import sharp from 'sharp';
import type { Config } from '../config.js';
import { expandPath } from '../config.js';
import { ToolError } from './errors.js';

export class ImageReader {
  constructor(private config: Config) {}
  async read(args: { path: string; workdir?: string }) {
    const filename = expandPath(args.path, expandPath(args.workdir ?? '.', this.config.cwd));
    const handle = await open(filename, 'r');
    let bytes: Buffer;
    try {
      const s = await handle.stat();
      if (!s.isFile()) throw new ToolError('NOT_AN_IMAGE', 'Image path is not a regular file.');
      if (s.size > this.config.image.max_input_bytes) throw new ToolError('IMAGE_TOO_LARGE', 'Input image exceeds byte budget.');
      // Bounded read also handles growth between stat and read.
      const data: Buffer[] = []; let length = 0;
      while (true) {
        const block = Buffer.allocUnsafe(Math.min(65536, this.config.image.max_input_bytes + 1 - length));
        const { bytesRead } = await handle.read(block);
        if (!bytesRead) break;
        data.push(block.subarray(0, bytesRead)); length += bytesRead;
        if (length > this.config.image.max_input_bytes) throw new ToolError('IMAGE_TOO_LARGE', 'Input image grew beyond byte budget.');
      }
      bytes = Buffer.concat(data);
    } finally { await handle.close(); }
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
      : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
      : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
    if (!mime) throw new ToolError('UNSUPPORTED_IMAGE', 'Only PNG, JPEG and WebP are supported.');
    try {
      const settings = { limitInputPixels: this.config.image.max_input_pixels, failOn: 'error' as const };
      const original = await sharp(bytes, settings).metadata();
      if (!original.width || !original.height || original.width * original.height > this.config.image.max_input_pixels) throw new ToolError('IMAGE_TOO_LARGE', 'Input pixel budget exceeded.');
      if ((original.pages ?? 1) > 1) throw new ToolError('UNSUPPORTED_IMAGE', 'Animated/multi-page images are not supported; export a single frame.');
      let dimension = this.config.image.max_output_dimension;
      for (let attempt = 0; attempt < 8; attempt++) {
        let image = sharp(bytes, settings).rotate().resize({ width: dimension, height: dimension, fit: 'inside', withoutEnlargement: true });
        image = mime === 'image/png' ? image.png() : mime === 'image/jpeg' ? image.jpeg({ quality: 85 }) : image.webp({ quality: 85 });
        const result = await image.toBuffer({ resolveWithObject: true });
        const encodedSize = Math.ceil(result.data.length / 3) * 4;
        if (encodedSize <= this.config.image.max_encoded_bytes) return {
          image: { type: 'image' as const, data: result.data.toString('base64'), mimeType: mime },
          metadata: { path: filename, mime_type: mime, width: result.info.width, height: result.info.height,
            original_width: original.width, original_height: original.height, encoded_bytes: encodedSize,
            resized: result.info.width !== original.width || result.info.height !== original.height }
        };
        dimension = Math.max(32, Math.floor(dimension * 0.65));
      }
      throw new ToolError('IMAGE_TOO_LARGE', 'Encoded image exceeds configured transport budget after resizing.');
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError('INVALID_IMAGE', e instanceof Error ? e.message : 'Image decoding failed.');
    }
  }
}
