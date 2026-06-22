create table if not exists public.learning_hub_content (
  content_key text primary key,
  content_group text not null,
  content jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists learning_hub_content_group_idx
  on public.learning_hub_content (content_group);

alter table public.learning_hub_content enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'learning_hub_content'
      and policyname = 'learning_hub_content_select'
  ) then
    create policy learning_hub_content_select
      on public.learning_hub_content
      for select
      using (true);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'learning_hub_content'
      and policyname = 'learning_hub_content_insert'
  ) then
    create policy learning_hub_content_insert
      on public.learning_hub_content
      for insert
      with check (true);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'learning_hub_content'
      and policyname = 'learning_hub_content_update'
  ) then
    create policy learning_hub_content_update
      on public.learning_hub_content
      for update
      using (true)
      with check (true);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'learning_hub_content'
      and policyname = 'learning_hub_content_delete'
  ) then
    create policy learning_hub_content_delete
      on public.learning_hub_content
      for delete
      using (true);
  end if;
end $$;

insert into public.learning_hub_content (content_key, content_group, content)
values
  (
    'dashboard_courses',
    'dashboard',
    $$[
      {"title":"fundamental social media","desc":"strategi konten, ritme posting, dan cara membaca performa.","progress":72,"tag":"kelas aktif"},
      {"title":"content system","desc":"workflow pembuatan ide, asset, revisi, dan approval mentor.","progress":54,"tag":"video + asset"},
      {"title":"growth and analytics","desc":"cara evaluasi insight, retention, dan optimasi campaign.","progress":34,"tag":"next batch"}
    ]$$::jsonb
  ),
  (
    'calendar_events',
    'calendar',
    $$[
      {"day":"senin","time":"19.00 wita","title":"zoom class: content planning","note":"reminder 4 jam sebelum mulai"},
      {"day":"rabu","time":"19.30 wita","title":"review task minggu ini","note":"reminder 1 hari sebelum mulai"},
      {"day":"jumat","time":"20.00 wita","title":"qna mentor live","note":"reminder 30 menit sebelum mulai"}
    ]$$::jsonb
  ),
  (
    'community_threads',
    'community',
    $$[
      {"author":"nisa","title":"cara bikin hook yang lebih kuat?","reply":"mentor rafi menjawab: pakai angle masalah, bukti, lalu promise hasil.","points":"+12 poin"},
      {"author":"dimas","title":"asset kelas disimpan di mana?","reply":"semua file ada di library materi per batch dan bisa diunduh ulang.","points":"+8 poin"}
    ]$$::jsonb
  ),
  (
    'profile_stats',
    'profile',
    $$[
      {"label":"progress bulan ini","value":"78%"},
      {"label":"pertanyaan terjawab","value":"24"},
      {"label":"poin terkumpul","value":"320"}
    ]$$::jsonb
  ),
  (
    'lms_lessons',
    'lms',
    $$[
      {
        "id":"content-planning",
        "title":"01: learn the basics",
        "duration":"18 menit",
        "meta":"video class",
        "description":"membahas cara menyusun ide konten, menentukan angle, dan membangun ritme posting yang konsisten.",
        "videoUrl":"https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
        "stats":["4.5 rating","14,115 ratings","1.2h total duration","3d ago","8+ languages"],
        "assets":[
          {"title":"content brief template","type":"pdf","note":"outline singkat untuk planning","href":"data:text/plain;charset=utf-8,content%20brief%20template"},
          {"title":"hook bank sheet","type":"sheet","note":"list hook yang siap dipakai","href":"data:text/plain;charset=utf-8,hook%20bank%20sheet"}
        ]
      },
      {
        "id":"asset-reels",
        "title":"02: content asset workflow",
        "duration":"12 file",
        "meta":"download asset",
        "description":"menjelaskan struktur asset kelas yang dipakai untuk reels, termasuk cover, subtitle, dan format file.",
        "videoUrl":"https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
        "stats":["321,195 students enrolled","downloadable assets","lms library"],
        "assets":[
          {"title":"reel cover pack","type":"zip","note":"cover visual siap edit","href":"data:text/plain;charset=utf-8,reel%20cover%20pack"},
          {"title":"subtitle preset","type":"srt","note":"format subtitle dasar","href":"data:text/plain;charset=utf-8,subtitle%20preset"}
        ]
      },
      {
        "id":"weekly-review",
        "title":"03: weekly performance review",
        "duration":"9 menit",
        "meta":"case study",
        "description":"menunjukkan cara membaca insight mingguan, menemukan pola performa, dan menentukan next action.",
        "videoUrl":"https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
        "stats":["last updated 3d ago","weekly review","mentor guided"],
        "assets":[
          {"title":"insight tracking sheet","type":"sheet","note":"rekap performa mingguan","href":"data:text/plain;charset=utf-8,insight%20tracking%20sheet"}
        ]
      },
      {
        "id":"practice-recap",
        "title":"04: practice and recap",
        "duration":"11 menit",
        "meta":"exercise",
        "description":"latihan penerapan materi sebelumnya lalu merangkum poin penting agar mudah diulang kembali.",
        "videoUrl":"https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
        "stats":["practice round","recap notes","mentor review"],
        "assets":[
          {"title":"practice checklist","type":"pdf","note":"panduan latihan mandiri","href":"data:text/plain;charset=utf-8,practice%20checklist"}
        ]
      },
      {
        "id":"platform-shift",
        "title":"05: platform trend shift",
        "duration":"14 menit",
        "meta":"trend update",
        "description":"membahas perubahan pola konsumsi konten di platform dan implikasinya ke strategi berikutnya.",
        "videoUrl":"https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
        "stats":["trend update","platform analysis","new signals"],
        "assets":[
          {"title":"trend notes","type":"pdf","note":"catatan update tren platform","href":"data:text/plain;charset=utf-8,trend%20notes"}
        ]
      }
    ]$$::jsonb
  ),
  (
    'lms_reviews',
    'lms',
    $${
      "content-planning": [
        {"name":"nisa","rating":5,"feedback":"materinya jelas, contoh yang dipakai gampang diikuti."},
        {"name":"dimas","rating":4,"feedback":"alur videonya enak, tinggal butuh lebih banyak praktik."}
      ],
      "asset-reels": [],
      "weekly-review": [],
      "practice-recap": [],
      "platform-shift": []
    }$$::jsonb
  ),
  (
    'lms_assessment_questions',
    'lms',
    $$[
      {
        "id":"q-1",
        "prompt":"Apa tujuan utama dari content planning?",
        "options":[
          "Membuat ide konten lebih terarah",
          "Menghapus seluruh asset kelas",
          "Menentukan font saja",
          "Membuat jadwal meeting mentor"
        ],
        "correctIndex":0,
        "answerIndex":0
      },
      {
        "id":"q-2",
        "prompt":"Apa yang perlu diperhatikan saat membaca insight mingguan?",
        "options":[
          "Warna thumbnail",
          "Pola performa dan engagement",
          "Jumlah folder asset",
          "Ukuran video"
        ],
        "correctIndex":1,
        "answerIndex":1
      }
    ]$$::jsonb
  ),
  (
    'lms_progress',
    'lms',
    $$[]$$::jsonb
  )
on conflict (content_key) do update
set
  content_group = excluded.content_group,
  content = excluded.content,
  updated_at = now();
