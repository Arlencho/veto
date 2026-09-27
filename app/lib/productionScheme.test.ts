import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { stripDevClientSchemes, stripsDevClientScheme } = require('../plugins/withoutDevClientScheme.js') as {
  stripDevClientSchemes: (manifest: {
    manifest: {
      application: Array<{
        activity: Array<{
          'intent-filter': Array<{ data?: Array<{ $: { 'android:scheme': string } }> }>;
        }>;
      }>;
    };
  }) => {
    manifest: {
      application: Array<{
        activity: Array<{
          'intent-filter': Array<{ data?: Array<{ $: { 'android:scheme': string } }> }>;
        }>;
      }>;
    };
  };
  stripsDevClientScheme: (profile: string | undefined) => boolean;
};
const { shapeConfig } = require('../app.config.js') as {
  shapeConfig: (
    config: { plugins?: unknown[]; extra?: Record<string, unknown> },
    env: Record<string, string | undefined>,
  ) => { plugins: unknown[] };
};

function schemes(manifest: ReturnType<typeof stripDevClientSchemes>): string[] {
  const out: string[] = [];
  for (const application of manifest.manifest.application) {
    for (const activity of application.activity) {
      for (const filter of activity['intent-filter']) {
        for (const entry of filter.data ?? []) {
          out.push(entry.$['android:scheme']);
        }
      }
    }
  }
  return out;
}

test('a production manifest keeps the app scheme and drops the dev-client scheme', () => {
  const manifest = {
    manifest: {
      application: [
        {
          activity: [
            {
              'intent-filter': [
                {
                  data: [
                    { $: { 'android:scheme': 'veto' } },
                    { $: { 'android:scheme': 'exp+veto' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
  const next = stripDevClientSchemes(manifest);
  assert.deepEqual(schemes(next), ['veto']);
});

test('the dev-client scheme strip applies to the production, mainnet-preview and tester profiles only', () => {
  assert.equal(stripsDevClientScheme('production'), true);
  assert.equal(stripsDevClientScheme('tester'), true);
  assert.equal(stripsDevClientScheme('mainnet-preview'), true);
  assert.equal(stripsDevClientScheme('development'), false);
  assert.equal(stripsDevClientScheme(undefined), false);
});

test('the production config does not apply the dev client and still blocks unused permissions', () => {
  const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')) as {
    expo: {
      plugins?: unknown[];
      android?: { blockedPermissions?: string[] };
    };
  };
  const blocked = app.expo.android?.blockedPermissions ?? [];
  assert.deepEqual(blocked, [
    'android.permission.SYSTEM_ALERT_WINDOW',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
  ]);
  assert.equal(
    blocked.includes('android.permission.VIBRATE'),
    false,
    'VIBRATE stays declared so hold to sign feedback and notification vibration work',
  );
  assert.equal(
    blocked.includes('android.permission.RECEIVE_BOOT_COMPLETED'),
    false,
    'RECEIVE_BOOT_COMPLETED stays declared so the decision scan can be rescheduled after a reboot',
  );
  const prod = shapeConfig(app.expo, { EAS_BUILD_PROFILE: 'production' });
  const names = prod.plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
  assert.equal(names.includes('expo-dev-client'), false);
  assert.equal(typeof prod.plugins[0], 'function');
  const dev = shapeConfig(app.expo, {});
  const devNames = dev.plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
  assert.equal(devNames.includes('expo-dev-client'), true);
});
