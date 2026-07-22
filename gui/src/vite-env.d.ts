/// <reference types="vite/client" />

// Injected at build time by vite.config.ts `define` as the UI version fallback.
declare const __APP_VERSION__: string;

// Injected at build time by vite.config.ts `define` as the served GUI artifact id.
declare const __APP_BUILD_ID__: string;
