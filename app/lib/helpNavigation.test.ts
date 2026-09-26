import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { finishHelpExport, type HelpStackRoute } from './helpNavigation';

import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type NavCall = { method: 'push' | 'replace' | 'back' | 'dismiss'; href?: string };

const calls: NavCall[] = [];
const history: string[] = [];
let pathname = '/';
let blockPathname = false;

function Host(type: string) {
  return function MockHost(props: { children?: ReactNode; style?: unknown } & Record<string, unknown>) {
    const style =
      typeof props.style === 'function'
        ? (props.style as (state: { pressed: boolean }) => unknown)({ pressed: false })
        : props.style;
    return createElement(type, { ...props, style }, props.children);
  };
}

mock.module('react-native', {
  namedExports: {
    Pressable: Host('Pressable'),
    RefreshControl: Host('RefreshControl'),
    ScrollView: Host('ScrollView'),
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

mock.module('react-native-safe-area-context', {
  namedExports: {
    SafeAreaView: Host('SafeAreaView'),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  },
});

mock.module('expo-router', {
  namedExports: {
    usePathname: () => {
      if (blockPathname) throw new Error('Invalid hook call');
      return pathname;
    },
    useNavigation: () => ({
      getState: () => ({
        routes: history.map((entry) => ({ name: entry, path: entry })),
      }),
    }),
    useRouter: () => ({
      push: (href: string) => {
        calls.push({ method: 'push', href });
        history.push(href);
        pathname = href;
      },
      replace: (href: string) => {
        calls.push({ method: 'replace', href });
        if (history.length === 0) history.push(href);
        else history[history.length - 1] = href;
        pathname = href;
      },
      back: () => {
        calls.push({ method: 'back' });
        history.pop();
        pathname = history[history.length - 1] ?? '/';
      },
      canDismiss: () => history.length > 1,
      // StackRouter POP keeps max(index - count + 1, 1) routes from the bottom.
      dismiss: (count = 1) => {
        calls.push({ method: 'dismiss', href: String(count) });
        const currentIndex = history.length - 1;
        if (currentIndex > 0) {
          const keep = Math.max(currentIndex - count + 1, 1);
          history.splice(keep);
          pathname = history[history.length - 1] ?? '/';
        }
      },
    }),
    Stack: Host('Stack'),
    Tabs: Host('Tabs'),
  },
});

type HelpScreen = () => ReactNode;
type TopBarComponent = (props: { help?: boolean; back?: string }) => ReactNode;

let HelpIndex: HelpScreen;
let HelpRefusal: HelpScreen;
let HelpExport: HelpScreen;
let TopBar: TopBarComponent;

function isHost(node: ReactTestInstance, type: string): boolean {
  return (node.type as unknown) === type;
}

function labelsOf(root: ReactTestRenderer): string[] {
  return root.root
    .findAll((node) => typeof node.props?.accessibilityLabel === 'string')
    .map((node) => String(node.props.accessibilityLabel));
}

function button(root: ReactTestRenderer, label: string): ReactTestInstance {
  const node = root.root
    .findAll((candidate) => isHost(candidate, 'Pressable'))
    .find((candidate) => candidate.props.accessibilityLabel === label);
  assert.ok(node, `no button labelled ${label}. Labels: ${labelsOf(root).join(' | ')}`);
  return node;
}

async function mount(node: ReactElement): Promise<ReactTestRenderer> {
  let root: ReactTestRenderer | null = null;
  await act(async () => {
    root = create(node);
  });
  assert.ok(root);
  return root;
}

function at(path: string, stack: string[] = ['/(tabs)/rules', path]): void {
  calls.length = 0;
  history.splice(0, history.length, ...stack);
  pathname = path;
}

test.before(async () => {
  const [index, refusal, exported, bar] = await Promise.all([
    import('../app/help/index'),
    import('../app/help/refusal'),
    import('../app/help/export'),
    import('../components/TopBar'),
  ]);
  HelpIndex = index.default;
  HelpRefusal = refusal.default;
  HelpExport = exported.default;
  TopBar = bar.TopBar;
});

test.beforeEach(() => {
  blockPathname = false;
  at('/rules', ['/(tabs)/rules']);
});

test('the three help pages do not show a Help control', async () => {
  const pages: Array<{ path: string; Screen: HelpScreen }> = [
    { path: '/help', Screen: HelpIndex },
    { path: '/help/refusal', Screen: HelpRefusal },
    { path: '/help/export', Screen: HelpExport },
  ];
  for (const page of pages) {
    at(page.path);
    const root = await mount(createElement(page.Screen));
    assert.equal(
      labelsOf(root).includes('Help'),
      false,
      `${page.path} still shows Help, so another press can open /help on top of itself`,
    );
  }
});

test('Help stays hidden on a help or onboarding route when the bar would otherwise show it', async () => {
  for (const path of ['/help', '/help/refusal', '/help/export', '/help/export?from=rules', '/onboarding']) {
    at(path);
    const root = await mount(createElement(TopBar, { help: true, back: 'Back' }));
    assert.equal(labelsOf(root).includes('Help'), false, `${path} rendered Help`);
  }
});

test('back on a help or onboarding route pops the screen under it', async () => {
  const steps: Array<{ path: string; stack: string[]; after: string[] }> = [
    {
      path: '/help',
      stack: ['/(tabs)/rules', '/help'],
      after: ['/(tabs)/rules'],
    },
    {
      path: '/help/refusal',
      stack: ['/(tabs)/rules', '/help', '/help/refusal'],
      after: ['/(tabs)/rules', '/help'],
    },
    {
      path: '/help/export?from=rules',
      stack: ['/(tabs)/rules', '/help', '/help/refusal', '/help/export?from=rules'],
      after: ['/(tabs)/rules', '/help', '/help/refusal'],
    },
    {
      path: '/onboarding',
      stack: ['/(tabs)/rules', '/help', '/onboarding'],
      after: ['/(tabs)/rules', '/help'],
    },
  ];
  for (const step of steps) {
    at(step.path, step.stack);
    const root = await mount(createElement(TopBar, { help: true, back: 'Back' }));
    await act(async () => {
      button(root, 'Back').props.onPress();
    });
    assert.deepEqual(calls, [{ method: 'back' }], step.path);
    assert.deepEqual(history, step.after, step.path);
  }
});

test('Help from another screen pushes one help route', async () => {
  at('/rules', ['/(tabs)/rules']);
  const root = await mount(createElement(TopBar, { help: true }));
  await act(async () => {
    button(root, 'Help').props.onPress();
  });
  assert.deepEqual(calls, [{ method: 'push', href: '/help' }]);
  assert.deepEqual(history, ['/(tabs)/rules', '/help']);
});

test('opening the introduction from help pushes it on the help page', async () => {
  at('/help');
  const root = await mount(createElement(HelpIndex));
  await act(async () => {
    button(root, 'Show the introduction').props.onPress();
  });
  assert.deepEqual(calls, [{ method: 'push', href: '/onboarding' }]);
  assert.deepEqual(history, ['/(tabs)/rules', '/help', '/onboarding']);
});

test('next through the help pages pushes the next page', async () => {
  at('/help');
  const first = await mount(createElement(HelpIndex));
  await act(async () => {
    button(first, 'Next').props.onPress();
  });
  assert.deepEqual(calls, [{ method: 'push', href: '/help/refusal' }]);
  assert.deepEqual(history, ['/(tabs)/rules', '/help', '/help/refusal']);

  const second = await mount(createElement(HelpRefusal));
  await act(async () => {
    button(second, 'Next').props.onPress();
  });
  assert.deepEqual(calls, [
    { method: 'push', href: '/help/refusal' },
    { method: 'push', href: '/help/export' },
  ]);
  assert.deepEqual(history, ['/(tabs)/rules', '/help', '/help/refusal', '/help/export']);
});

test('back on a later help page pops to the previous page', async () => {
  at('/help/refusal', ['/(tabs)/rules', '/help', '/help/refusal']);
  const refusal = await mount(createElement(HelpRefusal));
  await act(async () => {
    button(refusal, 'Back').props.onPress();
  });
  assert.deepEqual(calls, [{ method: 'back' }]);
  assert.deepEqual(history, ['/(tabs)/rules', '/help']);

  at('/help/export', ['/(tabs)/rules', '/help', '/help/refusal', '/help/export']);
  const exported = await mount(createElement(HelpExport));
  await act(async () => {
    button(exported, 'Back').props.onPress();
  });
  assert.deepEqual(calls, [{ method: 'back' }]);
  assert.deepEqual(history, ['/(tabs)/rules', '/help', '/help/refusal']);
});

test('back on the first help page leaves the flow', async () => {
  at('/help');
  const root = await mount(createElement(HelpIndex));
  await act(async () => {
    button(root, 'Back').props.onPress();
  });
  assert.deepEqual(calls, [{ method: 'back' }]);
  assert.deepEqual(history, ['/(tabs)/rules']);
});

test('Done returns to the screen that opened help and leaves no help page or second tabs route', async () => {
  const origins: Array<{ path: string; stack: string[]; back?: string }> = [
    { path: '/rules', stack: ['/(tabs)/rules'] },
    { path: '/decision/5Nf3', stack: ['/(tabs)/decisions', '/decision/5Nf3'], back: 'Decisions' },
  ];
  for (const origin of origins) {
    at(origin.path, origin.stack);
    const openedFrom = [...origin.stack];
    const bar = await mount(createElement(TopBar, { help: true, back: origin.back }));
    await act(async () => {
      button(bar, 'Help').props.onPress();
    });
    const first = await mount(createElement(HelpIndex));
    await act(async () => {
      button(first, 'Next').props.onPress();
    });
    const second = await mount(createElement(HelpRefusal));
    await act(async () => {
      button(second, 'Next').props.onPress();
    });
    const exported = await mount(createElement(HelpExport));
    await act(async () => {
      button(exported, 'Done').props.onPress();
    });
    assert.deepEqual([...history], openedFrom, origin.path);
  }
});

test('Done on a cold help export link replaces the page with the tabs home', async () => {
  at('/help/export', ['/help/export']);
  const exported = await mount(createElement(HelpExport));
  blockPathname = true;
  try {
    await act(async () => {
      button(exported, 'Done').props.onPress();
    });
  } finally {
    blockPathname = false;
  }
  assert.deepEqual(calls, [{ method: 'replace', href: '/(tabs)' }]);
  assert.deepEqual(history, ['/(tabs)']);
});

function doneRouter(stackLength: number) {
  const calls: Array<{ method: 'dismiss' | 'replace'; value: string }> = [];
  return {
    calls,
    router: {
      canDismiss: () => stackLength > 1,
      dismiss: (count?: number) => calls.push({ method: 'dismiss', value: String(count) }),
      replace: (href: string) => calls.push({ method: 'replace', value: href }),
    },
  };
}

test('Done dismisses a stack that is only help pages and replaces the page that pop must leave', () => {
  const { calls, router } = doneRouter(3);
  finishHelpExport(router, ['/help', '/help/refusal', '/help/export']);
  assert.deepEqual(calls, [
    { method: 'dismiss', value: '3' },
    { method: 'replace', value: '/(tabs)' },
  ]);
});

test('Done on a cold refusal link dismisses both help pages and replaces the last one', () => {
  const { calls, router } = doneRouter(2);
  finishHelpExport(router, ['/help/refusal', '/help/export']);
  assert.deepEqual(calls, [
    { method: 'dismiss', value: '2' },
    { method: 'replace', value: '/(tabs)' },
  ]);
});

test('Done on a warm export link dismisses that page and keeps the open decision', () => {
  const { calls, router } = doneRouter(3);
  finishHelpExport(router, ['/decisions', '/decision/5Nf3', '/help/export']);
  assert.deepEqual(calls, [{ method: 'dismiss', value: '1' }]);
});

test('Done dismisses the three help screen names and leaves the tabs route', () => {
  const routes: HelpStackRoute[] = [
    { name: '(tabs)' },
    { name: 'help/index' },
    { name: 'help/refusal' },
    { name: 'help/export' },
  ];
  const { calls, router } = doneRouter(routes.length);
  finishHelpExport(router, routes);
  assert.deepEqual(calls, [{ method: 'dismiss', value: '3' }]);
});

test('a missing route list replaces home and does not walk the focused path', () => {
  let reads = 0;
  const calls: { method: 'dismiss' | 'replace'; value: string }[] = [];
  const finish = finishHelpExport as unknown as (
    router: {
      canDismiss: () => boolean;
      dismiss: (count?: number) => void;
      replace: (href: string) => void;
    },
    routes: readonly string[] | null,
    readPath: () => string,
  ) => void;
  finish(
    {
      canDismiss: () => true,
      dismiss: (count?: number) => calls.push({ method: 'dismiss', value: String(count) }),
      replace: (href: string) => calls.push({ method: 'replace', value: href }),
    },
    null,
    () => {
      reads += 1;
      return '/help/export';
    },
  );
  assert.equal(reads, 0);
  assert.deepEqual(calls, [{ method: 'replace', value: '/(tabs)' }]);
});

test('Done on the only help export route replaces it even when canDismiss is true', () => {
  const calls: Array<{ method: 'dismiss' | 'replace'; value: string }> = [];
  finishHelpExport(
    {
      canDismiss: () => true,
      dismiss: (count?: number) => calls.push({ method: 'dismiss', value: String(count) }),
      replace: (href: string) => calls.push({ method: 'replace', value: href }),
    },
    [{ name: 'help/export', path: '/help/export' }],
  );
  assert.deepEqual(calls, [{ method: 'replace', value: '/(tabs)' }]);
});

test('Done stops at the first route that is not a help page', () => {
  const { calls, router } = doneRouter(4);
  finishHelpExport(router, ['/rules', '/help', '/onboarding', '/help/export']);
  assert.deepEqual(calls, [{ method: 'dismiss', value: '1' }]);
});

test('back from the introduction pops to help', async () => {
  at('/onboarding', ['/(tabs)/rules', '/help', '/onboarding']);
  const root = await mount(createElement(TopBar, { back: 'Back', help: false }));
  await act(async () => {
    button(root, 'Back').props.onPress();
  });
  assert.deepEqual(calls, [{ method: 'back' }]);
  assert.deepEqual(history, ['/(tabs)/rules', '/help']);
});

test('Help explains the guardian recovery destination and safe wallet ownership risks', async () => {
  const root = await mount(createElement(HelpIndex));
  const text = root.root.findAll((node) => isHost(node, 'Text'))
    .map((node) => node.children.filter((child) => typeof child === 'string').join('')).join('\n');
  assert.match(text, /immediately recover the entire balance to the configured safe address/);
  assert.match(text, /Acting alone, it cannot choose another destination/);
  assert.match(text, /guardian does not control/);
  assert.match(text, /safe address must differ from the owner/);
  await act(async () => root.unmount());
});
