export interface PlanSceneProgress { id: number; code: string; storyboard: boolean; prompt: boolean; video: boolean }
export interface PlanNextAction { stage: 'storyboard' | 'prompt' | 'video' | 'final'; label: string; scene_id?: number; scene_code?: string }

/** Navigation only: producing media still requires the user's action in the selected step. */
export function nextPlanAction(scenes: PlanSceneProgress[], final: { status?: string; current?: boolean }): PlanNextAction | null {
  if (!scenes.length) return null;
  if (final.status === 'planning' || final.status === 'rendering') return { stage: 'final', label: 'Xem tiến trình dựng' };
  if (final.status === 'ready' && final.current !== false) return { stage: 'final', label: 'Xem bản hoàn chỉnh' };
  const scene = scenes.find((s) => !s.video);
  if (!scene) return { stage: 'final', label: 'Dựng bản hoàn chỉnh' };
  const stage = !scene.storyboard ? 'storyboard' : !scene.prompt ? 'prompt' : 'video';
  const label = stage === 'storyboard' ? `Làm storyboard cảnh ${scene.code}` : stage === 'prompt' ? `Xem prompt cảnh ${scene.code}` : `Tải video cảnh ${scene.code}`;
  return { stage, label, scene_id: scene.id, scene_code: scene.code };
}
