# NEXA

NEXA is a unified social workspace prototype combining a personalized video feed, messaging, channels, creator studio, and communities in one responsive interface.

## Run locally

```bash
npm install
npm run dev
```

## Frontend-only mode

NEXA currently runs entirely in the browser with Vite and local state. The developer portal, experiments, integrations UI, and owner unlock are local to this browser. No Backend, database, Docker, or API server is required.

This mode is suitable for prototyping only. Local storage can be inspected or cleared, and AI/API integrations are displayed as local configuration until a secure Backend is added.

The current build is a frontend-first prototype with local state for likes, saves, follows, chat selection, sending messages, experimental CoreAuth, device binding, golden verification, and multi-account switching. The API and persistence boundaries are intentionally ready to be connected in the next phase.

## Experimental authentication

- The first three locally created users receive `verification: "gold"` and a gold badge.
- Login and registration continue to `DeviceBindScreen` before opening the home screen.
- `Add account` and `Switch account` are available in the desktop sidebar.
- Demo credentials are stored in browser `localStorage` only. This is intentionally not production authentication; connect the documented CoreAuth API before deploying.

## Product modules

- **HyperBrain surface:** recommendation context and preference controls in the feed.
- **DeepGuard surface:** creator studio protection indicator before publishing.
- **SafeChat boundary:** composer is the integration point for outbound message screening.
- **TrustScore surface:** account trust indicator in the navigation rail.
- **CoreAuth boundary:** profile and device/session settings entry point.
