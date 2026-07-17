/**
 * B-90 T-12 — tappable URLs inside chat bubbles.
 *
 * Splits the body with the SAME regex the preview pipeline uses
 * (linkPreview.splitByUrls) and renders URL segments as underlined,
 * tappable nested Text spans. Nested spans wrap naturally with the
 * surrounding text, so long messages behave exactly like the previous
 * plain <Text>.
 */
import React from 'react';
import {Text, Linking, type StyleProp, type TextStyle} from 'react-native';
import {splitByUrls} from './linkPreview';

interface Props {
  text: string | null | undefined;
  style?: StyleProp<TextStyle>;
  /** Link tint — pass a light tone on dark bubbles, white on cobalt. */
  linkColor: string;
}

export function LinkifiedText({text, style, linkColor}: Props) {
  const body = text ?? '';
  const segments = splitByUrls(body);
  const hasUrl = segments.some(s => s.url);
  if (!hasUrl) {
    return <Text style={style}>{body}</Text>;
  }
  return (
    <Text style={style}>
      {segments.map((seg, i) =>
        seg.url ? (
          <Text
            key={`${i}-${seg.url}`}
            style={{color: linkColor, textDecorationLine: 'underline'}}
            accessibilityRole="link"
            onPress={() => { void Linking.openURL(seg.url!).catch(() => {}); }}
            suppressHighlighting>
            {seg.text}
          </Text>
        ) : (
          <Text key={i}>{seg.text}</Text>
        ),
      )}
    </Text>
  );
}
