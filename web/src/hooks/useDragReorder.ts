import { useState, type DragEvent } from 'react';

/** Kéo thả đổi thứ tự một danh sách (HTML5 drag and drop). Dùng `bind(i)` trên từng dòng. */
export function useDragReorder(onMove: (from: number, to: number) => void, disabled = false) {
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  const bind = (i: number) => ({
    draggable: !disabled,
    onDragStart: (e: DragEvent) => {
      setDrag(i);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i)); // Firefox cần dữ liệu để bắt đầu kéo
    },
    onDragOver: (e: DragEvent) => {
      if (drag === null) return;
      e.preventDefault();
      e.stopPropagation();
      setOver(i);
    },
    onDrop: (e: DragEvent) => {
      if (drag === null) return;
      e.preventDefault();
      e.stopPropagation();
      if (drag !== i) onMove(drag, i);
      setDrag(null);
      setOver(null);
    },
    onDragEnd: () => {
      setDrag(null);
      setOver(null);
    },
  });

  return { drag, over, bind };
}
