module.exports = {
  parserOptions: {
    ecmaVersion: 'latest', // hoặc 2022
    sourceType: 'module',
    ecmaFeatures: {
      experimentalObjectRestSpread: true,
    },
  },
  env: {
    es6: true,
    node: true,
  },
};
