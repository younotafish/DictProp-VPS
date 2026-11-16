import React, { useState } from 'react';
import { dismissUpdate, reloadApp, updateNoticeVisible, useAppUpdate } from '../services/appUpdate';
import { NoticePill, type NoticeAction } from './NoticePill';

/**
 * Offers the reload a deploy calls for, in a few words; the full sentence is its title and accessible name. While
 * `hold` (an open card or popup covers the page), a new version waits. Reloading saves and sends unsent changes first,
 * so it can take a moment.
 */
export const AppUpdateToast: React.FC<{ hold: boolean }> = ({ hold }) => {
  const reason = useAppUpdate();
  const [reloading, setReloading] = useState(false);
  if (!updateNoticeVisible(reason, hold)) return null;
  const failed = reason === 'chunk-load';
  const sentence = failed ? 'Part of the app couldn’t load' : 'A new version is available';
  const reload: NoticeAction = { label: reloading ? 'Saving…' : 'Reload', disabled: reloading, onClick: () => { setReloading(true); void reloadApp(); } };
  const dismiss: NoticeAction = { label: 'Dismiss the update notice', title: 'Not now', dismiss: true, onClick: dismissUpdate };
  return (
    <NoticePill tone="dark" title={sentence} label={sentence} actions={reloading ? [reload] : [reload, dismiss]}>
      {failed ? 'Reload needed' : 'Update ready'}
    </NoticePill>
  );
};
