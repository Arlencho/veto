import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const SPEND = 'VetoSpend';
const RULE = 'VetoRule';

let placed: Record<string, number[]> = {};
let boards = 0;
const updated: string[] = [];

mock.module('react-native-android-widget', {
  namedExports: {
    getWidgetInfo: async (widgetName: string) =>
      (placed[widgetName] ?? []).map((widgetId) => ({ widgetName, widgetId })),
    requestWidgetUpdate: async (args: { widgetName: string }) => {
      updated.push(args.widgetName);
    },
  },
});
mock.module('../widgets/androidWidget', {
  namedExports: {
    widgetElement: () => null,
  },
});
mock.module('./widgetData', {
  namedExports: {
    SPEND_WIDGET_NAME: SPEND,
    RULE_WIDGET_NAME: RULE,
    WIDGET_ERROR_COPY: 'error',
    WIDGET_LOADING_COPY: 'loading',
    boardWithMessage: () => ({}),
    drawForRule: () => ({}),
    drawForSpend: () => ({}),
    forgetWidgetBinding: async () => undefined,
    loadWidgetBoard: async () => {
      boards += 1;
      return {};
    },
    readWidgetBindings: async () => ({}),
  },
});

const registerModule = import('../widgets/register');

function reset(next: Record<string, number[]>): void {
  placed = next;
  boards = 0;
  updated.length = 0;
}

test.describe('home widget refresh', { concurrency: 1 }, () => {
  test('with no widget on the home screen, no board is loaded and nothing is read from chain', async () => {
    const { refreshHomeWidgets } = await registerModule;
    reset({});
    await refreshHomeWidgets();
    assert.equal(boards, 0);
    assert.deepEqual(updated, []);
  });

  test('a placed spend widget still loads the board and updates both widget kinds', async () => {
    const { refreshHomeWidgets } = await registerModule;
    reset({ [SPEND]: [4] });
    await refreshHomeWidgets();
    assert.equal(boards, 1);
    assert.deepEqual(updated, [SPEND, RULE]);
  });

  test('a placed rule widget alone still loads the board', async () => {
    const { refreshHomeWidgets } = await registerModule;
    reset({ [RULE]: [7] });
    await refreshHomeWidgets();
    assert.equal(boards, 1);
    assert.deepEqual(updated, [SPEND, RULE]);
  });
});
