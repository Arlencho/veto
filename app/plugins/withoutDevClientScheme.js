const { withAndroidManifest } = require('expo/config-plugins');

function stripDevClientSchemes(manifest) {
  const applications = manifest?.manifest?.application ?? [];
  for (const application of applications) {
    for (const activity of application.activity ?? []) {
      const filters = activity['intent-filter'] ?? [];
      for (const intentFilter of filters) {
        if (!Array.isArray(intentFilter.data)) {
          continue;
        }
        intentFilter.data = intentFilter.data.filter((entry) => {
          const scheme = entry?.$?.['android:scheme'] ?? '';
          return !String(scheme).startsWith('exp+');
        });
      }
    }
  }
  return manifest;
}

function stripsDevClientScheme(profile) {
  return profile === 'production' || profile === 'mainnet-preview' || profile === 'tester';
}

function withProductionDevClientScheme(config) {
  if (!stripsDevClientScheme(process.env.EAS_BUILD_PROFILE)) {
    return config;
  }
  return withAndroidManifest(config, (next) => {
    next.modResults = stripDevClientSchemes(next.modResults);
    return next;
  });
}

module.exports = {
  stripDevClientSchemes,
  stripsDevClientScheme,
  withProductionDevClientScheme,
};
