import crypto from 'node:crypto';
import type { ManifestFile } from './safe-path.js';
import type { HtmlVariable } from './view.js';
/** Prefix tất định, không vượt 32 ký tự và không đổi khi chuẩn hoá lần thứ hai. */
export function prefixSegmentVariables(
  files: ManifestFile[],
  variables: (Omit<HtmlVariable, 'target'> & { target?: string })[],
  idx?: number,
) {
  if (!idx) return { files, variables: variables.map((v) => ({ ...v, target: v.target ?? v.id })) };
  const prefix = `s${idx}_`;
  const name = (s: string) =>
    s.startsWith(prefix)
      ? s
      : prefix.length + s.length <= 32
        ? prefix + s
        : prefix + s.slice(0, 32 - prefix.length - 5) + '_' + crypto.createHash('sha256').update(s).digest('hex').slice(0, 4);
  const names = new Map<string, string>();
  for (const v of variables) {
    names.set(v.id, name(v.id));
    names.set(v.target ?? v.id, name(v.target ?? v.id));
  }
  return {
    variables: variables.map((v) => ({ ...v, id: names.get(v.id)!, target: names.get(v.target ?? v.id)! })),
    files: files.map((f) => ({
      ...f,
      content: f.content
        .replace(/data-hf-var\s*=\s*(["'])([a-z][a-z0-9_-]*)\1/gi, (all, q, id) =>
          names.has(id) ? `data-hf-var=${q}${names.get(id)}${q}` : all,
        )
        .replace(/--hf-([a-z][a-z0-9_-]*)/g, (all, id) => (names.has(id) ? `--hf-${names.get(id)}` : all)),
    })),
  };
}
