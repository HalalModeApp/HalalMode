module.exports = function (api) {
  api.cache(true);
  return {
    presets: [['babel-preset-expo', { jsxImportSource: 'react' }]],
    // react-native-worklets/plugin must stay last — Reanimated 4 depends on it.
    plugins: ['react-native-worklets/plugin'],
  };
};
