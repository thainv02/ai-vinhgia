import { useQuery } from '@tanstack/react-query';
import { planner } from './api';

/** Trạng thái máy chủ AI / công cụ xoá logo / hàng đợi render: dùng chung cho thanh trạng thái và Cài đặt (cùng queryKey nên không gọi trùng). */
export function useAppStatus() {
  const status = useQuery({ queryKey: ['status'], queryFn: planner.status, refetchInterval: 10_000 });
  const tool = useQuery({ queryKey: ['tool-status'], queryFn: planner.toolStatus, refetchInterval: 10_000 });
  return { status, tool };
}
