import type { Config } from '@eslint/config-helpers';
import js from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import { defineConfig } from 'eslint/config';
import _ from 'lodash';
import tseslint from 'typescript-eslint';

function customizeConfig(oriConfig: Config, overrides: Config): Config {
    const result = _.cloneDeep(oriConfig);
    return _.merge(result, overrides);
}

export default defineConfig([
    {
        ignores: ['dist/**', '.omp/**', 'node_modules/**'],
    },
    customizeConfig(eslintPluginPrettierRecommended, {
        rules: {
            'prettier/prettier': 'off',
        },
    }),
    // Core JS rules.
    js.configs.recommended,
    // Strict, type-aware TypeScript rules plus the stylistic (type-aware) tier.
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                projectService: {
                    // This config file and the manual-test demo live outside tsconfig's
                    // include; parse them with default compiler options instead of
                    // failing type-aware linting.
                    allowDefaultProject: ['eslint.config.ts', 'examples/*.ts'],
                },
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            // `import type` for type-only imports — fixable, so `format`/`lint:fix` apply it.
            '@typescript-eslint/consistent-type-imports': [
                'error',
                { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
            ],
            // Disallow `import { type Foo }` side-effect imports that cost a runtime lookup.
            '@typescript-eslint/no-import-type-side-effects': 'error',
            // @vscode/debugadapter declares every DAP handler as `void`-returning
            // while this session implements them as `async` ...: Promise<void> with
            // errors caught inside (the pattern Microsoft's own adapter docs use).
            // The dispatch does not await handlers, but none of ours can reject.
            '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
            // `_`-prefixed params are kept for signature compatibility with the
            // shared SourceMap interfaces, not dead code.
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            // Template-literal interpolation of numbers is idiomatic in this
            // codebase; the strict tier's zero-allow options forced `${String(x)}`
            // noise everywhere. Off per project preference.
            '@typescript-eslint/restrict-template-expressions': 'off',
        },
    },
]);
