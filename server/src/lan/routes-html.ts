import fs from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { notFound, conflict } from '../lib/errors.js';
import { intParam, parse } from '../lib/validate.js';
import { assetFileAbs, deleteHtmlAsset, listHtmlAssets, uploadHtmlAsset } from '../services/html/assets.js';
import { composeExtras } from '../services/html/compose-policy.js';
import { createHtmlProject, createHtmlProjectBody, htmlProjectView, listHtmlProjects, patchHtmlProject, patchHtmlProjectBody } from '../services/html/projects.js';
import { getHtmlAsset, getHtmlProject, getVersion, getVersionById } from '../services/html/repo.js';
import { cancelHtmlVersion, createComposingVersion, createVariableVersion, getVersionView, listVersions, variableValuesBody } from '../services/html/versions.js';
import { versionView } from '../services/html/view.js';
import { deleteFromPlanner } from '../services/trash.js';
import { cancelVoice, editVoice, startVoice, voiceView } from '../services/html/voice.js';
import { confirmImageLabels } from '../services/html/image-review.js';
import { listSegments, retrySegment } from '../services/html/segments.js';
import { splitSegments } from '../services/html/split-segments.js';
import { projectMeta } from '../services/html/repo.js';
import { voiceSnapshot } from '../services/html/voice.js';

const idem = z.string().trim().min(8, 'idempotency_key tối thiểu 8 ký tự').max(100).regex(/^[\w.:-]+$/, 'idempotency_key chỉ gồm chữ, số, . _ : -');
const modelId = z.string().trim().min(1).max(100).regex(/^[\w.:/-]+$/);
const noControl = (s: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);

const composeBody = z.object({
  prompt: z.string().trim().min(1, 'cần mô tả video').max(10_000, 'tối đa 10000 ký tự').refine(noControl, 'không được chứa ký tự điều khiển'),
  idempotency_key: idem,
  model: z.object({ compose: modelId.optional(), vision: modelId.optional() }).optional(),
});
const reviseBody = z.object({
  feedback: z.string().trim().min(1, 'cần nhập góp ý').max(5_000, 'tối đa 5000 ký tự').refine(noControl, 'không được chứa ký tự điều khiển'),
  idempotency_key: idem,
  model: z.object({ compose: modelId.optional(), vision: modelId.optional() }).optional(),
});
const variablesBody = variableValuesBody.extend({ idempotency_key: idem });

/**
 * Video HTML (CHỈ bản desktop): `/lan/api/html-projects`. Không đăng ký trên listener LAN thật (`desktop=false` → 404). Mọi route kiểm tra dự án
 * `kind='html'`; dự án loại khác trả 404. Xem server/API.md mục 15. Render/preview là phần việc khác (chưa có ở đây).
 */
export function registerLanHtmlRoutes(app: FastifyInstance, ctx: AppContext): void {
  const P = '/lan/api/html-projects';
  const pid = (req: FastifyRequest) => intParam((req.params as { id: string }).id);
  const vnum = (req: FastifyRequest) => intParam((req.params as { v: string }).v, 'v');

  app.get(P, async () => listHtmlProjects(ctx));

  app.post(P, async (req, reply) => {
    const body = parse(createHtmlProjectBody, req.body ?? {});
    return reply.code(201).send(htmlProjectView(ctx, createHtmlProject(ctx, body)));
  });

  app.get(`${P}/:id`, async (req) => htmlProjectView(ctx, getHtmlProject(ctx, pid(req))));
  app.get(`${P}/:id/estimate`,async(req)=>{
    const id=getHtmlProject(ctx,pid(req)).id,voice=voiceSnapshot(ctx,id),total=voice?.duration_s??projectMeta(ctx,id).duration_s;
    const segments=splitSegments(total,voice?.transcript.sentences,voice?.transcript.words);
    return {total_s:total,segments,compose_calls:segments.length,max_compose_calls:segments.length*6};
  });

  app.patch(`${P}/:id`, async (req) => htmlProjectView(ctx, patchHtmlProject(ctx, pid(req), parse(patchHtmlProjectBody, req.body ?? {}))));

  // Xoá vĩnh viễn ngay (desktop). Chặn 409 PROJECT_BUSY khi đang tạo/kiểm tra/dựng/tải asset.
  app.delete(`${P}/:id`, async (req) => {
    const p = getHtmlProject(ctx, pid(req));
    const r = await deleteFromPlanner(ctx, p.id);
    return { ok: true, id: p.id, purged: r.purged };
  });

  // ---- asset ----
  app.get(`${P}/:id/assets`, async (req) => listHtmlAssets(ctx, pid(req)));
  app.post(`${P}/:id/image-labels/confirm`, async (req) => {
    const b = parse(z.object({ confirmed: z.literal(true), labels: z.array(z.object({ id: z.number().int().positive(), label: z.string().trim().min(1).max(600).regex(/^[^\u0000-\u001f\u007f]*$/) })).min(1).max(500) }), req.body);
    return confirmImageLabels(ctx, pid(req), b.labels);
  });
  app.get(`${P}/:id/voice`, async (req) => voiceView(ctx, pid(req)));
  app.post(`${P}/:id/voice`, async (req, reply) => {
    const b = parse(z.object({ asset_id: z.number().int().positive(), captions: z.boolean().default(true) }), req.body);
    return reply.code(202).send(startVoice(ctx, pid(req), b.asset_id, b.captions));
  });
  app.patch(`${P}/:id/voice`, async (req) => {
    const b = parse(z.object({ words: z.array(z.object({ i: z.number().int().min(0), w: z.string().trim().min(1).max(100).regex(/^[^\u0000-\u001f\u007f<>]*$/) })).max(5000), captions: z.boolean() }), req.body);
    return editVoice(ctx, pid(req), b.words, b.captions);
  });
  app.post(`${P}/:id/voice/cancel`, async (req) => cancelVoice(ctx, pid(req)));
  app.delete(`${P}/:id/voice`, async (req) => cancelVoice(ctx, pid(req), true));
  app.post(`${P}/:id/assets`, async (req, reply) => reply.code(201).send(await uploadHtmlAsset(ctx, req, pid(req))));
  app.delete(`${P}/:id/assets/:assetId`, async (req) => {
    const id = pid(req);
    deleteHtmlAsset(ctx, id, intParam((req.params as { assetId: string }).assetId, 'assetId'));
    return { ok: true };
  });
  // Xem/tải asset gốc (thumbnail trong giao diện). Chỉ asset của chính dự án này.
  app.get(`${P}/:id/assets/:assetId/file`, async (req, reply) => {
    const a = getHtmlAsset(ctx, getHtmlProject(ctx, pid(req)).id, intParam((req.params as { assetId: string }).assetId, 'assetId'));
    const abs = assetFileAbs(ctx, a);
    if (!abs) throw notFound('file asset');
    reply.header('Content-Type', a.media_type).header('Content-Length', a.bytes).header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, no-cache');
    return reply.send(fs.createReadStream(abs));
  });

  // ---- phiên bản ----
  app.get(`${P}/:id/versions`, async (req) => listVersions(ctx, pid(req)));
  app.get(`${P}/:id/versions/:v`, async (req) => getVersionView(ctx, pid(req), vnum(req)));
  app.post(`${P}/:id/versions/:v/segments/:idx/retry`,async(req)=>{
    const owner=getVersion(ctx,getHtmlProject(ctx,pid(req)).id,vnum(req));
    return {version:versionView(ctx,retrySegment(ctx,owner,intParam((req.params as {idx:string}).idx,'idx')))};
  });
  app.post(`${P}/:id/versions/:v/segments/:idx/variables`,async(req,reply)=>{
    const body=parse(variablesBody,req.body??{}),id=pid(req),parent=getVersion(ctx,getHtmlProject(ctx,id).id,vnum(req));
    const idx=intParam((req.params as {idx:string}).idx,'idx'),old=listSegments(ctx,parent.id).find(s=>s.idx===idx);
    if(!old?.segment_version_id)throw notFound('đoạn');
    const r=createComposingVersion(ctx,{projectId:id,parentId:parent.id,prompt:parent.prompt,feedback:`Sửa biến đoạn ${idx}: ${JSON.stringify(body.values)}`,segmentIndices:[idx],deferSegmentCompose:true,createdBy:'user',idempotencyKey:body.idempotency_key});
    if(r.created){
      const row=listSegments(ctx,r.version.id).find(s=>s.idx===idx)!;
      try{await createVariableVersion(ctx,{projectId:id,parentId:old.segment_version_id,values:body.values,segmentOwnerId:r.version.id,segmentRowId:row.id});}
      catch(e){ctx.tx(()=>{ctx.db.prepare("UPDATE html_segments SET status='failed',error=? WHERE id=?").run(e instanceof Error?e.message:'Lỗi sửa biến',row.id);ctx.db.prepare("UPDATE html_versions SET status='failed',error='Lỗi sửa biến đoạn',error_code='HTML_SEGMENT_FAILED' WHERE id=?").run(r.version.id);});throw e;}
    }
    return reply.code(r.created?201:200).send({version:versionView(ctx,getVersionById(ctx,r.version.id)),created:r.created});
  });
  app.post(`${P}/:id/versions/:v/segments/:idx/revise`,async(req,reply)=>{
    const body=parse(reviseBody,req.body??{}),id=pid(req),parent=getVersion(ctx,getHtmlProject(ctx,id).id,vnum(req));
    const idx=intParam((req.params as {idx:string}).idx,'idx');
    if(!listSegments(ctx,parent.id).some(s=>s.idx===idx))throw notFound('đoạn');
    const x=await composeExtras(ctx,id,body.model);
    const r=createComposingVersion(ctx,{projectId:id,parentId:parent.id,prompt:parent.prompt,feedback:`Đoạn ${idx}: ${body.feedback}`,segmentIndices:[idx],createdBy:'ai',policy:x.policy,payload:{...x.payload,template:null},idempotencyKey:body.idempotency_key});
    return reply.code(r.created?201:200).send({version:versionView(ctx,r.version),created:r.created});
  });

  // Tạo mới bằng AI: người dùng bấm nên job được duyệt sẵn. Cùng idempotency_key → cùng phiên bản (200, created:false).
  app.post(`${P}/:id/compose`, async (req, reply) => {
    const body = parse(composeBody, req.body ?? {});
    const id = pid(req);
    getHtmlProject(ctx, id);
    const x = await composeExtras(ctx, id, body.model); // snapshot model + mẫu/canvas vào payload (W2)
    const r = createComposingVersion(ctx, { projectId: id, prompt: body.prompt, createdBy: 'ai', policy: x.policy, payload: x.payload, idempotencyKey: body.idempotency_key });
    return reply.code(r.created ? 201 : 200).send({ version: versionView(ctx, r.version), created: r.created });
  });

  // Sửa bằng góp ý AI từ phiên bản `ready` → phiên bản mới (bản cũ giữ nguyên).
  app.post(`${P}/:id/versions/:v/revise`, async (req, reply) => {
    const body = parse(reviseBody, req.body ?? {});
    const id = pid(req);
    const parent = getVersion(ctx, getHtmlProject(ctx, id).id, vnum(req));
    const x = await composeExtras(ctx, id, body.model);
    const r = createComposingVersion(ctx, { projectId: id, parentId: parent.id, prompt: parent.prompt, feedback: body.feedback, createdBy: 'ai', policy: x.policy, payload: { ...x.payload, template: null }, idempotencyKey: body.idempotency_key });
    return reply.code(r.created ? 201 : 200).send({ version: versionView(ctx, r.version), created: r.created });
  });

  // Sửa nhanh bằng form chữ/màu/ảnh → phiên bản `created_by='user'` (không gọi AI).
  app.post(`${P}/:id/versions/:v/variables`, async (req, reply) => {
    const body = parse(variablesBody, req.body ?? {});
    const id = pid(req);
    const parent = getVersion(ctx, getHtmlProject(ctx, id).id, vnum(req));
    if(parent.is_segmented)throw conflict('SEGMENT_VARIABLES_REQUIRED','Chọn một đoạn để sửa biến');
    const r = await createVariableVersion(ctx, { projectId: id, parentId: parent.id, values: body.values, idempotencyKey: body.idempotency_key });
    return reply.code(r.created ? 201 : 200).send({ version: versionView(ctx, r.version), created: r.created });
  });

  app.post(`${P}/:id/versions/:v/cancel`, async (req) => ({ version: versionView(ctx, cancelHtmlVersion(ctx, pid(req), vnum(req))) }));
}
