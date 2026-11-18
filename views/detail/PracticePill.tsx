import { createPortal } from 'react-dom';
import { Target } from 'lucide-react';
import { NoticePill } from '../../components/NoticePill';
import { useNoticeSlot } from '../../components/noticeSlots';
import { practicePillLabel, practicePillText, type PracticeToggle } from './practiceToggle';

// One size and shape in both states, so a press changes only the colours: the width holds either text with room to
// spare, and the pill is as tall as the lesson row's buttons less the same pulls (-my-1), so the row never grows.
const PILL = '-my-1 inline-flex h-8 min-w-[6.75rem] shrink-0 items-center justify-center gap-1 rounded-full border px-3 text-xs font-semibold transition-colors';
const OUT = 'border-slate-200 bg-white text-slate-600 hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700';
const IN = 'border-orange-500 bg-orange-500 text-white hover:border-orange-600 hover:bg-orange-600';

/**
 * The practice pill: '+ Practice' outlined while the item is out of Today's practice, 'Practicing' filled orange while
 * it's in. Its accessible name says what a press does, so it changes with the state and the button carries no
 * aria-pressed, which would announce the state twice (a toggle's name stays put; a name that changes, like Mute and
 * Unmute, stands alone). B presses it too. The icon is Target, since a bookmark means Save in this app.
 */
export function PracticePill({ toggle, onPress }: { toggle: PracticeToggle; onPress: () => void }) {
  const label = practicePillLabel(toggle);
  return (
    <button
      type="button"
      onClick={onPress}
      aria-label={label}
      title={`${label} (B)`}
      className={`${PILL} ${toggle.practicing ? IN : OUT}`}
    >
      <Target size={14} className={toggle.practicing ? undefined : 'text-orange-500'} />
      {practicePillText(toggle.practicing)}
    </button>
  );
}

/** Why a press couldn't be taken back, as a rose alert, the way Study says its failed undo. */
export function PracticeUndoFailure({ message }: { message: string }) {
  return <NoticePill tone="rose" role="alert" wrap>{message}</NoticePill>;
}

/**
 * The failed undo's notice, while there's one to give, in the notice stack's short-lived slot, the one right under the
 * undo offer it follows (components/AppStatus stacks notices by how long they stay). Nothing while the stack is away.
 */
export function PracticeNotice({ message }: { message: string | null }) {
  const slot = useNoticeSlot('search');
  if (!message || !slot) return null;
  return createPortal(<PracticeUndoFailure message={message} />, slot);
}
