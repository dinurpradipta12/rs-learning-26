import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const TG_TOKEN = Deno.env.get('TG_TOKEN') ?? '';
const TG_CHAT  = Deno.env.get('TG_CHAT')  ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─── Telegram helpers ───────────────────────────────────────────────────────

type InlineRow = Array<{ text: string; callback_data: string }>;

async function tgSend(text: string, inlineButtons?: InlineRow[], replyMarkup?: unknown) {
  const body: Record<string, unknown> = { chat_id: TG_CHAT, text, parse_mode: 'HTML' };
  if (inlineButtons) body.reply_markup = { inline_keyboard: inlineButtons };
  else if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function tgEdit(chatId: number, messageId: number, text: string, inlineButtons?: InlineRow[]) {
  const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
  if (inlineButtons) body.reply_markup = { inline_keyboard: inlineButtons };
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function tgEditButtons(chatId: number, messageId: number, statusText: string) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/editMessageReplyMarkup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: statusText, callback_data: 'noop' }]] },
    }),
  });
}

async function tgAnswer(id: string, text: string) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: id, text, show_alert: false }),
  });
}

const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: '📋 Pending Approval' }, { text: '📊 Pendapatan Bulan Ini' }],
    [{ text: '🎟 Lihat Referral' },   { text: '➕ Buat Referral' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

async function tgSendMenu(text: string) {
  await tgSend(text, undefined, MAIN_KEYBOARD);
}

function formatRupiah(n: number) {
  return 'Rp' + Number(n).toLocaleString('id-ID');
}

// ─── Session helpers ─────────────────────────────────────────────────────────

type SessionData = {
  code?: string;
  type?: 'coin' | 'feature';
  credits?: number;
  features?: string[];
  description?: string;
  expiresAt?: string;
  confirmMsgId?: number;
};

async function getSession(): Promise<{ step: string; data: SessionData } | null> {
  const { data } = await supabase.from('telegram_sessions').select('step,data').eq('chat_id', Number(TG_CHAT)).maybeSingle();
  return data ? { step: data.step, data: data.data as SessionData } : null;
}

async function setSession(step: string, data: SessionData) {
  await supabase.from('telegram_sessions').upsert({ chat_id: Number(TG_CHAT), step, data, updated_at: new Date().toISOString() });
}

async function clearSession() {
  await supabase.from('telegram_sessions').delete().eq('chat_id', Number(TG_CHAT));
}

// ─── Feature labels ───────────────────────────────────────────────────────────

const FEATURE_LABELS: Record<string, string> = {
  free_video:   '🎬 Akses Video',
  free_booking: '📅 Booking 1:1',
  free_thread:  '💬 Post Thread',
  free_asset:   '📁 Download Asset',
  free_event:   '🎥 Join Event',
};
const ALL_FEATURES = Object.keys(FEATURE_LABELS);

function featureButtons(selected: string[]): InlineRow[] {
  const rows: InlineRow[] = ALL_FEATURES.map((f) => [{
    text: (selected.includes(f) ? '✅ ' : '☐ ') + FEATURE_LABELS[f],
    callback_data: `toggle_feat:${f}`,
  }]);
  rows.push([
    { text: '↩️ Reset', callback_data: 'feat_reset' },
    { text: '✅ Lanjut', callback_data: 'feat_done' },
  ]);
  return rows;
}

// ─── Referral confirm summary ─────────────────────────────────────────────────

function buildConfirmText(d: SessionData): string {
  const bonus = d.type === 'coin'
    ? `💰 Bonus Coin: <b>${d.credits} Ruang Coin</b>`
    : `🎁 Akses Fitur:\n${(d.features ?? []).map((f) => `  • ${FEATURE_LABELS[f]}`).join('\n')}`;
  return (
    `📋 <b>Konfirmasi Kode Referral</b>\n\n` +
    `🎟 Kode: <b>${d.code}</b>\n` +
    `${bonus}\n` +
    `📝 Keterangan: ${d.description || '—'}\n` +
    `📅 Berlaku hingga: ${d.expiresAt || 'Tidak ada batas'}\n\n` +
    `Apakah data sudah benar?`
  );
}

// ─── Save referral code ───────────────────────────────────────────────────────

async function saveReferralCode(d: SessionData): Promise<string> {
  const { data: settingsRow, error: sErr } = await supabase
    .from('learning_hub_content')
    .select('content')
    .eq('content_key', 'admin_credit_settings')
    .maybeSingle();
  if (sErr) return `❌ Gagal ambil settings: ${sErr.message}`;

  const settings = (settingsRow?.content ?? {}) as {
    packages?: unknown[]; payment?: unknown;
    referralCodes?: Array<{ code: string; credits?: number; description?: string; expiresAt?: string; type?: string; features?: string[] }>;
    coin_rate?: number;
  };
  const codes = settings.referralCodes ?? [];

  if (codes.find((r) => r.code.toLowerCase() === (d.code ?? '').toLowerCase())) {
    return `⚠️ Kode <b>${d.code}</b> sudah ada. Gunakan kode lain.`;
  }

  const newCode: typeof codes[0] = { code: d.code ?? '', type: d.type ?? 'coin' };
  if (d.type === 'coin') newCode.credits = d.credits ?? 0;
  if (d.type === 'feature') newCode.features = d.features ?? [];
  if (d.description) newCode.description = d.description;
  if (d.expiresAt) newCode.expiresAt = d.expiresAt;

  codes.push(newCode);
  const { error: uErr } = await supabase.from('learning_hub_content').upsert({
    content_key: 'admin_credit_settings',
    content_group: 'admin',
    content: { ...settings, referralCodes: codes },
  });
  if (uErr) return `❌ Gagal simpan: ${uErr.message}`;

  const bonusStr = d.type === 'coin'
    ? `+${d.credits} Ruang Coin`
    : (d.features ?? []).map((f) => FEATURE_LABELS[f]).join(', ');

  return `✅ <b>Kode Referral Dibuat!</b>\n\n🎟 Kode: <code>${d.code}</code>\n🎁 Bonus: ${bonusStr}\n📝 Keterangan: ${d.description || '—'}\n📅 Berlaku: ${d.expiresAt || 'Tidak ada batas'}`;
}

// ─── Main command handler ─────────────────────────────────────────────────────

async function handleText(text: string): Promise<void> {
  const lower = text.toLowerCase().trim();

  // Keyboard button aliases
  const mapped =
    lower === '📋 pending approval'    ? '/list'       :
    lower === '📊 pendapatan bulan ini' ? '/pendapatan' :
    lower === '🎟 lihat referral'       ? '/listref'    :
    lower === '➕ buat referral'        ? '/newref'     :
    lower;

  // Check if we're in a session flow
  const session = await getSession();

  // ─── Session flow: collecting referral form ───────────────────────────────
  if (session) {
    // Allow /cancel or main menu commands to escape the flow
    if (mapped === '/cancel' || mapped === '/batal') {
      await clearSession();
      await tgSendMenu('❌ <b>Pembuatan referral dibatalkan.</b>');
      return;
    }
    if (['/list', '/pendapatan', '/listref', '/help', '/start', '/resend'].includes(mapped)) {
      await clearSession();
      // fall through to handle the command below
    } else {
      await handleSessionInput(session.step, session.data, text);
      return;
    }
  }

  // ─── Top-level commands ───────────────────────────────────────────────────

  if (mapped === '/list' || mapped === '/pending') {
    const [{ data: topups }, { data: bookings }] = await Promise.all([
      supabase.from('topup_requests').select('id,username,display_name,package_label,credits,amount_rp').eq('status', 'pending').order('created_at', { ascending: false }).limit(10),
      supabase.from('one_on_one_bookings').select('id,requester_username,topic,preferred_date,preferred_time').eq('status', 'pending').order('created_at', { ascending: false }).limit(10),
    ]);
    const total = (topups?.length ?? 0) + (bookings?.length ?? 0);
    if (total === 0) { await tgSend('📋 <b>Pending Approval</b>\n\n✨ Tidak ada yang perlu disetujui.'); return; }
    await tgSend(`📋 <b>Pending Approval</b> — ${total} item`);
    for (const t of topups ?? []) {
      const fid = String(t.id); const sid = fid.slice(0, 8);
      await tgSend(`💰 <b>Topup Coin</b>\n\n👤 ${t.display_name ?? t.username} (@${t.username})\n📦 ${t.package_label}\n💵 ${formatRupiah(t.amount_rp)}\n🪙 ${Number(t.credits).toLocaleString('id-ID')} Coin\n🆔 <code>${sid}</code>`,
        [[{ text: '✅ Approve', callback_data: `at:${fid}` }]]);
    }
    for (const b of bookings ?? []) {
      const fid = String(b.id); const sid = fid.slice(0, 8);
      await tgSend(`📅 <b>Booking 1:1</b>\n\n👤 @${b.requester_username}\n📌 ${b.topic}\n🗓 ${b.preferred_date} pukul ${String(b.preferred_time).slice(0, 5)}\n🆔 <code>${sid}</code>`,
        [[{ text: '✅ Approve', callback_data: `ab:${fid}` }]]);
    }
    return;
  }

  if (mapped === '/resend') {
    const [{ data: topups }, { data: bookings }] = await Promise.all([
      supabase.from('topup_requests').select('*').eq('status', 'pending').order('created_at', { ascending: false }).limit(10),
      supabase.from('one_on_one_bookings').select('*').eq('status', 'pending').order('created_at', { ascending: false }).limit(10),
    ]);
    let count = 0;
    for (const t of topups ?? []) {
      const fid = String(t.id); const sid = fid.slice(0, 8);
      await tgSend(`💰 <b>Pembelian Coin — Butuh Approval</b>\n\n👤 @${t.username}\n📦 ${t.package_label}\n💵 ${formatRupiah(t.amount_rp)}\n🪙 ${Number(t.credits).toLocaleString('id-ID')} Coin\n🆔 <code>${sid}</code>`,
        [[{ text: '✅ Approve', callback_data: `at:${fid}` }]]);
      count++;
    }
    for (const b of bookings ?? []) {
      const fid = String(b.id); const sid = fid.slice(0, 8);
      await tgSend(`📅 <b>Jadwal 1:1 — Butuh Approval</b>\n\n👤 @${b.requester_username}\n📌 ${b.topic}\n🗓 ${b.preferred_date} pukul ${String(b.preferred_time).slice(0, 5)}\n🆔 <code>${sid}</code>`,
        [[{ text: '✅ Approve', callback_data: `ab:${fid}` }]]);
      count++;
    }
    await tgSend(count === 0 ? '✨ Tidak ada notifikasi pending.' : `📤 <b>${count} notifikasi</b> dikirim ulang.`);
    return;
  }

  if (mapped === '/listref') {
    const { data: settingsRow } = await supabase.from('learning_hub_content').select('content').eq('content_key', 'admin_credit_settings').maybeSingle();
    const settings = (settingsRow?.content ?? {}) as { referralCodes?: Array<{ code: string; credits?: number; description?: string; type?: string; features?: string[] }> };
    const codes = settings.referralCodes ?? [];
    if (codes.length === 0) { await tgSend('🎟 Belum ada kode referral.\n\nTap <b>➕ Buat Referral</b> untuk membuat.'); return; }
    let msg = `🎟 <b>Kode Referral Aktif (${codes.length})</b>\n\n`;
    for (const r of codes) {
      const bonus = r.type === 'feature' ? (r.features ?? []).map((f) => FEATURE_LABELS[f]).join(', ') : `${r.credits} coin`;
      msg += `• <code>${r.code}</code> — ${bonus}${r.description ? ` (${r.description})` : ''}\n`;
    }
    await tgSend(msg);
    return;
  }

  if (mapped === '/pendapatan' || mapped === '/revenue') {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const endOfMonth   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();
    const bulan = now.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
    const [{ data: topups }, { data: newUsers }, { data: bookings }] = await Promise.all([
      supabase.from('topup_requests').select('package_label,amount_rp,credits').eq('status', 'approved').gte('created_at', startOfMonth).lte('created_at', endOfMonth),
      supabase.from('app_users').select('username').gte('created_at', startOfMonth).lte('created_at', endOfMonth),
      supabase.from('one_on_one_bookings').select('status').gte('created_at', startOfMonth).lte('created_at', endOfMonth),
    ]);
    const totalRp   = (topups ?? []).reduce((s, t) => s + Number(t.amount_rp), 0);
    const totalCoin = (topups ?? []).reduce((s, t) => s + Number(t.credits), 0);
    const byPkg: Record<string, { count: number; total: number }> = {};
    for (const t of topups ?? []) {
      const k = t.package_label ?? 'Lainnya';
      if (!byPkg[k]) byPkg[k] = { count: 0, total: 0 };
      byPkg[k].count++; byPkg[k].total += Number(t.amount_rp);
    }
    const bApproved = (bookings ?? []).filter((b) => b.status === 'approved').length;
    const bPending  = (bookings ?? []).filter((b) => b.status === 'pending').length;
    let msg = `📊 <b>Pendapatan ${bulan}</b>\n\n`;
    msg += `💵 Total Pendapatan: <b>${formatRupiah(totalRp)}</b>\n`;
    msg += `🪙 Total Coin Terjual: <b>${totalCoin.toLocaleString('id-ID')} coin</b>\n`;
    msg += `🛒 Transaksi: <b>${topups?.length ?? 0}x</b>\n`;
    msg += `👤 User Baru: <b>${newUsers?.length ?? 0} orang</b>\n`;
    msg += `📅 Booking 1:1: <b>${bApproved} disetujui</b>${bPending > 0 ? `, ${bPending} pending` : ''}\n`;
    if (Object.keys(byPkg).length > 0) {
      msg += `\n<b>Per Paket:</b>\n`;
      for (const [pkg, v] of Object.entries(byPkg).sort((a, b) => b[1].total - a[1].total)) {
        msg += `• ${pkg}: ${v.count}x — ${formatRupiah(v.total)}\n`;
      }
    }
    await tgSend(msg);
    return;
  }

  if (mapped === '/newref') {
    await setSession('newref_code', {});
    await tgSend(
      `🎟 <b>Buat Kode Referral Baru</b>\n\n` +
      `Aku akan tanya beberapa hal. Ketik /batal kapan saja untuk membatalkan.\n\n` +
      `<b>1/5 — Nama Kode</b>\nKetik kode referral yang ingin dibuat:\n<i>(contoh: PROMO2026, TEMAN50)</i>`
    );
    return;
  }

  if (mapped === '/help' || mapped === '/start') {
    await tgSendMenu(
      `👋 <b>Ruang Sosmed Bot</b>\n\n` +
      `Gunakan tombol di bawah atau command:\n\n` +
      `<b>Approval</b>\n/list — Pending approval\n/resend — Kirim ulang notif pending\n\n` +
      `<b>Referral</b>\n/listref — Lihat kode referral\n/newref — Buat kode referral baru\n\n` +
      `<b>Laporan</b>\n/pendapatan — Pendapatan bulan ini`
    );
    return;
  }

  await tgSend(`❓ Command tidak dikenal. Ketik /help.`);
}

// ─── Session step handler ─────────────────────────────────────────────────────

async function handleSessionInput(step: string, data: SessionData, input: string): Promise<void> {
  const val = input.trim();

  if (step === 'newref_code') {
    if (!/^[A-Za-z0-9_-]{2,30}$/.test(val)) {
      await tgSend(`⚠️ Kode tidak valid. Gunakan huruf, angka, - atau _ (2–30 karakter).\n\nCoba lagi:`);
      return;
    }
    const newData = { ...data, code: val.toUpperCase() };
    await setSession('newref_type', newData);
    await tgSend(
      `✅ Kode: <b>${newData.code}</b>\n\n<b>2/5 — Tipe Bonus</b>\nPilih tipe bonus untuk kode ini:`,
      [[
        { text: '💰 Bonus Coin', callback_data: 'newref_type:coin' },
        { text: '🎁 Akses Fitur', callback_data: 'newref_type:feature' },
      ]]
    );
    return;
  }

  if (step === 'newref_coins') {
    const n = parseInt(val);
    if (isNaN(n) || n < 1) { await tgSend(`⚠️ Masukkan angka valid (minimal 1).\n\nBerapa coin yang diberikan?`); return; }
    const newData = { ...data, credits: n };
    await setSession('newref_desc', newData);
    await tgSend(
      `✅ Bonus: <b>${n} Ruang Coin</b>\n\n<b>4/5 — Keterangan</b>\nTulis keterangan singkat untuk kode ini:\n<i>(ketik - untuk skip)</i>`
    );
    return;
  }

  if (step === 'newref_desc') {
    const newData = { ...data, description: val === '-' ? '' : val };
    await setSession('newref_expires', newData);
    await tgSend(
      `✅ Keterangan: <b>${newData.description || '—'}</b>\n\n<b>5/5 — Berlaku Hingga</b>\nMasukkan tanggal kedaluwarsa:\n<i>Format: YYYY-MM-DD\nContoh: 2026-12-31\nKetik - untuk tidak ada batas waktu</i>`
    );
    return;
  }

  if (step === 'newref_expires') {
    let expiresAt = '';
    if (val !== '-') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) {
        await tgSend(`⚠️ Format tanggal tidak valid. Gunakan YYYY-MM-DD.\n<i>Contoh: 2026-12-31</i>\nAtau ketik - untuk tanpa batas:`);
        return;
      }
      expiresAt = val;
    }
    const newData = { ...data, expiresAt };
    await setSession('newref_confirm', newData);
    await tgSend(
      buildConfirmText(newData),
      [[
        { text: '✅ Simpan', callback_data: 'newref_confirm:yes' },
        { text: '❌ Batal', callback_data: 'newref_confirm:no' },
      ]]
    );
    return;
  }
}

// ─── Callback query handler ───────────────────────────────────────────────────

async function handleCallback(data: string, callbackId: string, chatId: number, messageId: number): Promise<void> {
  await tgAnswer(callbackId, '⏳');

  // ─── Approve / Reject topup & booking ──────────────────────────────────────
  const cbMatch = data.match(/^(at|rt|ab|rb):([a-f0-9-]{36})$/i);
  if (cbMatch) {
    const action = cbMatch[1].toLowerCase();
    const fullId = cbMatch[2].toLowerCase();

    if (action === 'at') {
      const { data: req, error } = await supabase.from('topup_requests').select('*').eq('id', fullId).eq('status', 'pending').maybeSingle();
      if (error || !req) { await tgEditButtons(chatId, messageId, '⚠️ Tidak ditemukan'); return; }
      if (!req.proof_url) { await tgEditButtons(chatId, messageId, '⚠️ Belum ada bukti transaksi — tidak bisa disetujui'); return; }
      const { data: cr } = await supabase.from('user_credits').select('balance').eq('username', req.username).maybeSingle();
      const current = (cr as { balance?: number } | null)?.balance ?? 0;
      const newBal = current + req.credits;

      const ops: Promise<unknown>[] = [
        supabase.from('topup_requests').update({ status: 'approved' }).eq('id', fullId),
        supabase.from('user_credits').upsert({ username: req.username, balance: newBal }),
        supabase.from('credit_transactions').insert({ username: req.username, amount: req.credits, type: 'topup', description: `Topup ${req.package_label} — disetujui via Telegram` }),
      ];

      // Apply promo bonus if snapshot exists
      type Promo = { active?: boolean; bonus_features?: string[]; bonus_booking?: boolean };
      const promo = req.promo_bonus as Promo | null;
      let bonusDesc = '';
      if (promo?.active) {
        const perksUpdate: Record<string, boolean> = {};
        for (const f of promo.bonus_features ?? []) perksUpdate[f] = true;
        if (promo.bonus_booking) perksUpdate['free_booking'] = true;
        if (Object.keys(perksUpdate).length > 0) {
          const { data: ep } = await supabase.from('user_profiles').select('perks').eq('username', req.username).maybeSingle();
          const cur = (ep?.perks ?? {}) as Record<string, boolean>;
          ops.push(supabase.from('user_profiles').update({ perks: { ...cur, ...perksUpdate } }).eq('username', req.username));
          const fLabels: Record<string, string> = { free_video: 'Video', free_booking: 'Booking', free_thread: 'Thread', free_asset: 'Asset', free_event: 'Event' };
          bonusDesc = [promo.bonus_booking && 'Sesi 1:1 Gratis', ...(promo.bonus_features ?? []).map((f) => fLabels[f] ?? f)].filter(Boolean).join(', ');
        }
      }

      const notifBody = bonusDesc
        ? `Paket ${req.package_label} disetujui. +${Number(req.credits).toLocaleString('id-ID')} Ruang Coin. 🎁 Bonus promo: ${bonusDesc}`
        : `Paket ${req.package_label} disetujui. +${Number(req.credits).toLocaleString('id-ID')} Ruang Coin masuk ke akunmu. Saldo: ${newBal.toLocaleString('id-ID')} coin.`;
      ops.push(supabase.from('notifications').insert([{ recipient_username: req.username, type: 'credits_added', title: bonusDesc ? '🎉 Topup + Bonus Promo!' : '💰 Topup Berhasil!', body: notifBody, link: '#profile' }]));

      await Promise.all(ops);
      await tgEditButtons(chatId, messageId, '✅ Disetujui');

      // Notify student via student bot
      const [{ data: userRow }, { data: settingsRow }] = await Promise.all([
        supabase.from('app_users').select('telegram_chat_id').eq('username', req.username).maybeSingle(),
        supabase.from('learning_hub_content').select('content').eq('content_key', 'admin_credit_settings').maybeSingle(),
      ]);
      const studentChatId = (userRow as { telegram_chat_id?: string } | null)?.telegram_chat_id;
      const settings = (settingsRow?.content ?? {}) as { student_bot_token?: string };
      const studentToken = settings.student_bot_token ?? '';
      if (studentChatId && studentToken) {
        const notifText = bonusDesc
          ? `✅ <b>Topup Disetujui!</b>\n\n📦 ${req.package_label}\n💎 +${Number(req.credits).toLocaleString('id-ID')} Ruang Coin\n🎁 Bonus: ${bonusDesc}\n\n💰 Saldo baru: <b>${newBal.toLocaleString('id-ID')} Coin</b>`
          : `✅ <b>Topup Disetujui!</b>\n\n📦 ${req.package_label}\n💎 +${Number(req.credits).toLocaleString('id-ID')} Ruang Coin masuk ke akunmu.\n\n💰 Saldo baru: <b>${newBal.toLocaleString('id-ID')} Coin</b>`;
        await fetch(`https://api.telegram.org/bot${studentToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: studentChatId, text: notifText, parse_mode: 'HTML' }),
        });
      }
      return;
    }

    if (action === 'ab') {
      const { data: b, error } = await supabase.from('one_on_one_bookings').select('*').eq('id', fullId).eq('status', 'pending').maybeSingle();
      if (error || !b) { await tgEditButtons(chatId, messageId, '⚠️ Tidak ditemukan'); return; }
      await Promise.all([
        supabase.from('one_on_one_bookings').update({ status: 'approved' }).eq('id', fullId),
        supabase.from('notifications').insert([{ recipient_username: b.requester_username, type: 'booking_approved', title: '📅 Booking 1:1 Disetujui!', body: `Sesi 1:1 "${b.topic}" pada ${b.preferred_date} pukul ${String(b.preferred_time).slice(0, 5)} telah dikonfirmasi.`, link: '#calendar' }]),
      ]);
      await tgEditButtons(chatId, messageId, '✅ Disetujui');
      return;
    }
  }

  // ─── Referral form callbacks ────────────────────────────────────────────────

  if (data === 'newref_type:coin' || data === 'newref_type:feature') {
    const session = await getSession();
    if (!session) return;
    const type = data === 'newref_type:coin' ? 'coin' : 'feature';
    const newData = { ...session.data, type };
    if (type === 'coin') {
      await setSession('newref_coins', newData);
      await tgEdit(chatId, messageId,
        `✅ Tipe: <b>Bonus Coin</b>\n\n<b>3/5 — Jumlah Coin</b>\nBerapa Ruang Coin yang diberikan sebagai bonus?`
      );
    } else {
      await setSession('newref_features', { ...newData, features: [] });
      await tgEdit(chatId, messageId,
        `✅ Tipe: <b>Akses Fitur</b>\n\n<b>3/5 — Pilih Fitur</b>\nCentang fitur yang ingin diberikan gratis:`,
        featureButtons([])
      );
    }
    return;
  }

  if (data.startsWith('toggle_feat:')) {
    const session = await getSession();
    if (!session) return;
    const feat = data.replace('toggle_feat:', '');
    const current = session.data.features ?? [];
    const updated = current.includes(feat) ? current.filter((f) => f !== feat) : [...current, feat];
    const newData = { ...session.data, features: updated };
    await setSession('newref_features', newData);
    await tgEdit(chatId, messageId,
      `✅ Tipe: <b>Akses Fitur</b>\n\n<b>3/5 — Pilih Fitur</b>\nCentang fitur yang ingin diberikan gratis:`,
      featureButtons(updated)
    );
    return;
  }

  if (data === 'feat_reset') {
    const session = await getSession();
    if (!session) return;
    const newData = { ...session.data, features: [] };
    await setSession('newref_features', newData);
    await tgEdit(chatId, messageId,
      `✅ Tipe: <b>Akses Fitur</b>\n\n<b>3/5 — Pilih Fitur</b>\nCentang fitur yang ingin diberikan gratis:`,
      featureButtons([])
    );
    return;
  }

  if (data === 'feat_done') {
    const session = await getSession();
    if (!session) return;
    if (!session.data.features?.length) {
      await tgAnswer(callbackId, '⚠️ Pilih minimal 1 fitur dulu!');
      return;
    }
    await setSession('newref_desc', session.data);
    await tgEdit(chatId, messageId,
      `✅ Fitur: <b>${(session.data.features ?? []).map((f) => FEATURE_LABELS[f]).join(', ')}</b>\n\n<b>4/5 — Keterangan</b>\nTulis keterangan singkat:\n<i>(ketik - untuk skip)</i>`
    );
    return;
  }

  if (data === 'newref_confirm:yes') {
    const session = await getSession();
    if (!session) return;
    const result = await saveReferralCode(session.data);
    await clearSession();
    await tgEdit(chatId, messageId, result);
    return;
  }

  if (data === 'newref_confirm:no') {
    await clearSession();
    await tgEdit(chatId, messageId, '❌ <b>Pembuatan referral dibatalkan.</b>');
    return;
  }
}

// ─── Bot commands registration ────────────────────────────────────────────────

async function setMyCommands() {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands: [
        { command: 'list',       description: '📋 Pending approval' },
        { command: 'pendapatan', description: '📊 Laporan pendapatan bulan ini' },
        { command: 'listref',    description: '🎟 Lihat kode referral' },
        { command: 'newref',     description: '➕ Buat kode referral baru' },
        { command: 'resend',     description: '🔁 Kirim ulang notif pending' },
        { command: 'batal',      description: '❌ Batalkan form yang sedang berjalan' },
        { command: 'help',       description: '❓ Daftar command' },
      ],
    }),
  });
}

setMyCommands().catch(() => {});

// ─── Server ───────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('OK', { status: 200 });

  try {
    type TgUpdate = {
      update_id: number;
      message?: { text?: string; chat?: { id: number } };
      callback_query?: { id: string; data?: string; from?: { id: number }; message?: { message_id: number; chat: { id: number } } };
    };

    const update = await req.json() as TgUpdate;

    if (update.callback_query) {
      const cq = update.callback_query;
      await handleCallback(
        cq.data ?? '',
        cq.id,
        cq.message?.chat.id ?? Number(TG_CHAT),
        cq.message?.message_id ?? 0
      );
      return new Response('OK', { status: 200 });
    }

    if (update.message?.text && update.message.chat?.id === Number(TG_CHAT)) {
      const text = update.message.text.trim();
      const isCommand = text.startsWith('/');
      const isKeyboardBtn = text.startsWith('📋') || text.startsWith('📊') || text.startsWith('🎟') || text.startsWith('➕');
      if (isCommand || isKeyboardBtn) {
        await handleText(text);
      } else {
        // Plain text — might be a session input
        const session = await getSession();
        if (session) await handleText(text);
      }
    }
  } catch (err) {
    console.error('Webhook error:', err);
  }

  return new Response('OK', { status: 200 });
});
