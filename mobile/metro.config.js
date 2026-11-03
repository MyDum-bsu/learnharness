const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// The app is self-contained (the SSE client is a vendored copy of the
// desktop's src/core/sse.ts) — no monorepo watching needed.

module.exports = config;
