import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { assembleSegments } from '../src/services/html/segment-media.js';
import { withVoice } from '../src/services/html/voice-overlay.js';
import { buildTranscript } from '../src/services/clips/transcript.js';
it('3 MP4 + voice dài hơn → đúng 3s/90 khung, đúng một audio; đoạn captionsOnly không có audio', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-concat-'));
  const ff = process.env.FFMPEG_PATH ?? 'ffmpeg',
    fp = process.env.FFPROBE_PATH ?? 'ffprobe';
  try {
    const parts = [0.8, 1, 1.2].map((duration, i) => {
      const file = path.join(dir, `input-${i}.mp4`);
      execFileSync(
        ff,
        [
          '-y',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          `color=c=${['red', 'green', 'blue'][i]}:s=160x90:r=30`,
          '-t',
          String(duration),
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          file,
        ],
        { windowsHide: true },
      );
      return { path: file, start_s: i, end_s: i + 1 };
    });
    const voice = path.join(dir, 'voice.wav');
    execFileSync(ff, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=500', '-t', '4', voice], { windowsHide: true });
    const result = await assembleSegments({
      ffmpeg: ff,
      ffprobe: fp,
      parts,
      totalS: 3,
      width: 160,
      height: 90,
      voice,
      out: path.join(dir, 'result.mp4'),
      tempDir: dir,
      signal: new AbortController().signal,
    });
    expect(Math.abs(result.duration - 3)).toBeLessThanOrEqual(1 / 30);
    expect(result.streams.filter((s) => s.codec_type === 'audio')).toHaveLength(1);
    const transcript = buildTranscript({ text: 'x', segments: [], words: [{ word: 'x', start: 0, end: 0.5 }] }, { durationHintS: 1 });
    const files = withVoice(
      [{ path: 'index.html', content: '<div data-composition-id="main"></div>' }],
      { asset_id: 1, path: 'assets/u/1.wav', duration_s: 1, captions: true, transcript },
      '9:16',
      { captionsOnly: true },
    );
    expect(files[0]!.content).not.toContain('<audio');
    expect(files[0]!.content).toContain('hv-voice-caption');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
