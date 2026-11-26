# Rencana Peningkatan — Political Slop Debunker

Disusun setelah membandingkan dengan `live-fact-checker` (repo referensi, Gemini-based). Repo itu lebih matang di fundamental fact-checking (context, rate limiting, prompt rigor, output), sementara kita lebih ambisius di cakupan (sistem 9 flag bias/logika/konsistensi, significance filtering, same-video history, transparency log). Rencana ini menutup gap fundamental tanpa mengorbankan cakupan yang sudah ada.

Status: **Batch 1 (item 1-4) sudah diimplementasikan.** Batch 2 item 6 (highlight inline + ekspor) juga sudah ditarik maju dan dikerjakan. Sisanya masih rencana.

### Addendum — perbaikan reliabilitas deteksi (di luar rencana awal)

Setelah dipakai, ditemukan bahwa detect pass sering gagal menemukan pola sama sekali ("tidak ditemukan apa pun") pada pernyataan yang jelas-jelas punya celah. Akar masalahnya: detect pass menilai tiap window transkrip TERISOLASI — tanpa riwayat video, tanpa akses pencarian — sehingga struktural tidak mungkin ngenalin BIAS/NADA_TIDAK_SESUAI_REALITA/DATA_DIPILAH_SEPIHAK (butuh data pembanding) meskipun sudah diinstruksikan menandai secara liberal. Tiga perbaikan diterapkan:

1. **Riwayat video dikasih ke prompt detect juga** (sebelumnya cuma di tahap analisis), bantu TIDAK_KONSISTEN/PINDAH_TARGET.
2. **Window diperbesar** (WINDOW_SIZE 6→10, MAX_WAIT_MS 8000→12000, MAX_FRAGMENT_WORDS 50→70) — lebih banyak konteks per panggilan detect.
3. **Pengecekan 5 pola anchored digabung ke panggilan verifikasi klaim** (`buildVerifyPrompt`/`verifyClaim` di `lib/pipeline.js`) — bukan 1 panggilan tambahan terpisah, numpang di panggilan web-search yang sudah pasti jalan buat tiap klaim. Ini menutup gap struktural di atas tanpa nunggu detect pass (yang buta konteks) berhasil ngenalin pola itu sendiri. Klaim yang lolos ke verifikasi sekarang selalu sekalian dicek terhadap 5 kategori anchored; hasil TERINDIKASI ditampilkan sebagai bagian tambahan di modal klaim (hanya kalau ada temuan — kategori kosong disembunyikan biar gak nambah noise).

Juga ditambahkan filter lokal (gratis, tanpa API call) buat sapaan/pembukaan seremonial (Bismillah, Assalamualaikum, "yang saya hormati...") yang sebelumnya lolos ke detect pass cuma karena panjang katanya cukup, padahal isinya kosong.

---

## Batch 1 — murah, dampak tinggi, tanpa API call baru

### 1. Context injection

**Masalah:** Model sekarang hanya melihat potongan transkrip mentah — tidak tahu siapa yang bicara, video apa, kapan tayang. Untuk klaim politik, ini penting (mis. "turunkan inflasi ke 3%" artinya beda tergantung presiden & tahun mana).

**File yang disentuh:**
- `content.js` — scrape metadata dari DOM YouTube: judul video, nama channel/uploader, deskripsi (potong ~300-500 karakter), tanggal upload, status live. Kirim via message baru `PAGE_CONTEXT` (mirip pola `TRANSCRIPT_CHUNK` yang sudah ada), atau digabung ke `CONTENT_READY`.
- `background.js` — kemungkinan tidak perlu berubah (pesan bisa langsung content→sidepanel seperti sekarang), kecuali ingin dukungan re-fetch context saat SPA nav (`VIDEO_CHANGED` sudah ada, bisa dipakai untuk trigger re-fetch context juga).
- `sidepanel.js` — simpan context di state (title, channel, description, date, isLive), reset saat `resetSession()`/video berubah, dan sediakan fungsi `getContextString()` yang merangkai jadi teks pendek.
- `lib/prompts.js` — `buildDetectPrompt`, `buildVerifyPrompt`, `buildAnalysisPrompt` semua menerima parameter `context` (string), disisipkan di system/user prompt sebelum transkrip/klaim.

**Detail implementasi:**
- Selector DOM (contoh, perlu diverifikasi terhadap YouTube saat ini):
  - Judul: `#title h1`, fallback `document.title`
  - Channel: `#channel-name a`, `ytd-channel-name a`
  - Deskripsi: `#description-inline-expander`
  - Live badge: cek elemen `.ytp-live-badge` atau sejenisnya
- Opsional: field context manual di settings (mis. "Nama pembicara", "Acara/topik") yang di-override manual oleh user jika deteksi otomatis salah/kosong — pola ini ada di repo referensi.
- Context string dibatasi panjangnya (mis. 300-400 karakter) supaya tidak membengkakkan biaya token di setiap panggilan.

**Dampak:** Memperbaiki akurasi deteksi klaim, presisi pencarian saat verifikasi, DAN kualitas penilaian `significance` yang baru dibangun (model tidak lagi menilai signifikansi tanpa tahu konteks nyata).

---

### 2. Rate limiting proaktif

**Masalah:** Sekarang hanya bereaksi ke error 429 (lihat `err.retryAfterMs` di `lib/pipeline.js`). Tidak ada budget tracking di muka, jadi saat live stream lama dengan banyak klaim, permintaan bisa menumpuk dan kena limit.

**File yang disentuh:**
- `lib/pipeline.js` — tambah modul budget tracker: sliding window daftar timestamp request (mis. per menit), fungsi `availableRequests()` dan `acquireSlot()` yang menunggu tepat selama dibutuhkan sebelum request baru dikirim. Dipanggil di awal `detectClaimsAndFlags`, `verifyClaim`, `analyzeStatement`.
- Interval buffering (`MAX_WAIT_MS`, ukuran window) bisa dibuat adaptif: kalau budget menipis, perlambat siklus deteksi — mirip `getAdaptiveInterval()` di repo referensi.

**Catatan:** Anthropic/Aivene tidak selalu punya limit publik setegas Gemini free tier, jadi angka limit (RPM/RPD) perlu dibuat sebagai konstanta yang masuk akal secara default (atau bahkan dikonfigurasi user) — bukan angka hardcode ala Gemini 15 RPM. Bisa dimulai dengan limit longgar dan disesuaikan.

**Dampak:** Lebih tangguh untuk live stream panjang; user melihat status "menunggu slot API" alih-alih error tiba-tiba.

---

### 3. Self-consistency guard

**Masalah:** Model kadang menyatakan verdict yang bertentangan dengan penjelasannya sendiri (mis. verdict BENAR tapi explanation menyebut angka yang berbeda/bertentangan). Repo referensi menangkap ini dengan regex sederhana pada teks explanation.

**File yang disentuh:**
- `lib/pipeline.js` — di `verifyClaim` dan `analyzeStatement`, setelah verdict & explanation di-parse, jalankan pengecekan pola kontradiksi (mis. explanation mengandung kata seperti "berbeda", "bertentangan", "tidak sesuai", "namun data menunjukkan angka lain" sambil verdict = BENAR/TERINDIKASI-positif) → turunkan verdict ke status paling aman (TIDAK DAPAT DIVERIFIKASI / TIDAK CUKUP BUKTI).

**Dampak:** Lapisan pertahanan tambahan, gratis (tidak ada panggilan API baru), menangkap kasus model "asal declare" padahal reasoning-nya sendiri ragu.

---

### 4. Prompt yang lebih tajam dengan contoh konkret

**Masalah:** `buildVerifyPrompt` dan `buildAnalysisPrompt` sekarang cukup abstrak — tidak ada aturan batas angka yang jelas (kapan sesuatu jadi SALAH vs MENYESATKAN vs BENAR), tidak ada contoh nyata yang bisa dicontoh model.

**File yang disentuh:**
- `lib/prompts.js` — tambahkan:
  - Aturan margin angka eksplisit di `buildVerifyPrompt` (mis. data resmi dalam ±10-15% dari klaim → BENAR; beda signifikan → SALAH/MENYESATKAN tergantung konteks).
  - 1-2 contoh konkret per kategori di `buildAnalysisPrompt` (mis. seperti apa PINDAH_TARGET yang sebenarnya, vs yang bukan).

**Dampak:** Model lebih konsisten dan lebih berani mengambil keputusan (mengurangi verdict "aman" yang sebenarnya bisa diputuskan dengan data yang ada), tanpa mengubah struktur kode sama sekali — murni perbaikan teks prompt.

---

## Batch 2 — fitur lebih besar, didiskusikan terpisah nanti

### 5. Analisis video penuh (batch mode)

Ambil transcript penuh langsung dari internal player API YouTube (`chrome.scripting.executeScript` dengan `world: 'MAIN'`, baca `captionTracks` dari player response, fetch `timedtext`), bukan hanya scraping caption yang sedang tampil di layar. Memungkinkan analisis instan untuk video yang sudah tayang (bukan cuma live), dan lebih andal karena membaca data timing asli, bukan DOM yang bisa berubah-ubah.

Perlu: perubahan besar di `background.js` (handler baru semacam `GET_FULL_TRANSCRIPT`), UI progress bar di `sidepanel.html/js`, dan alur dua-fase (identifikasi lalu verifikasi) terpisah dari pipeline live yang sudah ada.

### 6. Highlight inline + ekspor laporan — **sudah diimplementasikan** (ditarik maju dari Batch 2 atas permintaan user)

- Highlight klaim/flag langsung di teks transkrip (bukan kartu terpisah), dengan tooltip saat hover dan modal detail saat diklik. Panel Analisis/Transkrip terpisah dan tab dihapus, digabung jadi satu tampilan dengan stats bar (kata/klaim/benar/salah/pola) dan bagian "Konteks" yang collapsible.
- Tombol ekspor: menghasilkan laporan HTML mandiri (self-contained) yang bisa dibagikan — semua klaim, verdict, sumber, dan transkrip lengkap dalam satu file.

Selain itu, kategori "soft" (TIDAK_RELEVAN, TIDAK_LOGIS, MENGALIHKAN_ISU) sekarang juga melalui tahap deliberasi kedua dengan model verifikasi (`DeliberationQueue`/`buildDeliberationPrompt` di `lib/pipeline.js`/`lib/prompts.js`) — sebelumnya hanya dinilai sekali oleh model deteksi cepat tanpa verifikasi ulang, sehingga terasa dangkal. Ini menambah panggilan API dibanding rencana awal yang "murni UI/UX", jadi ada trade-off biaya vs kedalaman analisis.

---

## Urutan yang disarankan

1. Batch 1, item 1 (context injection) — paling berdampak, memperkuat semua fitur lain termasuk significance scoring yang baru dibangun.
2. Batch 1, item 2 (rate limiting) — keandalan untuk pemakaian live stream panjang.
3. Batch 1, item 3 & 4 (self-consistency guard + prompt tajam) — bisa dikerjakan bareng, keduanya murni perbaikan teks/logic kecil.
4. Batch 2 — didiskusikan lagi setelah Batch 1 selesai dan diuji.
