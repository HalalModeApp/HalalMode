# Native smoke flows

Run these against an Expo development build with mock mode enabled. They use
stable `testID` selectors, not coordinates. Real-backend flows belong in a
separate isolated test project because they create authenticated state.

```bash
maestro test maestro
```

The CI job is intentionally not enabled until an Android development build is
available to the runner; the flows are source-controlled readiness contracts.
