import type { DetailedHTMLProps, HTMLAttributes } from 'react';

// Custom element của @hyperframes/player (import '@hyperframes/player' để đăng ký).
type PlayerProps = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
  src?: string;
  controls?: boolean;
  muted?: boolean;
  poster?: string;
  width?: number | string;
  height?: number | string;
  'sandbox-origin'?: string;
};

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'hyperframes-player': PlayerProps;
    }
  }
}
