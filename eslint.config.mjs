// eslint-config-next 16 ships native flat configs, so no eslintrc compat bridge.
import coreWebVitals from 'eslint-config-next/core-web-vitals'
import typescript from 'eslint-config-next/typescript'

const config = [
  /* `.claude/` is agent scratch space — worktrees with their own `.next/` build
     output land there, and linting a bundled chunk produces hundreds of errors
     about code nobody wrote. CI never sees it (a fresh checkout has no
     worktrees), so without this the failure is local-only, which is the worst
     kind: `pnpm lint` is the documented command and it stops agreeing with the
     job that gates the image. */
  { ignores: ['.next/**', '.next-*/**', '.claude/**', 'node_modules/**', 'dist/**', 'next-env.d.ts'] },
  ...coreWebVitals,
  ...typescript,
]

export default config
