// ============================================================
// birthday-check — Edge Function (Fase 2)
//
// Dijalankan sekali tiap pagi via pg_cron. Untuk tiap user aktif yang:
//   - berulang tahun HARI INI (cocok bulan-tanggal `birth_date`)
//   - show_birthday = true
//   - belum punya birthday_events tahun ini
// fungsi ini:
//   1. award bonus koin (idempoten) via RPC award_birthday_bonus
//   2. kirim notifikasi in-app "Selamat Ulang Tahun" ke yang berulang tahun
//   3. kirim Telegram ke yang berulang tahun (kalau sudah connect)
//
// Popup perayaan ke semua user diturunkan di sisi client dari tabel
// birthday_events (Fase 3) — tidak perlu di sini.
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function getBotToken(): Promise<string> {
  const { data } = await supabase
    .from('learning_hub_content')
    .select('content')
    .eq('content_key', 'admin_credit_settings')
    .maybeSingle();
  if (!data?.content) return '';
  const s = (typeof data.content === 'string' ? JSON.parse(data.content) : data.content) as { student_bot_token?: string };
  return s.student_bot_token ?? '';
}

async function sendTelegram(token: string, chatId: string, text: string): Promise<boolean> {
  if (!token || !chatId) return false;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  return res.ok;
}

// 'MM-DD' zona WIB (UTC+7) supaya cocok dengan tanggal lokal Indonesia.
function todayMonthDayWIB(): { md: string; year: number } {
  const wib = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const mm = String(wib.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(wib.getUTCDate()).padStart(2, '0');
  return { md: `${mm}-${dd}`, year: wib.getUTCFullYear() };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const { md, year } = todayMonthDayWIB();

  // Profil (birth_date, avatar, show_birthday) ada di user_profiles;
  // status aktif & telegram ada di app_users. Gabungkan by username.
  const [{ data: profiles, error: profErr }, { data: accounts, error: accErr }] = await Promise.all([
    supabase
      .from('user_profiles')
      .select('username, name, birth_date, avatar_path, show_birthday')
      .eq('show_birthday', true)
      .not('birth_date', 'is', null),
    supabase
      .from('app_users')
      .select('username, telegram_chat_id, is_active'),
  ]);

  if (profErr || accErr) {
    return new Response(JSON.stringify({ error: profErr?.message ?? accErr?.message }), { status: 500 });
  }

  const accountMap = new Map((accounts ?? []).map((a) => [a.username, a]));

  const celebrants = (profiles ?? [])
    .filter((p) => {
      const bd = String(p.birth_date ?? '');
      // birth_date format 'YYYY-MM-DD' → bandingkan 'MM-DD'.
      return bd.length >= 10 && bd.slice(5, 10) === md && accountMap.get(p.username)?.is_active;
    })
    .map((p) => ({
      username: p.username,
      name: p.name,
      avatar_path: p.avatar_path,
      telegram_chat_id: accountMap.get(p.username)?.telegram_chat_id ?? null,
    }));

  if (celebrants.length === 0) {
    return new Response(JSON.stringify({ celebrated: 0, message: 'No birthdays today' }), { status: 200 });
  }

  const botToken = await getBotToken();
  let awarded = 0;

  for (const u of celebrants) {
    // Award idempoten — kalau sudah pernah tahun ini, RPC balikin already:true.
    const { data: res, error: rpcErr } = await supabase.rpc('award_birthday_bonus', {
      p_username: u.username,
      p_year: year,
      p_display_name: u.name ?? u.username,
      p_avatar_path: u.avatar_path ?? null,
    });

    if (rpcErr) {
      console.warn('award_birthday_bonus failed', u.username, rpcErr.message);
      continue;
    }
    const result = (typeof res === 'string' ? JSON.parse(res) : res) as { ok?: boolean; already?: boolean; amount?: number };
    if (!result?.ok) continue; // sudah dirayakan tahun ini
    awarded++;

    const amount = result.amount ?? 0;
    // Notifikasi in-app ke yang berulang tahun.
    await supabase.from('notifications').insert([{
      recipient_username: u.username,
      type: 'birthday',
      title: '🎂 Selamat Ulang Tahun!',
      body: amount > 0
        ? `Semoga panjang umur & sukses selalu! Kamu dapat bonus ${amount} Ruang Coin. Cek ucapan dari member di inbox-mu.`
        : 'Semoga panjang umur & sukses selalu! Cek ucapan dari member di inbox-mu.',
      link: '#birthday-inbox',
    }]);

    // Telegram ke yang berulang tahun.
    if (u.telegram_chat_id) {
      const tg = `🎂 <b>Selamat Ulang Tahun, ${u.name ?? u.username}!</b>\n\nSemoga panjang umur, sehat, dan makin sukses. 🎉${amount > 0 ? `\n\n🪙 Kamu menerima bonus <b>${amount} Ruang Coin</b>!` : ''}\n\nMember lain sedang menuliskan ucapan untukmu — cek inbox ucapan di aplikasi. 💌`;
      await sendTelegram(botToken, u.telegram_chat_id, tg);
    }
  }

  return new Response(JSON.stringify({ celebrated: celebrants.length, awarded }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
