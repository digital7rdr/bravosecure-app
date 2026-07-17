import {act, renderHook} from '@testing-library/react-native';
import {Keyboard} from 'react-native';
import type {ScrollView} from 'react-native';
import {useKeyboardHeight, useRevealOnKeyboard} from '../useKeyboardHeight';

type Handler = (e?: {endCoordinates?: {height: number}}) => void;

function mockKeyboard() {
  const handlers = new Map<string, Handler>();
  const removedEvents: string[] = [];
  jest.spyOn(Keyboard, 'addListener').mockImplementation(((evt: string, cb: Handler) => {
    handlers.set(evt, cb);
    return {
      remove: () => {
        removedEvents.push(evt);
        handlers.delete(evt);
      },
    };
  }) as unknown as typeof Keyboard.addListener);
  return {
    removedEvents,
    // Fire both platform variants — the hook subscribes to whichever
    // matches the Jest Platform.OS, the other is a no-op.
    show(height: number) {
      act(() => {
        handlers.get('keyboardDidShow')?.({endCoordinates: {height}});
        handlers.get('keyboardWillShow')?.({endCoordinates: {height}});
      });
    },
    hide() {
      act(() => {
        handlers.get('keyboardDidHide')?.();
        handlers.get('keyboardWillHide')?.();
      });
    },
  };
}

beforeEach(() => {
  jest.restoreAllMocks();
  jest
    .spyOn(globalThis, 'requestAnimationFrame')
    .mockImplementation(((cb: (time: number) => void) => {
      cb(0);
      return 0;
    }) as unknown as typeof globalThis.requestAnimationFrame);
});

describe('useKeyboardHeight', () => {
  it('tracks show and hide', () => {
    const kb = mockKeyboard();
    const {result} = renderHook(() => useKeyboardHeight());
    expect(result.current).toBe(0);
    kb.show(312);
    expect(result.current).toBe(312);
    kb.hide();
    expect(result.current).toBe(0);
  });

  it('ignores sub-4dp OEM noise re-fires', () => {
    const kb = mockKeyboard();
    const {result} = renderHook(() => useKeyboardHeight());
    kb.show(300);
    kb.show(302);
    expect(result.current).toBe(300);
    kb.show(360);
    expect(result.current).toBe(360);
  });

  it('removes listeners on unmount', () => {
    const kb = mockKeyboard();
    const {unmount} = renderHook(() => useKeyboardHeight());
    unmount();
    expect(kb.removedEvents.length).toBe(2);
  });
});

describe('useRevealOnKeyboard', () => {
  function makeScrollRef() {
    return {current: {scrollToEnd: jest.fn()} as unknown as ScrollView};
  }

  it('defers the scroll until the keyboard actually shows', () => {
    const kb = mockKeyboard();
    const scrollRef = makeScrollRef();
    const {result} = renderHook(() => useRevealOnKeyboard(scrollRef));
    act(() => result.current());
    expect((scrollRef.current as any).scrollToEnd).not.toHaveBeenCalled();
    kb.show(300);
    expect((scrollRef.current as any).scrollToEnd).toHaveBeenCalledWith({animated: true});
  });

  it('scrolls immediately when the keyboard is already open (field-to-field focus)', () => {
    const kb = mockKeyboard();
    const scrollRef = makeScrollRef();
    const {result} = renderHook(() => useRevealOnKeyboard(scrollRef));
    kb.show(300);
    expect((scrollRef.current as any).scrollToEnd).not.toHaveBeenCalled();
    act(() => result.current());
    expect((scrollRef.current as any).scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('does not scroll if focus never happened', () => {
    const kb = mockKeyboard();
    const scrollRef = makeScrollRef();
    renderHook(() => useRevealOnKeyboard(scrollRef));
    kb.show(300);
    expect((scrollRef.current as any).scrollToEnd).not.toHaveBeenCalled();
  });
});
