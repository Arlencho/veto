const { withProductionDevClientScheme } = require('./plugins/withoutDevClientScheme');

function pluginName(plugin) {
  return Array.isArray(plugin) ? plugin[0] : plugin;
}

function shapeConfig(config, env) {
  const mainnetPreview = env.EAS_BUILD_PROFILE === 'mainnet-preview';
  const tester = env.EAS_BUILD_PROFILE === 'tester';
  const production = env.EAS_BUILD_PROFILE === 'production' || mainnetPreview || tester;
  // VETO_MAINNET_PREVIEW_RPC must be an EAS secret in the preview environment.
  const rpc = tester ? env.VETO_TESTER_RPC
    : mainnetPreview ? env.VETO_MAINNET_PREVIEW_RPC : env.EXPO_PUBLIC_VETO_RPC;
  if (tester && env.EAS_BUILD === 'true' && !rpc?.trim()) {
    throw new Error('Set the VETO_TESTER_RPC EAS secret before building tester.');
  }
  if (mainnetPreview && env.EAS_BUILD === 'true' && !rpc?.trim()) {
    throw new Error('Set the VETO_MAINNET_PREVIEW_RPC EAS secret before building mainnet-preview.');
  }
  const plugins = [...(config.plugins ?? [])];
  const nextPlugins = production
    ? [
        withProductionDevClientScheme,
        ...plugins.filter((plugin) => pluginName(plugin) !== 'expo-dev-client'),
      ]
    : plugins;
  return {
    ...config,
    ...(mainnetPreview ? {
      name: `${config.name} Mainnet preview`,
      scheme: 'veto-mainnet-preview',
      android: { ...config.android, package: `${config.android.package}.mainnetpreview` },
    } : {}),
    plugins: nextPlugins,
    extra: {
      ...(config.extra ?? {}),
      ...(tester ? { vetoBuildProfile: 'tester' } : {}),
      vetoRpc: rpc ?? '',
      vetoProgramId: env.EXPO_PUBLIC_VETO_PROGRAM_ID ?? '',
      vetoMint: env.EXPO_PUBLIC_VETO_MINT ?? '',
      vetoExplorerCluster: env.EXPO_PUBLIC_VETO_EXPLORER_CLUSTER ?? 'devnet',
      vetoMintDecimals: env.EXPO_PUBLIC_VETO_MINT_DECIMALS ?? '6',
    },
  };
}

function build(ctx) {
  return shapeConfig(ctx.config, process.env);
}

build.shapeConfig = shapeConfig;
module.exports = build;
