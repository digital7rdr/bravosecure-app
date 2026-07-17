/**
 * ScreenContainer — the responsive screen shell.
 *
 * Composes the existing KeyboardAvoidingScreen (KAV + optional ScrollView)
 * and adds the two things every screen was hand-rolling: SafeArea insets and
 * (on Android tablets) max-width centering. Adopting a screen means replacing
 * its outer `View`/`SafeAreaView` + KAV + ScrollView boilerplate — and its
 * manual `paddingTop: insets.top` — with one `<ScreenContainer>`.
 *
 * SafeArea is applied via `useSafeAreaInsets()` (the pattern already used in
 * ~83 screens) rather than <SafeAreaView>, so behavior matches the rest of
 * the app and there's no nested-provider surprise.
 *
 * Tablet centering is a no-op on phones and on iOS (supportsTablet:false, so
 * iOS never reports tablet widths) — it only constrains width on Android
 * tablets/foldables. Pass `centerOnTablet={false}` for full-bleed screens
 * (maps, media) so they aren't letterboxed.
 *
 * For a fixed footer (e.g. a pinned primary button that must stay above the
 * keyboard while the body scrolls), pass it via `footer` — it renders inside
 * the KAV but OUTSIDE the scroll body.
 */
import React from 'react';
import {StyleSheet, View, type StyleProp, type ViewStyle} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import KeyboardAvoidingScreen from './KeyboardAvoidingScreen';
import {maxContentWidth, isTablet} from '@utils/scaling';

type InsetEdge = 'top' | 'bottom' | 'left' | 'right';

interface Props {
  children: React.ReactNode;
  /** Render content inside a ScrollView (default) or a fixed View. */
  scrollable?: boolean;
  /** SafeArea edges to pad. Default top + bottom (portrait). */
  edges?: InsetEdge[];
  /** Pinned content rendered after the scroll body, inside the KAV. */
  footer?: React.ReactNode;
  /** Constrain + center content on Android tablets. No-op on phones/iOS. */
  centerOnTablet?: boolean;
  /** Outer background / layout style. */
  style?: StyleProp<ViewStyle>;
  /** Padding around the scrollable content. */
  contentContainerStyle?: StyleProp<ViewStyle>;
  /** Extra px above the keyboard's reserved space (tall custom header). */
  keyboardVerticalOffset?: number;
}

export default function ScreenContainer({
  children,
  scrollable = true,
  edges = ['top', 'bottom'],
  footer,
  centerOnTablet = true,
  style,
  contentContainerStyle,
  keyboardVerticalOffset = 0,
}: Props): React.ReactElement {
  const insets = useSafeAreaInsets();

  const insetPadding: ViewStyle = {
    paddingTop: edges.includes('top') ? insets.top : 0,
    paddingBottom: edges.includes('bottom') ? insets.bottom : 0,
    paddingLeft: edges.includes('left') ? insets.left : 0,
    paddingRight: edges.includes('right') ? insets.right : 0,
  };

  const centered = centerOnTablet && isTablet;
  const body = centered ? (
    <View style={styles.tabletCenter}>{children}</View>
  ) : (
    children
  );

  return (
    <View style={[styles.root, insetPadding, style]}>
      <KeyboardAvoidingScreen
        scrollable={scrollable}
        contentContainerStyle={contentContainerStyle}
        keyboardVerticalOffset={keyboardVerticalOffset}>
        {body}
      </KeyboardAvoidingScreen>
      {footer !== null && footer !== undefined && <View>{footer}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  tabletCenter: {width: '100%', maxWidth: maxContentWidth, alignSelf: 'center'},
});
