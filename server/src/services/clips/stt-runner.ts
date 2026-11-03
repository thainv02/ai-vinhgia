/**
 * Tiến trình con nhận dạng lời nói trên máy (CPU): server chạy `node stt-runner.mjs <json>` (bản build) hoặc qua tsx (dev), xem local-stt.ts.
 * Tách riêng tiến trình vì giải mã nặng và đồng bộ (không được chặn event loop của server); hủy = kill tiến trình.
 *
 * ffmpeg giải mã thành PCM float32 mono 16 kHz qua pipe (3 giờ âm thanh không nằm hết trong RAM) → VAD silero cắt đoạn nói (tối đa 20 giây)
 * → gipformer nhận dạng từng đoạn → ghép token thành từ (local-stt-words.ts).
 * stdout: mỗi dòng một JSON — `{type:'ready'}`, `{type:'progress', processed_s}`, `{type:'result', result}`; lỗi: `{type:'error', message}` và mã thoát 1.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { toVerbose, type DecodedSegment } from './local-stt-words.js';

interface Args {
  ffmpeg: string;
  input: string;
  modelDir: string;
  threads: number;
  modelLabel: string;
}

const SR = 16000;
const WINDOW = 512; // cửa sổ của VAD silero ở 16 kHz

const send = (msg: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(msg)}\n`);

async function main(): Promise<void> {
  const args = JSON.parse(process.argv[2] ?? '{}') as Args;
  const require = createRequire(import.meta.url);
  const sherpa = require('sherpa-onnx-node');
  const m = (f: string) => path.join(args.modelDir, f);
  const startedAt = Date.now();
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SR, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: m('encoder.int8.onnx'), decoder: m('decoder.int8.onnx'), joiner: m('joiner.int8.onnx') },
      tokens: m('tokens.txt'),
      numThreads: args.threads,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
  });
  const vad = new sherpa.Vad(
    { sileroVad: { model: m('silero_vad.onnx'), threshold: 0.5, minSilenceDuration: 0.3, minSpeechDuration: 0.25, windowSize: WINDOW, maxSpeechDuration: 20 }, sampleRate: SR, numThreads: 1, provider: 'cpu', debug: 0 },
    60,
  );
  send({ type: 'ready', load_ms: Date.now() - startedAt });

  const segments: DecodedSegment[] = [];
  const drain = () => {
    while (!vad.isEmpty()) {
      const seg = vad.front();
      vad.pop();
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: SR, samples: seg.samples });
      recognizer.decode(stream);
      const r = recognizer.getResult(stream) as { tokens?: string[]; timestamps?: number[]; ys_log_probs?: number[] };
      segments.push({ offset: seg.start / SR, duration: seg.samples.length / SR, tokens: r.tokens ?? [], timestamps: r.timestamps ?? [], logProbs: r.ys_log_probs });
    }
  };

  let processedS = 0;
  let lastReport = 0;
  await new Promise<void>((resolve, reject) => {
    const ff = spawn(args.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', args.input, '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let err = '';
    ff.stderr.on('data', (d) => (err = (err + String(d)).slice(-2000)));
    let rest: Buffer = Buffer.alloc(0);
    ff.stdout.on('data', (chunk: Buffer) => {
      const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const n = Math.floor(buf.length / 4 / WINDOW) * WINDOW;
      if (n > 0) {
        // chép ra ArrayBuffer riêng: Float32Array cần offset chia hết cho 4
        const samples = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + n * 4));
        for (let i = 0; i < samples.length; i += WINDOW) vad.acceptWaveform(samples.subarray(i, i + WINDOW));
        processedS += n / SR;
        drain();
        if (processedS - lastReport >= 10) {
          lastReport = processedS;
          send({ type: 'progress', processed_s: Math.round(processedS) });
        }
      }
      rest = buf.subarray(n * 4);
    });
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg không giải mã được âm thanh (mã ${code}): ${err.trim().slice(-300)}`))));
  });
  vad.flush();
  drain();
  segments.sort((a, b) => a.offset - b.offset);
  send({ type: 'result', result: toVerbose(segments, { duration: processedS, model: args.modelLabel, elapsedMs: Date.now() - startedAt }) });
}

main().catch((e) => {
  send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  process.exitCode = 1;
});
