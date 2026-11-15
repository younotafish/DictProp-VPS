import React from 'react';

const BASE_STYLES = "rounded-xl font-medium transition-all duration-150 active:scale-95 flex items-center justify-center disabled:opacity-50 disabled:pointer-events-none";

const VARIANTS = {
  primary: "bg-indigo-600 text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700",
  secondary: "bg-white text-slate-700 border border-slate-200 shadow-sm hover:bg-slate-50",
  ghost: "bg-transparent text-slate-600 hover:bg-slate-100",
  // No colour, background or shadow of its own: for a button whose className gives it all of them.
  plain: "",
};

const SIZES = {
  sm: "px-3 py-1.5 text-sm",
  md: "px-4 py-2.5 text-base",
};

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
  /**
   * Added after the variant's classes, but that order doesn't settle a conflict: Tailwind's stylesheet
   * does, and it orders utilities by name, so a class setting something the variant also sets (background,
   * text colour, shadow, radius) wins or loses by alphabetical accident. Restyle through `plain` instead.
   */
  className?: string;
}

/** A button of type "button" unless told otherwise, so it never submits a form it happens to sit in. */
export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'primary',
  size = 'md',
  type = 'button',
  className = '',
  ...props
}) => (
  <button
    type={type}
    className={`${BASE_STYLES} ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
    {...props}
  >
    {children}
  </button>
);
