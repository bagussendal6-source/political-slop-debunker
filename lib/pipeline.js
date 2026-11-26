// Rolling window → claim detect → verify queue → dedup.
//
// The detect pass runs on a cheap model chosen independently of the user's
// verification model (settings.model, used by verifyClaim/analyzeStatement)
// — settings.detectModel picks between the two options offered in the UI:
// "haiku" (default) or "deepseek-v4-flash" (Aivene only, cheaper still).
// See resolveDetectModel below.
//
// Two providers are supported: Anthropic direct, and Aivene — an
// OpenAI-compatible gateway (api.aivene.com/v1/chat/completions) that
// proxies Claude models under its own naming, which doesn't always match
// Anthropic's IDs 1:1 (e.g. Aivene lists Haiku 4.5 as "claude-haiku-4-5",
// without Anthropic's dated "-20251001" snapshot suffix) — hence Haiku's
// id is keyed per provider below rather than a single shared constant.
// Their request/response shapes also differ (Anthropic's content-block
// array vs. OpenAI's flat message string; output_config.format vs. plain
// prompted JSON), so each provider gets its own request builder and
// response parser rather than trying to paper over the difference with
// conditionals scattered through the call sites.
//
// One thing Aivene's docs don't specify: the exact shape of citation data
// for the web_search built-in tool result. Rather than guess at a field
// name, the verify pass relies on the model's own self-reported "sources"
// JSON (already required by the prompt for both providers) and simply
// skips Anthropic's extra "did a search block actually appear" safety
// check for Aivene. The pre-existing "sources.length === 0 → force
// TIDAK DAPAT DIVERIFIKASI" rule still applies either way, so an
// unrecognized citation shape fails safe (unverifiable), not silently
// wrong.

const HAIKU_DETECT_MODEL = {
  anthropic: "claude-haiku-4-5-20251001",
  aivene: "claude-haiku-4-5",
};

// "deepseek-v4-flash" is only ever meaningful through Aivene — there's no
// Anthropic-direct equivalent — same "only via Aivene" convention already
// used for the verify-model dropdown. Anthropic-direct users always get
// Haiku for detection regardless of this setting.
function resolveDetectModel(detectModelSetting, providerName) {
  if (detectModelSetting === "deepseek-v4-flash" && providerName === "aivene") {
    return "deepseek-v4-flash";
  }
  return HAIKU_DETECT_MODEL[providerName] || HAIKU_DETECT_MODEL.anthropic;
}

// Widened from the original 6/8000/50 — the detect pass was judging windows
// so small (often a single isolated sentence, especially after the
// sentence-boundary fix) that it rarely had enough material to recognize a
// pattern even when explicitly told to flag liberally. More raw chunks and
// more wait time per window means fewer, richer detect calls instead of
// many starved ones — same call frequency order of magnitude, just fed
// better.
const WINDOW_SIZE = 10;
const MAX_WAIT_MS = 12000;
const MAX_FRAGMENT_WORDS = 70;
const MAX_VERIFY_QUEUE = 20;
const MAX_ANALYSIS_QUEUE = 20;
const MAX_DELIBERATION_QUEUE = 20;
const MIN_DETECT_WORDS = 6;
const MAX_HISTORY = 30;

// A window this short (small talk, a single interjection, captions still
// catching up) essentially never contains a checkable claim or a
// flaggable rhetorical pattern — skip the detect call entirely rather
// than spending an API call to learn that. Deliberately just a word-count
// floor, not a content-type filter: the 9 analysis flags cover tone and
// logic as much as facts, so anything smarter risks quietly filtering out
// exactly the rhetoric this feature exists to catch.
//
// One category of text reliably clears that floor while still being just
// as unworthy of an API call: ceremonial opening/closing boilerplate —
// religious salutations, the "yang saya hormati..." honorific address list,
// generic "selamat pagi"/thank-you lines. A speech's opening routinely runs
// 20-40 words of pure ceremony before any actual content starts, so the
// word-count floor alone lets every one of those windows through to a
// detect call that always comes back empty. Patterns below are matched and
// stripped (with a bounded tail length, not `[^.]*`, since live captions
// often lack punctuation for a while — an unbounded match could eat real
// content that follows in the same window) before re-checking the word
// count on what's left. A window that mixes boilerplate with real content
// still passes normally, since only the matched portions are removed.
const CEREMONIAL_PATTERNS = [
  /bismillahir?rahmanir?rahim\.?/gi,
  /assalamu ?'? ?alaikum(?:\s*warahmatullahi(?:\s*wabarakatuh)?)?\.?/gi,
  /wa ?'? ?alaikum ?salam(?:\s*warahmatullahi(?:\s*wabarakatuh)?)?\.?/gi,
  /shalom\.?/gi,
  /salve\.?/gi,
  /om swastiastu\.?/gi,
  /namo buddhaya\.?/gi,
  /salam kebajikan\.?/gi,
  /puji (?:dan )?syukur[\w\s,]{0,60}/gi,
  /yang saya (?:hormati|banggakan|muliakan|cintai)[\w\s,]{0,80}/gi,
  /yang (?:kami|saya) (?:hormati|banggakan)[\w\s,]{0,80}/gi,
  /yang terhormat[\w\s,]{0,80}/gi,
  /selamat (?:pagi|siang|sore|malam)\.?/gi,
  /terima kasih atas (?:waktu|kesempatan|perhatian)[\w\s,]{0,40}/gi,
  /wabillahitaufik[\w\s,]{0,40}/gi,
];

function stripCeremonial(text) {
  let stripped = text;
  for (const pattern of CEREMONIAL_PATTERNS) {
    stripped = stripped.replace(pattern, " ");
  }
  return stripped.replace(/\s+/g, " ").trim();
}

// Returns { worth, reason } instead of a bare boolean so the caller can
// show a specific, honest explanation in the process-transparency log
// rather than lumping "just a greeting" together with "too short" under
// one generic message.
function classifyWindow(text) {
  const rawWordCount = text.split(/\s+/).filter(Boolean).length;
  if (rawWordCount < MIN_DETECT_WORDS) {
    return { worth: false, reason: "terlalu singkat untuk diperiksa" };
  }
  const substantive = stripCeremonial(text);
  if (substantive.split(/\s+/).filter(Boolean).length < MIN_DETECT_WORDS) {
    return { worth: false, reason: "hanya sapaan/pembukaan seremonial, tidak ada substansi untuk diperiksa" };
  }
  return { worth: true, reason: "" };
}

// Splits accumulated transcript text at the last sentence-ending
// punctuation (., !, ?) so a window never gets sent to the detect API
// ending mid-sentence — a dangling clause is exactly as confusing for
// judging the 9 bias/logic flags as it is for fact claims, since both
// hinge on what's actually being asserted, not just which words appeared.
// Returns the complete portion (through that punctuation) and the
// remainder, which the caller carries into the next window instead of
// sending or discarding.
function splitCompleteSentences(text) {
  let lastEnd = -1;
  const re = /[.!?]+/g;
  let m;
  while ((m = re.exec(text))) {
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd === -1) return { complete: "", remainder: text };
  return { complete: text.slice(0, lastEnd).trim(), remainder: text.slice(lastEnd).trim() };
}

// ------------------------------------------------------------------
// Providers
// ------------------------------------------------------------------

const PROVIDERS = {
  anthropic: {
    endpoint: "https://api.anthropic.com/v1/messages",
    headers: (apiKey) => ({
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    }),
    detectBody: (model, system, user, schema) => ({
      model,
      max_tokens: 2048,
      system,
      messages: [{ role: "user", content: user }],
      output_config: {
        format: { type: "json_schema", schema },
      },
    }),
    verifyBody: (model, system, user) => ({
      model,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: user }],
      tools: [{ type: "web_search_20260209", name: "web_search" }],
    }),
    parseDetectText: (data) => {
      const block = (data.content || []).find((b) => b.type === "text");
      return block ? block.text : "";
    },
    parseVerify: (data) => {
      const content = data.content || [];
      const searchBlocks = content.filter((b) => b.type === "web_search_tool_result");
      const searchHappened = searchBlocks.length > 0;
      // Debug aid: distinguishes "the search tool never ran" from "it ran
      // but came back with zero/few results" from "it found results but the
      // model chose not to cite any of them as sources" — three different
      // failure points that all currently surface as the same empty
      // "TIDAK DAPAT DIVERIFIKASI" outcome downstream.
      const searchResultCount = searchBlocks.reduce(
        (sum, b) => sum + (Array.isArray(b.content) ? b.content.length : 0),
        0,
      );
      const text = content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return { text, searchHappened, searchResultCount };
    },
  },

  aivene: {
    endpoint: "https://api.aivene.com/v1/chat/completions",
    headers: (apiKey) => ({
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    }),
    detectBody: (model, system, user) => ({
      model,
      max_completion_tokens: 2048,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    verifyBody: (model, system, user) => ({
      model,
      max_completion_tokens: 1024,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      tools: [{ type: "web_search" }],
    }),
    parseDetectText: (data) => data.choices?.[0]?.message?.content || "",
    parseVerify: (data) => {
      const text = data.choices?.[0]?.message?.content || "";
      // No reliable "a search actually ran" signal documented for this
      // provider — rely solely on the sources.length enforcement below.
      return { text, searchHappened: true };
    },
  },
};

function getProvider(name) {
  return PROVIDERS[name] || PROVIDERS.anthropic;
}

// ------------------------------------------------------------------
// Proactive rate limiting: a sliding-window request budget shared across
// detect/verify/analysis calls (all three hit the same API key, so one
// global window is the right unit, not one per pass). Previously the
// pipeline only reacted to a 429's retry-after header (see the err.
// retryAfterMs handling in VerifyQueue/AnalysisQueue below) — fine for an
// occasional burst, but a long live stream with many claims could queue up
// requests fast enough to hit the limit before any 429 ever came back.
// acquireSlot() waits up front instead, so requests self-pace under the
// budget rather than firing and finding out.
//
// Anthropic/Aivene don't publish a single authoritative RPM figure the way
// e.g. Gemini's free tier does, so this is a conservative constant rather
// than a value mirrored from provider docs — deliberately loose enough to
// not bottleneck normal usage, tight enough to smooth out a live-stream
// burst.
const DEFAULT_RPM_LIMIT = 45;
const RATE_WINDOW_MS = 60000;

class RateLimiter {
  constructor(limitPerMinute = DEFAULT_RPM_LIMIT) {
    this.limit = limitPerMinute;
    this.timestamps = [];
  }

  _prune(now) {
    while (this.timestamps.length && now - this.timestamps[0] >= RATE_WINDOW_MS) {
      this.timestamps.shift();
    }
  }

  // Resolves once a slot is available, reserving it immediately (recording
  // the timestamp before returning) so concurrent callers can't all pass
  // the check before any of them accounts for their own request.
  // `onWaitStart` fires once per wait (not on every poll) so callers can
  // surface a "waiting for API budget" status without spamming it.
  async acquireSlot(onWaitStart) {
    for (;;) {
      const now = Date.now();
      this._prune(now);
      if (this.timestamps.length < this.limit) {
        this.timestamps.push(now);
        return;
      }
      const waitMs = Math.max(50, this.timestamps[0] + RATE_WINDOW_MS - now);
      onWaitStart?.(waitMs);
      await sleep(waitMs);
    }
  }
}

const rateLimiter = new RateLimiter();

// Category codes come back from the model as free-generated text even
// under Anthropic's structured-output schema (Aivene has no schema
// enforcement at all — see the note atop this file). A one-letter slip is
// enough to silently erase an otherwise well-formed flag: observed live,
// the model correctly identified a DATA_DIPILAH_SEPIHAK candidate but
// wrote "DATA_DIPILIH_SEPIHAK" (DIPILIH vs DIPILAH), which then failed the
// exact-match filter below and vanished entirely along with the flag it
// belonged to. Snap near-miss spellings to the closest enabled code
// (edit distance <= 2) before falling back to discarding it — a typo this
// small is clearly the same category, not the model inventing a new one.
function levenshteinDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[rows - 1][cols - 1];
}

function normalizeCategoryCode(code, enabledFlagCodes) {
  if (enabledFlagCodes.includes(code)) return code;
  let best = null;
  let bestDist = Infinity;
  for (const candidate of enabledFlagCodes) {
    const dist = levenshteinDistance(code, candidate);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return bestDist <= 2 ? best : null;
}

// ------------------------------------------------------------------
// Self-consistency guard: catches cases where the model asserts a
// positive verdict (BENAR / TERINDIKASI) but its own explanation text
// contains language that suggests a mismatch or contradiction — a sign
// the model "asal declare" despite its own reasoning being unsure. Pure
// regex over already-generated text, no extra API call. Downgrades to the
// safest status rather than trusting the asserted verdict.
const CONTRADICTION_PATTERN =
  /namun (?:data|angka|faktanya)|berbeda (?:jauh|signifikan)? ?(?:dari|dengan)|bertentangan (?:dengan|dari)|tidak sesuai dengan (?:data|klaim|fakta)|tidak sama dengan|angka (?:yang )?berbeda|kontradiksi/i;

function hasSelfContradiction(explanation) {
  return CONTRADICTION_PATTERN.test(explanation || "");
}

// ------------------------------------------------------------------
// Detect pass: rolling window → claude-haiku-4-5 → claim list
// ------------------------------------------------------------------

class Pipeline {
  constructor({
    getSettings,
    getContext,
    onClaimDetected,
    onFlagDetected,
    onStateChange,
    onWindowProcessed,
    onRateLimitWait,
  }) {
    this.getSettings = getSettings;
    this.getContext = getContext || (() => ""); // () => short video-context string, see sidepanel.js
    this.onClaimDetected = onClaimDetected; // (id, claim, quote)
    this.onFlagDetected = onFlagDetected; // (id, statement, quote, categories)
    this.onStateChange = onStateChange; // ("idle" | "buffering" | "scanning")
    this.onRateLimitWait = onRateLimitWait; // (waitMs) — proactive budget wait started
    // Transparency log: one call per transcript window handled, whether it
    // got sent to the detect API or skipped locally — lets the UI show an
    // overview of what was actually read vs. ignored, without needing to
    // dump the whole transcript. ({text, videoTime, status, summary})
    this.onWindowProcessed = onWindowProcessed;
    // Accumulated raw transcript text not yet sent to the detect API — a
    // single growing string rather than a chunk array, since flush() needs
    // to split it on sentence boundaries (see splitCompleteSentences) and
    // carry an incomplete trailing sentence over to the next window.
    this.pendingText = "";
    this.chunkCount = 0; // raw addTranscriptChunk() calls since last flush attempt
    this.timer = null;
    this.claimSeq = 0;
    this.flagSeq = 0;
    // Running log of everything detected so far in the current video —
    // { quote, summary, videoTime } — fed to anchored-flag analysis as
    // same-video evidence (see analyzeStatement). Capped so a long video
    // or livestream doesn't grow the analysis prompt unbounded.
    this.history = [];
    this.lastVideoTime = null;
  }

  addTranscriptChunk(text, videoTime) {
    if (typeof videoTime === "number") this.lastVideoTime = videoTime;
    const wasEmpty = !this.pendingText;
    this.pendingText = this.pendingText ? `${this.pendingText} ${text}` : text;
    this.chunkCount++;
    if (wasEmpty) this.onStateChange?.("buffering");
    if (this.chunkCount >= WINDOW_SIZE) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), MAX_WAIT_MS);
    }
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pendingText) {
      this.onStateChange?.("idle");
      return;
    }
    this.chunkCount = 0;

    const { complete, remainder } = splitCompleteSentences(this.pendingText);
    const remainderWordCount = remainder.split(/\s+/).filter(Boolean).length;
    // No complete sentence yet, and the dangling fragment isn't so long
    // that waiting longer risks unbounded buffering (some auto-generated
    // caption tracks go a while without punctuation) — keep accumulating
    // instead of sending a mid-sentence cut to the detect API.
    if (!complete && remainderWordCount < MAX_FRAGMENT_WORDS) {
      this.timer = setTimeout(() => this.flush(), MAX_WAIT_MS);
      this.onStateChange?.("buffering");
      return;
    }

    const batchText = complete || this.pendingText;
    this.pendingText = complete ? remainder : "";

    const { worth, reason } = classifyWindow(batchText);
    if (!worth) {
      this.onWindowProcessed?.({
        text: batchText,
        videoTime: this.lastVideoTime,
        status: "skipped",
        summary: reason,
      });
      this.onStateChange?.(this.pendingText ? "buffering" : "idle");
      return;
    }

    const settings = await this.getSettings();
    if (!settings.apiKey) {
      this.onStateChange?.("idle");
      return;
    }

    this.onStateChange?.("scanning");
    try {
      const { claims, flags, droppedCount, rawText } = await detectClaimsAndFlags(
        batchText,
        settings.apiKey,
        settings.provider,
        settings.enabledChecks,
        settings.detectModel,
        settings.significanceThreshold,
        this.history,
        this.getContext(),
        this.onRateLimitWait,
      );
      for (const claim of claims) {
        const id = `claim-${++this.claimSeq}`;
        this.recordHistory(claim.quote, claim.claim);
        this.onClaimDetected(id, claim.claim, claim.quote, claim.significance);
      }
      for (const flag of flags) {
        const id = `flag-${++this.flagSeq}`;
        this.recordHistory(flag.quote, flag.statement);
        this.onFlagDetected?.(id, flag.statement, flag.quote, flag.categories, flag.significance);
      }
      const summaryParts = [];
      if (claims.length || flags.length) {
        summaryParts.push(`${claims.length} klaim, ${flags.length} pola terdeteksi`);
      }
      if (droppedCount > 0) {
        summaryParts.push(`${droppedCount} dilewati (di bawah ambang signifikansi)`);
      }
      this.onWindowProcessed?.({
        text: batchText,
        videoTime: this.lastVideoTime,
        status: "checked",
        summary: summaryParts.length > 0 ? summaryParts.join(" · ") : "tidak ditemukan apa pun",
        rawText,
      });
    } catch (err) {
      console.error("Political Slop Debunker: detect pass failed", err);
      this.onWindowProcessed?.({
        text: batchText,
        videoTime: this.lastVideoTime,
        status: "error",
        summary: `gagal diperiksa: ${err.message}`,
      });
    } finally {
      this.onStateChange?.(this.pendingText ? "buffering" : "idle");
    }
  }

  recordHistory(quote, summary) {
    this.history.push({ quote, summary, videoTime: this.lastVideoTime });
    if (this.history.length > MAX_HISTORY) this.history.shift();
  }

  getHistorySnapshot() {
    return this.history.slice();
  }

  reset() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingText = "";
    this.chunkCount = 0;
    this.history = [];
    this.lastVideoTime = null;
    this.claimSeq = 0;
    this.flagSeq = 0;
  }
}

// Pattern/flag detection (the 9 bias/logic/consistency categories) is
// temporarily disabled network-wide — set to true to bring it back. This is
// a hard kill switch independent of chrome.storage.local's enabledChecks,
// so it stays off regardless of whatever a given install's settings happen
// to have saved (including from before this switch existed). Claim
// fact-checking is unaffected and keeps working normally.
const POLA_FEATURE_ENABLED = false;

// enabledChecks is a flat map of { claims: bool, <categoryCode>: bool, ... }.
// Missing keys default to enabled (see sidepanel.js) so older stored
// settings, or categories added in a later version, aren't silently
// treated as off.
function detectEnabledSets(enabledChecks) {
  const checks = enabledChecks || {};
  const enabledClaims = checks.claims !== false;
  const enabledFlagCodes = POLA_FEATURE_ENABLED
    ? window.CATEGORIES_LIB.ALL_CODES.filter((code) => checks[code] !== false)
    : [];
  return { enabledClaims, enabledFlagCodes };
}

// The detect prompt now asks the model to self-rate how much each
// candidate actually matters (see SIGNIFICANCE_RUBRIC in prompts.js)
// instead of suppressing candidates outright. Filtering happens here,
// right after parsing — below-threshold candidates never become a card
// and never cost a verify/analysis call. "sedang" default covers a
// missing/malformed field safely (a model that forgets the field
// shouldn't have its candidate silently vanish OR silently bypass the
// threshold).
const SIGNIFICANCE_ORDER = { rendah: 0, sedang: 1, tinggi: 2 };
const DEFAULT_SIGNIFICANCE = "sedang";

function normalizeSignificance(sig) {
  return Object.prototype.hasOwnProperty.call(SIGNIFICANCE_ORDER, sig) ? sig : DEFAULT_SIGNIFICANCE;
}

function meetsSignificanceThreshold(sig, threshold) {
  const normThreshold = normalizeSignificance(threshold);
  return SIGNIFICANCE_ORDER[normalizeSignificance(sig)] >= SIGNIFICANCE_ORDER[normThreshold];
}

// Shared HTTP mechanics for one detect sub-call (claims or flags). Pulled
// out of detectClaimsAndFlags so that function can fire both sub-calls
// concurrently via Promise.all instead of duplicating the fetch/parse
// boilerplate twice inline.
async function runDetectRequest(provider, detectModel, apiKey, system, user, schema, onRateLimitWait) {
  await rateLimiter.acquireSlot(onRateLimitWait);
  const response = await fetch(provider.endpoint, {
    method: "POST",
    headers: provider.headers(apiKey),
    body: JSON.stringify(provider.detectBody(detectModel, system, user, schema)),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Detect pass HTTP ${response.status}: ${body}`);
  }

  const data = await response.json();
  return provider.parseDetectText(data);
}

async function detectClaimsAndFlags(
  transcript,
  apiKey,
  providerName,
  enabledChecks,
  detectModelSetting,
  significanceThreshold,
  history,
  context,
  onRateLimitWait,
) {
  const { enabledClaims, enabledFlagCodes } = detectEnabledSets(enabledChecks);
  if (!enabledClaims && enabledFlagCodes.length === 0) {
    return { claims: [], flags: [], droppedCount: 0 };
  }

  const provider = getProvider(providerName);
  const detectModel = resolveDetectModel(detectModelSetting, providerName);

  // Claims and flags are two independent API calls, not one shared JSON
  // response — see the comment above buildClaimsPrompt/buildFlagsPrompt in
  // prompts.js for why. Run concurrently (neither depends on the other's
  // result) so this doesn't double the wall-clock time per window.
  async function detectClaims() {
    if (!enabledClaims) return null;
    const { system, user } = PROMPTS.buildClaimsPrompt(transcript, context);
    const schema = PROMPTS.buildClaimsSchema();
    const text = await runDetectRequest(provider, detectModel, apiKey, system, user, schema, onRateLimitWait);
    return { text, parsed: parseJSONLoose(text) };
  }

  async function detectFlags() {
    if (enabledFlagCodes.length === 0) return null;
    const { system, user } = PROMPTS.buildFlagsPrompt(transcript, enabledFlagCodes, context, history);
    const schema = PROMPTS.buildFlagsSchema(enabledFlagCodes);
    const text = await runDetectRequest(provider, detectModel, apiKey, system, user, schema, onRateLimitWait);
    return { text, parsed: parseJSONLoose(text) };
  }

  const [claimsResult, flagsResult] = await Promise.all([detectClaims(), detectFlags()]);

  // Anthropic's structured-output schema enforces the category enum, but
  // Aivene's detect call has no schema enforcement at all (plain prompted
  // JSON) — the toggle would be purely advisory there without this
  // code-level filter. Also drops any flag left with zero categories once
  // the disabled ones are stripped out. Codes are normalized (see
  // normalizeCategoryCode above) before that filter so a near-miss spelling
  // doesn't masquerade as a disabled/unknown category and get dropped.
  const claimsRaw = claimsResult?.parsed?.claims || [];
  const rawFlags = flagsResult?.parsed?.flags || [];
  const flagsRaw = rawFlags
    .map((flag) => ({
      ...flag,
      categories: (flag.categories || [])
        .map((c) => ({ ...c, code: normalizeCategoryCode(c.code, enabledFlagCodes) }))
        .filter((c) => c.code !== null),
    }))
    .filter((flag) => flag.categories.length > 0);

  const claims = claimsRaw.filter((c) => meetsSignificanceThreshold(c.significance, significanceThreshold));
  const flags = flagsRaw.filter((f) => meetsSignificanceThreshold(f.significance, significanceThreshold));
  const droppedCount = claimsRaw.length - claims.length + (flagsRaw.length - flags.length);

  const rawText = JSON.stringify({ claims: claimsResult?.text ?? null, flags: flagsResult?.text ?? null });

  return { claims, flags, droppedCount, rawText };
}

// ------------------------------------------------------------------
// Verify queue: bounded, priority-ordered, one call in flight at a
// time. Full queue evicts the lowest-priority item to make room for a
// higher-priority arrival; both the evicted item and an outright
// rejection are reported as "shed" so the UI can say so honestly
// instead of silently dropping them.
// ------------------------------------------------------------------

class VerifyQueue {
  constructor({ getSettings, getContext, getHistory, onVerdict, onRateLimitWait }) {
    this.getSettings = getSettings;
    this.getContext = getContext || (() => "");
    this.getHistory = getHistory || (() => []);
    this.onVerdict = onVerdict; // (id, {verdict, explanation, sources, patterns} | {shed:true})
    this.onRateLimitWait = onRateLimitWait; // (waitMs)
    this.items = [];
    this.seq = 0;
    this.processing = false;
  }

  // Drops everything still waiting (e.g. on a video change) — a call
  // already in flight finishes naturally since its item was already
  // popped off this.items before this runs.
  clear() {
    this.items = [];
  }

  add(id, claimText, quoteText, significance) {
    // Significance (from the detect pass's own self-rating) dominates
    // ordering; the old regex-for-digits heuristic survives only as a
    // tiebreaker within the same significance tier.
    const priority = SIGNIFICANCE_ORDER[normalizeSignificance(significance)] * 100 + scorePriority(claimText, quoteText);
    const item = { id, claimText, priority, seq: this.seq++ };

    if (this.items.length >= MAX_VERIFY_QUEUE) {
      let worstIdx = 0;
      for (let i = 1; i < this.items.length; i++) {
        if (comparePriority(this.items[i], this.items[worstIdx]) < 0) worstIdx = i;
      }
      if (comparePriority(item, this.items[worstIdx]) > 0) {
        const evicted = this.items.splice(worstIdx, 1)[0];
        this.onVerdict(evicted.id, { shed: true });
        this.items.push(item);
      } else {
        this.onVerdict(id, { shed: true });
        return;
      }
    } else {
      this.items.push(item);
    }

    this._process();
  }

  async _process() {
    if (this.processing) return;
    this.processing = true;

    while (this.items.length > 0) {
      let bestIdx = 0;
      for (let i = 1; i < this.items.length; i++) {
        if (comparePriority(this.items[i], this.items[bestIdx]) > 0) bestIdx = i;
      }
      const item = this.items.splice(bestIdx, 1)[0];

      const settings = await this.getSettings();
      if (!settings.apiKey) {
        this.onVerdict(item.id, { shed: true });
        continue;
      }

      try {
        const verdict = await verifyClaim(
          item.claimText,
          settings.apiKey,
          settings.model,
          settings.provider,
          this.getHistory(),
          this.getContext(),
          this.onRateLimitWait,
        );
        this.onVerdict(item.id, verdict);
      } catch (err) {
        if (err.retryAfterMs) {
          this.items.push(item);
          await sleep(err.retryAfterMs);
          continue;
        }
        console.error("Political Slop Debunker: verify pass failed", err);
        this.onVerdict(item.id, {
          verdict: "TIDAK DAPAT DIVERIFIKASI",
          explanation: "Gagal memeriksa klaim ini karena kesalahan teknis.",
          sources: [],
          patterns: [],
        });
      }
    }

    this.processing = false;
  }
}

// ------------------------------------------------------------------
// Analysis queue: same bounded/priority/eviction shape as VerifyQueue,
// but for the "anchored" tier flags (bias, tone-vs-reality, moved
// goalposts, cherry-picking, broken promises). One item can carry
// multiple categories — they're checked together in a single web-search
// call (see buildAnalysisPrompt) rather than one call per category.
// ------------------------------------------------------------------

class AnalysisQueue {
  constructor({ getSettings, getContext, onResult, getHistory, onRateLimitWait }) {
    this.getSettings = getSettings;
    this.getContext = getContext || (() => "");
    this.onResult = onResult; // (id, {results: [...]} | {shed:true})
    // Called fresh at the moment each item is actually processed (not when
    // queued), so it reflects everything detected up to that point,
    // including items that arrived while this one was waiting.
    this.getHistory = getHistory || (() => []);
    this.onRateLimitWait = onRateLimitWait; // (waitMs)
    this.items = [];
    this.seq = 0;
    this.processing = false;
  }

  clear() {
    this.items = [];
  }

  add(id, statementText, quoteText, categoryCodes, significance) {
    if (!categoryCodes || categoryCodes.length === 0) return;
    // Significance dominates; how many anchored categories were flagged
    // survives only as a tiebreaker within the same significance tier.
    const priority = SIGNIFICANCE_ORDER[normalizeSignificance(significance)] * 100 + categoryCodes.length;
    const item = { id, statementText, quoteText, categoryCodes, priority, seq: this.seq++ };

    if (this.items.length >= MAX_ANALYSIS_QUEUE) {
      let worstIdx = 0;
      for (let i = 1; i < this.items.length; i++) {
        if (comparePriority(this.items[i], this.items[worstIdx]) < 0) worstIdx = i;
      }
      if (comparePriority(item, this.items[worstIdx]) > 0) {
        const evicted = this.items.splice(worstIdx, 1)[0];
        this.onResult(evicted.id, { shed: true, categoryCodes: evicted.categoryCodes });
        this.items.push(item);
      } else {
        this.onResult(id, { shed: true, categoryCodes });
        return;
      }
    } else {
      this.items.push(item);
    }

    this._process();
  }

  async _process() {
    if (this.processing) return;
    this.processing = true;

    while (this.items.length > 0) {
      let bestIdx = 0;
      for (let i = 1; i < this.items.length; i++) {
        if (comparePriority(this.items[i], this.items[bestIdx]) > 0) bestIdx = i;
      }
      const item = this.items.splice(bestIdx, 1)[0];

      const settings = await this.getSettings();
      if (!settings.apiKey) {
        this.onResult(item.id, { shed: true, categoryCodes: item.categoryCodes });
        continue;
      }

      try {
        const result = await analyzeStatement(
          item.statementText,
          item.quoteText,
          item.categoryCodes,
          settings.apiKey,
          settings.model,
          settings.provider,
          this.getHistory(),
          this.getContext(),
          this.onRateLimitWait,
        );
        this.onResult(item.id, result);
      } catch (err) {
        if (err.retryAfterMs) {
          this.items.push(item);
          await sleep(err.retryAfterMs);
          continue;
        }
        console.error("Political Slop Debunker: analysis pass failed", err);
        this.onResult(item.id, {
          results: item.categoryCodes.map((category) => ({
            category,
            verdict: "TIDAK CUKUP BUKTI",
            explanation: "Gagal memeriksa pola ini karena kesalahan teknis.",
            anchorQuote: "",
            anchorSource: null,
            comparison: null,
            sources: [],
          })),
        });
      }
    }

    this.processing = false;
  }
}

// ------------------------------------------------------------------
// Deliberation queue: same bounded/priority/eviction shape as
// AnalysisQueue, but for the "soft" tier flags (TIDAK_RELEVAN, TIDAK_LOGIS,
// MENGALIHKAN_ISU). These previously went straight from the cheap detect
// pass's one-line self-report to the UI with no second look at all — this
// queue gives them the same "checked again by a stronger model before
// being shown as a finding" treatment the anchored tier already has, just
// without a web-search evidence requirement (see buildDeliberationPrompt).
// ------------------------------------------------------------------

class DeliberationQueue {
  constructor({ getSettings, getContext, onResult, getHistory, onRateLimitWait }) {
    this.getSettings = getSettings;
    this.getContext = getContext || (() => "");
    this.onResult = onResult; // (id, {results: [...]} | {shed:true})
    this.getHistory = getHistory || (() => []);
    this.onRateLimitWait = onRateLimitWait; // (waitMs)
    this.items = [];
    this.seq = 0;
    this.processing = false;
  }

  clear() {
    this.items = [];
  }

  add(id, statementText, quoteText, categoryCodes, significance) {
    if (!categoryCodes || categoryCodes.length === 0) return;
    const priority = SIGNIFICANCE_ORDER[normalizeSignificance(significance)] * 100 + categoryCodes.length;
    const item = { id, statementText, quoteText, categoryCodes, priority, seq: this.seq++ };

    if (this.items.length >= MAX_DELIBERATION_QUEUE) {
      let worstIdx = 0;
      for (let i = 1; i < this.items.length; i++) {
        if (comparePriority(this.items[i], this.items[worstIdx]) < 0) worstIdx = i;
      }
      if (comparePriority(item, this.items[worstIdx]) > 0) {
        const evicted = this.items.splice(worstIdx, 1)[0];
        this.onResult(evicted.id, { shed: true, categoryCodes: evicted.categoryCodes });
        this.items.push(item);
      } else {
        this.onResult(id, { shed: true, categoryCodes });
        return;
      }
    } else {
      this.items.push(item);
    }

    this._process();
  }

  async _process() {
    if (this.processing) return;
    this.processing = true;

    while (this.items.length > 0) {
      let bestIdx = 0;
      for (let i = 1; i < this.items.length; i++) {
        if (comparePriority(this.items[i], this.items[bestIdx]) > 0) bestIdx = i;
      }
      const item = this.items.splice(bestIdx, 1)[0];

      const settings = await this.getSettings();
      if (!settings.apiKey) {
        this.onResult(item.id, { shed: true, categoryCodes: item.categoryCodes });
        continue;
      }

      try {
        const result = await deliberateStatement(
          item.statementText,
          item.quoteText,
          item.categoryCodes,
          settings.apiKey,
          settings.model,
          settings.provider,
          this.getHistory(),
          this.getContext(),
          this.onRateLimitWait,
        );
        this.onResult(item.id, result);
      } catch (err) {
        if (err.retryAfterMs) {
          this.items.push(item);
          await sleep(err.retryAfterMs);
          continue;
        }
        console.error("Political Slop Debunker: deliberation pass failed", err);
        this.onResult(item.id, {
          results: item.categoryCodes.map((category) => ({
            category,
            verdict: "TIDAK TERINDIKASI",
            explanation: "Gagal menimbang ulang pola ini karena kesalahan teknis.",
          })),
        });
      }
    }

    this.processing = false;
  }
}

// Normalize + fuzzy-match a claimed anchorQuote against the actual
// captured history, tolerating minor whitespace/punctuation drift from
// the model copying it back rather than requiring byte-exact equality.
function normalizeForMatch(s) {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function historyContainsQuote(history, quote) {
  const normQuote = normalizeForMatch(quote);
  if (!normQuote) return false;
  return (history || []).some((h) => {
    const normHist = normalizeForMatch(h.quote);
    if (!normHist) return false;
    if (normHist.includes(normQuote) || normQuote.includes(normHist)) return true;
    const histWords = new Set(normHist.split(" ").filter(Boolean));
    const quoteWords = normQuote.split(" ").filter(Boolean);
    if (quoteWords.length === 0) return false;
    const overlap = quoteWords.filter((w) => histWords.has(w)).length;
    return overlap / quoteWords.length >= 0.8;
  });
}

async function analyzeStatement(
  statementText,
  quoteText,
  categoryCodes,
  apiKey,
  model,
  providerName,
  history,
  context,
  onRateLimitWait,
) {
  const provider = getProvider(providerName);
  const { system, user } = PROMPTS.buildAnalysisPrompt(quoteText, statementText, categoryCodes, history, context);

  await rateLimiter.acquireSlot(onRateLimitWait);
  const response = await fetch(provider.endpoint, {
    method: "POST",
    headers: provider.headers(apiKey),
    body: JSON.stringify(provider.verifyBody(model, system, user)),
  });

  if (response.status === 429) {
    const header = response.headers.get("retry-after");
    const err = new Error("rate limited");
    err.retryAfterMs = header ? parseInt(header, 10) * 1000 : 30000;
    throw err;
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Analysis pass HTTP ${response.status}: ${body}`);
  }

  const data = await response.json();
  const { text, searchHappened, searchResultCount } = provider.parseVerify(data);
  const parsed = parseJSONLoose(text);
  const rawResults = Array.isArray(parsed?.results) ? parsed.results : [];
  const byCategory = new Map(rawResults.map((r) => [r.category, r]));

  const results = categoryCodes.map((category) => {
    const raw = byCategory.get(category);
    let verdict = raw?.verdict === "TERINDIKASI" ? "TERINDIKASI" : "TIDAK CUKUP BUKTI";
    let sources = Array.isArray(raw?.sources) ? raw.sources.filter((s) => s?.url) : [];
    let explanation = raw?.explanation || "";
    let anchorQuote = raw?.anchorQuote || "";
    let comparison = parseComparison(raw?.comparison);
    const anchorSource = raw?.anchorSource === "video_ini" ? "video_ini" : "web";

    if (anchorSource === "video_ini") {
      // Stricter than the web path below: verified deterministically
      // against transcript this session actually captured, rather than
      // just trusting the model's self-report the way a web citation has
      // to be trusted.
      if (!anchorQuote || !historyContainsQuote(history, anchorQuote)) {
        verdict = "TIDAK CUKUP BUKTI";
      }
      sources = [];
    } else if (!searchHappened || sources.length === 0) {
      // Same enforced-in-code fail-safe as verifyClaim: no search, or no
      // sources for this specific category, means no verdict is asserted.
      verdict = "TIDAK CUKUP BUKTI";
      sources = [];
    }

    if (verdict === "TERINDIKASI" && hasSelfContradiction(explanation)) {
      verdict = "TIDAK CUKUP BUKTI";
    }

    if (verdict === "TIDAK CUKUP BUKTI") {
      anchorQuote = "";
      comparison = null;
      if (!explanation) {
        explanation = "Tidak ditemukan bukti spesifik yang dapat memverifikasi pola ini.";
      }
    }

    return {
      category,
      verdict,
      explanation,
      anchorQuote,
      anchorSource: verdict === "TERINDIKASI" ? anchorSource : null,
      comparison,
      sources,
    };
  });

  return { results, _debugSearchHappened: searchHappened, _debugSearchResultCount: searchResultCount };
}

// Deliberation pass for "soft" tier flags — see buildDeliberationPrompt and
// DeliberationQueue above. No web-search evidence requirement (there's
// nothing external to cite for relevance/logic/deflection judgments), so
// unlike verifyClaim/analyzeStatement this doesn't gate the verdict on
// searchHappened/sources — it's a reasoned second opinion, not a citation
// check. The self-consistency guard still applies: a TERINDIKASI verdict
// whose own explanation reads as contradictory gets downgraded.
async function deliberateStatement(
  statementText,
  quoteText,
  categoryCodes,
  apiKey,
  model,
  providerName,
  history,
  context,
  onRateLimitWait,
) {
  const provider = getProvider(providerName);
  const { system, user } = PROMPTS.buildDeliberationPrompt(quoteText, statementText, categoryCodes, history, context);

  await rateLimiter.acquireSlot(onRateLimitWait);
  const response = await fetch(provider.endpoint, {
    method: "POST",
    headers: provider.headers(apiKey),
    body: JSON.stringify(provider.verifyBody(model, system, user)),
  });

  if (response.status === 429) {
    const header = response.headers.get("retry-after");
    const err = new Error("rate limited");
    err.retryAfterMs = header ? parseInt(header, 10) * 1000 : 30000;
    throw err;
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Deliberation pass HTTP ${response.status}: ${body}`);
  }

  const data = await response.json();
  const { text } = provider.parseVerify(data);
  const parsed = parseJSONLoose(text);
  const rawResults = Array.isArray(parsed?.results) ? parsed.results : [];
  const byCategory = new Map(rawResults.map((r) => [r.category, r]));

  const results = categoryCodes.map((category) => {
    const raw = byCategory.get(category);
    let verdict = raw?.verdict === "TERINDIKASI" ? "TERINDIKASI" : "TIDAK TERINDIKASI";
    let explanation = raw?.explanation || "";

    if (verdict === "TERINDIKASI" && hasSelfContradiction(explanation)) {
      verdict = "TIDAK TERINDIKASI";
    }

    if (verdict === "TIDAK TERINDIKASI" && !explanation) {
      explanation = "Setelah ditimbang ulang, pola ini tidak cukup jelas untuk dinyatakan berlaku.";
    }

    return { category, verdict, explanation };
  });

  return { results };
}

function scorePriority(claimText, quoteText) {
  const text = `${claimText} ${quoteText}`;
  let score = 0;
  if (/\d/.test(text)) score += 10;
  if (/%|persen/i.test(text)) score += 3;
  if (/rp\.?\s?\d|rupiah|triliun|miliar(?!an)|(?<!\S)juta/i.test(text)) score += 3;
  if (/\b(19|20)\d{2}\b/.test(text)) score += 2;
  return score;
}

// Positive when `a` should be preferred over `b`: higher priority wins;
// among equal priority, earlier arrival (smaller seq) wins.
function comparePriority(a, b) {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return b.seq - a.seq;
}

async function verifyClaim(claimText, apiKey, model, providerName, history, context, onRateLimitWait) {
  const provider = getProvider(providerName);
  const { system, user } = PROMPTS.buildVerifyPrompt(claimText, context, history);

  await rateLimiter.acquireSlot(onRateLimitWait);
  const response = await fetch(provider.endpoint, {
    method: "POST",
    headers: provider.headers(apiKey),
    body: JSON.stringify(provider.verifyBody(model, system, user)),
  });

  if (response.status === 429) {
    const header = response.headers.get("retry-after");
    const err = new Error("rate limited");
    err.retryAfterMs = header ? parseInt(header, 10) * 1000 : 30000;
    throw err;
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Verify pass HTTP ${response.status}: ${body}`);
  }

  const data = await response.json();
  const { text, searchHappened, searchResultCount } = provider.parseVerify(data);
  const parsed = parseJSONLoose(text);

  let verdict = parsed?.verdict || "TIDAK DAPAT DIVERIFIKASI";
  let sources = Array.isArray(parsed?.sources) ? parsed.sources.filter((s) => s?.url) : [];
  let explanation = parsed?.explanation || "";

  // Enforced in code, not just prompted: a claim with no retrieved sources
  // is never allowed to carry a bare BENAR/SALAH/MENYESATKAN assertion.
  if (!searchHappened || sources.length === 0) {
    verdict = "TIDAK DAPAT DIVERIFIKASI";
    sources = [];
    if (!explanation) {
      explanation = "Tidak ditemukan sumber yang dapat memverifikasi klaim ini.";
    }
  }

  if (verdict === "BENAR" && hasSelfContradiction(explanation)) {
    verdict = "TIDAK DAPAT DIVERIFIKASI";
  }

  // Piggybacked anchored-pattern check — same fail-safes as analyzeStatement
  // (evidence requirement, self-consistency guard), applied per category.
  // See buildVerifyPrompt for why this rides along with claim verification
  // instead of depending on the detect pass to flag these independently.
  const rawPatterns = Array.isArray(parsed?.patterns) ? parsed.patterns : [];
  const byCategory = new Map(rawPatterns.map((r) => [r.category, r]));
  const patterns = window.CATEGORIES_LIB.ANCHORED_CODES.map((category) => {
    const raw = byCategory.get(category);
    let pVerdict = raw?.verdict === "TERINDIKASI" ? "TERINDIKASI" : "TIDAK CUKUP BUKTI";
    let pSources = Array.isArray(raw?.sources) ? raw.sources.filter((s) => s?.url) : [];
    let pExplanation = raw?.explanation || "";
    let pAnchorQuote = raw?.anchorQuote || "";
    let pComparison = parseComparison(raw?.comparison);
    const pAnchorSource = raw?.anchorSource === "video_ini" ? "video_ini" : "web";

    if (pAnchorSource === "video_ini") {
      if (!pAnchorQuote || !historyContainsQuote(history, pAnchorQuote)) {
        pVerdict = "TIDAK CUKUP BUKTI";
      }
      pSources = [];
    } else if (!searchHappened || pSources.length === 0) {
      pVerdict = "TIDAK CUKUP BUKTI";
      pSources = [];
    }

    if (pVerdict === "TERINDIKASI" && hasSelfContradiction(pExplanation)) {
      pVerdict = "TIDAK CUKUP BUKTI";
    }

    if (pVerdict === "TIDAK CUKUP BUKTI") {
      pAnchorQuote = "";
      pComparison = null;
    }

    return {
      category,
      verdict: pVerdict,
      explanation: pExplanation,
      anchorQuote: pAnchorQuote,
      anchorSource: pVerdict === "TERINDIKASI" ? pAnchorSource : null,
      comparison: pComparison,
      sources: pSources,
    };
  });

  return {
    verdict,
    explanation,
    sources,
    patterns,
    _debugSearchHappened: searchHappened,
    _debugSearchResultCount: searchResultCount,
  };
}

// A comparison is only useful with all four fields present — a partial
// one (e.g. model filled claimedValue but left actualValue empty) is
// worse than no comparison block at all, so it's treated as absent.
function parseComparison(raw) {
  if (!raw || typeof raw !== "object") return null;
  const { claimedLabel, claimedValue, actualLabel, actualValue } = raw;
  if (![claimedLabel, claimedValue, actualLabel, actualValue].every((v) => typeof v === "string" && v.trim())) {
    return null;
  }
  return { claimedLabel, claimedValue, actualLabel, actualValue };
}

function parseJSONLoose(text) {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through to substring extraction
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      // give up
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

window.Pipeline = Pipeline;
window.VerifyQueue = VerifyQueue;
window.AnalysisQueue = AnalysisQueue;
window.DeliberationQueue = DeliberationQueue;
