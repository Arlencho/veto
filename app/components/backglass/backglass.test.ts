import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test, mock } from 'node:test';

import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const motion = { reduced: false };

type Anim = {
  toValue: number;
  duration: number;
  start: (cb?: (result: { finished: boolean }) => void) => void;
  stop: () => void;
  _cb?: (result: { finished: boolean }) => void;
};

const timings: Anim[] = [];

function Host(type: string) {
  return function MockHost(props: { children?: ReactNode; style?: unknown } & Record<string, unknown>) {
    const style =
      typeof props.style === 'function'
        ? (props.style as (state: { pressed: boolean }) => unknown)({ pressed: false })
        : props.style;
    return createElement(type, { ...props, style }, props.children);
  };
}

function timing(value: { setValue: (next: number) => void }, config: { toValue: number; duration?: number }) {
  const anim: Anim = {
    toValue: config.toValue,
    duration: config.duration ?? 0,
    start(cb) {
      anim._cb = cb;
    },
    stop() {
      const cb = anim._cb;
      anim._cb = undefined;
      cb?.({ finished: false });
    },
  };
  void value;
  timings.push(anim);
  return anim;
}

function sequence(anims: Anim[]) {
  let stopped = false;
  return {
    start(cb?: (result: { finished: boolean }) => void) {
      let index = 0;
      const step = (result?: { finished: boolean }) => {
        if (stopped || result?.finished === false) {
          cb?.({ finished: false });
          return;
        }
        index += 1;
        if (index >= anims.length) {
          cb?.({ finished: true });
          return;
        }
        anims[index]?.start(step);
      };
      if (anims.length === 0) {
        cb?.({ finished: true });
        return;
      }
      anims[0]?.start(step);
    },
    stop() {
      stopped = true;
      for (const anim of anims) {
        anim.stop?.();
      }
    },
  };
}

class AnimatedValue {
  _value: number;
  constructor(value: number) {
    this._value = value;
  }
  setValue(value: number) {
    this._value = value;
  }
  interpolate(config: unknown) {
    return { __animated: 'interpolate', config, value: this };
  }
  stopAnimation(cb?: (value: number) => void) {
    cb?.(this._value);
  }
  addListener() {
    return 0;
  }
  removeListener() {}
}

mock.module('react-native', {
  namedExports: {
    AccessibilityInfo: {
      isReduceMotionEnabled: () => Promise.resolve(motion.reduced),
      addEventListener: () => ({ remove() {} }),
    },
    Animated: {
      Value: AnimatedValue,
      View: Host('Animated.View'),
      Text: Host('Animated.Text'),
      timing,
      delay: (ms: number) => timing(new AnimatedValue(0), { toValue: 0, duration: ms }),
      loop: (inner: Anim) => ({
        start() {
          inner.start?.();
        },
        stop() {
          inner.stop?.();
        },
      }),
      sequence,
      createAnimatedComponent: (Component: unknown) => Component,
    },
    Easing: {
      linear: (amount: number) => amount,
      cubic: (amount: number) => amount,
      out: (easing: (amount: number) => number) => easing,
      inOut: (easing: (amount: number) => number) => easing,
      bezier: () => (amount: number) => amount,
    },
    Linking: {
      openURL: () => Promise.resolve(),
    },
    Pressable: Host('Pressable'),
    ScrollView: Host('ScrollView'),
    StyleSheet: {
      create<T>(styles: T): T {
        return styles;
      },
      hairlineWidth: 1,
      absoluteFill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
    },
    Text: Host('Text'),
    View: Host('View'),
  },
});

mock.module('react-native-svg', {
  namedExports: {
    Svg: Host('Svg'),
    Path: Host('Path'),
    Circle: Host('Circle'),
    Rect: Host('Rect'),
    G: Host('G'),
    Text: Host('Text'),
    Defs: Host('Defs'),
    LinearGradient: Host('LinearGradient'),
    Stop: Host('Stop'),
  },
});

const haptics: string[] = [];

mock.module('expo-haptics', {
  namedExports: {
    ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
    NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
    impactAsync: async (style: string) => {
      haptics.push(`impact:${style}`);
    },
    selectionAsync: async () => {
      haptics.push('selection');
    },
    notificationAsync: async (kind: string) => {
      haptics.push(`notification:${kind}`);
    },
  },
});

function flatStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map((item) => flatStyle(item)));
  }
  if (style && typeof style === 'object') {
    return style as Record<string, unknown>;
  }
  return {};
}

function textOf(node: ReactTestInstance): string {
  const bits: string[] = [];
  const walk = (child: unknown) => {
    if (typeof child === 'string' || typeof child === 'number') {
      bits.push(String(child));
      return;
    }
    if (Array.isArray(child)) {
      for (const item of child) {
        walk(item);
      }
    }
  };
  walk(node.props.children);
  return bits.join('');
}

function isHost(node: ReactTestInstance, type: string): boolean {
  return (node.type as unknown) === type;
}

function hostOf(scope: { findAll(predicate: (node: ReactTestInstance) => boolean): ReactTestInstance[] }, type: string): ReactTestInstance {
  const found = scope.findAll((node) => isHost(node, type));
  assert.ok(found[0], `missing ${type}`);
  return found[0];
}

function visibleText(root: ReactTestRenderer): string {
  return root.root
    .findAll((node) => isHost(node, 'Text'))
    .map((node) => textOf(node))
    .filter((line) => line.length > 0)
    .join('\n');
}

function countPrefixed(root: ReactTestRenderer, prefix: string): number {
  const ids = new Set<string>();
  for (const node of root.root.findAll((candidate) => String(candidate.props.testID ?? '').startsWith(prefix))) {
    ids.add(String(node.props.testID));
  }
  return ids.size;
}

function byLabel(root: ReactTestRenderer, label: string): ReactTestInstance {
  const found = root.root.findAll((node) => node.props.accessibilityLabel === label);
  assert.ok(found[0], `missing accessibility label ${label}`);
  return found[0];
}

async function mount(node: ReactElement): Promise<ReactTestRenderer> {
  timings.length = 0;
  let root: ReactTestRenderer | null = null;
  await act(async () => {
    root = create(node);
  });
  await act(async () => {
    await Promise.resolve();
  });
  assert.ok(root);
  return root;
}

function translateY(node: ReactTestInstance): unknown {
  const transform = flatStyle(node.props.style).transform;
  if (!Array.isArray(transform)) {
    return undefined;
  }
  const row = transform.find(
    (item) => item && typeof item === 'object' && 'translateY' in (item as Record<string, unknown>),
  ) as { translateY?: unknown } | undefined;
  return row?.translateY;
}

describe('backglass components', { concurrency: 1 }, () => {
  test('the color Catch mark draws the brass V and the amber ball from the master file', async () => {
    const svg = readFileSync(new URL('../../assets/brand/catch-mark.svg', import.meta.url), 'utf8');
    assert.match(svg, /M16 14L50 80L84 14/);
    assert.match(svg, /cy="37\.4"/);
    const { CatchMark } = await import('./CatchMark');
    motion.reduced = false;
    const root = await mount(createElement(CatchMark, { size: 48 }));
    const path = hostOf(root.root, 'Path');
    const ball = hostOf(root.root, 'Circle');
    const frame = hostOf(root.root, 'Svg');
    assert.equal(path.props.d, 'M16 14L50 80L84 14');
    assert.equal(path.props.stroke, '#C9A24D');
    assert.equal(ball.props.cy, 37.4);
    assert.equal(ball.props.fill, '#E3C77E');
    assert.equal(ball.props.stroke, '#7E5E14');
    assert.equal(ball.props.strokeWidth, 2);
    assert.equal(frame.props.width, 48);
    assert.equal(frame.props.height, 48);
    assert.equal(frame.props.accessibilityLabel, 'Veto Catch mark');
  });

  test('the one color Catch marks are open rings, bone on dark and forest on light', async () => {
    const bone = readFileSync(new URL('../../assets/brand/catch-mark-bone.svg', import.meta.url), 'utf8');
    const forest = readFileSync(new URL('../../assets/brand/catch-mark-forest.svg', import.meta.url), 'utf8');
    assert.match(bone, /stroke-width="4\.5"/);
    assert.match(forest, /stroke-width="4\.5"/);
    const { CatchMark } = await import('./CatchMark');
    for (const reduced of [false, true]) {
      motion.reduced = reduced;
      const boneMark = await mount(createElement(CatchMark, { variant: 'bone' }));
      const forestMark = await mount(createElement(CatchMark, { variant: 'forest' }));
      const boneBall = hostOf(boneMark.root, 'Circle');
      const forestBall = hostOf(forestMark.root, 'Circle');
      assert.equal(boneBall.props.fill, 'none');
      assert.equal(boneBall.props.stroke, '#EDE6D6');
      assert.equal(boneBall.props.strokeWidth, 4.5);
      assert.equal(hostOf(boneMark.root, 'Svg').props.accessibilityLabel, 'Veto Catch mark, bone');
      assert.equal(hostOf(boneMark.root, 'Svg').props.width, 24);
      assert.equal(forestBall.props.fill, 'none');
      assert.equal(forestBall.props.stroke, '#0F1A16');
      assert.equal(forestBall.props.strokeWidth, 4.5);
      assert.equal(hostOf(forestMark.root, 'Svg').props.accessibilityLabel, 'Veto Catch mark, forest');
    }
  });

  test('a lamp that is off stays dim, and a lamp that is on shows the amber decision color', async () => {
    const { Lamp } = await import('./Lamp');
    for (const reduced of [false, true]) {
      motion.reduced = reduced;
      const off = await mount(createElement(Lamp, { state: 'off' }));
      const on = await mount(createElement(Lamp, { state: 'on' }));
      assert.equal(flatStyle(byLabel(off, 'Lamp off').props.style).backgroundColor, 'rgba(201, 162, 77, 0.18)');
      assert.equal(flatStyle(byLabel(on, 'Lamp on').props.style).backgroundColor, '#E3C77E');
    }
  });

  test('a pulsing lamp keeps moving when motion is allowed and settles on brass when it is reduced', async () => {
    const { Lamp } = await import('./Lamp');
    motion.reduced = false;
    const moving = await mount(createElement(Lamp, { state: 'pulse' }));
    const movingColor = flatStyle(byLabel(moving, 'Lamp pulsing').props.style).backgroundColor;
    assert.equal(typeof movingColor, 'object');
    motion.reduced = true;
    const still = await mount(createElement(Lamp, { state: 'pulse' }));
    assert.equal(flatStyle(byLabel(still, 'Lamp pulsing').props.style).backgroundColor, '#C9A24D');
  });

  test('the brass frame can show the ten chase lamps and can leave them off', async () => {
    const { BrassFrame } = await import('./BrassFrame');
    motion.reduced = true;
    const chase = await mount(
      createElement(BrassFrame, { chase: true }, createElement('Text', null, 'Inside the cabinet')),
    );
    const quiet = await mount(
      createElement(BrassFrame, null, createElement('Text', null, 'Inside the cabinet')),
    );
    assert.equal(visibleText(chase).includes('Inside the cabinet'), true);
    assert.equal(countPrefixed(chase, 'chase-lamp-'), 10);
    assert.equal(countPrefixed(quiet, 'chase-lamp-'), 0);
  });

  test('a score reel names its value and is already there when reduced motion is on', async () => {
    const { ScoreReel, REEL_HEIGHT } = await import('./ScoreReel');
    motion.reduced = true;
    const root = await mount(createElement(ScoreReel, { value: 12, tone: 'amber', accessibilityLabel: '12 refusals' }));
    assert.equal(byLabel(root, '12 refusals').props.accessibilityLabel, '12 refusals');
    const ones = hostOf(root.root.findByProps({ testID: 'score-digit-1' }), 'Animated.View');
    assert.equal(translateY(ones), -2 * REEL_HEIGHT);
    const tens = hostOf(root.root.findByProps({ testID: 'score-digit-0' }), 'Animated.View');
    assert.equal(translateY(tens), -1 * REEL_HEIGHT);
  });

  test('a score reel starts at zero and rolls when reduced motion is off', async () => {
    const { ScoreReel } = await import('./ScoreReel');
    motion.reduced = false;
    const root = await mount(createElement(ScoreReel, { value: 12 }));
    assert.equal(byLabel(root, '12').props.accessibilityLabel, '12');
    const ones = translateY(hostOf(root.root.findByProps({ testID: 'score-digit-1' }), 'Animated.View'));
    assert.equal(typeof ones, 'object');
    assert.equal((ones as { _value: number })._value, 0);
  });

  test('the block bar lights 258 of 300 as 25 blocks and one block at eight tenths', async () => {
    const { BlockBar } = await import('./BlockBar');
    for (const reduced of [false, true]) {
      motion.reduced = reduced;
      const root = await mount(createElement(BlockBar, { remaining: 258, cap: 300 }));
      assert.equal(root.root.findByProps({ accessibilityRole: 'progressbar' }).props.accessibilityLabel, '258 remaining of 300');
      assert.equal(flatStyle(root.root.findByProps({ testID: 'block-fill-24' }).props.style).width, '100%');
      assert.equal(flatStyle(root.root.findByProps({ testID: 'block-fill-25' }).props.style).width, '80%');
      assert.equal(flatStyle(root.root.findByProps({ testID: 'block-fill-26' }).props.style).width, '0%');
      assert.equal(countPrefixed(root, 'block-fill-'), 30);
    }
  });

  test('the block bar is fully revealed when reduced motion is on and covered until the reveal runs', async () => {
    const { BlockBar } = await import('./BlockBar');
    motion.reduced = true;
    const still = await mount(createElement(BlockBar, { remaining: 0, cap: 300 }));
    assert.equal(countPrefixed(still, 'block-cover'), 0);
    assert.equal(flatStyle(still.root.findByProps({ testID: 'block-fill-0' }).props.style).width, '0%');
    motion.reduced = false;
    const moving = await mount(createElement(BlockBar, { remaining: 300, cap: 300 }));
    assert.equal(countPrefixed(moving, 'block-cover'), 1);
    assert.equal(flatStyle(moving.root.findByProps({ testID: 'block-fill-29' }).props.style).width, '100%');
  });

  test('the first-run strip names the current step and the steps already done', async () => {
    const { ProgressStrip } = await import('./ProgressStrip');
    for (const reduced of [false, true]) {
      motion.reduced = reduced;
      const root = await mount(
        createElement(ProgressStrip, { current: 'approve', done: ['learn', 'connect', 'agent'] }),
      );
      assert.equal(
        root.root.findByProps({ accessibilityRole: 'list' }).props.accessibilityLabel,
        'Your setup: step 4 of 5, Approve the rule',
      );
      assert.ok(root.root.findByProps({ accessibilityLabel: 'Learn, done' }));
      assert.ok(root.root.findByProps({ accessibilityLabel: 'Connect wallet, done' }));
      assert.ok(root.root.findByProps({ accessibilityLabel: 'Add your agent, done' }));
      assert.ok(root.root.findByProps({ accessibilityLabel: 'Approve the rule, current step' }));
      assert.ok(root.root.findByProps({ accessibilityLabel: 'Live, not yet' }));
      assert.match(visibleText(root), /Learn/);
      assert.match(visibleText(root), /Live/);
      assert.equal(flatStyle(root.root.findByProps({ testID: 'stage-bar-learn' }).props.style).backgroundColor, '#C9A24D');
      assert.equal(
        flatStyle(root.root.findByProps({ testID: 'stage-bar-live' }).props.style).backgroundColor,
        'rgba(237, 230, 214, 0.14)',
      );
      const stage = root.root.findByProps({ accessibilityLabel: 'Learn, done' });
      assert.ok(Number(flatStyle(stage.props.style).minHeight) >= 44);
    }
  });

  test('the machine diagram names the lit stations and holds them still when reduced motion is on', async () => {
    const { MachineDiagram } = await import('./MachineDiagram');
    motion.reduced = true;
    const still = await mount(createElement(MachineDiagram, { litStations: ['you', 'rule'] }));
    const stillLabel = hostOf(still.root, 'Svg').props.accessibilityLabel as string;
    assert.match(stillLabel, /Lit stations: You, The rule/);
    assert.equal(stillLabel.includes('Your agent'), false);
    assert.equal(still.root.findByProps({ testID: 'station-you' }).props.opacity, 1);
    assert.equal(still.root.findByProps({ testID: 'station-rule' }).props.opacity, 1);
    assert.equal(still.root.findByProps({ testID: 'station-agent' }).props.opacity, 0.38);
    assert.equal(countPrefixed(still, 'machine-ball'), 0);

    motion.reduced = false;
    const moving = await mount(createElement(MachineDiagram, { litStations: ['you', 'rule'] }));
    assert.equal(moving.root.findByProps({ testID: 'station-you' }).props.opacity, 0.38);
    assert.equal(moving.root.findByProps({ testID: 'station-agent' }).props.opacity, 0.38);
    assert.equal(countPrefixed(moving, 'machine-ball'), 1);
  });

  test('the tilt stamp reads Tilt and the reason, and sits still when reduced motion is on', async () => {
    const { TiltStamp } = await import('./TiltStamp');
    motion.reduced = true;
    const still = await mount(createElement(TiltStamp, null));
    assert.match(visibleText(still), /Tilt/);
    assert.match(visibleText(still), /Refused: over your limit/);
    assert.equal(byLabel(still, 'Tilt. Refused: over your limit').props.accessibilityLabel, 'Tilt. Refused: over your limit');
    const stillShift = (flatStyle(byLabel(still, 'Tilt. Refused: over your limit').props.style).transform as { translateX: unknown }[])[0];
    assert.equal(stillShift?.translateX, 0);

    motion.reduced = false;
    const moving = await mount(createElement(TiltStamp, { reason: 'Refused: rule not active' }));
    assert.match(visibleText(moving), /Refused: rule not active/);
    const movingShift = (
      flatStyle(byLabel(moving, 'Tilt. Refused: rule not active').props.style).transform as { translateX: unknown }[]
    )[0];
    assert.equal(typeof movingShift?.translateX, 'object');
  });

  test('holding through the ring confirms the rule, and letting go early does not', async () => {
    const { HoldToApprove, HOLD_MS } = await import('./HoldToApprove');
    motion.reduced = false;
    let confirmed = 0;
    const root = await mount(createElement(HoldToApprove, { onConfirm: () => { confirmed += 1; } }));
    const button = hostOf(root.root, 'Pressable');
    assert.match(String(button.props.accessibilityHint), /Long press/);
    assert.ok(Number(flatStyle(button.props.style).minHeight) >= 44);
    await act(async () => {
      button.props.onPressIn();
      button.props.onPressOut();
    });
    assert.equal(confirmed, 0);

    await act(async () => {
      button.props.onPressIn();
    });
    const fill = [...timings].reverse().find((anim) => anim.toValue === 1 && anim.duration === HOLD_MS);
    assert.ok(fill);
    await act(async () => {
      fill?._cb?.({ finished: true });
    });
    assert.equal(confirmed, 1);
    assert.match(visibleText(root), /Hold to approve rule/);
    assert.match(visibleText(root), /You sign on this phone/);
  });

  test('reduced motion confirms with a long press and says so', async () => {
    const { HoldToApprove } = await import('./HoldToApprove');
    motion.reduced = true;
    let confirmed = 0;
    const root = await mount(createElement(HoldToApprove, { onConfirm: () => { confirmed += 1; } }));
    const button = hostOf(root.root, 'Pressable');
    assert.match(String(button.props.accessibilityHint), /Long press to approve/);
    const ring = root.root.findAll((node) => isHost(node, 'Circle') && node.props.strokeDasharray)[0];
    assert.equal(typeof ring?.props.strokeDashoffset, 'number');
    assert.ok(Number(ring?.props.strokeDashoffset) > 0);
    await act(async () => {
      button.props.onPressIn();
    });
    assert.equal(confirmed, 0);
    await act(async () => {
      button.props.onLongPress();
    });
    assert.equal(confirmed, 1);
    const filled = root.root.findAll((node) => isHost(node, 'Circle') && node.props.strokeDasharray)[0];
    assert.equal(filled?.props.strokeDashoffset, 0);
    await act(async () => {
      button.props.onAccessibilityAction({ nativeEvent: { actionName: 'longpress' } });
    });
    assert.equal(confirmed, 1);
  });

  test('a new reset key arms the button again after a cancelled or failed signature', async () => {
    const { HoldToApprove } = await import('./HoldToApprove');
    motion.reduced = true;
    let confirmed = 0;
    const onConfirm = () => { confirmed += 1; };
    const root = await mount(createElement(HoldToApprove, { onConfirm, resetKey: 0 }));
    await act(async () => {
      hostOf(root.root, 'Pressable').props.onLongPress();
    });
    assert.equal(confirmed, 1);
    await act(async () => {
      hostOf(root.root, 'Pressable').props.onLongPress();
    });
    assert.equal(confirmed, 1, 'a confirmed button ignores a second press');
    await act(async () => {
      root.update(createElement(HoldToApprove, { onConfirm, resetKey: 1 }));
    });
    const ring = root.root.findAll((node) => isHost(node, 'Circle') && node.props.strokeDasharray)[0];
    assert.ok(Number(ring?.props.strokeDashoffset) > 0, 'the ring is empty again');
    await act(async () => {
      hostOf(root.root, 'Pressable').props.onLongPress();
    });
    assert.equal(confirmed, 2);
  });

  test('pressing in starts the ring at once with a light haptic, a glow, and the fill colour', async () => {
    const { HoldToApprove, HOLD_MS } = await import('./HoldToApprove');
    const { hapticsSettled } = await import('./haptics');
    const { colors } = await import('../theme');
    motion.reduced = false;
    haptics.length = 0;
    const root = await mount(createElement(HoldToApprove, { onConfirm: () => undefined }));
    const idleFill = flatStyle(root.root.findByProps({ testID: 'hold-fill' }).props.style);
    const idleRange = (idleFill.backgroundColor as { config: { outputRange: string[] } }).config.outputRange;
    assert.deepEqual(idleRange, [colors.surface, colors.brass], 'the fill runs from the dark surface to brass');
    await act(async () => {
      hostOf(root.root, 'Pressable').props.onPressIn();
    });
    await hapticsSettled();
    assert.deepEqual(haptics, ['impact:light']);
    assert.ok(timings.some((anim) => anim.toValue === 1 && anim.duration === HOLD_MS), 'the ring starts filling');
    assert.ok(timings.some((anim) => anim.toValue === 1 && anim.duration < HOLD_MS), 'the glow comes up');
    const ring = root.root.findAll((node) => isHost(node, 'Circle') && node.props.strokeDasharray)[0];
    assert.equal(typeof ring?.props.strokeDashoffset, 'object', 'the ring and the fill share one animated value');
  });

  test('a full hold ticks at a quarter, half and three quarters, then confirms with a success haptic and a flash', async () => {
    const { HoldToApprove, HOLD_MS } = await import('./HoldToApprove');
    const { hapticsSettled } = await import('./haptics');
    motion.reduced = false;
    haptics.length = 0;
    let confirmed = 0;
    const root = await mount(createElement(HoldToApprove, { onConfirm: () => { confirmed += 1; } }));
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await act(async () => {
        hostOf(root.root, 'Pressable').props.onPressIn();
      });
      const fill = [...timings].reverse().find((anim) => anim.toValue === 1 && anim.duration === HOLD_MS);
      assert.ok(fill);
      mock.timers.tick(HOLD_MS * 0.25);
      await hapticsSettled();
      assert.deepEqual(haptics, ['impact:light', 'selection']);
      mock.timers.tick(HOLD_MS * 0.5);
      await hapticsSettled();
      assert.deepEqual(haptics, ['impact:light', 'selection', 'selection', 'selection']);
      assert.equal(confirmed, 0);
      const before = timings.length;
      await act(async () => {
        fill?._cb?.({ finished: true });
      });
      await hapticsSettled();
      assert.equal(confirmed, 1, 'the wallet prompt opens as before');
      assert.deepEqual(haptics.slice(-1), ['notification:success']);
      assert.equal(haptics.filter((item) => item === 'selection').length, 3);
      assert.ok(timings.slice(before).some((anim) => anim.toValue === 1 && anim.duration === 90), 'the success colour flashes');
      assert.ok(root.root.findAllByProps({ testID: 'hold-flash' }).length > 0);
    } finally {
      mock.timers.reset();
    }
  });

  test('letting go early drains the colour, stops the ticks, and shows the hint for a few seconds', async () => {
    const { HoldToApprove, HOLD_MS, RELEASE_HINT, RELEASE_HINT_MS } = await import('./HoldToApprove');
    const { hapticsSettled } = await import('./haptics');
    motion.reduced = false;
    haptics.length = 0;
    let confirmed = 0;
    const root = await mount(createElement(HoldToApprove, { onConfirm: () => { confirmed += 1; } }));
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      assert.doesNotMatch(visibleText(root), /Press and hold until the ring fills/);
      await act(async () => {
        hostOf(root.root, 'Pressable').props.onPressIn();
      });
      mock.timers.tick(HOLD_MS * 0.3);
      const before = timings.length;
      await act(async () => {
        hostOf(root.root, 'Pressable').props.onPressOut();
      });
      assert.ok(
        timings.slice(before).some((anim) => anim.toValue === 0 && anim.duration > 0 && anim.duration < HOLD_MS),
        'the colour drains back',
      );
      assert.match(visibleText(root), new RegExp(RELEASE_HINT));
      mock.timers.tick(HOLD_MS);
      await hapticsSettled();
      assert.deepEqual(haptics, ['impact:light', 'selection'], 'no tick after the release');
      assert.equal(confirmed, 0);
      await act(async () => {
        mock.timers.tick(RELEASE_HINT_MS);
      });
      assert.doesNotMatch(visibleText(root), new RegExp(RELEASE_HINT));
    } finally {
      mock.timers.reset();
    }
  });

  test('reduced motion still changes colour on press, without a pulse or a flash', async () => {
    const { HoldToApprove, HOLD_MS, RELEASE_HINT } = await import('./HoldToApprove');
    const { hapticsSettled } = await import('./haptics');
    const { colors } = await import('../theme');
    motion.reduced = true;
    haptics.length = 0;
    let confirmed = 0;
    const root = await mount(createElement(HoldToApprove, { onConfirm: () => { confirmed += 1; } }));
    const fillColor = () => flatStyle(root.root.findByProps({ testID: 'hold-fill' }).props.style).backgroundColor;
    assert.equal(fillColor(), colors.surface);
    await act(async () => {
      hostOf(root.root, 'Pressable').props.onPressIn();
    });
    await hapticsSettled();
    assert.deepEqual(haptics, ['impact:light']);
    assert.equal(fillColor(), colors.brass, 'the colour changes in one step');
    assert.equal(timings.length, 0, 'nothing animates');
    await act(async () => {
      hostOf(root.root, 'Pressable').props.onPressOut();
    });
    assert.equal(fillColor(), colors.surface);
    assert.match(visibleText(root), new RegExp(RELEASE_HINT));
    await act(async () => {
      hostOf(root.root, 'Pressable').props.onPressIn();
    });
    await act(async () => {
      hostOf(root.root, 'Pressable').props.onLongPress();
    });
    await hapticsSettled();
    assert.equal(confirmed, 1);
    assert.equal(haptics.at(-1), 'notification:success');
    assert.equal(fillColor(), colors.brass);
    assert.equal(root.root.findAllByProps({ testID: 'hold-flash' }).length, 0, 'no flash');
    assert.ok(!timings.some((anim) => anim.duration === HOLD_MS || anim.duration === 90));
    assert.doesNotMatch(visibleText(root), new RegExp(RELEASE_HINT));
  });

  test('the accessibility action completes the hold and is named for what it does', async () => {
    const { HoldToApprove, HOLD_A11Y_ACTION } = await import('./HoldToApprove');
    motion.reduced = false;
    let confirmed = 0;
    const root = await mount(createElement(HoldToApprove, { onConfirm: () => { confirmed += 1; } }));
    const button = hostOf(root.root, 'Pressable');
    assert.equal(HOLD_A11Y_ACTION, 'Press and hold to sign');
    assert.deepEqual(button.props.accessibilityActions, [{ name: 'longpress', label: 'Press and hold to sign' }]);
    assert.match(String(button.props.accessibilityHint), /^Press and hold to sign/);
    await act(async () => {
      button.props.onAccessibilityAction({ nativeEvent: { actionName: 'longpress' } });
    });
    assert.equal(confirmed, 1);
  });

  test('the seal row offers a link to the record', async () => {
    const { SealRow } = await import('./SealRow');
    for (const reduced of [false, true]) {
      motion.reduced = reduced;
      let opened = 0;
      const root = await mount(
        createElement(SealRow, {
          text: 'This refusal is saved on the blockchain with its reason. Anyone can check it.',
          onPress: () => {
            opened += 1;
          },
        }),
      );
      assert.match(visibleText(root), /saved on the blockchain/);
      const link = root.root.findByProps({ accessibilityRole: 'link' });
      assert.equal(link.props.accessibilityLabel, 'See it');
      assert.ok(Number(flatStyle(link.props.style).minHeight) >= 44);
      await act(async () => {
        link.props.onPress();
      });
      assert.equal(opened, 1);
    }
  });

  test('an earned plaque can be shared and a pending plaque says it is not yet', async () => {
    const { Plaque } = await import('./Plaque');
    motion.reduced = true;
    let shares = 0;
    const earned = await mount(
      createElement(Plaque, {
        date: 'Day 1, Sun 20 Sep',
        title: 'First payment inside the rule',
        detail: 'Paid 8. Limit per payment: 10.',
        onShare: () => {
          shares += 1;
        },
      }),
    );
    assert.match(visibleText(earned), /First payment inside the rule/);
    const share = earned.root.findByProps({ accessibilityLabel: 'Share this plaque' });
    assert.equal(flatStyle(share.props.style).width, 44);
    assert.equal(flatStyle(share.props.style).height, 44);
    await act(async () => {
      share.props.onPress();
    });
    assert.equal(shares, 1);
    const pending = await mount(
      createElement(Plaque, {
        earned: false,
        date: 'Not yet: day 90',
        title: 'Rule finished, rest returned',
        detail: 'Engraved if the rule runs to its end.',
        onShare: () => {
          shares += 1;
        },
      }),
    );
    const pendingPlate = pending.root.findByProps({
      accessibilityLabel: 'Not yet: Rule finished, rest returned. Engraved if the rule runs to its end.',
    });
    assert.ok(pendingPlate);
    assert.equal(
      new Set(
        pending.root
          .findAll((node) => node.props.accessibilityLabel === 'Share this plaque')
          .map((node) => node.props.accessibilityLabel),
      ).size,
      0,
    );
    assert.equal(shares, 1);
    assert.equal(flatStyle(pendingPlate.props.style).opacity, 1);

    motion.reduced = false;
    const moving = await mount(
      createElement(Plaque, {
        date: 'Day 2',
        title: 'First refusal saved',
        detail: 'Nothing moved.',
      }),
    );
    const plate = moving.root.findByProps({
      accessibilityLabel: 'Day 2. First refusal saved. Nothing moved.',
    });
    assert.equal(typeof flatStyle(plate.props.style).opacity, 'object');
  });

  test('a stat tile reads its value and what that value is', async () => {
    const { StatTile } = await import('./StatTile');
    for (const reduced of [false, true]) {
      motion.reduced = reduced;
      const root = await mount(
        createElement(StatTile, {
          value: '61',
          label: 'payments paid, all within the rule',
          valueColor: '#9CC9A8',
        }),
      );
      assert.equal(
        root.root.findByProps({ accessibilityLabel: '61, payments paid, all within the rule' }).props.accessibilityLabel,
        '61, payments paid, all within the rule',
      );
      assert.match(visibleText(root), /61/);
      assert.match(visibleText(root), /payments paid, all within the rule/);
      const tile = root.root.findByProps({ accessibilityLabel: '61, payments paid, all within the rule' });
      assert.ok(Number(flatStyle(tile.props.style).minHeight) >= 44);
    }
  });

  test('a pill shows whether it is selected and keeps a 44 point target', async () => {
    const { Pill } = await import('./Pill');
    for (const reduced of [false, true]) {
      motion.reduced = reduced;
      let presses = 0;
      const root = await mount(
        createElement(Pill, {
          label: 'Refused',
          dot: '#E4A48E',
          selected: reduced,
          onPress: () => {
            presses += 1;
          },
        }),
      );
      const pill = hostOf(root.root, 'Pressable');
      assert.equal(pill.props.accessibilityLabel, 'Refused');
      assert.equal(pill.props.accessibilityState.selected, reduced);
      assert.ok(Number(flatStyle(pill.props.style).minHeight) >= 44);
      assert.match(visibleText(root), /Refused/);
      await act(async () => {
        pill.props.onPress();
      });
      assert.equal(presses, 1);
    }
  });

  test('the tab bar marks the open tab and each tab is at least 44 points', async () => {
    const { TabBar } = await import('./TabBar');
    for (const reduced of [false, true]) {
      motion.reduced = reduced;
      let next = '';
      const root = await mount(
        createElement(TabBar, {
          active: 'home',
          onChange: (tab: string) => {
            next = tab;
          },
        }),
      );
      const tabs = root.root.findAll(
        (node) => isHost(node, 'Pressable') && node.props.accessibilityRole === 'tab',
      );
      assert.equal(tabs.length, 3);
      assert.equal(tabs[0]?.props.accessibilityLabel, 'Home');
      assert.equal(tabs[0]?.props.accessibilityState.selected, true);
      assert.equal(tabs[1]?.props.accessibilityState.selected, false);
      assert.equal(tabs[2]?.props.accessibilityLabel, 'Decisions');
      for (const tab of tabs) {
        assert.ok(Number(flatStyle(tab.props.style).minHeight) >= 44);
      }
      assert.match(visibleText(root), /Home/);
      assert.match(visibleText(root), /Rules/);
      await act(async () => {
        tabs[1]?.props.onPress();
      });
      assert.equal(next, 'rules');
      const homeLabel = tabs[0] ? hostOf(tabs[0], 'Text') : undefined;
      assert.equal(flatStyle(homeLabel?.props.style).color, '#C9A24D');
    }
  });

  test('the design kit renders every backglass component', async () => {
    motion.reduced = true;
    const screen = await import('../../app/design-kit');
    const root = await mount(createElement(screen.default));
    const text = visibleText(root);
    const hasLabel = (label: string) =>
      root.root.findAll((node) => node.props.accessibilityLabel === label).length > 0;
    assert.match(text, /Design kit/);
    assert.match(text, /veto:\/\/design-kit/);
    assert.equal(hasLabel('Veto Catch mark'), true);
    assert.equal(hasLabel('Veto Catch mark, bone'), true);
    assert.equal(hasLabel('Veto Catch mark, forest'), true);
    assert.equal(hasLabel('Lamp off'), true);
    assert.equal(hasLabel('Lamp on'), true);
    assert.equal(hasLabel('Lamp pulsing'), true);
    assert.equal(hasLabel('12 refusals'), true);
    assert.equal(hasLabel('258 remaining of 300'), true);
    assert.equal(hasLabel('Your setup: step 1 of 5, Learn'), true);
    assert.equal(hasLabel('Your setup: step 5 of 5, Live'), true);
    assert.match(
      String(root.root.findAll((node) => isHost(node, 'Svg') && String(node.props.accessibilityLabel ?? '').includes('Lit stations: You, Your agent'))[0]?.props.accessibilityLabel),
      /You, Your agent/,
    );
    assert.match(text, /Tilt/);
    assert.match(text, /Hold to approve rule/);
    assert.match(text, /See it/);
    assert.match(text, /First payment inside the rule/);
    assert.equal(hasLabel('Share this plaque'), true);
    assert.match(
      String(
        root.root.findAll((node) =>
          String(node.props.accessibilityLabel ?? '').startsWith('Not yet:'),
        )[0]?.props.accessibilityLabel,
      ),
      /Not yet:/,
    );
    assert.equal(hasLabel('61, payments paid, all within the rule'), true);
    assert.match(text, /Refused/);
    assert.equal(root.root.findAll((node) => node.props.accessibilityRole === 'tablist').length > 0, true);
    assert.match(text, /Home/);
  });
});
