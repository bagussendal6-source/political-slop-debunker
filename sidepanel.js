function buildDefaultEnabledChecks() {
  const checks = { claims: true };
  for (const code of CATEGORIES_LIB.ALL_CODES) checks[code] = true;
  return checks;
}

const DEFAULT_SETTINGS = {
  apiKey: "",
  language: "id",
  model: "claude-sonnet-4-6",
  detectModel: "haiku",
  significanceThreshold: "sedang",
  provider: "anthropic",
  enabledChecks: buildDefaultEnabledChecks(),
  manualContext: "",
};

const appMainEl = document.getElementById("app-main");
const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("status-text");
const transcriptEl = document.getElementById("transcript");
const transcriptEmpty = document.getElementById("transcript-empty");
const resultsScanningEl = document.getElementById("results-scanning");
const resultsScanningTextEl = document.getElementById("results-scanning-text");
const processLogToggleBtn = document.getElementById("process-log-toggle");
const processLogEl = document.getElementById("process-log");
const processLogList = document.getElementById("process-log-list");
const processLogEmpty = document.getElementById("process-log-empty");

const settingsToggleBtn = document.getElementById("settings-toggle");
const settingsPanel = document.getElementById("settings-panel");
const providerSelect = document.getElementById("provider");
const apiKeyInput = document.getElementById("api-key");
const toggleKeyVisibilityBtn = document.getElementById("toggle-key-visibility");
const languageSelect = document.getElementById("language");
const modelSelect = document.getElementById("model");
const detectModelSelect = document.getElementById("detect-model");
const significanceThresholdSelect = document.getElementById("significance-threshold");
const manualContextInput = document.getElementById("manual-context");
const saveSettingsBtn = document.getElementById("save-settings");
const settingsSavedHint = document.getElementById("settings-saved");
const checksListEl = document.getElementById("checks-list");

const contextToggleBtn = document.getElementById("context-toggle");
const contextFieldsEl = document.getElementById("context-fields");
const contextBadgeEl = document.getElementById("context-badge");
const contextDetectedEl = document.getElementById("context-detected");

const clearBtn = document.getElementById("clear-btn");
const exportBtn = document.getElementById("export-btn");
const statsBarEl = document.getElementById("stats-bar");
const statWordsEl = document.getElementById("stat-words");
const statClaimsEl = document.getElementById("stat-claims");
const statTrueEl = document.getElementById("stat-true");
const statFalseEl = document.getElementById("stat-false");
const statPatternsEl = document.getElementById("stat-patterns");

const tooltipEl = document.getElementById("mark-tooltip");
const mtVerdictEl = tooltipEl.querySelector(".mt-verdict");
const mtSummaryEl = tooltipEl.querySelector(".mt-summary");
const detailModalEl = document.getElementById("detail-modal");
const modalBodyEl = document.getElementById("modal-body");
const modalCloseBtn = document.getElementById("modal-close");

let currentLanguage = DEFAULT_SETTINGS.language;
let currentStatusKey = "statusWaitingTab";
let currentPipelineState = "idle"; // "idle" | "buffering" | "scanning"
let activeTabId = null;

// Relays a line to the YouTube tab's own console via the content script.
// Exists purely so pipeline activity (detect call results, errors) can be
// observed from the tab's console — the side panel is a separate extension
// page whose console isn't reachable by the same tooling that can read a
// regular tab's console. Best-effort: swallows errors (e.g. no receiver
// while the content script is reloading) since this is a debug aid, not a
// path anything else depends on.
function relayDebugLog(text) {
  if (!activeTabId) return;
  chrome.tabs.sendMessage(activeTabId, { type: "DEBUG_LOG", text }).catch(() => {});
}

// ---------- i18n ----------

function applyLanguage(lang) {
  currentLanguage = lang;
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = I18N.t(el.dataset.i18n, lang);
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
    el.setAttribute("aria-label", I18N.t(el.dataset.i18nAriaLabel, lang));
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.setAttribute("placeholder", I18N.t(el.dataset.i18nPlaceholder, lang));
  });
  updateKeyVisibilityLabel();
  renderStatus();
  renderPipelineState();
  renderContextUI();
}

function setStatus(kind, key) {
  currentStatusKey = key;
  statusEl.className = `status status--${kind}`;
  renderStatus();
}

function renderStatus() {
  statusTextEl.textContent = I18N.t(currentStatusKey, currentLanguage);
}

function setPipelineState(state) {
  currentPipelineState = state;
  renderPipelineState();
}

function renderPipelineState() {
  if (currentPipelineState === "idle") {
    resultsScanningEl.hidden = true;
    return;
  }
  const key = currentPipelineState === "buffering" ? "resultsBuffering" : "resultsScanning";
  resultsScanningTextEl.textContent = I18N.t(key, currentLanguage);
  resultsScanningEl.hidden = false;
}

// ---------- Settings ----------

settingsToggleBtn.addEventListener("click", () => {
  const open = settingsPanel.hidden;
  settingsPanel.hidden = !open;
  settingsToggleBtn.setAttribute("aria-expanded", String(open));
});

function updateKeyVisibilityLabel() {
  const key = apiKeyInput.type === "password" ? "settingsShowKey" : "settingsHideKey";
  toggleKeyVisibilityBtn.setAttribute("aria-label", I18N.t(key, currentLanguage));
  const iconName = apiKeyInput.type === "password" ? "eye" : "eye-off";
  toggleKeyVisibilityBtn.querySelector(".icon").innerHTML = ICONS.iconSvg(iconName);
}

toggleKeyVisibilityBtn.addEventListener("click", () => {
  apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
  updateKeyVisibilityLabel();
});

// Checkbox labels for the 9 categories are hardcoded Indonesian, same as
// their badge text elsewhere — those describe patterns in Indonesian
// political speech and stay Indonesian regardless of UI language, unlike
// the surrounding chrome (buttons, headings) which is translated.
function renderChecksList() {
  checksListEl.innerHTML = "";
  // Pattern/flag checkboxes are hidden while POLA_FEATURE_ENABLED is false
  // in lib/pipeline.js — showing togglable checkboxes for a feature that's
  // hard-disabled underneath would be misleading. Only "claims" remains.
  const items = [{ key: "claims", label: "Periksa Fakta (klaim numerik/statistik)" }];
  for (const item of items) {
    const row = document.createElement("label");
    row.className = "check-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = true;
    input.dataset.checkKey = item.key;
    row.append(input, document.createTextNode(item.label));
    checksListEl.appendChild(row);
  }
}

function getEnabledChecksFromUI() {
  const enabledChecks = {};
  checksListEl.querySelectorAll("input[type=checkbox]").forEach((input) => {
    enabledChecks[input.dataset.checkKey] = input.checked;
  });
  return enabledChecks;
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  providerSelect.value = stored.provider;
  apiKeyInput.value = stored.apiKey;
  languageSelect.value = stored.language;
  modelSelect.value = stored.model;
  detectModelSelect.value = stored.detectModel;
  significanceThresholdSelect.value = stored.significanceThreshold;
  manualContextInput.value = stored.manualContext || "";
  checksListEl.querySelectorAll("input[type=checkbox]").forEach((input) => {
    input.checked = stored.enabledChecks?.[input.dataset.checkKey] !== false;
  });
  applyLanguage(stored.language);
}

async function saveSettings() {
  const settings = {
    provider: providerSelect.value,
    apiKey: apiKeyInput.value.trim(),
    language: languageSelect.value,
    model: modelSelect.value,
    detectModel: detectModelSelect.value,
    significanceThreshold: significanceThresholdSelect.value,
    manualContext: manualContextInput.value.trim(),
    enabledChecks: getEnabledChecksFromUI(),
  };
  await chrome.storage.local.set(settings);
  applyLanguage(settings.language);
  settingsSavedHint.textContent = I18N.t("settingsSaved", currentLanguage);
  settingsSavedHint.hidden = false;
  setTimeout(() => {
    settingsSavedHint.hidden = true;
  }, 2000);
}

languageSelect.addEventListener("change", () => applyLanguage(languageSelect.value));
saveSettingsBtn.addEventListener("click", saveSettings);

// Manual context lives on the main surface (not tucked in settings), so it
// persists as soon as the user leaves the field rather than requiring a
// trip to Settings → Save.
manualContextInput.addEventListener("change", () => {
  chrome.storage.local.set({ manualContext: manualContextInput.value.trim() });
});

// ---------- Context section ----------

contextToggleBtn.addEventListener("click", () => {
  const open = contextFieldsEl.hidden;
  contextFieldsEl.hidden = !open;
  contextToggleBtn.setAttribute("aria-expanded", String(open));
});

// Populated from content.js's PAGE_CONTEXT message (video title/channel/
// description/live status). Fed into every prompt so the model knows what
// video/speaker it's evaluating, not just the raw transcript window — see
// getContextString().
let pageContext = { title: "", channel: "", description: "", isLive: false };

function resetPageContext() {
  pageContext = { title: "", channel: "", description: "", isLive: false };
}

function getContextString() {
  const parts = [];
  if (pageContext.title) parts.push(`Judul video: ${pageContext.title}`);
  if (pageContext.channel) parts.push(`Channel: ${pageContext.channel}`);
  if (pageContext.isLive) parts.push("Status: siaran langsung (live)");
  if (pageContext.description) parts.push(`Deskripsi: ${pageContext.description}`);
  const manual = manualContextInput?.value?.trim();
  if (manual) parts.push(`Catatan tambahan dari pengguna: ${manual}`);
  return parts.join("\n");
}

function renderContextUI() {
  const hasAuto = !!(pageContext.title || pageContext.channel || pageContext.description);
  contextBadgeEl.textContent = I18N.t(hasAuto ? "contextBadgeAuto" : "contextBadgeNone", currentLanguage);
  contextBadgeEl.classList.toggle("badge--active", hasAuto);
  const parts = [];
  if (pageContext.title) parts.push(`${pageContext.title}`);
  if (pageContext.channel) parts.push(`${pageContext.channel}`);
  if (pageContext.isLive) parts.push("LIVE");
  contextDetectedEl.textContent = parts.join(" · ");
}

// ---------- Active tab tracking ----------

async function checkActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url || !tab.url.startsWith("https://www.youtube.com/")) {
    activeTabId = null;
    setStatus("pending", "statusWaitingTab");
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "PING" });
    if (response?.type === "PONG") {
      activeTabId = tab.id;
      setStatus("ok", "statusConnected");
    } else {
      activeTabId = null;
      setStatus("pending", "statusWaitingScript");
    }
  } catch {
    activeTabId = null;
    setStatus("pending", "statusWaitingScript");
  }
}

// ---------- Transcript feed ----------

let wordCount = 0;

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function autoScrollMain() {
  if (appMainEl.scrollHeight - appMainEl.scrollTop - appMainEl.clientHeight < 80) {
    appMainEl.scrollTop = appMainEl.scrollHeight;
  }
}

function appendTranscriptChunk(text, videoTime) {
  transcriptEmpty.hidden = true;
  wordCount += text.split(/\s+/).filter(Boolean).length;

  const block = document.createElement("span");
  block.className = "transcript-block";
  const t = typeof videoTime === "number" ? formatTime(videoTime) : "--:--";
  const timeSpan = document.createElement("span");
  timeSpan.className = "t-time";
  timeSpan.textContent = `[${t}]`;
  block.append(timeSpan, document.createTextNode(`${text} `));
  transcriptEl.appendChild(block);

  autoScrollMain();
  updateStats();
}

// ---------- Claim / flag stores ----------
// Rendering no longer uses separate cards — claims and flags are
// highlighted directly inside the transcript text (see highlightInTranscript
// below). These maps hold the full detail behind each highlighted mark, for
// the hover tooltip and click-through modal.

const claimsStore = new Map(); // id -> { claimText, quote, verdict, explanation, sources }
const flagsStore = new Map(); // id -> { statement, quote, categories: Map(code -> {tier, verdict, explanation, sources, comparison, anchorQuote, anchorSource}) }

const VERDICT_DISPLAY = { SHED: "TIDAK SEMPAT DIPERIKSA" };
const CLAIM_MARK_CLASS = {
  BENAR: "t-mark--true",
  SALAH: "t-mark--false",
  MENYESATKAN: "t-mark--misleading",
  "TIDAK DAPAT DIVERIFIKASI": "t-mark--unverifiable",
  SHED: "t-mark--shed",
};
const VERDICT_MODAL_CLASS = {
  BENAR: "true",
  SALAH: "false",
  MENYESATKAN: "misleading",
  "TIDAK DAPAT DIVERIFIKASI": "unverifiable",
  SHED: "unverifiable",
};

function updateStats() {
  let trueCount = 0;
  let falseCount = 0;
  let patternCount = 0;
  for (const c of claimsStore.values()) {
    if (c.verdict === "BENAR") trueCount++;
    else if (c.verdict === "SALAH" || c.verdict === "MENYESATKAN") falseCount++;
    for (const pat of c.patterns.values()) {
      if (pat.verdict === "TERINDIKASI") patternCount++;
    }
  }
  for (const f of flagsStore.values()) {
    for (const cat of f.categories.values()) {
      if (cat.verdict === "TERINDIKASI") patternCount++;
    }
  }
  statWordsEl.textContent = String(wordCount);
  statClaimsEl.textContent = String(claimsStore.size);
  statTrueEl.textContent = String(trueCount);
  statFalseEl.textContent = String(falseCount);
  statPatternsEl.textContent = String(patternCount);
  statsBarEl.hidden = wordCount === 0;
}

// ---------- Inline highlighting ----------

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Wraps the first un-marked occurrence of quoteText in a <mark>, walking
// transcript text nodes directly (case-insensitive substring match). The
// quote should already be on screen — it was captured from a transcript
// chunk before ever being sent to the detect pass.
function wrapQuoteInTranscript(quoteText, markId, kind) {
  const escaped = escapeRegExp(quoteText.trim());
  if (!escaped) return false;
  const pattern = new RegExp(escaped, "i");
  const blocks = transcriptEl.querySelectorAll(".transcript-block");

  for (const block of blocks) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      if (!walker.currentNode.parentElement.classList.contains("t-mark")) nodes.push(walker.currentNode);
    }
    for (const node of nodes) {
      const match = node.textContent.match(pattern);
      if (!match) continue;
      const idx = match.index;
      const before = node.textContent.slice(0, idx);
      const matched = node.textContent.slice(idx, idx + match[0].length);
      const after = node.textContent.slice(idx + match[0].length);
      const mark = document.createElement("mark");
      mark.className = "t-mark t-mark--pending";
      mark.dataset.markId = markId;
      mark.dataset.markKind = kind;
      mark.textContent = matched;
      const frag = document.createDocumentFragment();
      if (before) frag.appendChild(document.createTextNode(before));
      frag.appendChild(mark);
      if (after) frag.appendChild(document.createTextNode(after));
      node.parentNode.replaceChild(frag, node);
      return true;
    }
  }
  return false;
}

// Fallback for when the quote doesn't match verbatim (caption reconstruction
// drift): appends a small indicator to whichever transcript block shares the
// most distinctive words with the quote.
function appendFuzzyIndicator(quoteText, summaryText, markId, kind) {
  const blocks = Array.from(transcriptEl.querySelectorAll(".transcript-block"));
  const words = quoteText.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  let best = null;
  let bestScore = 0;
  for (const b of blocks) {
    const bt = b.textContent.toLowerCase();
    const score = words.filter((w) => bt.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  const mark = document.createElement("mark");
  mark.className = "t-mark t-mark--pending t-mark-indicator";
  mark.dataset.markId = markId;
  mark.dataset.markKind = kind;
  const preview = summaryText.length > 40 ? `${summaryText.slice(0, 40)}…` : summaryText;
  mark.textContent = ` [${preview}]`;
  const threshold = Math.min(3, words.length);
  if (best && bestScore >= threshold) {
    best.appendChild(mark);
  } else {
    transcriptEl.appendChild(mark);
  }
}

function highlightInTranscript(markId, quoteText, summaryText, kind) {
  if (!wrapQuoteInTranscript(quoteText, markId, kind)) {
    appendFuzzyIndicator(quoteText, summaryText, markId, kind);
  }
}

function setMarkVerdictClass(mark, cls) {
  mark.classList.remove(
    "t-mark--pending",
    "t-mark--true",
    "t-mark--false",
    "t-mark--misleading",
    "t-mark--unverifiable",
    "t-mark--shed",
    "t-mark--flag-hit",
    "t-mark--flag-clear",
    "t-mark--caution",
  );
  mark.classList.add(cls);
}

// ---------- Claims ----------

// Every claim also carries a `patterns` map — the same 5 anchored-tier
// categories a flag can have, piggybacked onto the claim's own verify call
// (see buildVerifyPrompt/verifyClaim in lib/pipeline.js) rather than
// depending on the detect pass to notice them independently. Pre-populated
// pending so the modal can render all 5 rows and fill them in as the
// (single) verify call resolves.
function registerClaim(id, claimText, quoteText) {
  const patterns = new Map();
  for (const code of CATEGORIES_LIB.ANCHORED_CODES) {
    patterns.set(code, {
      verdict: "pending",
      explanation: "",
      sources: [],
      comparison: null,
      anchorQuote: "",
      anchorSource: null,
    });
  }
  claimsStore.set(id, { claimText, quote: quoteText, verdict: "pending", explanation: "", sources: [], patterns });
  highlightInTranscript(id, quoteText, claimText, "claim");
  updateStats();
}

function updateClaimResult(id, result) {
  const entry = claimsStore.get(id);
  if (!entry) return;
  if (result.shed) {
    entry.verdict = "SHED";
    for (const pat of entry.patterns.values()) {
      if (pat.verdict === "pending") pat.verdict = "shed";
    }
  } else {
    entry.verdict = result.verdict;
    entry.explanation = result.explanation || "";
    entry.sources = result.sources || [];
    for (const pat of result.patterns || []) {
      const existing = entry.patterns.get(pat.category);
      if (!existing) continue;
      existing.verdict = pat.verdict;
      existing.explanation = pat.explanation || "";
      existing.sources = pat.sources || [];
      existing.comparison = pat.comparison || null;
      existing.anchorQuote = pat.anchorQuote || "";
      existing.anchorSource = pat.anchorSource || null;
    }
  }
  const cls = CLAIM_MARK_CLASS[entry.verdict] || "t-mark--unverifiable";
  transcriptEl.querySelectorAll(`[data-mark-id="${id}"]`).forEach((m) => setMarkVerdictClass(m, cls));
  updateStats();
}

// ---------- Flags ----------

function computeFlagMarkClass(entry) {
  let anyHit = false;
  let anyPending = false;
  let anyCaution = false;
  for (const cat of entry.categories.values()) {
    if (cat.verdict === "pending") anyPending = true;
    else if (cat.verdict === "TERINDIKASI") anyHit = true;
    else if (cat.verdict === "caution") anyCaution = true;
  }
  if (anyHit) return "t-mark--flag-hit";
  if (anyPending) return "t-mark--pending";
  if (anyCaution) return "t-mark--caution";
  return "t-mark--flag-clear";
}

function registerFlag(id, statement, quoteText, categories) {
  const categoryMap = new Map();
  for (const cat of categories) {
    const meta = CATEGORIES_LIB.CATEGORIES[cat.code];
    if (!meta) continue;
    if (meta.tier === "caution") {
      categoryMap.set(cat.code, { tier: meta.tier, verdict: "caution", explanation: cat.reason || "", sources: [] });
    } else {
      categoryMap.set(cat.code, { tier: meta.tier, verdict: "pending", explanation: "", sources: [] });
    }
  }
  const entry = { statement, quote: quoteText, categories: categoryMap };
  flagsStore.set(id, entry);
  highlightInTranscript(id, quoteText, statement, "flag");
  const cls = computeFlagMarkClass(entry);
  transcriptEl.querySelectorAll(`[data-mark-id="${id}"]`).forEach((m) => setMarkVerdictClass(m, cls));
  updateStats();
}

function updateFlagResult(id, payload) {
  const entry = flagsStore.get(id);
  if (!entry) return;
  if (payload.shed) {
    for (const code of payload.categoryCodes || []) {
      const cat = entry.categories.get(code);
      if (cat && cat.verdict === "pending") cat.verdict = "shed";
    }
  } else {
    for (const result of payload.results || []) {
      const cat = entry.categories.get(result.category);
      if (!cat) continue;
      cat.verdict = result.verdict;
      cat.explanation = result.explanation || "";
      cat.sources = result.sources || [];
      cat.comparison = result.comparison || null;
      cat.anchorQuote = result.anchorQuote || "";
      cat.anchorSource = result.anchorSource || null;
    }
  }
  const cls = computeFlagMarkClass(entry);
  transcriptEl.querySelectorAll(`[data-mark-id="${id}"]`).forEach((m) => setMarkVerdictClass(m, cls));
  updateStats();
}

// ---------- Hover tooltip ----------

function showTooltip(mark) {
  const id = mark.dataset.markId;
  const kind = mark.dataset.markKind;
  let verdictText = "";
  let summaryText = "";

  if (kind === "claim") {
    const entry = claimsStore.get(id);
    if (!entry) return;
    verdictText =
      entry.verdict === "pending"
        ? I18N.t("tooltipVerifying", currentLanguage)
        : VERDICT_DISPLAY[entry.verdict] || entry.verdict;
    summaryText = entry.explanation || entry.claimText;
  } else {
    const entry = flagsStore.get(id);
    if (!entry) return;
    const hits = Array.from(entry.categories.entries()).filter(
      ([, c]) => c.verdict === "TERINDIKASI" || c.verdict === "caution",
    );
    if (hits.length) {
      verdictText = hits
        .map(([code]) => {
          const meta = CATEGORIES_LIB.CATEGORIES[code];
          return meta?.positiveLabel || meta?.label || code;
        })
        .join(", ");
      summaryText = hits[0][1].explanation || entry.statement;
    } else {
      const anyPending = Array.from(entry.categories.values()).some((c) => c.verdict === "pending");
      verdictText = anyPending ? I18N.t("tooltipVerifying", currentLanguage) : "TIDAK TERINDIKASI";
      summaryText = entry.statement;
    }
  }

  mtVerdictEl.textContent = verdictText;
  mtSummaryEl.textContent = summaryText.length > 140 ? `${summaryText.slice(0, 140)}…` : summaryText;
  tooltipEl.hidden = false;

  const rect = mark.getBoundingClientRect();
  requestAnimationFrame(() => {
    const tRect = tooltipEl.getBoundingClientRect();
    let top = rect.top - tRect.height - 8;
    let left = rect.left + rect.width / 2 - tRect.width / 2;
    if (top < 4) top = rect.bottom + 8;
    if (left < 4) left = 4;
    if (left + tRect.width > window.innerWidth - 4) left = window.innerWidth - tRect.width - 4;
    tooltipEl.style.top = `${top}px`;
    tooltipEl.style.left = `${left}px`;
  });
}

function hideTooltip() {
  tooltipEl.hidden = true;
}

// ---------- Click-through detail modal ----------

function buildSourcesEl(sources) {
  const wrap = document.createElement("div");
  wrap.className = "claim-sources";
  for (const source of sources) {
    const link = document.createElement("a");
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = source.title || source.url;
    wrap.appendChild(link);
  }
  return wrap;
}

function renderComparison(comparison) {
  const box = document.createElement("div");
  box.className = "flag-comparison";
  for (const [label, value] of [
    [comparison.claimedLabel, comparison.claimedValue],
    [comparison.actualLabel, comparison.actualValue],
  ]) {
    const row = document.createElement("div");
    row.className = "flag-comparison__row";
    const labelEl = document.createElement("span");
    labelEl.className = "flag-comparison__label";
    labelEl.textContent = label;
    const valueEl = document.createElement("span");
    valueEl.className = "flag-comparison__value";
    valueEl.textContent = value;
    row.append(labelEl, valueEl);
    box.appendChild(row);
  }
  return box;
}

function renderClaimModalBody(entry) {
  const verdictEl = document.createElement("div");
  const vCls = VERDICT_MODAL_CLASS[entry.verdict] || "unverifiable";
  verdictEl.className = `modal-verdict modal-verdict--${vCls}`;
  verdictEl.textContent =
    entry.verdict === "pending"
      ? I18N.t("tooltipVerifying", currentLanguage)
      : VERDICT_DISPLAY[entry.verdict] || entry.verdict;

  const claimEl = document.createElement("p");
  claimEl.className = "modal-claim";
  claimEl.textContent = entry.claimText;

  const quoteEl = document.createElement("p");
  quoteEl.className = "modal-quote";
  quoteEl.textContent = `"${entry.quote}"`;

  modalBodyEl.append(verdictEl, claimEl, quoteEl);

  if (entry.explanation) {
    const exp = document.createElement("p");
    exp.className = "claim-explanation";
    exp.textContent = entry.explanation;
    modalBodyEl.appendChild(exp);
  }
  if (entry.sources?.length) {
    modalBodyEl.appendChild(buildSourcesEl(entry.sources));
  }

  // Anchored-pattern results piggybacked on this claim's own verify call
  // (see registerClaim/updateClaimResult) — only surfaced here if still
  // being checked or an actual hit, so an ordinary claim with nothing
  // notable doesn't get cluttered with 5 rows of "TIDAK CUKUP BUKTI".
  const visiblePatterns = Array.from(entry.patterns?.entries() || []).filter(
    ([, pat]) => pat.verdict === "pending" || pat.verdict === "TERINDIKASI",
  );
  if (visiblePatterns.length > 0) {
    const header = document.createElement("p");
    header.className = "modal-patterns-heading";
    header.textContent = "Pola tambahan yang ditemukan pada klaim ini";
    modalBodyEl.appendChild(header);
    for (const [code, pat] of visiblePatterns) {
      const section = renderCategorySection(code, pat);
      if (section) modalBodyEl.appendChild(section);
    }
  }
}

// Shared renderer for one category's result block — used both for flag
// cards (all categories requested) and for the claim modal's piggybacked
// pattern rows (filtered to pending/hit only, see renderClaimModalBody).
function renderCategorySection(code, catData) {
  const meta = CATEGORIES_LIB.CATEGORIES[code];
  if (!meta) return null;
  const section = document.createElement("div");
  section.className = "modal-category";

  const nameEl = document.createElement("p");
  nameEl.className = "modal-category__name";
  nameEl.textContent = meta.label;
  section.appendChild(nameEl);

  const badge = document.createElement("div");
  let cls;
  let text;
  if (catData.verdict === "pending") {
    cls = "unverifiable";
    text = I18N.t("tooltipVerifying", currentLanguage);
  } else if (catData.verdict === "shed") {
    cls = "unverifiable";
    text = "TIDAK SEMPAT DIPERIKSA";
  } else if (catData.verdict === "caution") {
    cls = "caution";
    text = meta.label.toUpperCase();
  } else if (catData.verdict === "TERINDIKASI") {
    cls = "flag-hit";
    text = meta.positiveLabel || meta.label;
  } else {
    cls = "flag-clear";
    text = meta.clearLabel || catData.verdict;
  }
  badge.className = `modal-verdict modal-verdict--${cls}`;
  badge.textContent = text;
  section.appendChild(badge);

  if (catData.explanation) {
    const exp = document.createElement("p");
    exp.className = "claim-explanation";
    exp.textContent = catData.explanation;
    section.appendChild(exp);
  }
  if (catData.comparison) section.appendChild(renderComparison(catData.comparison));
  if (catData.anchorQuote) {
    const anchor = document.createElement("p");
    anchor.className = "claim-quote--anchor";
    anchor.textContent =
      catData.anchorSource === "video_ini"
        ? `Pernyataan sebelumnya di video ini: "${catData.anchorQuote}"`
        : `Pembanding: "${catData.anchorQuote}"`;
    section.appendChild(anchor);
  }
  if (catData.anchorSource === "video_ini") {
    const tag = document.createElement("span");
    tag.className = "flag-source-tag";
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.innerHTML = ICONS.iconSvg("clock");
    tag.append(icon, document.createTextNode("Sumber: video ini, bukan pencarian web"));
    section.appendChild(tag);
  } else if (catData.sources?.length) {
    section.appendChild(buildSourcesEl(catData.sources));
  }

  return section;
}

function renderFlagModalBody(entry) {
  const statementEl = document.createElement("p");
  statementEl.className = "modal-claim";
  statementEl.textContent = entry.statement;
  const quoteEl = document.createElement("p");
  quoteEl.className = "modal-quote";
  quoteEl.textContent = `"${entry.quote}"`;
  modalBodyEl.append(statementEl, quoteEl);

  for (const [code, cat] of entry.categories.entries()) {
    const section = renderCategorySection(code, cat);
    if (section) modalBodyEl.appendChild(section);
  }
}

function openDetailModal(id, kind) {
  modalBodyEl.innerHTML = "";
  if (kind === "claim") {
    const entry = claimsStore.get(id);
    if (!entry) return;
    renderClaimModalBody(entry);
  } else {
    const entry = flagsStore.get(id);
    if (!entry) return;
    renderFlagModalBody(entry);
  }
  detailModalEl.hidden = false;
}

function closeDetailModal() {
  detailModalEl.hidden = true;
}

modalCloseBtn.addEventListener("click", closeDetailModal);
detailModalEl.querySelector(".modal__backdrop").addEventListener("click", closeDetailModal);

transcriptEl.addEventListener("mouseover", (e) => {
  const mark = e.target.closest(".t-mark");
  if (mark) showTooltip(mark);
});
transcriptEl.addEventListener("mouseout", (e) => {
  if (e.target.closest(".t-mark")) hideTooltip();
});
transcriptEl.addEventListener("click", (e) => {
  const mark = e.target.closest(".t-mark");
  if (mark) openDetailModal(mark.dataset.markId, mark.dataset.markKind);
});

// ---------- Scan-process transparency log ----------

const MAX_PROCESS_LOG_ROWS = 50;
const PROCESS_LOG_STATUS_LABEL = { checked: "DIPERIKSA", skipped: "DILEWATI", error: "ERROR" };

processLogToggleBtn.addEventListener("click", () => {
  const open = processLogEl.hidden;
  processLogEl.hidden = !open;
  processLogToggleBtn.setAttribute("aria-expanded", String(open));
});

function renderProcessLogEntry({ text, videoTime, status, summary }) {
  processLogEmpty.hidden = true;
  const row = document.createElement("div");
  row.className = `process-log-entry process-log-entry--${status}`;

  const time = document.createElement("span");
  time.className = "process-log-entry__time";
  time.textContent = typeof videoTime === "number" ? `[${formatTime(videoTime)}]` : "[--:--]";

  const statusTag = document.createElement("span");
  statusTag.className = "process-log-entry__status";
  statusTag.textContent = PROCESS_LOG_STATUS_LABEL[status] || status;

  const body = document.createElement("span");
  body.className = "process-log-entry__body";
  const preview = text.length > 70 ? `${text.slice(0, 70)}…` : text;
  const textEl = document.createElement("span");
  textEl.className = "process-log-entry__text";
  textEl.textContent = `"${preview}"`;
  body.append(textEl, document.createTextNode(` — ${summary}`));

  row.append(time, statusTag, body);
  processLogList.appendChild(row);
  processLogList.scrollTop = processLogList.scrollHeight;

  while (processLogList.children.length > MAX_PROCESS_LOG_ROWS) {
    processLogList.removeChild(processLogList.firstChild);
  }
}

// Multiple queues can hit the rate limiter's wait around the same moment —
// de-duped so a burst doesn't spam the transparency log with near-identical
// "waiting" rows.
let lastRateLimitLogAt = 0;
function renderRateLimitWaitEntry(waitMs) {
  const now = Date.now();
  if (now - lastRateLimitLogAt < 3000) return;
  lastRateLimitLogAt = now;
  processLogEmpty.hidden = true;
  const row = document.createElement("div");
  row.className = "process-log-entry process-log-entry--waiting";
  const time = document.createElement("span");
  time.className = "process-log-entry__time";
  time.textContent = "[--:--]";
  const body = document.createElement("span");
  body.className = "process-log-entry__body";
  body.textContent = `Menunggu slot API tersedia (~${Math.ceil(waitMs / 1000)} detik)…`;
  row.append(time, body);
  processLogList.appendChild(row);
  processLogList.scrollTop = processLogList.scrollHeight;
  while (processLogList.children.length > MAX_PROCESS_LOG_ROWS) {
    processLogList.removeChild(processLogList.firstChild);
  }
}

// ---------- Export ----------

function escapeHtmlText(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function buildExportHtml() {
  const title = pageContext.title || document.title || "Political Slop Debunker";
  const transcriptText = transcriptEl.textContent.trim();

  const claimsHtml = Array.from(claimsStore.values())
    .map(
      (c) => `<div class="item">
      <p class="verdict">${escapeHtmlText(VERDICT_DISPLAY[c.verdict] || c.verdict)}</p>
      <p class="claim">${escapeHtmlText(c.claimText)}</p>
      <blockquote>${escapeHtmlText(c.quote)}</blockquote>
      ${c.explanation ? `<p class="explanation">${escapeHtmlText(c.explanation)}</p>` : ""}
      ${
        c.sources?.length
          ? `<ul class="sources">${c.sources.map((s) => `<li><a href="${escapeHtmlText(s.url)}">${escapeHtmlText(s.title || s.url)}</a></li>`).join("")}</ul>`
          : ""
      }
    </div>`,
    )
    .join("");

  const flagsHtml = Array.from(flagsStore.values())
    .map((f) => {
      const catsHtml = Array.from(f.categories.entries())
        .map(([code, cat]) => {
          const meta = CATEGORIES_LIB.CATEGORIES[code];
          const label =
            cat.verdict === "TERINDIKASI"
              ? meta?.positiveLabel || meta?.label
              : cat.verdict === "caution"
                ? meta?.label
                : meta?.clearLabel || cat.verdict;
          return `<div class="cat"><strong>${escapeHtmlText(label || code)}</strong>${cat.explanation ? `<p>${escapeHtmlText(cat.explanation)}</p>` : ""}</div>`;
        })
        .join("");
      return `<div class="item">
      <p class="claim">${escapeHtmlText(f.statement)}</p>
      <blockquote>${escapeHtmlText(f.quote)}</blockquote>
      ${catsHtml}
    </div>`;
    })
    .join("");

  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>${escapeHtmlText(title)} — Laporan Political Slop Debunker</title>
<style>
body{font-family:-apple-system,sans-serif;max-width:760px;margin:32px auto;padding:0 16px;color:#18181b;line-height:1.5}
h1{font-size:20px}h2{font-size:15px;margin-top:32px;border-bottom:1px solid #e4e4e7;padding-bottom:6px}
.item{border:1px solid #e4e4e7;border-radius:10px;padding:14px;margin-bottom:12px}
.verdict{font-weight:700;font-size:11px;text-transform:uppercase;color:#b45309}
.claim{font-weight:650;margin:4px 0}
blockquote{margin:6px 0;padding-left:10px;border-left:2px solid #d4d4d8;color:#6b6b74;font-style:italic}
.explanation{margin:6px 0}
.cat{margin-top:8px;padding-top:8px;border-top:1px solid #e4e4e7}
.sources{margin:6px 0 0;padding:0;list-style:none}
.sources a{display:block;font-size:12px;color:#dc2626}
pre{white-space:pre-wrap;font-family:inherit;font-size:13px;background:#f7f7f8;padding:14px;border-radius:10px}
</style></head><body>
<h1>${escapeHtmlText(title)}</h1>
<p>Diekspor dari Political Slop Debunker pada ${new Date().toLocaleString("id-ID")}</p>
<h2>Klaim (${claimsStore.size})</h2>
${claimsHtml || "<p>Tidak ada klaim terdeteksi.</p>"}
<h2>Pola terdeteksi (${flagsStore.size})</h2>
${flagsHtml || "<p>Tidak ada pola terdeteksi.</p>"}
<h2>Transkrip lengkap</h2>
<pre>${escapeHtmlText(transcriptText)}</pre>
</body></html>`;
}

exportBtn.addEventListener("click", () => {
  const html = buildExportHtml();
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `political-slop-debunker-${Date.now()}.html`;
  a.click();
  URL.revokeObjectURL(url);
});

// ---------- Pipeline wiring ----------

const verifyQueue = new VerifyQueue({
  getSettings: () => chrome.storage.local.get(DEFAULT_SETTINGS),
  getContext: () => getContextString(),
  getHistory: () => pipeline.getHistorySnapshot(),
  onVerdict: (id, verdict) => {
    updateClaimResult(id, verdict);
    relayDebugLog(`[verify] claim ${id} :: ${JSON.stringify(verdict)}`);
  },
  onRateLimitWait: renderRateLimitWaitEntry,
});

const analysisQueue = new AnalysisQueue({
  getSettings: () => chrome.storage.local.get(DEFAULT_SETTINGS),
  getContext: () => getContextString(),
  onResult: (id, payload) => {
    updateFlagResult(id, payload);
    relayDebugLog(`[analysis] flag ${id} :: ${JSON.stringify(payload)}`);
  },
  getHistory: () => pipeline.getHistorySnapshot(),
  onRateLimitWait: renderRateLimitWaitEntry,
});

const deliberationQueue = new DeliberationQueue({
  getSettings: () => chrome.storage.local.get(DEFAULT_SETTINGS),
  getContext: () => getContextString(),
  onResult: (id, payload) => {
    updateFlagResult(id, payload);
    relayDebugLog(`[deliberation] flag ${id} :: ${JSON.stringify(payload)}`);
  },
  getHistory: () => pipeline.getHistorySnapshot(),
  onRateLimitWait: renderRateLimitWaitEntry,
});

const pipeline = new Pipeline({
  getSettings: () => chrome.storage.local.get(DEFAULT_SETTINGS),
  getContext: () => getContextString(),
  onClaimDetected: (id, claimText, quoteText, significance) => {
    registerClaim(id, claimText, quoteText);
    verifyQueue.add(id, claimText, quoteText, significance);
  },
  onFlagDetected: (id, statement, quoteText, categories, significance) => {
    registerFlag(id, statement, quoteText, categories);
    const anchoredCodes = categories
      .filter((c) => CATEGORIES_LIB.CATEGORIES[c.code]?.tier === "anchored")
      .map((c) => c.code);
    const softCodes = categories
      .filter((c) => CATEGORIES_LIB.CATEGORIES[c.code]?.tier === "soft")
      .map((c) => c.code);
    if (anchoredCodes.length) analysisQueue.add(id, statement, quoteText, anchoredCodes, significance);
    if (softCodes.length) deliberationQueue.add(id, statement, quoteText, softCodes, significance);
  },
  onStateChange: setPipelineState,
  onWindowProcessed: (entry) => {
    renderProcessLogEntry(entry);
    const rawPart = entry.rawText ? `\nraw model output: ${entry.rawText}` : "";
    relayDebugLog(`[${entry.status}] ${entry.summary} :: "${entry.text.slice(0, 80)}"${rawPart}`);
  },
  onRateLimitWait: renderRateLimitWaitEntry,
});

// Clears the current transcript/results view without touching the detected
// page context — used both for the manual "Bersihkan" button and as the
// shared core of resetSession() below.
function clearResults() {
  transcriptEl.innerHTML = "";
  transcriptEmpty.hidden = false;
  claimsStore.clear();
  flagsStore.clear();
  wordCount = 0;
  updateStats();
  processLogList.innerHTML = "";
  processLogEmpty.hidden = false;
  pipeline.reset();
  verifyQueue.clear();
  analysisQueue.clear();
  deliberationQueue.clear();
  setPipelineState("idle");
}

clearBtn.addEventListener("click", clearResults);

// YouTube's SPA navigation means a video change doesn't reload this panel,
// so without this, claims/flags/history from a previous video would keep
// accumulating and the "same video" history the analysis flags rely on
// would silently include statements from an unrelated video.
function resetSession() {
  clearResults();
  resetPageContext();
  renderContextUI();
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "TRANSCRIPT_CHUNK" && sender.tab?.id === activeTabId) {
    appendTranscriptChunk(message.text, message.videoTime);
    pipeline.addTranscriptChunk(message.text, message.videoTime);
  }
  if (message?.type === "VIDEO_CHANGED" && sender.tab?.id === activeTabId) {
    resetSession();
  }
  if (message?.type === "PAGE_CONTEXT" && sender.tab?.id === activeTabId && message.context) {
    pageContext = message.context;
    renderContextUI();
  }
  if (message?.type === "CONTENT_READY" && sender.tab?.id != null) {
    // The content script can finish loading (and PING/PONG can race) before
    // any tabs.onActivated/onUpdated event fires to trigger checkActiveTab,
    // e.g. when the panel opens on a video that was already loaded — leaving
    // activeTabId permanently null with no error. Re-check as soon as the
    // content script announces itself.
    checkActiveTab();
  }
});

chrome.tabs.onActivated.addListener(checkActiveTab);
chrome.tabs.onUpdated.addListener((_, info) => {
  if (info.status === "complete") checkActiveTab();
});

// ---------- Boot ----------

settingsToggleBtn.querySelector(".icon").innerHTML = ICONS.iconSvg("settings");
contextToggleBtn.querySelector(".section-toggle__chevron").innerHTML = ICONS.iconSvg("chevron-down");
processLogToggleBtn.querySelector(".process-log-toggle__chevron").innerHTML = ICONS.iconSvg("chevron-down");
modalCloseBtn.querySelector(".icon").innerHTML = ICONS.iconSvg("x");
renderChecksList();
renderContextUI();
updateStats();
loadSettings();
checkActiveTab();
