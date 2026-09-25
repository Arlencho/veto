import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { Circle, Path, Svg } from 'react-native-svg';

import { colors, fonts, radii, space } from '../theme';
import { motionAllowed, useReducedMotion } from './motion';

export const HOLD_MS = 1200;
const RING_RADIUS = 20;
const RING = 2 * Math.PI * RING_RADIUS;

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

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
  const running = useRef<Animated.CompositeAnimation | null>(null);
  const holding = useRef(false);
  const confirmed = useRef(false);
  const [done, setDone] = useState(false);

  const [previousResetKey, setPreviousResetKey] = useState(resetKey);
  if (previousResetKey !== resetKey) {
    setPreviousResetKey(resetKey);
    setDone(false);
  }

  // A cancelled or failed signature must leave the button usable again.
  useEffect(() => {
    running.current?.stop();
    running.current = null;
    holding.current = false;
    confirmed.current = false;
    progress.setValue(0);
  }, [resetKey, progress]);

  function confirm() {
    if (disabled || confirmed.current) {
      return;
    }
    confirmed.current = true;
    holding.current = false;
    progress.setValue(1);
    setDone(true);
    onConfirm();
  }

  function onPressIn() {
    if (disabled || !motionOn || confirmed.current) {
      return;
    }
    holding.current = true;
    progress.setValue(0);
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: HOLD_MS,
      easing: Easing.linear,
      useNativeDriver: false,
    });
    running.current = anim;
    anim.start(({ finished }) => {
      if (finished && holding.current) {
        confirm();
      }
    });
  }

  function onPressOut() {
    holding.current = false;
    running.current?.stop();
    running.current = null;
    if (confirmed.current || !motionOn) {
      return;
    }
    Animated.timing(progress, {
      toValue: 0,
      duration: 160,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start();
  }

  const dashOffset = motionOn
    ? progress.interpolate({
        inputRange: [0, 1],
        outputRange: [RING, 0],
      })
    : done
      ? 0
      : RING;

  const gestureHint = motionOn
    ? 'Hold until the ring fills. Long press does the same thing.'
    : 'Long press to approve.';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${hint}`}
      accessibilityHint={gestureHint}
      accessibilityState={{ disabled }}
      accessibilityActions={[{ name: 'longpress', label: 'Approve' }]}
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
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Svg width={44} height={44} viewBox="0 0 52 52">
          <Circle cx={26} cy={26} r={RING_RADIUS} fill="none" stroke="rgba(15, 26, 22, 0.22)" strokeWidth={4} />
          <AnimatedCircle
            cx={26}
            cy={26}
            r={RING_RADIUS}
            fill="none"
            stroke={colors.forest}
            strokeWidth={4}
            strokeLinecap="round"
            strokeDasharray={`${RING} ${RING}`}
            strokeDashoffset={dashOffset}
            rotation={-90}
            origin="26, 26"
          />
          <Path d="M26 15l8 3v6c0 6-3.5 10-8 12-4.5-2-8-6-8-12v-6z" fill={colors.forest} />
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
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.hint}>{hint}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 64,
    borderRadius: radii.hold,
    backgroundColor: colors.brass,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xxl,
    paddingHorizontal: space.xxl,
    paddingVertical: space.lg,
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
    color: colors.forest,
  },
  hint: {
    fontFamily: fonts.sansSemibold,
    fontSize: 12,
    lineHeight: 16,
    color: colors.holdHint,
  },
});
