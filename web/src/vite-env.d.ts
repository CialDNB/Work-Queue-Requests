/// <reference types="vite/client" />

// Ambient types for the vite-only affordances the SPA relies on — chiefly `import './styles.css'`
// in main.tsx, which is a bundler feature with no runtime module behind it.
//
// TypeScript 7 (the native compiler) is what forced this: it added TS2882, which checks
// side-effect imports of non-code assets, so `import './styles.css'` became a hard error where
// 5.9 said nothing. vite ships the canonical declarations (`declare module '*.css' {}` et al) in
// vite/client.d.ts; this reference is the vite-scaffolded way to pull them in, and it is what
// `npm create vite` writes. Kept as a file rather than `"types": ["vite/client"]` in
// web/tsconfig.json deliberately — setting `types` REPLACES the auto-included @types set for the
// whole project, which is a much wider blast radius than declaring the ambient module we need.
