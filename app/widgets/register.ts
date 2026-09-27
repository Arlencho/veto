import type { WidgetTaskHandlerProps } from 'react-native-android-widget';

import {
  RULE_WIDGET_NAME,
  SPEND_WIDGET_NAME,
  WIDGET_ERROR_COPY,
  WIDGET_LOADING_COPY,
  boardWithMessage,
  drawForRule,
  drawForSpend,
  forgetWidgetBinding,
  loadWidgetBoard,
  readWidgetBindings,
  type WidgetBoard,
} from '../lib/widgetData';

// The decision task imports this module. Native widget packages stay behind
// a dynamic import so loading the task does not parse react-native.

export async function anyHomeWidgetPlaced(
  getWidgetInfo: (widgetName: string) => Promise<readonly unknown[]>,
): Promise<boolean> {
  const placed = await Promise.all([getWidgetInfo(SPEND_WIDGET_NAME), getWidgetInfo(RULE_WIDGET_NAME)]);
  return placed.some((widgets) => widgets.length > 0);
}

export async function refreshHomeWidgets(): Promise<void> {
  try {
    const { getWidgetInfo, requestWidgetUpdate } = await import('react-native-android-widget');
    if (!(await anyHomeWidgetPlaced(getWidgetInfo))) {
      // No widget on the home screen, so no chain reads for one.
      return;
    }
    const { widgetElement } = await import('./androidWidget');
    const board = await loadWidgetBoard(Date.now());
    const bindings = await readWidgetBindings();
    await requestWidgetUpdate({
      widgetName: SPEND_WIDGET_NAME,
      renderWidget: () => widgetElement(drawForSpend(board)),
      widgetNotFound() {
        return undefined;
      },
    });
    await requestWidgetUpdate({
      widgetName: RULE_WIDGET_NAME,
      renderWidget: (info) => widgetElement(drawForRule(board, bindings, info.widgetId)),
      widgetNotFound() {
        return undefined;
      },
    });
  } catch {
    // The home screen may have no widget yet, or this process has no widget runtime.
  }
}

export async function widgetTaskHandler(props: WidgetTaskHandlerProps): Promise<void> {
  const { widgetAction, widgetInfo, renderWidget } = props;
  if (widgetAction === 'WIDGET_DELETED') {
    if (widgetInfo.widgetName === RULE_WIDGET_NAME) {
      try {
        await forgetWidgetBinding(widgetInfo.widgetId);
      } catch {
        // A missing store still lets the launcher remove the widget.
      }
    }
    return;
  }
  if (widgetAction === 'WIDGET_CLICK') {
    return;
  }
  const { widgetElement } = await import('./androidWidget');
  renderWidget(widgetElement({ kind: 'message', body: WIDGET_LOADING_COPY }));
  let board: WidgetBoard;
  try {
    board = await loadWidgetBoard(Date.now());
  } catch {
    board = boardWithMessage(Date.now(), 'error', WIDGET_ERROR_COPY);
  }
  let bindings: Record<string, string> = {};
  try {
    bindings = await readWidgetBindings();
  } catch {
    bindings = {};
  }
  const draw =
    widgetInfo.widgetName === RULE_WIDGET_NAME
      ? drawForRule(board, bindings, widgetInfo.widgetId)
      : drawForSpend(board);
  renderWidget(widgetElement(draw));
}

let registered = false;

export function registerHomeWidgets(): void {
  if (registered) {
    return;
  }
  registered = true;
  void finishHomeWidgetRegistration().catch(() => {
    registered = false;
  });
}

async function finishHomeWidgetRegistration(): Promise<void> {
  const { registerWidgetTaskHandler, registerWidgetConfigurationScreen } = await import(
    'react-native-android-widget'
  );
  const { AppState } = await import('react-native');
  const { RuleChoiceScreen } = await import('./RuleChoiceScreen');
  registerWidgetTaskHandler(widgetTaskHandler);
  registerWidgetConfigurationScreen(RuleChoiceScreen);
  const kick = () => {
    void refreshHomeWidgets();
  };
  if (AppState.currentState === 'active') {
    kick();
  }
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      kick();
    }
  });
}
