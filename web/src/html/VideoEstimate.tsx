import { useQuery } from '@tanstack/react-query';
import { htmlApi } from './api';
export function VideoEstimate({ id, enabled = true }: { id: number; enabled?: boolean }) {
  const q = useQuery({
    queryKey: ['html-estimate', id],
    queryFn: () => htmlApi.estimate(id),
    enabled,
    refetchInterval: enabled ? 5000 : false,
  });
  if (!q.data) return null;
  const n = q.data.compose_calls;
  return (
    <p className="av-muted">
      {n > 1 ? `Sẽ chia thành ${n} đoạn, mỗi đoạn tối đa 60 giây. ` : ''}Ước tính AI: {n} lượt compose ban đầu, khoảng {n} lần chi phí một
      đoạn. Chưa gồm quét ảnh, kiểm tra hình ảnh và lượt sửa lỗi; chi phí thực tế theo model và lượng nội dung.
    </p>
  );
}
