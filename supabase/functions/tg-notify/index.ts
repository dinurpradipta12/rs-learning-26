// tg-notify — mengirim pesan Telegram TANPA membocorkan token bot ke client.
// Token bot hanya ada di env edge function (server), bukan di bundle frontend.
//
// Secrets yang harus di-set:
//   supabase secrets set TG_TOKEN=... TG_CHAT=... STUDENT_BOT_TOKEN=...
//
// Body request:
//   { action: 'admin',        text, buttons? }                 → ke chat admin
//   { action: 'admin_photo',  text, photoUrl, buttons? }       → foto ke admin
//   { action: 'student',      chatId, text, buttons? }         → ke 1 student
//   { action: 'student_bulk', chatIds: string[], text }        → broadcast student

const TG_TOKEN = Deno.env.get('TG_TOKEN') ?? '';
const TG_CHAT = Deno.env.get('TG_CHAT') ?? '';
const STUDENT_BOT_TOKEN = Deno.env.get('STUDENT_BOT_TOKEN') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type Buttons = Array<Array<{ text: string; callback_data: string }>>;

async function tgApi(token: string, method: string, payload: Record<string, unknown>) {
  await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const body = await req.json() as {
      action: string;
      text?: string;
      chatId?: string;
      chatIds?: string[];
      photoUrl?: string;
      buttons?: Buttons;
    };
    const { action, text = '', chatId, chatIds, photoUrl, buttons } = body;
    const markup = buttons ? { inline_keyboard: buttons } : undefined;

    // Ambil username bot peserta (untuk ditampilkan di UI) tanpa membocorkan token.
    if (action === 'student_botname') {
      if (!STUDENT_BOT_TOKEN) return json({ ok: false, error: 'student bot not set' });
      const res = await fetch(`https://api.telegram.org/bot${STUDENT_BOT_TOKEN}/getMe`);
      const data = await res.json() as { ok: boolean; result?: { username?: string } };
      return json({ ok: data.ok, username: data.result?.username ?? null });
    }

    if (action === 'admin') {
      if (!TG_TOKEN || !TG_CHAT) return json({ ok: false, error: 'admin bot not configured' });
      await tgApi(TG_TOKEN, 'sendMessage', {
        chat_id: TG_CHAT, text, parse_mode: 'HTML', reply_markup: markup,
      });
      return json({ ok: true });
    }

    if (action === 'admin_photo') {
      if (!TG_TOKEN || !TG_CHAT) return json({ ok: false, error: 'admin bot not configured' });
      await tgApi(TG_TOKEN, 'sendPhoto', {
        chat_id: TG_CHAT, photo: photoUrl, caption: text, parse_mode: 'HTML', reply_markup: markup,
      });
      return json({ ok: true });
    }

    if (action === 'student') {
      if (!STUDENT_BOT_TOKEN || !chatId) return json({ ok: false, error: 'student bot / chat not set' });
      await tgApi(STUDENT_BOT_TOKEN, 'sendMessage', {
        chat_id: chatId, text, parse_mode: 'HTML', reply_markup: markup,
      });
      return json({ ok: true });
    }

    if (action === 'student_bulk') {
      if (!STUDENT_BOT_TOKEN) return json({ ok: false, error: 'student bot not set' });
      await Promise.all((chatIds ?? []).map((c) =>
        tgApi(STUDENT_BOT_TOKEN, 'sendMessage', { chat_id: c, text, parse_mode: 'HTML' })));
      return json({ ok: true });
    }

    return json({ ok: false, error: 'unknown action' });
  } catch (e) {
    return json({ ok: false, error: String(e) });
  }
});

function json(obj: unknown) {
  return new Response(JSON.stringify(obj), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
