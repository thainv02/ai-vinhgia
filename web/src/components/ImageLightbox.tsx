import { Modal } from './Modal';

export function ImageLightbox({ src, title, onClose }: { src: string | null; title: string; onClose: () => void }) {
  return (
    <Modal open={!!src} onClose={onClose} title={title} wide>
      {src && <img src={src} alt={title} className="mx-auto max-h-[70vh] w-auto max-w-full rounded-md" />}
    </Modal>
  );
}
