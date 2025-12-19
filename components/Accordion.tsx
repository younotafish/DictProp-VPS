import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';

interface AccordionItemProps {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  icon?: React.ReactNode;
}

export const AccordionItem: React.FC<AccordionItemProps> = ({
  title,
  children,
  defaultOpen = false,
  icon
}) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(defaultOpen ? undefined : 0);

  useEffect(() => {
    if (isOpen) {
      const contentEl = contentRef.current;
      if (contentEl) {
        setHeight(contentEl.scrollHeight);
        // After animation, set to auto for dynamic content
        const timeout = setTimeout(() => setHeight(undefined), 300);
        return () => clearTimeout(timeout);
      }
    } else {
      setHeight(0);
    }
  }, [isOpen]);

  return (
    <div className="border-b border-slate-100 last:border-b-0">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between py-4 px-1 text-left hover:bg-slate-50/50 transition-colors rounded-lg -mx-1"
      >
        <div className="flex items-center gap-2.5">
          {icon && (
            <span className="text-slate-400 w-5 h-5 flex items-center justify-center">
              {icon}
            </span>
          )}
          <span className="font-medium text-slate-700 text-[15px]">{title}</span>
        </div>
        <ChevronDown
          size={18}
          className={`text-slate-400 transition-transform duration-300 ease-out ${
            isOpen ? 'rotate-180' : 'rotate-0'
          }`}
        />
      </button>
      <div
        className="overflow-hidden transition-all duration-300 ease-out"
        style={{ height: height === undefined ? 'auto' : height }}
      >
        <div ref={contentRef} className="pb-4 pt-1 px-1">
          {children}
        </div>
      </div>
    </div>
  );
};

interface AccordionProps {
  children: React.ReactNode;
  className?: string;
}

export const Accordion: React.FC<AccordionProps> = ({ children, className = '' }) => {
  return (
    <div className={`divide-y divide-slate-100 ${className}`}>
      {children}
    </div>
  );
};


