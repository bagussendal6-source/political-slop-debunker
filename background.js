chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete" || !tab.url) return;
  const onYouTube = tab.url.startsWith("https://www.youtube.com/");
  chrome.sidePanel.setOptions({
    tabId,
    path: "sidepanel.html",
    enabled: onYouTube,
  });
});
