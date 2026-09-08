import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PreparedDesktopAssets {
  pngPath: string;
  icoPath: string;
  pngBytes: number;
  icoBytes: number;
}

let crcTable: number[] | null = null;

function makeCrcTable(): number[] {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(buffer: Buffer): number {
  const table = crcTable ?? (crcTable = makeCrcTable());
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function setPixel(image: Buffer, size: number, x: number, y: number, color: readonly [number, number, number, number]): void {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const offset = y * (size * 4 + 1) + 1 + x * 4;
  image[offset] = color[0];
  image[offset + 1] = color[1];
  image[offset + 2] = color[2];
  image[offset + 3] = color[3];
}

function fillRect(image: Buffer, size: number, x: number, y: number, width: number, height: number, color: readonly [number, number, number, number]): void {
  for (let yy = y; yy < y + height; yy += 1) {
    for (let xx = x; xx < x + width; xx += 1) {
      setPixel(image, size, xx, yy, color);
    }
  }
}

function fillRoundedRect(image: Buffer, size: number, x: number, y: number, width: number, height: number, radius: number, color: readonly [number, number, number, number]): void {
  const right = x + width - 1;
  const bottom = y + height - 1;
  for (let yy = y; yy <= bottom; yy += 1) {
    for (let xx = x; xx <= right; xx += 1) {
      const dx = xx < x + radius ? x + radius - xx : xx > right - radius ? xx - (right - radius) : 0;
      const dy = yy < y + radius ? y + radius - yy : yy > bottom - radius ? yy - (bottom - radius) : 0;
      if ((dx === 0 && dy === 0) || dx * dx + dy * dy <= radius * radius) {
        setPixel(image, size, xx, yy, color);
      }
    }
  }
}

function drawThickLine(image: Buffer, size: number, x1: number, y1: number, x2: number, y2: number, thickness: number, color: readonly [number, number, number, number]): void {
  const minX = Math.floor(Math.min(x1, x2) - thickness);
  const maxX = Math.ceil(Math.max(x1, x2) + thickness);
  const minY = Math.floor(Math.min(y1, y2) - thickness);
  const maxY = Math.ceil(Math.max(y1, y2) + thickness);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const radius = thickness / 2;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared));
      const px = x1 + t * dx;
      const py = y1 + t * dy;
      const distanceSquared = (x - px) * (x - px) + (y - py) * (y - py);
      if (distanceSquared <= radius * radius) {
        setPixel(image, size, x, y, color);
      }
    }
  }
}

export function createDesktopIconPng(size = 256): Buffer {
  const image = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    image[y * (size * 4 + 1)] = 0;
  }

  fillRoundedRect(image, size, 13, 13, 230, 230, 46, [15, 23, 42, 255]);
  fillRoundedRect(image, size, 25, 25, 206, 206, 36, [30, 41, 59, 255]);
  fillRect(image, size, 46, 70, 24, 102, [45, 212, 191, 255]);
  fillRect(image, size, 84, 54, 24, 118, [96, 165, 250, 255]);
  fillRect(image, size, 122, 84, 24, 88, [163, 230, 53, 255]);
  fillRect(image, size, 160, 62, 24, 110, [251, 191, 36, 255]);
  fillRoundedRect(image, size, 42, 180, 152, 14, 7, [148, 163, 184, 255]);
  drawThickLine(image, size, 75, 142, 110, 176, 17, [8, 13, 28, 180]);
  drawThickLine(image, size, 108, 176, 190, 84, 17, [8, 13, 28, 180]);
  drawThickLine(image, size, 75, 138, 110, 172, 11, [248, 250, 252, 255]);
  drawThickLine(image, size, 108, 172, 190, 80, 11, [248, 250, 252, 255]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(image)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function createIcoFromPng(png: Buffer, size = 256): Buffer {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = size >= 256 ? 0 : size;
  header[7] = size >= 256 ? 0 : size;
  header[8] = 0;
  header[9] = 0;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}

export function prepareDesktopAssets(rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")): PreparedDesktopAssets {
  const outputDir = path.join(rootDir, "build", "desktop");
  fs.mkdirSync(outputDir, { recursive: true });
  const png = createDesktopIconPng(256);
  const ico = createIcoFromPng(png, 256);
  const pngPath = path.join(outputDir, "icon.png");
  const icoPath = path.join(outputDir, "icon.ico");
  fs.writeFileSync(pngPath, png);
  fs.writeFileSync(icoPath, ico);
  return {
    pngPath,
    icoPath,
    pngBytes: png.length,
    icoBytes: ico.length,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const assets = prepareDesktopAssets();
  console.log(`Desktop assets prepared: ${assets.pngPath}, ${assets.icoPath}`);
}
