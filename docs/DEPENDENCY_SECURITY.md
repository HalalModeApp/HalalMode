# Dependency security status

Last assessed: 2026-07-29.

The Expo 57 / React Native 0.86 upgrade removed the 20 high advisories that were
present in the Expo 54 tree. `npm audit --omit=dev` now reports **0 high, 0
critical, and 11 moderate** advisories, all inside Expo tooling dependencies.
The audit database currently suggests incompatible historical Expo versions as
the remedy, so `npm audit fix --force` remains unsafe.

Expo Doctor is currently clean (20/20 checks): direct `expo-asset` and
`expo-linking` peers are installed, and native module duplicates were removed.

Before a public release, complete a fresh Expo 57 development build and full
Android/iOS device matrix: Arabic cold restart, auth, media, notifications, and
deep-link smoke tests. Do not silence the remaining audit result in CI.
