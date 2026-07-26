module.exports = {
  env: {
    node: true,
    es2021: true
  },
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "prettier"
  ],
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],

  rules: {
    // Allow function declarations inside blocks.
    "no-inner-declarations": "off",

    // Warn, don't error, on empty blocks.
    "no-empty": ["warn", { allowEmptyCatch: true }],

    // Temporarily allow `any` across the repo.
    "@typescript-eslint/no-explicit-any": "off",

    // Warn for unused vars, ignore prefixed underscores.
    "@typescript-eslint/no-unused-vars": [
      "warn",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_"
      }
    ]
  }
};