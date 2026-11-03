// Tải model nhận dạng lời nói (gipformer INT8 + VAD) vào thư mục model. scripts/build-installer.mjs gọi lúc build để đóng model vào bộ cài:
//   node.exe server/stt-model-cli.mjs --dir ".build-cache/stt-models"
// In tiến độ từng 5% (chữ không dấu). Mã thoát 0 = đã có/đã tải xong; 1 = lỗi.
import { cliArg } from '../config.js';
import { downloadSttModel, STT_MODEL, STT_MODEL_BYTES, sttModelStatus } from '../services/clips/stt-model.js';

const dir = cliArg('dir');
if (!dir) {
  console.error('Thieu --dir <thu muc model>');
  process.exit(2);
}
const mb = (n: number) => (n / 1e6).toFixed(0);
const ascii = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
if (sttModelStatus(dir).installed) {
  console.log(`Model nhan dang loi noi ${STT_MODEL.label} da co.`);
  process.exit(0);
}
console.log(`Dang tai model nhan dang loi noi ${STT_MODEL.label} (${mb(STT_MODEL_BYTES)} MB)...`);
let lastStep = -1;
try {
  await downloadSttModel(dir, {
    onRetry: ({ file, waitMs }) => {
      console.log(`May chu tam gioi han/ban. Cho ${Math.ceil(waitMs / 1000)} giay roi tu dong tai lai ${file}...`);
    },
    onProgress: (p) => {
      const step = Math.floor((p.received / p.total) * 20);
      if (step === lastStep) return;
      lastStep = step;
      console.log(`  ${step * 5}% (${mb(p.received)}/${mb(p.total)} MB)`);
    },
  });
  console.log('Da tai xong model nhan dang loi noi.');
} catch (e) {
  console.log(`Khong tai duoc model nhan dang loi noi: ${ascii(e instanceof Error ? e.message : String(e))}`);
  console.log('Co the tai lai sau trong app: Cai dat > Nhan dang loi noi.');
  process.exit(1);
}
