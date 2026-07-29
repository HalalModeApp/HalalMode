# Dependency security status

Last assessed: 2026-07-29.

`npm audit --omit=dev` reports 20 high and 12 moderate advisories in the Expo
54 / React Native 0.81 dependency tree. The reported fixes require a coordinated
Expo 57 and React Native upgrade; they are not safe to apply with `npm audit fix
--force` because that would mix incompatible native modules.

Expo Doctor is currently clean (18/18 checks): direct `expo-asset` and
`expo-linking` peers are installed, and native module duplicates were removed.

Before a public release, complete a dedicated SDK upgrade branch with a fresh
development build, full Android/iOS device matrix, Arabic cold restart, auth,
media, notifications, and deep-link smoke tests. Do not treat the current audit
result as release-ready and do not silence it in CI.
