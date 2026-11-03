import { request, uploadWithProgress } from '../planner/api';
import type { HtmlAsset, HtmlAspect, HtmlPreview, HtmlProject, HtmlQuality, HtmlRender, HtmlRendererStatus, HtmlTemplate, HtmlVersion, HtmlVoice } from './types';

const P = '/lan/api/html-projects';
const get = <T>(p: string) => request<T>('GET', p);
const post = <T>(p: string, b: unknown = {}) => request<T>('POST', p, b);

export interface ModelChoice {
  compose?: string;
  vision?: string;
}
export interface CreateHtmlProject {
  name: string;
  brief: string;
  aspect: HtmlAspect;
  duration_s: number;
  quality: HtmlQuality;
  template: string | null;
  model?: ModelChoice;
}

export const htmlApi = {
  renderSettings:()=>get<{concurrency:number|'auto';auto_concurrency:number;effective_concurrency:number}>('/lan/api/settings/render'),
  setRenderSettings:(concurrency:number|'auto')=>request('PUT','/lan/api/settings/render',{concurrency}),
  estimate:(id:number)=>get<{segments:{idx:number;start_s:number;end_s:number}[];compose_calls:number;max_compose_calls:number}>(`${P}/${id}/estimate`),
  segmentPreview:(id:number,v:number,idx:number)=>post<HtmlPreview>(`${P}/${id}/versions/${v}/segments/${idx}/preview`),
  retrySegment:(id:number,v:number,idx:number)=>post<{version:HtmlVersion}>(`${P}/${id}/versions/${v}/segments/${idx}/retry`),
  reviseSegment:(id:number,v:number,idx:number,b:{feedback:string;idempotency_key:string})=>post<{version:HtmlVersion}>(`${P}/${id}/versions/${v}/segments/${idx}/revise`,b),
  segmentVariables:(id:number,v:number,idx:number,b:{values:Record<string,string>;idempotency_key:string})=>post<{version:HtmlVersion}>(`${P}/${id}/versions/${v}/segments/${idx}/variables`,b),
  list: () => get<HtmlProject[]>(P),
  get: (id: number) => get<HtmlProject>(`${P}/${id}`),
  create: (b: CreateHtmlProject) => post<HtmlProject>(P, b),
  remove: (id: number) => request<{ ok: true; id: number; purged: boolean }>('DELETE', `${P}/${id}`),
  assets: (id: number) => get<HtmlAsset[]>(`${P}/${id}/assets`),
  confirmImageLabels: (id: number, labels: { id: number; label: string }[]) => post<{ ok: true; resumed: number }>(`${P}/${id}/image-labels/confirm`, { labels, confirmed: true }),
  voice: (id: number) => get<HtmlVoice | null>(`${P}/${id}/voice`),
  startVoice: (id: number, asset_id: number, captions = true) => post<HtmlVoice>(`${P}/${id}/voice`, { asset_id, captions }),
  cancelVoice: (id: number) => post<HtmlVoice>(`${P}/${id}/voice/cancel`),
  clearVoice: (id: number) => request<null>('DELETE', `${P}/${id}/voice`),
  editVoice: (id: number, words: { i: number; w: string }[], captions: boolean) => request<HtmlVoice>('PATCH', `${P}/${id}/voice`, { words, captions }),
  uploadAsset: (id: number, file: File, onProgress: (loaded: number, total: number) => void) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return uploadWithProgress<HtmlAsset>(`${P}/${id}/assets`, form, onProgress);
  },
  deleteAsset: (id: number, assetId: number) => request<{ ok: true }>('DELETE', `${P}/${id}/assets/${assetId}`),
  versions: (id: number) => get<HtmlVersion[]>(`${P}/${id}/versions`),
  compose: (id: number, b: { prompt: string; idempotency_key: string; model?: ModelChoice }) => post<{ version: HtmlVersion; created: boolean }>(`${P}/${id}/compose`, b),
  revise: (id: number, v: number, b: { feedback: string; idempotency_key: string }) => post<{ version: HtmlVersion; created: boolean }>(`${P}/${id}/versions/${v}/revise`, b),
  setVariables: (id: number, v: number, b: { values: Record<string, string>; idempotency_key: string }) =>
    post<{ version: HtmlVersion; created: boolean }>(`${P}/${id}/versions/${v}/variables`, b),
  cancelVersion: (id: number, v: number) => post<{ version: HtmlVersion }>(`${P}/${id}/versions/${v}/cancel`),
  // ---- W3: xem trước (theo hợp đồng) ----
  preview: (id: number, v: number) => post<HtmlPreview>(`${P}/${id}/versions/${v}/preview`),
  // ---- W1b: render (theo hợp đồng) ----
  renders: (id: number) => get<HtmlRender[]>(`${P}/${id}/renders`),
  createRender: (id: number, v: number, b: { quality: HtmlQuality; idempotency_key: string }) => post<HtmlRender>(`${P}/${id}/versions/${v}/renders`, b),
  cancelRender: (id: number, rid: number) => post<unknown>(`${P}/${id}/renders/${rid}/cancel`),
  retryRender: (id: number, rid: number, b: { idempotency_key: string }) => post<HtmlRender>(`${P}/${id}/renders/${rid}/retry`, b),
  revealRender: (id: number, rid: number) => post<unknown>(`${P}/${id}/renders/${rid}/reveal`),
  // ---- W2: template (theo hợp đồng) ----
  templates: () => get<HtmlTemplate[]>('/lan/api/html-templates'),
  // ---- W1a: bộ dựng, dùng ở Cài đặt và ở trang chi tiết (theo hợp đồng) ----
  renderer: () => get<HtmlRendererStatus>('/lan/api/settings/html-renderer'),
  downloadRenderer: () => post<HtmlRendererStatus>('/lan/api/settings/html-renderer/download'),
  cancelRendererDownload: () => post<HtmlRendererStatus>('/lan/api/settings/html-renderer/download/cancel'),
};
