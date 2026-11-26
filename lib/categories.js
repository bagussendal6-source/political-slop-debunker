// Shared metadata for the "analysis" flags: patterns beyond plain fact-
// checking (bias, tone-vs-reality, moved goalposts, relevance, logic,
// deflection, unfunded promises). Consumed by prompts.js (to build the
// detect + analysis prompts) and sidepanel.js (to render badges), so the
// label/definition text lives in exactly one place.
//
// Three tiers, each with a different evidence bar:
//  - "anchored":  must be backed by a cited source found via web search
//                 (prior statement, official data, policy doc). Goes
//                 through AnalysisQueue. Verdict: TERINDIKASI | TIDAK CUKUP BUKTI.
//  - "soft":      judgment call with no external anchor possible (logic,
//                 relevance, deflection all live inside the transcript
//                 itself). The cheap detect pass's one-line self-report is
//                 only a candidate, not a verdict — it goes through a
//                 second deliberation pass with the stronger verify model
//                 (DeliberationQueue in lib/pipeline.js), which is asked to
//                 weigh reasons the pattern DOESN'T apply before asserting
//                 it does. Verdict: TERINDIKASI | TIDAK TERINDIKASI.
//  - "caution":   not a verdict at all, just a flag that a promise has no
//                 concrete mechanism attached yet. Rendered directly from
//                 the detect pass.

const CATEGORIES = {
  TIDAK_KONSISTEN: {
    tier: "anchored",
    label: "Tidak Konsisten",
    positiveLabel: "TIDAK KONSISTEN",
    clearLabel: "TIDAK CUKUP BUKTI",
    icon: "x",
    definition:
      "Pernyataan ini bertentangan dengan janji, komitmen, atau target kebijakan yang pernah dinyatakan sebelumnya oleh pembicara yang sama.",
  },
  BIAS: {
    tier: "anchored",
    label: "Bias",
    positiveLabel: "BIAS TERINDIKASI",
    clearLabel: "TIDAK CUKUP BUKTI",
    icon: "alert-triangle",
    definition:
      "Pernyataan ini menyajikan satu sisi cerita sambil mengabaikan data atau laporan resmi yang secara langsung bertentangan dan seharusnya dapat ditemukan.",
  },
  NADA_TIDAK_SESUAI_REALITA: {
    tier: "anchored",
    label: "Nada Tidak Sesuai Realita",
    positiveLabel: "NADA TIDAK SESUAI REALITA",
    clearLabel: "TIDAK CUKUP BUKTI",
    icon: "alert-triangle",
    definition:
      "Nada pernyataan optimis/bangga, padahal kondisi nyata pada periode yang sama (data ekonomi, harga pangan, bencana, dll) menunjukkan hal yang bertentangan.",
  },
  PINDAH_TARGET: {
    tier: "anchored",
    label: "Target Berubah",
    positiveLabel: "TARGET DIAM-DIAM BERUBAH",
    clearLabel: "TIDAK CUKUP BUKTI",
    icon: "alert-triangle",
    definition:
      "Kriteria keberhasilan suatu janji atau target berubah diam-diam dari waktu ke waktu tanpa penjelasan.",
  },
  DATA_DIPILAH_SEPIHAK: {
    tier: "anchored",
    label: "Cherry-Picking Data",
    positiveLabel: "DATA DIPILAH SEPIHAK",
    clearLabel: "TIDAK CUKUP BUKTI",
    icon: "alert-triangle",
    definition:
      "Menonjolkan satu statistik yang menguntungkan sambil mengabaikan tren data yang lebih luas atau lebih baru yang bertentangan.",
  },
  TIDAK_RELEVAN: {
    tier: "soft",
    label: "Kemungkinan Tidak Relevan",
    positiveLabel: "TIDAK RELEVAN",
    clearLabel: "TERNYATA RELEVAN",
    icon: "help-circle",
    definition:
      "Jawaban tidak membahas pertanyaan atau topik yang sebenarnya diajukan.",
  },
  TIDAK_LOGIS: {
    tier: "soft",
    label: "Kemungkinan Tidak Logis",
    positiveLabel: "TIDAK LOGIS",
    clearLabel: "LOGIKANYA WAJAR",
    icon: "help-circle",
    definition:
      "Kesimpulan tidak mengikuti secara logis dari premis yang dinyatakan (non sequitur).",
  },
  MENGALIHKAN_ISU: {
    tier: "soft",
    label: "Kemungkinan Mengalihkan Isu",
    positiveLabel: "MENGALIHKAN ISU",
    clearLabel: "TIDAK MENGALIHKAN",
    icon: "help-circle",
    definition:
      "Alih-alih menjawab, pembicara mengalihkan ke isu lain atau menyalahkan pihak lain.",
  },
  JANJI_TANPA_RENCANA: {
    tier: "caution",
    label: "Janji Tanpa Rencana Konkret",
    icon: "clock",
    definition:
      "Janji dinyatakan tanpa anggaran, linimasa, atau mekanisme konkret yang menyertainya.",
  },
};

const ANCHORED_CODES = Object.keys(CATEGORIES).filter((c) => CATEGORIES[c].tier === "anchored");
const SOFT_CODES = Object.keys(CATEGORIES).filter((c) => CATEGORIES[c].tier === "soft");
const CAUTION_CODES = Object.keys(CATEGORIES).filter((c) => CATEGORIES[c].tier === "caution");
const ALL_CODES = Object.keys(CATEGORIES);

window.CATEGORIES_LIB = { CATEGORIES, ANCHORED_CODES, SOFT_CODES, CAUTION_CODES, ALL_CODES };
