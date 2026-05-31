/**
 * dependency-cruiser config for even-status-deck (dependency-cruiser 17.x).
 *
 * レイヤ境界の実態 (rg で裏取り済み):
 *  - src/ (UI/Vite)  -> server/        : import 0 件
 *  - server/ (CLI/HTTP) -> src/        : ../src/event-types.ts / ../src/status-types.ts のみ (共有型)
 *  - 共有型は src/*-types.ts に置き、server がそこだけ参照する構造。
 *
 * 解決上の注意:
 *  - src/ は拡張子なし相対 import (例 `from './builtins'`, `from './status-types'`)。
 *  - server/ のクロスレイヤ import は明示 .ts (例 `from '../src/event-types.ts'`)。
 *    -> tsConfig(allowImportingTsExtensions) + enhancedResolveOptions で両方を解決する。
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'モジュール間の循環依存を禁止する。',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'ui-not-to-server',
      comment: 'UI 層 (src/) は server 実装に依存してはならない。共有は src/*-types.ts のみ。',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^server/' },
    },
    {
      name: 'server-to-src-types-only',
      comment:
        'server から src への参照は共有型 (src/*-types.ts) のみ許可。それ以外の src 参照は警告。',
      severity: 'warn',
      from: { path: '^server/' },
      to: {
        path: '^src/',
        pathNot: ['^src/[^/]*-types\\.ts$'],
      },
    },
    {
      name: 'no-orphans',
      comment: '孤立モジュール検出 (型定義・設定・テストは除外)。',
      severity: 'info',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$', // dotfiles
          '\\.d\\.ts$',
          '(^|/)tsconfig\\.json$',
          '(^|/)(biome|playwright|vite)\\.config\\.(js|cjs|mjs|ts)$',
          '\\.(test|spec)\\.ts$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: {
      path: ['node_modules'],
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    enhancedResolveOptions: {
      // .ts 明示 import (server -> ../src/*.ts) と 拡張子なし import (src 内) の両方を解決する。
      extensions: ['.ts', '.tsx', '.mjs', '.cjs', '.js', '.jsx', '.json'],
      // 型情報を優先解決し、CJS/ESM 双方の exports を尊重する。
      mainFields: ['module', 'main', 'types', 'typings'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
    reporterOptions: {
      dot: {
        collapsePattern: 'node_modules/(?:@[^/]+/[^/]+|[^/]+)',
      },
    },
  },
}
