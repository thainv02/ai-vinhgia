/**
 * Dò khoảng lặng thật trong audio (16 kHz mono) bằng ffmpeg, để dựng câu và bám điểm cắt.
 *
 * Vì sao cần: dịch vụ STT trả mốc từ LIỀN NHAU (end của từ = start của từ kế, khe lớn nhất đo được 0.43 s, hầu hết 0.0) và segment ~20 giây (ghép VAD), nên khe giữa hai từ
 * không phản ánh chỗ người nói ngắt.
 *
 * Phương pháp (hai lượt ffmpeg trên file mp3 tạm đã tách, nhanh hơn thời gian thực hàng trăm lần):
 *  1. Đo mức RMS từng cửa sổ 50 ms (`asetnsamples=n=800,astats`) → lấy phân vị 5% (ồn nền, `floor`) và 90% (mức tiếng nói, `speech`).
 *  2. Ngưỡng = floor + 35% × (speech − floor), kẹp [−55, −25] dB: giữa ồn nền và tiếng nói, nên audio ồn nhiều hay im lặng số đều dùng được.
 *     Ví dụ video thử: floor −85, speech −15 → −55 (kẹp, im lặng số); audio có ồn nền −45 dB, tiếng nói −20 → −36 dB.
 *  3. `silencedetect=n=<ngưỡng>dB:d=0.15` → `[{start, end}]` (≥ 0.15 s). Khoảng lặng không có điểm kết thúc (cuối file) bị bỏ.
 */
import { run } from '../final-render/ffmpeg-renderer.js';
import { PAUSE_MIN_S, type Pause, type PauseDetectInfo } from './transcript.js';

export const THRESHOLD_MIN_DB = -55;
export const THRESHOLD_MAX_DB = -25;
export const THRESHOLD_FRACTION = 0.35;
export const RMS_WINDOW_SAMPLES = 800; // 50 ms ở 16 kHz

/** Phân vị `p` (0–100) của mảng đã sắp. */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length * p) / 100)))]!;
}

/** Ngưỡng silencedetect (dB) từ các mức RMS cửa sổ 50 ms (dB; −inf coi là −90). null nếu không đủ dữ liệu. */
export function thresholdFromLevels(levels: number[]): { threshold_db: number; floor_db: number; speech_db: number } | null {
  if (levels.length < 20) return null;
  const sorted = levels.map((v) => (Number.isFinite(v) ? Math.max(v, -90) : -90)).sort((a, b) => a - b);
  const floor = percentile(sorted, 5);
  const speech = percentile(sorted, 90);
  const raw = floor + THRESHOLD_FRACTION * (speech - floor);
  const threshold = Math.max(THRESHOLD_MIN_DB, Math.min(THRESHOLD_MAX_DB, raw));
  return { threshold_db: Math.round(threshold * 10) / 10, floor_db: Math.round(floor * 10) / 10, speech_db: Math.round(speech * 10) / 10 };
}

/** Đọc các dòng `lavfi.silence_start=` / `lavfi.silence_end=` của `ametadata=print` thành khoảng lặng. */
export function parseSilenceLines(lines: string[]): Pause[] {
  const out: Pause[] = [];
  let start: number | null = null;
  for (const line of lines) {
    const m = /lavfi\.silence_(start|end)=(-?[\d.]+)/.exec(line);
    if (!m) continue;
    const v = Number(m[2]);
    if (m[1] === 'start') start = Math.max(0, v);
    else if (start !== null) {
      if (v - start >= PAUSE_MIN_S - 1e-9) out.push({ start: Math.round(start * 1000) / 1000, end: Math.round(v * 1000) / 1000 });
      start = null;
    }
  }
  return out;
}

export interface PauseResult {
  pauses: Pause[];
  info: PauseDetectInfo;
}

/** Dò khoảng lặng của một file audio. Ném lỗi nếu ffmpeg lỗi (người gọi dựng câu theo cách cũ). */
export async function detectPauses(ffmpegBin: string, audioAbs: string, signal: AbortSignal): Promise<PauseResult | null> {
  const levels: number[] = [];
  await run(
    ffmpegBin,
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', audioAbs, '-vn', '-af', `aformat=sample_rates=16000:channel_layouts=mono,asetnsamples=n=${RMS_WINDOW_SAMPLES},astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`, '-f', 'null', '-'],
    signal,
    (line) => {
      const m = /lavfi\.astats\.Overall\.RMS_level=(.+)$/.exec(line);
      if (m) levels.push(m[1] === '-inf' ? -90 : Number(m[1]));
    },
  );
  const th = thresholdFromLevels(levels);
  if (!th) return null;
  const lines: string[] = [];
  await run(
    ffmpegBin,
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', audioAbs, '-vn', '-af', `silencedetect=n=${th.threshold_db}dB:d=${PAUSE_MIN_S},ametadata=mode=print:file=-`, '-f', 'null', '-'],
    signal,
    (line) => {
      if (line.includes('lavfi.silence_')) lines.push(line);
    },
  );
  return {
    pauses: parseSilenceLines(lines),
    info: { ...th, min_s: PAUSE_MIN_S, method: 'astats RMS 50 ms: ngưỡng = p5 + 35% × (p90 − p5), kẹp [−55, −25] dB; silencedetect d=0.15' },
  };
}
