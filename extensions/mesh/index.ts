// Pi package extension entry (loaded via the "pi" manifest in package.json).
// The mesh extension implementation lives in src/extension/ (compiled adapter,
// zero Pi imports — the local pi-types.ts mirrors the ExtensionAPI surface).
export { default } from "../../src/extension/index.js";
