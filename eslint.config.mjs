import { defineConfig, globalIgnores } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
  globalIgnores(['node_modules/**', 'main.js', 'esbuild.config.mjs', 'version-bump.mjs', 'eslint.config.mjs', 'tests/**', 'tests-*.mjs', 'docs/**']),
  ...obsidianmd.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { parserOptions: { projectService: true } },
  },
]);
