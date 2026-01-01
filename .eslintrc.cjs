module.exports = {
  root: true,
  env: {
    browser: true,
    es2021: true,
    node: true,
  },
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "script",
  },
  extends: ["eslint:recommended", "prettier"],
  ignorePatterns: ["dist/", "build/", "node_modules/", ".github/"],
  rules: {
    "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    "no-console": "off",
  },
};

