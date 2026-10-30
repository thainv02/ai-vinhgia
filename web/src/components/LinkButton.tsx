import type { ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { buttonClass, type ButtonSize, type ButtonVariant } from './Button';

// Tách khỏi Button.tsx để trang planner LAN (bundle riêng, không dùng react-router) không kéo theo thư viện định tuyến.
export function LinkButton({ variant = 'secondary', size = 'md', className = '', icon, children, ...rest }: LinkProps & { variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode }) {
  return (
    <Link {...rest} className={buttonClass(variant, size, className)}>
      {icon}
      {children}
    </Link>
  );
}
