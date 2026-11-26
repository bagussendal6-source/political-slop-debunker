// Captures YouTube's rendered caption DOM (not the caption track file), so
// captions must be visible on screen — we turn CC on if it's off.
//
// The caption window only shows the last couple of lines, so a naive
// "does the new text extend the old text" check breaks the moment an old
// line scrolls off — that happens on nearly every line change, which was
// verified against a live video and produced single-word fragments instead
// of sentences. The fix: track the caption box's current contents
// (lastSeenWindow) separately from an accumulator of everything captured
// since the last flush, and on every change append only the part of the
// new window that doesn't overlap the tail of the previous one (word-level
// longest-suffix-is-prefix match). Flush the accumulator on a pause
// (debounce) or once it's been open too long (max window).

const POLL_MS = 300;
const DEBOUNCE_MS = 700; // flush after this long with no caption-box change
const MAX_WINDOW_MS = 6000; // flush anyway if one run of speech goes long
const BLANK_FLUSH_MS = 400; // flush quickly once captions go blank (pause)
const MIN_FLUSH_LENGTH = 3; // skip flushing bare filler like "ee"

const CAPTION_SEGMENT_SELECTOR = ".ytp-caption-segment";
const SUBTITLES_BUTTON_SELECTOR = ".ytp-subtitles-button";

// Page context (title/channel/description/live status) is scraped
// separately from captions and sent as its own message — it changes far
// less often than the transcript and DOM selectors below can lag behind
// yt-navigate-finish (title/description update async after the event), so
// callers retry rather than trusting a single read.
const TITLE_SELECTOR = "#title h1";
const CHANNEL_SELECTOR = "#channel-name a, ytd-channel-name a";
const DESCRIPTION_SELECTOR = "#description-inline-expander";
const LIVE_BADGE_SELECTOR = ".ytp-live-badge";
const CONTEXT_DESCRIPTION_MAX_LENGTH = 400;
const CONTEXT_RETRY_DELAYS_MS = [800, 2000];

let accumulator = "";
let lastSeenWindow = "";
let lastChangeTime = 0;
let windowStartTime = 0;
let blankSince = 0;
let pollTimer = null;

function getCurrentCaptionText() {
  const segments = document.querySelectorAll(CAPTION_SEGMENT_SELECTOR);
  return Array.from(segments)
    .map((el) => el.textContent || "")
    .join(" ");
}

function cleanCaptionText(raw) {
  return raw
    .replace(/\[[^\]]*\]/g, " ") // [Musik], [Tepuk tangan], etc.
    .replace(/\s+/g, " ")
    .trim();
}

// Longest n such that the last n words of `prev` equal the first n words
// of `curr`; returns the words of `curr` after that overlap.
function wordOverlapSuffix(prev, curr) {
  const prevWords = prev.split(" ").filter(Boolean);
  const currWords = curr.split(" ").filter(Boolean);
  const maxOverlap = Math.min(prevWords.length, currWords.length);
  for (let n = maxOverlap; n > 0; n--) {
    const prevTail = prevWords.slice(prevWords.length - n).join(" ");
    const currHead = currWords.slice(0, n).join(" ");
    if (prevTail === currHead) {
      return currWords.slice(n).join(" ");
    }
  }
  return curr;
}

function getPageContext() {
  const titleEl = document.querySelector(TITLE_SELECTOR);
  const title = (titleEl?.textContent || document.title || "").trim();

  const channelEl = document.querySelector(CHANNEL_SELECTOR);
  const channel = (channelEl?.textContent || "").trim();

  const descEl = document.querySelector(DESCRIPTION_SELECTOR);
  let description = (descEl?.textContent || "").replace(/\s+/g, " ").trim();
  if (description.length > CONTEXT_DESCRIPTION_MAX_LENGTH) {
    description = `${description.slice(0, CONTEXT_DESCRIPTION_MAX_LENGTH)}…`;
  }

  const liveBadge = document.querySelector(LIVE_BADGE_SELECTOR);
  const isLive = !!liveBadge && liveBadge.offsetParent !== null;

  return { title, channel, description, isLive };
}

function sendPageContext() {
  chrome.runtime.sendMessage({ type: "PAGE_CONTEXT", context: getPageContext() });
}

function sendPageContextWithRetries() {
  sendPageContext();
  for (const delay of CONTEXT_RETRY_DELAYS_MS) {
    setTimeout(sendPageContext, delay);
  }
}

function sendTranscriptChunk(text) {
  const video = document.querySelector("video");
  chrome.runtime.sendMessage({
    type: "TRANSCRIPT_CHUNK",
    text,
    videoTime: video ? video.currentTime : null,
  });
}

function flush() {
  if (accumulator.trim().length >= MIN_FLUSH_LENGTH) {
    sendTranscriptChunk(accumulator.trim());
  }
  accumulator = "";
  windowStartTime = 0;
  blankSince = 0;
}

function poll() {
  const cleaned = cleanCaptionText(getCurrentCaptionText());
  const now = Date.now();

  if (!cleaned) {
    if (accumulator) {
      if (!blankSince) blankSince = now;
      else if (now - blankSince >= BLANK_FLUSH_MS) flush();
    }
    lastSeenWindow = "";
    return;
  }
  blankSince = 0;

  if (cleaned !== lastSeenWindow) {
    const newPart = wordOverlapSuffix(lastSeenWindow, cleaned).trim();
    if (newPart) {
      accumulator = accumulator ? `${accumulator} ${newPart}` : newPart;
    }
    if (!windowStartTime) windowStartTime = now;
    lastChangeTime = now;
    lastSeenWindow = cleaned;
  }

  const idle = now - lastChangeTime;
  const windowAge = now - (windowStartTime || now);
  if (accumulator && (idle >= DEBOUNCE_MS || windowAge >= MAX_WINDOW_MS)) {
    flush();
  }
}

function ensureCaptionsOn() {
  const button = document.querySelector(SUBTITLES_BUTTON_SELECTOR);
  if (button && button.getAttribute("aria-pressed") === "false") {
    button.click();
  }
}

function getVideoId() {
  return new URLSearchParams(location.search).get("v");
}

let lastVideoId = getVideoId();

// YouTube is an SPA — navigating to a different video doesn't reload this
// content script, so the panel needs an explicit signal to know the video
// (and therefore the "same video" history the analysis flags rely on)
// actually changed, rather than just another yt-navigate-finish firing for
// an unrelated in-page transition.
function resetForNewVideo() {
  accumulator = "";
  lastSeenWindow = "";
  lastChangeTime = 0;
  windowStartTime = 0;
  blankSince = 0;

  const videoId = getVideoId();
  if (videoId !== lastVideoId) {
    lastVideoId = videoId;
    chrome.runtime.sendMessage({ type: "VIDEO_CHANGED" });
    sendPageContextWithRetries();
  }
}

function start() {
  if (pollTimer) return;
  ensureCaptionsOn();
  pollTimer = setInterval(() => {
    ensureCaptionsOn();
    poll();
  }, POLL_MS);
}

document.addEventListener("yt-navigate-finish", resetForNewVideo);
start();
chrome.runtime.sendMessage({ type: "CONTENT_READY" });
sendPageContextWithRetries();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "PING") {
    sendResponse({ type: "PONG", url: location.href });
    return true;
  }
  if (message?.type === "DEBUG_LOG") {
    console.log("[FactChecker Pipeline]", message.text);
    return false;
  }
});
