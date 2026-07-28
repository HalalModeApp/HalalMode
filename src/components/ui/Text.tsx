import { Text as RNText, type TextProps as RNTextProps, StyleSheet } from 'react-native';

import { color, font, microLabel } from '@/theme/tokens';

/**
 * The reference gives every string one of a handful of jobs. Naming those jobs
 * here keeps Playfair on the human sentences and Beiruti on the mechanics,
 * which is the whole typographic idea.
 */
export type TextVariant =
  /** Playfair. Screen headlines — "Five introductions, one at a time." */
  | 'display'
  /** Playfair, smaller. Card and sheet headings. */
  | 'displaySmall'
  /** Playfair, smallest. Inline pull-quotes. */
  | 'quote'
  /** Wide-tracked uppercase. "Today · resets at fajr". */
  | 'micro'
  /** Wide-tracked uppercase in gold. Step counters that matter. */
  | 'microAccent'
  /** Default reading size. */
  | 'body'
  /** Secondary reading size. */
  | 'bodySmall'
  /** Field labels, names, emphasis. */
  | 'label'
  /** The quietest hints and counters. */
  | 'caption';

export interface TextProps extends RNTextProps {
  variant?: TextVariant;
  /** Overrides the variant's colour. */
  tone?: keyof typeof color;
  center?: boolean;
}

export function Text({
  variant = 'body',
  tone,
  center,
  style,
  ...rest
}: TextProps) {
  return (
    <RNText
      {...rest}
      style={[
        styles[variant],
        tone ? { color: color[tone] } : null,
        center ? { textAlign: 'center' } : null,
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  display: {
    fontFamily: font.display,
    fontSize: 26,
    lineHeight: 30,
    letterSpacing: -0.3,
    color: color.ink,
  },
  displaySmall: {
    fontFamily: font.display,
    fontSize: 20,
    lineHeight: 25,
    color: color.ink,
  },
  quote: {
    fontFamily: font.display,
    fontSize: 17,
    lineHeight: 25,
    color: color.ink,
  },
  micro: {
    fontFamily: font.bodySemi,
    ...microLabel.tiny,
    color: color.label,
  },
  microAccent: {
    fontFamily: font.bodyBold,
    ...microLabel.tiny,
    color: color.gold,
  },
  body: {
    fontFamily: font.body,
    fontSize: 13,
    lineHeight: 22,
    color: color.inkSoft,
  },
  bodySmall: {
    fontFamily: font.body,
    fontSize: 12,
    lineHeight: 20,
    color: color.muted,
  },
  label: {
    fontFamily: font.bodySemi,
    fontSize: 13,
    lineHeight: 18,
    color: color.ink,
  },
  caption: {
    fontFamily: font.body,
    fontSize: 11,
    lineHeight: 17,
    color: color.faintest,
  },
});
