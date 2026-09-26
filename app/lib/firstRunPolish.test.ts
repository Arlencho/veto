import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { ConfiguredTokenContext } from './configuredToken';
import { DEVNET_USDC_MINT, VTEST_MINT } from './tokens';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
mock.module('react-native', { namedExports: {
  View: 'View', Text: 'Text', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (styles: unknown) => styles },
} });

for (const [mint, label] of [[DEVNET_USDC_MINT, 'Devnet USDC'], [VTEST_MINT, 'Test tokens']]) {
  test(`first-run header and wallet copy show ${label}`, async () => {
    const { ConnectWalletScreen } = await import('../components/firstrun/ConnectWalletScreen');
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(createElement(ConfiguredTokenContext.Provider, { value: mint },
        createElement(ConnectWalletScreen, { cluster: 'devnet', onConnect() {} }),
      ));
    });
    const text = JSON.stringify(root.toJSON());
    assert.match(text, new RegExp(label));
    assert.match(text, new RegExp(`with ${mint === VTEST_MINT ? 'test tokens' : label}`));
    if (mint === DEVNET_USDC_MINT) assert.doesNotMatch(text, /test tokens/i);
    await act(async () => root.unmount());
  });
}

test('first-run decoration is clipped inside the body below the header and ignores touches', async () => {
  const { FirstRunChrome } = await import('../components/firstrun/Chrome');
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(createElement(FirstRunChrome, { cluster: 'devnet', stage: 'learn' }));
  });
  const layers = root.root.findAll((node) =>
    node.type === ('View' as never) && node.props.pointerEvents === 'none');
  assert.equal(layers.length, 1);
  const layer = layers[0]!;
  assert.equal(layer.props.style.overflow, 'hidden');
  assert.equal(layer.props.style.top, 0);
  assert.equal(layer.props.style.zIndex, -1);
  assert.equal(layer.parent?.findAll((node) => node.children.includes('Veto')).length, 0);
  await act(async () => root.unmount());
});
