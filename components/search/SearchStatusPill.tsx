import React from 'react';
import { NoticePill } from '../NoticePill';
import type { SearchStatus } from './searchStatusLine';

interface Props {
  status: SearchStatus;
  /** Opens the result `id` in the sheet, which says its word. */
  onView: (id: string) => void;
}

/**
 * The search's status line, in the notice stack's dark style (GlobalSearch portals it into the stack's search slot). A
 * ready result carries View, a button, so tapping it never brings the keyboard up; the line itself never takes focus.
 */
export const SearchStatusPill: React.FC<Props> = ({ status, onView }) => {
  const { viewId } = status;
  return (
    <NoticePill tone="dark" actions={viewId ? [{ label: 'View', title: 'Open this result', onClick: () => onView(viewId) }] : undefined}>
      {status.text}
    </NoticePill>
  );
};
