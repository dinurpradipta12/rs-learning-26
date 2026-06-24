import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ADMIN_TG_TOKEN       = Deno.env.get('TG_TOKEN') ?? '';
const ADMIN_TG_CHAT        = Deno.env.get('TG_CHAT') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Helpers ────────────────────────────────────────────────────────────────────

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

type InlineRow = Array<{ text: string; callback_data: string }>;

const STUDENT_KEYBOARD = {
  keyboard: [
    [{ text: '💰 Saldo' }, { text: '💳 Topup Coin' }],
    [{ text: '🔗 Hubungkan Akun' }, { text: '❓ Bantuan' }],
    [{ text: '📅 Event & Kelas' }, { text: '🔔 Notifikasi' }],
  ],
  resize_keyboard: true,
  persistent: true,
};

async function send(token: string, chatId: number, text: string, buttons?: InlineRow[], showMenu = true): Promise<void> {
  const body: Record<string, unknown> = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  else if (showMenu) body.reply_markup = STUDENT_KEYBOARD;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function answer(token: string, id: string, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: id, text, show_alert: false }),
  });
}

function formatRupiah(n: number) {
  return 'Rp' + Number(n).toLocaleString('id-ID');
}

async function getUserByChat(chatId: number) {
  const { data } = await supabase
    .from('app_users')
    .select('username, display_name')
    .eq('telegram_chat_id', String(chatId))
    .maybeSingle();
  return data as { username: string; display_name?: string } | null;
}

// ── Topup flow state (stored in DB) ────────────────────────────────────────────

type TopupSession = { step: 'select_pkg' | 'confirm'; pkg_id?: string; pkg_label?: string; pkg_credits?: number; pkg_price?: number };

async function getTopupSession(chatId: number): Promise<TopupSession | null> {
  const { data } = await supabase
    .from('telegram_sessions')
    .select('step, data')
    .eq('chat_id', chatId)
    .eq('bot', 'student')
    .maybeSingle();
  if (!data) return null;
  return { step: data.step as TopupSession['step'], ...(data.data as object) } as TopupSession;
}

async function setTopupSession(chatId: number, session: TopupSession): Promise<void> {
  await supabase.from('telegram_sessions').upsert({
    chat_id: chatId,
    bot: 'student',
    step: session.step,
    data: session,
    updated_at: new Date().toISOString(),
  });
}

async function clearTopupSession(chatId: number): Promise<void> {
  await supabase.from('telegram_sessions').delete().eq('chat_id', chatId).eq('bot', 'student');
}

// ── Command handlers ────────────────────────────────────────────────────────────

async function handleStart(token: string, chatId: number, text: string): Promise<void> {
  // /start <code> — account linking
  const parts = text.trim().split(/\s+/);
  const code = parts[1]?.toUpperCase();
  if (code) {
    await handleLink(token, chatId, code);
    return;
  }
  await send(token, chatId,
    `👋 <b>Halo! Ini adalah Ruang Admin Bot</b>\n\n` +
    `Bot resmi dari <b>Ruang Sosmed ID</b> untuk notifikasi dan layanan student.\n\n` +
    `<b>Cara menghubungkan akun:</b>\n` +
    `1. Login ke Ruang Sosmed ID\n` +
    `2. Buka Profil → Status Berlangganan\n` +
    `3. Klik "Generate Kode Link"\n` +
    `4. Kirim ke sini: <code>/link KODEMU</code>`,
    [
      [{ text: '💰 Cek Saldo', callback_data: 'menu_saldo' }, { text: '💳 Topup Coin', callback_data: 'topup_start' }],
      [{ text: '🔗 Hubungkan Akun', callback_data: 'menu_link' }, { text: '❓ Bantuan', callback_data: 'menu_help' }],
    ],
  );
}

async function handleLink(token: string, chatId: number, code: string): Promise<void> {
  const now = new Date().toISOString();
  const { data: linkRow } = await supabase
    .from('telegram_link_codes')
    .select('username, expires_at')
    .eq('code', code.toUpperCase())
    .maybeSingle();

  if (!linkRow) {
    await send(token, chatId, `❌ <b>Kode tidak valid.</b>\n\nPastikan kamu memasukkan kode yang benar. Generate ulang kode di app jika sudah kedaluwarsa.`);
    return;
  }

  if (new Date(linkRow.expires_at) < new Date(now)) {
    await send(token, chatId, `⏰ <b>Kode sudah kedaluwarsa.</b>\n\nSilakan generate kode baru di Ruang Sosmed ID → Profil → Status Berlangganan.`);
    return;
  }

  // Link the account
  await Promise.all([
    supabase.from('app_users').update({
      telegram_chat_id: String(chatId),
      telegram_linked_at: now,
    } as never).eq('username', linkRow.username),
    supabase.from('telegram_link_codes').delete().eq('code', code.toUpperCase()),
  ]);

  await send(token, chatId,
    `✅ <b>Akun berhasil dihubungkan!</b>\n\n` +
    `👤 Username: <b>@${linkRow.username}</b>\n\n` +
    `Mulai sekarang kamu akan menerima notifikasi langsung di sini:\n` +
    `• 💰 Status topup Ruang Coin\n` +
    `• 📢 Pengumuman & promo\n` +
    `• 🎓 Kelas dan event baru\n\n` +
    `Ketik /saldo untuk cek saldo coin kamu.`,
  );
}

async function handleSaldo(token: string, chatId: number): Promise<void> {
  const user = await getUserByChat(chatId);
  if (!user) { await send(token, chatId, `⚠️ Akun belum terhubung. Ketik /start untuk mulai.`); return; }

  const { data: credits } = await supabase
    .from('user_credits')
    .select('balance')
    .eq('username', user.username)
    .maybeSingle();

  const balance = (credits as { balance?: number } | null)?.balance ?? 0;

  const { data: txs } = await supabase
    .from('credit_transactions')
    .select('amount, description, created_at')
    .eq('username', user.username)
    .order('created_at', { ascending: false })
    .limit(3);

  let msg = `💰 <b>Saldo Ruang Coin</b>\n\n`;
  msg += `👤 ${user.display_name ?? user.username}\n`;
  msg += `💎 Saldo: <b>${balance.toLocaleString('id-ID')} Ruang Coin</b>\n\n`;

  if (txs && txs.length > 0) {
    msg += `<b>Transaksi terakhir:</b>\n`;
    for (const t of txs) {
      const sign = Number(t.amount) > 0 ? '+' : '';
      const tgl = new Date(t.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
      msg += `• ${sign}${Number(t.amount).toLocaleString('id-ID')} — ${t.description} <i>(${tgl})</i>\n`;
    }
  }

  await send(token, chatId, msg, [
    [{ text: '💳 Topup Coin', callback_data: 'topup_start' }],
    [{ text: '🏠 Menu Utama', callback_data: 'menu_help' }],
  ]);
}

async function handleTopup(token: string, chatId: number): Promise<void> {
  const user = await getUserByChat(chatId);
  if (!user) { await send(token, chatId, `⚠️ Akun belum terhubung. Ketik /start untuk mulai.`); return; }

  const { data: settingsRow } = await supabase
    .from('learning_hub_content')
    .select('content')
    .eq('content_key', 'admin_credit_settings')
    .maybeSingle();

  const settings = (settingsRow?.content ?? {}) as { packages?: Array<{ id: string; label: string; credits: number; price: number }> };
  const packages = settings.packages ?? [];

  if (packages.length === 0) {
    await send(token, chatId, `⚠️ Paket topup belum tersedia. Hubungi admin.`);
    return;
  }

  const buttons: InlineRow[] = packages.map((p) => [{
    text: `${p.label} — ${p.credits.toLocaleString('id-ID')} Coin (${formatRupiah(p.price)})`,
    callback_data: `topup_pkg:${p.id}`,
  }]);
  buttons.push([{ text: '❌ Batal', callback_data: 'topup_cancel' }]);

  await setTopupSession(chatId, { step: 'select_pkg' });
  await send(token, chatId,
    `💳 <b>Topup Ruang Coin</b>\n\nPilih paket yang kamu inginkan:`,
    buttons,
  );
}

async function handleEvents(token: string, chatId: number): Promise<void> {
  const now = new Date();
  const { data: events } = await supabase
    .from('calendar_events')
    .select('title, note, event_date, start_time, end_time, category')
    .gte('event_date', now.toISOString().slice(0, 10))
    .order('event_date', { ascending: true })
    .order('start_time', { ascending: true })
    .limit(8);

  if (!events || events.length === 0) {
    await send(token, chatId, `📅 <b>Event & Kelas</b>\n\nTidak ada event atau kelas yang akan datang saat ini.`);
    return;
  }

  let msg = `📅 <b>Event & Kelas Mendatang</b>\n\n`;
  for (const e of events) {
    const tgl = new Date(e.event_date).toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short' });
    const jam = e.start_time ? String(e.start_time).slice(0, 5) : '';
    const jamEnd = e.end_time ? `–${String(e.end_time).slice(0, 5)}` : '';
    const cat = e.category ? ` <i>[${e.category}]</i>` : '';
    msg += `📌 <b>${e.title}</b>${cat}\n`;
    msg += `🗓 ${tgl}${jam ? ` · ${jam}${jamEnd}` : ''}\n`;
    if (e.note) msg += `📝 ${e.note}\n`;
    msg += `\n`;
  }
  await send(token, chatId, msg.trim());
}

async function handleNotifInfo(token: string, chatId: number): Promise<void> {
  const user = await getUserByChat(chatId);
  const linked = !!user;
  let msg = `🔔 <b>Notifikasi</b>\n\n`;
  if (linked) {
    msg += `✅ Akun terhubung sebagai <b>@${user!.username}</b>\n\n`;
    msg += `Kamu akan otomatis menerima notifikasi:\n`;
    msg += `• 💰 Status topup Ruang Coin (approve/reject)\n`;
    msg += `• 📢 Broadcast dari admin (promo, pengumuman)\n`;
    msg += `• 🎓 Event & kelas baru\n\n`;
    msg += `Untuk berhenti menerima notifikasi, gunakan /unlink.`;
  } else {
    msg += `⚠️ Akun belum terhubung.\n\nHubungkan akun terlebih dahulu untuk menerima notifikasi.`;
  }
  await send(token, chatId, msg, [
    linked
      ? [{ text: '🔓 Unlink Akun', callback_data: 'unlink_confirm' }]
      : [{ text: '🔗 Hubungkan Akun', callback_data: 'menu_link' }],
  ]);
}

async function handleUnlink(token: string, chatId: number): Promise<void> {
  const user = await getUserByChat(chatId);
  if (!user) { await send(token, chatId, `⚠️ Akun tidak terhubung.`); return; }

  await send(token, chatId, `⚠️ Yakin ingin memutuskan koneksi akun <b>@${user.username}</b>?`,
    [[
      { text: '✅ Ya, putuskan', callback_data: 'unlink_confirm' },
      { text: '❌ Batal', callback_data: 'unlink_cancel' },
    ]],
  );
}

// ── Callback handler ────────────────────────────────────────────────────────────

async function handleCallback(token: string, chatId: number, msgId: number, data: string, cbId: string): Promise<void> {
  await answer(token, cbId, '⏳');

  if (data === 'menu_saldo') {
    await handleSaldo(token, chatId);
    return;
  }

  if (data === 'menu_link') {
    await send(token, chatId,
      `🔗 <b>Hubungkan Akun</b>\n\n` +
      `1. Login ke Ruang Sosmed ID\n` +
      `2. Buka Profil → Status Berlangganan\n` +
      `3. Klik "Generate Kode Link"\n` +
      `4. Kirim ke sini: <code>/link KODEMU</code>`,
    );
    return;
  }

  if (data === 'menu_help') {
    await send(token, chatId,
      `❓ <b>Bantuan</b>\n\n` +
      `<b>Command tersedia:</b>\n` +
      `/saldo — Cek saldo Ruang Coin\n` +
      `/topup — Topup Ruang Coin\n` +
      `/link — Hubungkan akun\n` +
      `/unlink — Putuskan koneksi akun\n` +
      `/batal — Batalkan proses aktif\n\n` +
      `Butuh bantuan lebih lanjut? Hubungi admin di app Ruang Sosmed ID.`,
      [
        [{ text: '💰 Cek Saldo', callback_data: 'menu_saldo' }, { text: '💳 Topup Coin', callback_data: 'topup_start' }],
      ],
    );
    return;
  }

  if (data === 'topup_start') {
    await handleTopup(token, chatId);
    return;
  }

  if (data === 'topup_cancel') {
    await clearTopupSession(chatId);
    await send(token, chatId, `❌ Topup dibatalkan.`);
    return;
  }

  if (data.startsWith('topup_pkg:')) {
    const pkgId = data.replace('topup_pkg:', '');
    const { data: settingsRow } = await supabase
      .from('learning_hub_content').select('content').eq('content_key', 'admin_credit_settings').maybeSingle();
    const settings = (settingsRow?.content ?? {}) as { packages?: Array<{ id: string; label: string; credits: number; price: number }>; payment?: { accountName?: string; bankName?: string; accountNumber?: string } };
    const pkg = settings.packages?.find((p) => p.id === pkgId);
    if (!pkg) { await send(token, chatId, `⚠️ Paket tidak ditemukan.`); return; }

    const payment = settings.payment ?? {};
    await setTopupSession(chatId, { step: 'confirm', pkg_id: pkg.id, pkg_label: pkg.label, pkg_credits: pkg.credits, pkg_price: pkg.price });

    await send(token, chatId,
      `📦 <b>${pkg.label}</b>\n💎 ${pkg.credits.toLocaleString('id-ID')} Ruang Coin\n💵 ${formatRupiah(pkg.price)}\n\n` +
      `<b>Transfer ke:</b>\n` +
      `🏦 ${payment.bankName ?? 'BCA'}\n` +
      `👤 ${payment.accountName ?? 'Admin Ruang Sosmed'}\n` +
      `🔢 <code>${payment.accountNumber ?? '-'}</code>\n\n` +
      `Setelah transfer, kirim bukti pembayaran (foto) ke bot ini. Request akan diproses oleh admin.\n\n` +
      `Ketik /batal untuk membatalkan.`,
    );
    return;
  }

  if (data === 'unlink_confirm') {
    const user = await getUserByChat(chatId);
    if (!user) return;
    await supabase.from('app_users').update({ telegram_chat_id: null, telegram_linked_at: null } as never).eq('username', user.username);
    await send(token, chatId, `✅ Koneksi akun <b>@${user.username}</b> berhasil diputuskan. Kamu tidak akan menerima notifikasi lagi.\n\nKetik /start untuk menghubungkan ulang.`);
    return;
  }

  if (data === 'unlink_cancel') {
    await send(token, chatId, `↩️ Dibatalkan. Akunmu masih terhubung.`);
    return;
  }
}

// ── Handle photo (topup proof) ─────────────────────────────────────────────────

async function handlePhoto(token: string, chatId: number, fileId: string): Promise<void> {
  const user = await getUserByChat(chatId);
  if (!user) { await send(token, chatId, `⚠️ Akun belum terhubung. Ketik /start untuk mulai.`); return; }

  const session = await getTopupSession(chatId);
  if (!session || session.step !== 'confirm') {
    await send(token, chatId, `⚠️ Tidak ada transaksi aktif. Mulai topup dulu dengan /topup.`);
    return;
  }

  // Get file URL
  const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const fileData = await fileRes.json() as { ok: boolean; result: { file_path: string } };
  if (!fileData.ok) { await send(token, chatId, `⚠️ Gagal memproses foto. Coba kirim ulang.`); return; }
  const proofUrl = `https://api.telegram.org/file/bot${token}/${fileData.result.file_path}`;

  // Create topup request
  const shortId = crypto.randomUUID();
  const { error: insertErr } = await supabase.from('topup_requests').insert({
    id: shortId,
    username: user.username,
    display_name: user.display_name ?? user.username,
    package_label: session.pkg_label,
    credits: session.pkg_credits,
    amount_rp: session.pkg_price,
    proof_url: proofUrl,
    status: 'pending',
  });

  if (insertErr) {
    console.error('topup insert error:', insertErr);
    await send(token, chatId, `⚠️ Gagal menyimpan request. Coba lagi atau hubungi admin.`);
    return;
  }

  // Notify admin via admin bot with approve button
  if (ADMIN_TG_TOKEN && ADMIN_TG_CHAT) {
    await fetch(`https://api.telegram.org/bot${ADMIN_TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: ADMIN_TG_CHAT,
        parse_mode: 'HTML',
        text: `📩 <b>Request Topup Baru (via Bot)</b>\n\n` +
          `👤 @${user.username}\n` +
          `📦 ${session.pkg_label}\n` +
          `💎 ${(session.pkg_credits ?? 0).toLocaleString('id-ID')} Coin\n` +
          `💵 Rp${(session.pkg_price ?? 0).toLocaleString('id-ID')}\n` +
          `🆔 ID: <code>${shortId.slice(0, 8)}</code>`,
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Approve', callback_data: `at:${shortId}` }],
          ],
        },
      }),
    });
  }

  await clearTopupSession(chatId);
  await send(token, chatId,
    `✅ <b>Bukti pembayaran diterima!</b>\n\n` +
    `📦 Paket: <b>${session.pkg_label}</b>\n` +
    `💎 ${(session.pkg_credits ?? 0).toLocaleString('id-ID')} Ruang Coin\n` +
    `🆔 ID: <code>${shortId.slice(0, 8)}</code>\n\n` +
    `Request kamu sedang diproses admin. Kamu akan mendapat notifikasi setelah disetujui.\n\n` +
    `Rata-rata waktu proses: <b>1×24 jam</b>.`,
  );
}

// ── Register bot commands ───────────────────────────────────────────────────────

async function setMyCommands(token: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands: [
        { command: 'start',  description: '👋 Mulai & hubungkan akun' },
        { command: 'link',   description: '🔗 Hubungkan akun dengan kode' },
        { command: 'saldo',  description: '💰 Cek saldo Ruang Coin' },
        { command: 'topup',  description: '💳 Topup Ruang Coin' },
        { command: 'unlink', description: '🔓 Putuskan koneksi akun' },
        { command: 'batal',  description: '❌ Batalkan proses aktif' },
        { command: 'help',   description: '❓ Bantuan' },
      ],
    }),
  });
}

// ── Server ──────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('OK', { status: 200 });

  try {
    const token = await getBotToken();
    if (!token) return new Response('Bot token not configured', { status: 500 });

    type TgUpdate = {
      message?: {
        text?: string;
        chat?: { id: number };
        photo?: Array<{ file_id: string }>;
      };
      callback_query?: {
        id: string;
        data?: string;
        message?: { message_id: number; chat: { id: number } };
      };
    };

    const update = await req.json() as TgUpdate;

    if (update.callback_query) {
      const cq = update.callback_query;
      await handleCallback(token, cq.message?.chat.id ?? 0, cq.message?.message_id ?? 0, cq.data ?? '', cq.id);
      return new Response('OK', { status: 200 });
    }

    if (update.message) {
      const chatId = update.message.chat?.id;
      if (!chatId) return new Response('OK', { status: 200 });

      // Photo upload (topup proof)
      if (update.message.photo && update.message.photo.length > 0) {
        const fileId = update.message.photo[update.message.photo.length - 1].file_id;
        await handlePhoto(token, chatId, fileId);
        return new Response('OK', { status: 200 });
      }

      const text = update.message.text?.trim() ?? '';
      const lower = text.toLowerCase();

      if (lower.startsWith('/start')) { await handleStart(token, chatId, text); return new Response('OK', { status: 200 }); }
      if (lower.startsWith('/link'))  { await handleLink(token, chatId, text.split(/\s+/)[1] ?? ''); return new Response('OK', { status: 200 }); }
      if (lower === '/saldo'         || text === '💰 Saldo')          { await handleSaldo(token, chatId); return new Response('OK', { status: 200 }); }
      if (lower === '/topup'         || text === '💳 Topup Coin')     { await handleTopup(token, chatId); return new Response('OK', { status: 200 }); }
      if (lower === '/unlink')                                         { await handleUnlink(token, chatId); return new Response('OK', { status: 200 }); }
      if (lower === '/batal' || lower === '/cancel') {
        await clearTopupSession(chatId);
        await send(token, chatId, `❌ Dibatalkan.`);
        return new Response('OK', { status: 200 });
      }
      if (lower === '/help'          || text === '❓ Bantuan')         { await handleStart(token, chatId, '/start'); return new Response('OK', { status: 200 }); }
      if (lower === '/event'         || text === '📅 Event & Kelas')  { await handleEvents(token, chatId); return new Response('OK', { status: 200 }); }
      if (lower === '/notif'         || text === '🔔 Notifikasi')     { await handleNotifInfo(token, chatId); return new Response('OK', { status: 200 }); }
      if (text === '🔗 Hubungkan Akun') {
        await send(token, chatId,
          `🔗 <b>Hubungkan Akun</b>\n\n` +
          `1. Login ke Ruang Sosmed ID\n` +
          `2. Buka Profil → Status Berlangganan\n` +
          `3. Klik "Generate Kode Link"\n` +
          `4. Kirim ke sini: <code>/link KODEMU</code>`,
        );
        return new Response('OK', { status: 200 });
      }

      // Unknown
      await send(token, chatId, `❓ Command tidak dikenal. Ketik /help untuk daftar command.`);
    }
  } catch (err) {
    console.error('Student bot webhook error:', err);
  }

  // Register commands once on first call
  getBotToken().then((t) => { if (t) setMyCommands(t).catch(() => {}); });

  return new Response('OK', { status: 200 });
});
