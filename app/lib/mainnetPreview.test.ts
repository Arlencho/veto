import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { shapeConfig } = require('../app.config.js');
const { expo } = require('../app.json');
const { build } = require('../eas.json');

test('mainnet preview installs beside devnet with SKR and the existing program', () => {
  const profile = build['mainnet-preview'];
  assert.equal(profile.environment, 'preview');
  assert.equal(profile.distribution, 'internal');
  assert.equal(profile.android.buildType, 'apk');
  const config = shapeConfig(expo, { ...profile.env, EAS_BUILD_PROFILE: 'mainnet-preview' });
  assert.equal(config.name, 'Veto Mainnet preview');
  assert.equal(config.android.package, 'com.veto.app.mainnetpreview');
  assert.equal(config.scheme, 'veto-mainnet-preview');
  assert.equal(config.extra.vetoMint, 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3');
  assert.equal(config.extra.vetoMintDecimals, '6');
  assert.equal(config.extra.vetoExplorerCluster, 'mainnet-beta');
  assert.equal(config.extra.vetoProgramId, build.production.env.EXPO_PUBLIC_VETO_PROGRAM_ID);
  assert.equal(config.plugins.includes('expo-dev-client'), false);
});

test('mainnet preview uses only its dedicated EAS RPC secret and refuses a missing build secret', () => {
  const env = { EAS_BUILD_PROFILE: 'mainnet-preview', EXPO_PUBLIC_VETO_RPC: 'devnet sentinel' };
  assert.equal(shapeConfig(expo, env).extra.vetoRpc, '');
  assert.equal(shapeConfig(expo, { ...env, VETO_MAINNET_PREVIEW_RPC: 'secret sentinel' }).extra.vetoRpc, 'secret sentinel');
  assert.throws(() => shapeConfig(expo, { ...env, EAS_BUILD: 'true' }), /VETO_MAINNET_PREVIEW_RPC/);
  assert.throws(() => shapeConfig(expo, { ...env, EAS_BUILD: 'true', VETO_MAINNET_PREVIEW_RPC: ' ' }), /VETO_MAINNET_PREVIEW_RPC/);
});

test('existing build identities and RPC sources are unchanged', () => {
  const others = Object.keys(build).filter((profile) => profile !== 'mainnet-preview' && profile !== 'tester');
  assert.deepEqual(others.sort(), ['development', 'production']);
  for (const profile of others) {
    const config = shapeConfig(expo, {
      ...build[profile].env,
      EAS_BUILD_PROFILE: profile,
      EXPO_PUBLIC_VETO_RPC: 'existing sentinel',
    });
    assert.equal(config.name, expo.name);
    assert.equal(config.android.package, expo.android.package);
    assert.equal(config.scheme, expo.scheme);
    assert.equal(config.extra.vetoRpc, 'existing sentinel');
  }
});
