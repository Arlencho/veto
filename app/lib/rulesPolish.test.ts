import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Keypair } from '@solana/web3.js';
import { act, createElement, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { STATUS_ACTIVE } from './constants';
import type { MandateAccount } from './mandate';
import { ruleCardTimeLeft, rulesHeading } from './ruleView';
import { VTEST_MINT } from './tokens';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Host(type: string) {
  return function MockHost(props: { children?: ReactNode; style?: unknown } & Record<string, unknown>) {
    const style =
      typeof props.style === 'function'
        ? (props.style as (state: { pressed: boolean }) => unknown)({ pressed: false })
        : props.style;
    return createElement(type, { ...props, style }, props.children);
  };
}

class AnimatedValue {
  setValue(_value: number) {}
  interpolate() {
    return 0;
  }
}

const animation = { start() {}, stop() {} };

mock.module('react-native', {
  namedExports: {
    AccessibilityInfo: {
      isReduceMotionEnabled: async () => true,
      addEventListener: () => ({ remove() {} }),
    },
    Animated: {
      Value: AnimatedValue,
      View: Host('Animated.View'),
      Text: Host('Animated.Text'),
      timing: () => animation,
      sequence: () => animation,
      loop: () => animation,
      delay: () => animation,
    },
    Easing: {
      bezier: () => () => 0,
      linear: (value: number) => value,
      cubic: (value: number) => value,
      out: (fn: unknown) => fn,
      in: (fn: unknown) => fn,
      inOut: (fn: unknown) => fn,
    },
    Pressable: Host('Pressable'),
    StyleSheet: {
      create<T>(styles: T): T {
        return styles;
      },
      hairlineWidth: 1,
      absoluteFill: {},
    },
    Text: Host('Text'),
    View: Host('View'),
  },
});

mock.module('react-native-svg', {
  namedExports: {
    Circle: Host('Circle'),
    Defs: Host('Defs'),
    G: Host('G'),
    Line: Host('Line'),
    LinearGradient: Host('LinearGradient'),
    Path: Host('Path'),
    Rect: Host('Rect'),
    Stop: Host('Stop'),
    Svg: Host('Svg'),
  },
});

const DAY = 86400n;
const HOUR = 3600n;
const NOW = 1_800_000_000n;
const SHARED_AGENT = Keypair.generate().publicKey.toBase58();

function mandate(over: Partial<MandateAccount> = {}): MandateAccount {
  return {
    address: Keypair.generate().publicKey.toBase58(),
    owner: Keypair.generate().publicKey.toBase58(),
    agent: SHARED_AGENT,
    mint: VTEST_MINT,
    source: Keypair.generate().publicKey.toBase58(),
    merchant: Keypair.generate().publicKey.toBase58(),
    mandateId: 1n,
    cap: 100_000_000n,
    spent: 0n,
    perTxMax: 10_000_000n,
    expiresAt: NOW + 40n * DAY,
    overrideAmount: 0n,
    overrideNonce: 0n,
    lastNonce: 0n,
    purpose: 'Charging top-ups',
    status: STATUS_ACTIVE,
    spendCount: 0,
    refusalCount: 0,
    bump: 1,
    ...over,
  };
}

test('two rules with the same agent key read as one agent', () => {
  assert.equal(rulesHeading([mandate(), mandate()]), '2 rules, 1 agent.');
});

test('two rules with different agent keys read as two agents', () => {
  const other = Keypair.generate().publicKey.toBase58();
  assert.equal(rulesHeading([mandate(), mandate({ agent: other })]), '2 rules, 2 agents.');
});

test('three rules over two agents count each agent key once', () => {
  const other = Keypair.generate().publicKey.toBase58();
  assert.equal(rulesHeading([mandate(), mandate(), mandate({ agent: other })]), '3 rules, 2 agents.');
});

test('no rules and one rule keep their plain headings', () => {
  assert.equal(rulesHeading([]), 'No rules yet.');
  assert.equal(rulesHeading([mandate()]), 'One rule, one agent.');
});

test('a rule card says the days left once, in words', () => {
  assert.equal(ruleCardTimeLeft(NOW + 39n * DAY + 22n * HOUR, NOW), '39 days left');
  assert.equal(ruleCardTimeLeft(NOW + 1n * DAY + 3n * HOUR, NOW), '1 day left');
});

test('on the last day a rule card says the hours left', () => {
  assert.equal(ruleCardTimeLeft(NOW + 22n * HOUR + 10n * 60n, NOW), '22 hours left');
  assert.equal(ruleCardTimeLeft(NOW + 1n * HOUR + 5n, NOW), '1 hour left');
});

test('an ended rule card says Ended', () => {
  assert.equal(ruleCardTimeLeft(NOW, NOW), 'Ended');
  assert.equal(ruleCardTimeLeft(NOW - DAY, NOW), 'Ended');
});

function isHost(node: ReactTestInstance, type: string): boolean {
  return (node.type as unknown) === type;
}

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textOf(child)))
    .join('');
}

function hostParent(node: ReactTestInstance): ReactTestInstance | null {
  let up = node.parent;
  while (up && typeof up.type !== 'string') {
    up = up.parent;
  }
  return up;
}

function flatStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map(flatStyle));
  }
  return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
}

async function renderCard(row: MandateAccount): Promise<ReactTestRenderer> {
  const { RuleListItem } = await import('../components/RuleListItem');
  let root: ReactTestRenderer | null = null;
  await act(async () => {
    root = create(
      createElement(RuleListItem, {
        mandate: row,
        decimals: 6,
        nowSec: NOW,
        current: false,
        onPress: () => undefined,
      }),
    );
  });
  assert.ok(root);
  return root;
}

test('a rule card with 39 days 22 hours left shows the time once', async () => {
  const root = await renderCard(mandate({ expiresAt: NOW + 39n * DAY + 22n * HOUR }));
  const texts = root.root.findAll((node) => isHost(node, 'Text')).map(textOf);
  const all = texts.join('\n');
  assert.ok(texts.includes('39 days left'), all);
  assert.doesNotMatch(all, /39d 22h/);
  assert.equal(all.match(/days left/g)?.length, 1, all);
  act(() => root.unmount());
});

test('a rule card shows remaining and spent that add up to the cap', async () => {
  const root = await renderCard(mandate({ cap: 20_000_000n, spent: 973_721n }));
  const texts = root.root.findAll((node) => isHost(node, 'Text')).map(textOf);
  const all = texts.join('\n');
  assert.ok(texts.includes('19.02 VTEST'), all);
  assert.ok(texts.includes('0.98 VTEST spent'), all);
  assert.ok(texts.includes('left of your 20 VTEST total'), all);
  act(() => root.unmount());
});

test('a card with long 6 decimal amounts and a 5 letter symbol keeps every figure whole and lets it wrap or shrink', async () => {
  const row = mandate({
    cap: 987_654_321_123_456n,
    spent: 17_250_000n,
    perTxMax: 1_234_567_891n,
  });
  const root = await renderCard(row);
  const texts = root.root.findAll((node) => isHost(node, 'Text'));
  const all = texts.map(textOf).join('\n');

  const remaining = texts.find((node) => textOf(node) === '987654303.87 VTEST');
  assert.ok(remaining, all);
  assert.match(textOf(remaining), /VTEST$/);
  assert.equal(remaining.props.numberOfLines, 1);
  assert.equal(remaining.props.adjustsFontSizeToFit, true);
  assert.ok(Number(remaining.props.minimumFontScale) <= 0.5);

  const spentLine = texts.find((node) => textOf(node) === '17.25 VTEST spent');
  assert.ok(spentLine, all);
  assert.equal(flatStyle(spentLine.props.style).flexShrink, 1);

  const ofLine = texts.find((node) => /^left of your .* VTEST total$/.test(textOf(node)));
  assert.ok(ofLine, all);
  assert.equal(flatStyle(ofLine.props.style).flexShrink, 1);

  const row2 = hostParent(spentLine);
  assert.ok(row2);
  assert.ok(row2 === hostParent(ofLine), 'spent and total share one row');
  const rowStyle = flatStyle(row2.props.style);
  assert.equal(rowStyle.flexDirection, 'row');
  assert.equal(rowStyle.flexWrap, 'wrap');

  // The big amount is not on the same row as the spent figure, so it cannot push it off the edge.
  assert.ok(hostParent(remaining) !== row2, 'the big amount sits on its own line');

  for (const node of texts) {
    const style = flatStyle(node.props.style);
    assert.equal(style.width, undefined, `fixed width on ${textOf(node)}`);
    assert.notEqual(node.props.numberOfLines === 1 && node.props.ellipsizeMode, 'tail');
  }
  act(() => root.unmount());
});


test('Overview stacks its cap below the amount and fits six decimal amounts with five letter symbols', async () => {
  const { SpendBoard } = await import('../components/daily/SpendBoard');
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(createElement(SpendBoard, {
      kicker: 'Your agent can still spend',
      remainingText: '987654303.873456 VTEST',
      ofText: 'of 987654321.123456 VTEST',
      spentText: '17.25 VTEST', spentCaption: 'spent so far',
      remaining: 9, cap: 10, accessibilityLabel: 'Remaining budget',
      leftCaption: '1 block is one share of 987654321.123456 VTEST',
      rightCaption: 'Most per payment: 1234.567891 VTEST',
    }));
  });
  const texts = root.root.findAll((node) => isHost(node, 'Text'));
  const amount = texts.find((node) => textOf(node) === '987654303.87 VTEST')!;
  const cap = texts.find((node) => textOf(node) === 'of 987654321.12 VTEST')!;
  assert.ok(amount);
  assert.ok(cap);
  assert.equal(flatStyle(hostParent(amount)!.props.style).flexDirection, 'column');
  assert.equal(amount.props.numberOfLines, 1);
  assert.equal(amount.props.adjustsFontSizeToFit, true);
  assert.ok(amount.props.minimumFontScale <= 0.4);
  assert.equal(flatStyle(cap.props.style).flexShrink, 1);
  assert.equal(cap.props.numberOfLines, undefined, 'the cap can wrap');
  for (const node of texts) {
    assert.equal(flatStyle(node.props.style).width, undefined);
  }
  act(() => root.unmount());
});
