import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { configFromExtra } from './appConfig';

const require = createRequire(import.meta.url);
const { shapeConfig } = require('../app.config.js');
const { expo } = require('../app.json');
const { build } = require('../eas.json');
const { stripsDevClientScheme } = require('../plugins/withoutDevClientScheme');

test('tester ships a standalone devnet APK with the production identity and permissions', () => {
  assert.equal(build.tester.environment, 'preview');
  assert.equal(build.tester.android.buildType, 'apk');
  assert.deepEqual(build.tester.env, build.production.env);
  const config = shapeConfig(expo, { ...build.tester.env, EAS_BUILD_PROFILE: 'tester' });
  const production = shapeConfig(expo, { ...build.production.env, EAS_BUILD_PROFILE: 'production' });
  assert.equal(config.android.package, 'com.veto.app');
  assert.equal(config.name, production.name);
  assert.equal(config.scheme, production.scheme);
  assert.deepEqual(config.android, production.android);
  assert.deepEqual(config.plugins, production.plugins);
  assert.equal(stripsDevClientScheme('tester'), true);
  assert.equal(config.extra.vetoBuildProfile, 'tester');
  assert.equal(config.extra.vetoExplorerCluster, 'devnet');
  assert.equal(config.extra.vetoMint, production.extra.vetoMint);
  assert.equal(config.extra.vetoProgramId, production.extra.vetoProgramId);
});

test('tester selects only its capped RPC even when other RPC variables are present', () => {
  const env = {
    EAS_BUILD_PROFILE: 'tester', EAS_BUILD: 'true',
    EXPO_PUBLIC_VETO_RPC: 'production sentinel',
    VETO_MAINNET_PREVIEW_RPC: 'mainnet sentinel',
    VETO_TESTER_RPC: 'tester sentinel',
  };
  assert.equal(shapeConfig(expo, env).extra.vetoRpc, 'tester sentinel');
  for (const missing of [undefined, '', '   ']) {
    assert.throws(() => shapeConfig(expo, { ...env, VETO_TESTER_RPC: missing }), /VETO_TESTER_RPC/);
  }
  const local = shapeConfig(expo, { ...env, EAS_BUILD: undefined, VETO_TESTER_RPC: undefined });
  assert.equal(local.extra.vetoRpc, '');
  assert.throws(() => configFromExtra(local.extra, env), /VETO_TESTER_RPC/);
});

test('production and mainnet preview ignore the tester RPC', () => {
  for (const profile of ['production', 'mainnet-preview']) {
    const env = {
      ...build[profile].env, EAS_BUILD_PROFILE: profile,
      EXPO_PUBLIC_VETO_RPC: 'production sentinel',
      VETO_MAINNET_PREVIEW_RPC: 'mainnet sentinel',
    };
    assert.deepEqual(
      shapeConfig(expo, { ...env, VETO_TESTER_RPC: 'tester sentinel' }),
      shapeConfig(expo, env),
    );
    assert.equal(shapeConfig(expo, env).extra.vetoRpc, profile === 'production' ? 'production sentinel' : 'mainnet sentinel');
  }
});
