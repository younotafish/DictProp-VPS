import { useEffect, useState } from 'react';
import { getTtsStyle, subscribeTtsStyle } from '../../services/ttsSettings';

/** The current Clear/Casual speech style, so audio warm-ups run again in the voice a switch selects. */
export function useSpeechStyle() {
  const [speechStyle, setSpeechStyle] = useState(getTtsStyle);
  useEffect(() => subscribeTtsStyle(setSpeechStyle), []);
  return speechStyle;
}
