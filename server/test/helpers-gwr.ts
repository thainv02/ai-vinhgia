import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../src/config.js';
// @ts-expect-error module JS của tools/gwr, không có khai báo kiểu
import { findBrowser } from '../../tools/gwr/browser.mjs';
import { FFMPEG, FFPROBE } from './final-helpers.js';

/** Tool xoá logo thật (mặc định tools/gwr của app, ghi đè bằng GWR_CLI) và video Veo mẫu có logo. */
export const GWR_CLI: string = process.env.GWR_CLI || path.join(REPO_ROOT, 'tools', 'gwr', 'gwr.mjs');
export const VEO_SAMPLE = path.join(REPO_ROOT, 'tools', 'gwr', 'test', 'veo-sample.mp4'); // 720x1280, 10 giây, có âm thanh, có logo Veo
/** Test tích hợp chỉ chạy khi có tool, Edge/Chrome trên máy, video mẫu và ffmpeg/ffprobe. */
export const gwrAvailable: boolean = fs.existsSync(GWR_CLI) && !!findBrowser() && fs.existsSync(VEO_SAMPLE) && !!FFMPEG && !!FFPROBE;
