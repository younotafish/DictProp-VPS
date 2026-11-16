import React, { useState } from 'react';
import { dismissUpdate, reloadApp, useAppUpdate } from '../services/appUpdate';
import { NoticePill, type NoticeAction } from './NoticePill';

/** Offers the reload a deploy calls for. Reloading saves and sends unsent changes first, so it can take a moment. */
export const AppUpdateToast: React.FC = () => {
  const reason = useAppUpdate();
  const [reloading, setReloading] = useState(false);
  if (!reason) return null;
  const reload: NoticeAction = { label: reloading ? 'Saving…' : 'Reload', disabled: reloading, onClick: () => { setReloading(true); void reloadApp(); } };
  const dismiss: NoticeAction = { label: 'Dismiss the update notice', title: 'Not now', dismiss: true, onClick: dismissUpdate };
  return (
    <NoticePill tone="dark" actions={reloading ? [reload] : [reload, dismiss]}>
      {reason === 'chunk-load' ? 'Part of the app couldn’t load' : 'A new version is available'}
    </NoticePill>
  );
};
