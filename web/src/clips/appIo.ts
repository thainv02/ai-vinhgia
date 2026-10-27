import { api as mainApi, request } from '../api/client';
import { uploadWithProgress } from '../planner/api';
import { makeClipApi, type ClipIo } from './api';
import type { ClipEnv } from './env';

/** Truyền tải của app chính: cùng origin, không có xác thực theo cookie. */
export const appIo: ClipIo = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  patch: (p, b) => request('PATCH', p, b),
  put: (p, b) => request('PUT', p, b),
  upload: (p, form, onProgress) => uploadWithProgress(p, form, onProgress),
};

export const appClipApi = makeClipApi('/api', appIo);


/** Môi trường dùng chung (api + hành động riêng của app chính) cho các trang /clips. */
export const appClipEnv: ClipEnv = {
  api: appClipApi,
  scope: 'app',
  quota: null,
  cancelJob: (id) => mainApi.cancelJob(id),
  deleteProject: (id, name) => mainApi.deleteProject(id, name),
};
