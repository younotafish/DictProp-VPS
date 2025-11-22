import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'icon';
  size?: 'sm' | 'md' | 'lg';
}

export const Button: React.FC<ButtonProps> = ({ 
  children, 
  variant = 'primary', 
  size = 'md', 
  className = '', 
  ...props 
}) => {
  const baseStyles = "rounded-xl font-medium transition-all duration-150 active:scale-95 flex items-center justify-center disabled:opacity-50 disabled:pointer-events-none";
  
  const variants = {
    primary: "bg-indigo-600 text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700",
    secondary: "bg-white text-slate-700 border border-slate-200 shadow-sm hover:bg-slate-50",
    ghost: "bg-transparent text-slate-600 hover:bg-slate-100",
    icon: "p-2 bg-white/80 backdrop-blur text-slate-700 hover:bg-white shadow-sm rounded-full"
  };

  const sizes = {
    sm: "px-3 py-1.5 text-sm",
    md: "px-4 py-2.5 text-base",
    lg: "px-6 py-3 text-lg"
  };

  const variantStyles = variants[variant];
  const sizeStyles = variant === 'icon' ? '' : sizes[size];

  return (
    <button 
      className={`${baseStyles} ${variantStyles} ${sizeStyles} ${className}`} 
      {...props}
    >
      {children}
    </button>
  );
};
