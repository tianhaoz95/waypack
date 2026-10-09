---
layout: home
hero:
  name: "Waypack Architecture"
  text: "Developer & System Documentation"
  tagline: "Turn AI agent itineraries into self-contained bundles that work completely offline with vector maps on mobile devices."
  actions:
    - theme: brand
      text: System Design & Architecture
      link: /design
    - theme: alt
      text: Architecture Decisions (ADRs)
      link: /DECISIONS
    - theme: alt
      text: Deployment Guide
      link: /DEPLOY

features:
  - title: Model Context Protocol (MCP)
    details: Stateless Cloudflare Worker exposing 17 travel planning tools, live WebSocket-free previews, OAuth 2.1 PKCE, and inline bundle uploads.
  - title: Offline Vector Maps
    details: Cloudflare Container running Go + pmtiles extracts region-bounded vector maps from a mirrored OpenStreetMap planet file into compact PMTiles.
  - title: Bundle Sandboxing & SDK
    details: Self-contained HTML + manifest bundles run under strict Content Security Policy inside a Flutter loopback server with zero external network access.
---

## System Architecture

Waypack bridges modern LLM coding and planning agents with real-world travel conditions where cellular signal is intermittent or non-existent.

```mermaid
flowchart TD
    subgraph Agent["AI Agent (Claude, Cursor, Muse, Gemini)"]
        A1["User Conversation"] --> A2["Waypack Skill / Tools"]
    end

    subgraph Backend["Waypack Backend Infrastructure"]
        M1["MCP Server\n(Cloudflare Worker)"]
        S1["Database & Auth\n(Supabase Postgres + RLS)"]
        S2["Object Storage\n(Supabase Storage)"]
        T1["Map Tiler\n(Go + PMTiles Container)"]
    end

    subgraph Client["Waypack App (iOS, Android, macOS)"]
        C1["App Shell (Flutter)"]
        C2["Local Loopback Server"]
        C3["Sandboxed WebView\n(Trip Bundle)"]
        C4["Offline Vector Map\n(MapLibre GL JS + PMTiles)"]
    end

    A2 -->|Streamable HTTP / JSON-RPC| M1
    M1 -->|OAuth 2.1 & Session| S1
    M1 -->|Upload Zip / Manifest| S2
    M1 -->|Queue Tile Extract Job| T1
    T1 -->|Slice Bounding Box| S2

    C1 -->|Download Bundle + Map| S2
    C1 --> C2
    C2 --> C3
    C3 --> C4
```

---

## Subsystem Breakdown

### 1. Trip Bundle Format (`packages/bundle-schema`)
A trip plan is compiled into a static, deterministic zip archive:
* `manifest.json`: Structured source of truth (places, coordinates, routes, schedule, day-by-day activities, emergency contacts, metadata). Validated against JSON Schema v1.
* `index.html`: Entry point of the mobile web application.
* `assets/`: Self-contained JavaScript, CSS, and imagery.
* **Strict Offline CSP**: Prohibits any remote network calls, external fonts, iframes, or CDNs.

### 2. Client-Side Trip SDK (`packages/trip-sdk`)
Exposes `window.Waypack` to the sandboxed web view:
* **Vector Basemap**: Renders regional vector tiles from an offline `.pmtiles` archive using MapLibre GL JS with offline glyphs and sprites.
* **Native Bridges**: Hand-offs to Apple Maps / Google Maps coordinates (`Waypack.openInMaps`), `.ics` offline calendar exports (`Waypack.addToCalendar`), and GPS geolocation tracking.

### 3. Developer Toolchain (`packages/cli`)
The `@waypack/cli` npm package provides local development workflows:
* `waypack init <dir>`: Scaffolds a new trip bundle from starter templates.
* `waypack preview <dir>`: Launches a phone-sized local preview server with authentic Content Security Policy and live tile proxying.
* `waypack validate <dir>`: Verifies structural and schema compliance before publishing.
* `waypack screenshot <dir> [--manifest]`: Captures phone-sized screenshots of the trip into `listing/` for its store-style listing in the account portal.
* `waypack skill install`: Installs the agent skill directly to Claude Code and Cursor.

### 4. Remote MCP Server (`services/mcp`)
A horizontal, stateless Cloudflare Worker implementing the Model Context Protocol:
* Exposes tools: `geocode`, `compute_route`, `validate_bundle`, `push_preview`, `publish_preview`, `upload_bundle_inline`, `list_trips`, `get_trip_status`.
* **Live Previews**: Allows travelers to watch trip plans materialize in real-time on any device before final publishing.
* **Security**: PKCE OAuth 2.1 with Cloudflare OAuth Provider, signed upload/download URLs, and Row-Level Security (RLS).

### 5. Basemap Slicing Engine (`services/tiler`)
A containerized Go microservice:
* Mirrors planet-wide OpenStreetMap vector tiles monthly into R2.
* Receives trip bounding boxes (`bbox`) from the Cloudflare Queue.
* Extracts multi-zoom tile polygons into compact, standalone PMTiles files (~15–80 MB).

### 6. Mobile Viewer (`apps/mobile`)
Built with Flutter for iOS, Android, and macOS:
* Manages offline downloads and cryptographically verifies bundle checksums.
* Hosts bundles on a local loopback HTTP server with ephemeral security tokens.
* Features native Today dashboard, calendar integrations, and an Apple Intelligence on-device offline travel assistant.

---

## Further Reading

* [System Design & Technical Specification](/design): Deep dive into data structures, protocol flows, and security models.
* [Architectural Decisions (ADRs)](/DECISIONS): Complete index of all 55+ recorded architectural decisions and trade-offs.
* [Deployment Guide](/DEPLOY): Step-by-step instructions for deploying the backend, database, container tiler, and mobile apps.
* [Status & Roadmap](/STATUS): Current test coverage, verified platforms, and upcoming milestones.
