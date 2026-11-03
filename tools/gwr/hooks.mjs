/** Hook nạp module: `playwright` → lớp đệm playwright-shim.mjs (không sửa code của @pilio/gemini-watermark-remover). */
const SHIM = new URL('./playwright-shim.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'playwright') return { url: SHIM, shortCircuit: true };
  return nextResolve(specifier, context);
}
