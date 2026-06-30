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
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  return res.ok;
}

function buildMessage(type: string, eventTitle: string, eventDate: string, eventTime: string | null, eventLink: string | null): string {
  const dateStr = new Date(eventDate).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const timeStr = eventTime ? ` pukul ${eventTime.slice(0, 5)} WIB` : '';

  const linkLine = eventLink ? `\n🔗 <a href="${eventLink}">Buka Link Event</a>` : '\n⏳ Link event akan segera dikirimkan.';

  if (type === 'h1') {
    return `🔔 <b>Pengingat H-1 Event!</b>\n\n📌 <b>${eventTitle}</b>\n📅 ${dateStr}${timeStr}\n${linkLine}\n\n✅ Kamu sudah terdaftar. Sampai jumpa besok!`;
  }
  if (type === 'h3') {
    return `⏰ <b>3 Jam Lagi Event Dimulai!</b>\n\n📌 <b>${eventTitle}</b>\n📅 ${dateStr}${timeStr}\n${linkLine}\n\n🚀 Bersiap-siaplah, event akan segera dimulai!`;
  }
  // h30
  return `🚨 <b>30 Menit Lagi! Event Hampir Dimulai!</b>\n\n📌 <b>${eventTitle}</b>\n📅 ${dateStr}${timeStr}\n${linkLine}\n\n⚡ Segera bergabung sekarang!`;
}

Deno.serve(async (req) => {
  // Allow cron calls (no auth needed from pg_cron, but secure with service key header)
  if (req.method !== 'POST' && req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const botToken = await getBotToken();
  if (!botToken) {
    return new Response(JSON.stringify({ error: 'Bot token not configured' }), { status: 500 });
  }

  const now = new Date().toISOString();

  // Fetch due reminders that haven't been sent yet
  const { data: reminders, error } = await supabase
    .from('event_reminders')
    .select('*')
    .lte('scheduled_at', now)
    .is('sent_at', null)
    .limit(100);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  if (!reminders || reminders.length === 0) {
    return new Response(JSON.stringify({ sent: 0, message: 'No reminders due' }), { status: 200 });
  }

  let sent = 0;
  let failed = 0;

  for (const reminder of reminders) {
    const text = buildMessage(
      reminder.reminder_type,
      reminder.event_title,
      reminder.event_date,
      reminder.event_time,
      reminder.event_link,
    );

    const ok = await sendTelegram(botToken, reminder.telegram_chat_id, text);

    await supabase
      .from('event_reminders')
      .update({ sent_at: now, send_status: ok ? 'sent' : 'failed' })
      .eq('id', reminder.id);

    if (ok) sent++; else failed++;
  }

  return new Response(JSON.stringify({ sent, failed, total: reminders.length }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
