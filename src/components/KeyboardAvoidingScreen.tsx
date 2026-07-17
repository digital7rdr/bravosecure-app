/**
 * KeyboardAvoidingScreen — reusable wrapper that keeps text inputs
 * visible above the on-screen keyboard.
 *
 * Why this exists: across 12+ screens we had hand-rolled
 * KeyboardAvoidingView + (View | ScrollView) combinations, several
 * with subtly wrong behavior values. Worse, screens with a tall form
 * (Register, ProfileCompletion, Vault*) used a plain <View> as the
 * inner layout — so even with KAV the bottommost inputs got covered
 * because the content couldn't scroll up past its own height.
 *
 * What this gives you:
 *   • Correct `behavior` per platform (iOS: padding, Android: height).
 *     Android needs `height` because edge-to-edge layouts on API 30+
 *     ignore `padding` and don't push content above the IME.
 *   • Built-in ScrollView with `keyboardShouldPersistTaps="handled"`
 *     so taps on buttons WHILE the keyboard is open dismiss it AND
 *     fire the press, instead of swallowing the press as a
 *     keyboard-dismissal gesture.
 *   • `keyboardVerticalOffset` accounts for any header above the
 *     screen body (default 0; pass insets.top + headerHeight if your
 *     screen has its own custom header).
 *
 * When NOT to use:
 *   • The chat / call screens have their own composer-row layout
 *     and use KeyboardAvoidingView directly with custom offsets.
 *     Don't replace those.
 *   • Modal sheets that already wrap their own KAV (group-call
 *     invite picker, audio-route picker).
 */
import React from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type KeyboardAvoidingViewProps,
  type ScrollViewProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

interface Props {
  children: React.ReactNode;
  /** Outer container background — defaults to transparent so the parent screen color shows through. */
  style?: StyleProp<ViewStyle>;
  /** Inner ScrollView contentContainerStyle — use this for padding around the form. */
  contentContainerStyle?: StyleProp<ViewStyle>;
  /** Extra px to add above the keyboard's reserved space (e.g. for a tall custom header). */
  keyboardVerticalOffset?: number;
  /** Disable the default ScrollView and render children directly. Use when content fits one screen and you want fixed positioning. */
  scrollable?: boolean;
  /** Pass-through ScrollView props for advanced cases (refresh control, etc.). */
  scrollViewProps?: Omit<ScrollViewProps, 'children' | 'contentContainerStyle' | 'keyboardShouldPersistTaps'>;
  /** Pass-through KeyboardAvoidingView props (rarely needed). */
  kavProps?: Omit<KeyboardAvoidingViewProps, 'children' | 'behavior' | 'keyboardVerticalOffset' | 'style'>;
}

export default function KeyboardAvoidingScreen({
  children,
  style,
  contentContainerStyle,
  keyboardVerticalOffset = 0,
  scrollable = true,
  scrollViewProps,
  kavProps,
}: Props): React.ReactElement {
  return (
    <KeyboardAvoidingView
      style={[styles.flex, style]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={keyboardVerticalOffset}
      {...kavProps}>
      {scrollable ? (
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[styles.scrollContent, contentContainerStyle]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          {...scrollViewProps}>
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.flex, contentContainerStyle]}>{children}</View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {flex: 1},
  scrollContent: {flexGrow: 1},
});
