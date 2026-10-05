(function () {
  function initFeedbackKit() {
    if (typeof window === "undefined" || !window.FeedbackKit) return;

    FeedbackKit.configure({
      projectKey: "pk_88dcc559540fd5cea57354c41dc455fcfd13",
      endpoint: "https://gpucoladcyvijefdjudf.supabase.co/functions/v1/ingest-feedback",
      appVersion: "1.0.1",
    });

    FeedbackKit.theme = {
      primaryColorHex: "#1D6FE0",
    };

    var path = window.location.pathname;
    if (path === "/" || path === "/index.html" || path === "") {
      FeedbackKit.currentScreen = "Landing";
    } else if (path.startsWith("/account")) {
      FeedbackKit.currentScreen = "Account";
    } else if (path.startsWith("/join")) {
      FeedbackKit.currentScreen = "Join";
    } else if (path.startsWith("/remix")) {
      FeedbackKit.currentScreen = "Remix";
    } else if (path.startsWith("/privacy")) {
      FeedbackKit.currentScreen = "Privacy";
    } else if (path.startsWith("/terms")) {
      FeedbackKit.currentScreen = "Terms";
    } else {
      FeedbackKit.currentScreen = path;
    }

    FeedbackKit.showFloatingTriggerButton();
    FeedbackKit.enableFixVerification();
  }

  if (window.FeedbackKit) {
    initFeedbackKit();
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initFeedbackKit);
  } else {
    initFeedbackKit();
  }
})();
