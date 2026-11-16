import { useEffect, useState } from 'react';
import { needsReplan, planAutoplayPreload, type PreloadCard, type PreloadPlan } from '../../services/audio/autoplayPreload';
import { getPlaybackRate, getTtsStyle, subscribeTtsStyleChosen } from '../../services/ttsSettings';
import { useLatest } from '../../hooks/useStableValue';

interface AutoplayPreloadPlanOptions {
  /** Sentence auto-play is on; there's a plan only while it runs. */
  active: boolean;
  /** The cards in reading order, read when a plan is made, so a new list (a listen saved) doesn't make a new plan. */
  getCards: () => readonly PreloadCard[];
  /** The card on screen, as an index into the cards. */
  position: number;
  timerMinutes: number;
  repeats: number;
  gapMs: number;
  /** The silence after a card's last read. */
  cardGapMs: number;
  /** What's left of the Duration (useAutoPlay's remainingMs). */
  remainingMs: () => number;
}

/**
 * The part of the list sentence auto-play preloads (planAutoplayPreload), from the card on screen when it starts. It's
 * planned again when the Duration, the repeats, the interval or the speech style (a click on Clear or Casual, wherever
 * the switch is, the review popup's included) change, and when the card on screen leaves the planned cards (a swipe
 * back, or a skip past them). The style a card switches to as it comes up is part of the plan, so moving between cards
 * never replans, and neither does the voice speed, which the plan's margin absorbs until the next plan.
 */
export function useAutoplayPreloadPlan({
  active, getCards, position, timerMinutes, repeats, gapMs, cardGapMs, remainingMs,
}: AutoplayPreloadPlanOptions): PreloadPlan | null {
  const [plan, setPlan] = useState<PreloadPlan | null>(null);
  // Clicks on Clear or Casual, wherever the switch is, while auto-play runs.
  const [styleChoices, setStyleChoices] = useState(0);
  const getCardsRef = useLatest(getCards);
  const remainingMsRef = useLatest(remainingMs);
  const positionRef = useLatest(position);

  // A plan from the card on screen, with the settings now.
  const planFrom = (fromIndex: number): PreloadPlan | null => {
    const cards = getCardsRef.current();
    if (fromIndex >= cards.length) return null;
    return planAutoplayPreload({
      cards, fromIndex, remainingMs: remainingMsRef.current(), repeats, gapMs, cardGapMs, rate: getPlaybackRate(),
      currentStyle: getTtsStyle(),
    });
  };

  useEffect(() => {
    if (!active) return;
    return subscribeTtsStyleChosen(() => setStyleChoices(count => count + 1));
  }, [active]);

  useEffect(() => {
    setPlan(active ? planFrom(positionRef.current) : null);
    // The cards, the time left and the place are read as the plan is made; these are what make a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, timerMinutes, repeats, gapMs, cardGapMs, styleChoices]);

  // The card on screen left the planned cards: plan again from it.
  useEffect(() => {
    if (!active || !plan || !needsReplan(plan, position)) return;
    setPlan(planFrom(position));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, plan, position]);

  return plan;
}
