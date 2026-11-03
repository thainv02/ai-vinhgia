/** Chuẩn hoá đoạn và ghép MP4: chạy trong slot render hiện có, không giữ slot để chờ slot con. */
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { AppError } from '../../lib/errors.js';
import { killTree } from '../final-render/watermark.js';
import { mediaEnv } from './config.js';

export interface SegmentProbe {
  duration: number;
  streams: {
    codec_type: string;
    codec_name?: string;
    width?: number;
    height?: number;
    pix_fmt?: string;
    r_frame_rate?: string;
    time_base?: string;
    extradata_hash?: string;
  }[];
}
export function probeSegment(bin: string, file: string, signal: AbortSignal): Promise<SegmentProbe> {
  return new Promise((resolve, reject) =>
    execFile(
      bin,
      ['-v', 'error', '-show_streams', '-show_format', '-show_data_hash', 'sha256', '-of', 'json', file],
      { windowsHide: true, env: mediaEnv(), signal, timeout: 20000, maxBuffer: 2 * 1024 * 1024 },
      (e, out) => {
        if (e) return reject(e);
        try {
          const j = JSON.parse(out);
          resolve({ duration: Number(j.format.duration), streams: j.streams });
        } catch (err) {
          reject(err);
        }
      },
    ),
  );
}
export function runSegmentFfmpeg(bin: string, args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AppError('CANCELLED', 'Đã hủy dựng đoạn', 409));
    const child = spawn(bin, args, { windowsHide: true, env: mediaEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const abort = () => {
      if (child.pid) killTree(child.pid);
    };
    const timer = setTimeout(abort, 45 * 60_000);
    signal.addEventListener('abort', abort, { once: true });
    child.stderr.on('data', (b) => (stderr = (stderr + String(b)).slice(-2000)));
    child.on('error', (e) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (signal.aborted) return reject(new AppError('CANCELLED', 'Đã hủy dựng đoạn', 409));
      if (code === 0) resolve();
      else reject(new AppError('HTML_SEGMENT_MEDIA_FAILED', `Ghép/dựng đoạn lỗi: ${stderr.slice(-500)}`, 500));
    });
  });
}
export function normalizationArgs(input: string, output: string, frames: number, width: number, height: number, actualS: number): string[] {
  const pad = Math.max(1, frames / 30 - actualS + 0.1);
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input,
    '-vf',
    `fps=30,scale=${width}:${height},setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=${pad},trim=end_frame=${frames},setpts=PTS-STARTPTS`,
    '-frames:v',
    String(frames),
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '18',
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    output,
  ];
}
const signature = (p: SegmentProbe) =>
  JSON.stringify(
    p.streams
      .filter((s) => s.codec_type === 'video')
      .map((s) => [s.codec_name, s.width, s.height, s.pix_fmt, s.r_frame_rate, s.time_base, s.extradata_hash]),
  );
export async function assembleSegments(o: {
  ffmpeg: string;
  ffprobe: string;
  parts: { path: string; start_s: number; end_s: number }[];
  totalS: number;
  width: number;
  height: number;
  voice?: string | null;
  out: string;
  tempDir: string;
  signal: AbortSignal;
}): Promise<SegmentProbe> {
  fs.mkdirSync(o.tempDir, { recursive: true });
  const probes: SegmentProbe[] = [];
  const names: string[] = [];
  for (const [i, p] of o.parts.entries()) {
    let probe = await probeSegment(o.ffprobe, p.path, o.signal);
    const frames = Math.round(p.end_s * 30) - Math.round(p.start_s * 30);
    const file = path.join(o.tempDir, `part-${i + 1}.mp4`);
    const stream = probe.streams.find((s) => s.codec_type === 'video');
    if (
      Math.abs(probe.duration - frames / 30) > 0.001 ||
      probe.streams.some((s) => s.codec_type === 'audio') ||
      stream?.width !== o.width ||
      stream.height !== o.height ||
      stream.codec_name !== 'h264' ||
      stream.pix_fmt !== 'yuv420p' ||
      stream.r_frame_rate !== '30/1'
    ) {
      await runSegmentFfmpeg(o.ffmpeg, normalizationArgs(p.path, file, frames, o.width, o.height, probe.duration), o.signal);
      probe = await probeSegment(o.ffprobe, file, o.signal);
    } else {
      try {
        fs.linkSync(p.path, file);
      } catch {
        fs.copyFileSync(p.path, file);
      }
    }
    probes.push(probe);
    names.push(`file 'part-${i + 1}.mp4'`);
  }
  const list = path.join(o.tempDir, 'concat.txt');
  fs.writeFileSync(list, names.join('\n'));
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '1', '-i', list];
  if (o.voice) args.push('-i', o.voice);
  args.push('-map', '0:v:0');
  if (probes.every((p) => signature(p) === signature(probes[0]!))) args.push('-c:v', 'copy');
  else args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p');
  if (o.voice) args.push('-map', '1:a:0', '-af', 'apad', '-c:a', 'aac', '-b:a', '160k');
  else args.push('-an');
  args.push('-t', String(o.totalS), '-movflags', '+faststart', o.out);
  await runSegmentFfmpeg(o.ffmpeg, args, o.signal);
  const final = await probeSegment(o.ffprobe, o.out, o.signal);
  if (
    Math.abs(final.duration - o.totalS) > 1 / 30 + 0.001 ||
    final.streams.filter((s) => s.codec_type === 'audio').length !== (o.voice ? 1 : 0)
  )
    throw new AppError('HTML_CONCAT_INVALID', 'Video ghép sai thời lượng hoặc số luồng âm thanh', 500);
  return final;
}
