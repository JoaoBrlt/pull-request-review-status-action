import eslint from "@eslint/js";
import prettierConfig from "eslint-config-prettier/flat";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";
import jest from "eslint-plugin-jest";

export default defineConfig([
    // Ignored files
    { ignores: ["**/dist/", "**/node_modules/"] },

    // JavaScript + TypeScript
    {
        files: ["**/*.{js,cjs,mjs,ts,cts,mts}"],
        languageOptions: {
            globals: globals.node,
        },
    },
    {
        files: ["**/*.{js,cjs,mjs,ts,cts,mts}"],
        ...eslint.configs.recommended,
    },

    // TypeScript
    ...tseslint.configs.recommendedTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },

    // JavaScript
    {
        files: ["**/*.{js,cjs,mjs}"],
        ...tseslint.configs.disableTypeChecked,
    },

    // Tests
    {
        files: ["**/*.test.{js,cjs,mjs,ts,cts,mts}"],
        ...jest.configs["flat/recommended"],
    },

    // Prettier
    prettierConfig,
]);
