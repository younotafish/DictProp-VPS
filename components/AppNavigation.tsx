import React, { forwardRef } from 'react';
import { Book, BookOpenText, BrainCircuit, Compass, Keyboard, MessageSquareQuote } from 'lucide-react';
import type { ViewState } from '../types';

interface NavButtonProps {
  view: ViewState;
  currentView: ViewState;
  onClick: (view: ViewState) => void;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  label: string;
  badge?: number;
}

const NavButton: React.FC<NavButtonProps> = ({ view, currentView, onClick, icon: Icon, label, badge }) => (
  <button
    onClick={() => onClick(view)}
    className={`relative flex flex-1 flex-col items-center justify-center gap-1 py-3 transition-colors ${currentView === view ? 'text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
  >
    <div className="relative">
      <Icon size={24} strokeWidth={currentView === view ? 2.5 : 2} />
      {badge !== undefined && badge > 0 && (
        <span className="absolute -right-2.5 -top-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-violet-500 px-1 text-[9px] font-bold leading-none text-white">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </div>
    <span className="text-[10px] font-bold uppercase tracking-wider">{label}</span>
  </button>
);

interface AppNavigationProps {
  currentView: ViewState;
  onNavigate: (view: ViewState) => void;
  sentenceDueCount: number;
  onKeyboardHelp: () => void;
}

const AppNavigation = forwardRef<HTMLElement, AppNavigationProps>(({
  currentView,
  onNavigate,
  sentenceDueCount,
  onKeyboardHelp,
}, ref) => (
  <nav
    ref={ref}
    className="fixed bottom-0 left-0 right-0 z-30 flex translate-y-0 justify-between bg-white px-2 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-1 transition-transform duration-300"
  >
    <NavButton view="notebook" currentView={currentView} onClick={onNavigate} icon={Book} label="Notebook" />
    <NavButton view="sentences" currentView={currentView} onClick={onNavigate} icon={MessageSquareQuote} label="Sentences" badge={sentenceDueCount || undefined} />
    <NavButton view="real-life" currentView={currentView} onClick={onNavigate} icon={Compass} label="Real Life" />
    <NavButton view="essays" currentView={currentView} onClick={onNavigate} icon={BookOpenText} label="Essays" />
    <NavButton view="study" currentView={currentView} onClick={onNavigate} icon={BrainCircuit} label="Study" />
    <button
      onClick={onKeyboardHelp}
      className="hidden flex-col items-center justify-center gap-1 py-3 text-slate-300 transition-colors hover:text-slate-500 md:flex"
      title="Keyboard shortcuts (?)"
    >
      <Keyboard size={20} strokeWidth={2} />
      <span className="text-[10px] font-bold uppercase tracking-wider">?</span>
    </button>
  </nav>
));

AppNavigation.displayName = 'AppNavigation';

export default AppNavigation;
