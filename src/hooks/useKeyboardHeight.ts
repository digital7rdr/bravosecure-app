/**
 * B-84 shared keyboard avoidance.
 *
 * Why: edge-to-edge (RN 0.81 / target SDK 36, `edgeToEdgeEnabled=true`)
 * makes the manifest's `windowSoftInputMode="adjustResize"` a no-op, and
 * Android <Modal> windows never resize for the IME at all — so keyboard
 * avoidance must happen in JS. KeyboardAvoidingView with
 * `behavior="height"` leaves ghost space after the keyboard closes
 * (see ChatScreen), so the app-blessed Android pattern is manual
 * keyboard-height padding. These hooks are the shared form of the two
 * proven in-repo implementations: ChatScreen's composer padding and
 * NextOfKinModal's sheet lift.
 * Register: docs/audits/KEYBOARD_FOCUS_AUDIT_2026-07-16.md.
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import {Keyboard, Platform} from 'react-native';
import type {RefObject} from 'react';
import type {ScrollView} from 'react-native';

export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, e => {
      const next = e.endCoordinates?.height ?? 0;
      // Why: some OEM IMEs re-fire show with 1-2 px height bumps per
      // animation frame (ChatScreen Fix #29) — ignore sub-4dp deltas so
      // consumers don't re-render per frame.
      setHeight(prev => (Math.abs(prev - next) > 4 ? next : prev));
    });
    const hide = Keyboard.addListener(hideEvt, () => {
      setHeight(prev => (prev === 0 ? prev : 0));
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return height;
}

/**
 * For scroll-forms whose inputs sit at/near the BOTTOM of the content:
 * returns an onFocus handler that scrolls to the end once the keyboard
 * has actually shown (replaces fixed-timer hacks that race the IME
 * animation, e.g. the 120 ms BS-BACKUP-PWVIS timeout).
 */
export function useRevealOnKeyboard(scrollRef: RefObject<ScrollView | null>): () => void {
  const kb = useKeyboardHeight();
  const kbRef = useRef(kb);
  kbRef.current = kb;
  const pending = useRef(false);

  const scrollNow = useCallback(() => {
    // Why: wait a frame so kb-padding applied on the same keyboard event
    // has committed before the scroll target is measured.
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({animated: true}));
  }, [scrollRef]);

  useEffect(() => {
    if (kb > 0 && pending.current) {
      pending.current = false;
      scrollNow();
    }
  }, [kb, scrollNow]);

  return useCallback(() => {
    if (kbRef.current > 0) {
      scrollNow();
    } else {
      pending.current = true;
    }
  }, [scrollNow]);
}
