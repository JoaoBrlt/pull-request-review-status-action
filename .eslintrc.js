module.exports = {
    root: true,
    env: {
        node: true,
        es6: true,
    },
    extends: ["eslint:recommended", "prettier"],
    parserOptions: {
        ecmaVersion: 2023,
        sourceType: "module",
    },
    overrides: [
        // TypeScript
        {
            files: ["**/*.ts"],
            extends: ["plugin:@typescript-eslint/recommended", "plugin:@typescript-eslint/recommended-type-checked"],
            parser: "@typescript-eslint/parser",
            parserOptions: {
                project: "./tsconfig.eslint.json",
            },
            plugins: ["@typescript-eslint"],
        },

        // Tests
        {
            files: ["**/*.test.ts"],
            extends: ["plugin:jest/recommended"],
            plugins: ["jest"],
        },
    ],
};
