# Rencana Mobile-Friendly — tanpa mengubah UI desktop

## Prinsip & jaminan
- Semua penyesuaian mobile ditulis **hanya di dalam `@media (max-width: …)`**.
  Di atas breakpoint, aturan base (desktop) tidak dievaluasi → **desktop byte-identik**.
- **Tidak mengedit satu pun aturan base yang sudah ada.** Hanya menambah override.
- `<meta viewport>` sudah ada di `index.html` ✅ (syarat mutlak, tak perlu diubah).

## Struktur & breakpoint
- Tambah **satu section baru di paling akhir `src/styles.css`** dengan penanda:
  `/* ===== MOBILE OVERRIDES (RS-2026-07) — jangan taruh aturan desktop di sini ===== */`
- Standarkan 2 breakpoint saja untuk pekerjaan baru:
  - `@media (max-width: 768px)` — tablet & HP (mayoritas fix di sini)
  - `@media (max-width: 480px)` — HP kecil (penyesuaian ekstra)
- 27 media query lama yang tersebar **dibiarkan** (jangan diutak-atik agar desktop aman);
  cukup ditimpa dari section baru bila perlu (section baru ada di bawah → menang di cascade).

## Inventaris pain-point (selector nyata) + rencana fix

### A. Fondasi global (kerjakan pertama — memperbaiki ~70% halaman)
1. **Cegah overflow horizontal**: `html, body { overflow-x: hidden; }` + `*{min-width:0}` selektif.
2. **Grid fixed → 1 kolom** di ≤768px:
   - `.hero` (`1.2fr 0.8fr`, baris ~2155) → `1fr`
   - `.login-split-card` (sudah ada di ~2937 tapi cek konsistensi)
   - grid `220px minmax(0,1fr)` (~3427), `minmax(0,1fr) 360px` (~2540) → `1fr`
   - `.course-modal-form` / `.course-modal-row` (`1fr 1fr`, ~2440/2469) → `1fr`
   - grid `repeat(2,minmax(0,1fr))` (~3477), berbagai `1fr 1fr` → `1fr`
   - Catatan: grid `repeat(auto-fit, minmax(260px,1fr))` (~895/930/2230/3925) **sudah responsif** — tidak perlu disentuh.
3. **Modal full-width / bottom-sheet** di ≤768px:
   - `.admin-modal`, `.course-modal-sm`, `.modal`, `.overlay` → `width:100%; max-width:100%; border-radius:16px 16px 0 0; inset:auto 0 0 0;` (bottom sheet) atau center full-width.
4. **Kalender check-in** `repeat(7,1fr)` (~3597) → biarkan (7 kolom kecil masih muat), tapi kecilkan gap/font di ≤480px.

### B. Navigasi
5. **Sidebar pill** (`.sidebar-nav--left/right`, ~1397): di ≤768px **paksa ke bottom-bar** —
   `.sidebar-nav { left:50%!important; right:auto!important; top:auto!important;
   bottom:12px!important; transform:translateX(-50%)!important; flex-direction:row!important; }`
   + perbesar `.sidebar-nav-item` touch target ke ≥44px.
6. **Dynamic-island top nav**: kecilkan / `flex-wrap` agar tidak meluber di layar sempit.
7. **Tooltip hover-only** (`.sidebar-nav-tooltip`): sembunyikan di mobile (tak ada hover),
   nav bawah pakai label/ikon saja.

### C. Halaman berat
8. **Tabel admin (User Control)** — paling parah. Dua opsi:
   - **Cepat**: bungkus tabel dengan `overflow-x:auto` (scroll samping). CSS-only, 0 risiko.
   - **Rapi**: ubah baris jadi kartu di ≤768px (`table,thead,tbody,tr,td{display:block}` +
     `td::before{content:attr(data-label)}`). Butuh menambah `data-label` di tiap `<td>` (markup).
9. **Landing hero** (`.landing-hero` ~802, `.hero-copy h2`): perkecil `font-size` & `padding` di ≤480px.
   (Sebagian sudah ditangani `@media 760px` ~1042 — cukup lengkapi.)
10. **Dashboard stat cards & journey**: pastikan turun 1 kolom + padding lebih kecil.

### D. Sentuhan UX mobile
11. Semua tombol/target interaktif **≥44×44px** di mobile.
12. Input `font-size:16px` di mobile (mencegah auto-zoom iOS).
13. Sticky header/nav aman dari **safe-area** (`env(safe-area-inset-bottom)`), terutama bottom-bar.

## Urutan pengerjaan (bertahap, tiap langkah bisa direview & di-commit)
1. **Fondasi global** (poin 1–4, 11–13) — 1 blok CSS, dampak terbesar.
2. **Navigasi** (poin 5–7).
3. **Tabel admin** (poin 8) — putuskan scroll vs kartu.
4. **Landing & dashboard** (poin 9–10).
5. Poles sisa per halaman (materi, kalender, komunitas, event) sambil test device toolbar.

## Cara test
- DevTools → Device Toolbar → iPhone SE (375), iPhone 14 (390), Android (360), iPad (768).
- Cek: tak ada scroll samping, tak ada teks kepotong, tombol mudah ditekan, modal muat.
- Karena base CSS tak diubah, cek desktop cukup sekilas (mustahil berubah).

## Yang butuh sedikit markup (bukan CSS murni)
- Tabel→kartu (poin 8 opsi rapi): tambah `data-label` di `<td>` komponen tabel admin.
- Selebihnya **CSS-only**. Tidak ada perubahan logika/JS.

## Estimasi
- Fondasi global: 1 sesi, langsung terasa.
- Total sampai poles halaman: bertahap, aman dihentikan kapan saja (tiap langkah berdiri sendiri).
