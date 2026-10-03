import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test",
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  use: {
    ...devices["iPhone 13"],
    browserName: "chromium",
    launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
  webServer: {
    // Offline-faithful preview: local extract only, no online tiles, real CSP.
    command: "node ../cli/dist/cli.js preview ../../examples/sequoia-winter --port 4199 --tiles test/fixtures/giant-forest-z14.pmtiles --no-online",
    url: "http://127.0.0.1:4199/t/local/",
    reuseExistingServer: false,
  },
});
