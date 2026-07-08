# Rencana Remediasi Keamanan — Ruang Sosmed Learning Hub

Dokumen ini merangkum audit keamanan tulisan-database (write access) dan
menyediakan **pola siap-pakai** untuk menutup sisa lubang secara bertahap.

_Terakhir diperbarui: 2026-07-08._

---

## 1. Akar masalah (wajib dipahami dulu)

Aplikasi **tidak memakai Supabase Auth** — login lewat token custom
(`app_sessions`). Akibatnya, bagi Postgres **semua client = role `anon`**;
tidak ada identitas per-user di level DB. Karena itu:

- **RLS murni tidak bisa** menegakkan "baris ini milik si A" untuk tulisan
  dari client (semua anonim).
- Satu-satunya cara aman mengamankan tulisan sensitif = **RPC
  `SECURITY DEFINER` yang memverifikasi token** via `_session_identity(p_token)`,
  lalu tabelnya dikunci (anon hanya SELECT; tulis lewat RPC/service_role).

Ini pola yang SUDAH dipakai untuk credits, dan kini untuk 3 tabel di bawah.

---

## 2. Sudah selesai & terverifikasi ✅

| Tabel | Lubang | Fix | Migrasi |
|---|---|---|---|
| `learning_hub_content` | Anon bisa ubah setting reward → cetak coin tak terbatas | RPC `admin_set_hub_content` (role developer) + RLS lock | `20260709_lock_hub_content.sql` |
| `user_asset_unlocks` | Tulis unlock langsung → buka asset berbayar gratis | RPC `unlock_asset` atomik (potong coin + unlock) + RLS lock | `20260710_lock_asset_unlocks.sql` |
| `notifications` | Anon insert notif palsu + link phishing | RPC `send_notification` (tolak link eksternal, actor dipaksa) + RLS lock (INSERT ditolak, read/update/delete tetap) | `20260711_lock_notifications.sql` |

**Ledger uang inti** (`user_credits`, `credit_transactions`, `app_users`,
`user_subscriptions`, `topup_requests`, `app_sessions`) sudah deny-all sejak
migrasi `secure_credits` — saldo & identitas aman.

---

## 3. Pola baku (ikuti untuk tiap tabel berikutnya)

### 3a. Migrasi berlapis
- **BAGIAN 1 (aditif, jalankan kapan saja):** buat RPC ber-verifikasi token.
- **BAGIAN 2 (lockdown, jalankan PALING AKHIR setelah client baru live):**
  enable RLS + hapus SEMUA policy lama + pasang policy yang benar.

### 3b. Template RPC role-check (untuk tulisan admin-only)
```sql
create or replace function public.admin_xxx(p_token text, ...)
returns json language plpgsql volatile security definer set search_path=public as $$
declare caller record;
begin
  select * into caller from public._session_identity(p_token);
  if caller.username is null or caller.role not in ('developer','admin') then
    raise exception 'Access denied' using errcode='42501';
  end if;
  -- ... lakukan tulisan ...
  return json_build_object('ok', true);
end; $$;
grant execute on function public.admin_xxx(...) to anon, authenticated;
```
Untuk tulisan **milik-user** (bukan admin), hilangkan cek role tapi paksa
kolom kepemilikan = `caller.username` (jangan percaya nilai dari client).

### 3c. Blok lockdown (hapus policy legacy + set yang benar)
```sql
alter table public.<T> enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='<T>'
  loop execute format('drop policy if exists %I on public.<T>', p.policyname); end loop;
end $$;
create policy "<T>_read" on public.<T> for select to anon, authenticated using (true);
create policy "<T>_service_write" on public.<T> for all to service_role using (true) with check (true);
-- (tambah policy update/delete anon HANYA bila operasi itu memang perlu dari client)
```

### 3d. Urutan deploy (WAJIB, biar fitur tak mati)
1. Jalankan BAGIAN 1 (RPC) di SQL.
2. Deploy client baru (merge → main → tunggu Cloudflare).
3. Jalankan BAGIAN 2 (lockdown).
4. Verifikasi (lihat §5). Katup darurat bila fitur mati:
   `alter table public.<T> disable row level security;`

---

## 4. Backlog tersisa (urut prioritas)

> Semua tabel di bawah RLS-nya sudah `on`, tapi punya policy **"allow all"**
> (mis. `allow_all_<t>`, `<t>_insert/update/delete {public}`) yang membuatnya
> terbuka. Blok DO di §3c menghapusnya sekaligus.

### P1 — Konten global (risiko KEHILANGAN DATA — kerjakan lebih dulu)
| Tabel | Tulisan client | Pendekatan |
|---|---|---|
| `lessons` | upsert, delete, reorder (bulk) | RPC `admin_upsert_lesson(token, jsonb)`, `admin_delete_lesson(token, key)` (sekalian hapus asset-nya), `admin_reorder_lessons(token, jsonb[])` |
| `lesson_assets` | delete+insert (ganti massal) | RPC `admin_replace_lesson_assets(token, lesson_key, jsonb)` |
| `courses` | insert, update, delete, sync `lesson_count` | RPC `admin_upsert_course(token, jsonb)`, `admin_delete_course(token, key)`, `admin_set_lesson_count(token, key, n)` |

> ⚠️ Uji panel admin (tambah/edit/hapus materi & course) di preview branch
> sebagai **developer** sebelum lock — flow ini tidak bisa diuji sebagai student.

### P2 — Konten milik-user (integritas/impersonasi)
| Tabel | Risiko | Pendekatan |
|---|---|---|
| `forum_threads`, `forum_replies` | edit/hapus post orang lain; farming reward post | RPC owner-check (`author_username = caller`); reward sudah lewat `claim_self_reward` (cap harian) |
| `lesson_reviews` | review/hapus palsu | RPC owner-check |
| `review_likes` | inflasi/hapus like | RPC owner-check |
| `birthday_wishes` | impersonasi ucapan (`from_username` dari client) | RPC: paksa `from_username = caller.username` |

### P3 — Lainnya (severity rendah)
| Tabel | Risiko | Pendekatan |
|---|---|---|
| `calendar_events` | vandalisme jadwal | RPC developer-only |
| `shared_assets` | ubah/hapus katalog asset | RPC developer-only |
| `event_participants` | palsukan kode akses rekaman | RPC: paksa `username = caller`, generate access_code di server |
| `lesson_progress`, `lesson_notes` | palsukan progres/catatan sendiri | RPC owner-check (dampak rendah) |
| `video_views` | inflasi analitik | RPC atau biarkan (dampak sangat rendah) |

---

## 5. Cara verifikasi tiap tabel (via curl, anon key publik dari .env.local)

```bash
URL=<VITE_SUPABASE_URL>; KEY=<VITE_SUPABASE_ANON_KEY>
# Tulis anon langsung HARUS ditolak 401:
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$URL/rest/v1/<T>" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"...":"..."}'
# Baca HARUS 200:
curl -s -o /dev/null -w "%{http_code}\n" "$URL/rest/v1/<T>?select=*&limit=1" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY"
```
Tes RPC pakai token developer (ambil dari localStorage `ruang-sosmed-session`):
```sql
select public.admin_xxx('<TOKEN_DEV>', ...);
```

---

## 6. Catatan penting (technical debt yang ditemukan)

1. **Policy "allow all" ada di hampir semua tabel** (sisa setup awal). Blok DO
   di §3c menghapusnya. Cek peta lengkap:
   ```sql
   select tablename, policyname, cmd, roles from pg_policies
   where schemaname='public' and cmd in ('INSERT','UPDATE','DELETE','ALL')
     and roles && array['anon','authenticated','public']::name[]
     and coalesce(qual,'true')='true' and coalesce(with_check,'true')='true'
   order by tablename;
   ```
2. **Drift repo ↔ DB:** beberapa fungsi (mis. `spend_credits`) hanya ada di
   DB, tidak di migrasi repo. Sebaiknya di-`pg_get_functiondef` dan dimasukkan
   ke migrasi agar repo jadi sumber kebenaran & bisa di-redeploy.
3. **Anon key bersifat publik** (ada di bundle JS) — jadi "hanya bisa via anon
   key" BUKAN pengaman; hambatan penyerang rendah. Pengaman sebenarnya =
   RLS + RPC ber-token seperti di dokumen ini.
