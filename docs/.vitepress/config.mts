import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Waypack Developer Docs",
  description: "Architectural designs, data formats, offline vector maps, and backend pipelines for Waypack",
  base: "/waypack/",
  head: [
    ["link", { rel: "icon", href: "/waypack/favicon.svg", type: "image/svg+xml" }],
    ["link", { rel: "icon", href: "/waypack/favicon.png", type: "image/png" }],
  ],
  themeConfig: {
    logo: "/favicon.svg",
    siteTitle: "Waypack Dev",
    nav: [
      { text: "Overview", link: "/" },
      { text: "Architecture & Design", link: "/design" },
      { text: "Decisions (ADRs)", link: "/DECISIONS" },
      { text: "Deploy", link: "/DEPLOY" },
      { text: "Status", link: "/STATUS" },
    ],
    sidebar: [
      {
        text: "System Overview",
        items: [
          { text: "Developer Guide & Architecture", link: "/" },
          { text: "System Design & Specification", link: "/design" },
          { text: "Project Status & Roadmap", link: "/STATUS" },
        ],
      },
      {
        text: "Architecture & Operations",
        items: [
          { text: "Architectural Decisions (ADRs)", link: "/DECISIONS" },
          { text: "Deployment & Infrastructure", link: "/DEPLOY" },
          { text: "Store Listing & Distribution", link: "/store-listing" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/tianhaoz95/waypack" }],
    search: {
      provider: "local",
    },
    footer: {
      message: "Released under the PolyForm Perimeter License 1.0.1.",
      copyright: "Copyright © 2026 Tianhao Zhou & Waypack Contributors",
    },
  },
});
