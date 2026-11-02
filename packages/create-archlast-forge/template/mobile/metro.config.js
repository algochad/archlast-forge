// Expo's Metro config finds the workspace on its own (apps/ and packages/ of the monorepo).
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
