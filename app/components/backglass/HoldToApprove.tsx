import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { Circle, Path, Svg } from 'react-native-svg';

import { colors, fonts, radii, space } from '../theme';
import { preloadHaptics, pressHaptic, successHaptic, tickHaptic } from './haptics';
import { motionAllowed, useReducedMotion } from './motion';

export const HOLD_MS = 1200;
/** Points on the ring where a light tick tells the owner the hold is counting. */
export const HOLD_TICKS = [0.25, 0.5, 0.75] as const;
export const RELEASE_HINT = 'Press and hold until the ring fills';
export const RELEASE_HINT_MS = 3500;
export const HOLD_A11Y_ACTION = 'Press and hold to sign';

const RING_RADIUS = 20;
const RING = 2 * Math.PI * RING_RADIUS;
const DRAIN_MS = 220;
const GLOW_MS = 120;

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedText = Animated.createAnimatedComponent(Text);

type HoldToApproveProps = {
  label?: string;
  hint?: string;
  onConfirm: () => void;
  disabled?: boolean;
  /** Change this value to arm the button again, for example after a signature was cancelled or failed. */
  resetKey?: string | number;
};

export function HoldToApprove({
  label = 'Hold to approve rule',
  hint = 'You sign on this phone. Veto never sees your key.',
  onConfirm,
  disabled = false,
  resetKey,
}: HoldToApproveProps) {
  const reduced = useReducedMotion();
  const motionOn = motionAllowed(reduced);
  const [progress] = useState(() => new Animated.Value(0));
  const [glow] = useState(() => new Animated.Value(0));
  const [flash] = useState(() => new Animated.Value(0));
  const running = useRef<Animated.CompositeAnimation | null>(null);
  const holding = useRef(false);
  const confirmed = useRef(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [done, setDone] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
    preloadHaptics();
  }, []);

  // A light tick at each quarter tells the owner the hold is counting. The
  // ring runs linearly, so the ticks are timed against the same clock.
  const tickTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  function clearTicks() {
    for (const timer of tickTimers.current) {
      clearTimeout(timer);
    }
    tickTimers.current = [];
  }

  function startTicks() {
    clearTicks();
    tickTimers.current = HOLD_TICKS.map((at) =>
      setTimeout(() => {
        if (holding.current && !confirmed.current) {
          tickHaptic();
        }
      }, Math.round(HOLD_MS * at)),
    );
  }

  function clearHintTimer() {
    if (hintTimer.current) {
      clearTimeout(hintTimer.current);
      hintTimer.current = null;
    }
  }

  useEffect(
    () => () => {
      holding.current = false;
      running.current?.stop();
      running.current = null;
      clearHintTimer();
      clearTicks();
    },
    [],
  );

  // A cancelled or failed signature must leave the button usable again.
  useEffect(() => {
    running.current?.stop();
    running.current = null;
    holding.current = false;
    confirmed.current = false;
    clearTicks();
    progress.setValue(0);
    glow.setValue(0);
    flash.setValue(0);
    clearHintTimer();
  }, [resetKey, progress, glow, flash]);

  // The visible state follows the same key, set during render so the button
  // never paints one frame of the old state.
  const [armedKey, setArmedKey] = useState(resetKey);
  if (armedKey !== resetKey) {
    setArmedKey(resetKey);
    setShowHint(false);
    setPressed(false);
    setDone(false);
  }

  function setGlow(to: number) {
    if (motionOn) {
      Animated.timing(glow, { toValue: to, duration: GLOW_MS, easing: Easing.linear, useNativeDriver: false }).start();
    } else {
      glow.setValue(to);
    }
  }

  function confirm() {
    if (disabled || confirmed.current) {
      return;
    }
    confirmed.current = true;
    holding.current = false;
    running.current = null;
    clearTicks();
    progress.setValue(1);
    clearHintTimer();
    setShowHint(false);
    setDone(true);
    successHaptic();
    if (motionOn) {
      flash.setValue(0);
      Animated.sequence([
        Animated.timing(flash, { toValue: 1, duration: 90, easing: Easing.linear, useNativeDriver: false }),
        Animated.timing(flash, { toValue: 0, duration: 260, easing: Easing.linear, useNativeDriver: false }),
      ]).start();
    }
    onConfirm();
  }

  function onPressIn() {
    if (disabled || confirmed.current) {
      return;
    }
    holding.current = true;
    clearHintTimer();
    setShowHint(false);
    setPressed(true);
    pressHaptic();
    setGlow(1);
    if (!motionOn) {
      return;
    }
    progress.setValue(0);
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: HOLD_MS,
      easing: Easing.linear,
      useNativeDriver: false,
    });
    running.current = anim;
    startTicks();
    anim.start(({ finished }) => {
      if (finished && holding.current) {
        confirm();
      }
    });
  }

  function onPressOut() {
    const early = holding.current && !confirmed.current;
    holding.current = false;
    running.current?.stop();
    running.current = null;
    clearTicks();
    setPressed(false);
    if (confirmed.current) {
      return;
    }
    setGlow(0);
    if (motionOn) {
      Animated.timing(progress, {
        toValue: 0,
        duration: DRAIN_MS,
        easing: Easing.linear,
        useNativeDriver: false,
      }).start();
    } else {
      progress.setValue(0);
    }
    if (early) {
      setShowHint(true);
      clearHintTimer();
      hintTimer.current = setTimeout(() => {
        hintTimer.current = null;
        setShowHint(false);
      }, RELEASE_HINT_MS);
    }
  }

  // With motion the ring and the fill move together from one value. Without
  // it the colour still changes, in one step, and nothing pulses or flashes.
  const lit = pressed || done;
  const fillColor = motionOn
    ? progress.interpolate({ inputRange: [0, 1], outputRange: [colors.surface, colors.brass] })
    : lit
      ? colors.brass
      : colors.surface;
  const labelColor = motionOn
    ? progress.interpolate({ inputRange: [0, 0.55, 0.6, 1], outputRange: [colors.bone, colors.bone, colors.forest, colors.forest] })
    : lit
      ? colors.forest
      : colors.bone;
  const hintColor = motionOn
    ? progress.interpolate({ inputRange: [0, 0.55, 0.6, 1], outputRange: [colors.muted, colors.muted, colors.forest, colors.forest] })
    : lit
      ? colors.forest
      : colors.muted;
  // Hide the small copy while foreground and fill colours cross in luminance.
  const hintOpacity = motionOn
    ? progress.interpolate({ inputRange: [0, 0.3499, 0.35, 0.7, 0.7001, 1], outputRange: [1, 1, 0, 0, 1, 1] })
    : 1;
  const markColor = motionOn
    ? progress.interpolate({ inputRange: [0, 1], outputRange: [colors.brass, colors.forest] })
    : lit
      ? colors.forest
      : colors.brass;
  const ringColor = motionOn
    ? progress.interpolate({ inputRange: [0, 1], outputRange: [colors.amber, colors.forest] })
    : done
      ? colors.forest
      : colors.amber;
  const dashOffset = motionOn
    ? progress.interpolate({
        inputRange: [0, 1],
        outputRange: [RING, 0],
      })
    : done
      ? 0
      : RING;

  const gestureHint = motionOn
    ? `${HOLD_A11Y_ACTION}. Hold until the ring fills. Long press does the same thing.`
    : `${HOLD_A11Y_ACTION}. Long press to approve.`;

  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}. ${hint}`}
        accessibilityHint={gestureHint}
        accessibilityState={{ disabled }}
        accessibilityActions={[{ name: 'longpress', label: HOLD_A11Y_ACTION }]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'longpress') {
            confirm();
          }
        }}
        disabled={disabled}
        delayLongPress={motionOn ? HOLD_MS : 500}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        onLongPress={confirm}
        style={[styles.button, disabled && styles.disabled]}
      >
        <Animated.View
          testID="hold-glow"
          pointerEvents="none"
          style={[styles.glow, { opacity: glow }]}
        />
        <Animated.View testID="hold-fill" pointerEvents="none" style={[styles.fill, { backgroundColor: fillColor }]}>
          {motionOn ? (
            <Animated.View testID="hold-flash" pointerEvents="none" style={[styles.flash, { opacity: flash }]} />
          ) : null}
        </Animated.View>
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Svg width={44} height={44} viewBox="0 0 52 52">
            <Circle cx={26} cy={26} r={RING_RADIUS} fill="none" stroke={colors.track} strokeWidth={4} />
            <AnimatedCircle
              cx={26}
              cy={26}
              r={RING_RADIUS}
              fill="none"
              stroke={ringColor}
              strokeWidth={4}
              strokeLinecap="round"
              strokeDasharray={`${RING} ${RING}`}
              strokeDashoffset={dashOffset}
              rotation={-90}
              origin="26, 26"
            />
            <AnimatedPath d="M26 15l8 3v6c0 6-3.5 10-8 12-4.5-2-8-6-8-12v-6z" fill={markColor} />
            <Path
              d="M22 26l3 3 5-6"
              fill="none"
              stroke={colors.amber}
              strokeWidth={2.2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </Svg>
        </View>
        <View style={styles.copy}>
          <AnimatedText style={[styles.label, { color: labelColor }]}>{label}</AnimatedText>
          <AnimatedText style={[styles.hint, { color: hintColor, opacity: hintOpacity }]}>{hint}</AnimatedText>
        </View>
      </Pressable>
      {showHint ? (
        <Text accessibilityLiveRegion="polite" style={styles.releaseHint}>
          {RELEASE_HINT}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: space.md,
  },
  button: {
    minHeight: 64,
    borderRadius: radii.hold,
    borderWidth: 1,
    borderColor: colors.brassLine,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xxl,
    paddingHorizontal: space.xxl,
    paddingVertical: space.lg,
  },
  glow: {
    position: 'absolute',
    top: -5,
    left: -5,
    right: -5,
    bottom: -5,
    borderRadius: radii.hold + 5,
    borderWidth: 3,
    borderColor: colors.amber,
  },
  fill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: radii.hold,
    overflow: 'hidden',
  },
  flash: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.paid,
  },
  disabled: {
    opacity: 0.45,
  },
  copy: {
    flex: 1,
    gap: 3,
  },
  label: {
    fontFamily: fonts.sansBold,
    fontSize: 17,
    lineHeight: 20,
    color: colors.bone,
  },
  hint: {
    fontFamily: fonts.sansSemibold,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
  },
  releaseHint: {
    fontFamily: fonts.sansSemibold,
    fontSize: 13,
    lineHeight: 18,
    color: colors.amber,
    textAlign: 'center',
  },
});
