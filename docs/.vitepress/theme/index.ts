import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import "./custom.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ router }) {
    if (typeof window !== "undefined") {
      import("feedbackkit-web").then(({ FeedbackKit }) => {
        FeedbackKit.configure({
          projectKey: "pk_88dcc559540fd5cea57354c41dc455fcfd13",
          endpoint: "https://gpucoladcyvijefdjudf.supabase.co/functions/v1/ingest-feedback",
          appVersion: "1.0.0",
        });

        FeedbackKit.theme = {
          primaryColorHex: "#1D6FE0",
        };

        const updateScreen = (path: string) => {
          if (!path || path === "/" || path === "/waypack/" || path === "/waypack/index.html") {
            FeedbackKit.currentScreen = "Developer Docs - Overview";
          } else if (path.includes("design")) {
            FeedbackKit.currentScreen = "Developer Docs - Design & Architecture";
          } else if (path.includes("DECISIONS")) {
            FeedbackKit.currentScreen = "Developer Docs - Decisions";
          } else if (path.includes("DEPLOY")) {
            FeedbackKit.currentScreen = "Developer Docs - Deploy";
          } else if (path.includes("STATUS")) {
            FeedbackKit.currentScreen = "Developer Docs - Status";
          } else if (path.includes("store-listing")) {
            FeedbackKit.currentScreen = "Developer Docs - Store Listing";
          } else {
            FeedbackKit.currentScreen = `Developer Docs - ${path}`;
          }
        };

        updateScreen(window.location.pathname);

        router.onAfterRouteChanged = (to) => {
          updateScreen(to);
        };

        FeedbackKit.showFloatingTriggerButton();
        FeedbackKit.enableKeyboardShortcut();
        FeedbackKit.enableFixVerification();

        (window as unknown as { FeedbackKit: typeof FeedbackKit }).FeedbackKit = FeedbackKit;
      });
    }
  },
} satisfies Theme;
