chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ installed: Date.now() });
});
