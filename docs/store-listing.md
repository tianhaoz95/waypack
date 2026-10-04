# Store listing copy (App Store + Google Play)

**App name:** Waypack: Offline Trip Plans
**Subtitle (iOS, 30):** Agent-made trips, offline
**Short description (Play, 80):** Trip plans from your AI agent, with an offline map, GPS and itinerary.
**Bundle / package id:** `com.hejitech.waypack`
**Category:** Travel (secondary: Navigation)
**Age rating:** 4+ / Everyone
**Price:** Free. No in-app purchases (Waypack Pro is sold on waypack.app; the app is a companion viewer).

## Description
Your AI agent plans the trip. Waypack keeps it working when the signal drops.

Ask Claude, Cursor or any AI agent that supports MCP to plan a trip “with Waypack”. It interviews you, researches, and publishes a detailed trip guide to your Waypack account. Open the app, tap Download while you have signal, and everything works in airplane mode:

• Today view: what's happening now and next, one tap away
• Day-by-day itinerary with times, drive durations and the reasons behind the plan
• Lodging, confirmation numbers, check-in times, phone numbers
• Offline map (Pro): trails, roads and labels for your trip area, your planned routes, and your live GPS position, no cell service needed
• Navigate buttons that hand off to Google Maps or Apple Maps
• Packing list, budget, emergency info, backup plans, live-check links for road and park conditions
• Reminder to download before you go

Waypack is a viewer for your own plans: planning and edits happen in your AI agent, and updates arrive in the app with one tap.

The app is free. A Waypack account is required.

Map data © OpenStreetMap contributors (ODbL). Basemap by Protomaps.

## Keywords (iOS, 100)
offline map,itinerary,trip planner,national park,hiking,road trip,AI,Claude,travel guide,GPS

## What's New (1.0)
First release: download trips from your AI agent, offline maps with GPS, native Today view.

## Review notes (App Store)
- Waypack displays trip guides the user created with their own AI agent (via our MCP server). Bundles are documents (HTML/CSS/JS + JSON) rendered in a sandboxed WebView from a local loopback server; they cannot change native functionality, access the network (CSP `connect-src 'self'`), or reach other trips.
- Native features: offline download manager with integrity checks, native Today view, GPS map, trip reminders, share sheet.
- **Guideline 3.1.3(f):** Waypack is a free stand-alone companion to a paid web service (cloud storage of trip plans + offline map generation, sold at waypack.app). The app contains no purchasing and no calls to action for purchasing outside the app; it only displays the account's current plan.
- Sign-in: Sign in with Apple or Google (no passwords). Reviewers can use their own Apple ID. **To do before submission:** create a dedicated demo Google account, publish the sample Sequoia trip to it, and put its credentials in the App Review notes.
- Location is used only to show the user's position on the offline map (When In Use).

## Privacy nutrition label / Data safety
| Data | Collected | Linked to user | Tracking | Purpose |
|---|---|---|---|---|
| Email address / name (from Apple or Google sign-in) | Yes | Yes | No | App functionality (sign-in) |
| User content (trip plans) | Yes | Yes | No | App functionality |
| Precise location | No (stays on device) | — | — | — |
| Diagnostics | No | — | — | — |

## Screenshots (6.9" and 6.5", Play phone)
1. Today: "Now · Sledding & snow play" (`site/img/today.jpg`)
2. Offline map with routes and blue dot
3. Day plan with "why this order" notes
4. Guide: packing list with checkboxes
5. Trips list: "Available offline"
6. Settings: connect your agent

Capture at device resolution from the simulator (`xcrun simctl io booted screenshot`) using the seeded dev account (`services/mcp/scripts/seed-dev.mjs`).
