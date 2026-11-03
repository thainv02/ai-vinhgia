import { describe, expect, it } from 'vitest';
import { imageSize, sniffAsset } from '../src/services/html/assets.js';
import { PNG_BYTES } from './helpers.js';

const pad = (b: Buffer, n = 64) => Buffer.concat([b, Buffer.alloc(Math.max(0, n - b.length))]);
const ascii = (s: string) => Buffer.from(s, 'latin1');

describe('sniffAsset: nhận diện bằng magic bytes', () => {
  it('ảnh', () => {
    expect(sniffAsset(PNG_BYTES)).toMatchObject({ kind: 'image', ext: 'png' });
    expect(sniffAsset(pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0])))).toMatchObject({ kind: 'image', ext: 'jpg' });
    expect(sniffAsset(pad(Buffer.concat([ascii('RIFF'), Buffer.alloc(4), ascii('WEBPVP8 ')])))).toMatchObject({ kind: 'image', ext: 'webp' });
    expect(sniffAsset(pad(ascii('GIF89a')))).toMatchObject({ kind: 'image', ext: 'gif' });
  });
  it('video và âm thanh', () => {
    const ftyp = (brand: string) => pad(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), ascii('ftyp'), ascii(brand)]));
    expect(sniffAsset(ftyp('isom'))).toMatchObject({ kind: 'video', ext: 'mp4' });
    expect(sniffAsset(ftyp('qt  '))).toMatchObject({ kind: 'video', ext: 'mov' });
    expect(sniffAsset(ftyp('M4A '))).toMatchObject({ kind: 'audio', ext: 'm4a' });
    expect(sniffAsset(pad(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(8), ascii('\x42\x82\x84webm')])))).toMatchObject({ kind: 'video', ext: 'webm' });
    expect(sniffAsset(pad(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), ascii('matroska')])))).toBeNull(); // mkv không nhận
    expect(sniffAsset(pad(Buffer.concat([ascii('RIFF'), Buffer.alloc(4), ascii('WAVEfmt ')])))).toMatchObject({ kind: 'audio', ext: 'wav' });
    expect(sniffAsset(pad(ascii('OggS')))).toMatchObject({ kind: 'audio', ext: 'ogg' });
    expect(sniffAsset(pad(ascii('ID3')))).toMatchObject({ kind: 'audio', ext: 'mp3' });
    expect(sniffAsset(pad(Buffer.from([0xff, 0xfb, 0x90])))).toMatchObject({ kind: 'audio', ext: 'mp3' });
    expect(sniffAsset(pad(Buffer.from([0xff, 0xf1, 0x50])))).toMatchObject({ kind: 'audio', ext: 'aac' });
  });
  it('không phải media: văn bản, HTML, SVG, exe, zip, rỗng', () => {
    for (const b of [ascii('<!doctype html><script>alert(1)</script>'), ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'), ascii('MZ\x90\x00'), ascii('PK\x03\x04'), Buffer.alloc(0), Buffer.from('hello world, đây là văn bản')])
      expect(sniffAsset(pad(b)), b.toString('latin1').slice(0, 10)).toBeNull();
  });
});

describe('imageSize: đọc kích thước từ header', () => {
  it('png, gif, webp (VP8X/VP8L/VP8), jpeg có đoạn APP lớn trước SOF', () => {
    expect(imageSize(PNG_BYTES, 'png')).toEqual({ width: 1, height: 1 });
    const gif = Buffer.alloc(14);
    gif.write('GIF89a', 0, 'latin1');
    gif.writeUInt16LE(320, 6);
    gif.writeUInt16LE(200, 8);
    expect(imageSize(gif, 'gif')).toEqual({ width: 320, height: 200 });
    const vp8x = Buffer.alloc(30);
    vp8x.write('RIFF', 0, 'latin1');
    vp8x.write('WEBPVP8X', 8, 'latin1');
    vp8x.writeUIntLE(799, 24, 3);
    vp8x.writeUIntLE(449, 27, 3);
    expect(imageSize(vp8x, 'webp')).toEqual({ width: 800, height: 450 });
    const vp8l = Buffer.alloc(30);
    vp8l.write('RIFF', 0, 'latin1');
    vp8l.write('WEBPVP8L', 8, 'latin1');
    vp8l.writeUInt32LE(639 | (359 << 14), 21);
    expect(imageSize(vp8l, 'webp')).toEqual({ width: 640, height: 360 });
    const vp8 = Buffer.alloc(30);
    vp8.write('RIFF', 0, 'latin1');
    vp8.write('WEBPVP8 ', 8, 'latin1');
    vp8.writeUInt16LE(1080, 26);
    vp8.writeUInt16LE(1920, 28);
    expect(imageSize(vp8, 'webp')).toEqual({ width: 1080, height: 1920 });
    const app = Buffer.alloc(2 + 2 + 3000);
    app[0] = 0xff; app[1] = 0xe1; app.writeUInt16BE(3000, 2);
    const sof = Buffer.alloc(19);
    sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8; sof.writeUInt16BE(1920, 5); sof.writeUInt16BE(1080, 7);
    expect(imageSize(Buffer.concat([Buffer.from([0xff, 0xd8]), app, sof]), 'jpg')).toEqual({ width: 1080, height: 1920 });
  });
  it('header cụt/hỏng → null', () => {
    expect(imageSize(PNG_BYTES.subarray(0, 12), 'png')).toBeNull();
    expect(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2]), 'jpg')).toBeNull();
    expect(imageSize(Buffer.alloc(5), 'gif')).toBeNull();
  });
});
