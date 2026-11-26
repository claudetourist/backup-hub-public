import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant;
  /** All sizes keep a 40px minimum touch height; size changes padding and type only. */
  size?: ButtonSize;
  /** Optional leading icon (decorative; the label carries the meaning). */
  icon?: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', icon, type = 'button', children, ...rest }: ButtonProps) {
  return (
    <button type={type} className={`btn btn--${variant} btn--${size}`} {...rest}>
      {icon ? <span className="btn__icon">{icon}</span> : null}
      {children}
    </button>
  );
}
