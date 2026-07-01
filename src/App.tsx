import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent, type FormEvent } from 'react';
import { supabase } from './lib/supabase';
import logo1 from './logo1.png';
import ruangCoinImg from './ruang-coin.png';

// ── Telegram Bot (Admin) ──────────────────────────────────────
const TG_TOKEN = '8366984234:AAHjA8l7QqvVNtc7kajGwaTwkzAy4t52Sko';
const TG_CHAT  = '8830130248';

// Kompres & resize gambar sebelum upload agar hemat storage + egress Supabase.
// File non-gambar (pdf/zip), GIF (animasi), dan SVG dikembalikan apa adanya.
async function compressImage(file: File, maxDim = 1280, quality = 0.82): Promise<File> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') return file;
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as string);
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = dataUrl;
    });
    let { width, height } = img;
    // Sudah kecil & ringan → tidak perlu diproses.
    if (width <= maxDim && height <= maxDim && file.size < 300 * 1024) return file;
    const scale = Math.min(1, maxDim / Math.max(width, height));
    width = Math.round(width * scale);
    height = Math.round(height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob || blob.size >= file.size) return file; // jangan sampai malah lebih besar
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

async function scheduleEventReminders(username: string, ev: { id: string; title: string; date: string; time?: string; link?: string }): Promise<void> {
  // Get user's telegram chat id
  const { data: userRow } = await supabase.from('app_users').select('telegram_chat_id').eq('username', username).maybeSingle();
  const chatId = (userRow as { telegram_chat_id?: string } | null)?.telegram_chat_id;
  if (!chatId) return; // user hasn't linked Telegram — skip

  // Build event datetime (combine date + time, treat as WIB = UTC+7)
  const [year, month, day] = ev.date.split('-').map(Number);
  const [hour = 0, minute = 0] = (ev.time ?? '00:00').split(':').map(Number);
  // Event local time in WIB (UTC+7): subtract 7h to get UTC
  const eventUtc = new Date(Date.UTC(year, month - 1, day, hour - 7, minute));

  const reminders = [
    { type: 'h1',  scheduled_at: new Date(eventUtc.getTime() - 24 * 60 * 60 * 1000).toISOString() },
    { type: 'h3',  scheduled_at: new Date(eventUtc.getTime() -  3 * 60 * 60 * 1000).toISOString() },
    { type: 'h30', scheduled_at: new Date(eventUtc.getTime() - 30 * 60 * 1000).toISOString() },
  ];

  // Only schedule reminders that are still in the future
  const now = new Date().toISOString();
  const rows = reminders
    .filter((r) => r.scheduled_at > now)
    .map((r) => ({
      event_id: ev.id,
      username,
      telegram_chat_id: chatId,
      event_title: ev.title,
      event_date: ev.date,
      event_time: ev.time ?? null,
      event_link: ev.link ?? null,
      reminder_type: r.type,
      scheduled_at: r.scheduled_at,
    }));

  if (rows.length > 0) {
    // Upsert — prevent duplicate rows if user re-joins
    await supabase.from('event_reminders').upsert(rows, { onConflict: 'event_id,username,reminder_type' });
  }
}

async function sendTelegram(text: string, buttons?: Array<Array<{ text: string; callback_data: string }>>): Promise<void> {
  try {
    const body: Record<string, unknown> = { chat_id: TG_CHAT, text, parse_mode: 'HTML' };
    if (buttons) body.reply_markup = { inline_keyboard: buttons };
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch { /* silent */ }
}

// ── Student Bot (Ruang Admin) ─────────────────────────────────
async function sendStudentBot(chatId: string, text: string, token: string, buttons?: Array<Array<{ text: string; callback_data: string }>>): Promise<void> {
  if (!token || !chatId) return;
  try {
    const body: Record<string, unknown> = { chat_id: chatId, text, parse_mode: 'HTML' };
    if (buttons) body.reply_markup = { inline_keyboard: buttons };
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch { /* silent */ }
}

// Token student bot dipakemkan agar tidak berubah lagi (tidak bergantung ke DB).
const STUDENT_BOT_TOKEN = '8824436093:AAFOwAwqzVzUvKp-KSTb7S6b83m9O9FIW50';

async function getStudentBotToken(): Promise<string> {
  return STUDENT_BOT_TOKEN;
}

async function getStudentChatId(username: string): Promise<string | null> {
  const { data } = await supabase.from('app_users').select('telegram_chat_id').eq('username', username).maybeSingle();
  return (data as { telegram_chat_id?: string } | null)?.telegram_chat_id ?? null;
}

async function notifyStudent(username: string, text: string): Promise<void> {
  const [chatId, token] = await Promise.all([getStudentChatId(username), getStudentBotToken()]);
  if (chatId && token) await sendStudentBot(chatId, text, token);
}

function generateLinkCode(): string {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

async function answerCallback(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
    });
  } catch { /* silent */ }
}

async function processTelegramCommand(text: string): Promise<string | null> {
  const cmd = text.trim().toLowerCase();

  // /at <shortId> → approve topup
  const atMatch = cmd.match(/^\/at\s+([a-f0-9\-]{6,8})/);
  if (atMatch) {
    const shortId = atMatch[1];
    const { data: rows } = await supabase.from('topup_requests').select('*').ilike('id', `${shortId}%`).eq('status', 'pending').limit(1);
    const req = rows?.[0];
    if (!req) return `❌ Request topup <code>${shortId}</code> tidak ditemukan atau sudah diproses.`;
    const { data: creditRow } = await supabase.from('user_credits').select('balance').eq('username', req.username).maybeSingle();
    const current = (creditRow as { balance?: number } | null)?.balance ?? 0;
    await Promise.all([
      supabase.from('topup_requests').update({ status: 'approved' }).eq('id', req.id),
      supabase.from('user_credits').upsert({ username: req.username, balance: current + req.credits }),
      supabase.from('credit_transactions').insert({ username: req.username, amount: req.credits, type: 'topup', description: `Topup ${req.package_label}` }),
    ]);
    return `✅ <b>Topup disetujui!</b>\n\n👤 @${req.username}\n💰 +${req.credits.toLocaleString('id-ID')} Ruang Coin\nSaldo baru: ${(current + req.credits).toLocaleString('id-ID')} Ruang Coin`;
  }

  // /rt <shortId> → reject topup
  const rtMatch = cmd.match(/^\/rt\s+([a-f0-9\-]{6,8})/);
  if (rtMatch) {
    const shortId = rtMatch[1];
    const { data: rows } = await supabase.from('topup_requests').select('*').ilike('id', `${shortId}%`).eq('status', 'pending').limit(1);
    const req = rows?.[0];
    if (!req) return `❌ Request topup <code>${shortId}</code> tidak ditemukan atau sudah diproses.`;
    await supabase.from('topup_requests').update({ status: 'rejected' }).eq('id', req.id);
    return `❌ <b>Topup ditolak.</b>\n\n👤 @${req.username}\n💰 ${req.credits.toLocaleString('id-ID')} Ruang Coin\nUser akan menerima notifikasi penolakan.`;
  }

  // /ab <shortId> → approve booking
  const abMatch = cmd.match(/^\/ab\s+([a-f0-9\-]{6,8})/);
  if (abMatch) {
    const shortId = abMatch[1];
    const { data: rows } = await supabase.from('one_on_one_bookings').select('*').ilike('id', `${shortId}%`).eq('status', 'pending').limit(1);
    const booking = rows?.[0];
    if (!booking) return `❌ Booking <code>${shortId}</code> tidak ditemukan atau sudah diproses.`;
    await supabase.from('one_on_one_bookings').update({ status: 'approved' }).eq('id', booking.id);
    return `✅ <b>Booking disetujui!</b>\n\n👤 @${booking.requester_username}\n📌 ${booking.topic}\n🗓 ${booking.preferred_date} pukul ${(booking.preferred_time as string).slice(0, 5)}`;
  }

  // /rb <shortId> → reject booking
  const rbMatch = cmd.match(/^\/rb\s+([a-f0-9\-]{6,8})/);
  if (rbMatch) {
    const shortId = rbMatch[1];
    const { data: rows } = await supabase.from('one_on_one_bookings').select('*').ilike('id', `${shortId}%`).eq('status', 'pending').limit(1);
    const booking = rows?.[0];
    if (!booking) return `❌ Booking <code>${shortId}</code> tidak ditemukan atau sudah diproses.`;
    await supabase.from('one_on_one_bookings').update({ status: 'rejected' }).eq('id', booking.id);
    return `❌ <b>Booking ditolak.</b>\n\n👤 @${booking.requester_username}\n📌 ${booking.topic}`;
  }

  // /help
  if (cmd === '/help' || cmd === '/start') {
    return `📋 <b>Daftar Command</b>\n\n<code>/at &lt;id&gt;</code> — Approve topup\n<code>/rt &lt;id&gt;</code> — Reject topup\n<code>/ab &lt;id&gt;</code> — Approve booking 1:1\n<code>/rb &lt;id&gt;</code> — Reject booking 1:1\n\n💡 ID dikirim otomatis di setiap notifikasi.\nContoh: <code>/at a1b2c3d4</code>`;
  }

  // command dikenal tapi tanpa ID
  if (/^\/(at|rt|ab|rb)$/.test(cmd)) {
    const labels: Record<string, string> = { at: 'approve topup', rt: 'reject topup', ab: 'approve booking', rb: 'reject booking' };
    const key = cmd.slice(1);
    return `⚠️ Format salah. Gunakan:\n<code>${cmd} &lt;id&gt;</code>\nContoh: <code>${cmd} a1b2c3d4</code>\n\nID ada di notifikasi ${labels[key] ?? ''}.`;
  }

  return `❓ Command tidak dikenal. Ketik /help untuk daftar command.`;
}

// Singleton guard: only one polling loop allowed across all React renders/mounts
let tgPollingActive = false;

function useTelegramPolling(active: boolean) {
  const offsetRef = useRef(0);
  useEffect(() => {
    if (!active) return;
    // Prevent duplicate polling instances (React StrictMode double-invoke)
    if (tgPollingActive) return;
    tgPollingActive = true;
    let cancelled = false;
    const poll = async () => {
      try {
        const url = `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${offsetRef.current}&timeout=0`;
        const res = await fetch(url);
        type TgUpdate = {
          update_id: number;
          message?: { text?: string; chat?: { id: number } };
          callback_query?: { id: string; data?: string; from?: { id: number }; message?: { message_id: number } };
        };
        const json = await res.json() as { ok: boolean; result: TgUpdate[] };
        if (json.ok && !cancelled) {
          for (const update of json.result) {
            offsetRef.current = update.update_id + 1;

            // Handle inline button tap (callback_query)
            if (update.callback_query) {
              const cq = update.callback_query;
              await answerCallback(cq.id, '⏳ Memproses...');
              const reply = await processTelegramCommand(`/${cq.data ?? ''}`);
              if (reply) await sendTelegram(reply);
              continue;
            }

            // Handle text command
            const text = update.message?.text?.trim() ?? '';
            if (!text.startsWith('/') || update.message?.chat?.id !== Number(TG_CHAT)) continue;
            const reply = await processTelegramCommand(text);
            if (reply) await sendTelegram(reply);
          }
        }
      } catch { /* silent */ }
      if (!cancelled) setTimeout(poll, 4000);
    };
    // Delete any active webhook first, then start polling
    void (async () => {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/deleteWebhook?drop_pending_updates=true`, { method: 'POST' });
      if (!cancelled) void poll();
    })();
    return () => { cancelled = true; tgPollingActive = false; };
  }, [active]);
}

function CoinIcon({ size = 16, animate = false }: { size?: number; animate?: boolean }) {
  const [anim, setAnim] = useState<'idle' | 'spin' | 'bounce'>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!animate) return;
    const cycle = () => {
      // alternate between spin and bounce
      setAnim((prev) => prev === 'idle' || prev === 'bounce' ? 'spin' : 'bounce');
      setTimeout(() => setAnim('idle'), 800);
      timerRef.current = setTimeout(cycle, 10000);
    };
    timerRef.current = setTimeout(cycle, 2000); // first play after 2s
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [animate]);

  return (
    <img
      src={ruangCoinImg}
      alt="Ruang Coin"
      width={size}
      height={size}
      className={anim === 'spin' ? 'coin-anim-spin' : anim === 'bounce' ? 'coin-anim-bounce' : ''}
      style={{ display: 'inline-block', verticalAlign: 'middle', objectFit: 'contain', marginRight: 2 }}
    />
  );
}

function CoinBalanceDisplay({ balance }: { balance: number | null }) {
  const displayed = useCountUp(balance);
  const [pulse, setPulse] = useState(false);
  const prevBalance = useRef<number | null>(null);

  useEffect(() => {
    if (balance !== null && prevBalance.current !== null && balance !== prevBalance.current) {
      setPulse(true);
      setTimeout(() => setPulse(false), 700);
    }
    prevBalance.current = balance;
  }, [balance]);

  return (
    <div className={`credit-balance-amount${pulse ? ' coin-pulse' : ''}`}>
      <CoinIcon size={32} animate />
      <span className="credit-balance-number">
        {displayed === null ? '…' : displayed.toLocaleString('id-ID')}
      </span>
      <span className="credit-balance-unit">Ruang Coin</span>
    </div>
  );
}

// Count-up hook
function useCountUp(target: number | null, duration = 900): number | null {
  const [displayed, setDisplayed] = useState<number | null>(null);
  const prevRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (target === null) return;
    const start = prevRef.current;
    const diff = target - start;
    if (diff === 0) { setDisplayed(target); return; }
    const startTime = performance.now();
    const tick = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
      // ease-out cubic
      const ease = 1 - Math.pow(1 - progress, 3);
      setDisplayed(Math.round(start + diff * ease));
      if (progress < 1) { rafRef.current = requestAnimationFrame(tick); }
      else { prevRef.current = target; setDisplayed(target); }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [target]);

  return displayed;
}

const menu = [
  {
    label: 'Dashboard',
    hash: '#dashboard',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
      </svg>
    ),
  },
  {
    label: 'Learning Center',
    hash: '#materi',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
      </svg>
    ),
  },
  {
    label: 'Calendar',
    hash: '#calendar',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
      </svg>
    ),
  },
  {
    label: 'QnA Session',
    hash: '#community',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
    ),
  },
  {
    label: 'Events',
    hash: '#events',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>
      </svg>
    ),
  },
  {
    label: 'Assets',
    hash: '#assets',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      </svg>
    ),
  },
  {
    label: 'My File',
    hash: '#myfile',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
      </svg>
    ),
  },
];

const headerMessages = [
  'Have a nice day',
  'semangat kerjanya',
  'fokus sedikit lagi, hasilnya akan terlihat',
  'hari ini waktunya naik level',
  'satu langkah kecil tetap berarti',
  'jaga ritme, jangan buru-buru',
  'ide bagus datang dari konsistensi',
  'selesaikan yang paling penting dulu',
  'belajar pelan tetap maju',
  'buat hari ini lebih rapi dari kemarin',
];

type DashboardCourse = {
  title: string;
  desc: string;
  progress: number;
  tag: string;
};

type BookingStatus = 'pending' | 'approved' | 'rejected';

type Booking = {
  id: string;
  requester_username: string;
  requester_display_name: string;
  topic: string;
  preferred_date: string;
  preferred_time: string;
  note: string;
  status: BookingStatus;
  created_at: string;
  calendar_event_id?: string | null;
};

type CalendarEventItem = {
  day: string;
  time: string;
  title: string;
  note: string;
};

type CalendarEventRow = {
  id: string;
  title: string;
  note: string;
  event_date: string;
  start_time: string;
  end_time: string;
  category: 'class' | 'review' | 'qna' | 'reminder';
  accent: 'lime' | 'purple';
  attendee_count: number;
  is_done: boolean;
  sort_order: number;
};

type CalendarEvent = {
  id: string;
  title: string;
  note: string;
  eventDate: string;
  startTime: string;
  endTime: string;
  category: CalendarEventRow['category'];
  accent: CalendarEventRow['accent'];
  attendeeCount: number;
  isDone: boolean;
  sortOrder: number;
};

type ThreadItem = {
  author: string;
  title: string;
  reply: string;
  points: string;
};

type ForumReply = {
  id: string;
  authorUsername: string;
  authorDisplayName: string;
  body: string;
  imageUrl?: string;
  createdAt: string;
  upvotes: number;
  parentReplyId?: string;
  answered?: boolean;
};

type ForumThread = {
  id: string;
  category: string;
  title: string;
  body: string;
  imageUrl?: string;
  authorUsername: string;
  authorDisplayName: string;
  createdAt: string;
  viewCount: number;
  replies: ForumReply[];
};

type ProfileStatItem = {
  label: string;
  value: string;
};

type UserProfile = {
  name: string;
  email: string;
  birthDate: string;
  photoUrl: string;
  avatarPath: string;
  role: string;
  joinedAt: string;
  subscriptionStatus: string;
  subscriptionStart: string;
  subscriptionDue: string;
  paymentMethod: string;
  renewalStatus: string;
};

type AppSession = {
  username: string;
  displayName: string;
  role: 'student' | 'developer' | 'admin';
  createdAt?: string;
};

type LocalAuthUser = {
  username: string;
  displayName: string;
  password: string;
  role: AppSession['role'];
  createdAt?: string;
};

type UserProfileRow = {
  username: string;
  name: string;
  email: string;
  job_title: string;
  birth_date: string | null;
  joined_at: string;
  avatar_path: string | null;
};

type UserSubscriptionRow = {
  username: string;
  status: string;
  started_at: string;
  due_at: string;
  payment_method: string;
  renewal_status: string;
};

type LearningHubContentKey =
  | 'dashboard_courses'
  | 'calendar_events'
  | 'community_threads'
  | 'profile_stats'
  | 'lms_assessment_questions';

const sessionStorageKey = 'ruang-sosmed-session';
const transientSessionStorageKey = 'ruang-sosmed-session-transient';
const localAuthUsersStorageKey = 'ruang-sosmed-local-auth-users';

const courses: DashboardCourse[] = [
  {
    title: 'fundamental social media',
    desc: 'strategi konten, ritme posting, dan cara membaca performa.',
    progress: 72,
    tag: 'kelas aktif',
  },
  {
    title: 'content system',
    desc: 'workflow pembuatan ide, asset, revisi, dan approval mentor.',
    progress: 54,
    tag: 'video + asset',
  },
  {
    title: 'growth and analytics',
    desc: 'cara evaluasi insight, retention, dan optimasi campaign.',
    progress: 34,
    tag: 'next batch',
  },
];

const initialLessons: Lesson[] = [
  {
    id: 'content-planning',
    title: '01: learn the basics',
    duration: '18 menit',
    meta: 'video class',
    description:
      'membahas cara menyusun ide konten, menentukan angle, dan membangun ritme posting yang konsisten.',
    videoUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    stats: ['4.5 rating', '14,115 ratings', '1.2h total duration', '3d ago', '8+ languages'],
    assets: [
      {
        title: 'content brief template',
        type: 'pdf',
        note: 'outline singkat untuk planning',
        href: assetDownloadUrl('content brief template', 'pdf'),
      },
      {
        title: 'hook bank sheet',
        type: 'sheet',
        note: 'list hook yang siap dipakai',
        href: assetDownloadUrl('hook bank sheet', 'sheet'),
      },
    ],
  },
  {
    id: 'asset-reels',
    title: '02: content asset workflow',
    duration: '12 file',
    meta: 'download asset',
    description:
      'menjelaskan struktur asset kelas yang dipakai untuk reels, termasuk cover, subtitle, dan format file.',
    videoUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    stats: ['321,195 students enrolled', 'downloadable assets', 'lms library'],
    assets: [
      {
        title: 'reel cover pack',
        type: 'zip',
        note: 'cover visual siap edit',
        href: assetDownloadUrl('reel cover pack', 'zip'),
      },
      {
        title: 'subtitle preset',
        type: 'srt',
        note: 'format subtitle dasar',
        href: assetDownloadUrl('subtitle preset', 'srt'),
      },
    ],
  },
  {
    id: 'weekly-review',
    title: '03: weekly performance review',
    duration: '9 menit',
    meta: 'case study',
    description:
      'menunjukkan cara membaca insight mingguan, menemukan pola performa, dan menentukan next action.',
    videoUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    stats: ['last updated 3d ago', 'weekly review', 'mentor guided'],
    assets: [
      {
        title: 'insight tracking sheet',
        type: 'sheet',
        note: 'rekap performa mingguan',
        href: assetDownloadUrl('insight tracking sheet', 'sheet'),
      },
    ],
  },
  {
    id: 'practice-recap',
    title: '04: practice and recap',
    duration: '11 menit',
    meta: 'exercise',
    description:
      'latihan penerapan materi sebelumnya lalu merangkum poin penting agar mudah diulang kembali.',
    videoUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    stats: ['practice round', 'recap notes', 'mentor review'],
    assets: [
      {
        title: 'practice checklist',
        type: 'pdf',
        note: 'panduan latihan mandiri',
        href: assetDownloadUrl('practice checklist', 'pdf'),
      },
    ],
  },
  {
    id: 'platform-shift',
    title: '05: platform trend shift',
    duration: '14 menit',
    meta: 'trend update',
    description:
      'membahas perubahan pola konsumsi konten di platform dan implikasinya ke strategi berikutnya.',
    videoUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    stats: ['trend update', 'platform analysis', 'new signals'],
    assets: [
      {
        title: 'trend notes',
        type: 'pdf',
        note: 'catatan update tren platform',
        href: assetDownloadUrl('trend notes', 'pdf'),
      },
    ],
  },
];
const calendarEvents: CalendarEventItem[] = [
  { day: 'senin', time: '19.00 wita', title: 'zoom class: content planning', note: 'reminder 4 jam sebelum mulai' },
  { day: 'rabu', time: '19.30 wita', title: 'review task minggu ini', note: 'reminder 1 hari sebelum mulai' },
  { day: 'jumat', time: '20.00 wita', title: 'qna mentor live', note: 'reminder 30 menit sebelum mulai' },
];

const initialCalendarSchedule: CalendarEvent[] = [
  {
    id: 'content-planning',
    title: 'Content Planning',
    note: 'Zoom class strategi konten',
    eventDate: '2026-06-15',
    startTime: '09:30',
    endTime: '10:30',
    category: 'class',
    accent: 'lime',
    attendeeCount: 8,
    isDone: false,
    sortOrder: 1,
  },
  {
    id: 'asset-review',
    title: 'Asset Review',
    note: 'Review task minggu ini',
    eventDate: '2026-06-16',
    startTime: '10:00',
    endTime: '11:00',
    category: 'review',
    accent: 'purple',
    attendeeCount: 5,
    isDone: false,
    sortOrder: 2,
  },
  {
    id: 'mentor-qna',
    title: 'Mentor QNA Live',
    note: 'Tanya jawab bersama mentor',
    eventDate: '2026-06-17',
    startTime: '11:00',
    endTime: '12:00',
    category: 'qna',
    accent: 'lime',
    attendeeCount: 12,
    isDone: false,
    sortOrder: 3,
  },
  {
    id: 'weekly-insight',
    title: 'Weekly Insight',
    note: 'Baca performa konten',
    eventDate: '2026-06-18',
    startTime: '09:00',
    endTime: '10:00',
    category: 'review',
    accent: 'purple',
    attendeeCount: 6,
    isDone: true,
    sortOrder: 4,
  },
  {
    id: 'reels-practice',
    title: 'Reels Practice',
    note: 'Latihan ide dan hook',
    eventDate: '2026-06-19',
    startTime: '10:30',
    endTime: '11:30',
    category: 'class',
    accent: 'lime',
    attendeeCount: 9,
    isDone: false,
    sortOrder: 5,
  },
  {
    id: 'community-clinic',
    title: 'Community Clinic',
    note: 'Diskusi kendala campaign',
    eventDate: '2026-06-20',
    startTime: '11:30',
    endTime: '12:30',
    category: 'qna',
    accent: 'purple',
    attendeeCount: 7,
    isDone: false,
    sortOrder: 6,
  },
];

const threads: ThreadItem[] = [
  {
    author: 'nisa',
    title: 'cara bikin hook yang lebih kuat?',
    reply: 'mentor rafi menjawab: pakai angle masalah, bukti, lalu promise hasil.',
    points: '+12 poin',
  },
  {
    author: 'dimas',
    title: 'asset kelas disimpan di mana?',
    reply: 'semua file ada di library materi per batch dan bisa diunduh ulang.',
    points: '+8 poin',
  },
];

// ── Supabase forum helpers ──────────────────────────────────

async function fetchForumThreads(): Promise<ForumThread[]> {
  const { data: threads, error: tErr } = await supabase
    .from('forum_threads')
    .select('*')
    .order('created_at', { ascending: false });
  if (tErr || !threads) return [];

  const { data: replies, error: rErr } = await supabase
    .from('forum_replies')
    .select('*')
    .order('created_at', { ascending: true });
  if (rErr) return [];

  const replyMap: Record<string, ForumReply[]> = {};
  for (const r of replies ?? []) {
    const reply: ForumReply = {
      id: r.id,
      authorUsername: r.author_username,
      authorDisplayName: r.author_display_name,
      body: r.body,
      imageUrl: r.image_url ?? undefined,
      createdAt: r.created_at,
      upvotes: r.upvotes,
      parentReplyId: r.parent_reply_id ?? undefined,
      answered: r.answered ?? false,
    };
    if (!replyMap[r.thread_id]) replyMap[r.thread_id] = [];
    replyMap[r.thread_id].push(reply);
  }

  return threads.map((t) => ({
    id: t.id,
    category: t.category,
    title: t.title,
    body: t.body,
    imageUrl: t.image_url ?? undefined,
    authorUsername: t.author_username,
    authorDisplayName: t.author_display_name,
    createdAt: t.created_at,
    viewCount: t.view_count,
    replies: replyMap[t.id] ?? [],
  }));
}

async function upsertForumThread(thread: ForumThread): Promise<void> {
  await supabase.from('forum_threads').upsert({
    id: thread.id,
    author_username: thread.authorUsername,
    author_display_name: thread.authorDisplayName,
    category: thread.category,
    title: thread.title,
    body: thread.body,
    image_url: thread.imageUrl ?? null,
    view_count: thread.viewCount,
    created_at: thread.createdAt,
  });
}

async function upsertForumReply(reply: ForumReply, threadId: string): Promise<void> {
  const { error } = await supabase.from('forum_replies').upsert({
    id: reply.id,
    thread_id: threadId,
    author_username: reply.authorUsername,
    author_display_name: reply.authorDisplayName,
    body: reply.body,
    image_url: reply.imageUrl ?? null,
    upvotes: reply.upvotes,
    parent_reply_id: reply.parentReplyId ?? null,
    created_at: reply.createdAt,
    answered: reply.answered ?? false,
  });
  if (error) throw new Error(error.message);
}

async function deleteForumThreadFromDb(threadId: string): Promise<void> {
  await supabase.from('forum_threads').delete().eq('id', threadId);
}

async function updateThreadViewCount(threadId: string, viewCount: number): Promise<void> {
  await supabase.from('forum_threads').update({ view_count: viewCount }).eq('id', threadId);
}

type NotifType = 'booking_approved' | 'booking_rejected' | 'lesson_new' | 'credits_added' | 'thread_reply';

async function insertNotification(recipient: string, type: NotifType, title: string, body: string, link?: string) {
  await supabase.from('notifications').insert([{ recipient_username: recipient, type, title, body, link: link ?? null }]);
}

// ── Confirm Modal ─────────────────────────────────────────────
function ConfirmModal({ message, onConfirm, onCancel }: { message: string; onConfirm: () => void; onCancel: () => void }) {
  return createPortal(
    <div className="confirm-overlay" onClick={onCancel}>
      <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
        <p className="confirm-message">{message}</p>
        <div className="confirm-actions">
          <button type="button" className="confirm-btn confirm-btn--cancel" onClick={onCancel}>Batal</button>
          <button type="button" className="confirm-btn confirm-btn--ok" onClick={() => { onConfirm(); onCancel(); }}>Hapus</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function useConfirm() {
  const [state, setState] = useState<{ message: string; resolve: (v: boolean) => void } | null>(null);
  const confirm = (message: string): Promise<boolean> =>
    new Promise((resolve) => setState({ message, resolve }));
  const modal = state ? (
    <ConfirmModal
      message={state.message}
      onConfirm={() => state.resolve(true)}
      onCancel={() => { state.resolve(false); setState(null); }}
    />
  ) : null;
  return { confirm, modal };
}

// ── Badge system ─────────────────────────────────────────────
type BadgeTier = 'wood' | 'silver' | 'gold' | 'diamond' | null;

function calcBadgeTier(weeklyRp: number, monthlyRp: number): BadgeTier {
  if (monthlyRp >= 10_000_000) return 'diamond';
  if (monthlyRp >= 7_000_000)  return 'gold';
  if (weeklyRp  >= 5_000_000)  return 'silver';
  if (weeklyRp  >= 1_000_000)  return 'wood';
  return null;
}

const BADGE_LABEL: Record<NonNullable<BadgeTier>, string> = {
  wood:    'Wood Member',
  silver:  'Silver Member',
  gold:    'Gold Member',
  diamond: 'Diamond Member',
};

function BadgeIcon({ tier, size = 18 }: { tier: BadgeTier; size?: number }) {
  if (!tier) return null;
  const s = size;
  const label = BADGE_LABEL[tier];

  const icons: Record<NonNullable<BadgeTier>, JSX.Element> = {
    wood: (
      <svg width={s} height={s} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id="bw-bg" cx="50%" cy="40%" r="60%">
            <stop offset="0%" stopColor="#c8975a"/>
            <stop offset="100%" stopColor="#7a4a1e"/>
          </radialGradient>
          <radialGradient id="bw-face" cx="40%" cy="35%" r="60%">
            <stop offset="0%" stopColor="#e8b87a"/>
            <stop offset="100%" stopColor="#a0622a"/>
          </radialGradient>
        </defs>
        {/* Shield shape */}
        <path d="M16 2 L28 7 L28 18 Q28 26 16 30 Q4 26 4 18 L4 7 Z" fill="url(#bw-bg)" stroke="#5a3010" strokeWidth="1"/>
        {/* Inner panel */}
        <path d="M16 5 L25 9 L25 17 Q25 23 16 27 Q7 23 7 17 L7 9 Z" fill="url(#bw-face)" opacity="0.85"/>
        {/* Bear face */}
        <circle cx="13" cy="14" r="2" fill="#5a3010" opacity="0.8"/>
        <circle cx="19" cy="14" r="2" fill="#5a3010" opacity="0.8"/>
        <ellipse cx="16" cy="17" rx="3" ry="2" fill="#5a3010" opacity="0.6"/>
        {/* Ears */}
        <circle cx="10" cy="8" r="2.5" fill="#a0622a"/>
        <circle cx="22" cy="8" r="2.5" fill="#a0622a"/>
        <circle cx="10" cy="8" r="1.5" fill="#c8975a"/>
        <circle cx="22" cy="8" r="1.5" fill="#c8975a"/>
        {/* Shine */}
        <ellipse cx="12" cy="9" rx="3" ry="1.5" fill="white" opacity="0.15" transform="rotate(-20 12 9)"/>
      </svg>
    ),
    silver: (
      <svg width={s} height={s} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id="bs-bg" cx="50%" cy="35%" r="65%">
            <stop offset="0%" stopColor="#e8e8f0"/>
            <stop offset="60%" stopColor="#a0a8c0"/>
            <stop offset="100%" stopColor="#5a6080"/>
          </radialGradient>
          <radialGradient id="bs-gem" cx="40%" cy="30%" r="60%">
            <stop offset="0%" stopColor="#d0e8ff"/>
            <stop offset="100%" stopColor="#4080c0"/>
          </radialGradient>
        </defs>
        <path d="M16 2 L28 7 L28 18 Q28 26 16 30 Q4 26 4 18 L4 7 Z" fill="url(#bs-bg)" stroke="#707898" strokeWidth="1"/>
        {/* Spike top */}
        <polygon points="16,1 18,5 14,5" fill="#c0c8e0"/>
        {/* Diamond gem center */}
        <polygon points="16,10 20,14 16,20 12,14" fill="url(#bs-gem)" stroke="#80b0e0" strokeWidth="0.5"/>
        <polygon points="16,10 20,14 16,12" fill="white" opacity="0.4"/>
        {/* Side spikes */}
        <polygon points="4,13 8,11 8,15" fill="#c0c8e0"/>
        <polygon points="28,13 24,11 24,15" fill="#c0c8e0"/>
        {/* Shine */}
        <ellipse cx="12" cy="8" rx="4" ry="2" fill="white" opacity="0.2" transform="rotate(-15 12 8)"/>
      </svg>
    ),
    gold: (
      <svg width={s} height={s} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id="bg-bg" cx="50%" cy="35%" r="65%">
            <stop offset="0%" stopColor="#ffe066"/>
            <stop offset="50%" stopColor="#e8a020"/>
            <stop offset="100%" stopColor="#9a5800"/>
          </radialGradient>
          <radialGradient id="bg-face" cx="40%" cy="35%" r="60%">
            <stop offset="0%" stopColor="#fff0a0"/>
            <stop offset="100%" stopColor="#c87800"/>
          </radialGradient>
          <radialGradient id="bg-gem" cx="40%" cy="30%" r="60%">
            <stop offset="0%" stopColor="#ffffc0"/>
            <stop offset="100%" stopColor="#e8a020"/>
          </radialGradient>
        </defs>
        {/* Outer shield with spikes */}
        <path d="M16 1 L18 5 L28 7 L28 18 Q28 27 16 31 Q4 27 4 18 L4 7 L14 5 Z" fill="url(#bg-bg)" stroke="#b07000" strokeWidth="1"/>
        {/* Inner shield */}
        <path d="M16 6 L24 10 L24 18 Q24 24 16 27 Q8 24 8 18 L8 10 Z" fill="url(#bg-face)" opacity="0.9"/>
        {/* Lion face */}
        <circle cx="13.5" cy="15" r="1.8" fill="#8a5000" opacity="0.9"/>
        <circle cx="18.5" cy="15" r="1.8" fill="#8a5000" opacity="0.9"/>
        <circle cx="16" cy="18" r="2.2" fill="#8a5000" opacity="0.7"/>
        {/* Mane spikes */}
        <polygon points="16,7 17.5,11 14.5,11" fill="#e8a020"/>
        <polygon points="11,9 13,12 10,13" fill="#e8a020"/>
        <polygon points="21,9 19,12 22,13" fill="#e8a020"/>
        {/* Crown gems */}
        <circle cx="16" cy="4" r="1.5" fill="#fff0a0"/>
        <circle cx="12" cy="5" r="1" fill="#ffe066"/>
        <circle cx="20" cy="5" r="1" fill="#ffe066"/>
        {/* Shine */}
        <ellipse cx="12" cy="9" rx="4" ry="1.8" fill="white" opacity="0.25" transform="rotate(-20 12 9)"/>
      </svg>
    ),
    diamond: (
      <svg width={s} height={s} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id="bd-bg" cx="50%" cy="30%" r="70%">
            <stop offset="0%" stopColor="#e0d0ff"/>
            <stop offset="40%" stopColor="#a060e0"/>
            <stop offset="100%" stopColor="#3a0080"/>
          </radialGradient>
          <radialGradient id="bd-gold" cx="40%" cy="30%" r="60%">
            <stop offset="0%" stopColor="#ffe880"/>
            <stop offset="100%" stopColor="#c08000"/>
          </radialGradient>
          <radialGradient id="bd-gem" cx="35%" cy="30%" r="65%">
            <stop offset="0%" stopColor="#ffffff"/>
            <stop offset="30%" stopColor="#c0e8ff"/>
            <stop offset="100%" stopColor="#4040c0"/>
          </radialGradient>
        </defs>
        {/* Outer ornate shield */}
        <path d="M16 1 L19 4 L28 6 L29 18 Q29 27 16 31 Q3 27 3 18 L4 6 L13 4 Z" fill="url(#bd-bg)" stroke="#8040c0" strokeWidth="0.8"/>
        {/* Gold trim */}
        <path d="M16 3 L18 6 L26 8 L26 18 Q26 25 16 29 Q6 25 6 18 L6 8 L14 6 Z" fill="none" stroke="url(#bd-gold)" strokeWidth="1.2"/>
        {/* Dragon face */}
        <polygon points="16,8 20,12 18,16 14,16 12,12" fill="url(#bd-gold)" opacity="0.9"/>
        {/* Dragon eyes */}
        <circle cx="13.5" cy="13" r="1.5" fill="#ff4040"/>
        <circle cx="18.5" cy="13" r="1.5" fill="#ff4040"/>
        <circle cx="13.8" cy="12.8" r="0.6" fill="white" opacity="0.6"/>
        <circle cx="18.8" cy="12.8" r="0.6" fill="white" opacity="0.6"/>
        {/* Center gem */}
        <polygon points="16,17 19,20 16,24 13,20" fill="url(#bd-gem)" stroke="#8080ff" strokeWidth="0.5"/>
        <polygon points="16,17 19,20 16,19" fill="white" opacity="0.5"/>
        {/* Crown spikes with gems */}
        <polygon points="16,1 17.5,5 14.5,5" fill="url(#bd-gold)"/>
        <polygon points="10,3 12,7 9,7" fill="url(#bd-gold)"/>
        <polygon points="22,3 23,7 20,7" fill="url(#bd-gold)"/>
        <circle cx="16" cy="2" r="1.2" fill="#c0e8ff"/>
        <circle cx="10.5" cy="3.5" r="0.9" fill="#ff80ff"/>
        <circle cx="21.5" cy="3.5" r="0.9" fill="#ff80ff"/>
        {/* Side ornaments */}
        <polygon points="3,13 7,11 7,15" fill="url(#bd-gold)"/>
        <polygon points="29,13 25,11 25,15" fill="url(#bd-gold)"/>
        {/* Shine */}
        <ellipse cx="11" cy="8" rx="4" ry="1.8" fill="white" opacity="0.3" transform="rotate(-20 11 8)"/>
      </svg>
    ),
  };

  return (
    <span className="badge-icon" title={label} style={{ display: 'inline-flex', alignItems: 'center', cursor: 'default', flexShrink: 0 }}>
      {icons[tier]}
      <span className="badge-tooltip">{label}</span>
    </span>
  );
}

// ── Badge fetcher hook ────────────────────────────────────────
function useBadgeTier(username: string): BadgeTier {
  const [tier, setTier] = useState<BadgeTier>(null);
  useEffect(() => {
    if (!username) return;
    void supabase.rpc('get_user_badge_tiers').then(({ data }) => {
      const rows = (data ?? []) as { username: string; tier: BadgeTier }[];
      const found = rows.find((r) => r.username === username);
      setTier(found?.tier ?? null);
    });
  }, [username]);
  return tier;
}

// ── Global badge map (admin/forum views) ─────────────────────
// Uses RPC to avoid exposing raw topup amounts through RLS
async function fetchAllBadgeTiers(): Promise<Record<string, BadgeTier>> {
  const { data } = await supabase.rpc('get_user_badge_tiers') as { data: { username: string; tier: BadgeTier }[] | null };
  const result: Record<string, BadgeTier> = {};
  for (const row of (data ?? [])) result[row.username] = row.tier;
  return result;
}

function timeAgo(isoString: string) {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'baru saja';
  if (mins < 60) return `${mins}m yang lalu`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}j yang lalu`;
  const days = Math.floor(hours / 24);
  return `${days}h yang lalu`;
}

function forumAvatarSvg(displayName: string, seed: string) {
  const colors = [
    ['#b389ff', '#7a4fd6'],
    ['#ff8fa3', '#c94068'],
    ['#80d8ff', '#0288d1'],
    ['#a5d6a7', '#388e3c'],
    ['#ffcc80', '#ef6c00'],
    ['#f48fb1', '#ad1457'],
    ['#90caf9', '#1565c0'],
    ['#ce93d8', '#6a1b9a'],
  ];
  const index = seed.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % colors.length;
  const [c1, c2] = colors[index];
  const label = displayName
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('') || displayName.slice(0, 2).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/></linearGradient></defs><rect width="40" height="40" rx="20" fill="url(#g)"/><text x="20" y="26" text-anchor="middle" fill="#fff" font-family="Manrope,Arial,sans-serif" font-size="14" font-weight="700">${escapeXml(label)}</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

const profileStats: ProfileStatItem[] = [
  { label: 'progress bulan ini', value: '78%' },
  { label: 'pertanyaan terjawab', value: '24' },
  { label: 'poin terkumpul', value: '320' },
];

const initialReviews = [
  {
    name: 'nisa',
    rating: 5,
    feedback: 'materinya jelas, contoh yang dipakai gampang diikuti.',
  },
  {
    name: 'dimas',
    rating: 4,
    feedback: 'alur videonya enak, tinggal butuh lebih banyak praktik.',
  },
];

type Review = {
  id?: string;
  name: string;
  username?: string | null;
  avatarUrl?: string | null;
  rating: number;
  feedback: string;
};

type ReviewRow = {
  id: string;
  lesson_key: string;
  reviewer_name: string;
  reviewer_username: string | null;
  rating: number;
  feedback: string;
  created_at: string;
};

type LessonProgressRow = {
  session_username: string;
  lesson_key: string;
  completed_at: string;
};

const initialAssessmentQuestions: AssessmentQuestion[] = [
  {
    id: 'q-1',
    prompt: 'Apa tujuan utama dari content planning?',
    options: [
      'Membuat ide konten lebih terarah',
      'Menghapus seluruh asset kelas',
      'Menentukan font saja',
      'Membuat jadwal meeting mentor',
    ],
    correctIndex: 0,
    answerIndex: null,
  },
  {
    id: 'q-2',
    prompt: 'Apa yang perlu diperhatikan saat membaca insight mingguan?',
    options: [
      'Warna thumbnail',
      'Pola performa dan engagement',
      'Jumlah folder asset',
      'Ukuran video',
    ],
    correctIndex: 1,
    answerIndex: null,
  },
];

type LessonAsset = {
  title: string;
  type: string;
  note: string;
  href: string;
  links?: { label: string; href: string }[];
  externalUrl?: string;
  storagePath?: string;
  sortOrder?: number;
};

type Lesson = {
  id: string;
  sortOrder?: number;
  title: string;
  duration: string;
  meta: string;
  description: string;
  videoUrl: string;
  stats: string[];
  assets: LessonAsset[];
};

type LessonRow = {
  lesson_key: string;
  course_key?: string;
  sort_order: number;
  title: string;
  duration: string;
  meta: string;
  description: string;
  video_url: string;
};

type LessonAssetRow = {
  asset_key: string;
  lesson_key: string;
  sort_order: number;
  title: string;
  type: string;
  note: string;
  storage_path: string | null;
  external_url: string | null;
};

type LessonAssetDraftLink = {
  id: string;
  title: string;
  url: string;
};

type LessonAssetDraftItem = {
  id: string;
  title: string;
  type: string;
  note: string;
  links: LessonAssetDraftLink[];
};

type ParsedAssetLink = {
  title: string;
  href: string;
  storagePath: string | undefined;
  externalUrl: string | undefined;
};

type LessonEditorDraft = {
  title: string;
  duration: string;
  meta: string;
  description: string;
  videoUrl: string;
  statsText: string;
  assets: LessonAssetDraftItem[];
};

type AssessmentQuestion = {
  id: string;
  prompt: string;
  options: string[];
  correctIndex: number;
  answerIndex: number | null;
};

type AssessmentResult = {
  score: number;
  correctCount: number;
  totalCount: number;
};

function getPage(hash: string) {
  if (hash.startsWith('#profil')) return 'profil';
  if (hash === '#materi') return 'materi';
  if (hash === '#calendar') return 'calendar';
  if (hash === '#community') return 'community';
  if (hash === '#assets') return 'assets';
  if (hash === '#events') return 'events';
  if (hash === '#myfile') return 'myfile';
  if (hash === '#admin') return 'admin';
  if (hash === '#inbox' || hash === '#inbox-topup') return 'inbox';
  if (hash === '#login') return 'login';
  return 'dashboard';
}

function readStoredSession() {
  if (typeof window === 'undefined') {
    return null;
  }

  const rawSession = window.localStorage.getItem(sessionStorageKey) ?? window.sessionStorage.getItem(transientSessionStorageKey);

  if (!rawSession) {
    return null;
  }

  try {
    return JSON.parse(rawSession) as AppSession;
  } catch {
    return null;
  }
}

function persistStoredSession(session: AppSession, rememberMe: boolean) {
  if (typeof window === 'undefined') {
    return;
  }

  const serializedSession = JSON.stringify(session);

  window.localStorage.removeItem(sessionStorageKey);
  window.sessionStorage.removeItem(transientSessionStorageKey);

  if (rememberMe) {
    window.localStorage.setItem(sessionStorageKey, serializedSession);
  } else {
    window.sessionStorage.setItem(transientSessionStorageKey, serializedSession);
  }
}

function clearStoredSession() {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.removeItem(sessionStorageKey);
  window.sessionStorage.removeItem(transientSessionStorageKey);
}

function userProfileStorageKey(username: string) {
  return `ruang-sosmed-profile-${username}`;
}

function profileAvatarPublicUrl(avatarPath: string) {
  return supabase.storage.from('profile-avatars').getPublicUrl(avatarPath).data.publicUrl;
}

function toLocalDateKey(date: Date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function todayDateString() {
  return toLocalDateKey(new Date());
}

function addDaysToDate(dateString: string, days: number) {
  const date = new Date(`${dateString}T00:00:00`);
  date.setDate(date.getDate() + days);

  return toLocalDateKey(date);
}

function formatHeaderDate(date: Date) {
  const dayNames = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const dayName = dayNames[date.getDay()];
  const day = date.getDate();
  const month = monthNames[date.getMonth()];
  const year = date.getFullYear();
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const period = hours >= 12 ? 'pm' : 'am';

  hours %= 12;
  if (hours === 0) {
    hours = 12;
  }

  return `${dayName}, ${day} ${month} ${year} - ${String(hours).padStart(2, '0')}:${minutes} ${period}`;
}

function formatShortDate(dateString: string) {
  const date = new Date(`${dateString}T00:00:00`);
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

  return `${String(date.getDate()).padStart(2, '0')} ${monthNames[date.getMonth()]} ${date.getFullYear()}`;
}

function formatClockRange(startTime: string, endTime: string) {
  const toLabel = (time: string) => {
    const [hourString, minuteString] = time.split(':');
    let hour = Number(hourString);
    const period = hour >= 12 ? 'pm' : 'am';
    hour %= 12;
    if (hour === 0) {
      hour = 12;
    }

    return `${hour}:${minuteString} ${period}`;
  };

  return `${toLabel(startTime)} - ${toLabel(endTime)}`;
}

function formatTimelineHour(hour: number) {
  const normalizedHour = ((hour % 24) + 24) % 24;
  const period = normalizedHour >= 12 ? 'pm' : 'am';
  let displayHour = normalizedHour % 12;
  if (displayHour === 0) {
    displayHour = 12;
  }

  return `${String(displayHour).padStart(2, '0')} ${period}`;
}

function formatCurrentClock(date: Date) {
  let hour = date.getHours();
  const period = hour >= 12 ? 'pm' : 'am';
  hour %= 12;
  if (hour === 0) {
    hour = 12;
  }

  return `${String(hour).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')} ${period}`;
}

function timeToMinutes(time: string) {
  const [hourString, minuteString] = time.split(':');
  return Number(hourString) * 60 + Number(minuteString);
}

function dateKeyFromDate(date: Date) {
  return toLocalDateKey(date);
}

function formatCalendarMonth(dateString: string) {
  const date = new Date(`${dateString}T00:00:00`);
  const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];

  return `${monthNames[date.getMonth()]} ${date.getFullYear()}`;
}

function weekDatesFromDate(dateString: string) {
  const sourceDate = new Date(`${dateString}T00:00:00`);
  const mondayOffset = sourceDate.getDay() === 0 ? -6 : 1 - sourceDate.getDay();

  return Array.from({ length: 7 }, (_, index) => {
    const nextDate = new Date(sourceDate);
    nextDate.setDate(sourceDate.getDate() + mondayOffset + index);
    return nextDate;
  });
}

function monthDatesFromDate(dateString: string) {
  const sourceDate = new Date(`${dateString}T00:00:00`);
  const firstDate = new Date(sourceDate.getFullYear(), sourceDate.getMonth(), 1);
  const mondayOffset = firstDate.getDay() === 0 ? -6 : 1 - firstDate.getDay();

  return Array.from({ length: 42 }, (_, index) => {
    const nextDate = new Date(firstDate);
    nextDate.setDate(firstDate.getDate() + mondayOffset + index);
    return nextDate;
  });
}

function defaultUserProfile(session: AppSession): UserProfile {
  const joinedAt = session.createdAt?.slice(0, 10) || todayDateString();

  return {
    name: session.displayName || session.username,
    email: `${session.username}@ruangsosmed.local`,
    birthDate: '2000-01-01',
    photoUrl: '',
    avatarPath: '',
    role: session.role === 'developer' ? 'developer' : 'student',
    joinedAt,
    subscriptionStatus: session.role === 'student' ? 'aktif' : 'developer access',
    subscriptionStart: joinedAt,
    subscriptionDue: addDaysToDate(joinedAt, 30),
    paymentMethod: 'manual transfer',
    renewalStatus: 'siap diperpanjang',
  };
}

function readUserProfile(session: AppSession) {
  if (typeof window === 'undefined') {
    return defaultUserProfile(session);
  }

  const rawProfile = window.localStorage.getItem(userProfileStorageKey(session.username));
  if (!rawProfile) {
    return defaultUserProfile(session);
  }

  try {
    return { ...defaultUserProfile(session), ...(JSON.parse(rawProfile) as Partial<UserProfile>) };
  } catch {
    return defaultUserProfile(session);
  }
}

function persistUserProfile(username: string, profile: UserProfile) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(userProfileStorageKey(username), JSON.stringify(profile));
}

function mapSupabaseProfile(
  session: AppSession,
  profileRow: UserProfileRow | null,
  subscriptionRow: UserSubscriptionRow | null,
) {
  const fallback = defaultUserProfile(session);
  const avatarPath = profileRow?.avatar_path ?? '';

  return {
    ...fallback,
    name: profileRow?.name ?? fallback.name,
    email: profileRow?.email ?? fallback.email,
    birthDate: profileRow?.birth_date ?? fallback.birthDate,
    photoUrl: avatarPath ? profileAvatarPublicUrl(avatarPath) : fallback.photoUrl,
    avatarPath,
    role: profileRow?.job_title ?? fallback.role,
    joinedAt: profileRow?.joined_at ?? fallback.joinedAt,
    subscriptionStatus: subscriptionRow?.status ?? fallback.subscriptionStatus,
    subscriptionStart: subscriptionRow?.started_at ?? fallback.subscriptionStart,
    subscriptionDue: subscriptionRow?.due_at ?? fallback.subscriptionDue,
    paymentMethod: subscriptionRow?.payment_method ?? fallback.paymentMethod,
    renewalStatus: subscriptionRow?.renewal_status ?? fallback.renewalStatus,
  } satisfies UserProfile;
}

async function ensureSupabaseUserProfile(session: AppSession) {
  const fallback = defaultUserProfile(session);

  await Promise.all([
    supabase.from('user_profiles').upsert(
      {
        username: session.username,
        name: fallback.name,
        email: fallback.email,
        job_title: fallback.role,
        birth_date: fallback.birthDate,
        joined_at: fallback.joinedAt,
        avatar_path: null,
      },
      { onConflict: 'username', ignoreDuplicates: true },
    ),
    supabase.rpc('upsert_user_subscription', {
      p_username: session.username,
      p_status: fallback.subscriptionStatus,
      p_started_at: fallback.subscriptionStart ?? null,
      p_due_at: fallback.subscriptionDue ?? null,
      p_payment_method: fallback.paymentMethod ?? null,
      p_renewal_status: fallback.renewalStatus ?? null,
    }),
  ]);
}

async function loadSupabaseUserProfile(session: AppSession) {
  await ensureSupabaseUserProfile(session);

  const [{ data: profileRow, error: profileError }, { data: subscriptionRow, error: subscriptionError }] = await Promise.all([
    supabase
      .from('user_profiles')
      .select('username, name, email, job_title, birth_date, joined_at, avatar_path')
      .eq('username', session.username)
      .maybeSingle(),
    supabase
      .from('user_subscriptions')
      .select('username, status, started_at, due_at, payment_method, renewal_status')
      .eq('username', session.username)
      .maybeSingle(),
  ]);

  if (profileError || subscriptionError) {
    console.warn('supabase load failed for profile', profileError ?? subscriptionError);
    return readUserProfile(session);
  }

  return mapSupabaseProfile(
    session,
    (profileRow ?? null) as UserProfileRow | null,
    (subscriptionRow ?? null) as UserSubscriptionRow | null,
  );
}

function readLocalAuthUsers() {
  if (typeof window === 'undefined') {
    return [
      {
        username: 'arunika',
        displayName: 'arunika',
        password: 'ar4925',
        role: 'developer',
        createdAt: '2026-06-01T00:00:00.000Z',
      },
    ] satisfies LocalAuthUser[];
  }

  const rawUsers = window.localStorage.getItem(localAuthUsersStorageKey);

  if (!rawUsers) {
    return [
      {
        username: 'arunika',
        displayName: 'arunika',
        password: 'ar4925',
        role: 'developer',
        createdAt: '2026-06-01T00:00:00.000Z',
      },
    ] satisfies LocalAuthUser[];
  }

  try {
    const parsedUsers = JSON.parse(rawUsers) as LocalAuthUser[];
    return Array.isArray(parsedUsers) && parsedUsers.length > 0 ? parsedUsers : [];
  } catch {
    return [];
  }
}

function persistLocalAuthUsers(users: LocalAuthUser[]) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(localAuthUsersStorageKey, JSON.stringify(users));
}

function isMissingSupabaseFunctionError(error: unknown, functionName: string) {
  const message = error instanceof Error ? error.message : String(error);

  return (
    message.includes(`Could not find the function public.${functionName}`) ||
    message.includes('schema cache') ||
    message.includes('PGRST202')
  );
}

function authenticateLocalUser(username: string, password: string) {
  const normalizedUsername = username.trim().toLowerCase();
  const matchedUser = readLocalAuthUsers().find(
    (user) => user.username.toLowerCase() === normalizedUsername && user.password === password,
  );

  if (!matchedUser) {
    return null;
  }

  return {
    username: matchedUser.username,
    displayName: matchedUser.displayName,
    role: matchedUser.role,
    createdAt: matchedUser.createdAt,
  } satisfies AppSession;
}

function registerLocalUser(username: string, displayName: string, password: string) {
  const normalizedUsername = username.trim().toLowerCase();
  const normalizedDisplayName = displayName.trim() || normalizedUsername;
  const currentUsers = readLocalAuthUsers();

  if (currentUsers.some((user) => user.username.toLowerCase() === normalizedUsername)) {
    throw new Error('username sudah dipakai');
  }

  const nextUsers = [
    ...currentUsers,
    {
      username: normalizedUsername,
      displayName: normalizedDisplayName,
      password,
      role: 'student',
      createdAt: new Date().toISOString(),
    },
  ] satisfies LocalAuthUser[];

  persistLocalAuthUsers(nextUsers);

  return {
    username: normalizedUsername,
    displayName: normalizedDisplayName,
    role: 'student',
    createdAt: nextUsers.at(-1)?.createdAt,
  } satisfies AppSession;
}

function assetDownloadUrl(title: string, type: string) {
  const content = `${title}\n\nType: ${type}\nThis is a placeholder asset file for Ruang Sosmed Learning Center.`;
  return `data:text/plain;charset=utf-8,${encodeURIComponent(content)}`;
}

function sanitizeFileName(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').toLowerCase();
}

function avatarForSession(session: AppSession) {
  const label = session.displayName
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || session.username.slice(0, 2).toUpperCase();

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">
      <defs>
        <linearGradient id="avatar-g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="#b389ff" />
          <stop offset="100%" stop-color="#7a4fd6" />
        </linearGradient>
      </defs>
      <rect width="96" height="96" rx="48" fill="url(#avatar-g)" />
      <text x="48" y="56" text-anchor="middle" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="30" font-weight="700">${escapeXml(label)}</text>
    </svg>
  `;

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function resolveLessonAssetHref(asset: Pick<LessonAssetRow, 'storage_path' | 'external_url' | 'title' | 'type'>) {
  if (asset.external_url) {
    return asset.external_url;
  }

  if (asset.storage_path) {
    return supabase.storage.from('lesson-assets').getPublicUrl(asset.storage_path).data.publicUrl;
  }

  return assetDownloadUrl(asset.title, asset.type);
}

function resolveAssetLinkToken(token: string, fallbackLabel: string, index: number) {
  const trimmedToken = token.trim();
  if (!trimmedToken) {
    return null;
  }

  const [labelPart, hrefPart] = trimmedToken.includes('::')
    ? trimmedToken.split('::').map((part) => part.trim())
    : ['', trimmedToken];

  if (!hrefPart) {
    return null;
  }

  if (hrefPart.startsWith('storage:')) {
    const storagePath = hrefPart.replace(/^storage:/, '');
    return {
      label: labelPart || `${fallbackLabel} ${index + 1}`,
      href: supabase.storage.from('lesson-assets').getPublicUrl(storagePath).data.publicUrl,
    };
  }

  return {
    label: labelPart || `${fallbackLabel} ${index + 1}`,
    href: hrefPart,
  };
}

function resolveLessonAssetLinks(asset: Pick<LessonAssetRow, 'storage_path' | 'external_url' | 'title' | 'type'>) {
  const rawLinkTokens = [
    ...(asset.storage_path ? [`storage:${asset.storage_path}`] : []),
    ...(asset.external_url ? asset.external_url.split(',').map((part) => part.trim()).filter(Boolean) : []),
  ];

  const links = rawLinkTokens
    .map((token, index) => resolveAssetLinkToken(token, 'link', index))
    .filter((link): link is { label: string; href: string } => Boolean(link));

  if (links.length > 0) {
    return links;
  }

  return [{ label: 'download', href: assetDownloadUrl(asset.title, asset.type) }];
}

function mapLessonRowsToLessons(lessonRows: LessonRow[], assetRows: LessonAssetRow[]) {
  const assetsByLesson = new Map<string, LessonAsset[]>();

  assetRows.forEach((assetRow) => {
    const lessonAssets = assetsByLesson.get(assetRow.lesson_key) ?? [];
    const assetLinks = resolveLessonAssetLinks(assetRow);
    lessonAssets.push({
      title: assetRow.title,
      type: assetRow.type,
      note: assetRow.note,
      href: assetLinks[0]?.href ?? resolveLessonAssetHref(assetRow),
      links: assetLinks,
      externalUrl: assetRow.external_url ?? undefined,
      storagePath: assetRow.storage_path ?? undefined,
      sortOrder: assetRow.sort_order,
    });
    assetsByLesson.set(assetRow.lesson_key, lessonAssets);
  });

  return lessonRows
    .sort((left, right) => left.sort_order - right.sort_order)
    .map((lessonRow) => ({
      id: lessonRow.lesson_key,
      sortOrder: lessonRow.sort_order,
      title: lessonRow.title,
      duration: lessonRow.duration,
      meta: lessonRow.meta,
      description: lessonRow.description,
      videoUrl: lessonRow.video_url,
      stats: [],
      assets: assetsByLesson.get(lessonRow.lesson_key)?.sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0)) ?? [],
    }));
}

function mapCalendarEventRow(row: CalendarEventRow): CalendarEvent {
  return {
    id: row.id,
    title: row.title,
    note: row.note,
    eventDate: row.event_date,
    startTime: row.start_time,
    endTime: row.end_time,
    category: row.category,
    accent: row.accent,
    attendeeCount: row.attendee_count,
    isDone: row.is_done,
    sortOrder: row.sort_order,
  };
}

function useCalendarEvents() {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  function reloadCalendarEvents() { setReloadKey((k) => k + 1); }

  useEffect(() => {
    let isActive = true;

    const loadEvents = async () => {
      setIsLoading(true);

      const [{ data, error }, { data: bookingData }] = await Promise.all([
        supabase
          .from('calendar_events')
          .select('id, title, note, event_date, start_time, end_time, category, accent, attendee_count, is_done, sort_order')
          .order('event_date', { ascending: true })
          .order('start_time', { ascending: true }),
        supabase
          .from('one_on_one_bookings')
          .select('id, topic, preferred_date, preferred_time, requester_username, requester_display_name')
          .eq('status', 'approved'),
      ]);

      if (!isActive) {
        return;
      }

      if (error) {
        console.warn('supabase load failed for calendar_events', error);
        setEvents(initialCalendarSchedule);
        setIsLoading(false);
        return;
      }

      const calendarEvts = (data as CalendarEventRow[] | null)?.map(mapCalendarEventRow) ?? initialCalendarSchedule;

      // Merge approved bookings as calendar events
      const bookingEvts: CalendarEvent[] = ((bookingData ?? []) as {
        id: string; topic: string; preferred_date: string; preferred_time: string;
        requester_username: string; requester_display_name: string;
      }[]).map((b) => ({
        id: `booking-${b.id}`,
        title: `📅 1:1 — ${b.topic}`,
        note: `Booking dari ${b.requester_display_name ?? b.requester_username}`,
        eventDate: b.preferred_date,
        startTime: String(b.preferred_time ?? '').slice(0, 5),
        endTime: '',
        category: 'zoom' as CalendarEventRow['category'],
        accent: '#6366f1' as CalendarEventRow['accent'],
        attendeeCount: 1,
        isDone: false,
        sortOrder: 99,
      }));

      setEvents([...calendarEvts, ...bookingEvts].sort((a, b) => a.eventDate.localeCompare(b.eventDate)));
      setIsLoading(false);
    };

    void loadEvents();

    return () => {
      isActive = false;
    };
  }, [reloadKey]);

  return [events, isLoading, reloadCalendarEvents] as const;
}

function useSupabaseJsonState<T>(contentKey: LearningHubContentKey, fallback: T) {
  const [value, setValue] = useState<T>(fallback);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isActive = true;

    const load = async () => {
      setIsLoading(true);
      const { data, error } = await supabase
        .from('learning_hub_content')
        .select('content')
        .eq('content_key', contentKey)
        .maybeSingle();

      if (!isActive) {
        return;
      }

      if (error) {
        console.warn(`supabase load failed for ${contentKey}`, error);
        setValue(fallback);
        setIsLoading(false);
        return;
      }

      if (data?.content) {
        setValue(data.content as T);
      } else {
        setValue(fallback);
      }

      setIsLoading(false);
    };

    load();

    return () => {
      isActive = false;
    };
  }, [contentKey]);

  const persist = async (nextValue: T) => {
    setValue(nextValue);
    const { error } = await supabase.from('learning_hub_content').upsert({
      content_key: contentKey,
      content_group: 'learning_hub',
      content: nextValue as never,
      updated_at: new Date().toISOString(),
    });

    if (error) {
      console.warn(`supabase save failed for ${contentKey}`, error);
    }
  };

  return [value, setValue, persist, isLoading] as const;
}

function createEmptyLessonDraft(): LessonEditorDraft {
  return {
    title: '',
    duration: '',
    meta: 'video class',
    description: '',
    videoUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    statsText: '',
    assets: [],
  };
}

function createEmptyAssetDraftLink(): LessonAssetDraftLink {
  return {
    id: `asset-link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: '',
    url: '',
  };
}

function createEmptyAssetDraftItem(): LessonAssetDraftItem {
  return {
    id: `asset-item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: '',
    type: 'file',
    note: '',
    links: [createEmptyAssetDraftLink()],
  };
}

function createAssessmentQuestion(): AssessmentQuestion {
  return {
    id: `q-${Date.now()}`,
    prompt: '',
    options: ['', '', '', ''],
    correctIndex: 0,
    answerIndex: null,
  };
}

type NotifRow = { id: string; type: NotifType; title: string; body: string; link: string | null; is_read: boolean; created_at: string };

function NotificationBell({ username }: { username: string }) {
  const [open, setOpen] = useState(false);
  const [notifs, setNotifs] = useState<NotifRow[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);

  const loadNotifs = async () => {
    const { data } = await supabase
      .from('notifications')
      .select('*')
      .eq('recipient_username', username)
      .order('created_at', { ascending: false })
      .limit(30);
    if (data) setNotifs(data as NotifRow[]);
  };

  useEffect(() => {
    void loadNotifs();

    const channel = supabase
      .channel(`notifs-${username}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `recipient_username=eq.${username}` }, (payload) => {
        setNotifs((prev) => [payload.new as NotifRow, ...prev].slice(0, 30));
      })
      .subscribe();

    return () => { void supabase.removeChannel(channel); };
  }, [username]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const unread = notifs.filter((n) => !n.is_read).length;

  const markAllRead = async () => {
    const ids = notifs.filter((n) => !n.is_read).map((n) => n.id);
    if (!ids.length) return;
    setNotifs((prev) => prev.map((n) => ({ ...n, is_read: true })));
    await supabase.from('notifications').update({ is_read: true }).in('id', ids);
  };

  const clearOne = async (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setNotifs((prev) => prev.filter((n) => n.id !== id));
    await supabase.from('notifications').delete().eq('id', id);
  };

  const clearAll = async () => {
    const ids = notifs.map((n) => n.id);
    if (!ids.length) return;
    setNotifs([]);
    await supabase.from('notifications').delete().in('id', ids);
  };

  const handleOpen = () => {
    setOpen((v) => !v);
    if (!open) void markAllRead();
  };

  const notifIcon: Record<NotifType, string> = {
    booking_approved: '✅',
    booking_rejected: '❌',
    lesson_new: '🎓',
    credits_added: '💰',
    thread_reply: '💬',
  };

  return (
    <div className="notif-bell-wrap" ref={panelRef}>
      <button type="button" className="notif-bell-btn" onClick={handleOpen} aria-label="Notifikasi">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
        {unread > 0 && <span className="notif-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>

      {open && (
        <div className="notif-panel">
          <div className="notif-panel-head">
            <strong>Notifikasi</strong>
            <div className="notif-head-actions">
              {notifs.some((n) => !n.is_read) && (
                <button type="button" className="notif-mark-all" onClick={markAllRead}>Tandai dibaca</button>
              )}
              {notifs.length > 0 && (
                <button type="button" className="notif-clear-all" onClick={clearAll}>Hapus semua</button>
              )}
            </div>
          </div>
          <div className="notif-list">
            {notifs.length === 0 && <p className="notif-empty">Belum ada notifikasi.</p>}
            {notifs.map((n) => (
              <div key={n.id} className={`notif-item-wrap ${n.is_read ? 'read' : 'unread'}`}>
                <a
                  href={n.link ?? '#'}
                  className="notif-item"
                  onClick={() => setOpen(false)}
                >
                  <span className="notif-item-icon">{notifIcon[n.type] ?? '🔔'}</span>
                  <div className="notif-item-body">
                    <strong>{n.title}</strong>
                    <p>{n.body}</p>
                    <time>{timeAgo(n.created_at)}</time>
                  </div>
                </a>
                <button
                  type="button"
                  className="notif-delete-btn"
                  aria-label="Hapus notifikasi"
                  onClick={(e) => void clearOne(e, n.id)}
                >×</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

type CreditConfirmContext = {
  feature: string;
  cost: number;
  onConfirm: () => void;
  onCancel?: () => void;
};

function PromoContent({ promo, onCta, onDismiss, isPreview }: {
  promo: PromoPopup;
  onCta?: () => void;
  onDismiss?: () => void;
  isPreview?: boolean;
}) {
  const tc = promo.textColor ?? '#ffffff';
  const bc = promo.btnColor ?? '#6c47ff';
  const btc = promo.btnTextColor ?? '#ffffff';
  const ps = isPreview ? { pointerEvents: 'none' as const } : {};
  const icon = promo.iconUrl
    ? <img src={promo.iconUrl} alt="" className="promo-icon-img" />
    : <div className="promo-icon">{promo.icon || '🚀'}</div>;

  const tpl = promo.styleTemplate ?? 'default';

  if (tpl === 'flash_sale') {
    return (
      <div className="pc-flash">
        <span className="pc-flash-tag">🔥 FLASH SALE</span>
        <div className="pc-flash-badge" style={{ color: bc }}>
          <span className="pc-flash-pct" style={{ color: bc }}>{promo.subtitle || 'DISKON BESAR'}</span>
        </div>
        <h2 className="pc-flash-title" style={{ color: tc }}>{promo.title || 'Flash Sale!'}</h2>
        <p className="pc-flash-body" style={{ color: tc }}>{promo.body}</p>
        {promo.ctaAction !== 'dismiss' && (
          <button className="promo-cta pc-flash-cta" style={{ background: bc, color: btc, ...ps }} onClick={onCta}>{promo.ctaText}</button>
        )}
        <button className="promo-dismiss" style={{ color: tc, opacity: 0.7, ...ps }} onClick={onDismiss}>{promo.dismissText}</button>
      </div>
    );
  }

  if (tpl === 'premium') {
    return (
      <div className="pc-premium">
        <div className="pc-premium-rule" style={{ background: tc }} />
        {icon}
        <h2 className="pc-premium-title" style={{ color: tc }}>{promo.title}</h2>
        <p className="pc-premium-sub" style={{ color: tc }}>{promo.subtitle}</p>
        <p className="pc-premium-body" style={{ color: tc }}>{promo.body}</p>
        <div className="pc-premium-rule" style={{ background: tc }} />
        {promo.ctaAction !== 'dismiss' && (
          <button className="promo-cta pc-premium-cta" style={{ background: 'transparent', color: bc, border: `2px solid ${bc}`, ...ps }} onClick={onCta}>{promo.ctaText}</button>
        )}
        <button className="promo-dismiss" style={{ color: tc, opacity: 0.5, ...ps }} onClick={onDismiss}>{promo.dismissText}</button>
      </div>
    );
  }

  if (tpl === 'pastel') {
    return (
      <div className="pc-pastel">
        <div className="pc-pastel-icon">{promo.iconUrl ? <img src={promo.iconUrl} alt="" className="promo-icon-img" /> : promo.icon || '🌸'}</div>
        <h2 className="pc-pastel-title" style={{ color: tc }}>{promo.title}</h2>
        <p className="pc-pastel-sub" style={{ color: tc }}>{promo.subtitle}</p>
        <p className="pc-pastel-body" style={{ color: tc }}>{promo.body}</p>
        <div className="pc-pastel-actions">
          {promo.ctaAction !== 'dismiss' && (
            <button className="promo-cta pc-pastel-cta" style={{ background: bc, color: btc, ...ps }} onClick={onCta}>{promo.ctaText}</button>
          )}
          <button className="pc-pastel-dismiss" style={{ background: 'transparent', border: `1.5px solid ${bc}`, color: bc, ...ps }} onClick={onDismiss}>{promo.dismissText}</button>
        </div>
      </div>
    );
  }

  if (tpl === 'dark_announcement') {
    return (
      <div className="pc-announce">
        <div className="pc-announce-tag" style={{ background: bc, color: btc }}>📢 PENGUMUMAN</div>
        <h2 className="pc-announce-title" style={{ color: tc }}>{promo.title}</h2>
        <p className="pc-announce-sub" style={{ color: tc, opacity: 0.7 }}>{promo.subtitle}</p>
        <ul className="pc-announce-body">
          {(promo.body || '').split('\n').filter(Boolean).map((line, i) => (
            <li key={i} style={{ color: tc }}>{line}</li>
          ))}
        </ul>
        {promo.ctaAction !== 'dismiss' && (
          <button className="promo-cta pc-announce-cta" style={{ background: bc, color: btc, ...ps }} onClick={onCta}>{promo.ctaText}</button>
        )}
        <button className="promo-dismiss pc-announce-dismiss" style={{ color: tc, opacity: 0.5, ...ps }} onClick={onDismiss}>{promo.dismissText}</button>
      </div>
    );
  }

  // default
  return (
    <>
      {icon}
      <h2 className="promo-title" style={{ color: tc }}>{promo.title}</h2>
      <p className="promo-subtitle" style={{ color: tc }}>{promo.subtitle}</p>
      <p className="promo-body" style={{ color: tc }}>{promo.body}</p>
      {promo.ctaAction !== 'dismiss' && (
        <button className="promo-cta" style={{ background: bc, color: btc, ...ps }} onClick={onCta}>{promo.ctaText}</button>
      )}
      <button className="promo-dismiss" style={{ color: tc, ...ps }} onClick={onDismiss}>{promo.dismissText}</button>
    </>
  );
}

function PromoPopupModal({ promo, onClose, onTopUp }: { promo: PromoPopup; onClose: () => void; onTopUp: () => void }) {
  const handleCta = () => {
    if (promo.ctaAction === 'topup') { onClose(); onTopUp(); }
    else if (promo.ctaAction === 'url' && promo.ctaUrl) window.open(promo.ctaUrl, '_blank');
    else onClose();
  };
  return createPortal(
    <div className="promo-overlay" onClick={onClose}>
      <div className={`promo-modal promo-style-${promo.styleTemplate ?? 'default'}`} style={{ background: promoBg(promo) }} onClick={(e) => e.stopPropagation()}>
        <button className="promo-close" onClick={onClose}>×</button>
        <PromoContent promo={promo} onCta={handleCta} onDismiss={onClose} />
      </div>
    </div>,
    document.body,
  );
}

function CreditConfirmModal({ ctx, onClose }: { ctx: CreditConfirmContext; onClose: () => void }) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { ctx.onCancel?.(); onClose(); }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [ctx, onClose]);

  return createPortal(
    <div className="forum-modal-overlay confirm-overlay" onClick={() => { ctx.onCancel?.(); onClose(); }}>
      <div className="forum-modal confirm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
        </div>
        <h3 className="confirm-title">Konfirmasi Ruang Coin</h3>
        <p className="confirm-desc">
          Menggunakan <strong>{ctx.feature}</strong> akan memotong{' '}
          <span className="confirm-cost"><CoinIcon size={15} /> {ctx.cost} Ruang Coin</span> dari saldo kamu.
        </p>
        <p className="confirm-sub">Lanjutkan?</p>
        <div className="confirm-actions">
          <button
            type="button"
            className="button secondary"
            onClick={() => { ctx.onCancel?.(); onClose(); }}
          >
            Batal
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => { ctx.onConfirm(); onClose(); }}
          >
            Ya, Lanjutkan
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function TopUpModal({ context, onClose, session, initialPackageId }: { context: { feature: string; needed: number; balance: number }; onClose: () => void; session?: AppSession | null; initialPackageId?: string }) {
  const [packages, setPackages] = useState<CreditPackage[]>(defaultCreditPackages);
  const [payment, setPayment] = useState<PaymentInfo>(defaultPaymentInfo);
  const [selectedPkg, setSelectedPkg] = useState<CreditPackage | null>(null);
  const [customAmount, setCustomAmount] = useState('');
  const [step, setStep] = useState<'select' | 'payment' | 'uploaded'>('select');
  const [processing, setProcessing] = useState(false);
  const [activePkgSnapshot, setActivePkgSnapshot] = useState<{ label: string; credits: number; price: number; bonusCredits?: number } | null>(null);
  const [pendingPromoSnapshot, setPendingPromoSnapshot] = useState<PackagePromo | null>(null);
  const [savedTopupId, setSavedTopupId] = useState('');
  const [proofUploading, setProofUploading] = useState(false);
  const [proofPreview, setProofPreview] = useState<string | null>(null);
  const proofInputRef = useRef<HTMLInputElement>(null);

  const autoRan = useRef(false);
  useEffect(() => {
    void loadAdminSettings().then((s) => {
      setPackages(s.packages);
      setPayment(s.payment);
      const preset = initialPackageId ? s.packages.find((p) => p.id === initialPackageId) : null;
      setSelectedPkg(preset ?? s.packages[1] ?? s.packages[0]);
    });
  }, [initialPackageId]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const customAmt = parseInt(customAmount, 10);
  const activePkg = customAmount && customAmt > 0
    ? { id: 'custom', label: 'Custom', credits: customAmt, price: customAmt * CREDIT_RATE } as CreditPackage
    : selectedPkg;

  const handleProsesTopup = async () => {
    if (!activePkg) return;
    // Belum membuat request di database. Request baru dibuat setelah user
    // upload bukti transfer, supaya antrian verifikasi admin tidak penuh
    // dengan request tanpa bukti pembayaran.
    setActivePkgSnapshot(activePkg);
    setPendingPromoSnapshot(isPromoActive(activePkg) ? (activePkg.promo ?? null) : null);
    setSavedTopupId('');
    setStep('payment');
  };

  // Dari pricing landing: setelah daftar, langsung ke halaman pembayaran.
  useEffect(() => {
    if (!initialPackageId || autoRan.current) return;
    if (selectedPkg?.id === initialPackageId && step === 'select') {
      autoRan.current = true;
      void handleProsesTopup();
    }
  }, [initialPackageId, selectedPkg, step]);

  const handleProofUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activePkgSnapshot) return;
    setProofUploading(true);

    // preview lokal
    const localUrl = URL.createObjectURL(file);
    setProofPreview(localUrl);

    // Buat request topup SEKARANG (baru dibuat saat bukti diupload)
    const { data: topupRow, error: insertErr } = await supabase.from('topup_requests').insert({
      username: session?.username ?? 'guest',
      display_name: session?.displayName ?? '',
      credits: activePkgSnapshot.credits,
      amount_rp: activePkgSnapshot.price,
      package_label: activePkgSnapshot.label,
      status: 'pending',
      promo_bonus: pendingPromoSnapshot ?? null,
      bonus_credits: activePkgSnapshot.bonusCredits ?? 0,
    }).select('id').single();
    const topupId = (topupRow as { id?: string } | null)?.id ?? '';
    if (insertErr || !topupId) { setProofUploading(false); setProofPreview(null); alert('Gagal membuat request topup. Coba lagi.'); return; }
    setSavedTopupId(topupId);

    // upload ke storage (kompres dulu; bukti transfer tetap terbaca di 1600px)
    const uploadFile = await compressImage(file, 1600, 0.82);
    const ext = uploadFile.name.split('.').pop();
    const path = `topup-proofs/${topupId}.${ext}`;
    const { error } = await supabase.storage.from('lesson-assets').upload(path, uploadFile, { upsert: true, contentType: uploadFile.type });

    if (error) { setProofUploading(false); return; }

    const proofUrl = supabase.storage.from('lesson-assets').getPublicUrl(path).data.publicUrl;

    // update topup_request dengan proof_url
    const shortId = topupId.slice(0, 8);
    await supabase.from('topup_requests').update({ proof_url: proofUrl }).eq('id', topupId);

    // kirim foto ke Telegram
    try {
      const form = new FormData();
      form.append('chat_id', TG_CHAT);
      form.append('photo', file);
      form.append('caption', `💰 <b>Pembelian Coin Baru — Butuh Approval</b>\n\n👤 ${session?.displayName ?? session?.username} (@${session?.username})\n📦 Paket: ${activePkgSnapshot.label}\n💵 Harga: ${formatRupiah(activePkgSnapshot.price)}\n🪙 Coin: ${activePkgSnapshot.credits.toLocaleString('id-ID')} Ruang Coin\n🆔 ID: <code>${shortId}</code>`);
      form.append('parse_mode', 'HTML');
      form.append('reply_markup', JSON.stringify({
        inline_keyboard: [[
          { text: '✅ Approve', callback_data: `at:${topupId}` },
        ]],
      }));
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, { method: 'POST', body: form });
    } catch { /* silent */ }

    // notif in-app ke admin
    const { data: devs } = await supabase.from('app_users').select('username').eq('role', 'developer');
    if (devs) {
      for (const dev of devs) {
        await supabase.from('notifications').insert([{
          recipient_username: dev.username,
          type: 'credits_added',
          title: 'Bukti Topup Dikirim',
          body: `${session?.displayName ?? 'User'} mengupload bukti topup ${activePkgSnapshot.credits} coin`,
          link: '#inbox-topup',
        }]);
      }
    }

    setProofUploading(false);
    setStep('uploaded');
    e.target.value = '';
  };

  return createPortal(
    <div className="forum-modal-overlay topup-overlay" onClick={onClose}>
      <div className="forum-modal topup-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="forum-modal-close" onClick={onClose}>×</button>

        {step === 'select' ? (
          <>
            {context.needed > 0 && (
              <div className="topup-alert">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                <div>
                  <strong>Ruang Coin tidak cukup</strong>
                  <p>Untuk menggunakan <em>{context.feature}</em> butuh <strong>{context.needed} Ruang Coin</strong>, saldo kamu saat ini <strong>{context.balance} Ruang Coin</strong>.</p>
                </div>
              </div>
            )}

            <h3 className="topup-title">Topup Ruang Coin</h3>
            <p className="topup-sub">Pilih paket Ruang Coin yang sesuai kebutuhanmu.</p>

            <div className="credit-pkg-grid topup-pkg-grid">
              {packages.map((pkg) => (
                <button
                  key={pkg.id}
                  type="button"
                  className={`credit-pkg-card${selectedPkg?.id === pkg.id && !customAmount ? ' selected' : ''}${isPromoActive(pkg) ? ' promo-active' : ''}`}
                  onClick={() => { setSelectedPkg(pkg); setCustomAmount(''); }}
                >
                  {isPromoActive(pkg) && <span className="credit-pkg-promo-badge">{pkg.promo!.label || '🎉 Promo'}</span>}
                  <span className="credit-pkg-label">{pkg.label}</span>
                  {(pkg.discount ?? 0) > 0 && <span className="credit-pkg-discount">-{pkg.discount}%</span>}
                  <span className="credit-pkg-credits"><CoinIcon size={13} /> {pkg.credits.toLocaleString('id-ID')} Ruang Coin</span>
                  {(pkg.bonusCredits ?? 0) > 0 && <span className="credit-pkg-bonus">🎁 +{pkg.bonusCredits} bonus koin</span>}
                  <span className="credit-pkg-price">{formatRupiah(pkg.price)}</span>
                  {(pkg.discount ?? 0) > 0 && (
                    <span className="credit-pkg-base-price">{formatRupiah(pkg.credits * CREDIT_RATE)}</span>
                  )}
                  {isPromoActive(pkg) && (pkg.promo!.bonus_features?.length || pkg.promo!.bonus_booking) && (
                    <span className="credit-pkg-promo-bonus">
                      🎁 Bonus:{' '}
                      {[
                        pkg.promo!.bonus_booking && 'Sesi 1:1 Gratis',
                        ...(pkg.promo!.bonus_features ?? []).map((f) => ({ free_video: 'Video', free_booking: 'Booking', free_thread: 'Thread', free_asset: 'Asset', free_event: 'Event' }[f])),
                      ].filter(Boolean).join(', ')}
                    </span>
                  )}
                </button>
              ))}
            </div>

            <div className="credit-custom-wrap">
              <p className="credit-custom-label">atau masukkan jumlah Ruang Coin sendiri</p>
              <div className="credit-custom-row">
                <CoinIcon size={15} />
                <input
                  type="number"
                  min="1"
                  className={`credit-custom-input${customAmount ? ' active' : ''}`}
                  placeholder="contoh: 150"
                  value={customAmount}
                  onChange={(e) => { setCustomAmount(e.target.value); setSelectedPkg(null); }}
                />
                <span className="credit-custom-unit">Ruang Coin</span>
                {customAmount && customAmt > 0 && (
                  <span className="credit-custom-price">{formatRupiah(customAmt * CREDIT_RATE)}</span>
                )}
              </div>
            </div>

            {activePkg && (
              <div className="topup-proses-bar">
                <div className="topup-proses-summary">
                  <span><CoinIcon size={13} /> {activePkg.credits.toLocaleString('id-ID')} Ruang Coin</span>
                  <strong>{formatRupiah(activePkg.price)}</strong>
                </div>
                <button
                  type="button"
                  className="topup-proses-btn"
                  disabled={processing}
                  onClick={() => void handleProsesTopup()}
                >
                  {processing ? 'Memproses…' : 'Proses Topup →'}
                </button>
              </div>
            )}
          </>
        ) : step === 'payment' ? (
          <>
            <h3 className="topup-title">Transfer & Upload Bukti</h3>
            <p className="topup-sub">Selesaikan pembayaran lalu upload foto bukti transfernya.</p>

            {activePkgSnapshot && (
              <div className="credit-payment-info topup-payment-info">
                <div className="credit-payment-summary">
                  <span>Paket dipilih</span>
                  <strong>{activePkgSnapshot.label} — <CoinIcon size={13} /> {activePkgSnapshot.credits.toLocaleString('id-ID')} Ruang Coin</strong>
                  <span>Total pembayaran</span>
                  <strong className="credit-payment-total">{formatRupiah(activePkgSnapshot.price)}</strong>
                </div>
                {(payment.bankName || payment.accountNumber) && (
                  <div className="credit-payment-bank">
                    <p className="eyebrow" style={{ marginBottom: 6 }}>transfer ke</p>
                    {payment.bankName && <div className="credit-bank-name">{payment.bankName}</div>}
                    {payment.accountNumber && (
                      <div className="credit-bank-number-row">
                        <span className="credit-bank-number">{payment.accountNumber}</span>
                        <button
                          type="button"
                          className="credit-copy-btn"
                          onClick={() => {
                            void navigator.clipboard.writeText(payment.accountNumber).catch(() => {
                              const el = document.createElement('textarea');
                              el.value = payment.accountNumber;
                              el.style.position = 'fixed'; el.style.opacity = '0';
                              document.body.appendChild(el); el.select();
                              document.execCommand('copy'); document.body.removeChild(el);
                            });
                            const btn = document.activeElement as HTMLButtonElement;
                            const orig = btn.textContent ?? '';
                            btn.textContent = '✓ disalin';
                            setTimeout(() => { btn.textContent = orig; }, 1800);
                          }}
                        >salin</button>
                      </div>
                    )}
                    {payment.accountName && <div className="credit-bank-holder">{payment.accountName}</div>}
                  </div>
                )}
              </div>
            )}

            <input
              ref={proofInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={handleProofUpload}
            />

            {proofPreview ? (
              <div className="topup-proof-preview">
                <img src={proofPreview} alt="Bukti transfer" />
                {proofUploading && <div className="topup-proof-uploading">Mengirim bukti…</div>}
              </div>
            ) : (
              <button
                type="button"
                className="topup-proof-upload-btn"
                onClick={() => proofInputRef.current?.click()}
                disabled={proofUploading}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                <span>Upload Bukti Transfer</span>
                <small>JPG, PNG · Foto struk atau screenshot transfer</small>
              </button>
            )}
          </>
        ) : (
          // step === 'uploaded'
          <div className="topup-uploaded-success">
            <div className="topup-uploaded-icon">🎉</div>
            <h3 className="topup-title">Bukti Terkirim!</h3>
            <p className="topup-sub">Bukti transfermu sudah diterima dan sedang diverifikasi admin. Ruang Coin akan ditambahkan setelah pembayaran dikonfirmasi.</p>
            {proofPreview && <img src={proofPreview} alt="Bukti" className="topup-uploaded-thumb" />}
            <button type="button" className="button primary" style={{ width: '100%', marginTop: 16 }} onClick={onClose}>
              Oke, Tutup
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function App() {
  const [hash, setHash] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('thread')) return '#community';
    const h = window.location.hash || '#dashboard';
    return h.startsWith('#materi/') ? '#materi' : h;
  });
  const [initialThreadId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('thread'));
  const [session, setSession] = useState<AppSession | null>(() => readStoredSession());
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const [showReferralClaim, setShowReferralClaim] = useState(false);
  const [profileAvatarUrl, setProfileAvatarUrl] = useState('');
  const [userCredits, setUserCredits] = useState<number | null>(null);
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [featureCosts, setFeatureCosts] = useState<FeatureCosts>(defaultFeatureCosts);
  const [userPerks, setUserPerks] = useState<UserPerks>({});
  const [topUpContext, setTopUpContext] = useState<{ feature: string; needed: number; balance: number } | null>(null);
  const [confirmContext, setConfirmContext] = useState<CreditConfirmContext | null>(null);
  const [kickedMessage, setKickedMessage] = useState<string | null>(null);
  const [promoPopup, setPromoPopup] = useState<PromoPopup | null>(null);
  const [helpSettings, setHelpSettings] = useState<HelpSettings>(defaultHelpSettings);
  const [searchOpen, setSearchOpen] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [selectedCourseKey, setSelectedCourseKey] = useState<string | null>(() => {
    const h = window.location.hash;
    if (h.startsWith('#materi/')) return h.slice('#materi/'.length) || null;
    return null;
  });
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('rs-dark-mode') === '1');
  type NavPosition = 'left' | 'right' | 'top' | 'bottom';
  const [navPosition, setNavPosition] = useState<NavPosition>(() => (localStorage.getItem('rs-nav-pos') as NavPosition) || 'left');
  const [navPosOpen, setNavPosOpen] = useState(false);
  const changeNavPos = (pos: NavPosition) => { setNavPosition(pos); localStorage.setItem('rs-nav-pos', pos); setNavPosOpen(false); };
  const [landingContent, setLandingContent] = useState<LandingContent>(defaultLandingContent);
  const [pendingTopupPkgId, setPendingTopupPkgId] = useState<string | null>(null);

  useEffect(() => {
    void loadAppTheme().then(applyAppTheme);
    void loadHelpSettings().then(setHelpSettings);
    // Bersihkan cache-bust param dari URL setelah page load
    if (new URLSearchParams(window.location.search).has('_v')) {
      const clean = new URL(window.location.href);
      clean.searchParams.delete('_v');
      window.history.replaceState(null, '', clean.pathname + (clean.search || '') + clean.hash);
    }
  }, []);

  useEffect(() => {
    if (session) return;
    void loadLandingContent().then(setLandingContent);
  }, [session]);

  // Setelah daftar/login dari pricing landing → buka langsung halaman pembayaran.
  useEffect(() => {
    if (!session) return;
    const pkgId = sessionStorage.getItem('pending_topup_pkg_id');
    if (pkgId) {
      setPendingTopupPkgId(pkgId);
      sessionStorage.removeItem('pending_topup_pkg_id');
      sessionStorage.removeItem('landing_register');
    }
  }, [session]);

  useEffect(() => {
    document.body.classList.toggle('dark', darkMode);
    localStorage.setItem('rs-dark-mode', darkMode ? '1' : '0');
  }, [darkMode]);

  useEffect(() => {
    const handleHashChange = () => {
      const h = window.location.hash || '#dashboard';
      if (h.startsWith('#materi/')) {
        setHash('#materi');
        setSelectedCourseKey(h.slice('#materi/'.length) || null);
      } else {
        setHash(h);
        setSelectedCourseKey(null);
      }
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  // Global search shortcut: Cmd+K / Ctrl+K
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
      if (e.key === 'Escape') setSearchOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Onboarding: tampilkan sekali untuk user baru
  useEffect(() => {
    if (!session) return;
    const key = `onboarding_done_${session.username}`;
    if (!localStorage.getItem(key)) {
      setShowOnboarding(true);
    }
  }, [session?.username]);

  // Validasi session saat app load — paksa logout jika user sudah dihapus / nonaktif
  useEffect(() => {
    if (!session) return;
    const forceLogout = (msg: string) => {
      clearStoredSession();
      setSession(null);
      window.location.hash = '#login';
      setKickedMessage(msg);
    };
    supabase
      .from('app_users')
      .select('username, is_active')
      .eq('username', session.username)
      .maybeSingle()
      .then(({ data }) => {
        if (!data) forceLogout('Akun kamu telah dihapus oleh admin.');
        else if (!data.is_active) forceLogout('Akun kamu telah dinonaktifkan oleh admin.');
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Realtime: force logout jika user yang sedang login dihapus saat sesi aktif
  useEffect(() => {
    if (!session) return;
    const forceLogout = (msg: string) => {
      clearStoredSession();
      setSession(null);
      window.location.hash = '#login';
      setKickedMessage(msg);
    };
    const channel = supabase
      .channel('session-guard')
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'app_users' },
        (payload) => {
          if (payload.old && (payload.old as { username: string }).username === session.username) {
            forceLogout('Akun kamu telah dihapus oleh admin. Kamu telah dikeluarkan.');
          }
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'app_users' },
        (payload) => {
          const updated = payload.new as { username: string; is_active: boolean };
          if (updated.username === session.username && !updated.is_active) {
            forceLogout('Akun kamu telah dinonaktifkan oleh admin.');
          }
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [session]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setCurrentDate(new Date());
    }, 60_000);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (!isAccountMenuOpen) {
      return;
    }

    const handleWindowClick = () => {
      setIsAccountMenuOpen(false);
      setNavPosOpen(false);
    };

    window.addEventListener('click', handleWindowClick);
    return () => window.removeEventListener('click', handleWindowClick);
  }, [isAccountMenuOpen]);

  useEffect(() => {
    let isActive = true;

    if (!session) {
      setProfileAvatarUrl('');
      return;
    }

    void (async () => {
      const [nextProfile, { data: creditsData }] = await Promise.all([
        loadSupabaseUserProfile(session),
        supabase.from('user_credits').select('balance').eq('username', session.username).maybeSingle(),
      ]);
      if (!isActive) return;
      setProfileAvatarUrl(nextProfile.photoUrl);
      setUserCredits(creditsData?.balance ?? null);
    })();

    // Realtime: update balance langsung saat user_credits berubah
    const creditChannel = supabase.channel(`user-credits-${session.username}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'user_credits', filter: `username=eq.${session.username}` },
        (payload) => {
          const newBalance = (payload.new as { balance?: number })?.balance;
          if (typeof newBalance === 'number') setUserCredits(newBalance);
        },
      )
      .subscribe();

    return () => {
      isActive = false;
      void supabase.removeChannel(creditChannel);
    };
  }, [session]);

  // Load feature costs once on mount
  useEffect(() => {
    void loadFeatureCosts().then(setFeatureCosts);
  }, []);

  const page = useMemo(() => getPage(hash), [hash]);
  const isDeveloper = session?.role === 'developer' || session?.role === 'admin';
  const redirectTarget = page === 'login' ? '#dashboard' : hash;

  // Telegram command polling — aktif saat admin login
  // Telegram commands handled by supabase/functions/telegram-webhook (webhook mode)
  // useTelegramPolling(isDeveloper);

  // Re-fetch perks on every page navigation so changes take effect immediately
  useEffect(() => {
    if (!session) { setUserPerks({}); return; }
    void supabase.from('user_profiles').select('perks, referral_perks, referral_perks_expires_at').eq('username', session.username).maybeSingle()
      .then(({ data }) => {
        const permanent = (data?.perks ?? {}) as UserPerks;
        const referral = (data?.referral_perks ?? {}) as UserPerks;
        const expiresAt = (data as { referral_perks_expires_at?: string } | null)?.referral_perks_expires_at;
        const referralActive = !expiresAt || new Date(expiresAt) > new Date();
        const merged: UserPerks = { ...permanent, ...(referralActive ? referral : {}) };
        setUserPerks(merged);
      });
  }, [session, page]);

  // Realtime broadcast: terima promo dari admin secara langsung
  useEffect(() => {
    if (!session) return;
    const channel = supabase
      .channel('promo-broadcast')
      .on('broadcast', { event: 'show-promo' }, (payload) => {
        const p = payload.payload?.promo as PromoPopup | undefined;
        if (p?.enabled) setPromoPopup(p);
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [session]);

  // Tampilkan promo popup untuk all_users jika enabled dan belum pernah dilihat sesi ini
  useEffect(() => {
    if (!session) return;
    const seenKey = `promo_seen_${session.username}`;
    if (sessionStorage.getItem(seenKey)) return;
    void loadAdminSettings().then((s) => {
      const p = s.promo;
      if (p?.enabled && p.target === 'all_users') {
        setPromoPopup(p);
        sessionStorage.setItem(seenKey, '1');
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.username]);
  const headerMessage = headerMessages[Math.floor(currentDate.getTime() / 180_000) % headerMessages.length];

  const [pendingBookingCount, setPendingBookingCount] = useState(0);

  useEffect(() => {
    if (!isDeveloper) return;
    const load = async () => {
      const { count } = await supabase.from('one_on_one_bookings').select('id', { count: 'exact', head: true }).eq('status', 'pending');
      setPendingBookingCount(count ?? 0);
    };
    void load();
    const channel = supabase.channel('pending-bookings')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'one_on_one_bookings' }, () => void load())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [isDeveloper]);

  // Badge komunitas: jumlah balasan belum dibaca pada thread milik user sendiri.
  const [communityUnread, setCommunityUnread] = useState(0);
  useEffect(() => {
    if (!session) return;
    const uname = session.username;
    const load = async () => {
      const { count } = await supabase.from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('recipient_username', uname)
        .eq('type', 'thread_reply')
        .eq('is_read', false);
      setCommunityUnread(count ?? 0);
    };
    void load();
    const channel = supabase.channel('community-unread')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `recipient_username=eq.${uname}` }, () => void load())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [session]);

  // Saat user membuka forum, tandai balasan sudah dibaca → badge hilang.
  useEffect(() => {
    if (page !== 'community' || !session || communityUnread === 0) return;
    void supabase.from('notifications').update({ is_read: true })
      .eq('recipient_username', session.username)
      .eq('type', 'thread_reply')
      .eq('is_read', false);
    setCommunityUnread(0);
  }, [page, session, communityUnread]);

  // Bonus login harian (dibatasi 1x/hari oleh awardCoinReward).
  useEffect(() => {
    if (!session) return;
    void awardCoinReward(session.username, 'daily_login').then((nb) => { if (nb != null) setUserCredits(nb); });
  }, [session]);

  // Buka link thread (?thread=): begitu user login/ada sesi, arahkan ke forum
  // agar thread langsung terbuka tanpa perlu login ulang.
  useEffect(() => {
    if (initialThreadId && session && getPage(window.location.hash) !== 'community') {
      window.location.hash = '#community';
    }
  }, [session, initialThreadId]);

  if (!session) {
    // Landing untuk pengunjung di root/home; login untuk #login atau deep-link.
    // Kalau membuka link thread (?thread=), arahkan ke login dulu.
    const showLogin = hash === '#login' || page !== 'dashboard' || !!initialThreadId;
    if (!showLogin) {
      return (
        <div className="shell landing-shell">
          <div className="ambient ambient-a" />
          <div className="ambient ambient-b" />
          <LandingPage
            content={landingContent}
            onMasuk={() => { sessionStorage.removeItem('landing_register'); window.location.hash = '#login'; }}
            onPickPackage={(id) => {
              sessionStorage.setItem('pending_topup_pkg_id', id);
              sessionStorage.setItem('landing_register', '1');
              window.location.hash = '#login';
            }}
          />
          <UpdateToast />
        </div>
      );
    }
    return (
      <div className="shell auth-shell">
        <div className="ambient ambient-a" />
        <div className="ambient ambient-b" />
        <LoginPage session={session} redirectTo={page === 'login' ? '#dashboard' : hash} initialAuthMode={sessionStorage.getItem('landing_register') === '1' ? 'sign-up' : 'sign-in'} onLoginSuccess={setSession} onShowPromo={() => { void loadAdminSettings().then((s) => { if (s.promo?.enabled) setPromoPopup(s.promo); }); }} />
        <UpdateToast />
      </div>
    );
  }

  return (
    <div className="shell">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />

      <header className="topbar">
        <div className="topbar-brand">
          <div className="topbar-brand-row">
            <img src={logo1} alt="ruang sosmed learning center" className="topbar-brand-logo" />
            <p className="eyebrow">Ruang Sosmed Learning Center</p>
          </div>
        </div>

        <div className="topbar-nav-row">
          <div>{/* nav moved to sidebar */}</div>

          <div className="account-menu-wrap" onClick={(event) => event.stopPropagation()}>
            <div className="account-meta" aria-live="polite">
              <span>{formatHeaderDate(currentDate)}</span>
              <strong>
                {userCredits !== null
                  ? <span className="header-credits-wrap">
                      <span className="header-credits"><CoinIcon size={14} />{userCredits.toLocaleString('id-ID')} Ruang Coin</span>
                      <div className="header-credits-popover">
                        <div className="hcp-label">Saldo Ruang Coin</div>
                        <div className="hcp-balance"><CoinIcon size={20} animate />{userCredits.toLocaleString('id-ID')}</div>
                        <button type="button" className="hcp-topup-btn" onClick={() => setTopUpContext({ feature: 'topup', needed: 0, balance: userCredits ?? 0 })}>
                          + Topup Ruang Coin
                        </button>
                      </div>
                    </span>
                  : headerMessage}
              </strong>
            </div>
            <button
              type="button"
              className="global-search-btn"
              title="Cari (⌘K)"
              aria-label="buka pencarian global"
              onClick={() => setSearchOpen(true)}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <span className="global-search-btn-label">Cari…</span>
              <kbd className="global-search-kbd">⌘K</kbd>
            </button>
            <button
              type="button"
              className={`dark-mode-toggle${darkMode ? ' dark-on' : ''}`}
              onClick={() => setDarkMode((d) => !d)}
              aria-label={darkMode ? 'Matikan dark mode' : 'Aktifkan dark mode'}
              title={darkMode ? 'Light Mode' : 'Dark Mode'}
            >
              <span className="dmt-track">
                <span className="dmt-thumb">
                  {darkMode ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="5"/>
                      <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
                      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                      <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
                      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                    </svg>
                  )}
                </span>
              </span>
            </button>
            {session && <NotificationBell username={session.username} />}
            <button
              type="button"
              className="account-trigger"
              aria-label="menu akun"
              aria-expanded={isAccountMenuOpen}
              onClick={() => setIsAccountMenuOpen((current) => !current)}
            >
              <img
                src={profileAvatarUrl || avatarForSession(session)}
                alt={session.displayName}
                className="account-avatar"
              />
            </button>

            {isAccountMenuOpen && (
              <div className="account-menu" role="menu" aria-label="menu profil">
                <a
                  href="#profil-settings"
                  role="menuitem"
                  onClick={() => setIsAccountMenuOpen(false)}
                >
                  <svg className="account-menu-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                  setting profile
                </a>
                <a
                  href="#profil-subscription"
                  role="menuitem"
                  onClick={() => setIsAccountMenuOpen(false)}
                >
                  <svg className="account-menu-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
                  cek status berlangganan
                </a>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setShowReferralClaim(true); setIsAccountMenuOpen(false); }}
                >
                  <svg className="account-menu-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>
                  klaim kode referral
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="account-menu-danger"
                  onClick={() => {
                    clearStoredSession();
                    setSession(null);
                    setIsAccountMenuOpen(false);
                    window.location.hash = '#login';
                  }}
                >
                  <svg className="account-menu-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                  logout app
                </button>
              </div>
            )}
          </div>
        </div>

      </header>

      <aside className={`sidebar-nav sidebar-nav--${navPosition}`} aria-label="menu utama">
        <div className="sidebar-nav-pos-wrap">
          <button
            type="button"
            className="sidebar-nav-pos-btn"
            title="Ubah posisi menu"
            onClick={(e) => { e.stopPropagation(); setNavPosOpen((o) => !o); }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>
            </svg>
          </button>
          {navPosOpen && (
            <div className="sidebar-nav-pos-menu" onClick={(e) => e.stopPropagation()}>
              {([
                { pos: 'top', icon: '↑', label: 'Atas' },
                { pos: 'bottom', icon: '↓', label: 'Bawah' },
                { pos: 'left', icon: '←', label: 'Kiri' },
                { pos: 'right', icon: '→', label: 'Kanan' },
              ] as { pos: NavPosition; icon: string; label: string }[]).map(({ pos, icon, label }) => (
                <button
                  key={pos}
                  type="button"
                  className={`sidebar-nav-pos-opt${navPosition === pos ? ' active' : ''}`}
                  onClick={() => changeNavPos(pos)}
                >
                  <span>{icon}</span>
                  <span>{label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <nav>
          {menu.map((item) => (
            <a
              key={item.label}
              href={item.hash}
              className={`sidebar-nav-item ${page === getPage(item.hash) ? 'active' : ''}`}
              data-label={item.label}
            >
              <span className="sidebar-nav-icon" style={item.hash === '#community' ? { position: 'relative' } : undefined}>
                {item.icon}
                {item.hash === '#community' && communityUnread > 0 && (
                  <span className="sidebar-nav-badge">{communityUnread > 9 ? '9+' : communityUnread}</span>
                )}
              </span>
              <span className="sidebar-nav-tooltip">{item.label}</span>
            </a>
          ))}
          {isDeveloper && (
            <>
              <span className="sidebar-nav-divider" />
              <a href="#admin" className={`sidebar-nav-item${page === 'admin' ? ' active' : ''}`} data-label="Admin">
                <span className="sidebar-nav-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 1 0-16 0"/>
                    <circle cx="18" cy="18" r="3"/><line x1="18" y1="15" x2="18" y2="18"/><line x1="18" y1="18" x2="21" y2="18"/>
                  </svg>
                </span>
                <span className="sidebar-nav-tooltip">Admin</span>
              </a>
              <a href="#inbox" className={`sidebar-nav-item${page === 'inbox' ? ' active' : ''}`} data-label="Inbox 1:1">
                <span className="sidebar-nav-icon" style={{ position: 'relative' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
                  </svg>
                  {pendingBookingCount > 0 && <span className="sidebar-nav-badge">{pendingBookingCount}</span>}
                </span>
                <span className="sidebar-nav-tooltip">Inbox 1:1</span>
              </a>
            </>
          )}
        </nav>
      </aside>

      <main className="layout">
        {page === 'dashboard' && <DashboardSection session={session} />}
        {page === 'materi' && (
          selectedCourseKey
            ? <LmsPage canEdit={isDeveloper} sessionUsername={session?.username ?? ''} sessionDisplayName={session?.displayName ?? ''} featureCosts={featureCosts} userPerks={userPerks} onCreditChange={setUserCredits} onInsufficientCredits={(f, n, b) => setTopUpContext({ feature: f, needed: n, balance: b })} onRequestConfirm={(ctx) => setConfirmContext(ctx)} courseKey={selectedCourseKey} onBack={() => { history.replaceState(null, '', '#materi'); setSelectedCourseKey(null); }} />
            : <CourseCatalogPage onSelect={(key) => { history.replaceState(null, '', `#materi/${key}`); setSelectedCourseKey(key); }} canEdit={isDeveloper} sessionUsername={session?.username ?? ''} />
        )}
        {page === 'calendar' && <CalendarPage canManage={isDeveloper} sessionUsername={session?.username ?? ''} featureCosts={featureCosts} userPerks={userPerks} onCreditChange={setUserCredits} onInsufficientCredits={(f, n, b) => setTopUpContext({ feature: f, needed: n, balance: b })} onRequestConfirm={(ctx) => setConfirmContext(ctx)} />}
        {page === 'community' && <CommunityPage session={session} initialThreadId={initialThreadId} featureCosts={featureCosts} userPerks={userPerks} onCreditChange={setUserCredits} onInsufficientCredits={(f, n, b) => setTopUpContext({ feature: f, needed: n, balance: b })} onRequestConfirm={(ctx) => setConfirmContext(ctx)} />}
        {topUpContext && <TopUpModal context={topUpContext} onClose={() => setTopUpContext(null)} session={session} />}
        {pendingTopupPkgId && (
          <TopUpModal
            context={{ feature: 'topup', needed: 0, balance: 0 }}
            initialPackageId={pendingTopupPkgId}
            session={session}
            onClose={() => { setPendingTopupPkgId(null); window.location.hash = '#dashboard'; }}
          />
        )}
        {confirmContext && <CreditConfirmModal ctx={confirmContext} onClose={() => setConfirmContext(null)} />}
        {promoPopup && <PromoPopupModal promo={promoPopup} onClose={() => setPromoPopup(null)} onTopUp={() => setTopUpContext({ feature: 'promo', needed: 0, balance: 0 })} />}
        {searchOpen && <GlobalSearchModal onClose={() => setSearchOpen(false)} />}
        {showReferralClaim && session && (
          <ReferralClaimModal
            session={session}
            currentCredits={userCredits ?? 0}
            onClose={() => setShowReferralClaim(false)}
            onCoinClaimed={(bal) => setUserCredits(bal)}
            onFeatureClaimed={(features) => setUserPerks((prev) => { const next = { ...prev }; for (const f of features) next[f as keyof UserPerks] = true; return next; })}
          />
        )}
        {showOnboarding && session && (
          <OnboardingModal
            username={session.username}
            displayName={session.displayName}
            onClose={() => {
              localStorage.setItem(`onboarding_done_${session.username}`, '1');
              setShowOnboarding(false);
            }}
          />
        )}
        {kickedMessage && createPortal(
          <div className="kicked-overlay">
            <div className="kicked-modal">
              <div className="kicked-icon">🚫</div>
              <h3 className="kicked-title">Akses Diblokir</h3>
              <p className="kicked-body">{kickedMessage}</p>
              <p className="kicked-sub">Hubungi admin jika kamu merasa ini adalah kesalahan.</p>
              <button className="kicked-btn" onClick={() => setKickedMessage(null)}>OK, Mengerti</button>
            </div>
          </div>,
          document.body,
        )}
        {page === 'profil' && (
          <ProfilePage
            hash={hash}
            session={session}
            onProfilePhotoChange={setProfileAvatarUrl}
            onCreditChange={setUserCredits}
            externalCredits={userCredits}
          />
        )}
        {page === 'events' && <EventsPage canManage={isDeveloper} session={session} featureCosts={featureCosts} userPerks={userPerks} onCreditChange={setUserCredits} onInsufficientCredits={(f, n, b) => setTopUpContext({ feature: f, needed: n, balance: b })} />}
        {page === 'assets' && <AssetManagerPage canEdit={isDeveloper} session={session} userPerks={userPerks} />}
        {page === 'myfile' && session && <MyFilePage session={session} />}
        {page === 'admin' && isDeveloper && <AdminPage session={session} featureCosts={featureCosts} onFeatureCostsChange={(c) => { setFeatureCosts(c); void saveFeatureCosts(c); }} />}
        {page === 'inbox' && isDeveloper && <InboxPage />}
        {page === 'login' && (
          <LoginPage session={session} redirectTo={redirectTarget} onLoginSuccess={setSession} />
        )}
      </main>
      <HelpFab settings={helpSettings} />
      <UpdateToast />
    </div>
  );
}

// ── Database Monitor ───────────────────────────────────────────
type TableStat = { name: string; label: string; count: number; warnAt: number; limitAt: number };
type BucketStat = { name: string; label: string; files: number; warnAt: number; sizeBytes: number };

const CHART_TABLES = [
  { key: 'app_users',           label: 'Users',          color: '#6366f1', limitAt: 1000  },
  { key: 'credit_transactions', label: 'Transaksi Coin', color: '#f59e0b', limitAt: 20000 },
  { key: 'one_on_one_bookings', label: 'Booking 1:1',    color: '#22c55e', limitAt: 5000  },
  { key: 'forum_threads',         label: 'Forum Posts',    color: '#ec4899', limitAt: 10000 },
];
type ChartPoint = { time: Date; counts: Record<string, number> };

// ── Monitor sub-components ──────────────────────────────────────

function StatRingCard({ value, limit, color, label, delta }: { value: number; limit: number; color: string; label: string; delta: number | null }) {
  const r = 26; const circ = 2 * Math.PI * r;
  const pct = Math.min(1, value / limit);
  const dash = pct * circ;
  const up = delta === null ? null : delta > 0 ? true : delta < 0 ? false : null;
  return (
    <div className="dbmon2-stat-card">
      <div className="dbmon2-stat-ring">
        <svg width="68" height="68" viewBox="0 0 68 68">
          <circle cx="34" cy="34" r={r} fill="none" stroke="var(--line)" strokeWidth="5" />
          <circle cx="34" cy="34" r={r} fill="none" stroke={color} strokeWidth="5"
            strokeDasharray={`${dash.toFixed(1)} ${circ.toFixed(1)}`}
            strokeDashoffset={(circ / 4).toFixed(1)}
            strokeLinecap="round" style={{ transition: 'stroke-dasharray 0.6s ease' }} />
        </svg>
        <span className="dbmon2-stat-arrow" style={{ color: up === true ? '#22c55e' : up === false ? '#ef4444' : 'var(--muted)' }}>
          {up === true ? '↗' : up === false ? '↙' : '→'}
        </span>
      </div>
      <div className="dbmon2-stat-info">
        <div className="dbmon2-stat-value" style={{ color }}>{value.toLocaleString('id-ID')}</div>
        <div className="dbmon2-stat-label">{label}</div>
        {delta !== null && delta !== 0 && (
          <div className="dbmon2-stat-delta" style={{ color: delta > 0 ? '#22c55e' : '#ef4444' }}>
            {delta > 0 ? '+' : ''}{delta} sejak poll terakhir
          </div>
        )}
      </div>
    </div>
  );
}

function MultiLineChart({ history }: { history: ChartPoint[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const W = 800; const H = 180; const padL = 40; const padR = 12; const padT = 16; const padB = 32;
  const n = history.length;

  if (n < 2) {
    return (
      <div className="dbmon2-chart-empty">
        <span>⏳</span>
        <span>Memuat data historis 24 jam…</span>
      </div>
    );
  }

  const allValues = CHART_TABLES.flatMap((ct) => history.map((h) => h.counts[ct.key] ?? 0));
  const globalMin = Math.min(...allValues);
  const globalMax = Math.max(...allValues) || 1;
  const range = globalMax - globalMin || 1;

  const toX = (i: number) => padL + (i / (n - 1)) * (W - padL - padR);
  const toY = (v: number) => padT + (1 - (v - globalMin) / range) * (H - padT - padB);

  const YTICKS = 4;
  const yTicks = Array.from({ length: YTICKS + 1 }, (_, i) => globalMin + (i / YTICKS) * range);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const relX = (e.clientX - rect.left) * (W / rect.width);
    const idx = Math.round(((relX - padL) / (W - padL - padR)) * (n - 1));
    setHoverIdx(Math.max(0, Math.min(n - 1, idx)));
  };

  const hi = hoverIdx ?? n - 1;
  const hPoint = history[hi];

  return (
    <div className="dbmon2-chart-wrap">
      {/* Tooltip */}
      <div className="dbmon2-chart-tooltip">
        <span className="dbmon2-chart-tooltip-time">{hPoint.time.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
        {CHART_TABLES.map((ct) => (
          <span key={ct.key} className="dbmon2-chart-tooltip-item">
            <span className="dbmon2-chart-tooltip-dot" style={{ background: ct.color }} />
            <span style={{ color: ct.color }}>{ct.label}:</span>
            <span>{(hPoint.counts[ct.key] ?? 0).toLocaleString('id-ID')}</span>
          </span>
        ))}
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        className="dbmon2-chart-svg"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          {CHART_TABLES.map((ct) => (
            <linearGradient key={ct.key} id={`dbm-grad-${ct.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={ct.color} stopOpacity="0.18" />
              <stop offset="100%" stopColor={ct.color} stopOpacity="0.01" />
            </linearGradient>
          ))}
        </defs>
        {/* Grid lines */}
        {yTicks.map((v, i) => {
          const y = toY(v);
          return (
            <g key={i}>
              <line x1={padL} x2={W - padR} y1={y} y2={y} stroke="var(--line)" strokeWidth="0.5" strokeDasharray="3 4" />
              <text x={padL - 4} y={y + 4} fontSize="9" fill="var(--muted)" textAnchor="end">{Math.round(v).toLocaleString('id-ID')}</text>
            </g>
          );
        })}
        {/* X axis labels — every 4 points */}
        {history.map((h, i) => {
          if (i % 4 !== 0 && i !== n - 1) return null;
          return (
            <text key={i} x={toX(i)} y={H - 4} fontSize="9" fill="var(--muted)" textAnchor="middle">
              {h.time.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
            </text>
          );
        })}
        {/* Area fills */}
        {CHART_TABLES.map((ct) => {
          const pts = history.map((h, i) => ({ x: toX(i), y: toY(h.counts[ct.key] ?? 0) }));
          const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
          const areaPath = `${linePath} L${pts[pts.length - 1].x.toFixed(1)},${H - padB} L${pts[0].x.toFixed(1)},${H - padB} Z`;
          return <path key={ct.key} d={areaPath} fill={`url(#dbm-grad-${ct.key})`} />;
        })}
        {/* Lines */}
        {CHART_TABLES.map((ct) => {
          const pts = history.map((h, i) => ({ x: toX(i), y: toY(h.counts[ct.key] ?? 0) }));
          const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
          return <path key={ct.key} d={linePath} fill="none" stroke={ct.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />;
        })}
        {/* Hover crosshair */}
        {hoverIdx !== null && (
          <>
            <line x1={toX(hi)} x2={toX(hi)} y1={padT} y2={H - padB} stroke="var(--muted)" strokeWidth="1" strokeDasharray="3 3" />
            {CHART_TABLES.map((ct) => {
              const v = hPoint.counts[ct.key] ?? 0;
              return <circle key={ct.key} cx={toX(hi)} cy={toY(v)} r="4" fill={ct.color} stroke="var(--card)" strokeWidth="2" />;
            })}
          </>
        )}
        {/* Endpoint dots */}
        {hoverIdx === null && CHART_TABLES.map((ct) => {
          const v = hPoint.counts[ct.key] ?? 0;
          return <circle key={ct.key} cx={toX(n - 1)} cy={toY(v)} r="4" fill={ct.color} stroke="var(--card)" strokeWidth="2" />;
        })}
      </svg>
      {/* Legend */}
      <div className="dbmon2-chart-legend">
        {CHART_TABLES.map((ct) => (
          <span key={ct.key} className="dbmon2-legend-item">
            <span className="dbmon2-legend-dot" style={{ background: ct.color }} />
            {ct.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function StorageGauge({ used, total, label, sublabel }: { used: number; total: number; label: string; sublabel: string }) {
  const pct = Math.min(1, used / total);
  const R = 70; const cx = 100; const cy = 90;
  const startAngle = Math.PI; const endAngle = 2 * Math.PI;
  const sweepAngle = endAngle - startAngle;
  const angle = startAngle + pct * sweepAngle;
  const arcX = (r: number, a: number) => cx + r * Math.cos(a);
  const arcY = (r: number, a: number) => cy + r * Math.sin(a);
  const trackPath = `M${arcX(R, startAngle).toFixed(1)},${arcY(R, startAngle).toFixed(1)} A${R},${R} 0 1 1 ${arcX(R, endAngle - 0.001).toFixed(1)},${arcY(R, endAngle - 0.001).toFixed(1)}`;
  const fillPath = pct > 0.001
    ? `M${arcX(R, startAngle).toFixed(1)},${arcY(R, startAngle).toFixed(1)} A${R},${R} 0 ${pct > 0.5 ? 1 : 0} 1 ${arcX(R, angle).toFixed(1)},${arcY(R, angle).toFixed(1)}`
    : '';
  const gaugeColor = pct >= 0.8 ? '#ef4444' : pct >= 0.5 ? '#f59e0b' : '#6366f1';
  return (
    <div className="dbmon2-gauge-wrap">
      <svg viewBox="0 0 200 100" className="dbmon2-gauge-svg">
        <defs>
          <linearGradient id="gauge-grad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#6366f1" />
            <stop offset="60%" stopColor="#f59e0b" />
            <stop offset="100%" stopColor="#ef4444" />
          </linearGradient>
        </defs>
        <path d={trackPath} fill="none" stroke="var(--line)" strokeWidth="10" strokeLinecap="round" />
        {fillPath && <path d={fillPath} fill="none" stroke="url(#gauge-grad)" strokeWidth="10" strokeLinecap="round" />}
        <text x={cx} y={cy - 10} textAnchor="middle" fontSize="22" fontWeight="800" fill={gaugeColor}>{(pct * 100).toFixed(0)}%</text>
        <text x={cx} y={cy + 8} textAnchor="middle" fontSize="9" fill="var(--muted)">{label}</text>
        <text x={18} y={cy + 16} textAnchor="middle" fontSize="8" fill="var(--muted)">0%</text>
        <text x={182} y={cy + 16} textAnchor="middle" fontSize="8" fill="var(--muted)">100%</text>
      </svg>
      <div className="dbmon2-gauge-sub">{sublabel}</div>
    </div>
  );
}

function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

type ActivityItem = { id: string; type: 'transaksi' | 'booking' | 'topup' | 'user'; label: string; sub: string; time: string; color: string };
type TodayStats = { newUsers: number; transactions: number; bookings: number; topups: number };

// ── Asset & Spending Monitor ────────────────────────────────────
type AssetStat = { asset_key: string; title: string; type: string; unlock_count: number };
type SpendUser = { username: string; display_name: string; total_coin_spent: number; total_rp_spent: number; topup_count: number };
type VideoViewUser = { username: string; display_name: string; total_plays: number; last_viewed: string };

function AssetMonitor() {
  const [assets, setAssets] = useState<AssetStat[]>([]);
  const [spenders, setSpenders] = useState<SpendUser[]>([]);
  const [videoViewUsers, setVideoViewUsers] = useState<VideoViewUser[]>([]);
  const [totalVideoPlays, setTotalVideoPlays] = useState(0);
  const [totalCoinSpent, setTotalCoinSpent] = useState(0);
  const [totalRpTopup, setTotalRpTopup] = useState(0);
  const [totalTopupCount, setTotalTopupCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'assets' | 'users' | 'videos'>('assets');

  useEffect(() => {
    void (async () => {
      setLoading(true);
      const [{ data: assetRows }, { data: unlockRows }, { data: txRows }, { data: topupRows }, { data: profileRows }, { data: videoRows }] = await Promise.all([
        supabase.from('lesson_assets').select('asset_key, title, type').order('title'),
        supabase.from('user_asset_unlocks').select('asset_id, username'),
        supabase.from('credit_transactions').select('username, amount, type'),
        supabase.from('topup_requests').select('username, amount_rp, credits').eq('status', 'approved'),
        supabase.from('user_profiles').select('username, name'),
        supabase.from('video_views').select('username, video_title, viewed_at').order('viewed_at', { ascending: false }),
      ]);

      // Asset stats
      const unlockCountMap: Record<string, number> = {};
      for (const r of (unlockRows ?? []) as { asset_id: string; username: string }[]) {
        unlockCountMap[r.asset_id] = (unlockCountMap[r.asset_id] ?? 0) + 1;
      }
      const assetStats: AssetStat[] = ((assetRows ?? []) as { asset_key: string; title: string; type: string }[]).map((a) => ({
        ...a,
        unlock_count: unlockCountMap[a.asset_key] ?? 0,
      })).sort((a, b) => b.unlock_count - a.unlock_count);
      setAssets(assetStats);

      // User spending stats from credit_transactions (type = 'spend' or negative)
      const spendMap: Record<string, number> = {};
      for (const r of (txRows ?? []) as { username: string; amount: number; type: string }[]) {
        if (r.amount < 0 || r.type === 'spend' || r.type === 'purchase') {
          spendMap[r.username] = (spendMap[r.username] ?? 0) + Math.abs(r.amount);
        }
      }
      setTotalCoinSpent(Object.values(spendMap).reduce((a, b) => a + b, 0));

      // Topup stats
      const topupRpMap: Record<string, number> = {};
      const topupCountMap: Record<string, number> = {};
      let totalRp = 0;
      for (const r of (topupRows ?? []) as { username: string; amount_rp: number; credits: number }[]) {
        topupRpMap[r.username] = (topupRpMap[r.username] ?? 0) + (r.amount_rp ?? 0);
        topupCountMap[r.username] = (topupCountMap[r.username] ?? 0) + 1;
        totalRp += r.amount_rp ?? 0;
      }
      setTotalRpTopup(totalRp);
      setTotalTopupCount((topupRows ?? []).length);

      const nameMap: Record<string, string> = {};
      for (const p of (profileRows ?? []) as { username: string; name: string }[]) {
        nameMap[p.username] = p.name;
      }

      // Video view stats per user
      const videoPlayMap: Record<string, number> = {};
      const videoLastMap: Record<string, string> = {};
      for (const r of (videoRows ?? []) as { username: string; video_title: string; viewed_at: string }[]) {
        videoPlayMap[r.username] = (videoPlayMap[r.username] ?? 0) + 1;
        if (!videoLastMap[r.username]) videoLastMap[r.username] = r.viewed_at;
      }
      setTotalVideoPlays((videoRows ?? []).length);
      const videoUserList: VideoViewUser[] = Object.keys(videoPlayMap).map((u) => ({
        username: u,
        display_name: nameMap[u] ?? u,
        total_plays: videoPlayMap[u],
        last_viewed: videoLastMap[u] ?? '',
      })).sort((a, b) => b.total_plays - a.total_plays);
      setVideoViewUsers(videoUserList);

      const allUsernames = new Set([...Object.keys(spendMap), ...Object.keys(topupRpMap)]);
      const spenderList: SpendUser[] = [...allUsernames].map((u) => ({
        username: u,
        display_name: nameMap[u] ?? u,
        total_coin_spent: spendMap[u] ?? 0,
        total_rp_spent: topupRpMap[u] ?? 0,
        topup_count: topupCountMap[u] ?? 0,
      })).sort((a, b) => b.total_rp_spent - a.total_rp_spent);
      setSpenders(spenderList);
      setLoading(false);
    })();
  }, []);

  const formatRp = (n: number) => `Rp ${n.toLocaleString('id-ID')}`;

  if (loading) return <div className="asset-monitor-loading">Memuat data…</div>;

  return (
    <div className="asset-monitor">
      {/* Summary cards */}
      <div className="asset-monitor-cards">
        <div className="asset-monitor-card">
          <span className="amc-label">Total Asset</span>
          <span className="amc-value">{assets.length}</span>
          <span className="amc-sub">asset tersedia</span>
        </div>
        <div className="asset-monitor-card">
          <span className="amc-label">Total Unlock</span>
          <span className="amc-value">{assets.reduce((s, a) => s + a.unlock_count, 0)}</span>
          <span className="amc-sub">akses dibuka user</span>
        </div>
        <div className="asset-monitor-card accent">
          <span className="amc-label">Ruang Coin Dipakai</span>
          <span className="amc-value">{totalCoinSpent.toLocaleString('id-ID')}</span>
          <span className="amc-sub">total coin di-spend</span>
        </div>
        <div className="asset-monitor-card green">
          <span className="amc-label">Total Topup</span>
          <span className="amc-value">{formatRp(totalRpTopup)}</span>
          <span className="amc-sub">{totalTopupCount} transaksi approved</span>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="asset-monitor-tabs">
        <button className={`amt-tab${tab === 'assets' ? ' active' : ''}`} onClick={() => setTab('assets')}>📦 Per Asset</button>
        <button className={`amt-tab${tab === 'users' ? ' active' : ''}`} onClick={() => setTab('users')}>👤 Per User</button>
        <button className={`amt-tab${tab === 'videos' ? ' active' : ''}`} onClick={() => setTab('videos')}>▶ Video Play</button>
      </div>

      {tab === 'assets' && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Judul Asset</th>
                <th>Tipe</th>
                <th>Total Unlock</th>
              </tr>
            </thead>
            <tbody>
              {assets.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--muted)' }}>Belum ada data</td></tr>}
              {assets.map((a, i) => (
                <tr key={a.asset_key}>
                  <td style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>{i + 1}</td>
                  <td><strong>{a.title}</strong></td>
                  <td><span className="asset-type-badge">{a.type}</span></td>
                  <td>
                    <span className={`amc-count${a.unlock_count > 0 ? ' has-data' : ''}`}>{a.unlock_count}×</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'users' && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>#</th>
                <th>User</th>
                <th>Coin Dipakai</th>
                <th>Total Topup (Rp)</th>
                <th>Jml Topup</th>
              </tr>
            </thead>
            <tbody>
              {spenders.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--muted)' }}>Belum ada data</td></tr>}
              {spenders.map((u, i) => (
                <tr key={u.username}>
                  <td style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>{i + 1}</td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{u.display_name}</div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>@{u.username}</div>
                  </td>
                  <td>
                    <span className={`amc-count${u.total_coin_spent > 0 ? ' has-data' : ''}`}>
                      {u.total_coin_spent > 0 ? `${u.total_coin_spent.toLocaleString('id-ID')} coin` : '—'}
                    </span>
                  </td>
                  <td style={{ color: '#059669', fontWeight: 600 }}>
                    {u.total_rp_spent > 0 ? formatRp(u.total_rp_spent) : '—'}
                  </td>
                  <td style={{ color: 'var(--muted)' }}>{u.topup_count > 0 ? `${u.topup_count}×` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'videos' && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>#</th>
                <th>User</th>
                <th>Total Play</th>
                <th>Terakhir Nonton</th>
              </tr>
            </thead>
            <tbody>
              {videoViewUsers.length === 0 && (
                <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--muted)' }}>Belum ada data — data akan muncul setelah user memutar video</td></tr>
              )}
              {videoViewUsers.map((u, i) => (
                <tr key={u.username}>
                  <td style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>{i + 1}</td>
                  <td>
                    <strong>{u.display_name}</strong>
                    <span style={{ color: 'var(--muted)', fontSize: '0.8rem', marginLeft: 6 }}>@{u.username}</span>
                  </td>
                  <td>
                    <span className={`amc-count${u.total_plays > 0 ? ' has-data' : ''}`}>{u.total_plays}×</span>
                  </td>
                  <td style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>
                    {u.last_viewed ? new Date(u.last_viewed).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 8, color: 'var(--muted)', fontSize: '0.82rem' }}>
            Total {totalVideoPlays.toLocaleString('id-ID')} play dari {videoViewUsers.length} user
          </div>
        </div>
      )}
    </div>
  );
}

function DbMonitor() {
  const [tables, setTables] = useState<TableStat[]>([]);
  const [buckets, setBuckets] = useState<BucketStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshed, setRefreshed] = useState<Date | null>(null);
  const [history, setHistory] = useState<ChartPoint[]>([]);
  const [polling, setPolling] = useState(true);
  const [paused, setPaused] = useState(false);
  const POLL_INTERVAL = 60;
  const [countdown, setCountdown] = useState(POLL_INTERVAL);
  const prevCounts = useRef<Record<string, number>>({});
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [todayStats, setTodayStats] = useState<TodayStats>({ newUsers: 0, transactions: 0, bookings: 0, topups: 0 });

  const TABLE_DEFS: { name: string; label: string; warnAt: number; limitAt: number }[] = [
    { name: 'app_users',            label: 'Users',              warnAt: 500,   limitAt: 1000  },
    { name: 'user_profiles',        label: 'User Profiles',      warnAt: 500,   limitAt: 1000  },
    { name: 'user_credits',         label: 'Credits',            warnAt: 500,   limitAt: 1000  },
    { name: 'credit_transactions',  label: 'Transaksi Coin',     warnAt: 5000,  limitAt: 20000 },
    { name: 'courses',              label: 'Kelas',              warnAt: 50,    limitAt: 200   },
    { name: 'lessons',              label: 'Lessons',            warnAt: 500,   limitAt: 2000  },
    { name: 'lesson_progress',      label: 'Progres Belajar',    warnAt: 5000,  limitAt: 20000 },
    { name: 'lesson_notes',         label: 'Catatan',            warnAt: 2000,  limitAt: 10000 },
    { name: 'one_on_one_bookings',  label: 'Booking 1:1',        warnAt: 1000,  limitAt: 5000  },
    { name: 'topup_requests',       label: 'Request Topup',      warnAt: 1000,  limitAt: 5000  },
    { name: 'forum_threads',          label: 'Forum Posts',        warnAt: 2000,  limitAt: 10000 },
    { name: 'notifications',        label: 'Notifikasi',         warnAt: 5000,  limitAt: 20000 },
    { name: 'learning_hub_content', label: 'Konten & Settings',  warnAt: 50,    limitAt: 200   },
    { name: 'shared_assets',        label: 'Shared Assets',      warnAt: 500,   limitAt: 2000  },
  ];

  const BUCKET_DEFS: { name: string; label: string; warnAt: number; sizeLimitBytes: number }[] = [
    { name: 'profile-avatars', label: 'Avatar Profile', warnAt: 500, sizeLimitBytes: 500 * 1024 * 1024 },
    { name: 'lesson-assets',   label: 'Aset Kelas',     warnAt: 200, sizeLimitBytes: 500 * 1024 * 1024 },
  ];
  // Supabase free tier limits
  const DB_SIZE_LIMIT_BYTES = 500 * 1024 * 1024;
  const STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024;
  // Rough estimate: avg 512 bytes/row
  const AVG_ROW_BYTES = 512;

  const load24hHistory = async () => {
    const now = new Date();
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [txData, bookData, forumData, userNewData] = await Promise.all([
      supabase.from('credit_transactions').select('created_at').gte('created_at', since.toISOString()),
      supabase.from('one_on_one_bookings').select('created_at').gte('created_at', since.toISOString()),
      supabase.from('forum_threads').select('created_at').gte('created_at', since.toISOString()),
      supabase.from('app_users').select('created_at').gte('created_at', since.toISOString()),
    ]);

    const countInHour = (data: { created_at: string }[] | null, start: Date, end: Date) =>
      (data ?? []).filter((r) => { const t = new Date(r.created_at); return t >= start && t < end; }).length;

    const buckets: ChartPoint[] = [];
    for (let i = 0; i < 24; i++) {
      const bucketStart = new Date(since.getTime() + i * 3600 * 1000);
      const bucketEnd   = new Date(bucketStart.getTime() + 3600 * 1000);
      buckets.push({
        time: bucketEnd,
        counts: {
          app_users:           countInHour(userNewData.data, bucketStart, bucketEnd),
          credit_transactions: countInHour(txData.data,     bucketStart, bucketEnd),
          one_on_one_bookings: countInHour(bookData.data,   bucketStart, bucketEnd),
          forum_threads:         countInHour(forumData.data,  bucketStart, bucketEnd),
        },
      });
    }
    setHistory(buckets);
  };

  const loadActivity = async () => {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const iso = todayStart.toISOString();

    const [txRes, bookRes, topupRes, newUserRes, recentTx, recentBook, recentTopup, recentUser] = await Promise.all([
      supabase.from('credit_transactions').select('*', { count: 'exact', head: true }).gte('created_at', iso),
      supabase.from('one_on_one_bookings').select('*', { count: 'exact', head: true }).gte('created_at', iso),
      supabase.from('topup_requests').select('*', { count: 'exact', head: true }).gte('created_at', iso),
      supabase.from('app_users').select('*', { count: 'exact', head: true }).gte('created_at', iso),
      supabase.from('credit_transactions').select('id,type,amount,created_at,username').order('created_at', { ascending: false }).limit(5),
      supabase.from('one_on_one_bookings').select('id,status,created_at,requester_username').order('created_at', { ascending: false }).limit(5),
      supabase.from('topup_requests').select('id,status,amount_rp,created_at,username').order('created_at', { ascending: false }).limit(4),
      supabase.from('app_users').select('id,username,created_at').order('created_at', { ascending: false }).limit(4),
    ]);

    setTodayStats({
      newUsers: newUserRes.count ?? 0,
      transactions: txRes.count ?? 0,
      bookings: bookRes.count ?? 0,
      topups: topupRes.count ?? 0,
    });

    const fmt = (iso: string) => new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    const items: ActivityItem[] = [
      ...(recentTx.data ?? []).map((r: Record<string,unknown>) => ({
        id: `tx-${r.id}`, type: 'transaksi' as const,
        label: `Transaksi ${String(r.type ?? '')}`,
        sub: `${String(r.username ?? '—')} · ${Number(r.amount ?? 0).toLocaleString('id-ID')} coin`,
        time: fmt(String(r.created_at)), color: '#f59e0b',
      })),
      ...(recentBook.data ?? []).map((r: Record<string,unknown>) => ({
        id: `bk-${r.id}`, type: 'booking' as const,
        label: `Booking 1:1`,
        sub: `${String(r.requester_username ?? '—')} · ${String(r.status ?? '')}`,
        time: fmt(String(r.created_at)), color: '#22c55e',
      })),
      ...(recentTopup.data ?? []).map((r: Record<string,unknown>) => ({
        id: `tp-${r.id}`, type: 'topup' as const,
        label: `Topup ${String(r.status ?? '')}`,
        sub: `${String(r.username ?? '—')} · Rp${Number(r.amount_rp ?? 0).toLocaleString('id-ID')}`,
        time: fmt(String(r.created_at)), color: '#6366f1',
      })),
      ...(recentUser.data ?? []).map((r: Record<string,unknown>) => ({
        id: `usr-${r.id}`, type: 'user' as const,
        label: `User baru`,
        sub: String(r.username ?? '—'),
        time: fmt(String(r.created_at)), color: '#ec4899',
      })),
    ].sort((a, b) => b.time.localeCompare(a.time)).slice(0, 12);
    setActivity(items);
  };

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    const counts = await Promise.all(
      TABLE_DEFS.map(async (t) => {
        const { count } = await supabase.from(t.name as never).select('*', { count: 'exact', head: true });
        return { ...t, count: count ?? 0 };
      })
    );
    setTables(counts);

    void load24hHistory();

    const bucketStats = await Promise.all(
      BUCKET_DEFS.map(async (b) => {
        // File tersimpan di dalam subfolder (mis. topup-proofs/, shared-asset-thumbs/),
        // jadi list('') hanya mengembalikan folder. Telusuri 1 level ke dalam.
        const { data: top } = await supabase.storage.from(b.name).list('', { limit: 1000 });
        let files = 0;
        let sizeBytes = 0;
        const folders: string[] = [];
        for (const entry of top ?? []) {
          const size = (entry.metadata as { size?: number } | null)?.size;
          if (entry.id && typeof size === 'number') { files += 1; sizeBytes += size; }
          else folders.push(entry.name); // folder (metadata null)
        }
        const subResults = await Promise.all(folders.map((folder) => supabase.storage.from(b.name).list(folder, { limit: 1000 })));
        for (const { data: sub } of subResults) {
          for (const f of sub ?? []) {
            const size = (f.metadata as { size?: number } | null)?.size;
            if (typeof size === 'number') { files += 1; sizeBytes += size; }
          }
        }
        return { name: b.name, label: b.label, files, warnAt: b.warnAt, sizeBytes };
      })
    );
    setBuckets(bucketStats);
    void loadActivity();
    prevCounts.current = counts;
    setRefreshed(new Date());
    setCountdown(POLL_INTERVAL);
    if (!silent) setLoading(false);
  };

  // Initial load
  useEffect(() => { void load(); }, []);

  // Auto-pause when tab is hidden
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        setPaused(true);
      } else {
        setPaused(false);
        void load(true);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Poll interval — suspended when paused or manually stopped
  useEffect(() => {
    if (!polling || paused) return;
    const interval = setInterval(() => { void load(true); }, POLL_INTERVAL * 1000);
    return () => clearInterval(interval);
  }, [polling, paused]);

  // Countdown ticker
  useEffect(() => {
    if (!polling || paused) return;
    const tick = setInterval(() => setCountdown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(tick);
  }, [polling, paused]);

  // Derived stats
  const totalRows = tables.reduce((a, t) => a + t.count, 0);
  const estimatedDbBytes = totalRows * AVG_ROW_BYTES;
  const totalStorageBytes = buckets.reduce((a, b) => a + b.sizeBytes, 0);
  const freeStorageBytes = Math.max(0, STORAGE_LIMIT_BYTES - totalStorageBytes);
  const freeDbBytes = Math.max(0, DB_SIZE_LIMIT_BYTES - estimatedDbBytes);

  // Stat ring deltas (compare latest two history points)
  const getDelta = (key: string): number | null => {
    if (history.length < 2) return null;
    const cur = history[history.length - 1].counts[key] ?? 0;
    const prev = history[history.length - 2].counts[key] ?? 0;
    return cur - prev;
  };

  const STAT_CARDS = [
    ...CHART_TABLES.map((ct) => ({
      key: ct.key,
      label: ct.label,
      color: ct.color,
      value: tables.find((t) => t.name === ct.key)?.count ?? 0,
      limit: ct.limitAt,
      delta: getDelta(ct.key),
    })),
    {
      key: 'storage_used',
      label: 'Storage Dipakai',
      color: '#3b82f6',
      value: Math.round(totalStorageBytes / (1024 * 1024)),
      limit: Math.round(STORAGE_LIMIT_BYTES / (1024 * 1024)),
      delta: null,
    },
    {
      key: 'db_rows',
      label: 'Total Baris DB',
      color: '#8b5cf6',
      value: totalRows,
      limit: 100000,
      delta: null,
    },
  ];

  return (
    <div className="dbmon2-shell">
      {/* Header */}
      <div className="dbmon2-header">
        <div>
          <h2 className="dbmon2-title">Overview</h2>
          {refreshed && (
            <p className="dbmon2-subtitle">
              Diperbarui {refreshed.toLocaleTimeString('id-ID')} ·{' '}
              {paused ? '⏸ dijeda (tab tidak aktif)' : polling ? `auto-refresh dalam ${countdown}d` : 'auto-refresh off'}
              {' · '}Supabase Free Tier: 500 MB database · 1 GB storage
            </p>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="admin-mini-btn ghost" onClick={() => setPolling((p) => !p)}>
            {polling ? '⏸ Pause' : '▶ Resume'}
          </button>
          <button type="button" className="admin-mini-btn" onClick={() => void load()} disabled={loading}>
            {loading ? 'Memuat…' : '+ Refresh'}
          </button>
        </div>
      </div>

      {/* Stat ring cards */}
      <div className="dbmon2-stat-row">
        {STAT_CARDS.map((s) => (
          <StatRingCard key={s.key} value={s.value} limit={s.limit} color={s.color} label={s.label} delta={s.delta} />
        ))}
      </div>

      {/* Today stats bar */}
      <div className="dbmon2-today-bar">
        {[
          { label: 'User baru hari ini',    value: todayStats.newUsers,     color: '#ec4899' },
          { label: 'Transaksi hari ini',    value: todayStats.transactions,  color: '#f59e0b' },
          { label: 'Booking hari ini',      value: todayStats.bookings,      color: '#22c55e' },
          { label: 'Topup hari ini',        value: todayStats.topups,        color: '#6366f1' },
        ].map((s) => (
          <div key={s.label} className="dbmon2-today-item">
            <span className="dbmon2-today-dot" style={{ background: s.color }} />
            <span className="dbmon2-today-value" style={{ color: s.color }}>{s.value}</span>
            <span className="dbmon2-today-label">{s.label}</span>
          </div>
        ))}
        <span className="dbmon2-today-note">Data sejak 00:00 hari ini</span>
      </div>

      {/* Middle row: line chart + storage gauge */}
      <div className="dbmon2-mid-row">
        <div className="dbmon2-chart-card">
          <div className="dbmon2-card-head">
            <span className="dbmon2-card-title">Aktivitas 24 Jam Terakhir</span>
            <span className="dbmon2-card-sub">per jam · diperbarui tiap {POLL_INTERVAL}d</span>
          </div>
          <MultiLineChart history={history} />
        </div>
        <div className="dbmon2-side-col">
          <div className="dbmon2-gauge-card">
            <div className="dbmon2-card-head">
              <span className="dbmon2-card-title">Storage</span>
            </div>
            <StorageGauge
              used={totalStorageBytes}
              total={STORAGE_LIMIT_BYTES}
              label="terpakai"
              sublabel={`${formatBytes(totalStorageBytes)} dipakai · ${formatBytes(freeStorageBytes)} tersisa`}
            />
          </div>
          <div className="dbmon2-gauge-card">
            <div className="dbmon2-card-head">
              <span className="dbmon2-card-title">Database (estimasi)</span>
            </div>
            <StorageGauge
              used={estimatedDbBytes}
              total={DB_SIZE_LIMIT_BYTES}
              label="est. terpakai"
              sublabel={`~${formatBytes(estimatedDbBytes)} · ~${formatBytes(freeDbBytes)} tersisa`}
            />
          </div>
        </div>
      </div>

      {/* Bottom row: table bar chart + bucket stats */}
      {!loading && (
        <div className="dbmon2-bot-row">
          <div className="dbmon2-perf-card">
            <div className="dbmon2-card-head">
              <span className="dbmon2-card-title">Semua Tabel</span>
              <span className="dbmon2-card-sub">jumlah baris vs batas estimasi</span>
            </div>
            <div className="dbmon2-perf-list">
              {tables.map((t) => {
                const pct = Math.min(100, (t.count / t.limitAt) * 100);
                const color = pct >= 80 ? '#ef4444' : pct >= 50 ? '#f59e0b' : '#6366f1';
                return (
                  <div key={t.name} className="dbmon2-perf-row">
                    <div className="dbmon2-perf-meta">
                      <span className="dbmon2-perf-label">{t.label}</span>
                      <span className="dbmon2-perf-pct" style={{ color }}>{pct.toFixed(0)}%</span>
                    </div>
                    <div className="dbmon2-perf-track">
                      <div className="dbmon2-perf-fill" style={{ width: `${pct}%`, background: color }} />
                    </div>
                    <span className="dbmon2-perf-count">{t.count.toLocaleString('id-ID')}</span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="dbmon2-bucket-card">
            <div className="dbmon2-card-head">
              <span className="dbmon2-card-title">Storage Bucket</span>
              <span className="dbmon2-card-sub">ukuran aktual file</span>
            </div>
            <div className="dbmon2-bucket-list">
              {buckets.map((b) => {
                const pct = Math.min(100, (b.sizeBytes / (STORAGE_LIMIT_BYTES / 2)) * 100);
                const color = pct >= 80 ? '#ef4444' : pct >= 50 ? '#f59e0b' : '#3b82f6';
                return (
                  <div key={b.name} className="dbmon2-bucket-item">
                    <div className="dbmon2-bucket-top">
                      <span className="dbmon2-bucket-label">{b.label}</span>
                      <span className="dbmon2-bucket-name">{b.name}</span>
                    </div>
                    <div className="dbmon2-bucket-stats">
                      <span className="dbmon2-bucket-files">{b.files} file</span>
                      <span className="dbmon2-bucket-size" style={{ color }}>{formatBytes(b.sizeBytes)}</span>
                    </div>
                    <div className="dbmon2-perf-track">
                      <div className="dbmon2-perf-fill" style={{ width: `${pct}%`, background: color }} />
                    </div>
                    <div className="dbmon2-bucket-meta">
                      Tersisa: {formatBytes(Math.max(0, STORAGE_LIMIT_BYTES / 2 - b.sizeBytes))} dari 500 MB
                    </div>
                  </div>
                );
              })}
            </div>
            {/* Total storage summary */}
            <div className="dbmon2-storage-total">
              <div className="dbmon2-storage-row">
                <span>Total dipakai</span>
                <span style={{ color: '#3b82f6', fontWeight: 700 }}>{formatBytes(totalStorageBytes)}</span>
              </div>
              <div className="dbmon2-storage-row">
                <span>Tersisa (1 GB limit)</span>
                <span style={{ color: '#22c55e', fontWeight: 700 }}>{formatBytes(freeStorageBytes)}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Activity feed */}
      {activity.length > 0 && (
        <div className="dbmon2-activity-card">
          <div className="dbmon2-card-head">
            <span className="dbmon2-card-title">Aktivitas Terbaru</span>
            <span className="dbmon2-card-sub">12 event terbaru · diperbarui tiap {POLL_INTERVAL}d</span>
          </div>
          <div className="dbmon2-activity-grid">
            {activity.map((a) => (
              <div key={a.id} className="dbmon2-activity-item">
                <span className="dbmon2-activity-dot" style={{ background: a.color }} />
                <div className="dbmon2-activity-body">
                  <span className="dbmon2-activity-label">{a.label}</span>
                  <span className="dbmon2-activity-sub">{a.sub}</span>
                </div>
                <span className="dbmon2-activity-time">{a.time}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading && tables.length === 0 && <div className="forum-loading">Mengambil data…</div>}
    </div>
  );
}

// Editor admin untuk konten landing page: teks, tombol, foto (upload),
// tambah/hapus langkah, fitur, dan FAQ. Disimpan ke Supabase.
function LandingImageInput({ value, onChange }: { value: string; onChange: (url: string) => void }) {
  const [uploading, setUploading] = useState(false);
  return (
    <div className="landing-edit-image">
      {value ? <img src={value} alt="" className="landing-edit-thumb" /> : <div className="landing-edit-thumb empty" />}
      <div className="landing-edit-image-actions">
        <label className="admin-mini-btn">
          {uploading ? 'Mengunggah…' : 'Upload Foto'}
          <input
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setUploading(true);
              try { onChange(await uploadLandingImage(await compressImage(file, 1600, 0.82))); } catch { alert('Gagal upload gambar.'); }
              setUploading(false);
            }}
          />
        </label>
        {value && <button type="button" className="admin-mini-btn ghost" onClick={() => onChange('')}>Hapus</button>}
      </div>
    </div>
  );
}

function LandingEditor() {
  const [content, setContent] = useState<LandingContent | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(false);
  const [openSections, setOpenSections] = useState<string[]>(['hero']);

  useEffect(() => { void loadLandingContent().then(setContent); }, []);

  if (!content) return <div className="forum-loading">memuat konten landing…</div>;
  const c = content;
  const set = (patch: Partial<LandingContent>) => setContent({ ...c, ...patch });
  const toggle = (id: string) => setOpenSections((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  const isOpen = (id: string) => openSections.includes(id);

  const save = async () => {
    setSaving(true);
    await saveLandingContent(c);
    setSaving(false);
    setSavedAt(true);
    setTimeout(() => setSavedAt(false), 2500);
  };

  return (
    <div className="lpb-shell">

      {/* ── Live Preview 80% ── */}
      <div className="lpb-preview">
        <div className="lpb-preview-bar">
          <span className="lpb-preview-label">Live Preview</span>
          <a className="admin-mini-btn ghost" href="#" onClick={(e) => { e.preventDefault(); window.open('/', '_blank'); }}>Buka ↗</a>
        </div>
        <div className="lpb-preview-viewport">
          <div className="lpb-preview-scaler">
            <LandingPage content={c} onMasuk={() => {}} onPickPackage={() => {}} />
          </div>
        </div>
      </div>

      {/* ── Sidebar Editor 20% ── */}
      <aside className="lpb-sidebar">
        <div className="lpb-sidebar-head">
          <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text)' }}>Editor</span>
          <button type="button" className="admin-add-btn" style={{ padding: '6px 14px', fontSize: '0.82rem' }} disabled={saving} onClick={() => void save()}>
            {saving ? '…' : savedAt ? '✓ Tersimpan' : 'Simpan'}
          </button>
        </div>

        {/* Hero */}
        <div className={`lpb-acc${isOpen('hero') ? ' open' : ''}`}>
          <button className="lpb-acc-trigger" onClick={() => toggle('hero')}>
            <span>🏠 Hero</span><span className="lpb-chevron">{isOpen('hero') ? '▴' : '▾'}</span>
          </button>
          <div className="lpb-acc-body">
            <label>Badge<input value={c.badge} onChange={(e) => set({ badge: e.target.value })} /></label>
            <label>Judul utama<textarea rows={2} value={c.heroTitle} onChange={(e) => set({ heroTitle: e.target.value })} /></label>
            <label>Deskripsi<textarea rows={3} value={c.heroSubtitle} onChange={(e) => set({ heroSubtitle: e.target.value })} /></label>
            <label>Teks tombol<input value={c.heroCtaLabel} onChange={(e) => set({ heroCtaLabel: e.target.value })} /></label>
            <label>Placeholder email<input value={c.emailPlaceholder} onChange={(e) => set({ emailPlaceholder: e.target.value })} /></label>
          </div>
        </div>

        {/* Cara Kerja */}
        <div className={`lpb-acc${isOpen('steps') ? ' open' : ''}`}>
          <button className="lpb-acc-trigger" onClick={() => toggle('steps')}>
            <span>📋 Cara Kerja</span><span className="lpb-chevron">{isOpen('steps') ? '▴' : '▾'}</span>
          </button>
          <div className="lpb-acc-body">
            <label>Teks kecil di atas judul<input value={c.painEyebrow ?? ''} onChange={(e) => set({ painEyebrow: e.target.value })} /></label>
            <label>Judul bagian<input value={c.howTitle} onChange={(e) => set({ howTitle: e.target.value })} /></label>
            {c.steps.map((s, i) => (
              <div className="lpb-sub-item" key={s.id}>
                <div className="lpb-sub-head">
                  <strong>Card {i + 1}</strong>
                  <button type="button" className="admin-mini-btn ghost" onClick={() => set({ steps: c.steps.filter((x) => x.id !== s.id) })}>Hapus</button>
                </div>
                <label>Ikon (emoji)<input value={s.label} onChange={(e) => set({ steps: c.steps.map((x) => x.id === s.id ? { ...x, label: e.target.value } : x) })} /></label>
                <label>Judul<input value={s.title} onChange={(e) => set({ steps: c.steps.map((x) => x.id === s.id ? { ...x, title: e.target.value } : x) })} /></label>
                <label>Deskripsi<textarea rows={2} value={s.desc} onChange={(e) => set({ steps: c.steps.map((x) => x.id === s.id ? { ...x, desc: e.target.value } : x) })} /></label>
              </div>
            ))}
            <button type="button" className="admin-mini-btn" onClick={() => set({ steps: [...c.steps, { id: `s${Date.now()}`, image: '', label: `Langkah 0${c.steps.length + 1}`, title: 'Judul langkah', desc: 'Deskripsi langkah' }] })}>+ Tambah Langkah</button>
          </div>
        </div>

        {/* Pricing */}
        <div className={`lpb-acc${isOpen('pricing') ? ' open' : ''}`}>
          <button className="lpb-acc-trigger" onClick={() => toggle('pricing')}>
            <span>💰 Pricing</span><span className="lpb-chevron">{isOpen('pricing') ? '▴' : '▾'}</span>
          </button>
          <div className="lpb-acc-body">
            <label className="lpb-checkbox-label">
              <input type="checkbox" checked={c.showPricing} onChange={(e) => set({ showPricing: e.target.checked })} />
              Tampilkan bagian pricing
            </label>
            <label>Judul bagian<input value={c.pricingTitle} onChange={(e) => set({ pricingTitle: e.target.value })} /></label>
            <label>Subjudul<input value={c.pricingSubtitle} onChange={(e) => set({ pricingSubtitle: e.target.value })} /></label>
            <p className="lpb-hint">Paket &amp; benefit diambil dari tab <strong>Ruang Coin</strong>.</p>
          </div>
        </div>

        {/* Fitur */}
        <div className={`lpb-acc${isOpen('features') ? ' open' : ''}`}>
          <button className="lpb-acc-trigger" onClick={() => toggle('features')}>
            <span>✨ Fitur</span><span className="lpb-chevron">{isOpen('features') ? '▴' : '▾'}</span>
          </button>
          <div className="lpb-acc-body">
            <label>Judul bagian<input value={c.featuresTitle} onChange={(e) => set({ featuresTitle: e.target.value })} /></label>
            {c.features.map((f, i) => (
              <div className="lpb-sub-item" key={f.id}>
                <div className="lpb-sub-head">
                  <strong>Fitur {i + 1}</strong>
                  <button type="button" className="admin-mini-btn ghost" onClick={() => set({ features: c.features.filter((x) => x.id !== f.id) })}>Hapus</button>
                </div>
                <LandingImageInput value={f.image} onChange={(url) => set({ features: c.features.map((x) => x.id === f.id ? { ...x, image: url } : x) })} />
                <label>Label kecil<input value={f.eyebrow} onChange={(e) => set({ features: c.features.map((x) => x.id === f.id ? { ...x, eyebrow: e.target.value } : x) })} /></label>
                <label>Judul<input value={f.title} onChange={(e) => set({ features: c.features.map((x) => x.id === f.id ? { ...x, title: e.target.value } : x) })} /></label>
                <label>Deskripsi<textarea rows={2} value={f.desc} onChange={(e) => set({ features: c.features.map((x) => x.id === f.id ? { ...x, desc: e.target.value } : x) })} /></label>
                <label>Teks tombol<input value={f.ctaLabel} onChange={(e) => set({ features: c.features.map((x) => x.id === f.id ? { ...x, ctaLabel: e.target.value } : x) })} /></label>
                <label>Posisi gambar
                  <select value={f.imageSide} onChange={(e) => set({ features: c.features.map((x) => x.id === f.id ? { ...x, imageSide: e.target.value as 'left' | 'right' } : x) })}>
                    <option value="right">Kanan</option>
                    <option value="left">Kiri</option>
                  </select>
                </label>
              </div>
            ))}
            <button type="button" className="admin-mini-btn" onClick={() => set({ features: [...c.features, { id: `f${Date.now()}`, eyebrow: 'Label', title: 'Judul fitur', desc: 'Deskripsi fitur', ctaLabel: 'Pelajari', image: '', imageSide: 'right' }] })}>+ Tambah Fitur</button>
          </div>
        </div>

        {/* FAQ */}
        <div className={`lpb-acc${isOpen('faq') ? ' open' : ''}`}>
          <button className="lpb-acc-trigger" onClick={() => toggle('faq')}>
            <span>❓ FAQ</span><span className="lpb-chevron">{isOpen('faq') ? '▴' : '▾'}</span>
          </button>
          <div className="lpb-acc-body">
            <label>Judul bagian<input value={c.faqTitle} onChange={(e) => set({ faqTitle: e.target.value })} /></label>
            {c.faqs.map((q, i) => (
              <div className="lpb-sub-item" key={q.id}>
                <div className="lpb-sub-head">
                  <strong>FAQ {i + 1}</strong>
                  <button type="button" className="admin-mini-btn ghost" onClick={() => set({ faqs: c.faqs.filter((x) => x.id !== q.id) })}>Hapus</button>
                </div>
                <label>Pertanyaan<input value={q.q} onChange={(e) => set({ faqs: c.faqs.map((x) => x.id === q.id ? { ...x, q: e.target.value } : x) })} /></label>
                <label>Jawaban<textarea rows={2} value={q.a} onChange={(e) => set({ faqs: c.faqs.map((x) => x.id === q.id ? { ...x, a: e.target.value } : x) })} /></label>
              </div>
            ))}
            <button type="button" className="admin-mini-btn" onClick={() => set({ faqs: [...c.faqs, { id: `q${Date.now()}`, q: 'Pertanyaan baru?', a: 'Jawaban.' }] })}>+ Tambah FAQ</button>
          </div>
        </div>

        {/* Penutup & Footer */}
        <div className={`lpb-acc${isOpen('footer') ? ' open' : ''}`}>
          <button className="lpb-acc-trigger" onClick={() => toggle('footer')}>
            <span>📌 Penutup &amp; Footer</span><span className="lpb-chevron">{isOpen('footer') ? '▴' : '▾'}</span>
          </button>
          <div className="lpb-acc-body">
            <label>Judul ajakan akhir<input value={c.finalTitle} onChange={(e) => set({ finalTitle: e.target.value })} /></label>
            <label>Deskripsi ajakan<textarea rows={2} value={c.finalSubtitle} onChange={(e) => set({ finalSubtitle: e.target.value })} /></label>
            <label>Teks tombol akhir<input value={c.finalCtaLabel} onChange={(e) => set({ finalCtaLabel: e.target.value })} /></label>
            <label>Teks footer<input value={c.footerText} onChange={(e) => set({ footerText: e.target.value })} /></label>
            <label>Link Instagram<input value={c.instagramUrl} onChange={(e) => set({ instagramUrl: e.target.value })} /></label>
          </div>
        </div>

      </aside>
    </div>
  );
}

// Halaman landing khusus (SEO) untuk pengunjung yang belum login, termasuk
// crawler Google. Tombol "Masuk" mengarahkan ke halaman login (#login).
// User yang sudah login tidak pernah melihat halaman ini.
function LandingPage({ content, onMasuk, onPickPackage }: { content: LandingContent; onMasuk: () => void; onPickPackage: (pkgId: string) => void }) {
  const [packages, setPackages] = useState<CreditPackage[]>(defaultCreditPackages);
  useEffect(() => { void loadAdminSettings().then((s) => setPackages(s.packages)); }, []);
  return (
    <div className="landing">
      <nav className="landing-nav">
        <img src={logo1} alt="Ruang Sosmed ID" className="landing-nav-logo" />
        <div className="landing-nav-actions">
          <button type="button" className="landing-login-link" onClick={onMasuk}>Masuk</button>
          <button type="button" className="landing-cta small" onClick={() => { sessionStorage.setItem('landing_register', '1'); window.location.hash = '#login'; }}>Daftar</button>
        </div>
      </nav>

      {/* Hero */}
      <header className="landing-hero">
        <h1 className="landing-title">{content.heroTitle}</h1>
        <p className="landing-sub">{content.heroSubtitle}</p>
        <button type="button" className="landing-cta landing-cta-hero" onClick={onMasuk}>{content.heroCtaLabel} ↗</button>
      </header>

      <main className="landing-main">
        {/* Pain points */}
        <section className="landing-block landing-pain-section" id="cara-kerja">
          {content.painEyebrow && <p className="landing-pain-eyebrow">{content.painEyebrow}</p>}
          <h2 className="landing-h2 center">{content.howTitle}</h2>
          <div className="landing-pain-grid">
            {content.steps.map((s, i) => (
              <article className={`landing-pain-card${i === 1 ? ' featured' : ''}`} key={s.id}>
                <span className="landing-pain-icon">{s.label}</span>
                <h3 className="landing-pain-title">{s.title}</h3>
                <p className="landing-pain-desc">{s.desc}</p>
              </article>
            ))}
          </div>
        </section>

        {/* Feature split sections */}
        <section className="landing-block" id="fitur">
          <h2 className="landing-h2 center">{content.featuresTitle}</h2>
          {content.features.map((f) => (
            <div className={`landing-feature ${f.imageSide === 'left' ? 'media-left' : 'media-right'}`} key={f.id}>
              <div className="landing-feature-text">
                {f.eyebrow && <span className="landing-pill">{f.eyebrow}</span>}
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
                {f.ctaLabel && <button type="button" className="landing-cta small" onClick={onMasuk}>{f.ctaLabel} →</button>}
              </div>
              <div className="landing-feature-media">
                {f.image ? <img src={f.image} alt={f.title} /> : <div className="landing-media-empty tall" />}
              </div>
            </div>
          ))}
        </section>

        {/* Pricing */}
        {content.showPricing && packages.length > 0 && (
          <section className="landing-block" id="pricing">
            <h2 className="landing-h2 center">{content.pricingTitle}</h2>
            {content.pricingSubtitle && <p className="landing-pricing-sub">{content.pricingSubtitle}</p>}
            <div className="landing-pricing-grid">
              {packages.map((p, i) => (
                <article className={`landing-price-card${i === 1 ? ' featured' : ''}`} key={p.id}>
                  {i === 1 && <span className="landing-price-badge">Populer</span>}
                  <h3 className="landing-price-name">{p.label}</h3>
                  <div className="landing-price-coins">{p.credits.toLocaleString('id-ID')} <span>Ruang Coin</span></div>
                  <div className="landing-price-amount">{formatRupiah(p.price)}</div>
                  {p.features && p.features.length > 0 && (
                    <ul className="landing-price-features">
                      {p.features.map((f, fi) => <li key={fi}>{f}</li>)}
                    </ul>
                  )}
                  <button type="button" className="landing-cta" onClick={() => onPickPackage(p.id)}>Ambil paket ini →</button>
                </article>
              ))}
            </div>
          </section>
        )}

        {/* FAQ */}
        {content.faqs.length > 0 && (
          <section className="landing-faq" id="faq">
            <h2 className="landing-h2 center">{content.faqTitle}</h2>
            {content.faqs.map((q) => (
              <details key={q.id}><summary>{q.q}</summary><p>{q.a}</p></details>
            ))}
          </section>
        )}

        {/* Final CTA */}
        <section className="landing-final">
          <h2>{content.finalTitle}</h2>
          <p>{content.finalSubtitle}</p>
          <button type="button" className="landing-cta" onClick={onMasuk}>{content.finalCtaLabel} ↗</button>
        </section>
      </main>

      <footer className="landing-footer">
        <span>© {new Date().getFullYear()} {content.footerText}</span>
        {content.instagramUrl && <a href={content.instagramUrl} target="_blank" rel="noreferrer">Instagram</a>}
      </footer>
    </div>
  );
}

// Notif "versi baru tersedia": polling version.json yang dihasilkan tiap build.
// Saat deploy ke Cloudflare selesai, buildId di server berubah; semua klien yang
// masih membuka versi lama akan otomatis melihat notif ini (cek tiap 60 detik +
// saat tab kembali fokus) tanpa perlu push manual.
function UpdateToast() {
  const [updateReady, setUpdateReady] = useState(false);
  const initialBuildId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const res = await fetch(`/version.json?ts=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { buildId?: string };
        if (cancelled || !data.buildId) return;
        // buildId pertama = versi yang sedang berjalan. Jika berubah saat polling,
        // berarti ada deploy baru → tampilkan notif.
        if (initialBuildId.current === null) {
          initialBuildId.current = data.buildId;
        } else if (data.buildId !== initialBuildId.current) {
          setUpdateReady(true);
        }
      } catch {
        // offline / file belum ada (mis. dev) — abaikan
      }
    };

    void check();
    const interval = window.setInterval(() => void check(), 60_000);
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const handleRefresh = async () => {
    // Buang cache yang mungkin menyimpan HTML/aset lama agar reload benar-benar
    // memuat versi terbaru, bukan dari cache browser / service worker.
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      if (navigator.serviceWorker) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
    } catch {
      // abaikan — tetap lanjut reload
    }
    // Cache-bust dokumen HTML lalu reload paksa (hash dipertahankan).
    const url = new URL(window.location.href);
    url.searchParams.set('_v', Date.now().toString());
    window.location.replace(url.toString());
  };

  if (!updateReady) return null;

  return createPortal(
    <div className="update-toast" role="status" aria-live="polite">
      <span className="update-toast-icon">
        <svg width="36" height="36" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="18" cy="18" r="18" fill="#FF1744"/>
          <path d="M25.5 18C25.5 22.1421 22.1421 25.5 18 25.5C13.8579 25.5 10.5 22.1421 10.5 18C10.5 13.8579 13.8579 10.5 18 10.5C20.3386 10.5 22.4386 11.5114 23.8995 13.1317" stroke="white" strokeWidth="2.2" strokeLinecap="round"/>
          <polyline points="24,10 24,13.5 20.5,13.5" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M10.5 18C10.5 13.8579 13.8579 10.5 18 10.5C20.3386 10.5 22.4386 11.5114 23.8995 13.1317" stroke="white" strokeWidth="2.2" strokeLinecap="round" opacity="0"/>
        </svg>
      </span>
      <div className="update-toast-text">
        <strong>Versi baru tersedia</strong>
        <span>Refresh untuk memuat pembaruan terbaru.</span>
      </div>
      <button type="button" className="update-toast-btn" onClick={() => void handleRefresh()}>
        Refresh
      </button>
      <button type="button" className="update-toast-close" aria-label="tutup" onClick={() => setUpdateReady(false)}>
        ×
      </button>
    </div>,
    document.body,
  );
}

function DashboardSection({ session }: { session: AppSession }) {
  const today = todayDateString();

  // ── banner ──
  const [bannerSettings, setBannerSettings] = useState<BannerSettings>(defaultBannerSettings);
  useEffect(() => { void loadBannerSettings().then(setBannerSettings); }, []);

  // ── profile name ──
  const [profileName, setProfileName] = useState('');

  // ── learning progress ──
  const [totalLessons, setTotalLessons] = useState(0);
  const [completedCount, setCompletedCount] = useState(0);
  const [nextLesson, setNextLesson] = useState<{ id: string; title: string } | null>(null);

  // ── streak ──
  const [streak, setStreak] = useState(0);

  // ── profile avatar ──
  const [profileAvatarUrl, setProfileAvatarUrl] = useState<string | null>(null);

  // ── mini calendar month ──
  const [miniCalDate, setMiniCalDate] = useState(() => new Date());

  // ── upcoming events (2 weeks) ──
  const [upcomingEvents, setUpcomingEvents] = useState<CalendarEvent[]>([]);

  // ── recent threads ──
  const [recentThreads, setRecentThreads] = useState<ForumThread[]>([]);

  // ── recent assets ──
  const [recentAssets, setRecentAssets] = useState<SharedAsset[]>([]);

  // ── subscription ──
  const [subscription, setSubscription] = useState<UserSubscriptionRow | null>(null);

  // ── credits ──
  const [credits, setCredits] = useState<number | null>(null);

  // ── user perks (for asset unlock check) ──
  const [dashPerks, setDashPerks] = useState<UserPerks>({});
  const [dashUnlockedIds, setDashUnlockedIds] = useState<Set<string>>(new Set());

  // ── realtime new reply badge ──
  const [newReplyCount, setNewReplyCount] = useState(0);

  // ── own badge tier ──
  const ownBadge = useBadgeTier(session.username);

  const [isLoading, setIsLoading] = useState(true);

  // ── joined class events (calendar) ──
  const eventJoinedKey = (id: string) => `event_joined_${session.username}_${id}`;
  const [joinedCalEventIds, setJoinedCalEventIds] = useState<Set<string>>(() => new Set());
  const [joiningEventId, setJoiningEventId] = useState<string | null>(null);

  const isCalEventJoined = (ev: CalendarEvent) =>
    dashPerks.credit_exempt || dashPerks.free_event || joinedCalEventIds.has(ev.id) || !!localStorage.getItem(eventJoinedKey(ev.id));

  const handleJoinCalEvent = async (ev: CalendarEvent) => {
    if (isCalEventJoined(ev)) return;
    setJoiningEventId(ev.id);
    const cost = 5;
    const res = await deductCredits(session.username, cost, `Join kelas: ${ev.title}`, 'join_event');
    if (res.ok) {
      localStorage.setItem(eventJoinedKey(ev.id), '1');
      setJoinedCalEventIds((prev) => new Set([...prev, ev.id]));
    }
    setJoiningEventId(null);
  };

  const copyZoomLink = (ev: CalendarEvent) => {
    const url = (ev.note ?? '').match(/https?:\/\/\S+/)?.[0] ?? '';
    if (url) { void navigator.clipboard.writeText(url); }
  };

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const [
          { data: profileRow },
          { data: lessonRows },
          { data: progressRows },
          { data: eventRows },
          { data: bookingRows },
          { data: threadRows },
          { data: replyRows },
          { data: assetRows },
          { data: subRow },
          { data: creditRow },
          { data: perksRow },
          { data: assetUnlockRows },
        ] = await Promise.all([
          supabase.from('user_profiles').select('name, avatar_path').eq('username', session.username).maybeSingle(),
          supabase.from('lessons').select('lesson_key, title').order('sort_order', { ascending: true }),
          supabase.from('lesson_progress').select('lesson_key, completed_at').eq('session_username', session.username),
          supabase.from('calendar_events')
            .select('id, title, note, event_date, start_time, end_time, category, accent, attendee_count, is_done, sort_order')
            .gte('event_date', today)
            .lte('event_date', addDaysToDate(today, 14))
            .or('is_done.eq.false,is_done.is.null')
            .order('event_date', { ascending: true })
            .order('start_time', { ascending: true })
            .limit(20),
          supabase.from('one_on_one_bookings')
            .select('id, topic, preferred_date, preferred_time')
            .eq('requester_username', session.username)
            .eq('status', 'approved')
            .gte('preferred_date', today)
            .lte('preferred_date', addDaysToDate(today, 14))
            .order('preferred_date', { ascending: true }),
          supabase.from('forum_threads').select('*').order('created_at', { ascending: false }).limit(4),
          supabase.from('forum_replies').select('*').order('created_at', { ascending: true }),
          supabase.from('shared_assets').select('*').order('sort_order', { ascending: true }).limit(4),
          supabase.from('user_subscriptions').select('*').eq('username', session.username).maybeSingle(),
          supabase.from('user_credits').select('balance').eq('username', session.username).maybeSingle(),
          supabase.from('user_profiles').select('perks, referral_perks, referral_perks_expires_at').eq('username', session.username).maybeSingle(),
          supabase.from('user_asset_unlocks').select('asset_id').eq('username', session.username),
        ]);

        if (!active) return;

        const pr = profileRow as { name?: string; avatar_path?: string | null } | null;
        setProfileName(pr?.name ?? session.displayName);
        if (pr?.avatar_path) setProfileAvatarUrl(profileAvatarPublicUrl(pr.avatar_path));

        const allLessons = (lessonRows ?? []) as { lesson_key: string; title: string }[];
        const progressData = (progressRows ?? []) as { lesson_key: string; completed_at: string }[];
        const completedKeys = new Set(progressData.map((r) => r.lesson_key));

        // Hitung streak harian
        const activeDays = new Set(progressData.map((r) => r.completed_at?.slice(0, 10)).filter(Boolean));
        let streakCount = 0;
        const d = new Date();
        // cek hari ini dulu, kalau tidak ada cek kemarin (biar streak tidak langsung reset saat pagi)
        if (!activeDays.has(d.toISOString().slice(0, 10))) d.setDate(d.getDate() - 1);
        while (activeDays.has(d.toISOString().slice(0, 10))) {
          streakCount++;
          d.setDate(d.getDate() - 1);
        }
        setStreak(streakCount);
        const lessonList = allLessons.map((l) => ({ id: l.lesson_key, title: l.title }));
        const firstIncomplete = lessonList.find((l) => !completedKeys.has(l.id)) ?? null;

        // build threads with replies
        const replyMap: Record<string, ForumReply[]> = {};
        for (const r of (replyRows ?? [])) {
          const fr: ForumReply = { id: r.id, authorUsername: r.author_username, authorDisplayName: r.author_display_name, body: r.body, imageUrl: r.image_url ?? undefined, createdAt: r.created_at, upvotes: r.upvotes, parentReplyId: r.parent_reply_id ?? undefined, answered: r.answered ?? false };
          if (!replyMap[r.thread_id]) replyMap[r.thread_id] = [];
          replyMap[r.thread_id].push(fr);
        }
        const mappedThreads: ForumThread[] = (threadRows ?? []).map((t) => ({
          id: t.id, category: t.category, title: t.title, body: t.body, imageUrl: t.image_url ?? undefined,
          authorUsername: t.author_username, authorDisplayName: t.author_display_name, createdAt: t.created_at,
          viewCount: t.view_count, replies: replyMap[t.id] ?? [],
        }));

        setTotalLessons(allLessons.length);
        setCompletedCount(completedKeys.size);
        setNextLesson(firstIncomplete);
        const calItems: CalendarEvent[] = (eventRows ?? []).map(mapCalendarEventRow);
        const bookingItems: CalendarEvent[] = (bookingRows ?? []).map((b: { id: string; topic: string; preferred_date: string; preferred_time: string }) => ({
          id: `booking-${b.id}`,
          title: `📅 Sesi 1:1 — ${b.topic}`,
          note: '',
          eventDate: b.preferred_date,
          startTime: String(b.preferred_time ?? '').slice(0, 5),
          endTime: '',
          category: 'booking',
          accent: '#22c55e',
          attendeeCount: 0,
          isDone: false,
          sortOrder: 0,
        }));
        const merged = [...calItems, ...bookingItems].sort((a, b) => {
          const da = `${a.eventDate}T${a.startTime || '23:59'}`;
          const db = `${b.eventDate}T${b.startTime || '23:59'}`;
          return da.localeCompare(db);
        });
        setUpcomingEvents(merged);
        setRecentThreads(mappedThreads);
        setRecentAssets((assetRows ?? []) as SharedAsset[]);
        setSubscription((subRow ?? null) as UserSubscriptionRow | null);
        setCredits(creditRow?.balance ?? null);
        const permDash = (perksRow?.perks ?? {}) as UserPerks;
        const refDash = ((perksRow as { referral_perks?: UserPerks } | null)?.referral_perks ?? {}) as UserPerks;
        const refExpDash = (perksRow as { referral_perks_expires_at?: string } | null)?.referral_perks_expires_at;
        const refActiveDash = !refExpDash || new Date(refExpDash) > new Date();
        setDashPerks({ ...permDash, ...(refActiveDash ? refDash : {}) });
        setDashUnlockedIds(new Set((assetUnlockRows ?? []).map((r: { asset_id: string }) => r.asset_id)));
      } catch (err) {
        console.warn('dashboard load error', err);
      } finally {
        if (active) setIsLoading(false);
      }
    };

    void load();

    // realtime: new replies → cukup naikkan badge (tidak refetch thread demi hemat egress)
    const channel = supabase.channel('dashboard-replies')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'forum_replies' }, () => {
        setNewReplyCount((n) => n + 1);
      })
      .subscribe();

    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [session.username]);

  const progress = totalLessons === 0 ? 0 : Math.round((completedCount / totalLessons) * 100);
  const subDue = subscription?.due_at ? formatShortDate(subscription.due_at) : '—';
  const subStatus = subscription?.status ?? '—';
  const isSubActive = subStatus === 'aktif';

  const categoryColor: Record<string, string> = {
    class: '#7a4fd6', review: '#a78bfa', qna: '#34d399', reminder: '#f59e0b', booking: '#22c55e',
  };
  const categoryLabel: Record<string, string> = {
    class: 'E-Learning', review: 'Review', qna: 'QnA', reminder: 'Reminder', booking: 'Sesi 1:1',
  };

  const typeIcon: Record<string, string> = {
    pdf: '📄', sheet: '📊', zip: '📦', video: '🎬', doc: '📝', link: '🔗', lainnya: '📎',
  };

  // greeting
  const hour = new Date().getHours();
  const greeting = hour < 11 ? 'Selamat pagi' : hour < 15 ? 'Selamat siang' : hour < 18 ? 'Selamat sore' : 'Selamat malam';

  // progress ring
  const r = 30;
  const circ = 2 * Math.PI * r;
  const dash = circ * (1 - progress / 100);

  if (isLoading) {
    return (
      <section className="db-loading">
        <div className="db-loading-spinner" />
        <p>Memuat dashboard…</p>
      </section>
    );
  }

  return (
    <div className="db-root">

      {/* ── Promotional Banner ──────────────────────────── */}
      <DashboardBanner settings={bannerSettings} />

      <div className="db-layout">
      {/* ── LEFT: hero + cards ──────────────────────────── */}
      <div className="db-main">
      <section className="db-hero card">
        <div className="db-hero-left">
          <p className="eyebrow">{greeting}</p>
          <h2 className="db-hero-name"><BadgeIcon tier={ownBadge} size={22} />{profileName || session.displayName} 👋</h2>
          <p className="db-hero-sub">
            {completedCount === 0
              ? 'Mulai perjalanan belajarmu sekarang.'
              : completedCount === totalLessons && totalLessons > 0
                ? 'Semua materi sudah kamu selesaikan. Luar biasa!'
                : `Kamu sudah menyelesaikan ${completedCount} dari ${totalLessons} materi.`}
          </p>
          <div className="db-hero-actions">
            <a className="button primary" href="#materi">
              {nextLesson ? 'Lanjutkan Belajar' : 'Buka Materi'}
            </a>
            <a className="button secondary" href="#community">
              QnA Session
              {newReplyCount > 0 && <span className="db-reply-badge">{newReplyCount}</span>}
            </a>
          </div>
        </div>
        {/* ── Stats panel ── */}
        <div className="db-stats-panel">
          {/* progress ring + label */}
          <a className="db-stats-ring-block" href="#materi" style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="db-progress-ring-wrap">
              <svg className="db-progress-ring" viewBox="0 0 80 80">
                <defs>
                  <linearGradient id="dbRingGrad" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#9a6cf0" />
                    <stop offset="100%" stopColor="#6f3fd0" />
                  </linearGradient>
                </defs>
                <circle cx="40" cy="40" r={r} strokeWidth="8" className="db-ring-track" />
                <circle
                  cx="40" cy="40" r={r} strokeWidth="8"
                  className="db-ring-fill"
                  strokeDasharray={`${circ}`}
                  strokeDashoffset={`${dash}`}
                  strokeLinecap="round"
                  transform="rotate(-90 40 40)"
                />
              </svg>
              <div className="db-ring-label">
                <strong>{progress}%</strong>
                <span>{completedCount}/{totalLessons}</span>
              </div>
            </div>
            <div className="db-stats-ring-caption">
              <strong>{completedCount} dari {totalLessons} materi</strong>
              <span>sudah diselesaikan</span>
            </div>
          </a>

          <div className="db-stats-divider" />

          {/* Streak */}
          {streak > 0 && (
            <div className="db-streak-block">
              <span className="db-streak-fire">🔥</span>
              <div className="db-streak-text">
                <strong>{streak} hari</strong>
                <span>streak belajar</span>
              </div>
            </div>
          )}

          <div className="db-stats-divider" />

          {/* chips */}
          <div className="db-stat-chips">
            <a className="db-stat-chip chip-coin" href="#profil">
              <span className="db-chip-icon">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
              </span>
              <div className="db-chip-text">
                <span>Ruang Coin</span>
                <strong>{credits !== null ? credits.toLocaleString('id-ID') : '—'}</strong>
              </div>
            </a>
            <a className={`db-stat-chip ${isSubActive ? 'chip-active' : ''}`} href="#profil">
              <span className="db-chip-icon">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              </span>
              <div className="db-chip-text">
                <span>Langganan</span>
                <strong>{isSubActive ? 'Aktif' : subStatus}</strong>
                {isSubActive && <em>s/d {subDue}</em>}
              </div>
            </a>
          </div>
        </div>
      </section>

      {/* ── Main grid ────────────────────────────────────── */}
      <div className="db-grid">

        {/* ── Next lesson ── */}
        <article className="db-card db-card-accent">
          <div className="db-card-head">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            <p className="eyebrow">Lanjutkan Materi</p>
          </div>
          {nextLesson ? (
            <>
              <strong className="db-card-title">{nextLesson.title}</strong>
              <p className="db-card-sub">Materi berikutnya yang belum diselesaikan</p>
              <a className="button primary tiny db-card-cta" href="#materi">Mulai sekarang →</a>
            </>
          ) : totalLessons === 0 ? (
            <p className="db-card-sub">Belum ada materi yang tersedia.</p>
          ) : (
            <>
              <strong className="db-card-title">Semua materi selesai!</strong>
              <p className="db-card-sub">Kamu telah menyelesaikan seluruh kurikulum.</p>
              <a className="button secondary tiny db-card-cta" href="#materi">Lihat semua →</a>
            </>
          )}
          {totalLessons > 0 && (
            <div className="db-mini-progress">
              <div className="db-mini-bar"><span style={{ width: `${progress}%` }} /></div>
              <span>{progress}%</span>
            </div>
          )}
        </article>

        {/* ── Upcoming events ── */}
        <article className="db-card">
          <div className="db-card-head">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            <p className="eyebrow">Jadwal Mendatang</p>
            <a className="mini-link" href="#calendar">lihat semua</a>
          </div>
          {upcomingEvents.length === 0 && !nextLesson ? (
            <p className="db-empty">Tidak ada jadwal mendatang.</p>
          ) : (
            <div className="db-event-list">
              {nextLesson && (
                <a className="db-event-row" href="#materi" style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div className="db-event-dot" style={{ background: '#7a4fd6' }} />
                  <div className="db-event-info">
                    <strong>{nextLesson.title}</strong>
                    <span>Lanjutkan sekarang</span>
                    <span className="db-event-cat" style={{ color: '#7a4fd6' }}>E-Learning</span>
                  </div>
                </a>
              )}
              {upcomingEvents.map((ev) => {
                const isClass = ev.category === 'class';
                const joined = isClass && isCalEventJoined(ev);
                const hasZoom = isClass && !!(ev.note ?? '').match(/https?:\/\/\S+/);
                return (
                  <div className="db-event-row" key={ev.id}>
                    <div className="db-event-dot" style={{ background: categoryColor[ev.category] ?? '#7a4fd6' }} />
                    <div className="db-event-info">
                      <strong>{ev.title}</strong>
                      <span>{ev.eventDate ? `${formatShortDate(ev.eventDate)} · ${formatClockRange(ev.startTime, ev.endTime)}` : ''}</span>
                      <span className="db-event-cat">{categoryLabel[ev.category] ?? ev.category}</span>
                    </div>
                    {isClass && (
                      joined && hasZoom ? (
                        <button className="db-event-btn db-event-btn--zoom" onClick={() => copyZoomLink(ev)}>
                          📋 Copy Link Zoom
                        </button>
                      ) : !joined ? (
                        <button
                          className="db-event-btn db-event-btn--join"
                          disabled={joiningEventId === ev.id}
                          onClick={() => void handleJoinCalEvent(ev)}
                        >
                          {joiningEventId === ev.id ? '...' : 'Ikut Kelas Ini'}
                        </button>
                      ) : null
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </article>

        {/* ── Recent QnA ── */}
        <article className="db-card">
          <div className="db-card-head">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            <p className="eyebrow">
              Diskusi Terbaru
              {newReplyCount > 0 && <span className="db-live-dot" title="ada balasan baru" />}
            </p>
            <a className="mini-link" href="#community">lihat semua</a>
          </div>
          {(() => {
            const activeQna = recentThreads.find((t) => t.category === 'qna session');
            return activeQna ? (
              <a className="db-qna-card" href={`?thread=${activeQna.id}#community`}>
                <div className="db-qna-card-top">
                  <span className="db-qna-badge">🎙️ QNA Session Aktif</span>
                  <span className="db-qna-count">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                    {activeQna.replies.length} pertanyaan terkumpul
                  </span>
                </div>
                <strong className="db-qna-title">{activeQna.title}</strong>
                <span className="db-qna-cta">
                  Tanya Sekarang
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                </span>
              </a>
            ) : null;
          })()}
          {recentThreads.length === 0 ? (
            <p className="db-empty">Belum ada diskusi.</p>
          ) : (
            <div className="db-thread-list">
              {recentThreads.filter((t) => t.category !== 'qna session').map((t) => (
                <a className="db-thread-row" key={t.id} href={`?thread=${t.id}#community`}>
                  <div className="db-thread-meta">
                    <span className="tag">{t.category}</span>
                    <span className="db-thread-time">{timeAgo(t.createdAt)}</span>
                  </div>
                  <strong className="db-thread-title">{t.title}</strong>
                  <span className="db-thread-replies">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                    {t.replies.length} balasan
                  </span>
                </a>
              ))}
              {recentThreads.filter((t) => t.category !== 'qna session').length === 0 && (
                <p className="db-empty">Belum ada diskusi lainnya.</p>
              )}
            </div>
          )}
        </article>

        {/* ── Recent assets ── */}
        <article className="db-card">
          <div className="db-card-head">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            <p className="eyebrow">File &amp; Asset</p>
            <a className="mini-link" href="#assets">lihat semua</a>
          </div>
          {(() => {
            const unlockedAssets = recentAssets.filter((a) =>
              a.coin_cost === 0 || dashPerks.credit_exempt || (dashPerks.free_asset && a.feature_claimable !== false) || dashUnlockedIds.has(a.id)
            );
            return unlockedAssets.length === 0 ? (
              <p className="db-empty">Belum ada asset yang kamu miliki. <a href="#assets" style={{ color: 'var(--accent)' }}>Lihat semua asset →</a></p>
            ) : (
              <div className="db-asset-list">
                {unlockedAssets.map((a) => (
                  <a className="db-asset-row" key={a.id} href={a.url} target="_blank" rel="noopener noreferrer">
                    <span className="db-asset-thumb">
                      {a.thumbnail_url
                        ? <img src={a.thumbnail_url} alt={a.title} className="db-asset-thumb-img" />
                        : <span className="db-asset-thumb-fallback">{typeIcon[a.type] ?? '📄'}</span>
                      }
                    </span>
                    <div className="db-asset-info">
                      <strong>{a.title}</strong>
                      <span>{a.category}</span>
                    </div>
                    <svg className="db-asset-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  </a>
                ))}
              </div>
            );
          })()}
        </article>

      </div>{/* end db-grid */}
      </div>{/* end db-main */}

      {/* ── RIGHT: profile sidebar ──────────────────────── */}
      <aside className="db-sidebar">
        {(() => {
          const year = miniCalDate.getFullYear();
          const month = miniCalDate.getMonth();
          const firstDay = new Date(year, month, 1).getDay();
          const daysInMonth = new Date(year, month + 1, 0).getDate();
          const startOffset = (firstDay + 6) % 7;
          const eventDates = new Set(upcomingEvents.map((e) => e.eventDate));
          const todayStr = toLocalDateKey(new Date());
          const cells: (number | null)[] = [...Array(startOffset).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
          const monthLabel = miniCalDate.toLocaleString('id-ID', { month: 'long', year: 'numeric' });
          const dayNames = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
          const reminderItems = [
            ...(nextLesson ? [{ label: nextLesson.title, sub: 'Lanjutkan E-Learning', color: '#7a4fd6', href: '#materi' }] : []),
            ...upcomingEvents.slice(0, 4).map((ev) => ({
              label: ev.title,
              sub: ev.eventDate ? `${formatShortDate(ev.eventDate)}${ev.startTime ? `, ${ev.startTime.slice(0, 5)}` : ''}` : '',
              color: categoryColor[ev.category] ?? '#7a4fd6',
              href: ev.category === 'booking' ? '#calendar' : ev.category === 'class' ? '#events' : '#calendar',
            })),
          ].slice(0, 5);
          const fallbackAvatar = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><circle cx="40" cy="40" r="40" fill="#ede9fe"/><text x="40" y="52" text-anchor="middle" font-size="32" font-family="sans-serif" fill="#7a4fd6">${(profileName || session.displayName).charAt(0).toUpperCase()}</text></svg>`)}`;
          return (
            <div className="db-profile-card card">
              <div className="db-pc-avatar-wrap">
                <img className="db-pc-avatar" src={profileAvatarUrl ?? fallbackAvatar} alt={profileName} />
              </div>
              <div className="db-pc-name-row">
                <strong className="db-pc-name">{profileName || session.displayName}</strong>
                <BadgeIcon tier={ownBadge} size={20} />
              </div>
              <span className="db-pc-role">Student</span>
              <a className="button secondary tiny db-pc-btn" href="#profil">Profile</a>

              <div className="db-pc-cal">
                <div className="db-pc-cal-head">
                  <button className="db-pc-cal-nav" onClick={() => setMiniCalDate(new Date(year, month - 1, 1))}>‹</button>
                  <span>{monthLabel}</span>
                  <button className="db-pc-cal-nav" onClick={() => setMiniCalDate(new Date(year, month + 1, 1))}>›</button>
                </div>
                <div className="db-pc-cal-grid">
                  {dayNames.map((d) => <span key={d} className="db-pc-cal-dayname">{d}</span>)}
                  {cells.map((day, i) => {
                    if (!day) return <span key={`e-${i}`} />;
                    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                    const isToday = dateStr === todayStr;
                    const hasEvent = eventDates.has(dateStr);
                    return (
                      <span key={dateStr} className={`db-pc-cal-day${isToday ? ' db-pc-cal-today' : ''}${hasEvent ? ' db-pc-cal-has-event' : ''}`}>
                        {day}
                      </span>
                    );
                  })}
                </div>
              </div>

              {reminderItems.length > 0 && (
                <div className="db-pc-reminders">
                  <p className="db-pc-rem-title">Jadwal</p>
                  {reminderItems.map((item, i) => (
                    <a key={i} className="db-pc-rem-row" href={item.href}>
                      <span className="db-pc-rem-icon" style={{ background: `${item.color}20`, color: item.color }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                      </span>
                      <div className="db-pc-rem-info">
                        <strong>{item.label}</strong>
                        <span>{item.sub}</span>
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </div>
          );
        })()}
      </aside>
      </div>{/* end db-layout */}
    </div>
  );
}

type CourseCard = {
  key: string;
  title: string;
  subtitle: string;
  description: string;
  level: string;
  thumbnail_url: string | null;
  lesson_count: number;
  sort_order: number;
  status: 'open' | 'coming_soon';
};

// ── MyFilePage ────────────────────────────────────────────────

function MyFilePage({ session }: { session: AppSession }) {
  const username = session.username;
  const displayName = session.displayName ?? username;

  type CourseRow = { key: string; title: string; thumbnail_url: string | null };
  type AssetRow = { id: string; title: string; category: string; thumbnail_url: string | null; url: string; type: string };

  const [courses, setCourses] = useState<CourseRow[]>([]);
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [certTemplates, setCertTemplates] = useState<Record<string, CertificateTemplate>>({});
  const [loading, setLoading] = useState(true);
  const [showCertPreview, setShowCertPreview] = useState(false);
  const [activeCertKey, setActiveCertKey] = useState<string | null>(null);
  const [activeCertTitle, setActiveCertTitle] = useState('');
  const [activeTab, setActiveTab] = useState<'certificates' | 'assets'>('certificates');

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const [{ data: courseData }, { data: assetData }, { data: unlockRows }] = await Promise.all([
        supabase.from('courses').select('key, title, thumbnail_url').order('sort_order', { ascending: true }),
        supabase.from('shared_assets').select('id, title, category, thumbnail_url, url, type').order('sort_order', { ascending: true }),
        supabase.from('user_asset_unlocks').select('asset_id').eq('username', username),
      ]);

      const allCourses = (courseData ?? []) as CourseRow[];
      const allAssets = (assetData ?? []) as AssetRow[];
      const unlockedSet = new Set((unlockRows ?? []).map((r: { asset_id: string }) => r.asset_id));

      // Filter courses where user passed the assessment AND module is complete
      const releaseSettingsAll = await loadCourseReleaseSettings();
      const passedCourses = allCourses.filter((c) =>
        localStorage.getItem(`cert_passed_${username}_${c.key}`) === '1' &&
        (releaseSettingsAll[c.key]?.moduleComplete ?? false)
      );

      // Filter assets user has unlocked (DB-based)
      const unlockedAssets = allAssets.filter((a) => unlockedSet.has(a.id));

      setCourses(passedCourses);
      setAssets(unlockedAssets);

      // Load cert templates for passed courses
      if (passedCourses.length > 0) {
        const templates: Record<string, CertificateTemplate> = {};
        await Promise.all(passedCourses.map(async (c) => {
          templates[c.key] = await loadCertTemplate(c.key);
        }));
        setCertTemplates(templates);
      }

      setLoading(false);
    };
    void load();
  }, [username]);

  const handleOpenCert = (courseKey: string, courseTitle: string) => {
    setActiveCertKey(courseKey);
    setActiveCertTitle(courseTitle);
    setShowCertPreview(true);
  };

  if (loading) {
    return (
      <div className="myfile-page">
        <div className="forum-loading">Memuat file kamu…</div>
      </div>
    );
  }

  return (
    <div className="myfile-page">
      <div className="myfile-header">
        <h2 className="myfile-title">My File</h2>
        <p className="myfile-subtitle">Semua sertifikat dan asset yang sudah kamu dapatkan.</p>
      </div>

      <div className="myfile-tabs">
        <button
          type="button"
          className={`myfile-tab ${activeTab === 'certificates' ? 'active' : ''}`}
          onClick={() => setActiveTab('certificates')}
        >
          🎓 Sertifikat
          {courses.length > 0 && <span className="myfile-tab-badge">{courses.length}</span>}
        </button>
        <button
          type="button"
          className={`myfile-tab ${activeTab === 'assets' ? 'active' : ''}`}
          onClick={() => setActiveTab('assets')}
        >
          📁 Asset
          {assets.length > 0 && <span className="myfile-tab-badge">{assets.length}</span>}
        </button>
      </div>

      {activeTab === 'certificates' && (
        <div className="myfile-section">
          {courses.length === 0 ? (
            <div className="myfile-empty">
              <span className="myfile-empty-icon">🎓</span>
              <p>Belum ada sertifikat. Selesaikan kelas dan lulus Final Assessment untuk mendapatkan sertifikat.</p>
              <a href="#materi" className="button primary" style={{ marginTop: 16, display: 'inline-block' }}>Mulai Belajar</a>
            </div>
          ) : (
            <div className="myfile-grid">
              {courses.map((c) => (
                <div key={c.key} className="myfile-cert-card">
                  {c.thumbnail_url
                    ? <img src={c.thumbnail_url} alt={c.title} className="myfile-cert-thumb" />
                    : <div className="myfile-cert-thumb myfile-cert-thumb-empty">📚</div>
                  }
                  <div className="myfile-cert-info">
                    <span className="myfile-cert-badge">✓ Lulus</span>
                    <h3 className="myfile-cert-name">{c.title}</h3>
                    <button
                      type="button"
                      className="cert-download-btn"
                      onClick={() => handleOpenCert(c.key, c.title)}
                    >
                      ↓ Download Sertifikat
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'assets' && (
        <div className="myfile-section">
          {assets.length === 0 ? (
            <div className="myfile-empty">
              <span className="myfile-empty-icon">📁</span>
              <p>Belum ada asset yang dibeli. Kunjungi halaman Assets untuk melihat koleksi yang tersedia.</p>
              <a href="#assets" className="button primary" style={{ marginTop: 16, display: 'inline-block' }}>Lihat Assets</a>
            </div>
          ) : (
            <div className="myfile-asset-gallery">
              {assets.map((a) => (
                <div key={a.id} className="myfile-asset-gallery-card">
                  <a href={a.url} target="_blank" rel="noopener noreferrer" className="myfile-asset-gallery-thumb">
                    {a.thumbnail_url
                      ? <img src={a.thumbnail_url} alt={a.title} className="myfile-asset-gallery-img" />
                      : <div className="myfile-asset-gallery-placeholder">📄</div>
                    }
                  </a>
                  <div className="myfile-asset-gallery-info">
                    <span className="myfile-asset-category">{a.category.toUpperCase()}</span>
                    <p className="myfile-asset-gallery-name">{a.title}</p>
                    <a href={a.url} target="_blank" rel="noopener noreferrer" className="myfile-asset-gallery-btn">
                      Buka / Download ↗
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {showCertPreview && activeCertKey && certTemplates[activeCertKey] && (
        <CertPreviewModal
          displayName={displayName}
          courseTitle={activeCertTitle}
          template={certTemplates[activeCertKey]}
          onClose={() => { setShowCertPreview(false); setActiveCertKey(null); }}
        />
      )}
    </div>
  );
}

// ── Course Release Settings ────────────────────────────────────────────────────
type CourseReleaseSettings = { releaseDays: string[]; lastLessonUploadedAt?: string; moduleComplete?: boolean };
type AllCourseReleaseSettings = Record<string, CourseReleaseSettings>;
// ── App Theme ────────────────────────────────────────────────
type AppTheme = {
  id: string;
  name: string;
  accent: string;
  accentRgb: string;
  accentLightRgb: string;
  accentSoft: string;
  bg: string;
  bgStrong: string;
};

const APP_THEMES: AppTheme[] = [
  { id: 'purple', name: 'Ungu (Default)', accent: '#7a4fd6', accentRgb: '122, 79, 214', accentLightRgb: '187, 157, 255', accentSoft: '#ece1ff', bg: '#f6f1ff', bgStrong: '#efe2ff' },
  { id: 'blue', name: 'Biru', accent: '#2563eb', accentRgb: '37, 99, 235', accentLightRgb: '147, 183, 255', accentSoft: '#dbeafe', bg: '#eff6ff', bgStrong: '#dbeafe' },
  { id: 'teal', name: 'Teal', accent: '#0891b2', accentRgb: '8, 145, 178', accentLightRgb: '103, 210, 232', accentSoft: '#cffafe', bg: '#f0fdff', bgStrong: '#cffafe' },
  { id: 'green', name: 'Hijau', accent: '#059669', accentRgb: '5, 150, 105', accentLightRgb: '110, 205, 172', accentSoft: '#d1fae5', bg: '#ecfdf5', bgStrong: '#d1fae5' },
  { id: 'rose', name: 'Rose', accent: '#e11d48', accentRgb: '225, 29, 72', accentLightRgb: '255, 147, 167', accentSoft: '#ffe4e6', bg: '#fff1f2', bgStrong: '#ffe4e6' },
  { id: 'orange', name: 'Orange', accent: '#ea580c', accentRgb: '234, 88, 12', accentLightRgb: '255, 178, 128', accentSoft: '#ffedd5', bg: '#fff7ed', bgStrong: '#ffedd5' },
  { id: 'indigo', name: 'Indigo', accent: '#4338ca', accentRgb: '67, 56, 202', accentLightRgb: '165, 168, 255', accentSoft: '#e0e7ff', bg: '#eef2ff', bgStrong: '#e0e7ff' },
  // ── Palette 01 ──
  { id: 'lavender', name: 'Lavender Blue', accent: '#88A2FF', accentRgb: '136, 162, 255', accentLightRgb: '196, 210, 255', accentSoft: '#e4eaff', bg: '#f2f4ff', bgStrong: '#e0e6ff' },
  { id: 'violet-soft', name: 'Violet Soft', accent: '#AB9DFF', accentRgb: '171, 157, 255', accentLightRgb: '215, 208, 255', accentSoft: '#eceaff', bg: '#f4f2ff', bgStrong: '#e9e5ff' },
  { id: 'pink-candy', name: 'Pink Candy', accent: '#d946c4', accentRgb: '217, 70, 196', accentLightRgb: '255, 178, 247', accentSoft: '#fce8fc', bg: '#fdf0fd', bgStrong: '#fad8fa' },
  // ── Palette 11 ──
  { id: 'royal-blue', name: 'Biru Royal', accent: '#203F9A', accentRgb: '32, 63, 154', accentLightRgb: '148, 194, 218', accentSoft: '#dce8ff', bg: '#eff4ff', bgStrong: '#dce8ff' },
  { id: 'fuchsia', name: 'Fuchsia Pink', accent: '#E84797', accentRgb: '232, 71, 151', accentLightRgb: '231, 160, 204', accentSoft: '#ffd6ec', bg: '#fff0f7', bgStrong: '#ffd6ec' },
  { id: 'steel-blue', name: 'Biru Baja', accent: '#4E7CB2', accentRgb: '78, 124, 178', accentLightRgb: '148, 194, 218', accentSoft: '#ddeaf6', bg: '#f0f5fb', bgStrong: '#ddeaf6' },
];

const appThemeKey = 'app_theme';

async function loadAppTheme(): Promise<string> {
  const { data } = await supabase.from('learning_hub_content').select('content').eq('content_key', appThemeKey).maybeSingle();
  if (!data?.content) return 'purple';
  const raw = typeof data.content === 'string' ? JSON.parse(data.content) : data.content;
  return (raw?.themeId as string) ?? 'purple';
}

async function saveAppTheme(themeId: string): Promise<void> {
  await supabase.from('learning_hub_content').upsert({ content_key: appThemeKey, content_group: 'admin', content: { themeId }, updated_at: new Date().toISOString() });
}

function applyAppTheme(themeId: string): void {
  const theme = APP_THEMES.find((t) => t.id === themeId) ?? APP_THEMES[0];
  let styleEl = document.getElementById('app-theme-override') as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'app-theme-override';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = `:root {
    --accent: ${theme.accent};
    --accent-soft: ${theme.accentSoft};
    --accent-rgb: ${theme.accentRgb};
    --accent-light-rgb: ${theme.accentLightRgb};
    --bg: ${theme.bg};
    --bg-strong: ${theme.bgStrong};
  }`;
}

const courseReleaseSettingsKey = 'course_release_settings';

async function loadCourseReleaseSettings(): Promise<AllCourseReleaseSettings> {
  const { data } = await supabase.from('learning_hub_content').select('content').eq('content_key', courseReleaseSettingsKey).maybeSingle();
  if (!data?.content) return {};
  const raw = typeof data.content === 'string' ? JSON.parse(data.content) : data.content;
  return (raw ?? {}) as AllCourseReleaseSettings;
}
async function saveCourseReleaseSettings(settings: AllCourseReleaseSettings): Promise<void> {
  await supabase.from('learning_hub_content').upsert({ content_key: courseReleaseSettingsKey, content_group: 'admin', content: settings, updated_at: new Date().toISOString() });
}
async function updateLastLessonUploadedAt(courseKey: string): Promise<void> {
  const all = await loadCourseReleaseSettings();
  all[courseKey] = { ...(all[courseKey] ?? { releaseDays: [] }), lastLessonUploadedAt: new Date().toISOString() };
  await saveCourseReleaseSettings(all);
}

const DAYS_ID = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];

function getCourseBadge(courseKey: string, releaseSettings: AllCourseReleaseSettings): { type: 'new' | 'next' | 'complete'; label: string } | null {
  const settings = releaseSettings[courseKey];
  if (!settings) return null;
  const { lastLessonUploadedAt, releaseDays, moduleComplete } = settings;
  if (moduleComplete) return { type: 'complete', label: 'Modul Sudah Lengkap' };
  if (lastLessonUploadedAt) {
    const daysSince = (Date.now() - new Date(lastLessonUploadedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < 7) return { type: 'new', label: 'Video Baru · Tonton Sekarang' };
  }
  if (releaseDays && releaseDays.length > 0) {
    const dayNamesJS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
    const today = new Date().getDay();
    let minDiff = 8; let nextDay = '';
    for (const dayName of releaseDays) {
      const dayIdx = dayNamesJS.indexOf(dayName);
      if (dayIdx === -1) continue;
      let diff = dayIdx - today; if (diff <= 0) diff += 7;
      if (diff < minDiff) { minDiff = diff; nextDay = dayName; }
    }
    if (nextDay) return { type: 'next', label: `Video Berikutnya · ${nextDay}` };
  }
  return null;
}

const emptyCourseForm = (): Omit<CourseCard, 'lesson_count'> => ({
  key: '', title: '', subtitle: '', description: '', level: 'fundamental', thumbnail_url: null, sort_order: 0, status: 'open',
});

function CourseCatalogPage({ onSelect, canEdit = false, sessionUsername = '' }: { onSelect: (courseKey: string) => void; canEdit?: boolean; sessionUsername?: string }) {
  const [courses, setCourses] = useState<CourseCard[]>([]);
  const [loading, setLoading] = useState(true);
  // progress per course_key -> pct (0-100)
  const [courseProgress, setCourseProgress] = useState<Record<string, number>>({});
  const [releaseSettings, setReleaseSettings] = useState<AllCourseReleaseSettings>({});
  const [formReleaseDays, setFormReleaseDays] = useState<string[]>([]);
  const [formModuleComplete, setFormModuleComplete] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [form, setForm] = useState(emptyCourseForm());
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CourseCard | null>(null);
  const [formError, setFormError] = useState('');
  const [thumbFile, setThumbFile] = useState<File | null>(null);
  const [thumbPreview, setThumbPreview] = useState<string | null>(null);
  const thumbInputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    const [{ data }, allRelSettings] = await Promise.all([
      supabase.from('courses').select('key, title, subtitle, description, level, thumbnail_url, lesson_count, sort_order, status').order('sort_order', { ascending: true }),
      loadCourseReleaseSettings(),
    ]);
    const courseList = ((data ?? []) as CourseCard[]).map((c) => ({ ...c, status: c.status ?? 'open' }));
    setCourses(courseList);
    setReleaseSettings(allRelSettings);
    setLoading(false);

    // Load progress per kelas untuk user ini
    if (sessionUsername && courseList.length > 0) {
      const [{ data: progressRows }, { data: lessonRows }] = await Promise.all([
        supabase.from('lesson_progress').select('lesson_key').eq('session_username', sessionUsername),
        supabase.from('lessons').select('lesson_key, course_key'),
      ]);
      const completedByCourse: Record<string, number> = {};
      const totalByCourse: Record<string, number> = {};
      const lessonToCourse: Record<string, string> = {};
      for (const r of (lessonRows ?? []) as { lesson_key: string; course_key: string }[]) {
        totalByCourse[r.course_key] = (totalByCourse[r.course_key] ?? 0) + 1;
        lessonToCourse[r.lesson_key] = r.course_key;
      }
      for (const r of (progressRows ?? []) as { lesson_key: string }[]) {
        const ck = lessonToCourse[r.lesson_key];
        if (ck) completedByCourse[ck] = (completedByCourse[ck] ?? 0) + 1;
      }
      const pct: Record<string, number> = {};
      for (const key of Object.keys(totalByCourse)) {
        pct[key] = totalByCourse[key] > 0 ? Math.round(((completedByCourse[key] ?? 0) / totalByCourse[key]) * 100) : 0;
      }
      setCourseProgress(pct);

      // Sync lesson_count untuk semua course berdasarkan data aktual
      const updates = courseList
        .filter((c) => (totalByCourse[c.key] ?? 0) !== c.lesson_count)
        .map((c) => supabase.from('courses').update({ lesson_count: totalByCourse[c.key] ?? 0 }).eq('key', c.key));
      if (updates.length > 0) {
        await Promise.all(updates);
        // Update local state juga
        setCourses((prev) => prev.map((c) => ({ ...c, lesson_count: totalByCourse[c.key] ?? c.lesson_count })));
      }
    }
  };

  useEffect(() => { void load(); }, [sessionUsername]);

  const levelColor: Record<string, string> = {
    basic: '#64748b',
    general: '#64748b',
    fundamental: '#6c63ff',
    intermediate: '#0891b2',
    advance: '#e05a2b',
    expert: '#dc2626',
    masterclass: '#0a7ea4',
    bootcamp: '#059669',
    workshop: '#d97706',
  };

  const openCreate = () => {
    setForm({ ...emptyCourseForm(), sort_order: courses.length + 1 });
    setFormReleaseDays([]);
    setFormModuleComplete(false);
    setFormError('');
    setThumbFile(null);
    setThumbPreview(null);
    setModalMode('create');
    setModalOpen(true);
  };

  const openEdit = (c: CourseCard, e: React.MouseEvent) => {
    e.stopPropagation();
    setForm({ key: c.key, title: c.title, subtitle: c.subtitle, description: c.description, level: c.level, thumbnail_url: c.thumbnail_url, sort_order: c.sort_order, status: c.status ?? 'open' });
    setFormReleaseDays(releaseSettings[c.key]?.releaseDays ?? []);
    setFormModuleComplete(releaseSettings[c.key]?.moduleComplete ?? false);
    setFormError('');
    setThumbFile(null);
    setThumbPreview(c.thumbnail_url);
    setModalMode('edit');
    setModalOpen(true);
  };

  const handleThumbChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setThumbFile(file);
    setThumbPreview(URL.createObjectURL(file));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.key.trim() || !form.title.trim()) { setFormError('Key dan Judul wajib diisi.'); return; }
    setSaving(true);

    let thumbnailUrl = form.thumbnail_url;
    if (thumbFile) {
      const up = await compressImage(thumbFile, 1000, 0.82);
      const ext = up.name.split('.').pop();
      const filePath = `course-thumbnails/${form.key.trim()}_${Date.now()}.${ext}`;
      const { error: uploadError } = await supabase.storage.from('lesson-assets').upload(filePath, up, { upsert: true, contentType: up.type });
      if (uploadError) { setFormError(uploadError.message); setSaving(false); return; }
      thumbnailUrl = supabase.storage.from('lesson-assets').getPublicUrl(filePath).data.publicUrl;
    }

    const payload = { key: form.key.trim(), title: form.title.trim(), subtitle: form.subtitle.trim(), description: form.description.trim(), level: form.level, thumbnail_url: thumbnailUrl || null, sort_order: Number(form.sort_order) || 0, status: form.status };
    if (modalMode === 'create') {
      const { error } = await supabase.from('courses').insert({ ...payload, lesson_count: 0 });
      if (error) { setFormError(error.message); setSaving(false); return; }
    } else {
      const { error } = await supabase.from('courses').update({ title: payload.title, subtitle: payload.subtitle, description: payload.description, level: payload.level, thumbnail_url: payload.thumbnail_url, sort_order: payload.sort_order, status: payload.status, updated_at: new Date().toISOString() }).eq('key', payload.key);
      if (error) { setFormError(error.message); setSaving(false); return; }
    }
    // Save release schedule settings
    const updatedRelSettings = {
      ...releaseSettings,
      [payload.key]: { ...(releaseSettings[payload.key] ?? {}), releaseDays: formReleaseDays, moduleComplete: formModuleComplete },
    };
    await saveCourseReleaseSettings(updatedRelSettings);
    setSaving(false);
    setModalOpen(false);
    // Reload courses then apply release settings after so load() doesn't overwrite
    await load();
    setReleaseSettings(updatedRelSettings);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await supabase.from('courses').delete().eq('key', deleteTarget.key);
    setDeleteTarget(null);
    void load();
  };

  return (
    <section className="page course-catalog-page">
      <div className="course-catalog-header">
        <div>
          <h1 className="course-catalog-title">Learning Center</h1>
          <p className="course-catalog-subtitle">Pilih kelas yang ingin kamu pelajari</p>
        </div>
        {canEdit && (
          <button type="button" className="course-catalog-add-btn" onClick={openCreate}>+ Tambah Kelas</button>
        )}
      </div>

      {loading ? (
        <div className="course-catalog-loading">memuat kelas...</div>
      ) : courses.length === 0 ? (
        <div className="course-catalog-empty">Belum ada kelas tersedia.</div>
      ) : (
        <div className="course-catalog-grid">
          {courses.map((c) => {
            const isLocked = c.status === 'coming_soon';
            const pct = courseProgress[c.key] ?? 0;
            const started = pct > 0;
            const finished = pct === 100;
            const badge = !isLocked ? getCourseBadge(c.key, releaseSettings) : null;
            return (
              <div key={c.key} className={`course-card-wrap${isLocked ? ' course-card-locked' : ''}`}>
                <button
                  type="button"
                  className={`course-card${finished ? ' course-card-done' : ''}`}
                  onClick={() => { if (!isLocked || canEdit) onSelect(c.key); }}
                  disabled={isLocked && !canEdit}
                  style={isLocked && !canEdit ? { cursor: 'not-allowed' } : undefined}
                >
                  <div className="course-card-thumb">
                    {c.thumbnail_url
                      ? <img src={c.thumbnail_url} alt={c.title} className="course-card-thumb-img" />
                      : <div className="course-card-thumb-placeholder">📚</div>
                    }
                    <span className="course-card-level" style={{ background: levelColor[c.level.toLowerCase()] ?? '#6c63ff' }}>
                      {c.level}
                    </span>
                    {isLocked && (
                      <div className="course-card-coming-soon-overlay">
                        <span className="course-card-cs-badge">🔒 Coming Soon</span>
                      </div>
                    )}
                    {finished && !isLocked && (
                      <div className="course-card-done-badge">✓ Selesai</div>
                    )}
                  </div>
                  <div className="course-card-body">
                    {badge && !finished && (
                      badge.type === 'complete'
                        ? <div className="course-card-badge-capsule"><span className="ccbc-label ccbc-complete">✓ Modul Sudah Lengkap</span></div>
                        : <div className="course-card-badge-capsule">
                            <span className={`ccbc-label ${badge.type === 'new' ? 'ccbc-new' : 'ccbc-next'}`}>{badge.type === 'new' ? 'Video Baru' : 'Video Berikutnya'}</span>
                            <span className="ccbc-action">{badge.type === 'new' ? 'Tonton Sekarang' : badge.label.split('· ')[1]}</span>
                          </div>
                    )}
                    <p className="course-card-subtitle">{c.subtitle}</p>
                    <h3 className="course-card-title">{c.title}</h3>
                    <p className="course-card-desc">{isLocked && !canEdit ? 'Kelas ini belum dibuka. Nantikan peluncurannya!' : c.description}</p>
                    <div className="course-card-footer">
                      <span className="course-card-meta">{isLocked && !canEdit ? '—' : `${c.lesson_count} lesson`}</span>
                      {started && !isLocked && (
                        <span className="course-card-pct">{pct}%</span>
                      )}
                    </div>
                    {started && !isLocked && (
                      <div className="course-card-progress-bar">
                        <div className="course-card-progress-fill" style={{ width: `${pct}%`, background: finished ? '#167f72' : '#6c47ff' }} />
                      </div>
                    )}
                  </div>
                </button>
                {canEdit && (
                  <div className="course-card-actions">
                    <button type="button" className="course-card-action-btn" onClick={(e) => openEdit(c, e)}>Edit</button>
                    <button type="button" className="course-card-action-btn danger" onClick={(e) => { e.stopPropagation(); setDeleteTarget(c); }}>Hapus</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Modal Create/Edit */}
      {modalOpen && createPortal(
        <div className="course-modal-overlay" onClick={() => setModalOpen(false)}>
          <div className="course-modal" onClick={(e) => e.stopPropagation()}>
            <div className="course-modal-header">
              <h3>{modalMode === 'create' ? 'Tambah Kelas Baru' : 'Edit Kelas'}</h3>
              <button type="button" className="course-modal-close" onClick={() => setModalOpen(false)}>✕</button>
            </div>
            <form className="course-modal-form" onSubmit={(e) => { void handleSave(e); }}>
              <label className="course-modal-label">
                Key (unik, tidak bisa diubah setelah dibuat)
                <input className="course-modal-input" value={form.key} onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))} disabled={modalMode === 'edit'} placeholder="contoh: advance-sm" required />
              </label>
              <label className="course-modal-label">
                Judul Kelas
                <input className="course-modal-input" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="Fundamental Social Media Specialist" required />
              </label>
              <label className="course-modal-label">
                Subtitle / Label Series
                <input className="course-modal-input" value={form.subtitle} onChange={(e) => setForm((f) => ({ ...f, subtitle: e.target.value }))} placeholder="Series Fundamental" />
              </label>
              <label className="course-modal-label full">
                Deskripsi
                <textarea className="course-modal-input course-modal-textarea" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="Deskripsi singkat kelas..." rows={3} />
              </label>
              <div className="course-modal-row">
                <label className="course-modal-label">
                  Level
                  <select className="course-modal-input" value={form.level} onChange={(e) => setForm((f) => ({ ...f, level: e.target.value }))}>
                    <option value="basic">Basic</option>
                    <option value="general">General</option>
                    <option value="fundamental">Fundamental</option>
                    <option value="intermediate">Intermediate</option>
                    <option value="advance">Advance</option>
                    <option value="expert">Expert</option>
                    <option value="masterclass">Masterclass</option>
                    <option value="bootcamp">Bootcamp</option>
                    <option value="workshop">Workshop</option>
                  </select>
                </label>
                <label className="course-modal-label">
                  Urutan
                  <input type="number" className="course-modal-input" value={form.sort_order} onChange={(e) => setForm((f) => ({ ...f, sort_order: Number(e.target.value) }))} min={0} />
                </label>
              </div>
              <label className="course-modal-label">
                Status Kelas
                <div className="course-status-toggle">
                  <button
                    type="button"
                    className={`course-status-btn${form.status === 'open' ? ' active open' : ''}`}
                    onClick={() => setForm((f) => ({ ...f, status: 'open' }))}
                  >
                    ✅ Dibuka
                  </button>
                  <button
                    type="button"
                    className={`course-status-btn${form.status === 'coming_soon' ? ' active coming-soon' : ''}`}
                    onClick={() => setForm((f) => ({ ...f, status: 'coming_soon' }))}
                  >
                    🔒 Coming Soon
                  </button>
                </div>
              </label>
              <div className="course-modal-label">
                Jadwal Rilis Video <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: '0.78rem' }}>(opsional — untuk indikator "Episode Berikutnya")</span>
                <div className="course-release-days">
                  {DAYS_ID.map((day) => (
                    <label key={day} className={`course-release-day-btn${formReleaseDays.includes(day) ? ' selected' : ''}`}>
                      <input
                        type="checkbox"
                        style={{ display: 'none' }}
                        checked={formReleaseDays.includes(day)}
                        onChange={(e) => setFormReleaseDays((prev) => e.target.checked ? [...prev, day] : prev.filter((d) => d !== day))}
                      />
                      {day}
                    </label>
                  ))}
                </div>
                {formReleaseDays.length > 0 && (
                  <p className="course-release-days-preview">Video baru akan tampil badge "Video Berikutnya · [Hari]" berdasarkan hari yang dipilih</p>
                )}
              </div>
              <label className="course-modal-label full course-module-complete-row">
                <input
                  type="checkbox"
                  checked={formModuleComplete}
                  onChange={(e) => setFormModuleComplete(e.target.checked)}
                  style={{ accentColor: 'var(--accent)', width: 15, height: 15, flexShrink: 0 }}
                />
                <span>Modul sudah lengkap <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: '0.78rem' }}>(indikator berubah jadi "Modul Sudah Lengkap")</span></span>
              </label>
              <div className="course-modal-label full">
                Thumbnail
                <div className="course-thumb-upload" onClick={() => thumbInputRef.current?.click()}>
                  {thumbPreview
                    ? <img src={thumbPreview} alt="preview" className="course-thumb-preview" />
                    : <div className="course-thumb-placeholder">🖼️ Klik untuk upload gambar</div>
                  }
                  {thumbPreview && <div className="course-thumb-overlay">Ganti Gambar</div>}
                </div>
                <input ref={thumbInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleThumbChange} />
              </div>
              {formError && <p className="course-modal-error">{formError}</p>}
              <div className="course-modal-footer">
                <button type="button" className="course-modal-btn secondary" onClick={() => setModalOpen(false)}>Batal</button>
                <button type="submit" className="course-modal-btn primary" disabled={saving}>{saving ? 'Menyimpan...' : 'Simpan'}</button>
              </div>
            </form>
          </div>
        </div>
      , document.body)}

      {/* Konfirmasi hapus */}
      {deleteTarget && createPortal(
        <div className="course-modal-overlay" onClick={() => setDeleteTarget(null)}>
          <div className="course-modal course-modal-sm" onClick={(e) => e.stopPropagation()}>
            <h3 className="course-modal-delete-title">Hapus Kelas?</h3>
            <p className="course-modal-delete-body">Kelas <strong>{deleteTarget.title}</strong> akan dihapus dari katalog. Lesson di dalamnya tidak ikut terhapus.</p>
            <div className="course-modal-footer">
              <button type="button" className="course-modal-btn secondary" onClick={() => setDeleteTarget(null)}>Batal</button>
              <button type="button" className="course-modal-btn danger" onClick={() => { void handleDelete(); }}>Hapus</button>
            </div>
          </div>
        </div>
      , document.body)}
    </section>
  );
}

function LmsPage({ canEdit, sessionUsername, sessionDisplayName, featureCosts, userPerks = {}, onCreditChange, onInsufficientCredits, onRequestConfirm, courseKey = 'lms', onBack }: { canEdit: boolean; sessionUsername: string; sessionDisplayName: string; featureCosts: FeatureCosts; userPerks?: UserPerks; onCreditChange: (n: number) => void; onInsufficientCredits: (feature: string, needed: number, balance: number) => void; onRequestConfirm: (ctx: CreditConfirmContext) => void; courseKey?: string; onBack?: () => void }) {
  const [materialLessons, setMaterialLessons] = useState<Lesson[]>([]);
  const [selectedLessonId, setSelectedLessonId] = useState('');
  const [isLessonsLoading, setIsLessonsLoading] = useState(true);
  const paidVideosKey = `paid_videos_${sessionUsername}`;
  const chargedVideos = useRef<Set<string>>(new Set(
    (() => { try { return JSON.parse(localStorage.getItem(paidVideosKey) ?? '[]') as string[]; } catch { return []; } })()
  ));
  const markVideoPaid = (lessonId: string) => {
    chargedVideos.current.add(lessonId);
    try {
      const existing = JSON.parse(localStorage.getItem(paidVideosKey) ?? '[]') as string[];
      if (!existing.includes(lessonId)) localStorage.setItem(paidVideosKey, JSON.stringify([...existing, lessonId]));
    } catch { /* ignore */ }
  };
  const videoRef = useRef<HTMLVideoElement>(null);
  const [youtubeUnlocked, setYoutubeUnlocked] = useState(() => {
    // if selected lesson was already paid, unlock YouTube immediately
    return false;
  });
  const [activeTab, setActiveTab] = useState<'overview' | 'reviews' | 'notes'>('overview');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [notesSaving, setNotesSaving] = useState(false);
  const notesSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [reviewsByLesson, setReviewsByLesson] = useState<Record<string, Review[]>>({});
  const [isReviewsLoading, setIsReviewsLoading] = useState(true);
  const [isReviewModalOpen, setIsReviewModalOpen] = useState(false);
  const [popoverPlacement, setPopoverPlacement] = useState<'down' | 'up'>('down');
  const [reviewName, setReviewName] = useState(sessionDisplayName || sessionUsername);
  const [reviewRating, setReviewRating] = useState('5');
  const [reviewFeedback, setReviewFeedback] = useState('');
  const [reviewerAvatarUrl, setReviewerAvatarUrl] = useState<string | null>(null);
  const progressStorageKey = `lesson_progress_${sessionUsername}_${courseKey}`;
  const [completedLessons, setCompletedLessons] = useState<Set<string>>(() => {
    if (!sessionUsername) return new Set();
    try {
      const cached = localStorage.getItem(`lesson_progress_${sessionUsername}_${courseKey}`);
      return cached ? new Set<string>(JSON.parse(cached) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });
  const [isProgressLoading, setIsProgressLoading] = useState(true);
  const [lessonEditorOpen, setLessonEditorOpen] = useState(false);
  const [lessonEditorMode, setLessonEditorMode] = useState<'create' | 'edit'>('create');
  const [editingLessonId, setEditingLessonId] = useState<string | null>(null);
  const [lessonDraft, setLessonDraft] = useState<LessonEditorDraft>(createEmptyLessonDraft());
  const [pendingAssetFiles, setPendingAssetFiles] = useState<File[]>([]);
  const [lessonDeleteTarget, setLessonDeleteTarget] = useState<Lesson | null>(null);
  const [assessmentOpen, setAssessmentOpen] = useState(false);
  const [moduleComplete, setModuleComplete] = useState<boolean | null>(null);
  const [assessmentQuestions, setAssessmentQuestions, persistAssessmentQuestions] = useSupabaseJsonState<AssessmentQuestion[]>(
    'lms_assessment_questions',
    initialAssessmentQuestions,
  );
  const [assessmentResult, setAssessmentResult] = useState<AssessmentResult | null>(null);
  const [assessmentResultOpen, setAssessmentResultOpen] = useState(false);
  const assessmentCooldownKey = `assessment_cooldown_${sessionUsername}_${courseKey}`;
  const getAssessmentCooldownMs = () => {
    const ts = localStorage.getItem(assessmentCooldownKey);
    if (!ts) return 0;
    const elapsed = Date.now() - Number(ts);
    const remaining = 24 * 60 * 60 * 1000 - elapsed;
    return remaining > 0 ? remaining : 0;
  };
  const [assessmentCooldownMs, setAssessmentCooldownMs] = useState(() => getAssessmentCooldownMs());
  const certPassedKey = `cert_passed_${sessionUsername}_${courseKey}`;
  const [assessmentPassed, setAssessmentPassed] = useState(() => localStorage.getItem(`cert_passed_${sessionUsername}_${courseKey}`) === '1');
  const [certTemplate, setCertTemplate] = useState<CertificateTemplate | null>(null);
  const [courseTitle, setCourseTitle] = useState('');
  const [showCertPreview, setShowCertPreview] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [isSaveChangesOpen, setIsSaveChangesOpen] = useState(false);
  const [isVideoPlaying, setIsVideoPlaying] = useState(false);
  const [isTheaterMode, setIsTheaterMode] = useState(false);
  const [isEmbedLoaded, setIsEmbedLoaded] = useState(false);
  const reviewTriggerRef = useRef<HTMLDivElement | null>(null);
  const reviewPopoverRef = useRef<HTMLDivElement | null>(null);
  const selectedLesson =
    materialLessons.find((lesson) => lesson.id === selectedLessonId) ?? materialLessons[0] ?? null;
  const selectedLessonIndex = selectedLesson
    ? materialLessons.findIndex((lesson) => lesson.id === selectedLesson.id)
    : -1;
  const bookmarkKey = `bookmarks_${sessionUsername}_${courseKey}`;
  const [bookmarks, setBookmarks] = useState<Set<string>>(() => {
    try { return new Set<string>(JSON.parse(localStorage.getItem(`bookmarks_${sessionUsername}_${courseKey}`) ?? '[]') as string[]); }
    catch { return new Set(); }
  });
  const toggleBookmark = (lessonId: string) => {
    setBookmarks((prev) => {
      const next = new Set(prev);
      if (next.has(lessonId)) next.delete(lessonId); else next.add(lessonId);
      localStorage.setItem(bookmarkKey, JSON.stringify([...next]));
      return next;
    });
  };

  const allLessonsCompleted = materialLessons.length > 0 && completedLessons.size === materialLessons.length;
  const currentLessonCompleted = selectedLesson ? completedLessons.has(selectedLesson.id) : false;
  const learningProgress = isProgressLoading
    ? 0
    : materialLessons.length === 0
      ? 0
      : Math.round((completedLessons.size / materialLessons.length) * 100);
  const quizUnlocked = allLessonsCompleted && moduleComplete === true;
  const selectedLessonReviews = selectedLesson ? reviewsByLesson[selectedLesson.id] ?? [] : [];
  const selectedLessonMedia = selectedLesson ? resolveLessonMedia(selectedLesson.videoUrl) : null;

  const loadLessonsFromDatabase = async () => {
    setIsLessonsLoading(true);

    const [{ data: lessonRows, error: lessonError }, { data: assetRows, error: assetError }] = await Promise.all([
      supabase
        .from('lessons')
        .select('lesson_key, course_key, sort_order, title, duration, meta, description, video_url')
        .eq('course_key', courseKey)
        .order('sort_order', { ascending: true }),
      supabase
        .from('lesson_assets')
        .select('asset_key, lesson_key, sort_order, title, type, note, storage_path, external_url')
        .order('sort_order', { ascending: true }),
    ]);

    if (lessonError) {
      console.warn('supabase load failed for lessons', lessonError);
      setMaterialLessons([]);
      setIsLessonsLoading(false);
      return { error: lessonError };
    }

    if (assetError) {
      console.warn('supabase load failed for lesson_assets', assetError);
    }

    const nextLessons = mapLessonRowsToLessons((lessonRows ?? []) as LessonRow[], (assetRows ?? []) as LessonAssetRow[]);
    setMaterialLessons(nextLessons);
    setSelectedLessonId((currentLessonId) => {
      if (nextLessons.length === 0) {
        return '';
      }

      const hasCurrentLesson = nextLessons.some((lesson) => lesson.id === currentLessonId);
      return hasCurrentLesson ? currentLessonId : nextLessons[0]?.id ?? '';
    });
    setIsLessonsLoading(false);
    return { error: null };
  };

  useEffect(() => {
    let isActive = true;
    void (async () => {
      const result = await loadLessonsFromDatabase();
      if (!isActive) {
        return;
      }
      if (result.error) {
        return;
      }
    })();

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    void loadCourseReleaseSettings().then((all) => {
      setModuleComplete(all[courseKey]?.moduleComplete ?? false);
    });
  }, [courseKey]);

  useEffect(() => {
    void (async () => {
      const [template, { data: courseRow }] = await Promise.all([
        loadCertTemplate(courseKey),
        supabase.from('courses').select('title').eq('key', courseKey).maybeSingle(),
      ]);
      setCertTemplate(template);
      setCourseTitle((courseRow as { title?: string } | null)?.title ?? courseKey);
    })();
  }, [courseKey]);

  useEffect(() => {
    let isActive = true;

    const loadReviews = async () => {
      setIsReviewsLoading(true);
      const { data, error } = await supabase
        .from('lesson_reviews')
        .select('id, lesson_key, reviewer_name, reviewer_username, rating, feedback, created_at')
        .order('created_at', { ascending: false });

      if (!isActive) {
        return;
      }

      if (error) {
        console.warn('supabase load failed for lesson_reviews', error);
        setReviewsByLesson({});
        setIsReviewsLoading(false);
        return;
      }

      const rows = (data ?? []) as ReviewRow[];

      // fetch avatar paths for reviewers that have a username
      const usernames = [...new Set(rows.map((r) => r.reviewer_username).filter(Boolean))] as string[];
      let avatarMap: Record<string, string> = {};
      if (usernames.length > 0) {
        const { data: profiles } = await supabase
          .from('user_profiles')
          .select('username, avatar_path')
          .in('username', usernames);
        for (const p of (profiles ?? []) as { username: string; avatar_path: string | null }[]) {
          if (p.avatar_path) {
            avatarMap[p.username] = profileAvatarPublicUrl(p.avatar_path);
          }
        }
      }

      const groupedReviews = rows.reduce<Record<string, Review[]>>((accumulator, reviewRow) => {
        const lessonReviews = accumulator[reviewRow.lesson_key] ?? [];
        lessonReviews.push({
          id: reviewRow.id,
          name: reviewRow.reviewer_name,
          username: reviewRow.reviewer_username,
          avatarUrl: reviewRow.reviewer_username ? (avatarMap[reviewRow.reviewer_username] ?? null) : null,
          rating: reviewRow.rating,
          feedback: reviewRow.feedback,
        });
        accumulator[reviewRow.lesson_key] = lessonReviews;
        return accumulator;
      }, {});

      setReviewsByLesson(groupedReviews);
      setIsReviewsLoading(false);
    };

    const loadProgress = async () => {
      if (!sessionUsername) {
        setIsProgressLoading(false);
        return;
      }

      setIsProgressLoading(true);
      const { data, error } = await supabase
        .from('lesson_progress')
        .select('lesson_key')
        .eq('session_username', sessionUsername);

      if (!isActive) {
        return;
      }

      if (error) {
        console.warn('supabase load failed for lesson_progress', error);
        setIsProgressLoading(false);
        return;
      }

      const remoteKeys = ((data ?? []) as LessonProgressRow[]).map((row) => row.lesson_key);
      // Merge remote with local cache (union — never lose data)
      const merged = new Set<string>([
        ...remoteKeys,
        ...((() => { try { const c = localStorage.getItem(progressStorageKey); return c ? (JSON.parse(c) as string[]) : []; } catch { return []; } })()),
      ]);
      localStorage.setItem(progressStorageKey, JSON.stringify([...merged]));
      setCompletedLessons(merged);
      setIsProgressLoading(false);
    };

    void Promise.all([loadReviews(), loadProgress()]);

    return () => {
      isActive = false;
    };
  }, [sessionUsername]);

  // Load catatan saat lesson berubah
  useEffect(() => {
    if (!sessionUsername || !selectedLessonId) return;
    if (notes[selectedLessonId] !== undefined) return; // sudah ada di cache
    void supabase
      .from('lesson_notes')
      .select('content')
      .eq('username', sessionUsername)
      .eq('lesson_key', selectedLessonId)
      .maybeSingle()
      .then(({ data }) => {
        setNotes((prev) => ({ ...prev, [selectedLessonId]: data?.content ?? '' }));
      });
  }, [selectedLessonId, sessionUsername]);
  useEffect(() => {
    if (!canEdit) {
      setIsEditMode(false);
      setLessonEditorOpen(false);
      setLessonDeleteTarget(null);
      setIsSaveChangesOpen(false);
    }
  }, [canEdit]);

  useEffect(() => {
    setIsEmbedLoaded(false);
    // if this lesson was already paid (persisted in localStorage), unlock immediately
    const alreadyPaid = selectedLesson ? chargedVideos.current.has(selectedLesson.id) : false;
    setYoutubeUnlocked(alreadyPaid);
  }, [selectedLesson?.id, selectedLesson?.videoUrl, selectedLessonMedia?.kind]);

  const handleReviewSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextReview = {
      name: reviewName.trim() || 'anonymous',
      rating: Number(reviewRating),
      feedback: reviewFeedback.trim(),
    };

    if (!selectedLesson) {
      return;
    }

    void (async () => {
      const { data, error } = await supabase
        .from('lesson_reviews')
        .insert({
          lesson_key: selectedLesson.id,
          reviewer_name: nextReview.name,
          reviewer_username: sessionUsername || null,
          rating: nextReview.rating,
          feedback: nextReview.feedback,
        })
        .select('id, lesson_key, reviewer_name, reviewer_username, rating, feedback, created_at')
        .single();

      if (error) {
        console.warn('supabase save failed for lesson_reviews', error);
        return;
      }

      const insertedReview = data as ReviewRow;
      const nextReviewsByLesson = {
        ...reviewsByLesson,
        [selectedLesson.id]: [
          {
            id: insertedReview.id,
            name: insertedReview.reviewer_name,
            username: insertedReview.reviewer_username,
            avatarUrl: reviewerAvatarUrl,
            rating: insertedReview.rating,
            feedback: insertedReview.feedback,
          },
          ...(reviewsByLesson[selectedLesson.id] ?? []),
        ],
      };

      setReviewsByLesson(nextReviewsByLesson);
      setReviewName('');
      setReviewRating('5');
      setReviewFeedback('');
      setIsReviewModalOpen(false);
    })();
  };

  const parseLessonDraft = (draft: LessonEditorDraft, lessonId?: string, sortOrder = 0): Lesson => {
    const stats = draft.statsText
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean);

    const assets = draft.assets
      .map((assetDraft) => {
        const normalizedLinks = assetDraft.links
          .map((linkDraft, index) => {
            const normalizedUrl = linkDraft.url.trim();
            if (!normalizedUrl) {
              return null;
            }

            const resolvedLink = resolveAssetLinkToken(
              `${linkDraft.title.trim() || `link ${index + 1}`}::${normalizedUrl}`,
              'link',
              index,
            );

            return resolvedLink
              ? {
                  title: resolvedLink.label,
                  href: resolvedLink.href,
                  storagePath: normalizedUrl.startsWith('storage:') ? normalizedUrl.replace(/^storage:/, '') : undefined,
                  externalUrl: normalizedUrl.startsWith('storage:') ? undefined : normalizedUrl,
                }
              : null;
          })
          .filter((link): link is ParsedAssetLink => Boolean(link));

        const primaryStoragePath = normalizedLinks.find((link) => link.storagePath)?.storagePath;
        const externalLinks = normalizedLinks.filter((link) => !link.storagePath);

        return {
          title: assetDraft.title.trim() || 'untitled asset',
          type: assetDraft.type.trim() || 'file',
          note: assetDraft.note.trim() || 'asset pendukung',
          href:
            normalizedLinks[0]?.href
            ?? assetDownloadUrl(assetDraft.title.trim() || 'untitled asset', assetDraft.type.trim() || 'file'),
          links: normalizedLinks.map((link) => ({ label: link.title, href: link.href })),
          storagePath: primaryStoragePath,
          externalUrl:
            externalLinks.length > 0
              ? externalLinks.map((link) => `${link.title}::${link.externalUrl}`).join(', ')
              : undefined,
        };
      })
      .filter((asset) => asset.title || asset.links?.length);

    return {
      id: lessonId ?? `lesson-${Date.now()}`,
      sortOrder,
      title: draft.title.trim() || 'materi baru',
      duration: draft.duration.trim() || '0 menit',
      meta: draft.meta.trim() || 'video class',
      description: draft.description.trim() || 'deskripsi materi',
      videoUrl: draft.videoUrl.trim() || 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
      stats: stats.length > 0 ? stats : ['no stats'],
      assets,
    };
  };

  const persistLessonToDatabase = async (lesson: Lesson, assetFiles: File[]) => {
    const { error: lessonError } = await supabase.from('lessons').upsert({
      lesson_key: lesson.id,
      course_key: courseKey,
      sort_order: lesson.sortOrder ?? 0,
      title: lesson.title,
      duration: lesson.duration,
      meta: lesson.meta,
      description: lesson.description,
      video_url: lesson.videoUrl,
    });

    if (lessonError) {
      return { lesson, error: lessonError };
    }

    // Auto-update last lesson uploaded timestamp for Netflix badge
    void updateLastLessonUploadedAt(courseKey);

    const { error: deleteAssetError } = await supabase.from('lesson_assets').delete().eq('lesson_key', lesson.id);

    if (deleteAssetError) {
      return { lesson, error: deleteAssetError };
    }

    let uploadedAssets: LessonAsset[] = [];

    for (const [index, file] of assetFiles.entries()) {
      const filePath = `${lesson.id}/${Date.now()}-${index}-${sanitizeFileName(file.name)}`;
      const { error: uploadError } = await supabase.storage.from('lesson-assets').upload(filePath, file, {
        upsert: false,
      });

      if (uploadError) {
        return { lesson, error: uploadError };
      }

      uploadedAssets.push({
        title: file.name.replace(/\.[^.]+$/, ''),
        type: (file.name.split('.').pop() || 'file').toLowerCase(),
        note: `uploaded file ${file.name}`,
        href: supabase.storage.from('lesson-assets').getPublicUrl(filePath).data.publicUrl,
        links: [
          {
            label: 'download file',
            href: supabase.storage.from('lesson-assets').getPublicUrl(filePath).data.publicUrl,
          },
        ],
        storagePath: filePath,
      });
    }

    const allAssets = [...lesson.assets, ...uploadedAssets];

    if (allAssets.length > 0) {
      const assetRows = allAssets.map((asset, index) => ({
        asset_key: `${lesson.id}-${asset.sortOrder ?? index}-${asset.title.replace(/\s+/g, '-').toLowerCase()}`,
        lesson_key: lesson.id,
        sort_order: asset.sortOrder ?? index,
        title: asset.title,
        type: asset.type,
        note: asset.note,
        storage_path: asset.storagePath ?? null,
        external_url: asset.storagePath
          ? asset.links?.slice(1).map((link) => `${link.label}::${link.href}`).join(', ') || null
          : asset.links?.map((link) => `${link.label}::${link.href}`).join(', ') || asset.externalUrl || asset.href || null,
      }));

      const { error: insertAssetError } = await supabase.from('lesson_assets').insert(assetRows);

      if (insertAssetError) {
        return { lesson, error: insertAssetError };
      }
    }

    return {
      lesson: {
        ...lesson,
        assets: allAssets.map((asset, index) => ({
          ...asset,
          sortOrder: asset.sortOrder ?? index,
        })),
      },
      error: null,
    };
  };

  const openCreateLesson = () => {
    setLessonEditorMode('create');
    setEditingLessonId(null);
    setLessonDraft(createEmptyLessonDraft());
    setPendingAssetFiles([]);
    setLessonEditorOpen(true);
  };

  const openEditLesson = (lesson: Lesson) => {
    setLessonEditorMode('edit');
    setEditingLessonId(lesson.id);
    setLessonDraft({
      title: lesson.title,
      duration: lesson.duration,
      meta: lesson.meta,
      description: lesson.description,
      videoUrl: lesson.videoUrl,
      statsText: lesson.stats.join('\n'),
      assets: lesson.assets.map((asset) => ({
        id: `asset-item-${asset.title}-${asset.sortOrder ?? 0}`,
        title: asset.title,
        type: asset.type,
        note: asset.note,
        links:
          asset.links?.map((link, index) => ({
            id: `asset-link-${asset.title}-${index}`,
            title: link.label,
            url: asset.storagePath && index === 0 ? `storage:${asset.storagePath}` : link.href,
          })) ?? [
            {
              id: `asset-link-${asset.title}-0`,
              title: 'link 1',
              url: asset.storagePath ? `storage:${asset.storagePath}` : asset.externalUrl ?? asset.href,
            },
          ],
      })),
    });
    setPendingAssetFiles([]);
    setLessonEditorOpen(true);
  };

  const saveLesson = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const editingLesson = editingLessonId ? materialLessons.find((lesson) => lesson.id === editingLessonId) : null;
    const nextLesson = parseLessonDraft(
      lessonDraft,
      lessonEditorMode === 'edit' ? editingLessonId ?? undefined : undefined,
      editingLesson?.sortOrder ?? materialLessons.length,
    );

    void (async () => {
      const result = await persistLessonToDatabase(nextLesson, pendingAssetFiles);

      if (result?.error) {
        console.warn(`supabase save failed for lesson ${nextLesson.id}`, result.error);
        return;
      }

      const persistedLesson = result?.lesson ?? nextLesson;

      await loadLessonsFromDatabase();
      // sync lesson_count di tabel courses
      const { count } = await supabase.from('lessons').select('lesson_key', { count: 'exact', head: true }).eq('course_key', courseKey);
      await supabase.from('courses').update({ lesson_count: count ?? 0 }).eq('key', courseKey);
      setSelectedLessonId(persistedLesson.id);
      setPendingAssetFiles([]);
      setLessonEditorOpen(false);
      if (lessonEditorMode === 'create') {
        void (async () => {
          const { data: allUsers } = await supabase.from('app_users').select('username').eq('is_active', true);
          for (const u of allUsers ?? []) {
            void insertNotification(u.username, 'lesson_new', 'Materi Baru Tersedia!', `"${persistedLesson.title}" baru saja ditambahkan. Yuk mulai belajar!`, '#materi');
          }
        })();
      }
    })();
  };

  const commitDeleteLesson = (lessonId: string) => {
    const deletedIndex = materialLessons.findIndex((lesson) => lesson.id === lessonId);
    void (async () => {
      const { error: assetDeleteError } = await supabase.from('lesson_assets').delete().eq('lesson_key', lessonId);

      if (assetDeleteError) {
        console.warn(`supabase delete failed for lesson assets ${lessonId}`, assetDeleteError);
        return;
      }

      const { error } = await supabase.from('lessons').delete().eq('lesson_key', lessonId);

      if (error) {
        console.warn(`supabase delete failed for lesson ${lessonId}`, error);
        window.alert(`gagal menghapus materi: ${error.message}`);
        return;
      }

      const { error: reviewDeleteError } = await supabase.from('lesson_reviews').delete().eq('lesson_key', lessonId);
      if (reviewDeleteError) {
        console.warn(`supabase delete failed for lesson reviews ${lessonId}`, reviewDeleteError);
      }

      const { error: progressDeleteError } = await supabase.from('lesson_progress').delete().eq('lesson_key', lessonId);
      if (progressDeleteError) {
        console.warn(`supabase delete failed for lesson progress ${lessonId}`, progressDeleteError);
      }

      const nextReviews = { ...reviewsByLesson };
      delete nextReviews[lessonId];
      setReviewsByLesson(nextReviews);

      const nextCompletedLessons = new Set(completedLessons);
      nextCompletedLessons.delete(lessonId);
      setCompletedLessons(nextCompletedLessons);
      try { localStorage.setItem(progressStorageKey, JSON.stringify([...nextCompletedLessons])); } catch { /* ignore */ }

      const refreshResult = await loadLessonsFromDatabase();
      if (refreshResult.error) {
        window.alert(`materi terhapus, tetapi daftar terbaru gagal dimuat: ${refreshResult.error.message}`);
        return;
      }
      // sync lesson_count di tabel courses
      const { count } = await supabase.from('lessons').select('lesson_key', { count: 'exact', head: true }).eq('course_key', courseKey);
      await supabase.from('courses').update({ lesson_count: count ?? 0 }).eq('key', courseKey);

      if (selectedLessonId === lessonId) {
        const remainingLessons = materialLessons.filter((lesson) => lesson.id !== lessonId);
        const nextLesson = remainingLessons[Math.min(deletedIndex, remainingLessons.length - 1)];
        setSelectedLessonId(nextLesson?.id ?? '');
      }
    })();
  };

  const requestDeleteLesson = (lesson: Lesson) => {
    setLessonDeleteTarget(lesson);
  };

  const moveLesson = (lessonId: string, direction: 'up' | 'down') => {
    const currentIndex = materialLessons.findIndex((lesson) => lesson.id === lessonId);
    if (currentIndex < 0) {
      return;
    }

    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= materialLessons.length) {
      return;
    }

    const nextLessons = [...materialLessons];
    const [movedLesson] = nextLessons.splice(currentIndex, 1);
    nextLessons.splice(targetIndex, 0, movedLesson);

    const reorderedLessons = nextLessons.map((lesson, index) => ({
      ...lesson,
      sortOrder: index + 1,
    }));

    void (async () => {
      const { error } = await supabase.from('lessons').upsert(
        reorderedLessons.map((lesson) => ({
          lesson_key: lesson.id,
          course_key: courseKey,
          sort_order: lesson.sortOrder ?? 0,
          title: lesson.title,
          duration: lesson.duration,
          meta: lesson.meta,
          description: lesson.description,
          video_url: lesson.videoUrl,
        })),
        { onConflict: 'lesson_key' },
      );

      if (error) {
        console.warn('supabase reorder failed for lessons', error);
        window.alert(`gagal mengubah urutan materi: ${error.message}`);
        return;
      }

      await loadLessonsFromDatabase();
    })();
  };

  const markCurrentLessonComplete = () => {
    if (!selectedLesson || !sessionUsername) {
      return;
    }

    const wasCompleted = completedLessons.has(selectedLesson.id);

    // Update state optimistically so UI responds immediately
    const nextCompletedLessons = new Set(completedLessons);
    nextCompletedLessons.add(selectedLesson.id);
    setCompletedLessons(nextCompletedLessons);
    try { localStorage.setItem(progressStorageKey, JSON.stringify([...nextCompletedLessons])); } catch { /* ignore */ }

    // Bonus koin selesai materi (hanya saat pertama kali selesai, dibatasi per hari)
    if (!wasCompleted) {
      void awardCoinReward(sessionUsername, 'complete_lesson').then((nb) => { if (nb != null) onCreditChange(nb); });
    }

    void (async () => {
      const { error } = await supabase.from('lesson_progress').upsert(
        {
          session_username: sessionUsername,
          lesson_key: selectedLesson.id,
          completed_at: new Date().toISOString(),
        },
        { onConflict: 'session_username,lesson_key' },
      );

      if (error) {
        console.warn('supabase save failed for lesson_progress', error);
      }
    })();
  };

  const handleVideoEnded = () => {
    if (!selectedLesson) {
      return;
    }

    setIsVideoPlaying(false);
    setIsTheaterMode(false);
    markCurrentLessonComplete();

    const nextLesson = materialLessons[selectedLessonIndex + 1];

    if (nextLesson) {
      setSelectedLessonId(nextLesson.id);
    }
  };

  const isLessonUnlocked = (lessonIndex: number) =>
    lessonIndex === 0 || completedLessons.has(materialLessons[lessonIndex - 1].id);

  const handleNoteChange = (lessonId: string, value: string) => {
    setNotes((prev) => ({ ...prev, [lessonId]: value }));
    if (notesSaveTimer.current) clearTimeout(notesSaveTimer.current);
    notesSaveTimer.current = setTimeout(async () => {
      if (!sessionUsername) return;
      setNotesSaving(true);
      await supabase.from('lesson_notes').upsert({
        username: sessionUsername,
        lesson_key: lessonId,
        course_key: courseKey,
        content: value,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'username,lesson_key' });
      setNotesSaving(false);
    }, 800);
  };

  const addAssessmentQuestion = () => {
    const nextQuestions = [...assessmentQuestions, createAssessmentQuestion()];
    setAssessmentQuestions(nextQuestions);
    void persistAssessmentQuestions(nextQuestions);
  };

  const updateAssessmentQuestion = (
    questionId: string,
    updater: (question: AssessmentQuestion) => AssessmentQuestion,
  ) => {
    const nextQuestions = assessmentQuestions.map((question) => (question.id === questionId ? updater(question) : question));
    setAssessmentQuestions(nextQuestions);
    void persistAssessmentQuestions(nextQuestions);
  };

  const deleteAssessmentQuestion = (questionId: string) => {
    const nextQuestions = assessmentQuestions.filter((question) => question.id !== questionId);
    setAssessmentQuestions(nextQuestions);
    void persistAssessmentQuestions(nextQuestions);
  };

  const clearAssessmentQuestions = () => {
    setAssessmentQuestions([]);
    void persistAssessmentQuestions([]);
    setAssessmentResult(null);
  };

  const submitAssessment = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const totalCount = assessmentQuestions.length;
    const correctCount = assessmentQuestions.filter((q) => q.answerIndex !== null && q.answerIndex === q.correctIndex).length;
    const score = totalCount === 0 ? 0 : Math.round((correctCount / totalCount) * 100);
    setAssessmentResult({ score, correctCount, totalCount });
    if (score >= 70) {
      localStorage.setItem(certPassedKey, '1');
      setAssessmentPassed(true);
    }
    // save cooldown timestamp
    localStorage.setItem(assessmentCooldownKey, String(Date.now()));
    setAssessmentCooldownMs(24 * 60 * 60 * 1000);
    // reset answers for next attempt
    const reset = assessmentQuestions.map((q) => ({ ...q, answerIndex: null }));
    setAssessmentQuestions(reset);
    setAssessmentOpen(false);
    setAssessmentResultOpen(true);
  };

  const openAssessment = () => {
    const remaining = getAssessmentCooldownMs();
    setAssessmentCooldownMs(remaining);
    if (isEditMode || quizUnlocked) {
      // reset semua jawaban agar tidak ada yang terpilih saat mulai
      if (remaining === 0) {
        setAssessmentQuestions(prev => prev.map(q => ({ ...q, answerIndex: null })));
      }
      setAssessmentOpen(true);
      setAssessmentResult(null);
    }
  };

  const closeLessonEditor = () => {
    setLessonEditorOpen(false);
    setPendingAssetFiles([]);
  };

  // Sync nama review dengan profil terkini saat modal dibuka
  useEffect(() => {
    if (!isReviewModalOpen || !sessionUsername) return;
    void supabase.from('user_profiles').select('name, avatar_path').eq('username', sessionUsername).maybeSingle()
      .then(({ data }) => {
        const row = data as { name?: string; avatar_path?: string | null } | null;
        if (row?.name) setReviewName(row.name);
        setReviewerAvatarUrl(row?.avatar_path ? profileAvatarPublicUrl(row.avatar_path) : null);
      });
  }, [isReviewModalOpen, sessionUsername]);

  useEffect(() => {
    if (!isReviewModalOpen) {
      return;
    }

    const updatePlacement = () => {
      const triggerRect = reviewTriggerRef.current?.getBoundingClientRect();
      const popoverHeight = reviewPopoverRef.current?.offsetHeight ?? 0;
      const viewportHeight = window.innerHeight;

      if (!triggerRect) {
        return;
      }

      const spaceBelow = viewportHeight - triggerRect.bottom;
      const spaceAbove = triggerRect.top;

      if (spaceBelow < popoverHeight + 24 && spaceAbove > popoverHeight + 24) {
        setPopoverPlacement('up');
      } else {
        setPopoverPlacement('down');
      }
    };

    updatePlacement();
    window.addEventListener('resize', updatePlacement);
    window.addEventListener('scroll', updatePlacement, true);

    return () => {
      window.removeEventListener('resize', updatePlacement);
      window.removeEventListener('scroll', updatePlacement, true);
    };
  }, [isReviewModalOpen, reviewFeedback, reviewName, reviewRating]);

  useEffect(() => {
    if (materialLessons.length === 0) {
      if (selectedLessonId !== '') {
        setSelectedLessonId('');
      }
      return;
    }

    if (!materialLessons.some((lesson) => lesson.id === selectedLessonId) && materialLessons[0]) {
      setSelectedLessonId(materialLessons[0].id);
    }
  }, [materialLessons, selectedLessonId]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsTheaterMode(false);
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, []);

  return (
    <section className="page lms-page-wrap">
      {onBack && (
        <button type="button" className="lms-back-btn" onClick={onBack}>
          ← Kembali ke Katalog
        </button>
      )}
      <div className={`lms-shell ${isTheaterMode ? 'theater-active' : ''}`}>
        <article className="lms-main">
          {isLessonsLoading ? (
            <div className="lms-empty-state">
              <div className="lms-empty-icon">📚</div>
              <h2>memuat materi...</h2>
              <p>menyiapkan lesson dari database.</p>
            </div>
          ) : selectedLesson ? (
            <>
              {/* Video player */}
              <div className="lms-video-wrap">
                {isTheaterMode && (
                  <button type="button" className="video-close" onClick={() => setIsTheaterMode(false)}>×</button>
                )}
                <div className={`video-stage ${selectedLessonMedia?.kind === 'youtube' ? 'embed' : ''}`}>
                  {selectedLessonMedia?.kind === 'youtube' ? (
                    <div className="video-embed-wrap">
                      {youtubeUnlocked ? (
                        <iframe
                          className="video-embed"
                          src={selectedLessonMedia.embedUrl}
                          title={selectedLesson.title}
                          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                          allowFullScreen
                          loading="eager"
                          onLoad={() => setIsEmbedLoaded(true)}
                        />
                      ) : (
                        <div
                          className="video-overlay youtube-gate"
                          role="button"
                          tabIndex={0}
                          aria-label="Play video"
                          onClick={() => {
                            const lessonId = selectedLesson.id;
                            const videoFree = userPerks.credit_exempt || userPerks.free_video;
                            if (!canEdit && !chargedVideos.current.has(lessonId) && featureCosts.video_learning > 0 && !videoFree) {
                              onRequestConfirm({
                                feature: 'Video Learning',
                                cost: featureCosts.video_learning,
                                onConfirm: () => {
                                  markVideoPaid(lessonId);
                                  void deductCredits(sessionUsername, featureCosts.video_learning, `Akses video: ${selectedLesson.title}`, 'video_learning')
                                    .then((res) => {
                                      if (!res.ok) {
                                        chargedVideos.current.delete(lessonId);
                                        onInsufficientCredits('Video Learning', res.needed ?? featureCosts.video_learning, res.balance ?? 0);
                                      } else {
                                        if (res.newBalance !== undefined) onCreditChange(res.newBalance);
                                        setYoutubeUnlocked(true);
                                      }
                                    });
                                },
                              });
                            } else {
                              setYoutubeUnlocked(true);
                              void supabase.from('video_views').insert({ username: sessionUsername, lesson_key: selectedLesson.id, video_title: selectedLesson.title });
                            }
                          }}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.currentTarget.click(); }}
                        >
                          <img
                            className="youtube-gate-thumb"
                            src={`https://img.youtube.com/vi/${selectedLessonMedia.videoId}/maxresdefault.jpg`}
                            onError={(e) => { (e.currentTarget as HTMLImageElement).src = `https://img.youtube.com/vi/${selectedLessonMedia.videoId}/hqdefault.jpg`; }}
                            alt=""
                            aria-hidden="true"
                          />
                          {(() => {
                            const videoFreeCheck = userPerks.credit_exempt || userPerks.free_video;
                            if (!canEdit && !videoFreeCheck && featureCosts.video_learning > 0) {
                              return (
                                <div className="video-lock-overlay">
                                  <div className="video-lock-badge">
                                    <span className="video-lock-icon">🔒</span>
                                    <span className="video-lock-cost"><CoinIcon size={13} /> {featureCosts.video_learning} Ruang Coin</span>
                                  </div>
                                  <div className="video-lock-play">▶ Putar Video</div>
                                  <p className="video-lock-hint">Ruang Coin akan dipotong saat video dimulai</p>
                                </div>
                              );
                            }
                            return <div className="play-button">▶</div>;
                          })()}
                        </div>
                      )}
                    </div>
                  ) : selectedLessonMedia?.kind === 'video' ? (
                    <>
                      <video
                        ref={videoRef}
                        className="video-player"
                        controls
                        playsInline
                        poster={posterForLesson(selectedLesson.title)}
                        src={selectedLessonMedia.url}
                        onPlay={() => {
                          const lessonId = selectedLesson.id;
                          const videoFree = userPerks.credit_exempt || userPerks.free_video;
                          if (!canEdit && !chargedVideos.current.has(lessonId) && featureCosts.video_learning > 0 && !videoFree) {
                            videoRef.current?.pause();
                            onRequestConfirm({
                              feature: 'Video Learning',
                              cost: featureCosts.video_learning,
                              onConfirm: () => {
                                markVideoPaid(lessonId);
                                void deductCredits(sessionUsername, featureCosts.video_learning, `Akses video: ${selectedLesson.title}`, 'video_learning')
                                  .then((res) => {
                                    if (!res.ok) {
                                      chargedVideos.current.delete(lessonId);
                                      onInsufficientCredits('Video Learning', res.needed ?? featureCosts.video_learning, res.balance ?? 0);
                                    } else {
                                      if (res.newBalance !== undefined) onCreditChange(res.newBalance);
                                      setIsVideoPlaying(true);
                                      setIsTheaterMode(true);
                                      void videoRef.current?.play();
                                    }
                                  });
                              },
                              onCancel: () => { videoRef.current?.pause(); },
                            });
                          } else {
                            setIsVideoPlaying(true);
                            setIsTheaterMode(true);
                            void supabase.from('video_views').insert({ username: sessionUsername, lesson_key: selectedLesson.id, video_title: selectedLesson.title });
                          }
                        }}
                        onPause={() => setIsVideoPlaying(false)}
                        onEnded={handleVideoEnded}
                      />
                      {!isVideoPlaying && (() => {
                        const videoFreeCheck = userPerks.credit_exempt || userPerks.free_video;
                        const isLocked = !canEdit && !videoFreeCheck && featureCosts.video_learning > 0 && !chargedVideos.current.has(selectedLesson.id);
                        return (
                          <div className="video-overlay" aria-hidden="true">
                            {isLocked ? (
                              <div className="video-lock-overlay">
                                <div className="video-lock-badge">
                                  <span className="video-lock-icon">🔒</span>
                                  <span className="video-lock-cost"><CoinIcon size={13} /> {featureCosts.video_learning} Ruang Coin</span>
                                </div>
                                <div className="video-lock-play">▶ Putar Video</div>
                                <p className="video-lock-hint">Ruang Coin akan dipotong saat video dimulai</p>
                              </div>
                            ) : (
                              <div className="play-button">▶</div>
                            )}
                          </div>
                        );
                      })()}
                    </>
                  ) : (
                    <div className="video-fallback">
                      <strong>format video tidak didukung</strong>
                      <p>pakai link youtube atau direct file mp4/webm.</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Action bar */}
              <div className="lms-action-bar">
                <div className="lms-action-bar-left">
                  {(canEdit || (userPerks.credit_exempt || userPerks.free_video) || featureCosts.video_learning === 0 || chargedVideos.current.has(selectedLesson.id)) && (
                    <button type="button" className="lms-bar-btn" onClick={markCurrentLessonComplete} disabled={currentLessonCompleted}>
                      <span className={`lms-bar-icon ${currentLessonCompleted ? 'done' : ''}`}>{currentLessonCompleted ? '✓' : '♡'}</span>
                      {currentLessonCompleted ? 'Selesai' : 'Tandai Selesai'}
                    </button>
                  )}
                  <button
                    type="button"
                    className={`lms-bar-btn ${isTheaterMode ? 'active' : ''}`}
                    onClick={() => setIsTheaterMode(v => !v)}
                  >
                    <span className="lms-bar-icon">{isTheaterMode ? '⊠' : '⊡'}</span>
                    {isTheaterMode ? 'Keluar Theater' : 'Mode Theater'}
                  </button>
                </div>
                {selectedLessonIndex < materialLessons.length - 1 && (
                  <button
                    type="button"
                    className="lms-next-btn"
                    onClick={() => {
                      const next = materialLessons[selectedLessonIndex + 1];
                      if (next) setSelectedLessonId(next.id);
                    }}
                  >
                    Lesson Berikutnya →
                  </button>
                )}
              </div>

              {/* Lesson info */}
              <div className="lms-lesson-body">
                <div className="lms-lesson-meta-row">
                  <span className="lms-lesson-tag">{selectedLesson.meta}</span>
                  <span className="lms-lesson-duration-badge">⏱ {selectedLesson.duration}</span>
                  <span className="lms-lesson-num-badge">Lesson {selectedLessonIndex + 1} / {materialLessons.length}</span>
                </div>
                <h2 className="lms-lesson-title">{selectedLesson.title}</h2>
                <p className="lms-lesson-desc">{selectedLesson.description}</p>
              </div>

              {/* Tabs */}
              <div className="lms-tabs-wrap">
                <div className="lms-tabs-row" role="tablist">
                  {(['materi', 'catatan', 'reviews'] as const).map((tab) => {
                    const key = tab === 'materi' ? 'overview' : tab === 'catatan' ? 'notes' : 'reviews';
                    const hasNote = tab === 'catatan' && selectedLesson && notes[selectedLesson.id];
                    return (
                      <button
                        key={tab}
                        type="button"
                        className={`lms-tab ${activeTab === key ? 'active' : ''}`}
                        onClick={() => setActiveTab(key)}
                      >
                        {tab === 'materi' ? 'File & Asset' : tab === 'catatan' ? <>Catatan {hasNote ? <span className="lms-note-dot" /> : null}</> : 'Reviews'}
                      </button>
                    );
                  })}
                  {activeTab === 'reviews' && (
                    <button
                      type="button"
                      className="lms-write-review-btn"
                      onClick={() => setIsReviewModalOpen(v => !v)}
                      ref={reviewTriggerRef as unknown as React.RefObject<HTMLButtonElement>}
                    >
                      + Tulis Review
                    </button>
                  )}
                </div>

                {isReviewModalOpen && (
                  <div className={`review-popover ${popoverPlacement}`} ref={reviewPopoverRef} role="dialog" aria-modal="false">
                    <div className="review-modal-head">
                      <div><p className="eyebrow">review kelas</p><h3>tulis review baru</h3></div>
                      <button type="button" className="modal-close" onClick={() => setIsReviewModalOpen(false)}>×</button>
                    </div>
                    <form className="review-modal-form" onSubmit={handleReviewSubmit}>
                      <div className="review-user-info">
                        <span className="review-user-label">Review sebagai</span>
                        <strong className="review-user-name">{reviewName}</strong>
                      </div>
                      <div className="review-rating-field">
                        <span className="review-rating-label">rating</span>
                        <div className="review-star-picker" role="radiogroup" aria-label="rating">
                          {[1, 2, 3, 4, 5].map((v) => (
                            <button
                              type="button"
                              key={v}
                              className={`review-star${Number(reviewRating) >= v ? ' active' : ''}`}
                              aria-label={`${v} bintang`}
                              aria-checked={Number(reviewRating) === v}
                              role="radio"
                              onClick={() => setReviewRating(String(v))}
                            >
                              ★
                            </button>
                          ))}
                        </div>
                      </div>
                      <label>feedback<textarea rows={4} value={reviewFeedback} onChange={e => setReviewFeedback(e.target.value)} placeholder="tulis feedback kelas" /></label>
                      <button type="submit" className="button primary">simpan review</button>
                    </form>
                  </div>
                )}
              </div>

              {/* Tab content */}
              {activeTab === 'overview' ? (
                <div className="lms-files-section">
                  {selectedLesson.assets.length === 0 ? (
                    <p className="lms-no-files">Tidak ada file pendukung untuk lesson ini.</p>
                  ) : (
                    <div className="lms-file-grid">
                      {selectedLesson.assets.map((asset) => (
                        <div className="lms-file-card" key={asset.title}>
                          <div className="lms-file-icon">{asset.type === 'pdf' ? '📄' : asset.type === 'sheet' ? '📊' : asset.type === 'zip' ? '📦' : '📁'}</div>
                          <div className="lms-file-info">
                            <strong>{asset.title}</strong>
                            <span>{asset.note}</span>
                          </div>
                          <div className="lms-file-actions">
                            {(asset.links && asset.links.length > 0 ? asset.links : [{ label: 'Download', href: asset.href }]).map((link) => (
                              <a key={link.href} href={link.href} target="_blank" rel="noreferrer" className="lms-download-btn">
                                ↓ {link.label}
                              </a>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : activeTab === 'notes' ? (
                <div className="lms-notes-section">
                  <div className="lms-notes-header">
                    <p className="lms-notes-hint">Catatan hanya bisa dilihat oleh kamu sendiri. Disimpan otomatis.</p>
                    {notesSaving && <span className="lms-notes-saving">menyimpan…</span>}
                  </div>
                  <textarea
                    className="lms-notes-textarea"
                    placeholder="Tulis catatan untuk lesson ini…"
                    value={notes[selectedLesson?.id ?? ''] ?? ''}
                    onChange={(e) => selectedLesson && handleNoteChange(selectedLesson.id, e.target.value)}
                  />
                </div>
              ) : (
                <div className="lms-reviews-section">
                  {isReviewsLoading ? (
                    <p className="lms-no-files">Memuat review...</p>
                  ) : selectedLessonReviews.length === 0 ? (
                    <p className="lms-no-files">Belum ada review untuk lesson ini.</p>
                  ) : (
                    <div className="lms-review-list">
                      {selectedLessonReviews.map((review, index) => (
                        <div className="lms-review-item" key={`${review.name}-${index}`}>
                          <div className="lms-review-header">
                            {review.avatarUrl
                              ? <img src={review.avatarUrl} alt={review.name} className="lms-review-avatar lms-review-avatar-img" />
                              : <div className="lms-review-avatar">{review.name.charAt(0).toUpperCase()}</div>
                            }
                            <div>
                              <strong>{review.name}</strong>
                              <span className="lms-review-stars">{'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)}</span>
                            </div>
                          </div>
                          <p>{review.feedback}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="lms-empty-state">
              <div className="lms-empty-icon">📭</div>
              <h2>belum ada materi</h2>
              <p>{canEdit ? 'Tambah lesson pertama dari tombol di bawah.' : 'Materi belum tersedia, pantau terus ya!'}</p>
              {canEdit && (
                <button type="button" className="lms-add-first-btn" onClick={openCreateLesson}>
                  + Tambah Materi Pertama
                </button>
              )}
            </div>
          )}
        </article>

          <LmsSidebar
            learningProgress={learningProgress}
            materialLessons={materialLessons}
            selectedLessonId={selectedLessonId}
            completedLessons={completedLessons}
            quizUnlocked={quizUnlocked}
            isEditMode={isEditMode}
            canEdit={canEdit}
            onToggleEditMode={() => {
              if (!canEdit) {
                return;
              }

              if (isEditMode) {
                setIsSaveChangesOpen(true);
                return;
              }

              setIsEditMode(true);
          }}
          onSelectLesson={setSelectedLessonId}
          onCreateLesson={openCreateLesson}
          onEditLesson={openEditLesson}
          onMoveLesson={moveLesson}
          onDeleteLesson={requestDeleteLesson}
          onOpenAssessment={openAssessment}
          assessmentPassed={assessmentPassed}
          onDownloadCert={certTemplate ? () => setShowCertPreview(true) : undefined}
          bookmarks={bookmarks}
          onToggleBookmark={toggleBookmark}
          moduleComplete={moduleComplete}
        />
      </div>
      {lessonEditorOpen && (
        <LessonEditorDrawer
          mode={lessonEditorMode}
          draft={lessonDraft}
          pendingAssetFiles={pendingAssetFiles}
          onChangeDraft={setLessonDraft}
          onChangePendingAssetFiles={setPendingAssetFiles}
          onClose={closeLessonEditor}
          onSubmit={saveLesson}
        />
      )}

      {assessmentOpen && (
        <AssessmentDrawer
          questions={assessmentQuestions}
          unlocked={quizUnlocked}
          canEdit={canEdit && isEditMode}
          onClose={() => setAssessmentOpen(false)}
          onAddQuestion={addAssessmentQuestion}
          onUpdateQuestion={updateAssessmentQuestion}
          onDeleteQuestion={deleteAssessmentQuestion}
          onClearQuestions={clearAssessmentQuestions}
          onSubmit={submitAssessment}
          cooldownMs={assessmentCooldownMs}
          onSkipCooldown={() => {
            const cost = 2;
            onRequestConfirm({
              feature: 'Lewati cooldown asesmen',
              cost,
              onConfirm: () => {
                void deductCredits(sessionUsername, cost, 'Skip assessment cooldown', 'assessment_skip').then((res) => {
                  if (res?.newBalance != null) onCreditChange(res.newBalance);
                });
                localStorage.removeItem(assessmentCooldownKey);
                setAssessmentCooldownMs(0);
              },
            });
          }}
        />
      )}

      {assessmentResultOpen && assessmentResult && (
        <AssessmentResultModal
          result={assessmentResult}
          onClose={() => setAssessmentResultOpen(false)}
          onRetry={() => {
            setAssessmentResultOpen(false);
            setAssessmentOpen(true);
          }}
          onDownloadCert={assessmentResult.score >= 70 && certTemplate
            ? () => { setAssessmentResultOpen(false); setShowCertPreview(true); }
            : undefined
          }
        />
      )}

      {isSaveChangesOpen && (
        <SaveChangesDialog
          onCancel={() => setIsSaveChangesOpen(false)}
          onSave={() => {
            setIsSaveChangesOpen(false);
            setIsEditMode(false);
            setLessonEditorOpen(false);
            setAssessmentOpen(false);
          }}
        />
      )}

      {lessonDeleteTarget && (
        <DeleteLessonDialog
          lessonTitle={lessonDeleteTarget.title}
          onCancel={() => setLessonDeleteTarget(null)}
          onDelete={() => {
            commitDeleteLesson(lessonDeleteTarget.id);
            setLessonDeleteTarget(null);
          }}
        />
      )}

      {showCertPreview && certTemplate && (
        <CertPreviewModal
          displayName={sessionDisplayName || sessionUsername}
          courseTitle={courseTitle}
          template={certTemplate}
          onClose={() => setShowCertPreview(false)}
        />
      )}
    </section>
  );
}

function LmsSidebar({
  learningProgress,
  materialLessons,
  selectedLessonId,
  completedLessons,
  quizUnlocked,
  isEditMode,
  canEdit,
  onToggleEditMode,
  onSelectLesson,
  onCreateLesson,
  onEditLesson,
  onMoveLesson,
  onDeleteLesson,
  onOpenAssessment,
  assessmentPassed,
  onDownloadCert,
  bookmarks,
  onToggleBookmark,
  moduleComplete,
}: {
  learningProgress: number;
  materialLessons: Lesson[];
  selectedLessonId: string;
  completedLessons: Set<string>;
  quizUnlocked: boolean;
  isEditMode: boolean;
  canEdit: boolean;
  onToggleEditMode: () => void;
  onSelectLesson: (lessonId: string) => void;
  onCreateLesson: () => void;
  onEditLesson: (lesson: Lesson) => void;
  onMoveLesson: (lessonId: string, direction: 'up' | 'down') => void;
  onDeleteLesson: (lesson: Lesson) => void;
  onOpenAssessment: () => void;
  assessmentPassed?: boolean;
  onDownloadCert?: () => void;
  bookmarks?: Set<string>;
  onToggleBookmark?: (lessonId: string) => void;
  moduleComplete?: boolean;
}) {
  const isLessonUnlocked = (lessonIndex: number) =>
    lessonIndex === 0 || completedLessons.has(materialLessons[lessonIndex - 1].id);
  const canManageAssessment = canEdit && isEditMode;

  return (
    <aside className="lms-sidebar">
      <div className="lms-sidebar-header">
        <div className="lms-sidebar-title-row">
          <h3>Kurikulum Kelas</h3>
          {canEdit && (
            <button type="button" className={`lms-edit-toggle ${isEditMode ? 'active' : ''}`} onClick={onToggleEditMode}>
              {isEditMode ? '✓ Selesai Edit' : '✏ Edit'}
            </button>
          )}
        </div>
        <div className="lms-progress-bar-wrap">
          <div className="lms-progress-bar-track">
            <div className="lms-progress-bar-fill" style={{ width: `${learningProgress}%` }} />
          </div>
          <span className="lms-progress-label">{learningProgress}% selesai</span>
        </div>
      </div>

      <section className="lms-sidebar-section">
        <div className="lms-sidebar-section-head">
          <div>
            <strong>Materi Pelajaran</strong>
            <span>{materialLessons.length} lesson{materialLessons.length !== 1 ? 's' : ''}</span>
          </div>
          {canEdit && isEditMode && (
            <button type="button" className="lms-add-lesson-btn" onClick={onCreateLesson}>+</button>
          )}
        </div>

        <div className="lms-lesson-list">
          {materialLessons.map((lesson, index) => {
            const isLocked = !isLessonUnlocked(index);
            const isActive = lesson.id === selectedLessonId;
            const isDone = completedLessons.has(lesson.id);
            const isBookmarked = bookmarks?.has(lesson.id) ?? false;

            return (
              <div key={lesson.id} className={`lms-lesson-item ${isActive ? 'active' : ''} ${isLocked ? 'locked' : ''}`}>
                <button
                  type="button"
                  className="lms-lesson-btn"
                  disabled={isLocked}
                  onClick={() => onSelectLesson(lesson.id)}
                >
                  <span className={`lms-play-icon ${isActive ? 'active' : ''} ${isDone ? 'done' : ''}`}>
                    {isDone ? '✓' : '▶'}
                  </span>
                  <div className="lms-lesson-info">
                    <strong>{lesson.title}</strong>
                    <span>{lesson.duration}</span>
                  </div>
                </button>
                {!isLocked && !isEditMode && (
                  <button
                    type="button"
                    className={`lms-bookmark-btn${isBookmarked ? ' active' : ''}`}
                    title={isBookmarked ? 'Hapus bookmark' : 'Bookmark lesson ini'}
                    onClick={(e) => { e.stopPropagation(); onToggleBookmark?.(lesson.id); }}
                  >
                    {isBookmarked ? '🔖' : '🏷'}
                  </button>
                )}
                {canEdit && isEditMode && (
                  <div className="lms-lesson-edit-bar">
                    <button type="button" onClick={() => onEditLesson(lesson)}>edit</button>
                    <button type="button" onClick={() => onMoveLesson(lesson.id, 'up')} disabled={index === 0}>↑</button>
                    <button type="button" onClick={() => onMoveLesson(lesson.id, 'down')} disabled={index === materialLessons.length - 1}>↓</button>
                    <button type="button" className="danger" onClick={() => onDeleteLesson(lesson)}>hapus</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="lms-sidebar-section quiz-section">
        <div className="lms-sidebar-section-head">
          <div>
            <strong>Post Test</strong>
            <span>
              {canManageAssessment
                ? 'edit soal & nilai passing'
                : !moduleComplete
                  ? 'Menunggu modul selesai'
                  : quizUnlocked
                    ? 'Quiz tersedia'
                    : 'Selesaikan semua lesson dulu'}
            </span>
          </div>
          {canManageAssessment && (
            <button type="button" className="lms-add-lesson-btn" onClick={onOpenAssessment} title="edit asesmen">✏</button>
          )}
        </div>

        <div className="lms-lesson-list">
          <button
            type="button"
            className={`lms-lesson-btn quiz-btn ${quizUnlocked || canManageAssessment ? 'unlocked' : 'locked'}`}
            disabled={!canManageAssessment && !quizUnlocked}
            onClick={onOpenAssessment}
          >
            <span className={`lms-play-icon ${quizUnlocked || canManageAssessment ? 'active' : ''}`}>
              ▶
            </span>
            <div className="lms-lesson-info">
              <strong>Final Assessment</strong>
              <span>
                {canManageAssessment
                  ? 'edit soal & nilai passing'
                  : !moduleComplete
                    ? '🔒 Modul belum selesai'
                    : quizUnlocked
                      ? 'Siap dikerjakan'
                      : 'Terkunci'}
              </span>
            </div>
            <span className="lms-quiz-arrow">{quizUnlocked || canManageAssessment ? '→' : ''}</span>
          </button>
        </div>

        {!moduleComplete && !canManageAssessment && (
          <p className="lms-module-incomplete-note">
            Final Assessment & sertifikat akan terbuka setelah admin menandai modul ini selesai.
          </p>
        )}
      </section>

      {assessmentPassed && onDownloadCert && moduleComplete && (
        <div className="lms-cert-section">
          <div className="lms-cert-badge">🎓</div>
          <strong>Kelas Selesai!</strong>
          <span>Kamu sudah lulus final assessment</span>
          <button type="button" className="cert-download-btn" onClick={onDownloadCert}>
            ↓ Download Sertifikat
          </button>
        </div>
      )}
    </aside>
  );
}

function LessonEditorDrawer({
  mode,
  draft,
  pendingAssetFiles,
  onChangeDraft,
  onChangePendingAssetFiles,
  onClose,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  draft: LessonEditorDraft;
  pendingAssetFiles: File[];
  onChangeDraft: React.Dispatch<React.SetStateAction<LessonEditorDraft>>;
  onChangePendingAssetFiles: React.Dispatch<React.SetStateAction<File[]>>;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  if (typeof document === 'undefined') {
    return null;
  }

  const updateAssetDraft = (assetId: string, updater: (asset: LessonAssetDraftItem) => LessonAssetDraftItem) => {
    onChangeDraft((current) => ({
      ...current,
      assets: current.assets.map((asset) => (asset.id === assetId ? updater(asset) : asset)),
    }));
  };

  const addAssetDraft = () => {
    onChangeDraft((current) => ({
      ...current,
      assets: [...current.assets, createEmptyAssetDraftItem()],
    }));
  };

  const deleteAssetDraft = (assetId: string) => {
    onChangeDraft((current) => ({
      ...current,
      assets: current.assets.filter((asset) => asset.id !== assetId),
    }));
  };

  const addAssetLinkDraft = (assetId: string) => {
    updateAssetDraft(assetId, (asset) => ({
      ...asset,
      links: [...asset.links, createEmptyAssetDraftLink()],
    }));
  };

  const updateAssetLinkDraft = (
    assetId: string,
    linkId: string,
    key: 'title' | 'url',
    value: string,
  ) => {
    updateAssetDraft(assetId, (asset) => ({
      ...asset,
      links: asset.links.map((link) => (link.id === linkId ? { ...link, [key]: value } : link)),
    }));
  };

  const deleteAssetLinkDraft = (assetId: string, linkId: string) => {
    updateAssetDraft(assetId, (asset) => ({
      ...asset,
      links: asset.links.filter((link) => link.id !== linkId),
    }));
  };

  return createPortal(
    <div className="drawer-backdrop" role="presentation" onClick={onClose}>
      <aside className="side-drawer" role="dialog" aria-modal="true" aria-label="materi editor" onClick={(event) => event.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <p className="eyebrow">{mode === 'edit' ? 'edit materi' : 'tambah materi'}</p>
            <h3>{mode === 'edit' ? 'perbarui materi kelas' : 'buat materi baru'}</h3>
          </div>
          <button type="button" className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>

        <form className="drawer-form" onSubmit={onSubmit}>
          <label>
            judul materi
            <input
              value={draft.title}
              onChange={(event) => onChangeDraft((current) => ({ ...current, title: event.target.value }))}
              placeholder="judul materi"
            />
          </label>
          <label>
            duration
            <input
              value={draft.duration}
              onChange={(event) => onChangeDraft((current) => ({ ...current, duration: event.target.value }))}
              placeholder="18 menit"
            />
          </label>
          <label>
            meta
            <input
              value={draft.meta}
              onChange={(event) => onChangeDraft((current) => ({ ...current, meta: event.target.value }))}
              placeholder="video class / download asset"
            />
          </label>
          <label>
            deskripsi
            <textarea
              rows={4}
              value={draft.description}
              onChange={(event) => onChangeDraft((current) => ({ ...current, description: event.target.value }))}
              placeholder="ringkasan materi"
            />
          </label>
          <label>
            video url
            <input
              value={draft.videoUrl}
              onChange={(event) => onChangeDraft((current) => ({ ...current, videoUrl: event.target.value }))}
              placeholder="https://..."
            />
          </label>
          <label>
            stats
            <textarea
              rows={3}
              value={draft.statsText}
              onChange={(event) => onChangeDraft((current) => ({ ...current, statsText: event.target.value }))}
              placeholder="satu baris per stat"
            />
          </label>
          <label>
            asset kelas
            <div className="asset-draft-list">
              {draft.assets.map((asset, assetIndex) => (
                <div className="asset-draft-card" key={asset.id}>
                  <div className="asset-draft-head">
                    <strong>asset {assetIndex + 1}</strong>
                    <button type="button" className="mini-action danger" onClick={() => deleteAssetDraft(asset.id)}>
                      hapus asset
                    </button>
                  </div>

                  <div className="asset-draft-fields">
                    <label>
                      judul asset
                      <input
                        value={asset.title}
                        onChange={(event) => updateAssetDraft(asset.id, (current) => ({ ...current, title: event.target.value }))}
                        placeholder="template reels"
                      />
                    </label>
                    <label>
                      type
                      <input
                        value={asset.type}
                        onChange={(event) => updateAssetDraft(asset.id, (current) => ({ ...current, type: event.target.value }))}
                        placeholder="figma / pdf / drive"
                      />
                    </label>
                  </div>

                  <label>
                    note
                    <input
                      value={asset.note}
                      onChange={(event) => updateAssetDraft(asset.id, (current) => ({ ...current, note: event.target.value }))}
                      placeholder="catatan asset"
                    />
                  </label>

                  <div className="asset-link-list">
                    {asset.links.map((link, linkIndex) => (
                      <div className="asset-link-row" key={link.id}>
                        <input
                          value={link.title}
                          onChange={(event) => updateAssetLinkDraft(asset.id, link.id, 'title', event.target.value)}
                          placeholder={`judul link ${linkIndex + 1}`}
                        />
                        <input
                          value={link.url}
                          onChange={(event) => updateAssetLinkDraft(asset.id, link.id, 'url', event.target.value)}
                          placeholder="https://... atau storage:path"
                        />
                        <button type="button" className="mini-action danger" onClick={() => deleteAssetLinkDraft(asset.id, link.id)}>
                          hapus
                        </button>
                      </div>
                    ))}
                  </div>

                  <button type="button" className="button secondary tiny" onClick={() => addAssetLinkDraft(asset.id)}>
                    tambah link
                  </button>
                </div>
              ))}

              <button type="button" className="button secondary" onClick={addAssetDraft}>
                tambah asset kelas
              </button>
            </div>
          </label>
          <label>
            upload asset file
            <input
              type="file"
              multiple
              onChange={(event) => onChangePendingAssetFiles(Array.from(event.target.files ?? []))}
            />
          </label>
          {pendingAssetFiles.length > 0 && (
            <div className="upload-file-list">
              {pendingAssetFiles.map((file) => (
                <span key={`${file.name}-${file.size}`}>{file.name}</span>
              ))}
            </div>
          )}
          <button type="submit" className="button primary">
            simpan materi
          </button>
        </form>
      </aside>
    </div>
    ,
    document.body,
  );
}

function AssessmentDrawer({
  questions,
  unlocked,
  canEdit,
  onClose,
  onAddQuestion,
  onUpdateQuestion,
  onDeleteQuestion,
  onClearQuestions,
  onSubmit,
  cooldownMs,
  onSkipCooldown,
}: {
  questions: AssessmentQuestion[];
  unlocked: boolean;
  canEdit: boolean;
  onClose: () => void;
  onAddQuestion: () => void;
  onUpdateQuestion: (questionId: string, updater: (question: AssessmentQuestion) => AssessmentQuestion) => void;
  onDeleteQuestion: (questionId: string) => void;
  onClearQuestions: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  cooldownMs: number;
  onSkipCooldown?: () => void;
}) {
  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div className="drawer-backdrop" role="presentation" onClick={onClose}>
      <aside className="side-drawer assessment-drawer" role="dialog" aria-modal="true" aria-label="final assessment" onClick={(event) => event.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <p className="eyebrow">final assessment</p>
            <h3>{canEdit ? 'question builder' : 'mulai asesmen'}</h3>
          </div>
          <button type="button" className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>

        {!canEdit && !unlocked && (
          <div className="locked-note">selesaikan semua materi untuk membuka final assessment.</div>
        )}

        {!canEdit && unlocked && cooldownMs > 0 && (
          <div className="locked-note cooldown-note">
            asesmen sudah dikerjakan. kamu bisa mencoba lagi dalam{' '}
            <strong>{Math.ceil(cooldownMs / (60 * 60 * 1000))} jam</strong> ke depan.
            {onSkipCooldown && (
              <button type="button" className="cooldown-skip-btn" onClick={onSkipCooldown}>
                atau gunakan <strong>2 coin</strong> untuk langsung mencoba sekarang
              </button>
            )}
          </div>
        )}

        <form className="drawer-form assessment-form" onSubmit={onSubmit}>
          {questions.map((question, index) => (
            <div className="question-row" key={question.id}>
              <span className="question-num">{index + 1}</span>
            <section className="question-card">
              {canEdit && (
                <div className="question-head">
                  <button type="button" className="mini-action danger" onClick={() => onDeleteQuestion(question.id)}>
                    hapus
                  </button>
                </div>
              )}

              {canEdit ? (
                <>
                  <label>
                    pertanyaan
                    <textarea
                      rows={3}
                      value={question.prompt}
                      onChange={(event) =>
                        onUpdateQuestion(question.id, (current) => ({ ...current, prompt: event.target.value }))
                      }
                    />
                  </label>

                  <div className="question-options">
                    {question.options.map((option, optionIndex) => (
                      <label key={`${question.id}-${optionIndex}`}>
                        opsi {optionIndex + 1}
                        <input
                          value={option}
                          onChange={(event) =>
                            onUpdateQuestion(question.id, (current) => {
                              const nextOptions = [...current.options];
                              nextOptions[optionIndex] = event.target.value;
                              return { ...current, options: nextOptions };
                            })
                          }
                        />
                      </label>
                    ))}
                  </div>

                  <div className="question-meta">
                    <label>
                      jawaban benar
                      <select
                        value={question.correctIndex}
                        onChange={(event) =>
                          onUpdateQuestion(question.id, (current) => ({
                            ...current,
                            correctIndex: Number(event.target.value),
                          }))
                        }
                      >
                        {question.options.map((_, optionIndex) => (
                          <option key={optionIndex} value={optionIndex}>
                            opsi {optionIndex + 1}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label>
                      jawaban murid
                      <select
                        value={question.answerIndex ?? 0}
                        onChange={(event) =>
                          onUpdateQuestion(question.id, (current) => ({
                            ...current,
                            answerIndex: Number(event.target.value),
                          }))
                        }
                      >
                        {question.options.map((_, optionIndex) => (
                          <option key={optionIndex} value={optionIndex}>
                            opsi {optionIndex + 1}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </>
              ) : (
                <>
                  <div className="assessment-question-copy">{question.prompt}</div>
                  <div className="question-options answer-mode">
                    {question.options.map((option, optionIndex) => (
                      <label key={`${question.id}-${optionIndex}`} className="assessment-answer-option">
                        <input
                          type="radio"
                          name={`answer-${question.id}`}
                          checked={question.answerIndex === optionIndex}
                          disabled={cooldownMs > 0}
                          onChange={() =>
                            onUpdateQuestion(question.id, (current) => ({
                              ...current,
                              answerIndex: optionIndex,
                            }))
                          }
                        />
                        <span>{option}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </section>
            </div>
          ))}

          {canEdit ? (
            <>
              <button type="button" className="button secondary" onClick={onAddQuestion}>
                tambah soal
              </button>
              <button type="button" className="button danger" onClick={onClearQuestions} disabled={questions.length === 0}>
                hapus asesmen
              </button>
            </>
          ) : (
            <>
              <button type="submit" className="button primary" disabled={!unlocked || cooldownMs > 0}>
                {cooldownMs > 0 ? `tunggu ${Math.ceil(cooldownMs / (60 * 60 * 1000))} jam lagi` : 'submit asesmen'}
              </button>
              {cooldownMs > 0 && onSkipCooldown && (
                <button type="button" className="button secondary cooldown-skip-alt-btn" onClick={onSkipCooldown}>
                  <CoinIcon size={13} /> Bayar 2 Coin — Coba Sekarang
                </button>
              )}
            </>
          )}
        </form>
      </aside>
    </div>
    ,
    document.body,
  );
}

function AssessmentResultModal({
  result,
  onClose,
  onRetry,
  onDownloadCert,
}: {
  result: AssessmentResult;
  onClose: () => void;
  onRetry: () => void;
  onDownloadCert?: () => void;
}) {
  const passed = result.score >= 70;
  return createPortal(
    <div className="drawer-backdrop" role="presentation" onClick={onClose}>
      <div className="side-drawer save-dialog assessment-result-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="modal-close" onClick={onClose}>×</button>
        <div className="assessment-result-icon">{passed ? '🎉' : '📚'}</div>
        <p className="eyebrow">{passed ? 'selamat!' : 'hampir!'}</p>
        <h3 className="assessment-result-score">{result.score}<span>%</span></h3>
        <p className="assessment-result-sub">
          {result.correctCount} dari {result.totalCount} jawaban benar
        </p>
        <div className={`assessment-result-badge ${passed ? 'pass' : 'fail'}`}>
          {passed ? 'lulus' : 'belum lulus'}
        </div>
        {passed && onDownloadCert && (
          <button type="button" className="cert-download-btn" onClick={onDownloadCert}>
            🎓 Download Sertifikat
          </button>
        )}
        <div className="dialog-actions" style={{ justifyContent: 'center', marginTop: 16 }}>
          {!passed && (
            <button type="button" className="button secondary" onClick={onRetry}>
              coba lagi
            </button>
          )}
          <button type="button" className="button primary" onClick={onClose}>
            {passed ? 'tutup' : 'kembali ke materi'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SaveChangesDialog({
  onCancel,
  onSave,
}: {
  onCancel: () => void;
  onSave: () => void;
}) {
  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div className="drawer-backdrop" role="presentation" onClick={onCancel}>
      <aside
        className="side-drawer save-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="simpan perubahan"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="drawer-head">
          <div>
            <p className="eyebrow">mode edit</p>
            <h3>simpan perubahan?</h3>
          </div>
          <button type="button" className="modal-close" onClick={onCancel}>
            ×
          </button>
        </div>

        <p className="dialog-copy">
          perubahan yang sudah kamu buat akan dipertahankan. pilih simpan untuk keluar dari mode edit, atau cancel
          untuk tetap mengedit.
        </p>

        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onCancel}>
            cancel
          </button>
          <button type="button" className="button primary" onClick={onSave}>
            save perubahan
          </button>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function DeleteLessonDialog({
  lessonTitle,
  onCancel,
  onDelete,
}: {
  lessonTitle: string;
  onCancel: () => void;
  onDelete: () => void;
}) {
  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div className="drawer-backdrop" role="presentation" onClick={onCancel}>
      <aside
        className="side-drawer save-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="hapus materi"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="drawer-head">
          <div>
            <p className="eyebrow">hapus materi</p>
            <h3>hapus "{lessonTitle}"?</h3>
          </div>
          <button type="button" className="modal-close" onClick={onCancel}>
            ×
          </button>
        </div>

        <p className="dialog-copy">
          materi yang dihapus tidak bisa dikembalikan. review dan progress yang terhubung akan ikut hilang dari
          daftar.
        </p>

        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onCancel}>
            cancel
          </button>
          <button type="button" className="button danger" onClick={onDelete}>
            hapus materi
          </button>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function AuthDialog({
  username,
  password,
  error,
  submitting,
  onChangeUsername,
  onChangePassword,
  onClose,
  onSubmit,
}: {
  username: string;
  password: string;
  error: string;
  submitting: boolean;
  onChangeUsername: (value: string) => void;
  onChangePassword: (value: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div className="drawer-backdrop auth-backdrop" role="presentation" onClick={onClose}>
      <aside
        className="side-drawer auth-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="login developer"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="drawer-head">
          <div>
            <p className="eyebrow">login developer</p>
            <h3>masuk ke mode edit</h3>
          </div>
          <button type="button" className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>

        <p className="dialog-copy">
          akun developer akan membuka seluruh kontrol edit di LMS. mode student tetap preview only.
        </p>

        <form className="drawer-form" onSubmit={onSubmit}>
          <label>
            username
            <input
              value={username}
              onChange={(event) => onChangeUsername(event.target.value)}
              placeholder="arunika"
              autoComplete="username"
            />
          </label>
          <label>
            password
            <input
              type="password"
              value={password}
              onChange={(event) => onChangePassword(event.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </label>

          {error && <div className="form-error">{error}</div>}

          <div className="dialog-actions">
            <button type="button" className="button secondary" onClick={onClose}>
              cancel
            </button>
            <button type="submit" className="button primary" disabled={submitting}>
              {submitting ? 'memproses...' : 'login'}
            </button>
          </div>
        </form>
      </aside>
    </div>,
    document.body,
  );
}

function LoginPage({
  session,
  redirectTo,
  onLoginSuccess,
  onShowPromo,
  initialAuthMode = 'sign-in',
}: {
  session: AppSession | null;
  redirectTo: string;
  onLoginSuccess: (session: AppSession) => void;
  onShowPromo?: () => void;
  initialAuthMode?: 'sign-in' | 'sign-up';
}) {
  const [authMode, setAuthMode] = useState<'sign-in' | 'sign-up'>(initialAuthMode);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [referralCode, setReferralCode] = useState('');
  const [referralStatus, setReferralStatus] = useState<'idle' | 'valid' | 'invalid'>('idle');
  const [referralCredits, setReferralCredits] = useState(0);
  const [referralMatched, setReferralMatched] = useState<ReferralCode | null>(null);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ username?: string; displayName?: string; password?: string; confirmPassword?: string }>({});
  const [rememberMe] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const clearValidation = () => {
    setError('');
    setFieldErrors({});
  };

  const handleReferralBlur = async () => {
    if (!referralCode.trim()) { setReferralStatus('idle'); setReferralMatched(null); return; }
    const match = await validateReferralCode(referralCode);
    if (match) { setReferralStatus('valid'); setReferralCredits(match.credits); setReferralMatched(match); }
    else { setReferralStatus('invalid'); setReferralCredits(0); setReferralMatched(null); }
  };

  const validateSignIn = () => {
    const nextFieldErrors: typeof fieldErrors = {};

    if (username.trim().length < 3) {
      nextFieldErrors.username = 'username minimal 3 karakter.';
    }

    if (password.trim().length < 6) {
      nextFieldErrors.password = 'password minimal 6 karakter.';
    }

    setFieldErrors(nextFieldErrors);

    if (Object.keys(nextFieldErrors).length > 0) {
      setError('periksa kembali field yang masih kosong atau tidak valid.');
      return false;
    }

    return true;
  };

  const validateSignUp = () => {
    const nextFieldErrors: typeof fieldErrors = {};

    if (displayName.trim().length < 2) {
      nextFieldErrors.displayName = 'display name minimal 2 karakter.';
    }

    if (username.trim().length < 3) {
      nextFieldErrors.username = 'username minimal 3 karakter.';
    }

    if (password.trim().length < 6) {
      nextFieldErrors.password = 'password minimal 6 karakter.';
    }

    if (confirmPassword.trim().length < 6) {
      nextFieldErrors.confirmPassword = 'konfirmasi password wajib diisi.';
    }

    if (password && confirmPassword && password !== confirmPassword) {
      nextFieldErrors.confirmPassword = 'password dan konfirmasi password harus sama.';
    }

    setFieldErrors(nextFieldErrors);

    if (Object.keys(nextFieldErrors).length > 0) {
      setError('periksa kembali field yang masih kosong atau tidak valid.');
      return false;
    }

    return true;
  };

  const handleSignIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!validateSignIn()) {
      return;
    }

    setSubmitting(true);
    setError('');

    const doAuth = () => supabase.rpc('authenticate_app_user', {
      p_username: username.trim().toLowerCase(),
      p_password: password,
    });
    let { data, error: rpcError } = await doAuth();
    // Retry sekali jika kena statement timeout (biasanya throttling sementara).
    if (rpcError && /timeout|canceling statement/i.test(rpcError.message)) {
      await new Promise((r) => setTimeout(r, 800));
      ({ data, error: rpcError } = await doAuth());
    }

    if (rpcError) {
      if (/timeout|canceling statement/i.test(rpcError.message)) {
        setError('Server sedang sibuk, coba login lagi sebentar lagi.');
        setSubmitting(false);
        return;
      }
      if (isMissingSupabaseFunctionError(rpcError, 'authenticate_app_user')) {
        const localSession = authenticateLocalUser(username, password);

        if (localSession) {
          onLoginSuccess(localSession);
          persistStoredSession(localSession, rememberMe);
          window.location.hash = redirectTo;
          setPassword('');
          setError('');
          setFieldErrors({});
          setSubmitting(false);
          return;
        }

        setError('fungsi login belum terpasang di Supabase. jalankan SQL auth lalu refresh schema cache.');
      } else {
        setError(rpcError.message);
      }
      setSubmitting(false);
      return;
    }

    const matchedUser = Array.isArray(data) ? data[0] : null;

    if (!matchedUser) {
      setError('username atau password salah.');
      setSubmitting(false);
      return;
    }

    const nextSession: AppSession = {
      username: matchedUser.username,
      displayName: matchedUser.display_name ?? matchedUser.username,
      role: matchedUser.role,
      createdAt: matchedUser.created_at,
    };

    onLoginSuccess(nextSession);
    persistStoredSession(nextSession, rememberMe);
    window.location.hash = redirectTo;
    setPassword('');
    setError('');
    setFieldErrors({});
    setSubmitting(false);
  };

  const handleSignUp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!validateSignUp()) {
      return;
    }

    setSubmitting(true);
    setError('');

    const { data, error: rpcError } = await supabase.rpc('register_app_user', {
      p_username: username.trim().toLowerCase(),
      p_display_name: displayName.trim() || username.trim().toLowerCase(),
      p_password: password,
    });

    if (rpcError) {
      if (isMissingSupabaseFunctionError(rpcError, 'register_app_user')) {
        try {
          const localSession = registerLocalUser(username, displayName, password);
          onLoginSuccess(localSession);
          persistStoredSession(localSession, true);
          window.location.hash = '#dashboard';
          setDisplayName('');
          setPassword('');
          setConfirmPassword('');
          setError('');
          setFieldErrors({});
          setSubmitting(false);
          return;
        } catch (localError) {
          setError(localError instanceof Error ? localError.message : 'gagal membuat akun baru.');
        }
      } else {
        setError(rpcError.message);
      }
      setSubmitting(false);
      return;
    }

    const result = Array.isArray(data) ? data[0] : data as Record<string, unknown> | null;

    // register_app_user returns { success, username } or legacy row format
    const registeredUsername = (result as { success?: boolean; username?: string })?.username
      ?? (result as { username?: string })?.username
      ?? null;

    if (!result || (result as { success?: boolean }).success === false) {
      setError((result as { error?: string })?.error ?? 'gagal membuat akun baru.');
      setSubmitting(false);
      return;
    }

    if (!registeredUsername) {
      setError('gagal membuat akun baru.');
      setSubmitting(false);
      return;
    }

    const nextSession: AppSession = {
      username: registeredUsername,
      displayName: (result as { display_name?: string })?.display_name ?? (displayName.trim() || registeredUsername),
      role: (result as { role?: string })?.role ?? 'user',
      createdAt: (result as { created_at?: string })?.created_at ?? new Date().toISOString(),
    };

    // Apply referral code bonus — re-validate in case user didn't blur the input
    const newUser = nextSession.username;
    let appliedReferralCredits = 0;
    let appliedReferralFeatures: string[] = [];
    const usedReferralCode = referralCode.trim().toUpperCase();
    if (referralCode.trim()) {
      const matchedReferral = referralStatus === 'valid' && referralMatched ? referralMatched : await validateReferralCode(referralCode);
      if (matchedReferral) {
        const codeType = matchedReferral.type ?? 'coin';
        if (codeType === 'coin' && matchedReferral.credits > 0) {
          appliedReferralCredits = matchedReferral.credits;
        } else if (codeType === 'feature' && matchedReferral.features && matchedReferral.features.length > 0) {
          appliedReferralFeatures = matchedReferral.features;
          const referralPerks: UserPerks = {};
          for (const f of matchedReferral.features) referralPerks[f as keyof UserPerks] = true;
          // Store as time-limited referral_perks (not permanent perks)
          await supabase.from('user_profiles').update({
            referral_perks: referralPerks,
            referral_perks_expires_at: matchedReferral.expiresAt ?? null,
          } as never).eq('username', newUser);
        }
        // Simpan kode referral yang digunakan ke profil user
        await supabase.from('user_profiles').update({ referral_code: usedReferralCode }).eq('username', newUser);
      }
    }
    if (appliedReferralCredits > 0) {
      const { data: existingCredits } = await supabase.from('user_credits').select('balance').eq('username', newUser).maybeSingle();
      const currentBalance = existingCredits?.balance ?? 0;
      await Promise.all([
        supabase.from('user_credits').upsert({ username: newUser, balance: currentBalance + appliedReferralCredits }),
        supabase.from('credit_transactions').insert({ username: newUser, amount: appliedReferralCredits, type: 'topup', description: `Bonus kode referral: ${usedReferralCode}` }),
      ]);
    }

    const featureNames: Record<string, string> = { free_video: 'Video', free_booking: 'Booking 1:1', free_thread: 'Thread', free_asset: 'Asset', free_event: 'Event' };
    const referralInfo = usedReferralCode
      ? appliedReferralCredits > 0
        ? `🎁 Kode referral: <b>${usedReferralCode}</b>\n💰 Bonus: +${appliedReferralCredits} Ruang Coin`
        : appliedReferralFeatures.length > 0
          ? `🎁 Kode referral: <b>${usedReferralCode}</b>\n🔓 Akses gratis: ${appliedReferralFeatures.map((f) => featureNames[f] ?? f).join(', ')}`
          : `🎁 Kode referral: <b>${usedReferralCode}</b>`
      : '🔗 Tidak menggunakan kode referral';

    void sendTelegram(`🙋 <b>User Baru Bergabung</b>\n\n👤 ${nextSession.displayName} (@${nextSession.username})\n📧 ${newUser}\n\n${referralInfo}`);
    onLoginSuccess(nextSession);
    persistStoredSession(nextSession, true);
    window.location.hash = '#dashboard';
    setDisplayName('');
    setPassword('');
    setConfirmPassword('');
    setReferralCode('');
    setReferralStatus('idle');
    setReferralMatched(null);
    setError('');
    setFieldErrors({});
    setSubmitting(false);
    // Tampilkan promo popup jika user baru tanpa referral
    if (appliedReferralCredits === 0) {
      void loadAdminSettings().then((s) => {
        const p = s.promo;
        if (p?.enabled && (p.target === 'new_users' || p.target === 'all_users')) {
          onShowPromo?.();
        }
      });
    }
  };

  if (session) {
    window.location.hash = '#dashboard';
    return null;
  }

  return (
    <section className="page login-page">
      <div className="login-split-card">

        {/* LEFT */}
        <div className="login-split-left">
          <div className="login-split-overlay">
            <img src={logo1} alt="ruang sosmed" className="login-split-logo" />
            <h1 className="login-split-tagline">ruang belajar<br/>sosial media</h1>
            <p className="login-split-desc">tingkatkan skill konten, strategi, dan performa sosial mediamu bersama komunitas.</p>
          </div>
        </div>

        {/* RIGHT */}
        <div className="login-split-right">
          <div className="login-split-form-wrap">
            <img src={logo1} alt="logo" className="login-form-logo" />
            <h2 className="login-form-title">{authMode === 'sign-in' ? 'welcome back!' : 'create account'}</h2>
            <p className="login-form-sub">
              {authMode === 'sign-in'
                ? 'masuk untuk melanjutkan ke dashboard, materi, calendar, dan community.'
                : 'buat akun untuk masuk ke ruang belajar ini. semua user baru akan mendapat role student.'}
            </p>

            {authMode === 'sign-in' ? (
              <form className="drawer-form login-form" onSubmit={handleSignIn}>
                <label>
                  username
                  <input
                    className={fieldErrors.username ? 'error' : ''}
                    value={username}
                    onChange={(event) => {
                      setUsername(event.target.value);
                      clearValidation();
                    }}
                    placeholder="masukkan username"
                    autoComplete="username"
                  />
                  {fieldErrors.username && <span className="field-error">{fieldErrors.username}</span>}
                </label>
                <label>
                  password
                  <div className="password-input-wrap">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      className={fieldErrors.password ? 'error' : ''}
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        clearValidation();
                      }}
                      placeholder="masukkan password"
                      autoComplete="current-password"
                    />
                    <button type="button" className="password-toggle" onClick={() => setShowPassword(v => !v)} tabIndex={-1}>
                      {showPassword ? (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                      ) : (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                      )}
                    </button>
                  </div>
                  {fieldErrors.password && <span className="field-error">{fieldErrors.password}</span>}
                </label>

                <div className="login-meta-row">
                </div>

                {error && <div className="form-error">{error}</div>}

                <div className="dialog-actions login-actions">
                  <button type="submit" className="button primary" disabled={submitting}>
                    {submitting ? 'memproses...' : 'sign in'}
                  </button>
                </div>
                <p className="login-switch-row">
                  belum punya akun?{' '}
                  <button type="button" className="login-switch-btn" onClick={() => { setAuthMode('sign-up'); clearValidation(); }}>
                    daftar sekarang
                  </button>
                </p>
              </form>
            ) : (
              <form className="drawer-form login-form" onSubmit={handleSignUp}>
                <label>
                  display name
                  <input
                    className={fieldErrors.displayName ? 'error' : ''}
                    value={displayName}
                    onChange={(event) => {
                      setDisplayName(event.target.value);
                      clearValidation();
                    }}
                    placeholder="nama kamu"
                    autoComplete="name"
                  />
                  {fieldErrors.displayName && <span className="field-error">{fieldErrors.displayName}</span>}
                </label>
                <label>
                  username
                  <input
                    className={fieldErrors.username ? 'error' : ''}
                    value={username}
                    onChange={(event) => {
                      setUsername(event.target.value);
                      clearValidation();
                    }}
                    placeholder="username"
                    autoComplete="username"
                  />
                  {fieldErrors.username && <span className="field-error">{fieldErrors.username}</span>}
                </label>
                <label>
                  password
                  <div className="password-input-wrap">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      className={fieldErrors.password ? 'error' : ''}
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        clearValidation();
                      }}
                      placeholder="masukkan password"
                      autoComplete="new-password"
                    />
                    <button type="button" className="password-toggle" onClick={() => setShowPassword(v => !v)} tabIndex={-1}>
                      {showPassword ? (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                      ) : (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                      )}
                    </button>
                  </div>
                  {fieldErrors.password && <span className="field-error">{fieldErrors.password}</span>}
                </label>
                <label>
                  confirm password
                  <div className="password-input-wrap">
                    <input
                      type={showConfirmPassword ? 'text' : 'password'}
                      className={fieldErrors.confirmPassword ? 'error' : ''}
                      value={confirmPassword}
                      onChange={(event) => {
                        setConfirmPassword(event.target.value);
                        clearValidation();
                      }}
                      placeholder="konfirmasi password"
                      autoComplete="new-password"
                    />
                    <button type="button" className="password-toggle" onClick={() => setShowConfirmPassword(v => !v)} tabIndex={-1}>
                      {showConfirmPassword ? (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                      ) : (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                      )}
                    </button>
                  </div>
                  {fieldErrors.confirmPassword && <span className="field-error">{fieldErrors.confirmPassword}</span>}
                </label>

                <label>
                  kode referral <span className="login-optional">(opsional)</span>
                  <div className="referral-input-wrap">
                    <input
                      className={referralStatus === 'invalid' ? 'error' : referralStatus === 'valid' ? 'valid' : ''}
                      value={referralCode}
                      onChange={(e) => { setReferralCode(e.target.value); setReferralStatus('idle'); }}
                      onBlur={() => void handleReferralBlur()}
                      placeholder="masukkan kode referral"
                      autoComplete="off"
                    />
                    {referralStatus === 'valid' && referralMatched && (
                      referralMatched.type === 'feature' && referralMatched.features && referralMatched.features.length > 0
                        ? <span className="referral-badge valid">✓ Akses gratis: {referralMatched.features.map((f) => ({ free_video: 'Video', free_booking: 'Booking', free_thread: 'Thread', free_asset: 'Asset', free_event: 'Event' }[f])).join(', ')}{referralMatched.expiresAt ? ` (s/d ${new Date(referralMatched.expiresAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })})` : ''}</span>
                        : <span className="referral-badge valid">✓ +{referralCredits} Ruang Coin gratis!</span>
                    )}
                  </div>
                  {referralStatus === 'invalid' && (
                    <span className="field-error">Kode referral tidak valid atau sudah kadaluarsa.</span>
                  )}
                </label>

                {error && <div className="form-error">{error}</div>}

                <div className="dialog-actions login-actions">
                  <button type="submit" className="button primary" disabled={submitting}>
                    {submitting ? 'memproses...' : 'create account'}
                  </button>
                </div>
                <p className="login-switch-row">
                  sudah punya akun?{' '}
                  <button type="button" className="login-switch-btn" onClick={() => { setAuthMode('sign-in'); clearValidation(); }}>
                    sign in
                  </button>
                </p>
              </form>
            )}
          </div>
        </div>

      </div>
    </section>
  );
}


const EMPTY_ADD_FORM = {
  title: '',
  note: '',
  event_date: todayDateString(),
  start_time: '09:00',
  end_time: '10:00',
  category: 'class' as CalendarEventRow['category'],
  accent: 'purple' as CalendarEventRow['accent'],
  attendee_count: '',
  location: '',
};

function CalendarPage({ canManage = false, sessionUsername = '', featureCosts = defaultFeatureCosts, userPerks = {}, onCreditChange, onInsufficientCredits, onRequestConfirm }: { canManage?: boolean; sessionUsername?: string; featureCosts?: FeatureCosts; userPerks?: UserPerks; onCreditChange?: (n: number) => void; onInsufficientCredits?: (feature: string, needed: number, balance: number) => void; onRequestConfirm?: (ctx: CreditConfirmContext) => void }) {
  const [calendarEventsData, , reloadCalendarEvents] = useCalendarEvents();
  const [hubEvents, setHubEvents] = useState<HubEvent[]>([]);
  const [calendarView, setCalendarView] = useState<'daily' | 'weekly' | 'monthly'>('monthly');
  const [calendarNow, setCalendarNow] = useState(() => new Date());
  const [checkedCalendarItems, setCheckedCalendarItems] = useState<Record<string, string>>({});
  const [selectedDate, setSelectedDate] = useState(() => todayDateString());
  const [popupEvent, setPopupEvent] = useState<{ event: CalendarEvent; anchorEl: HTMLElement } | null>(null);
  const [popupPos, setPopupPos] = useState({ x: 0, y: 0 });
  const [miniCalMonth, setMiniCalMonth] = useState(() => todayDateString().slice(0, 7));
  const todayString = todayDateString();

  const [addEventOpen, setAddEventOpen] = useState(false);
  const [addForm, setAddForm] = useState({ ...EMPTY_ADD_FORM });
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => { void loadHubEvents().then((evs) => setHubEvents(evs.filter((e) => e.isActive !== false))); }, []);

  // Personal checklist (stored in localStorage per user)
  const checklistStorageKey = `personal_checklist_${sessionUsername}`;
  const [personalChecklist, setPersonalChecklist] = useState<{ id: string; text: string; done: boolean }[]>(() => {
    try { return JSON.parse(localStorage.getItem(checklistStorageKey) ?? '[]'); } catch { return []; }
  });
  const [checklistInput, setChecklistInput] = useState('');

  function saveChecklist(next: typeof personalChecklist) {
    setPersonalChecklist(next);
    localStorage.setItem(checklistStorageKey, JSON.stringify(next));
  }

  function addChecklistItem() {
    const text = checklistInput.trim();
    if (!text) return;
    saveChecklist([...personalChecklist, { id: crypto.randomUUID(), text, done: false }]);
    setChecklistInput('');
  }

  function toggleChecklistItem(id: string) {
    saveChecklist(personalChecklist.map((item) => item.id === id ? { ...item, done: !item.done } : item));
  }

  function removeChecklistItem(id: string) {
    saveChecklist(personalChecklist.filter((item) => item.id !== id));
  }

  // ── Book 1:1 ─────────────────────────────────────────────────
  const [bookOpen, setBookOpen] = useState(false);
  const [bookForm, setBookForm] = useState({ topic: '', preferred_date: '', preferred_time: '10:00', note: '' });
  const [bookSubmitting, setBookSubmitting] = useState(false);
  const [bookError, setBookError] = useState<string | null>(null);
  const [bookSuccess, setBookSuccess] = useState(false);

  function openBook() {
    setBookForm({ topic: '', preferred_date: selectedDate, preferred_time: '10:00', note: '' });
    setBookError(null);
    setBookSuccess(false);
    setBookOpen(true);
  }

  async function doBookSubmit() {
    setBookSubmitting(true);
    setBookError(null);

    const cost = featureCosts.book_1on1;
    if (cost > 0 && !canManage) {
      const deduct = await deductCredits(sessionUsername, cost, `Booking 1:1: ${bookForm.topic.trim()}`, 'book_1on1');
      if (!deduct.ok) {
        setBookSubmitting(false);
        onInsufficientCredits?.('Book Sesi 1:1', deduct.needed ?? cost, deduct.balance ?? 0);
        return;
      }
      if (deduct.newBalance !== undefined) onCreditChange?.(deduct.newBalance);
    }

    const { error } = await supabase.from('one_on_one_bookings').insert([{
      requester_username: sessionUsername,
      topic: bookForm.topic.trim(),
      preferred_date: bookForm.preferred_date,
      preferred_time: bookForm.preferred_time,
      note: bookForm.note.trim(),
      status: 'pending',
    }]);

    setBookSubmitting(false);
    if (error) { setBookError('Gagal mengirim booking. Coba lagi.'); return; }
    const { data: bookRow } = await supabase.from('one_on_one_bookings').select('id').eq('requester_username', sessionUsername).order('created_at', { ascending: false }).limit(1).single();
    const fullBookId = (bookRow as { id?: string } | null)?.id ?? '';
    const shortBookId = fullBookId.slice(0, 8);
    void sendTelegram(
      `📅 <b>Jadwal 1:1 Ditambahkan — Butuh Approval</b>\n\n👤 @${sessionUsername}\n📌 Topik: ${bookForm.topic.trim()}\n🗓 Tanggal: ${bookForm.preferred_date}\n⏰ Waktu: ${bookForm.preferred_time.slice(0, 5)}${bookForm.note.trim() ? `\n📝 Catatan: ${bookForm.note.trim()}` : ''}\n🆔 ID: <code>${shortBookId}</code>`,
      [[{ text: '✅ Approve', callback_data: `ab:${fullBookId}` }]]
    );
    setBookSuccess(true);
  }

  function handleBookSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!bookForm.topic.trim()) { setBookError('Topik wajib diisi.'); return; }
    if (!bookForm.preferred_date) { setBookError('Tanggal wajib diisi.'); return; }
    const cost = featureCosts.book_1on1;
    const bookingFree = userPerks.credit_exempt || userPerks.free_booking;
    if (cost > 0 && !canManage && !bookingFree && onRequestConfirm) {
      onRequestConfirm({
        feature: 'Book Sesi 1:1',
        cost,
        onConfirm: () => { void doBookSubmit(); },
      });
    } else {
      void doBookSubmit();
    }
  }

  function openAddEvent() {
    setAddForm({ ...EMPTY_ADD_FORM, event_date: selectedDate });
    setAddError(null);
    setAddEventOpen(true);
  }

  function closeAddEvent() {
    setAddEventOpen(false);
  }

  async function handleAddEventSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!addForm.title.trim()) { setAddError('Nama event wajib diisi.'); return; }
    if (!addForm.event_date) { setAddError('Tanggal wajib diisi.'); return; }
    if (addForm.start_time >= addForm.end_time) { setAddError('Waktu selesai harus setelah waktu mulai.'); return; }

    setAddSubmitting(true);
    setAddError(null);

    const payload = {
      title: addForm.title.trim(),
      note: [addForm.note.trim(), addForm.location.trim() ? `📍 ${addForm.location.trim()}` : ''].filter(Boolean).join('\n'),
      event_date: addForm.event_date,
      start_time: addForm.start_time,
      end_time: addForm.end_time,
      category: addForm.category,
      accent: addForm.accent,
      attendee_count: addForm.attendee_count === '' ? 0 : Number(addForm.attendee_count),
      is_done: false,
      sort_order: 0,
    };

    const { error } = await supabase.from('calendar_events').insert([payload]);

    if (error) {
      setAddError('Gagal menyimpan event. Coba lagi.');
      setAddSubmitting(false);
      return;
    }

    setAddSubmitting(false);
    setAddEventOpen(false);
    setSelectedDate(addForm.event_date);
    reloadCalendarEvents();
  }

  // ── Edit event ────────────────────────────────
  const [editEventOpen, setEditEventOpen] = useState(false);
  const [editEventId, setEditEventId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ ...EMPTY_ADD_FORM });
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  function openEditEvent(event: CalendarEvent) {
    const noteLines = event.note.split('\n');
    const locationLine = noteLines.find((l) => l.startsWith('📍 ')) ?? '';
    const plainNote = noteLines.filter((l) => !l.startsWith('📍 ')).join('\n');
    setEditForm({
      title: event.title,
      note: plainNote,
      event_date: event.eventDate,
      start_time: event.startTime.slice(0, 5),
      end_time: event.endTime.slice(0, 5),
      category: event.category,
      accent: event.accent,
      attendee_count: event.attendeeCount === 0 ? '' : String(event.attendeeCount),
      location: locationLine.replace('📍 ', ''),
    });
    setEditEventId(event.id);
    setEditError(null);
    setEditEventOpen(true);
    setPopupEvent(null);
  }

  async function handleEditEventSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editForm.title.trim()) { setEditError('Nama event wajib diisi.'); return; }
    if (!editForm.event_date) { setEditError('Tanggal wajib diisi.'); return; }
    if (editForm.start_time >= editForm.end_time) { setEditError('Waktu selesai harus setelah waktu mulai.'); return; }

    setEditSubmitting(true);
    setEditError(null);

    const payload = {
      title: editForm.title.trim(),
      note: [editForm.note.trim(), editForm.location.trim() ? `📍 ${editForm.location.trim()}` : ''].filter(Boolean).join('\n'),
      event_date: editForm.event_date,
      start_time: editForm.start_time,
      end_time: editForm.end_time,
      category: editForm.category,
      accent: editForm.accent,
      attendee_count: editForm.attendee_count === '' ? 0 : Number(editForm.attendee_count),
    };

    const { error } = await supabase.from('calendar_events').update(payload).eq('id', editEventId!);

    if (error) {
      setEditError('Gagal menyimpan perubahan. Coba lagi.');
      setEditSubmitting(false);
      return;
    }

    setEditSubmitting(false);
    setEditEventOpen(false);
    setEditEventId(null);
    setSelectedDate(editForm.event_date);
    reloadCalendarEvents();
  }

  // ── Delete event ──────────────────────────────
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);

  function openDeleteConfirm(event: CalendarEvent) {
    setDeleteConfirmId(event.id);
    setPopupEvent(null);
  }

  async function handleDeleteEvent() {
    if (!deleteConfirmId) return;
    setDeleteSubmitting(true);
    if (deleteConfirmId.startsWith('booking-')) {
      const realId = deleteConfirmId.replace('booking-', '');
      await supabase.from('one_on_one_bookings').delete().eq('id', realId);
    } else {
      await supabase.from('calendar_events').delete().eq('id', deleteConfirmId);
    }
    setDeleteSubmitting(false);
    setDeleteConfirmId(null);
    reloadCalendarEvents();
  }

  function navigateCalendar(direction: -1 | 1) {
    setSelectedDate((prev) => {
      if (calendarView === 'daily') return addDaysToDate(prev, direction);
      if (calendarView === 'weekly') return addDaysToDate(prev, direction * 7);
      const d = new Date(`${prev}T00:00:00`);
      d.setMonth(d.getMonth() + direction);
      return toLocalDateKey(d);
    });
  }
  const weekDates = weekDatesFromDate(selectedDate);
  const monthDates = monthDatesFromDate(selectedDate);
  const visibleTimelineDates = calendarView === 'daily' ? [new Date(`${selectedDate}T00:00:00`)] : weekDates;
  const visibleTimelineDateKeys = new Set(visibleTimelineDates.map(dateKeyFromDate));
  const weekDateKeys = new Set(weekDates.map(dateKeyFromDate));
  const selectedMonth = selectedDate.slice(0, 7);
  const selectedDay = new Date(`${selectedDate}T00:00:00`).getDate();
  const visibleCalendarEvents = calendarEventsData.filter((event) => {
    if (calendarView === 'daily') {
      return event.eventDate === selectedDate;
    }

    if (calendarView === 'weekly') {
      return weekDateKeys.has(event.eventDate);
    }

    return event.eventDate.startsWith(selectedMonth);
  });
  const primaryEvents = visibleCalendarEvents.slice(0, 3);
  const timelineEvents = visibleCalendarEvents.filter((event) => visibleTimelineDateKeys.has(event.eventDate));
  const currentMinutes = calendarNow.getHours() * 60 + calendarNow.getMinutes() + calendarNow.getSeconds() / 60;
  const timelineTotalMinutes = 240;
  const timelineStartMinutes = currentMinutes - 80; // keep indicator ~33% from top, may be negative (pre-midnight)
  const windowEndMinutes = timelineStartMinutes + timelineTotalMinutes;
  const firstHour = Math.ceil(Math.max(0, timelineStartMinutes) / 60);
  const lastHour = Math.floor(Math.min(1439, windowEndMinutes) / 60);
  const timelineHours = Array.from({ length: Math.max(0, lastHour - firstHour + 1) }, (_, i) => firstHour + i)
    .filter((h) => h >= 0 && h <= 23 && h * 60 >= timelineStartMinutes && h * 60 <= windowEndMinutes);
  const currentLineTop = ((currentMinutes - timelineStartMinutes) / timelineTotalMinutes) * 100;
  const shouldShowCurrentLine = true;

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setCalendarNow(new Date());
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  const toggleCalendarChecklist = (eventId: string) => {
    setCheckedCalendarItems((current) => {
      const next = { ...current };
      if (next[eventId]) {
        delete next[eventId];
      } else {
        next[eventId] = todayString;
      }
      return next;
    });
  };

  const openEventPopup = (event: CalendarEvent, e: React.MouseEvent) => {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    setPopupPos({ x: Math.min(rect.right + 8, window.innerWidth - 320), y: Math.max(8, Math.min(rect.top, window.innerHeight - 260)) });
    setPopupEvent({ event, anchorEl: el });
  };

  useEffect(() => {
    if (!popupEvent) return;
    const update = () => {
      const rect = popupEvent.anchorEl.getBoundingClientRect();
      setPopupPos({ x: Math.min(rect.right + 8, window.innerWidth - 320), y: Math.max(8, Math.min(rect.top, window.innerHeight - 260)) });
    };
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [popupEvent]);

  return (
    <>
    <section className="calendar-redesign">
      <div className="calendar-redesign-hero">
        <div className="calendar-redesign-title">
          <h2>My Calendar</h2>
          <p>atur jadwal kelas, zoom meeting, reminder, dan agenda belajar social media.</p>
        </div>
        <div className="calendar-redesign-stats">
          <div className="calendar-view-toggle" aria-label="pilih tampilan kalender">
            {(['daily', 'weekly', 'monthly'] as const).map((view) => (
              <button
                type="button"
                className={calendarView === view ? 'active' : ''}
                onClick={() => setCalendarView(view)}
                key={view}
              >
                {view}
              </button>
            ))}
          </div>
          <button type="button" className="calendar-book-button" onClick={openBook}>
            book 1:1
          </button>
        </div>
      </div>

      <div className="calendar-redesign-layout">
        <aside className="calendar-redesign-sidebar">
          <article className="mini-month-card">
            <div className="mini-month-head">
              <strong>{formatCalendarMonth(`${miniCalMonth}-01`)}</strong>
              <div>
                <button type="button" onClick={() => setMiniCalMonth((m) => { const d = new Date(`${m}-01T00:00:00`); d.setMonth(d.getMonth() - 1); return toLocalDateKey(d).slice(0, 7); })}>‹</button>
                <button type="button" onClick={() => setMiniCalMonth((m) => { const d = new Date(`${m}-01T00:00:00`); d.setMonth(d.getMonth() + 1); return toLocalDateKey(d).slice(0, 7); })}>›</button>
              </div>
            </div>
            <div className="mini-month-grid">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => (
                <span className="mini-month-day" key={day}>{day}</span>
              ))}
              {monthDatesFromDate(`${miniCalMonth}-15`).map((date, idx) => {
                const dateKey = toLocalDateKey(date);
                const inMonth = dateKey.startsWith(miniCalMonth);
                const day = date.getDate();
                const isActive = dateKey === selectedDate;
                const isToday = dateKey === todayString;
                const hasEvent = calendarEventsData.some((ev) => ev.eventDate === dateKey);
                if (!inMonth) {
                  return <span key={`pad-${idx}`} className="mini-month-date outside" />;
                }
                return (
                  <span
                    className={`mini-month-date ${isActive ? 'active' : ''} ${isToday && !isActive ? 'today' : ''} ${hasEvent ? 'has-event' : ''}`}
                    key={dateKey}
                    onClick={() => setSelectedDate(dateKey)}
                    style={{ cursor: 'pointer' }}
                  >
                    {day}
                  </span>
                );
              })}
            </div>
          </article>

          <article className="calendar-check-card">
            <div className="calendar-card-head">
              <h3>my checklist</h3>
              <span>{todayString}</span>
            </div>
            <div className="calendar-checklist-input-row">
              <input
                type="text"
                className="calendar-checklist-input"
                placeholder="Tambah item..."
                value={checklistInput}
                onChange={(e) => setChecklistInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addChecklistItem(); } }}
              />
              <button type="button" className="calendar-checklist-add-btn" onClick={addChecklistItem}>+</button>
            </div>
            <div className="calendar-check-list">
              {personalChecklist.length === 0 && (
                <p className="calendar-checklist-empty">Belum ada item. Tambah di atas!</p>
              )}
              {personalChecklist.map((item) => (
                <div key={item.id} className="calendar-check-item">
                  <button
                    type="button"
                    className={`calendar-check-tick ${item.done ? 'checked' : ''}`}
                    onClick={() => toggleChecklistItem(item.id)}
                  >
                    {item.done ? '✓' : ''}
                  </button>
                  <div className="calendar-check-item-meta" style={{ flex: 1 }}>
                    <strong className={item.done ? 'done' : ''}>{item.text}</strong>
                  </div>
                  <button type="button" className="calendar-checklist-remove-btn" onClick={() => removeChecklistItem(item.id)}>✕</button>
                </div>
              ))}
            </div>
          </article>
        </aside>

        <article className="calendar-board">
          <div className="calendar-board-head">
            <strong>{calendarView === 'monthly' ? formatCalendarMonth(selectedDate) : formatShortDate(selectedDate)}</strong>
            <div>
              <button type="button" onClick={() => setSelectedDate(todayDateString())}>Today</button>
              <button type="button" onClick={() => navigateCalendar(-1)}>‹</button>
              <button type="button" onClick={() => navigateCalendar(1)}>›</button>
            </div>
          </div>

          {calendarView === 'monthly' ? (
            <div className="calendar-month-board">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => (
                <div className="calendar-month-day-head" key={day}>{day}</div>
              ))}
              {monthDates.map((date) => {
                const dateKey = dateKeyFromDate(date);
                const dateEvents = calendarEventsData.filter((event) => event.eventDate === dateKey);
                const dateHubEvents = hubEvents.filter((e) => e.date === dateKey);
                const isCurrentMonth = dateKey.startsWith(selectedMonth);
                const isSelected = dateKey === selectedDate;
                const isToday = dateKey === todayString;
                const totalSlots = dateEvents.length + dateHubEvents.length;

                return (
                  <div className={`calendar-month-cell ${isCurrentMonth ? '' : 'muted'} ${isSelected ? 'active' : ''} ${isToday && !isSelected ? 'today' : ''}`} key={dateKey}>
                    <span>{date.getDate()}</span>
                    <div className="calendar-month-events">
                      {dateEvents.slice(0, Math.max(0, 3 - dateHubEvents.length)).map((event) => (
                        <div className={`calendar-month-event ${event.accent}`} key={event.id} onClick={(e) => { e.stopPropagation(); openEventPopup(event, e); }} style={{ cursor: 'pointer' }}>
                          <strong>{event.title}</strong>
                          <small>{formatClockRange(event.startTime, event.endTime)}</small>
                        </div>
                      ))}
                      {dateHubEvents.slice(0, 3).map((ev) => (
                        <a key={ev.id} href="#events" className="calendar-month-event calendar-hub-event" onClick={(e) => { if (canManage) { e.preventDefault(); sessionStorage.setItem('edit_hub_event_id', ev.id); window.location.hash = '#events'; } }}>
                          <strong>{({ zoom: '📹', video: '🎬', other: '📌' } as const)[ev.type]} {ev.title}</strong>
                          {ev.time && <small>{ev.time}</small>}
                        </a>
                      ))}
                      {totalSlots > 3 && <em>+{totalSlots - 3} lainnya</em>}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <>
              <div
                className={`calendar-week-row ${calendarView === 'daily' ? 'daily' : 'weekly'}`}
                style={{ '--calendar-columns': visibleTimelineDates.length } as CSSProperties}
              >
                <span>GMT+8</span>
                {visibleTimelineDates.map((date) => (
                  <div className={dateKeyFromDate(date) === selectedDate ? 'active' : ''} key={date.toISOString()}>
                    <strong>{String(date.getDate()).padStart(2, '0')}</strong>
                    <span>{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()]}</span>
                  </div>
                ))}
              </div>

              <div
                className={`calendar-timeline ${calendarView === 'daily' ? 'daily' : 'weekly'}`}
                style={{ '--calendar-columns': visibleTimelineDates.length } as CSSProperties}
              >
                {timelineHours.map((hour) => {
                  const topPct = ((hour * 60 - timelineStartMinutes) / timelineTotalMinutes) * 100;
                  return (
                    <div className="calendar-time-row" style={{ top: `${topPct}%` }} key={hour}>
                      <span>{formatTimelineHour(hour)}</span>
                      <div className="calendar-row-line" />
                    </div>
                  );
                })}
                {shouldShowCurrentLine && (
                  <div className="calendar-now-line" style={{ top: `${currentLineTop}%` }}>
                    <span>{formatCurrentClock(calendarNow)}</span>
                  </div>
                )}
                {hubEvents.filter((e) => visibleTimelineDates.some((d) => dateKeyFromDate(d) === e.date)).map((ev) => {
                  const dateIndex = Math.max(0, visibleTimelineDates.findIndex((d) => dateKeyFromDate(d) === ev.date));
                  const startMin = ev.time ? timeToMinutes(ev.time) : timelineStartMinutes + 60;
                  const top = ((startMin - timelineStartMinutes) / timelineTotalMinutes) * 100;
                  const contentLeft = 13;
                  const contentWidth = 83;
                  const columnWidth = contentWidth / visibleTimelineDates.length;
                  const left = contentLeft + dateIndex * columnWidth;
                  return (
                    <a
                      href="#events"
                      className="calendar-event-chip purple calendar-hub-chip"
                      style={{ '--event-left': `${left}%`, '--event-top': `${top}%`, '--event-width': `${columnWidth}%`, '--event-height': '8%' } as CSSProperties}
                      key={ev.id}
                      onClick={(e) => { if (canManage) { e.preventDefault(); sessionStorage.setItem('edit_hub_event_id', ev.id); window.location.hash = '#events'; } }}
                    >
                      <strong>{({ zoom: '📹', video: '🎬', other: '📌' } as const)[ev.type]} {ev.title}</strong>
                      {ev.time && <span>{ev.time}</span>}
                    </a>
                  );
                })}
                {timelineEvents.map((event) => {
                  const dateIndex = Math.max(0, visibleTimelineDates.findIndex((date) => dateKeyFromDate(date) === event.eventDate));
                  const top = ((timeToMinutes(event.startTime) - timelineStartMinutes) / timelineTotalMinutes) * 100;
                  const height = Math.max(8, ((timeToMinutes(event.endTime) - timeToMinutes(event.startTime)) / timelineTotalMinutes) * 100);
                  const contentLeft = 13;
                  const contentWidth = 83;
                  const columnWidth = contentWidth / visibleTimelineDates.length;
                  const left = contentLeft + dateIndex * columnWidth;

                  return (
                    <div
                      className={`calendar-event-chip ${event.accent}`}
                      style={{
                        '--event-left': `${left}%`,
                        '--event-top': `${top}%`,
                        '--event-width': `${columnWidth}%`,
                        '--event-height': typeof height === 'number' ? `${height}%` : height,
                        cursor: 'pointer',
                      } as CSSProperties}
                      key={event.id}
                      onClick={(e) => openEventPopup(event, e)}
                    >
                      <strong>{event.title}</strong>
                      <span>{formatClockRange(event.startTime, event.endTime)}</span>
                      <small>{event.attendeeCount}+ peserta</small>
                    </div>
                  );
                })}
              </div>
            </>
          )}

        </article>
      </div>

      {popupEvent && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 998 }} onClick={() => setPopupEvent(null)} />
          <div
            className="calendar-event-popup"
            style={{ left: popupPos.x, top: popupPos.y }}
          >
            <div className="calendar-event-popup-title">
              <strong>{popupEvent.event.title}</strong>
              <button type="button" onClick={() => setPopupEvent(null)}>✕</button>
            </div>
            <div className="calendar-event-popup-row">
              <div className={`calendar-event-popup-dot ${popupEvent.event.accent}`} />
              <span>{popupEvent.event.category}</span>
            </div>
            <div className="calendar-event-popup-row">
              <span>🕐</span>
              <span>{formatClockRange(popupEvent.event.startTime, popupEvent.event.endTime)}</span>
            </div>
            <div className="calendar-event-popup-row">
              <span>📅</span>
              <span>{popupEvent.event.eventDate}</span>
            </div>
            <div className="calendar-event-popup-row">
              <span>👥</span>
              <span>{popupEvent.event.attendeeCount}+ peserta</span>
            </div>
            {popupEvent.event.note && (
              <div className="calendar-event-popup-row">
                <span>📝</span>
                <span>{popupEvent.event.note}</span>
              </div>
            )}
            {canManage && (!popupEvent.event.id.startsWith('booking-') || canManage) && (
              <div className="calendar-event-popup-actions">
                {!popupEvent.event.id.startsWith('booking-') && (
                  <button type="button" className="popup-action-edit" onClick={() => openEditEvent(popupEvent.event)}>edit</button>
                )}
                <button type="button" className="popup-action-delete" onClick={() => openDeleteConfirm(popupEvent.event)}>hapus</button>
              </div>
            )}
          </div>
        </>
      )}
    </section>
    {addEventOpen && createPortal(<div className="aem-overlay" onClick={closeAddEvent}>
        <div className="aem-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="tambah event">
          <div className="aem-hero">
            <div className="aem-hero-icon">📅</div>
            <div className="aem-hero-text">
              <input
                className="aem-title-input"
                id="ae-title"
                type="text"
                placeholder="Nama event..."
                value={addForm.title}
                onChange={(e) => setAddForm((f) => ({ ...f, title: e.target.value }))}
                required
                autoFocus
              />
              <span className="aem-subtitle">tambah event baru</span>
            </div>
            <button type="button" className="aem-close" onClick={closeAddEvent}>✕</button>
          </div>

          <form className="aem-form" onSubmit={handleAddEventSubmit}>
            <p className="aem-section-label">Tanggal &amp; Waktu</p>

            <div className="aem-field-box">
              <span className="aem-field-icon">📅</span>
              <input
                id="ae-date"
                type="date"
                className="aem-input aem-input-full"
                value={addForm.event_date}
                onChange={(e) => setAddForm((f) => ({ ...f, event_date: e.target.value }))}
                required
              />
            </div>

            <div className="aem-time-row">
              <div className="aem-field-box aem-field-box--time">
                <span className="aem-field-icon">🕐</span>
                <input id="ae-start" type="time" className="aem-input" value={addForm.start_time} onChange={(e) => setAddForm((f) => ({ ...f, start_time: e.target.value }))} required />
              </div>
              <span className="aem-time-arrow">→</span>
              <div className="aem-field-box aem-field-box--time">
                <input id="ae-end" type="time" className="aem-input" value={addForm.end_time} onChange={(e) => setAddForm((f) => ({ ...f, end_time: e.target.value }))} required />
              </div>
            </div>

            <p className="aem-section-label">Detail</p>

            <div className="aem-two-col">
              <div className="aem-field-stack">
                <label className="aem-mini-label" htmlFor="ae-category">Kategori</label>
                <div className="aem-field-box">
                  <select id="ae-category" className="aem-input" value={addForm.category} onChange={(e) => setAddForm((f) => ({ ...f, category: e.target.value as CalendarEventRow['category'] }))}>
                    <option value="class">📚 Class</option>
                    <option value="review">🔍 Review</option>
                    <option value="qna">💬 QnA</option>
                    <option value="reminder">🔔 Reminder</option>
                  </select>
                </div>
              </div>
              <div className="aem-field-stack">
                <label className="aem-mini-label" htmlFor="ae-accent">Warna</label>
                <div className="aem-field-box">
                  <select id="ae-accent" className="aem-input" value={addForm.accent} onChange={(e) => setAddForm((f) => ({ ...f, accent: e.target.value as CalendarEventRow['accent'] }))}>
                    <option value="purple">🟣 Purple</option>
                    <option value="lime">🟢 Lime</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="aem-field-stack">
              <label className="aem-mini-label" htmlFor="ae-attendee">Jumlah Peserta</label>
              <div className="aem-field-box">
                <span className="aem-field-icon">👥</span>
                <input id="ae-attendee" type="number" min="0" placeholder="0" className="aem-input" value={addForm.attendee_count} onChange={(e) => setAddForm((f) => ({ ...f, attendee_count: e.target.value }))} />
              </div>
            </div>

            <p className="aem-section-label">Lokasi</p>

            <div className="aem-field-box">
              <span className="aem-field-icon">📍</span>
              <input id="ae-location" type="text" placeholder="Tambah lokasi atau link meeting..." className="aem-input aem-input-full" value={addForm.location} onChange={(e) => setAddForm((f) => ({ ...f, location: e.target.value }))} />
            </div>

            <div className="aem-field-box aem-field-box--textarea">
              <span className="aem-field-icon">📝</span>
              <textarea id="ae-note" placeholder="Tambah deskripsi atau catatan..." className="aem-input" rows={3} value={addForm.note} onChange={(e) => setAddForm((f) => ({ ...f, note: e.target.value }))} />
            </div>

            {addError && <p className="aem-error">{addError}</p>}

            <div className="aem-actions">
              <button type="button" className="aem-btn-cancel" onClick={closeAddEvent}>Batal</button>
              <button type="submit" className="aem-btn-submit" disabled={addSubmitting}>
                {addSubmitting ? 'Menyimpan…' : 'Simpan Event'}
              </button>
            </div>
          </form>
        </div>
      </div>, document.body)}

    {/* ── Edit Event Modal ── */}
    {editEventOpen && createPortal(<div className="aem-overlay" onClick={() => setEditEventOpen(false)}>
        <div className="aem-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="edit event">
          <div className="aem-hero">
            <div className="aem-hero-icon">✏️</div>
            <div className="aem-hero-text">
              <input className="aem-title-input" id="ee-title" type="text" placeholder="Nama event..." value={editForm.title} onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))} required autoFocus />
              <span className="aem-subtitle">edit event</span>
            </div>
            <button type="button" className="aem-close" onClick={() => setEditEventOpen(false)}>✕</button>
          </div>
          <form className="aem-form" onSubmit={handleEditEventSubmit}>
            <p className="aem-section-label">Tanggal &amp; Waktu</p>
            <div className="aem-field-box">
              <span className="aem-field-icon">📅</span>
              <input id="ee-date" type="date" className="aem-input aem-input-full" value={editForm.event_date} onChange={(e) => setEditForm((f) => ({ ...f, event_date: e.target.value }))} required />
            </div>
            <div className="aem-time-row">
              <div className="aem-field-box aem-field-box--time">
                <span className="aem-field-icon">🕐</span>
                <input id="ee-start" type="time" className="aem-input" value={editForm.start_time} onChange={(e) => setEditForm((f) => ({ ...f, start_time: e.target.value }))} required />
              </div>
              <span className="aem-time-arrow">→</span>
              <div className="aem-field-box aem-field-box--time">
                <input id="ee-end" type="time" className="aem-input" value={editForm.end_time} onChange={(e) => setEditForm((f) => ({ ...f, end_time: e.target.value }))} required />
              </div>
            </div>
            <p className="aem-section-label">Detail</p>
            <div className="aem-two-col">
              <div className="aem-field-stack">
                <label className="aem-mini-label" htmlFor="ee-category">Kategori</label>
                <div className="aem-field-box">
                  <select id="ee-category" className="aem-input" value={editForm.category} onChange={(e) => setEditForm((f) => ({ ...f, category: e.target.value as CalendarEventRow['category'] }))}>
                    <option value="class">📚 Class</option>
                    <option value="review">🔍 Review</option>
                    <option value="qna">💬 QnA</option>
                    <option value="reminder">🔔 Reminder</option>
                  </select>
                </div>
              </div>
              <div className="aem-field-stack">
                <label className="aem-mini-label" htmlFor="ee-accent">Warna</label>
                <div className="aem-field-box">
                  <select id="ee-accent" className="aem-input" value={editForm.accent} onChange={(e) => setEditForm((f) => ({ ...f, accent: e.target.value as CalendarEventRow['accent'] }))}>
                    <option value="purple">🟣 Purple</option>
                    <option value="lime">🟢 Lime</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="aem-field-stack">
              <label className="aem-mini-label" htmlFor="ee-attendee">Jumlah Peserta</label>
              <div className="aem-field-box">
                <span className="aem-field-icon">👥</span>
                <input id="ee-attendee" type="number" min="0" className="aem-input" value={editForm.attendee_count} onChange={(e) => setEditForm((f) => ({ ...f, attendee_count: e.target.value }))} />
              </div>
            </div>
            <p className="aem-section-label">Lokasi</p>
            <div className="aem-field-box">
              <span className="aem-field-icon">📍</span>
              <input id="ee-location" type="text" placeholder="Tambah lokasi atau link meeting..." className="aem-input aem-input-full" value={editForm.location} onChange={(e) => setEditForm((f) => ({ ...f, location: e.target.value }))} />
            </div>
            <div className="aem-field-box aem-field-box--textarea">
              <span className="aem-field-icon">📝</span>
              <textarea id="ee-note" placeholder="Tambah deskripsi atau catatan..." className="aem-input" rows={3} value={editForm.note} onChange={(e) => setEditForm((f) => ({ ...f, note: e.target.value }))} />
            </div>
            {editError && <p className="aem-error">{editError}</p>}
            <div className="aem-actions">
              <button type="button" className="aem-btn-cancel" onClick={() => setEditEventOpen(false)}>Batal</button>
              <button type="submit" className="aem-btn-submit" disabled={editSubmitting}>
                {editSubmitting ? 'Menyimpan…' : 'Simpan Perubahan'}
              </button>
            </div>
          </form>
        </div>
      </div>, document.body)}

    {/* ── Book 1:1 Modal ── */}
    {bookOpen && createPortal(
      <div className="aem-overlay" onClick={() => setBookOpen(false)}>
        <div className="aem-modal booking-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="book sesi 1:1">
          <div className="aem-hero">
            <div className="aem-hero-text">
              <span className="aem-title-static">Book Sesi 1:1</span>
              <span className="aem-subtitle">ajukan sesi konsultasi langsung</span>
            </div>
            <button type="button" className="aem-close" onClick={() => setBookOpen(false)}>✕</button>
          </div>

          {bookSuccess ? (
            <div className="booking-success">
              <h3>Booking Terkirim!</h3>
              <p>Permintaan sesi 1:1 kamu sudah diterima. Admin akan segera mengkonfirmasi dan jadwal akan muncul di kalender.</p>
              <p className="booking-success-wa-label">Konfirmasi booking kamu via WhatsApp agar diproses lebih cepat:</p>
              <a
                href={`https://wa.me/6289619941101?text=${encodeURIComponent(`Halo Kak, saya mau konfirmasi booking Sesi 1:1 di Ruang Sosmed Learning Hub 🙏\n\nTopik: ${bookForm.topic}\nTanggal: ${bookForm.preferred_date}\nJam: ${bookForm.preferred_time}${bookForm.note ? `\nCatatan: ${bookForm.note}` : ''}\n\nMohon dikonfirmasi ya Kak, terima kasih! 😊`)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="aem-btn-wa"
              >
                💬 Konfirmasi via WhatsApp
              </a>
              <button type="button" className="aem-btn-submit" onClick={() => setBookOpen(false)}>Tutup</button>
            </div>
          ) : (
            <form className="aem-form" onSubmit={handleBookSubmit}>
              <p className="aem-section-label">Topik Sesi</p>
              <div className="aem-field-box">
                <input
                  type="text"
                  className="aem-input aem-input-full"
                  placeholder="Misal: Review konten Instagram, strategi TikTok..."
                  value={bookForm.topic}
                  onChange={(e) => setBookForm((f) => ({ ...f, topic: e.target.value }))}
                  required
                  autoFocus
                />
              </div>

              <p className="aem-section-label">Preferensi Jadwal</p>
              <div className="aem-time-row">
                <div className="aem-field-box" style={{ flex: 2 }}>
                  <input
                    type="date"
                    className="aem-input aem-input-full"
                    value={bookForm.preferred_date}
                    onChange={(e) => setBookForm((f) => ({ ...f, preferred_date: e.target.value }))}
                    required
                  />
                </div>
                <div className="aem-field-box aem-field-box--time">
                  <input
                    type="time"
                    className="aem-input"
                    value={bookForm.preferred_time}
                    onChange={(e) => setBookForm((f) => ({ ...f, preferred_time: e.target.value }))}
                    required
                  />
                </div>
              </div>

              <p className="aem-section-label">Catatan (opsional)</p>
              <div className="aem-field-box aem-field-box--textarea">
                <textarea
                  className="aem-input"
                  placeholder="Ceritakan lebih detail apa yang ingin dibahas..."
                  rows={3}
                  value={bookForm.note}
                  onChange={(e) => setBookForm((f) => ({ ...f, note: e.target.value }))}
                />
              </div>

              {/* Info biaya booking */}
              {!canManage && (() => {
                const cost = featureCosts.book_1on1;
                const isFree = userPerks.credit_exempt || userPerks.free_booking || cost === 0;
                return (
                  <div className={`booking-cost-info ${isFree ? 'free' : ''}`}>
                    <CoinIcon size={15} />
                    {isFree
                      ? <span>Booking sesi 1:1 <strong>gratis</strong> untuk akun kamu</span>
                      : <span>Booking ini akan memotong <strong>{cost} Ruang Coin</strong> dari saldo kamu</span>
                    }
                  </div>
                );
              })()}

              {bookError && <p className="aem-error">{bookError}</p>}

              <div className="aem-actions">
                <button type="button" className="aem-btn-cancel" onClick={() => setBookOpen(false)}>Batal</button>
                <button type="submit" className="aem-btn-submit" disabled={bookSubmitting}>
                  {bookSubmitting ? 'Mengirim…' : (
                    <>Kirim Booking{!canManage && !(userPerks.credit_exempt || userPerks.free_booking) && featureCosts.book_1on1 > 0 && <> · <CoinIcon size={12} />{featureCosts.book_1on1}</>}</>
                  )}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>,
      document.body,
    )}

    {/* ── Delete Confirm Modal ── */}
    {deleteConfirmId && createPortal(<div className="aem-overlay" onClick={() => setDeleteConfirmId(null)}>
        <div className="delete-confirm-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
          <div className="delete-confirm-icon">🗑</div>
          <h3>hapus event ini?</h3>
          <p>Event yang dihapus tidak bisa dikembalikan.</p>
          <div className="delete-confirm-actions">
            <button type="button" className="add-event-cancel" onClick={() => setDeleteConfirmId(null)}>batal</button>
            <button type="button" className="delete-confirm-btn" onClick={handleDeleteEvent} disabled={deleteSubmitting}>
              {deleteSubmitting ? 'menghapus…' : 'ya, hapus'}
            </button>
          </div>
        </div>
      </div>, document.body)}
    </>
  );
}

const forumCategories = [
  'content strategy',
  'visual design',
  'analytics',
  'asset & materi',
  'mindset & growth',
  'lainnya',
];
const forumAdminCategories = ['qna session'];
const forumAllCategories = (isAdmin: boolean) =>
  isAdmin ? [...forumCategories, ...forumAdminCategories] : forumCategories;

const threadCategoryMeta: Record<string, { label: string; color: string; emoji: string }> = {
  'qna session': { label: 'QNA Session', color: '#f59e0b', emoji: '🎙️' },
};

type ForumParticipant = { username: string; displayName: string; avatarUrl?: string };

function ForumAvatarStack({ participants }: { participants: ForumParticipant[] }) {
  const visible = participants.slice(0, 5);
  return (
    <div className="forum-avatar-stack">
      {visible.map((p) => (
        <img
          key={p.username}
          src={p.avatarUrl || forumAvatarSvg(p.displayName, p.username)}
          alt={p.displayName}
          className="forum-avatar-xs"
          title={p.displayName}
        />
      ))}
    </div>
  );
}

function ForumThreadCard({
  thread,
  currentUser,
  userAvatarMap,
  badgeMap = {},
  onClick,
}: {
  thread: ForumThread;
  currentUser: { username: string; displayName: string; avatarUrl: string };
  userAvatarMap: Record<string, string>;
  badgeMap?: Record<string, BadgeTier>;
  onClick: () => void;
}) {
  const participantUsernames = Array.from(
    new Set([thread.authorUsername, ...thread.replies.map((r) => r.authorUsername)]),
  );

  const participants: ForumParticipant[] = participantUsernames.map((username) => {
    if (username === currentUser.username) {
      return { username, displayName: currentUser.displayName, avatarUrl: currentUser.avatarUrl };
    }
    const match = [
      { username: thread.authorUsername, displayName: thread.authorDisplayName },
      ...thread.replies.map((r) => ({ username: r.authorUsername, displayName: r.authorDisplayName })),
    ].find((p) => p.username === username);
    return { username, displayName: match?.displayName ?? username, avatarUrl: userAvatarMap[username] };
  });

  const lastReplyAt = thread.replies.length > 0
    ? thread.replies[thread.replies.length - 1].createdAt
    : thread.createdAt;

  const authorAvatar = thread.authorUsername === currentUser.username
    ? (currentUser.avatarUrl || forumAvatarSvg(currentUser.displayName, currentUser.username))
    : (userAvatarMap[thread.authorUsername] || forumAvatarSvg(thread.authorDisplayName, thread.authorUsername));

  const isQnaSession = thread.category === 'qna session';
  const catMeta = threadCategoryMeta[thread.category];

  return (
    <article className={`forum-thread-card${isQnaSession ? ' forum-thread-card--qna' : ''}`} onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onClick()}>
      {isQnaSession && (
        <div className="forum-qna-banner">🎙️ QNA Session — tanya jawab langsung dengan admin</div>
      )}
      <div className="forum-thread-card-author">
        <img src={authorAvatar} alt={thread.authorDisplayName} className="forum-avatar-xs" />
        <BadgeIcon tier={badgeMap[thread.authorUsername] ?? null} size={15} />
        <span className="forum-thread-author-name">{thread.authorDisplayName}</span>
        <span className="forum-dot">·</span>
        <span className="forum-thread-card-time">{timeAgo(thread.createdAt)}</span>
        <span
          className="forum-category-tag"
          style={{ marginLeft: 'auto', ...(catMeta ? { background: catMeta.color + '22', color: catMeta.color, borderColor: catMeta.color + '55' } : {}) }}
        >
          {catMeta ? `${catMeta.emoji} ${catMeta.label}` : thread.category}
        </span>
      </div>
      <h3 className="forum-thread-title">{thread.title}</h3>
      <p className="forum-thread-excerpt">{thread.body.slice(0, 120)}{thread.body.length > 120 ? '…' : ''}</p>
      {thread.imageUrl && (
        <img src={thread.imageUrl} alt="attachment" className="forum-thread-thumb" />
      )}
      {(() => {
        const topLevel = thread.replies.filter((r) => !r.parentReplyId);
        const last = topLevel[topLevel.length - 1];
        if (!last) return null;
        const avatarSrc = last.authorUsername === currentUser.username
          ? currentUser.avatarUrl || forumAvatarSvg(currentUser.displayName, currentUser.username)
          : userAvatarMap[last.authorUsername] || forumAvatarSvg(last.authorDisplayName, last.authorUsername);
        return (
          <div className="forum-card-last-reply">
            <img src={avatarSrc} alt={last.authorDisplayName} className="forum-avatar-xs" />
            <div className="forum-card-last-reply-content">
              <span className="forum-card-last-reply-author">{last.authorDisplayName}</span>
              <span className="forum-card-last-reply-body">{last.body.slice(0, 80)}{last.body.length > 80 ? '…' : ''}</span>
            </div>
            <span className="forum-card-last-reply-time">{timeAgo(last.createdAt)}</span>
          </div>
        );
      })()}
      <div className="forum-thread-footer">
        <div className="forum-thread-stats">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <span>{thread.replies.length} balasan</span>
          <span className="forum-dot">·</span>
          <span>{thread.viewCount} views</span>
        </div>
        <ForumAvatarStack participants={participants.slice(0, 4)} />
      </div>
    </article>
  );
}

function ForumReplyItem({
  reply,
  allReplies,
  depth,
  currentUser,
  userAvatarMap,
  badgeMap = {},
  onReplyTo,
  onUpvote,
  onImageClick,
  isQnaThread,
  canModerate,
  onMarkAnswered,
}: {
  reply: ForumReply;
  allReplies: ForumReply[];
  depth: number;
  currentUser: { username: string; displayName: string; avatarUrl: string };
  userAvatarMap: Record<string, string>;
  badgeMap?: Record<string, BadgeTier>;
  onReplyTo: (replyId: string, displayName: string) => void;
  onUpvote: (replyId: string) => void;
  onImageClick: (url: string) => void;
  isQnaThread?: boolean;
  canModerate?: boolean;
  onMarkAnswered?: (replyId: string) => void;
}) {
  const children = allReplies.filter((r) => r.parentReplyId === reply.id);
  const isMe = reply.authorUsername === currentUser.username;
  const replyAvatarSrc = isMe
    ? (currentUser.avatarUrl || forumAvatarSvg(currentUser.displayName, currentUser.username))
    : (userAvatarMap[reply.authorUsername] || forumAvatarSvg(reply.authorDisplayName, reply.authorUsername));
  const replyDisplayName = isMe ? currentUser.displayName : reply.authorDisplayName;

  const renderBody = (text: string) => {
    const parts = text.split(/(@\S+)/g);
    return parts.map((part, i) =>
      part.startsWith('@')
        ? <span key={i} className="forum-mention">{part}</span>
        : part
    );
  };

  return (
    <div className={`forum-reply-item${reply.answered ? ' forum-reply-item--answered' : ''}`}>
      <div className="forum-reply-item-left">
        <div className="forum-reply-avatar-wrap">
          <img src={replyAvatarSrc} alt={replyDisplayName} className="forum-avatar-sm" />
          {children.length > 0 && <div className="forum-reply-thread-line" />}
        </div>
      </div>
      <div className="forum-reply-item-body">
        <div className="forum-reply-item-header">
          <BadgeIcon tier={badgeMap[reply.authorUsername] ?? null} size={14} />
          <strong className="forum-reply-item-name">{replyDisplayName}</strong>
          {reply.answered && <span className="forum-reply-answered-badge">✓ Terjawab</span>}
        </div>
        <div className="forum-reply-item-text">
          {renderBody(reply.body)}
        </div>
        {reply.imageUrl && (
          <button type="button" className="forum-img-thumb-btn" onClick={() => onImageClick(reply.imageUrl!)}>
            <img src={reply.imageUrl} alt="attachment" className="forum-img-thumb" />
            <span className="forum-img-thumb-overlay">🔍 lihat gambar</span>
          </button>
        )}
        <div className="forum-reply-item-actions">
          <button type="button" className="forum-react-btn" onClick={() => onUpvote(reply.id)} title="suka">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
          </button>
          {reply.upvotes > 0 && (
            <span className="forum-react-chip">👍 {reply.upvotes}</span>
          )}
          <span className="forum-reply-sep" />
          <button type="button" className="forum-reply-inline-btn" onClick={() => onReplyTo(reply.id, reply.authorDisplayName)}>
            Balas
          </button>
          <span className="forum-reply-sep" />
          <span className="forum-reply-item-time">{timeAgo(reply.createdAt)}</span>
          {isQnaThread && canModerate && onMarkAnswered && (
            <>
              <span className="forum-reply-sep" />
              <button
                type="button"
                className={`forum-reply-inline-btn${reply.answered ? ' forum-reply-inline-btn--answered' : ''}`}
                onClick={() => onMarkAnswered(reply.id)}
              >
                {reply.answered ? '✓ Batalkan' : '✓ Tandai Terjawab'}
              </button>
            </>
          )}
        </div>
        {children.length > 0 && (
          <div className="forum-reply-nested">
            {children.map((child) => (
              <ForumReplyItem
                key={child.id}
                reply={child}
                allReplies={allReplies}
                depth={depth + 1}
                currentUser={currentUser}
                userAvatarMap={userAvatarMap}
                badgeMap={badgeMap}
                onReplyTo={onReplyTo}
                onUpvote={onUpvote}
                onImageClick={onImageClick}
                isQnaThread={isQnaThread}
                canModerate={canModerate}
                onMarkAnswered={onMarkAnswered}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ForumThreadDetail({
  thread,
  session,
  displayName,
  avatarUrl,
  userAvatarMap,
  badgeMap = {},
  onBack,
  onUpdate,
  onDelete,
  onCreditChange,
}: {
  thread: ForumThread;
  session: AppSession;
  displayName: string;
  avatarUrl: string;
  userAvatarMap: Record<string, string>;
  badgeMap?: Record<string, BadgeTier>;
  onBack: () => void;
  onUpdate: (updated: ForumThread) => void;
  onDelete: (threadId: string) => void;
  onCreditChange?: (n: number) => void;
}) {
  const [replyBody, setReplyBody] = useState('');
  const [replyImageUrl, setReplyImageUrl] = useState('');
  const [replyingToId, setReplyingToId] = useState<string | null>(null);
  const [replyingToName, setReplyingToName] = useState('');
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [showActionMenu, setShowActionMenu] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(thread.title);
  const [editBody, setEditBody] = useState(thread.body);
  const [copyToast, setCopyToast] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replyTextareaRef = useRef<HTMLTextAreaElement>(null);
  const isAuthor = thread.authorUsername === session.username;
  const canModerate = session.role === 'developer' || session.role === 'admin';
  const { confirm: confirmDialog, modal: confirmModal } = useConfirm();

  const handleShare = () => {
    const url = `${window.location.origin}${window.location.pathname}?thread=${thread.id}#community`;
    setShowActionMenu(false);
    const showToast = () => {
      setCopyToast(true);
      setTimeout(() => setCopyToast(false), 2500);
    };
    if (navigator.clipboard) {
      void navigator.clipboard.writeText(url).then(showToast).catch(() => {
        // fallback untuk browser yang memblokir clipboard API
        const el = document.createElement('textarea');
        el.value = url;
        el.style.position = 'fixed';
        el.style.opacity = '0';
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
        showToast();
      });
    } else {
      const el = document.createElement('textarea');
      el.value = url;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      showToast();
    }
  };

  const handleDelete = async () => {
    if (await confirmDialog('Hapus thread ini? Tindakan tidak bisa dibatalkan.')) {
      onDelete(thread.id);
    }
  };

  const handleEditSave = () => {
    if (!editTitle.trim()) return;
    const updated = { ...thread, title: editTitle.trim(), body: editBody.trim() };
    onUpdate(updated);
    void upsertForumThread(updated);
    setIsEditing(false);
  };
  const isQnaThread = thread.category === 'qna session';

  const topLevelReplies = (() => {
    const all = thread.replies.filter((r) => !r.parentReplyId);
    if (!isQnaThread) return all;
    // Unanswered first, answered sink to bottom
    return [...all.filter((r) => !r.answered), ...all.filter((r) => r.answered)];
  })();

  const handleMarkAnswered = (replyId: string) => {
    const updated: ForumThread = {
      ...thread,
      replies: thread.replies.map((r) =>
        r.id === replyId ? { ...r, answered: !r.answered } : r,
      ),
    };
    onUpdate(updated);
  };

  const handleReplyTo = (replyId: string, displayName: string) => {
    setReplyingToId(replyId);
    setReplyingToName(displayName);
    setReplyBody(`@${displayName} `);
    setTimeout(() => {
      if (replyTextareaRef.current) {
        replyTextareaRef.current.value = `@${displayName} `;
        replyTextareaRef.current.focus();
      }
    }, 50);
  };

  const handleUpvote = (replyId: string) => {
    const updated: ForumThread = {
      ...thread,
      replies: thread.replies.map((r) =>
        r.id === replyId ? { ...r, upvotes: r.upvotes + 1 } : r,
      ),
    };
    onUpdate(updated);
  };

  const handleImageFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    void compressImage(file, 1280, 0.8).then((compressed) => {
      const reader = new FileReader();
      reader.onload = (e) => setReplyImageUrl((e.target?.result as string) ?? '');
      reader.readAsDataURL(compressed);
    });
  };

  const submitReply = (event?: FormEvent<HTMLFormElement> | React.MouseEvent) => {
    event?.preventDefault();
    // Baca langsung dari DOM agar tetap jalan walau ekstensi browser (mis. Grammarly)
    // menulis ke textarea tanpa memicu onChange React, sehingga replyBody kosong.
    const trimmedBody = (replyTextareaRef.current?.value ?? replyBody).trim();
    if (!trimmedBody) return;

    const newReply: ForumReply = {
      id: crypto.randomUUID(),
      authorUsername: session.username,
      authorDisplayName: displayName,
      body: trimmedBody,
      imageUrl: replyImageUrl || undefined,
      createdAt: new Date().toISOString(),
      upvotes: 0,
      parentReplyId: replyingToId ?? undefined,
    };

    const updated: ForumThread = {
      ...thread,
      replies: [...thread.replies, newReply],
    };

    onUpdate(updated);

    // Bonus koin balas thread (dibatasi per hari)
    void awardCoinReward(session.username, 'reply_thread').then((nb) => { if (nb != null) onCreditChange?.(nb); });

    // Notifikasi ke pemilik thread jika bukan diri sendiri
    if (thread.authorUsername !== session.username) {
      void insertNotification(thread.authorUsername, 'thread_reply', 'Ada Balasan di Thread Kamu', `${displayName} membalas thread "${thread.title}"`, `#community`);
    }

    // Notifikasi ke pemilik reply yang dibalas (jika berbeda dari pemilik thread dan bukan diri sendiri)
    if (replyingToId) {
      const parentReply = thread.replies.find((r) => r.id === replyingToId);
      if (parentReply && parentReply.authorUsername !== session.username && parentReply.authorUsername !== thread.authorUsername) {
        void insertNotification(parentReply.authorUsername, 'thread_reply', 'Komentar Kamu Dibalas', `${displayName} membalas komentarmu di "${thread.title}"`, `#community`);
      }
    }
    void sendTelegram(
      `↩️ <b>Balasan Thread Baru</b>\n\n` +
      `👤 ${displayName} (@${session.username})\n` +
      `📌 Thread: <b>${thread.title}</b>\n` +
      (replyingToId ? `💬 Membalas komentar\n` : '') +
      `\n${trimmedBody.slice(0, 200)}${trimmedBody.length > 200 ? '…' : ''}`
    );
    setReplyBody('');
    setReplyImageUrl('');
    setReplyingToId(null);
    setReplyingToName('');
    if (replyTextareaRef.current) replyTextareaRef.current.value = '';
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="forum-detail">
      {confirmModal}
      {/* ── Fixed top: back + OP post ── */}
      <div className="forum-detail-top">
        <button type="button" className="forum-back-btn" onClick={onBack}>
          ← kembali ke forum
        </button>
        {copyToast && (
          <div className="forum-copy-toast">Link thread disalin!</div>
        )}
      </div>

      <article className="forum-op forum-op--sticky">
        <div className="forum-op-header">
          {(() => {
            const isMe = thread.authorUsername === session.username;
            const name = isMe ? displayName : thread.authorDisplayName;
            const src = isMe
              ? (avatarUrl || forumAvatarSvg(displayName, session.username))
              : (userAvatarMap[thread.authorUsername] || forumAvatarSvg(thread.authorDisplayName, thread.authorUsername));
            return (
              <>
                <img src={src} alt={name} className="forum-avatar-md" />
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <BadgeIcon tier={badgeMap[thread.authorUsername] ?? null} size={16} />
                    <strong className="forum-op-author">{name}</strong>
                  </div>
                  <div className="forum-op-meta">
                    <span className="forum-category-tag">{thread.category}</span>
                    <span>{timeAgo(thread.createdAt)}</span>
                  </div>
                </div>
              </>
            );
          })()}
          <div className="forum-op-actions">
            <button type="button" className="forum-action-menu-btn" onClick={() => setShowActionMenu((v) => !v)} title="Opsi thread">
              ···
            </button>
            {showActionMenu && (
              <div className="forum-action-menu">
                <button type="button" onClick={handleShare}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                  Bagikan link
                </button>
                {isAuthor && (
                  <button type="button" onClick={() => { setIsEditing(true); setShowActionMenu(false); }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    Edit thread
                  </button>
                )}
                {(isAuthor || canModerate) && (
                  <button type="button" className="forum-action-delete" onClick={handleDelete}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                    Hapus thread
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {isEditing ? (
          <div className="forum-edit-form">
            <input
              className="forum-edit-title-input"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              placeholder="Judul thread"
            />
            <textarea
              className="forum-edit-body-input"
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              placeholder="Isi thread"
              rows={5}
            />
            <div className="forum-edit-actions">
              <button type="button" className="forum-edit-cancel-btn" onClick={() => setIsEditing(false)}>Batal</button>
              <button type="button" className="forum-edit-save-btn" onClick={handleEditSave} disabled={!editTitle.trim()}>Simpan</button>
            </div>
          </div>
        ) : (
          <>
            <h2 className="forum-op-title">{thread.title}</h2>
            <p className="forum-op-body">{thread.body}</p>
          </>
        )}
        {thread.imageUrl && (
          <button type="button" className="forum-img-thumb-btn" onClick={() => setLightboxUrl(thread.imageUrl!)}>
            <img src={thread.imageUrl} alt="attachment" className="forum-img-thumb" />
            <span className="forum-img-thumb-overlay">🔍 lihat gambar</span>
          </button>
        )}
        <div className="forum-op-stats">
          <span>{thread.replies.length} balasan</span>
          <span className="forum-dot">·</span>
          <span>{thread.viewCount} views</span>
        </div>
      </article>

      {/* ── Scrollable replies ── */}
      <div className="forum-replies-section">
        {thread.replies.length > 0 && (
          <p className="forum-replies-heading">{thread.replies.length} Balasan</p>
        )}
        {topLevelReplies.length === 0 && (
          <p className="forum-empty-replies">belum ada balasan. jadilah yang pertama!</p>
        )}
        {topLevelReplies.map((reply) => (
          <ForumReplyItem
            key={reply.id}
            reply={reply}
            allReplies={thread.replies}
            depth={0}
            currentUser={{ username: session.username, displayName, avatarUrl }}
            userAvatarMap={userAvatarMap}
            badgeMap={badgeMap}
            onReplyTo={handleReplyTo}
            onUpvote={handleUpvote}
            onImageClick={setLightboxUrl}
            isQnaThread={isQnaThread}
            canModerate={canModerate}
            onMarkAnswered={handleMarkAnswered}
          />
        ))}
      </div>

      {/* ── Pinned reply bar ── */}
      <form className="forum-reply-bar" onSubmit={submitReply} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitReply(); }}>
        <img src={avatarUrl || forumAvatarSvg(displayName, session.username)} alt={displayName} className="forum-avatar-sm forum-reply-bar-avatar" />
        <div className="forum-reply-bar-inner">
          {replyingToName && (
            <div className="forum-reply-bar-context">
              <span>membalas <strong>@{replyingToName}</strong></span>
              <button type="button" className="forum-reply-bar-cancel" onClick={() => { setReplyingToId(null); setReplyingToName(''); setReplyBody(''); }}>✕</button>
            </div>
          )}
          {replyImageUrl && (
            <div className="forum-reply-preview-wrap" style={{ margin: '6px 0 0' }}>
              <img src={replyImageUrl} alt="preview" className="forum-reply-preview" />
              <button type="button" className="forum-remove-img" onClick={() => { setReplyImageUrl(''); if (fileInputRef.current) fileInputRef.current.value = ''; }}>✕</button>
            </div>
          )}
          <div className="forum-reply-bar-row">
            <textarea
              ref={replyTextareaRef}
              id="forum-reply-textarea"
              className="forum-reply-bar-input"
              defaultValue=""
              onInput={(e) => { const t = e.target as HTMLTextAreaElement; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 120) + 'px'; }}
              onFocus={(e) => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'; }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitReply(); } }}
              placeholder={replyingToName ? `Balas @${replyingToName}…` : 'Tambah komentar…'}
              rows={1}
            />
            <div className="forum-reply-bar-icons">
              <label className="forum-reply-bar-icon-btn" title="lampirkan gambar">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImageFile} />
              </label>
              <button type="button" className="forum-reply-bar-send" title="kirim" onClick={submitReply}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
              </button>
            </div>
          </div>
        </div>
      </form>
      <p className="forum-reply-bar-hint">Enter untuk mengirim · Shift+Enter untuk baris baru</p>

      {lightboxUrl && createPortal(
        <div className="forum-lightbox-overlay" onClick={() => setLightboxUrl(null)}>
          <button type="button" className="forum-lightbox-close" onClick={() => setLightboxUrl(null)}>✕</button>
          <img
            src={lightboxUrl}
            alt="preview"
            className="forum-lightbox-img"
            onClick={(e) => e.stopPropagation()}
          />
        </div>,
        document.body,
      )}
    </div>
  );
}

function ForumComposer({
  session,
  avatarUrl,
  displayName,
  jobTitle,
  onPost,
  featureCosts,
  userPerks = {},
  onCreditChange,
  onInsufficientCredits,
  onRequestConfirm,
}: {
  session: AppSession;
  avatarUrl: string;
  displayName: string;
  jobTitle: string;
  onPost: (thread: ForumThread) => void;
  featureCosts: FeatureCosts;
  userPerks?: UserPerks;
  onCreditChange: (n: number) => void;
  onInsufficientCredits?: (feature: string, needed: number, balance: number) => void;
  onRequestConfirm?: (ctx: CreditConfirmContext) => void;
}) {
  const isAdmin = session.role === 'admin' || session.role === 'developer';
  const availableCategories = forumAllCategories(isAdmin);
  const composerBadge = useBadgeTier(session.username);
  const [body, setBody] = useState('');
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState(forumCategories[0]);
  const [imageUrl, setImageUrl] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [isPosting, setIsPosting] = useState(false);
  const imgRef = useRef<HTMLInputElement>(null);

  const handleImageFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    void compressImage(file, 1280, 0.8).then((compressed) => {
      const reader = new FileReader();
      reader.onload = (e) => setImageUrl((e.target?.result as string) ?? '');
      reader.readAsDataURL(compressed);
    });
  };

  const doPost = async () => {
    setIsPosting(true);
    const isQnaSession = category === 'qna session';
    const cost = isQnaSession ? 0 : featureCosts.post_thread;
    if (cost > 0) {
      const result = await deductCredits(session.username, cost, `Post thread: ${title.trim()}`, 'post_thread');
      if (!result.ok) {
        setIsPosting(false);
        onInsufficientCredits?.('Post Thread / Diskusi', result.needed ?? cost, result.balance ?? 0);
        return;
      }
      if (result.newBalance !== undefined) onCreditChange(result.newBalance);
    }
    const newThread: ForumThread = {
      id: `thread-${Date.now()}`,
      category,
      title: title.trim(),
      body: body.trim(),
      imageUrl: imageUrl || undefined,
      authorUsername: session.username,
      authorDisplayName: displayName,
      createdAt: new Date().toISOString(),
      viewCount: 0,
      replies: [],
    };
    onPost(newThread);
    // Bonus koin buat thread (dibatasi per hari)
    void awardCoinReward(session.username, 'create_thread').then((nb) => { if (nb != null) onCreditChange(nb); });
    if (isQnaSession) {
      // Silent broadcast to all members with linked Telegram
      void (async () => {
        const [{ data: users }, token] = await Promise.all([
          supabase.from('app_users').select('telegram_chat_id').not('telegram_chat_id', 'is', null).neq('telegram_chat_id', ''),
          getStudentBotToken(),
        ]);
        if (!token || !users) return;
        const broadcastMsg =
          `🎙️ <b>QNA Session Baru!</b>\n\n` +
          `📌 <b>${title.trim()}</b>\n\n` +
          (body.trim() ? `${body.trim().slice(0, 300)}${body.trim().length > 300 ? '…' : ''}\n\n` : '') +
          `💬 Buka aplikasi untuk ikut tanya jawab!`;
        for (const u of users) {
          const chatId = (u as { telegram_chat_id: string }).telegram_chat_id;
          if (chatId) await sendStudentBot(chatId, broadcastMsg, token);
        }
      })();
    } else {
      void sendTelegram(
        `💬 <b>Thread Baru di Forum</b>\n\n` +
        `👤 ${displayName} (@${session.username})\n` +
        `📂 Kategori: ${category}\n` +
        `📌 Judul: <b>${title.trim()}</b>\n` +
        (body.trim() ? `\n${body.trim().slice(0, 200)}${body.trim().length > 200 ? '…' : ''}` : '')
      );
    }
    setTitle('');
    setBody('');
    setImageUrl('');
    setIsFocused(false);
    setIsPosting(false);
    if (imgRef.current) imgRef.current.value = '';
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!title.trim() || !body.trim()) return;
    const isQnaSession = category === 'qna session';
    const cost = isQnaSession ? 0 : featureCosts.post_thread;
    const threadFree = isQnaSession || userPerks.credit_exempt || userPerks.free_thread;
    if (cost > 0 && !threadFree && onRequestConfirm) {
      onRequestConfirm({
        feature: 'Post Thread / Diskusi',
        cost,
        onConfirm: () => { void doPost(); },
      });
    } else {
      void doPost();
    }
  };

  return (
    <form className="forum-composer" onSubmit={handleSubmit}>
      <div className="forum-composer-top">
        <img
          src={avatarUrl || forumAvatarSvg(session.displayName, session.username)}
          alt={session.displayName}
          className="forum-avatar-md"
        />
        <div className="forum-composer-identity">
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <BadgeIcon tier={composerBadge} size={15} />
            <strong className="forum-composer-name">{displayName}</strong>
          </div>
          <span className="forum-composer-role">@{displayName.toLowerCase().replace(/\s+/g, '')} · {jobTitle}</span>
          <div className="forum-composer-category-row">
            <select
              className="forum-composer-category-select"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {availableCategories.map((cat) => (
                <option key={cat} value={cat}>{cat === 'qna session' ? '🎙️ QNA Session' : cat}</option>
              ))}
            </select>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="forum-composer-chevron">
              <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
        </div>
        {isFocused && (
          <button type="button" className="forum-composer-close" onClick={() => { setIsFocused(false); setTitle(''); setBody(''); setImageUrl(''); }}>✕</button>
        )}
      </div>

      {isFocused && (
        <div className="forum-composer-fields">
          <input
            className="forum-composer-title-input"
            type="text"
            placeholder="judul thread kamu…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        </div>
      )}

      <div className="forum-composer-body-wrap" onClick={() => setIsFocused(true)}>
        <textarea
          className="forum-composer-textarea"
          placeholder="ada pertanyaan atau insight yang mau dibagikan?"
          value={body}
          rows={isFocused ? 4 : 2}
          onChange={(e) => setBody(e.target.value)}
          onFocus={() => setIsFocused(true)}
        />
      </div>

      {imageUrl && (
        <div className="forum-reply-preview-wrap" style={{ margin: '0 0 4px' }}>
          <img src={imageUrl} alt="preview" className="forum-reply-preview" />
          <button type="button" className="forum-remove-img" onClick={() => { setImageUrl(''); if (imgRef.current) imgRef.current.value = ''; }}>✕</button>
        </div>
      )}

      <div className="forum-composer-divider" />

      <div className="forum-composer-actions">
        <div className="forum-composer-icons">
          <label className="forum-composer-icon-btn" title="lampirkan gambar">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
            <input ref={imgRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImageFile} />
          </label>
          <label className="forum-composer-icon-btn" title="lampirkan file">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66L9.41 17.41A2 2 0 016.59 14.6L15.77 5.42"/></svg>
          </label>
          <span className="forum-composer-icon-btn" title="emoji">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
          </span>
          <span className="forum-composer-icon-btn" title="tag">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
          </span>
        </div>
        <div className="forum-composer-post-row">
          {featureCosts.post_thread > 0 && !userPerks.credit_exempt && !userPerks.free_thread && category !== 'qna session' && (
            <span className="forum-composer-credit-cost">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
              {featureCosts.post_thread} Ruang Coin
            </span>
          )}
          <button
            type="submit"
            className="forum-composer-post-btn"
            disabled={!isFocused || !title.trim() || !body.trim() || isPosting}
          >
            {isPosting ? 'Memproses…' : 'Posting'}
          </button>
        </div>
      </div>
    </form>
  );
}

function CommunityPage({ session, initialThreadId, featureCosts, userPerks = {}, onCreditChange, onInsufficientCredits, onRequestConfirm }: { session: AppSession; initialThreadId?: string | null; featureCosts: FeatureCosts; userPerks?: UserPerks; onCreditChange: (n: number) => void; onInsufficientCredits?: (feature: string, needed: number, balance: number) => void; onRequestConfirm?: (ctx: CreditConfirmContext) => void }) {
  const [forumThreads, setForumThreads] = useState<ForumThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(initialThreadId ?? null);
  const [filterCategory, setFilterCategory] = useState('semua');
  const [searchQuery, setSearchQuery] = useState('');
  const [composerAvatarUrl, setComposerAvatarUrl] = useState('');
  const [composerDisplayName, setComposerDisplayName] = useState(session.displayName);
  const [composerJobTitle, setComposerJobTitle] = useState<string>(session.role);
  const [userAvatarMap, setUserAvatarMap] = useState<Record<string, string>>({});
  const [forumBadgeMap, setForumBadgeMap] = useState<Record<string, BadgeTier>>({});

  // Load badge tiers for forum authors
  useEffect(() => { void fetchAllBadgeTiers().then(setForumBadgeMap); }, []);

  // Bersihkan query param setelah mount
  useEffect(() => {
    if (initialThreadId) {
      window.history.replaceState({}, '', window.location.pathname + window.location.hash);
    }
  }, [initialThreadId]);

  // Load threads dari Supabase
  useEffect(() => {
    let isActive = true;
    void (async () => {
      const threads = await fetchForumThreads();
      if (!isActive) return;
      setForumThreads(threads);
      setLoading(false);
      // validasi initialThreadId: kalau tidak ditemukan, reset
      if (initialThreadId && !threads.some((t) => t.id === initialThreadId)) {
        setSelectedThreadId(null);
      }
    })();
    return () => { isActive = false; };
  }, []);

  useEffect(() => {
    let isActive = true;
    void (async () => {
      const profile = await loadSupabaseUserProfile(session);
      if (!isActive) return;
      setComposerAvatarUrl(profile.photoUrl);
      setComposerDisplayName(profile.name || session.displayName);
      setComposerJobTitle(profile.role || session.role);
    })();
    return () => { isActive = false; };
  }, [session]);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.from('user_profiles').select('username, avatar_path');
      if (!data) return;
      const map: Record<string, string> = {};
      for (const row of data) {
        if (row.avatar_path) map[row.username] = profileAvatarPublicUrl(row.avatar_path);
      }
      setUserAvatarMap(map);
    })();
  }, [forumThreads]);

  // Realtime subscription — update inkremental (hemat egress: tidak reload semua
  // thread+reply tiap ada perubahan, cukup ubah baris yang berubah dari payload).
  useEffect(() => {
    const mapThreadRow = (t: Record<string, unknown>): Omit<ForumThread, 'replies'> => ({
      id: t.id as string,
      category: t.category as string,
      title: t.title as string,
      body: t.body as string,
      imageUrl: (t.image_url as string) ?? undefined,
      authorUsername: t.author_username as string,
      authorDisplayName: t.author_display_name as string,
      createdAt: t.created_at as string,
      viewCount: (t.view_count as number) ?? 0,
    });
    const mapReplyRow = (r: Record<string, unknown>): ForumReply => ({
      id: r.id as string,
      authorUsername: r.author_username as string,
      authorDisplayName: r.author_display_name as string,
      body: r.body as string,
      imageUrl: (r.image_url as string) ?? undefined,
      createdAt: r.created_at as string,
      upvotes: (r.upvotes as number) ?? 0,
      parentReplyId: (r.parent_reply_id as string) ?? undefined,
      answered: (r.answered as boolean) ?? false,
    });

    const channel = supabase
      .channel('forum-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'forum_threads' }, (payload) => {
        if (payload.eventType === 'DELETE') {
          setForumThreads((prev) => prev.filter((t) => t.id !== (payload.old as { id: string }).id));
        } else if (payload.eventType === 'INSERT') {
          const row = mapThreadRow(payload.new as Record<string, unknown>);
          setForumThreads((prev) => prev.some((t) => t.id === row.id) ? prev : [{ ...row, replies: [] }, ...prev]);
        } else {
          // UPDATE: ubah field thread, pertahankan replies yang sudah ada
          const row = mapThreadRow(payload.new as Record<string, unknown>);
          setForumThreads((prev) => prev.map((t) => t.id === row.id ? { ...t, ...row } : t));
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'forum_replies' }, (payload) => {
        if (payload.eventType === 'DELETE') {
          const oldId = (payload.old as { id: string }).id;
          setForumThreads((prev) => prev.map((t) => ({ ...t, replies: t.replies.filter((r) => r.id !== oldId) })));
        } else {
          const row = payload.new as Record<string, unknown>;
          const threadId = row.thread_id as string;
          const reply = mapReplyRow(row);
          setForumThreads((prev) => prev.map((t) => {
            if (t.id !== threadId) return t;
            const exists = t.replies.some((r) => r.id === reply.id);
            return { ...t, replies: exists ? t.replies.map((r) => r.id === reply.id ? reply : r) : [...t.replies, reply] };
          }));
        }
      })
      .subscribe();

    return () => { void supabase.removeChannel(channel); };
  }, []);

  const selectedThread = forumThreads.find((t) => t.id === selectedThreadId) ?? null;

  const visibleThreads = forumThreads.filter((t) => {
    const matchCat = filterCategory === 'semua' || t.category === filterCategory;
    const q = searchQuery.toLowerCase();
    const matchSearch = !q || t.title.toLowerCase().includes(q) || t.body.toLowerCase().includes(q) || t.category.toLowerCase().includes(q);
    return matchCat && matchSearch;
  });

  const updateThread = (updated: ForumThread, updateThreadFields = false) => {
    setForumThreads((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    setSelectedThreadId(updated.id);
    // Only upsert thread row when thread fields changed (edit), not on reply/upvote
    if (updateThreadFields) void upsertForumThread(updated);
    void Promise.all(updated.replies.map((r) => upsertForumReply(r, updated.id))).catch((err: unknown) => {
      alert(`Gagal menyimpan balasan: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  const openThread = (threadId: string) => {
    setForumThreads((prev) => {
      const next = prev.map((t) => t.id === threadId ? { ...t, viewCount: t.viewCount + 1 } : t);
      const opened = next.find((t) => t.id === threadId);
      if (opened) void updateThreadViewCount(threadId, opened.viewCount);
      return next;
    });
    setSelectedThreadId(threadId);
  };

  const deleteThread = (threadId: string) => {
    setForumThreads((prev) => prev.filter((t) => t.id !== threadId));
    void deleteForumThreadFromDb(threadId);
    setSelectedThreadId(null);
  };

  const handlePost = (newThread: ForumThread) => {
    setForumThreads((prev) => [newThread, ...prev]);
    void upsertForumThread(newThread);
    // tetap di forum list, tidak navigasi ke thread
  };

  if (loading) {
    return (
      <section className="page card">
        <div className="forum-loading">memuat thread…</div>
      </section>
    );
  }

  if (selectedThread) {
    return (
      <section className="page card">
        <ForumThreadDetail
          thread={selectedThread}
          session={session}
          displayName={composerDisplayName}
          avatarUrl={composerAvatarUrl}
          userAvatarMap={userAvatarMap}
          badgeMap={forumBadgeMap}
          onBack={() => setSelectedThreadId(null)}
          onUpdate={updateThread}
          onDelete={deleteThread}
          onCreditChange={onCreditChange}
        />
      </section>
    );
  }

  return (
    <section className="page card">
      <div className="forum-header">
        <div className="forum-header-left">
          <p className="eyebrow">community forum</p>
          <h2>diskusi, tanya jawab, dan berbagi insight</h2>
          <p className="forum-header-sub">tanyakan ke mentor atau komunitas, lampirkan gambar, dan balas thread orang lain.</p>
        </div>
        <div className="forum-header-right">
          <input
            type="text"
            className="forum-search"
            placeholder="cari thread…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      <ForumComposer session={session} avatarUrl={composerAvatarUrl} displayName={composerDisplayName} jobTitle={composerJobTitle} onPost={handlePost} featureCosts={featureCosts} userPerks={userPerks} onCreditChange={onCreditChange} onInsufficientCredits={onInsufficientCredits} onRequestConfirm={onRequestConfirm} />

      <div className="forum-category-filters">
        {['semua', ...forumCategories, ...forumAdminCategories].map((cat) => (
          <button
            key={cat}
            type="button"
            className={`forum-filter-btn${filterCategory === cat ? ' active' : ''}${cat === 'qna session' ? ' forum-filter-btn--qna' : ''}`}
            onClick={() => setFilterCategory(cat)}
          >
            {cat === 'qna session' ? '🎙️ QNA Session' : cat}
          </button>
        ))}
      </div>

      {visibleThreads.length === 0 ? (
        <div className="forum-empty">
          <p>tidak ada thread yang cocok.</p>
        </div>
      ) : (
        <div className="forum-thread-list">
          {visibleThreads.map((thread) => (
            <ForumThreadCard
                key={thread.id}
                thread={thread}
                currentUser={{ username: session.username, displayName: composerDisplayName, avatarUrl: composerAvatarUrl }}
                userAvatarMap={userAvatarMap}
                badgeMap={forumBadgeMap}
                onClick={() => openThread(thread.id)}
              />
          ))}
        </div>
      )}
    </section>
  );
}

// ── Admin Types ─────────────────────────────────────────────

type UserPerks = {
  credit_exempt?: boolean;
  free_video?: boolean;
  free_thread?: boolean;
  free_booking?: boolean;
  free_asset?: boolean;
  free_event?: boolean;
};

type AdminUser = {
  username: string;
  displayName: string;
  role: string;
  isActive: boolean;
  createdAt: string;
  credits: number;
  email?: string;
  perks: UserPerks;
  referralPerks?: UserPerks;
  referralPerksExpiresAt?: string | null;
  avatarUrl?: string | null;
  referralCode?: string | null;
};

type CreditTransaction = {
  id: string;
  username: string;
  amount: number;
  type: string;
  description: string;
  createdAt: string;
};

type PackagePromo = {
  active: boolean;
  label: string;
  bonus_features?: Array<'free_video' | 'free_booking' | 'free_thread' | 'free_asset' | 'free_event'>;
  bonus_booking?: boolean;
  end_date?: string;
};
type CreditPackage = { id: string; label: string; credits: number; price: number; discount?: number; bonusCredits?: number; promo?: PackagePromo; features?: string[] };

function isPromoActive(pkg: CreditPackage): boolean {
  if (!pkg.promo?.active) return false;
  if (pkg.promo.end_date) {
    return new Date(pkg.promo.end_date) >= new Date(new Date().toDateString());
  }
  return true;
}
type PaymentInfo = { bankName: string; accountNumber: string; accountName: string; confirmationLink: string };

const CREDIT_RATE = 3_000; // 1 Ruang Coin = Rp 3.000
function calcPackagePrice(credits: number, discount = 0) {
  const base = credits * CREDIT_RATE;
  return Math.round(base * (1 - discount / 100));
}

const defaultCreditPackages: CreditPackage[] = [
  { id: 'starter', label: 'Starter', credits: 100, discount: 0, price: calcPackagePrice(100, 0) },
  { id: 'basic', label: 'Basic', credits: 300, discount: 10, price: calcPackagePrice(300, 10) },
  { id: 'pro', label: 'Pro', credits: 750, discount: 10, price: calcPackagePrice(750, 10) },
  { id: 'unlimited', label: 'Unlimited', credits: 2000, discount: 10, price: calcPackagePrice(2000, 10) },
];
const defaultPaymentInfo: PaymentInfo = { bankName: '', accountNumber: '', accountName: '', confirmationLink: '' };

const adminSettingsKey = 'admin_credit_settings';

type ReferralCode = {
  code: string;
  credits: number;
  description?: string;
  expiresAt?: string;
  type?: 'coin' | 'feature';
  features?: Array<'free_video' | 'free_booking' | 'free_thread' | 'free_asset' | 'free_event'>;
};
type PromoPopup = {
  id: string;
  enabled: boolean;
  icon: string;
  iconUrl?: string;
  title: string;
  subtitle: string;
  body: string;
  ctaText: string;
  ctaAction: 'topup' | 'url' | 'dismiss';
  ctaUrl?: string;
  dismissText: string;
  target: 'new_users' | 'all_users';
  bgColor?: string;
  bgFrom?: string;
  bgTo?: string;
  bgAngle?: number;
  useGradient?: boolean;
  textColor?: string;
  btnColor?: string;
  btnTextColor?: string;
  styleTemplate?: 'default' | 'flash_sale' | 'premium' | 'pastel' | 'dark_announcement';
};

const defaultPromo: PromoPopup = {
  id: 'default',
  enabled: false,
  icon: '🚀',
  title: 'Selamat Datang!',
  subtitle: 'Mulai perjalanan belajarmu sekarang',
  body: 'Topup Ruang Coin sekarang dan akses semua fitur pembelajaran eksklusif yang tersedia.',
  ctaText: 'Topup Sekarang',
  ctaAction: 'topup',
  dismissText: 'Tidak, terima kasih',
  target: 'new_users',
  bgColor: '#ffffff',
  useGradient: false,
  bgFrom: '#f0e6ff',
  bgTo: '#b28aff',
  bgAngle: 135,
  textColor: '#1a1a1a',
  btnColor: '#6c47ff',
  btnTextColor: '#ffffff',
};

const PROMO_TEMPLATES: Record<NonNullable<PromoPopup['styleTemplate']>, {
  label: string; emoji: string; desc: string;
  patch: Partial<Pick<PromoPopup, 'bgColor'|'bgFrom'|'bgTo'|'bgAngle'|'useGradient'|'textColor'|'btnColor'|'btnTextColor'>>;
}> = {
  default: {
    label: 'Default', emoji: '✨', desc: 'Bersih & netral',
    patch: { useGradient: false, bgColor: '#4f8cff', textColor: '#ffffff', btnColor: '#ff5c5c', btnTextColor: '#ffffff' },
  },
  flash_sale: {
    label: 'Flash Sale', emoji: '🔥', desc: 'Urgensi & diskon',
    patch: { useGradient: true, bgFrom: '#ff3a3a', bgTo: '#ff8c00', bgAngle: 135, textColor: '#ffffff', btnColor: '#ffffff', btnTextColor: '#e03000' },
  },
  premium: {
    label: 'Premium', emoji: '👑', desc: 'Gelap & elegan',
    patch: { useGradient: true, bgFrom: '#1a1228', bgTo: '#2d1f4e', bgAngle: 145, textColor: '#f5d97e', btnColor: '#f5d97e', btnTextColor: '#1a1228' },
  },
  pastel: {
    label: 'Pastel', emoji: '🌸', desc: 'Lembut & ramah',
    patch: { useGradient: true, bgFrom: '#fde8f5', bgTo: '#e8d5fb', bgAngle: 120, textColor: '#5a2d82', btnColor: '#b07fe8', btnTextColor: '#ffffff' },
  },
  dark_announcement: {
    label: 'Announcement', emoji: '📢', desc: 'Serius & informatif',
    patch: { useGradient: false, bgColor: '#1c1c2e', textColor: '#e2e8f0', btnColor: '#3b82f6', btnTextColor: '#ffffff' },
  },
};

function applyPromoTemplate(promo: PromoPopup, tpl: NonNullable<PromoPopup['styleTemplate']>): PromoPopup {
  return { ...promo, ...PROMO_TEMPLATES[tpl].patch, styleTemplate: tpl };
}

function promoBg(p: PromoPopup): string {
  if (p.useGradient) return `linear-gradient(${p.bgAngle ?? 135}deg, ${p.bgFrom ?? '#f0e6ff'}, ${p.bgTo ?? '#b28aff'})`;
  return p.bgColor ?? '#ffffff';
}

// ── Bonus Ruang Coin (earn koin dari aksi) ───────────────────
type CoinRewardKey = 'reply_thread' | 'create_thread' | 'daily_login' | 'complete_lesson';
type CoinRewardRule = { amount: number; perDay: number };
type CoinRewards = Record<CoinRewardKey, CoinRewardRule>;
const defaultCoinRewards: CoinRewards = {
  reply_thread: { amount: 0, perDay: 3 },
  create_thread: { amount: 0, perDay: 2 },
  daily_login: { amount: 0, perDay: 1 },
  complete_lesson: { amount: 0, perDay: 5 },
};
const coinRewardLabels: Record<CoinRewardKey, string> = {
  reply_thread: 'Balas Thread / QNA',
  create_thread: 'Buat Thread Baru',
  daily_login: 'Login Harian',
  complete_lesson: 'Selesai Materi / Video',
};
const coinRewardIcons: Record<CoinRewardKey, string> = {
  reply_thread: '💬', create_thread: '📝', daily_login: '📅', complete_lesson: '🎬',
};

// Award koin ke user saat melakukan aksi tertentu (dengan batas harian anti-spam).
async function awardCoinReward(username: string, key: CoinRewardKey): Promise<number | null> {
  try {
    const settings = await loadAdminSettings();
    const rule = (settings.coin_rewards ?? defaultCoinRewards)[key];
    if (!rule || rule.amount <= 0) return null;
    const desc = `Bonus: ${coinRewardLabels[key]}`;
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const { count } = await supabase.from('credit_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('username', username).eq('description', desc)
      .gte('created_at', startOfDay.toISOString());
    if ((count ?? 0) >= rule.perDay) return null;
    const { data: bal } = await supabase.from('user_credits').select('balance').eq('username', username).maybeSingle();
    const next = (bal?.balance ?? 0) + rule.amount;
    await Promise.all([
      supabase.from('user_credits').upsert({ username, balance: next }),
      supabase.from('credit_transactions').insert({ username, amount: rule.amount, type: 'topup', description: desc }),
    ]);
    return next;
  } catch { return null; }
}

type AdminSettings = { packages: CreditPackage[]; payment: PaymentInfo; referralCodes?: ReferralCode[]; promo?: PromoPopup; coin_rate?: number; student_bot_token?: string; coin_rewards?: CoinRewards };

let _adminSettingsCache: AdminSettings | null = null;
async function loadAdminSettings(): Promise<AdminSettings> {
  if (_adminSettingsCache) return _adminSettingsCache;
  const { data } = await supabase
    .from('learning_hub_content')
    .select('content')
    .eq('content_key', adminSettingsKey)
    .maybeSingle();
  if (!data?.content) return { packages: defaultCreditPackages, payment: defaultPaymentInfo, referralCodes: [] };
  const raw = typeof data.content === 'string'
    ? (JSON.parse(data.content) as AdminSettings)
    : (data.content as AdminSettings);
  _adminSettingsCache = {
    packages: raw.packages ?? defaultCreditPackages,
    payment: raw.payment ?? defaultPaymentInfo,
    referralCodes: raw.referralCodes ?? [],
    promo: raw.promo ?? defaultPromo,
    coin_rate: raw.coin_rate ?? CREDIT_RATE,
    student_bot_token: raw.student_bot_token ?? '',
    coin_rewards: { ...defaultCoinRewards, ...(raw.coin_rewards ?? {}) },
  };
  return _adminSettingsCache;
}

async function saveAdminSettings(settings: AdminSettings) {
  await supabase.from('learning_hub_content').upsert({
    content_key: adminSettingsKey,
    content_group: 'admin',
    content: settings,
  });
  _adminSettingsCache = settings;
}

// ── Landing Page content (editable via admin) ───────────────
type LandingStep = { id: string; image: string; label: string; title: string; desc: string };
type LandingFeature = { id: string; eyebrow: string; title: string; desc: string; ctaLabel: string; image: string; imageSide: 'left' | 'right' };
type LandingFaq = { id: string; q: string; a: string };
type LandingContent = {
  badge: string;
  heroTitle: string;
  heroSubtitle: string;
  heroCtaLabel: string;
  emailPlaceholder: string;
  painEyebrow: string;
  howTitle: string;
  steps: LandingStep[];
  featuresTitle: string;
  features: LandingFeature[];
  showPricing: boolean;
  pricingTitle: string;
  pricingSubtitle: string;
  faqTitle: string;
  faqs: LandingFaq[];
  finalTitle: string;
  finalSubtitle: string;
  finalCtaLabel: string;
  footerText: string;
  instagramUrl: string;
};

const landingContentKey = 'landing_page_content';

const defaultLandingContent: LandingContent = {
  badge: 'Ruang Sosmed ID · by Snail',
  heroTitle: 'Belajar Jadi Social Media Specialist, dari Nol sampai Pro',
  heroSubtitle:
    'Platform belajar social media specialist terlengkap. Kuasai content strategy, visual design, analytics, dan social media marketing lewat materi terstruktur, sesi 1:1 mentor, dan komunitas aktif.',
  heroCtaLabel: 'Masuk ke kelas',
  emailPlaceholder: 'Masukkan email kamu',
  painEyebrow: 'Kamu pernah ngerasain ini?',
  howTitle: 'Kalau iya, kamu di tempat yang tepat.',
  steps: [
    { id: 's1', image: '', label: '😤', title: 'Udah rajin posting tapi engagement tetap sepi?', desc: 'Tanpa strategi yang jelas, konten sebagus apapun gak akan menjangkau orang yang tepat.' },
    { id: 's2', image: '', label: '😵', title: 'Tahu cara bikin konten, tapi gak paham kenapa gak convert?', desc: 'Ada gap besar antara "bisa posting" dan "ngerti social media marketing" — dan itu yang perlu diisi.' },
    { id: 's3', image: '', label: '😓', title: 'Mau jadi social media specialist tapi gak tahu mulai dari mana?', desc: 'Banyak resource di luar sana, tapi gak ada yang terstruktur dan sesuai kebutuhan dunia kerja nyata.' },
  ],
  showPricing: true,
  pricingTitle: 'Pilih Paket Ruang Coin',
  pricingSubtitle: 'Ambil paket yang kamu mau — daftar dulu, lalu lanjut ke pembayaran.',
  featuresTitle: 'Yang Membuat Ruang Sosmed ID Powerful',
  features: [
    { id: 'f1', eyebrow: 'Materi Terstruktur', title: 'Belajar bertahap dari dasar sampai mahir', desc: 'Kurikulum tersusun rapi: content strategy, visual design, analytics, hingga social media marketing.', ctaLabel: 'Mulai belajar', image: '', imageSide: 'right' },
    { id: 'f2', eyebrow: 'Mentor & Komunitas', title: 'Sesi 1:1 dan komunitas yang aktif', desc: 'Konsultasi langsung dengan mentor dan berbagi insight bersama member lain.', ctaLabel: 'Gabung sekarang', image: '', imageSide: 'left' },
  ],
  faqTitle: 'Pertanyaan yang Sering Diajukan',
  faqs: [
    { id: 'q1', q: 'Apakah cocok untuk pemula total?', a: 'Sangat cocok. Materi dimulai dari dasar, jadi yang belum berpengalaman pun bisa mengikuti.' },
    { id: 'q2', q: 'Apakah ada sesi bersama mentor?', a: 'Ya, kamu bisa booking sesi 1:1 untuk konsultasi langsung.' },
    { id: 'q3', q: 'Apakah dapat sertifikat?', a: 'Ya, kamu mendapat sertifikat setelah menyelesaikan kelas.' },
  ],
  finalTitle: 'Siap jadi social media specialist sungguhan?',
  finalSubtitle: 'Gabung sekarang dan mulai upgrade skill sosial mediamu bersama Ruang Sosmed ID.',
  finalCtaLabel: 'Masuk ke kelas',
  footerText: 'Ruang Sosmed ID by Snail',
  instagramUrl: 'https://www.instagram.com/ruangsosmedid',
};

let _landingContentCache: LandingContent | null = null;
async function loadLandingContent(): Promise<LandingContent> {
  if (_landingContentCache) return _landingContentCache;
  const { data } = await supabase
    .from('learning_hub_content')
    .select('content')
    .eq('content_key', landingContentKey)
    .maybeSingle();
  if (!data?.content) return defaultLandingContent;
  const raw = (typeof data.content === 'string' ? JSON.parse(data.content) : data.content) as Partial<LandingContent>;
  _landingContentCache = { ...defaultLandingContent, ...raw };
  return _landingContentCache;
}

async function saveLandingContent(content: LandingContent) {
  await supabase.from('learning_hub_content').upsert({
    content_key: landingContentKey,
    content_group: 'landing',
    content,
  });
  _landingContentCache = content;
}

async function uploadLandingImage(file: File): Promise<string> {
  const ext = file.name.split('.').pop() || 'jpg';
  const path = `landing/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage.from('lesson-assets').upload(path, file, { upsert: true, contentType: file.type });
  if (error) throw error;
  return supabase.storage.from('lesson-assets').getPublicUrl(path).data.publicUrl;
}

async function validateReferralCode(code: string): Promise<ReferralCode | null> {
  if (!code.trim()) return null;
  const settings = await loadAdminSettings();
  const match = settings.referralCodes?.find((r) => r.code.toLowerCase() === code.trim().toLowerCase());
  if (!match) return null;
  if (match.expiresAt && new Date(match.expiresAt) < new Date()) return null;
  return match;
}

function formatRupiah(n: number) {
  return 'Rp ' + n.toLocaleString('id-ID');
}

const REFERRAL_FEATURE_LABELS: Record<string, string> = {
  free_video: '🎬 Video Learning',
  free_booking: '📅 Booking 1:1',
  free_thread: '💬 Post Thread',
  free_asset: '📁 Asset Manager',
  free_event: '🎥 Join Event / Kelas',
};

function ReferralClaimModal({ session, currentCredits, onClose, onCoinClaimed, onFeatureClaimed }: {
  session: AppSession;
  currentCredits: number;
  onClose: () => void;
  onCoinClaimed: (newBalance: number) => void;
  onFeatureClaimed: (features: string[]) => void;
}) {
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<'idle' | 'checking' | 'invalid' | 'used' | 'claiming'>('idle');
  const [preview, setPreview] = useState<ReferralCode | null>(null);
  const [success, setSuccess] = useState<{ credits: number; features?: string[]; code: string } | null>(null);

  const codeUpper = code.trim().toUpperCase();

  const handleCheck = async () => {
    if (!codeUpper) return;
    setStatus('checking');
    setPreview(null);
    const match = await validateReferralCode(codeUpper);
    if (!match) { setStatus('invalid'); return; }
    // Cek apakah user sudah pernah pakai kode ini
    const { data: txs } = await supabase.from('credit_transactions').select('description').eq('username', session.username);
    const already = (txs ?? []).some((t) => t.description === `Bonus kode referral: ${codeUpper}` || t.description === `Klaim akses fitur: ${codeUpper}`);
    if (already) { setStatus('used'); return; }
    setPreview(match);
    setStatus('idle');
  };

  const handleClaim = async () => {
    if (!preview) return;
    setStatus('claiming');
    const codeType = preview.type ?? 'coin';

    if (codeType === 'feature' && preview.features && preview.features.length > 0) {
      const { data: profRow } = await supabase.from('user_profiles').select('referral_perks').eq('username', session.username).maybeSingle();
      const existingPerks = ((profRow as { referral_perks?: UserPerks } | null)?.referral_perks ?? {}) as UserPerks;
      const referralPerks: UserPerks = { ...existingPerks };
      for (const f of preview.features) referralPerks[f as keyof UserPerks] = true;
      await Promise.all([
        supabase.from('user_profiles').update({
          referral_perks: referralPerks,
          referral_perks_expires_at: preview.expiresAt ?? null,
          referral_code: codeUpper,
        } as never).eq('username', session.username),
        supabase.from('credit_transactions').insert({ username: session.username, amount: 0, type: 'topup', description: `Klaim akses fitur: ${codeUpper}` }),
      ]);
      onFeatureClaimed(preview.features);
      setSuccess({ credits: 0, features: preview.features, code: codeUpper });
      return;
    }

    // Coin
    const newBal = currentCredits + preview.credits;
    await Promise.all([
      supabase.from('user_credits').upsert({ username: session.username, balance: newBal }),
      supabase.from('credit_transactions').insert({ username: session.username, amount: preview.credits, type: 'topup', description: `Bonus kode referral: ${codeUpper}` }),
    ]);
    onCoinClaimed(newBal);
    setSuccess({ credits: preview.credits, code: codeUpper });
  };

  return createPortal(
    <div className="referral-claim-overlay" onClick={onClose}>
      <div className="referral-claim-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="referral-claim-close" onClick={onClose}>✕</button>

        {success ? (
          <div className="referral-claim-success">
            <div className="referral-claim-success-icon">🎉</div>
            {success.features && success.features.length > 0 ? (
              <>
                <h3>Akses Fitur Aktif!</h3>
                <div className="referral-claim-feat-list">
                  {success.features.map((f) => <span key={f} className="referral-badge valid">{REFERRAL_FEATURE_LABELS[f] ?? f}</span>)}
                </div>
                <p>Kode <strong>{success.code}</strong> berhasil diklaim. Fitur di atas sekarang gratis untukmu{preview?.expiresAt ? ` sampai ${new Date(preview.expiresAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}` : ''}.</p>
              </>
            ) : (
              <>
                <h3>Ruang Coin Ditambahkan!</h3>
                <div className="referral-claim-coin"><CoinIcon size={22} /> +{success.credits.toLocaleString('id-ID')}</div>
                <p>Kode <strong>{success.code}</strong> berhasil diklaim. Coin sudah masuk ke saldomu.</p>
              </>
            )}
            <button type="button" className="referral-claim-btn primary" onClick={onClose}>Sip, makasih! 🚀</button>
          </div>
        ) : (
          <>
            <div className="referral-claim-head">
              <div className="referral-claim-gift">🎁</div>
              <div>
                <h3 className="referral-claim-title">Klaim Kode Referral</h3>
                <p className="referral-claim-sub">Punya kode? Masukkan untuk dapat Ruang Coin atau akses fitur gratis.</p>
              </div>
            </div>

            <div className="referral-claim-input-row">
              <input
                className={`referral-claim-input${status === 'invalid' || status === 'used' ? ' error' : ''}`}
                placeholder="MASUKKAN KODE…"
                value={code}
                onChange={(e) => { setCode(e.target.value); setStatus('idle'); setPreview(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleCheck(); }}
                autoFocus
              />
              <button type="button" className="referral-claim-btn" disabled={!codeUpper || status === 'checking'} onClick={() => void handleCheck()}>
                {status === 'checking' ? '…' : 'Cek'}
              </button>
            </div>

            {status === 'invalid' && <p className="referral-claim-msg error">Kode tidak ditemukan atau sudah kedaluwarsa.</p>}
            {status === 'used' && <p className="referral-claim-msg error">Kamu sudah pernah mengklaim kode ini. Satu kode hanya bisa diklaim sekali per akun.</p>}

            {preview && (
              <div className="referral-claim-preview">
                <div className="referral-claim-preview-head">
                  <span className="referral-badge valid">{codeUpper}</span>
                  <span className="referral-claim-type">{(preview.type ?? 'coin') === 'feature' ? 'Akses Fitur' : 'Ruang Coin'}</span>
                </div>
                {(preview.type ?? 'coin') === 'feature' ? (
                  <div className="referral-claim-feat-list">
                    {(preview.features ?? []).map((f) => <span key={f} className="referral-badge valid">{REFERRAL_FEATURE_LABELS[f] ?? f}</span>)}
                  </div>
                ) : (
                  <div className="referral-claim-coin"><CoinIcon size={18} /> +{preview.credits.toLocaleString('id-ID')} Ruang Coin</div>
                )}
                {preview.expiresAt && <p className="referral-claim-expiry">Berlaku sampai {new Date(preview.expiresAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}</p>}
                <button type="button" className="referral-claim-btn primary full" disabled={status === 'claiming'} onClick={() => void handleClaim()}>
                  {status === 'claiming' ? 'Memproses…' : 'Klaim Sekarang'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ── Feature cost system ──────────────────────────────────────

type FeatureCostKey = 'video_learning' | 'post_thread' | 'book_1on1' | 'join_event';
type FeatureCosts = Record<FeatureCostKey, number>;

type CertTextField = {
  x: number;
  y: number;
  fontSize: number;
  fontFamily: string;
  color: string;
  align: CanvasTextAlign;
  bold: boolean;
};

type CertCustomFont = { name: string; url: string };

type CertificateTemplate = {
  bgUrl: string | null;
  customFonts?: CertCustomFont[];
  fields: {
    name: CertTextField;
    courseTitle: CertTextField;
    completionDate: CertTextField;
  };
};

const defaultCertField = (x: number, y: number, size: number, bold: boolean): CertTextField => ({
  x, y, fontSize: size, fontFamily: 'Georgia', color: '#1a1a2e', align: 'center', bold,
});

const defaultCertTemplate: CertificateTemplate = {
  bgUrl: null,
  customFonts: [],
  fields: {
    name: defaultCertField(50, 48, 64, false),
    courseTitle: defaultCertField(50, 58, 36, false),
    completionDate: defaultCertField(50, 68, 24, false),
  },
};

async function loadAndRegisterFonts(fonts: CertCustomFont[]): Promise<void> {
  if (!fonts?.length) return;
  await Promise.all(fonts.map(async (f) => {
    if (document.fonts.check(`12px "${f.name}"`)) return;
    try {
      const resp = await fetch(f.url);
      const buf = await resp.arrayBuffer();
      const face = new FontFace(f.name, buf);
      await face.load();
      document.fonts.add(face);
    } catch { /* ignore */ }
  }));
}

async function loadCertTemplate(courseKey: string): Promise<CertificateTemplate> {
  const contentKey = `cert_template_${courseKey}`;
  const { data } = await supabase.from('learning_hub_content').select('content').eq('content_key', contentKey).maybeSingle();
  if (data?.content) return data.content as CertificateTemplate;
  return JSON.parse(JSON.stringify(defaultCertTemplate)) as CertificateTemplate;
}

async function saveCertTemplate(courseKey: string, template: CertificateTemplate): Promise<string | null> {
  const contentKey = `cert_template_${courseKey}`;
  const { error } = await supabase.from('learning_hub_content').upsert({
    content_key: contentKey,
    content_group: 'cert',
    content: template,
    updated_at: new Date().toISOString(),
  });
  return error?.message ?? null;
}

async function renderCertToCanvas(displayName: string, courseTitle: string, template: CertificateTemplate, scale = 1): Promise<HTMLCanvasElement> {
  await loadAndRegisterFonts(template.customFonts ?? []);

  const W = 1280 * scale, H = 905 * scale;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  if (template.bgUrl) {
    try {
      const resp = await fetch(template.bgUrl);
      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);
      await new Promise<void>((resolve) => {
        const img = new Image();
        img.onload = () => { ctx.drawImage(img, 0, 0, W, H); URL.revokeObjectURL(blobUrl); resolve(); };
        img.onerror = () => { URL.revokeObjectURL(blobUrl); resolve(); };
        img.src = blobUrl;
      });
    } catch {
      ctx.fillStyle = '#f5f0e8';
      ctx.fillRect(0, 0, W, H);
    }
  } else {
    ctx.fillStyle = '#f5f0e8';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#c9a96e';
    ctx.lineWidth = 8 * scale;
    ctx.strokeRect(24 * scale, 24 * scale, W - 48 * scale, H - 48 * scale);
  }

  const drawField = (text: string, field: CertTextField) => {
    const px = (field.x / 100) * W;
    const py = (field.y / 100) * H;
    const size = Math.round(field.fontSize * scale);
    ctx.font = `${field.bold ? 'bold ' : ''}${size}px ${field.fontFamily}, serif`;
    ctx.fillStyle = field.color;
    ctx.textAlign = field.align;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, px, py);
  };

  const today = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  drawField(displayName, template.fields.name);
  drawField(courseTitle, template.fields.courseTitle);
  drawField(today, template.fields.completionDate);
  return canvas;
}

function CertPreviewModal({ displayName, courseTitle, template, onClose }: {
  displayName: string;
  courseTitle: string;
  template: CertificateTemplate;
  onClose: () => void;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let active = true;
    void renderCertToCanvas(displayName, courseTitle, template, 1).then((canvas) => {
      if (!active) return;
      setPreviewUrl(canvas.toDataURL('image/jpeg', 0.85));
    });
    return () => { active = false; };
  }, [displayName, courseTitle, template]);

  const handleDownload = async () => {
    setDownloading(true);
    await downloadCertificate(displayName, courseTitle, template);
    setDownloading(false);
  };

  return createPortal(
    <div className="drawer-backdrop cert-preview-backdrop" role="presentation" onClick={onClose}>
      <div className="cert-preview-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="cert-preview-modal-head">
          <div>
            <p className="eyebrow">sertifikat</p>
            <h3>Preview Sertifikat</h3>
          </div>
          <button type="button" className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="cert-preview-modal-body">
          {previewUrl
            ? <img src={previewUrl} alt="preview sertifikat" className="cert-preview-modal-img" />
            : <div className="cert-preview-loading">Memuat preview…</div>
          }
        </div>
        <div className="cert-preview-modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>Tutup</button>
          <button type="button" className="cert-download-btn" style={{ width: 'auto', marginTop: 0 }} onClick={handleDownload} disabled={!previewUrl || downloading}>
            {downloading ? 'Mengekspor PDF…' : '↓ Download PDF'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

async function downloadCertificate(displayName: string, courseTitle: string, template: CertificateTemplate): Promise<void> {
  const canvas = await renderCertToCanvas(displayName, courseTitle, template, 3);
  const W = canvas.width, H = canvas.height;

  // Export as JPEG then embed in a minimal PDF (A4 landscape: 841.89 × 595.28 pt)
  const jpegBlob = await new Promise<Blob>((resolve) => {
    canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.95);
  });
  const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());

  const pW = 841.89, pH = 595.28;
  const enc = new TextEncoder();

  const p1 = `%PDF-1.4\n`;
  const p2 = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
  const p3 = `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`;
  const p4 = `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pW.toFixed(2)} ${pH.toFixed(2)}] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`;
  const p5h = `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\r\n`;
  const p5f = `\r\nendstream\nendobj\n`;
  // PDF Y-axis is from bottom; negate height and offset by pH to flip image upright
  const contStream = `q ${pW.toFixed(2)} 0 0 -${pH.toFixed(2)} 0 ${pH.toFixed(2)} cm /Im1 Do Q`;
  const p6 = `5 0 obj\n<< /Length ${contStream.length} >>\nstream\n${contStream}\nendstream\nendobj\n`;

  const b1 = enc.encode(p1), b2 = enc.encode(p2), b3 = enc.encode(p3);
  const b4 = enc.encode(p4), b5h = enc.encode(p5h), b5f = enc.encode(p5f), b6 = enc.encode(p6);

  let off = b1.length;
  const o1 = off; off += b2.length;
  const o2 = off; off += b3.length;
  const o3 = off; off += b4.length;
  const o4 = off; off += b5h.length + jpegBytes.length + b5f.length;
  const o5 = off; off += b6.length;
  const xrefOff = off;

  const pad = (n: number) => String(n).padStart(10, '0');
  const xref = `xref\n0 6\n0000000000 65535 f\r\n${pad(o1)} 00000 n\r\n${pad(o2)} 00000 n\r\n${pad(o3)} 00000 n\r\n${pad(o4)} 00000 n\r\n${pad(o5)} 00000 n\r\n`;
  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOff}\n%%EOF\n`;
  const bx = enc.encode(xref), bt = enc.encode(trailer);

  const pdf = new Uint8Array(b1.length + b2.length + b3.length + b4.length + b5h.length + jpegBytes.length + b5f.length + b6.length + bx.length + bt.length);
  let pos = 0;
  const put = (b: Uint8Array) => { pdf.set(b, pos); pos += b.length; };
  put(b1); put(b2); put(b3); put(b4); put(b5h); put(jpegBytes); put(b5f); put(b6); put(bx); put(bt);

  const url = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `Sertifikat_${displayName.replace(/\s+/g, '_')}.pdf`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

const featureCostsStorageKey = 'feature_costs';

const defaultFeatureCosts: FeatureCosts = {
  video_learning: 5,
  post_thread: 1,
  book_1on1: 10,
  join_event: 5,
};

const featureCostLabels: Record<FeatureCostKey, string> = {
  video_learning: 'Video Learning',
  post_thread: 'Post Thread / Diskusi',
  book_1on1: 'Book Sesi 1:1',
  join_event: 'Join Event / Kelas',
};

const featureCostIcons: Record<FeatureCostKey, string> = {
  video_learning: '🎬',
  post_thread: '💬',
  book_1on1: '📅',
  join_event: '🎥',
};

async function loadFeatureCosts(): Promise<FeatureCosts> {
  const { data } = await supabase
    .from('learning_hub_content')
    .select('content')
    .eq('content_key', featureCostsStorageKey)
    .maybeSingle();
  if (!data?.content) return { ...defaultFeatureCosts };
  const raw = typeof data.content === 'string'
    ? (JSON.parse(data.content) as Partial<FeatureCosts>)
    : (data.content as Partial<FeatureCosts>);
  return { ...defaultFeatureCosts, ...raw };
}

async function saveFeatureCosts(costs: FeatureCosts): Promise<void> {
  await supabase.from('learning_hub_content').upsert({
    content_key: featureCostsStorageKey,
    content_group: 'admin',
    content: costs,
    updated_at: new Date().toISOString(),
  });
}

async function deductCredits(
  username: string,
  amount: number,
  description: string,
  type: string,
): Promise<{ ok: boolean; newBalance?: number; error?: string; needed?: number; balance?: number }> {
  if (amount <= 0) return { ok: true };

  // Check user perks — skip deduction if exempt
  const { data: profileRow } = await supabase
    .from('user_profiles')
    .select('perks')
    .eq('username', username)
    .maybeSingle();
  const perks = (profileRow?.perks ?? {}) as UserPerks;
  const perkMap: Record<string, keyof UserPerks> = {
    video_learning: 'free_video',
    post_thread: 'free_thread',
    book_1on1: 'free_booking',
    join_event: 'free_event',
  };
  const perkKey = perkMap[type];
  if (perks.credit_exempt || (perkKey && perks[perkKey])) {
    return { ok: true };
  }

  const { data, error } = await supabase.rpc('spend_credits', {
    p_username: username.toLowerCase(),
    p_amount: amount,
    p_type: type,
    p_description: description,
  });

  if (error) return { ok: false, error: error.message };

  const result = data as { ok: boolean; newBalance?: number; error?: string; needed?: number; balance?: number };
  return result;
}

// ── CertificateDesigner ────────────────────────────────────────────────

type CertFieldKey = 'name' | 'courseTitle' | 'completionDate';
const certFieldLabels: Record<CertFieldKey, string> = { name: 'Nama Peserta', courseTitle: 'Judul Kelas', completionDate: 'Tanggal Selesai' };
const certFieldColors: Record<CertFieldKey, string> = { name: '#6c63ff', courseTitle: '#e05a2b', completionDate: '#0a7ea4' };
const certFieldPreview: Record<CertFieldKey, string> = { name: 'Nama Peserta', courseTitle: 'Judul Kelas', completionDate: '21 Juni 2026' };

function CertificateDesigner({ courseKey, courseTitle }: { courseKey: string; courseTitle: string }) {
  const [template, setTemplate] = useState<CertificateTemplate>(() => JSON.parse(JSON.stringify(defaultCertTemplate)) as CertificateTemplate);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [bgFile, setBgFile] = useState<File | null>(null);
  const [bgUploading, setBgUploading] = useState(false);
  const [fontUploading, setFontUploading] = useState(false);
  const [dragging, setDragging] = useState<CertFieldKey | null>(null);
  const [activeField, setActiveField] = useState<CertFieldKey>('name');
  const previewRef = useRef<HTMLDivElement>(null);
  const bgInputRef = useRef<HTMLInputElement>(null);
  const fontInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadCertTemplate(courseKey).then(async (t) => {
      await loadAndRegisterFonts(t.customFonts ?? []);
      setTemplate(t);
      setLoading(false);
    });
  }, [courseKey]);

  const handleBgUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBgFile(file);
    setBgUploading(true);
    const ext = file.name.split('.').pop();
    const path = `cert-backgrounds/${courseKey}_${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from('lesson-assets').upload(path, file, { upsert: true, contentType: file.type });
    if (!error) {
      const url = supabase.storage.from('lesson-assets').getPublicUrl(path).data.publicUrl;
      setTemplate((prev) => ({ ...prev, bgUrl: url }));
    }
    setBgUploading(false);
    setBgFile(null);
  };

  const handleFontUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFontUploading(true);
    const fontName = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9\s\-_]/g, '');
    const ext = file.name.split('.').pop();
    const path = `cert-fonts/${courseKey}_${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from('lesson-assets').upload(path, file, { upsert: true, contentType: file.type });
    if (!error) {
      const url = supabase.storage.from('lesson-assets').getPublicUrl(path).data.publicUrl;
      const newFont: CertCustomFont = { name: fontName, url };
      await loadAndRegisterFonts([newFont]);
      setTemplate((prev) => {
        const updated = { ...prev, customFonts: [...(prev.customFonts ?? []), newFont] };
        void saveCertTemplate(courseKey, updated);
        return updated;
      });
    }
    setFontUploading(false);
    e.target.value = '';
  };

  const handleRemoveFont = (name: string) => {
    setTemplate((prev) => {
      const updated = { ...prev, customFonts: (prev.customFonts ?? []).filter((f) => f.name !== name) };
      void saveCertTemplate(courseKey, updated);
      return updated;
    });
  };

  const handleMouseDown = (key: CertFieldKey, e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(key);
    setActiveField(key);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging || !previewRef.current) return;
    const rect = previewRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
    setTemplate((prev) => ({ ...prev, fields: { ...prev.fields, [dragging]: { ...prev.fields[dragging], x, y } } }));
  };

  const handleMouseUp = () => setDragging(null);

  const handleFieldProp = (key: CertFieldKey, prop: keyof CertTextField, value: string | number | boolean) => {
    setTemplate((prev) => ({ ...prev, fields: { ...prev.fields, [key]: { ...prev.fields[key], [prop]: value } } }));
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    const err = await saveCertTemplate(courseKey, template);
    setSaving(false);
    if (err) { setSaveError(err); } else { setSaved(true); setTimeout(() => setSaved(false), 2500); }
  };

  const handlePreview = () => {
    void downloadCertificate('Nama Peserta', courseTitle || courseKey, template);
  };

  if (loading) return <div className="forum-loading">Memuat template sertifikat…</div>;

  const field = template.fields[activeField];

  return (
    <div className="cert-designer">
      <div className="cert-designer-left">
        <div
          className="cert-preview-wrap"
          ref={previewRef}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          style={{ cursor: dragging ? 'grabbing' : 'default' }}
        >
          {template.bgUrl
            ? <img src={template.bgUrl} alt="background sertifikat" className="cert-preview-bg" draggable={false} />
            : (
              <div className="cert-preview-bg cert-preview-bg-empty">
                <span>Upload background sertifikat</span>
              </div>
            )
          }
          {(Object.keys(certFieldLabels) as CertFieldKey[]).map((key) => (
            <div
              key={key}
              className={`cert-field-marker ${activeField === key ? 'active' : ''}`}
              style={{
                left: `${template.fields[key].x}%`,
                top: `${template.fields[key].y}%`,
                transform: 'translate(-50%, -50%)',
                color: certFieldColors[key],
                fontFamily: template.fields[key].fontFamily,
                fontSize: `${Math.max(8, Math.round(template.fields[key].fontSize * ((previewRef.current?.clientWidth ?? 700) / 1280)))}px`,
                fontWeight: template.fields[key].bold ? 'bold' : 'normal',
                textAlign: template.fields[key].align as React.CSSProperties['textAlign'],
              }}
              onMouseDown={(e) => handleMouseDown(key, e)}
              title={`Drag untuk memindahkan ${certFieldLabels[key]}`}
            >
              <span className="cert-field-dot" style={{ background: certFieldColors[key] }} />
              {certFieldPreview[key]}
            </div>
          ))}
        </div>

        <div className="cert-designer-bg-actions">
          <input ref={bgInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleBgUpload} />
          <button type="button" className="button secondary" onClick={() => bgInputRef.current?.click()} disabled={bgUploading}>
            {bgUploading ? 'Mengupload…' : bgFile ? bgFile.name : '↑ Upload Background'}
          </button>
          {template.bgUrl && (
            <button type="button" className="button secondary" onClick={() => setTemplate((p) => ({ ...p, bgUrl: null }))}>
              Hapus Background
            </button>
          )}
          <button type="button" className="button secondary" onClick={handlePreview}>
            ↓ Preview Download
          </button>
        </div>
      </div>

      <div className="cert-designer-right">
        <div className="cert-field-tabs">
          {(Object.keys(certFieldLabels) as CertFieldKey[]).map((key) => (
            <button
              key={key}
              type="button"
              className={`cert-field-tab ${activeField === key ? 'active' : ''}`}
              style={activeField === key ? { borderColor: certFieldColors[key], color: certFieldColors[key] } : {}}
              onClick={() => setActiveField(key)}
            >
              <span className="cert-field-dot" style={{ background: certFieldColors[key] }} />
              {certFieldLabels[key]}
            </button>
          ))}
        </div>

        <div className="cert-field-controls">
          <label className="cert-ctrl-row">
            <span>Posisi X (%)</span>
            <input type="range" min="0" max="100" step="0.5" value={field.x} onChange={(e) => handleFieldProp(activeField, 'x', parseFloat(e.target.value))} />
            <span className="cert-ctrl-val">{field.x.toFixed(1)}</span>
          </label>
          <label className="cert-ctrl-row">
            <span>Posisi Y (%)</span>
            <input type="range" min="0" max="100" step="0.5" value={field.y} onChange={(e) => handleFieldProp(activeField, 'y', parseFloat(e.target.value))} />
            <span className="cert-ctrl-val">{field.y.toFixed(1)}</span>
          </label>
          <label className="cert-ctrl-row">
            <span>Ukuran Font (px)</span>
            <input type="range" min="8" max="200" step="1" value={field.fontSize} onChange={(e) => handleFieldProp(activeField, 'fontSize', parseFloat(e.target.value))} />
            <span className="cert-ctrl-val">{field.fontSize.toFixed(1)}</span>
          </label>
          <label className="cert-ctrl-row">
            <span>Font</span>
            <select value={field.fontFamily} onChange={(e) => handleFieldProp(activeField, 'fontFamily', e.target.value)}>
              <option value="Georgia">Georgia</option>
              <option value="Times New Roman">Times New Roman</option>
              <option value="Arial">Arial</option>
              <option value="Helvetica">Helvetica</option>
              <option value="Verdana">Verdana</option>
              <option value="Palatino">Palatino</option>
              {(template.customFonts ?? []).length > 0 && (
                <optgroup label="── Custom Fonts ──">
                  {(template.customFonts ?? []).map((f) => (
                    <option key={f.name} value={f.name}>{f.name}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>

          <div className="cert-ctrl-row cert-font-upload-row">
            <span>Custom Font</span>
            <input
              ref={fontInputRef}
              type="file"
              accept=".ttf,.otf,.woff,.woff2"
              style={{ display: 'none' }}
              onChange={handleFontUpload}
            />
            <button
              type="button"
              className="button secondary"
              style={{ fontSize: 12, padding: '4px 10px' }}
              onClick={() => fontInputRef.current?.click()}
              disabled={fontUploading}
            >
              {fontUploading ? 'Mengupload…' : '↑ Upload Font'}
            </button>
          </div>

          {(template.customFonts ?? []).length > 0 && (
            <div className="cert-custom-fonts-list">
              {(template.customFonts ?? []).map((f) => (
                <div key={f.name} className="cert-custom-font-item">
                  <span style={{ fontSize: 13 }}>{f.name}</span>
                  <button
                    type="button"
                    className="cert-remove-font-btn"
                    onClick={() => handleRemoveFont(f.name)}
                    title="Hapus font"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <label className="cert-ctrl-row">
            <span>Warna</span>
            <input type="color" value={field.color} onChange={(e) => handleFieldProp(activeField, 'color', e.target.value)} />
            <span className="cert-ctrl-val">{field.color}</span>
          </label>
          <label className="cert-ctrl-row">
            <span>Rata</span>
            <select value={field.align} onChange={(e) => handleFieldProp(activeField, 'align', e.target.value as CanvasTextAlign)}>
              <option value="left">Kiri</option>
              <option value="center">Tengah</option>
              <option value="right">Kanan</option>
            </select>
          </label>
          <label className="cert-ctrl-row">
            <span>Bold</span>
            <input type="checkbox" checked={field.bold} onChange={(e) => handleFieldProp(activeField, 'bold', e.target.checked)} />
          </label>
        </div>

        {saveError && <p style={{ fontSize: 12, color: '#e05a2b', marginTop: 8 }}>⚠ {saveError}</p>}
        <button type="button" className="button primary" style={{ marginTop: 8, width: '100%' }} onClick={handleSave} disabled={saving}>
          {saved ? '✓ Tersimpan' : saving ? 'Menyimpan…' : 'Simpan Template'}
        </button>
      </div>
    </div>
  );
}

// ── HppCalculator ────────────────────────────────────────────
function HppCalculator({ coinRate: coinRateDefault, packages }: { coinRate: number; packages: CreditPackage[] }) {
  const [hargaPerKoin, setHargaPerKoin] = useState(coinRateDefault);
  const [biayaSupabase, setBiayaSupabase] = useState(250000);
  const [biayaDomain, setBiayaDomain] = useState(50000);
  const [biayaTools, setBiayaTools] = useState(100000);
  const [biayaLainnya, setBiayaLainnya] = useState(0);
  const [pgFee, setPgFee] = useState(1.5);
  const [biayaSesi, setBiayaSesi] = useState(150000);
  const [proyeksiKoin, setProyeksiKoin] = useState(5000);
  const [proyeksiSesi, setProyeksiSesi] = useState(4);
  const [targetMargin, setTargetMargin] = useState(40);

  const totalFixedBulanan = biayaSupabase + biayaDomain + biayaTools + biayaLainnya;
  const totalBiayaSesiBulanan = proyeksiSesi * biayaSesi;
  const totalHPPBulanan = totalFixedBulanan + totalBiayaSesiBulanan;

  const hppPerKoin = proyeksiKoin > 0 ? totalHPPBulanan / proyeksiKoin : 0;
  const varCostPerKoin = hargaPerKoin * (pgFee / 100);
  const totalCostPerKoin = hppPerKoin + varCostPerKoin;

  const hargaMinimum = totalCostPerKoin > 0 ? totalCostPerKoin / (1 - targetMargin / 100) : 0;
  const marginSaatIni = hargaPerKoin > 0 ? ((hargaPerKoin - totalCostPerKoin) / hargaPerKoin) * 100 : 0;
  const breakEvenKoin = totalCostPerKoin > 0 ? Math.ceil(totalHPPBulanan / (hargaPerKoin - varCostPerKoin)) : 0;
  const pendapatanProyeksi = proyeksiKoin * hargaPerKoin;
  const labaBersihProyeksi = pendapatanProyeksi - totalHPPBulanan - (proyeksiKoin * varCostPerKoin);

  const fmt = (n: number) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(n);
  const fmtPct = (n: number) => `${n.toFixed(1)}%`;

  const marginColor = marginSaatIni >= targetMargin ? '#167f72' : marginSaatIni >= 20 ? '#e08c2a' : '#e05252';

  return (
    <div className="hpp-page">
      <div className="hpp-header">
        <h3 className="admin-section-title">Kalkulator HPP & Margin</h3>
        <p className="admin-section-sub">Hitung biaya pokok penjualan dan kelayakan harga coin berdasarkan struktur biaya bulananmu.</p>
      </div>

      <div className="hpp-layout">
        {/* ── Kolom Input ── */}
        <div className="hpp-inputs">

          <div className="hpp-section">
            <p className="hpp-section-title">📦 Biaya Tetap Bulanan</p>
            <div className="hpp-field-group">
              <div className="hpp-field">
                <label>Supabase (database + storage + edge fn)</label>
                <div className="hpp-input-wrap"><span>Rp</span><input type="number" min={0} step={1000} value={biayaSupabase} onChange={(e) => setBiayaSupabase(+e.target.value)} /></div>
              </div>
              <div className="hpp-field">
                <label>Domain & hosting</label>
                <div className="hpp-input-wrap"><span>Rp</span><input type="number" min={0} step={1000} value={biayaDomain} onChange={(e) => setBiayaDomain(+e.target.value)} /></div>
              </div>
              <div className="hpp-field">
                <label>Tools pendukung (Figma, Notion, dll)</label>
                <div className="hpp-input-wrap"><span>Rp</span><input type="number" min={0} step={1000} value={biayaTools} onChange={(e) => setBiayaTools(+e.target.value)} /></div>
              </div>
              <div className="hpp-field">
                <label>Biaya lainnya</label>
                <div className="hpp-input-wrap"><span>Rp</span><input type="number" min={0} step={1000} value={biayaLainnya} onChange={(e) => setBiayaLainnya(+e.target.value)} /></div>
              </div>
              <div className="hpp-subtotal">
                Total Fixed: <strong>{fmt(totalFixedBulanan)}</strong> / bulan
              </div>
            </div>
          </div>

          <div className="hpp-section">
            <p className="hpp-section-title">🎯 Biaya Variabel per Transaksi</p>
            <div className="hpp-field-group">
              <div className="hpp-field">
                <label>Payment gateway fee (%)</label>
                <div className="hpp-input-wrap"><input type="number" min={0} max={10} step={0.1} value={pgFee} onChange={(e) => setPgFee(+e.target.value)} /><span>%</span></div>
                <span className="hpp-hint">Midtrans/Xendit sekitar 0.7–2.9%</span>
              </div>
            </div>
          </div>

          <div className="hpp-section">
            <p className="hpp-section-title">👤 Biaya Sesi 1:1 (Opportunity Cost)</p>
            <div className="hpp-field-group">
              <div className="hpp-field">
                <label>Nilai waktu per sesi 1:1</label>
                <div className="hpp-input-wrap"><span>Rp</span><input type="number" min={0} step={10000} value={biayaSesi} onChange={(e) => setBiayaSesi(+e.target.value)} /></div>
                <span className="hpp-hint">Nilai jam kerjamu per sesi konsultasi</span>
              </div>
              <div className="hpp-field">
                <label>Estimasi sesi 1:1 per bulan</label>
                <div className="hpp-input-wrap"><input type="number" min={0} value={proyeksiSesi} onChange={(e) => setProyeksiSesi(+e.target.value)} /><span>sesi</span></div>
              </div>
              <div className="hpp-subtotal">
                Total biaya sesi: <strong>{fmt(totalBiayaSesiBulanan)}</strong> / bulan
              </div>
            </div>
          </div>

          <div className="hpp-section">
            <p className="hpp-section-title">📊 Proyeksi & Target</p>
            <div className="hpp-field-group">
              <div className="hpp-field">
                <label>Harga jual 1 Ruang Coin</label>
                <div className="hpp-input-wrap"><span>Rp</span><input type="number" min={100} step={100} value={hargaPerKoin} onChange={(e) => setHargaPerKoin(+e.target.value)} /></div>
                <span className="hpp-hint">Default dari pengaturan: {new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(coinRateDefault)}/koin</span>
              </div>
              <div className="hpp-field">
                <label>Proyeksi total koin terjual / bulan</label>
                <div className="hpp-input-wrap"><input type="number" min={1} step={100} value={proyeksiKoin} onChange={(e) => setProyeksiKoin(+e.target.value)} /><span>koin</span></div>
              </div>
              <div className="hpp-field">
                <label>Target margin keuntungan bersih</label>
                <div className="hpp-input-wrap"><input type="number" min={1} max={99} step={1} value={targetMargin} onChange={(e) => setTargetMargin(+e.target.value)} /><span>%</span></div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Kolom Hasil ── */}
        <div className="hpp-results">
          <div className="hpp-result-card hpp-result-primary">
            <div className="hpp-result-label">Margin Saat Ini</div>
            <div className="hpp-result-big" style={{ color: marginColor }}>{fmtPct(marginSaatIni)}</div>
            <div className="hpp-result-sub">Harga coin: {fmt(hargaPerKoin)}/koin</div>
          </div>

          <div className="hpp-result-grid">
            <div className="hpp-result-card">
              <div className="hpp-result-label">Total HPP Bulanan</div>
              <div className="hpp-result-value">{fmt(totalHPPBulanan)}</div>
              <div className="hpp-result-sub">Fixed + sesi 1:1</div>
            </div>
            <div className="hpp-result-card">
              <div className="hpp-result-label">HPP per Koin</div>
              <div className="hpp-result-value">{fmt(hppPerKoin)}</div>
              <div className="hpp-result-sub">Dari biaya tetap saja</div>
            </div>
            <div className="hpp-result-card">
              <div className="hpp-result-label">Total Cost per Koin</div>
              <div className="hpp-result-value">{fmt(totalCostPerKoin)}</div>
              <div className="hpp-result-sub">HPP + PG fee</div>
            </div>
            <div className="hpp-result-card">
              <div className="hpp-result-label">Harga Minimum Aman</div>
              <div className="hpp-result-value hpp-result-warn">{fmt(hargaMinimum)}</div>
              <div className="hpp-result-sub">Untuk margin {targetMargin}%</div>
            </div>
          </div>

          <div className="hpp-result-card hpp-breakeven">
            <div className="hpp-result-label">Break Even Point</div>
            <div className="hpp-result-value">{breakEvenKoin.toLocaleString('id-ID')} koin / bulan</div>
            <div className="hpp-result-sub">Minimum penjualan untuk tidak rugi</div>
          </div>

          <div className="hpp-result-card hpp-proyeksi">
            <div className="hpp-result-label">Proyeksi Bulan Ini</div>
            <div className="hpp-proyeksi-row">
              <span>Pendapatan kotor</span><strong>{fmt(pendapatanProyeksi)}</strong>
            </div>
            <div className="hpp-proyeksi-row">
              <span>HPP + PG fee</span><strong style={{color:'#e05252'}}>- {fmt(totalHPPBulanan + proyeksiKoin * varCostPerKoin)}</strong>
            </div>
            <div className="hpp-proyeksi-divider" />
            <div className="hpp-proyeksi-row hpp-proyeksi-total">
              <span>Laba Bersih</span>
              <strong style={{ color: labaBersihProyeksi >= 0 ? '#167f72' : '#e05252' }}>{fmt(labaBersihProyeksi)}</strong>
            </div>
          </div>

          {/* Tabel per paket */}
          <div className="hpp-result-card hpp-pkg-table-wrap">
            <div className="hpp-result-label" style={{marginBottom:10}}>Analisis per Paket</div>
            <table className="hpp-pkg-table">
              <thead>
                <tr><th>Paket</th><th>Koin</th><th>Harga</th><th>HPP</th><th>Margin</th><th>Status</th></tr>
              </thead>
              <tbody>
                {packages.map((pkg) => {
                  const hpp = totalCostPerKoin * pkg.credits;
                  const margin = pkg.price > 0 ? ((pkg.price - hpp) / pkg.price) * 100 : 0;
                  const ok = margin >= targetMargin;
                  const warn = margin >= 20 && margin < targetMargin;
                  return (
                    <tr key={pkg.id}>
                      <td>{pkg.label}</td>
                      <td>{pkg.credits}</td>
                      <td>{fmt(pkg.price)}</td>
                      <td>{fmt(hpp)}</td>
                      <td style={{ color: ok ? '#167f72' : warn ? '#e08c2a' : '#e05252', fontWeight: 700 }}>{fmtPct(margin)}</td>
                      <td><span className={`hpp-status-badge ${ok ? 'ok' : warn ? 'warn' : 'danger'}`}>{ok ? '✅ Aman' : warn ? '⚠️ Tipis' : '❌ Rugi'}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="hpp-disclaimer">* Perhitungan ini bersifat estimasi. Sesuaikan dengan kondisi bisnis aktual. HPP tidak memperhitungkan biaya konten/produksi materi kelas.</p>
        </div>
      </div>
    </div>
  );
}

// ── Help FAB (floating button) ────────────────────────────────
type HelpSettings = { videoUrl: string; whatsappNumber: string; whatsappMessage: string };
const helpSettingsKey = 'help_fab_settings';
const defaultHelpSettings: HelpSettings = { videoUrl: '', whatsappNumber: '', whatsappMessage: 'Halo, saya butuh bantuan.' };

async function loadHelpSettings(): Promise<HelpSettings> {
  const { data } = await supabase.from('learning_hub_content').select('content').eq('content_key', helpSettingsKey).maybeSingle();
  if (!data?.content) return { ...defaultHelpSettings };
  const raw = typeof data.content === 'string' ? JSON.parse(data.content) : data.content;
  return { ...defaultHelpSettings, ...(raw as HelpSettings) };
}
async function saveHelpSettings(s: HelpSettings): Promise<void> {
  await supabase.from('learning_hub_content').upsert({ content_key: helpSettingsKey, content_group: 'admin', content: s, updated_at: new Date().toISOString() });
}

function HelpFab({ settings }: { settings: HelpSettings }) {
  const [open, setOpen] = useState(false);
  const [showVideo, setShowVideo] = useState(false);

  const hasAny = settings.videoUrl || settings.whatsappNumber;
  if (!hasAny) return null;

  const waUrl = settings.whatsappNumber
    ? `https://wa.me/${settings.whatsappNumber.replace(/\D/g, '')}?text=${encodeURIComponent(settings.whatsappMessage || 'Halo, saya butuh bantuan.')}`
    : null;

  return (
    <>
      <div className="help-fab-wrap">
        {/* Menu popup */}
        <div className={`help-fab-menu${open ? ' open' : ''}`}>
          {settings.videoUrl && (
            <button type="button" className="help-fab-menu-item" onClick={() => { setShowVideo(true); setOpen(false); }}>
              <span className="help-fab-menu-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/>
                </svg>
              </span>
              <span>Tonton Video Tutorial</span>
            </button>
          )}
          {waUrl && (
            <a href={waUrl} target="_blank" rel="noopener noreferrer" className="help-fab-menu-item" onClick={() => setOpen(false)}>
              <span className="help-fab-menu-icon help-fab-menu-icon--wa">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                </svg>
              </span>
              <span>Hubungi WhatsApp</span>
            </a>
          )}
        </div>

        {/* FAB button */}
        <button
          type="button"
          className={`help-fab-btn${open ? ' active' : ''}`}
          onClick={() => setOpen((v) => !v)}
          aria-label="Bantuan"
        >
          <span className={`help-fab-icon${open ? ' rotated' : ''}`}>
            {open
              ? <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            }
          </span>
        </button>

        {/* Backdrop */}
        {open && <div className="help-fab-backdrop" onClick={() => setOpen(false)} />}
      </div>

      {/* Video modal */}
      {showVideo && settings.videoUrl && createPortal(
        <div className="help-video-overlay" onClick={() => setShowVideo(false)}>
          <div className="help-video-modal" onClick={(e) => e.stopPropagation()}>
            <div className="help-video-header">
              <span className="help-video-title">Video Tutorial</span>
              <button type="button" className="help-video-close" onClick={() => setShowVideo(false)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="help-video-body">
              <iframe
                src={(() => {
                  const url = settings.videoUrl.trim();
                  try {
                    const parsed = new URL(url);
                    let videoId = '';
                    if (parsed.hostname === 'youtu.be') {
                      videoId = parsed.pathname.slice(1);
                    } else {
                      videoId = parsed.searchParams.get('v') ?? '';
                    }
                    if (videoId) return `https://www.youtube.com/embed/${videoId}?rel=0&modestbranding=1&mute=0`;
                  } catch { /* fall through */ }
                  return url;
                })()}
                title="Video Tutorial"
                className="help-video-iframe"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                referrerPolicy="strict-origin-when-cross-origin"
                allowFullScreen
              />
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// ── Dashboard Banner ─────────────────────────────────────────
type BannerSlide = { id: string; imageUrl: string; linkUrl?: string; title?: string };
type BannerSettings = { enabled: boolean; autoPlay: boolean; intervalSec: number; slides: BannerSlide[] };

const bannerKey = 'dashboard_banner_settings';
const defaultBannerSettings: BannerSettings = { enabled: false, autoPlay: true, intervalSec: 4, slides: [] };

async function loadBannerSettings(): Promise<BannerSettings> {
  const { data } = await supabase.from('learning_hub_content').select('content').eq('content_key', bannerKey).maybeSingle();
  if (!data?.content) return { ...defaultBannerSettings };
  const raw = typeof data.content === 'string' ? JSON.parse(data.content) : data.content;
  return { ...defaultBannerSettings, ...(raw as BannerSettings) };
}

async function saveBannerSettings(s: BannerSettings): Promise<void> {
  await supabase.from('learning_hub_content').upsert({ content_key: bannerKey, content_group: 'admin', content: s, updated_at: new Date().toISOString() });
}

async function uploadBannerImage(file: File, slideId: string): Promise<string> {
  const ext = file.name.split('.').pop() ?? 'jpg';
  const path = `banners/${slideId}.${ext}`;
  await supabase.storage.from('lesson-assets').remove([`banners/${slideId}.jpg`, `banners/${slideId}.png`, `banners/${slideId}.webp`]);
  await supabase.storage.from('lesson-assets').upload(path, file, { upsert: true, contentType: file.type });
  return supabase.storage.from('lesson-assets').getPublicUrl(path).data.publicUrl;
}

function DashboardBanner({ settings }: { settings: BannerSettings }) {
  const [current, setCurrent] = useState(0);
  const [paused, setPaused] = useState(false);
  const { slides, autoPlay, intervalSec } = settings;

  useEffect(() => {
    if (!autoPlay || paused || slides.length <= 1) return;
    const t = setInterval(() => setCurrent((c) => (c + 1) % slides.length), intervalSec * 1000);
    return () => clearInterval(t);
  }, [autoPlay, paused, slides.length, intervalSec]);

  useEffect(() => { setCurrent(0); }, [slides.length]);

  if (!settings.enabled || slides.length === 0) return null;

  const goTo = (i: number) => setCurrent((i + slides.length) % slides.length);

  return (
    <div
      className="db-banner-wrap"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* sliding track */}
      <div className="db-banner-track" style={{ transform: `translateX(-${current * 100}%)` }}>
        {slides.map((slide, i) => {
          const img = <img src={slide.imageUrl} alt={slide.title ?? 'Banner'} className="db-banner-img" loading="eager" />;
          return (
            <div key={i} className="db-banner-slide">
              {slide.linkUrl
                ? <a href={slide.linkUrl} target={slide.linkUrl.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer">{img}</a>
                : img}
            </div>
          );
        })}
      </div>

      {/* controls */}
      {slides.length > 1 && (
        <>
          <button type="button" className="db-banner-arrow db-banner-arrow--left" onClick={() => goTo(current - 1)}>‹</button>
          <button type="button" className="db-banner-arrow db-banner-arrow--right" onClick={() => goTo(current + 1)}>›</button>
          <div className="db-banner-dots">
            {slides.map((_, i) => (
              <button key={i} type="button" className={`db-banner-dot${i === current ? ' active' : ''}`} onClick={() => setCurrent(i)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Theme color helpers ──────────────────────────────────────
function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const n = parseInt(clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function blendWithWhite(r: number, g: number, b: number, alpha: number): string {
  const rr = Math.round(r * alpha + 255 * (1 - alpha));
  const gg = Math.round(g * alpha + 255 * (1 - alpha));
  const bb = Math.round(b * alpha + 255 * (1 - alpha));
  return `#${rr.toString(16).padStart(2, '0')}${gg.toString(16).padStart(2, '0')}${bb.toString(16).padStart(2, '0')}`;
}

function deriveThemeFromAccent(accent: string): Omit<AppTheme, 'id' | 'name'> {
  const [r, g, b] = hexToRgb(accent);
  const lr = Math.round(r * 0.4 + 255 * 0.6);
  const lg = Math.round(g * 0.4 + 255 * 0.6);
  const lb = Math.round(b * 0.4 + 255 * 0.6);
  return {
    accent,
    accentRgb: `${r}, ${g}, ${b}`,
    accentLightRgb: `${lr}, ${lg}, ${lb}`,
    accentSoft: blendWithWhite(r, g, b, 0.15),
    bg: blendWithWhite(r, g, b, 0.06),
    bgStrong: blendWithWhite(r, g, b, 0.14),
  };
}

// ── ThemeEditor ────────────────────────────────────────────────

function ThemeEditor() {
  const [activeThemeId, setActiveThemeId] = useState<string>('purple');
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [showCustomModal, setShowCustomModal] = useState(false);
  const [customColor, setCustomColor] = useState('#7a4fd6');
  const [customSaving, setCustomSaving] = useState(false);

  useEffect(() => {
    void loadAppTheme().then((id) => { setActiveThemeId(id); applyAppTheme(id); });
  }, []);

  useEffect(() => {
    if (!showCustomModal || customColor.length < 4) return;
    const derived = deriveThemeFromAccent(customColor);
    let styleEl = document.getElementById('app-theme-override') as HTMLStyleElement | null;
    if (!styleEl) { styleEl = document.createElement('style'); styleEl.id = 'app-theme-override'; document.head.appendChild(styleEl); }
    styleEl.textContent = `:root { --accent: ${derived.accent}; --accent-soft: ${derived.accentSoft}; --accent-rgb: ${derived.accentRgb}; --accent-light-rgb: ${derived.accentLightRgb}; --bg: ${derived.bg}; --bg-strong: ${derived.bgStrong}; }`;
  }, [customColor, showCustomModal]);

  async function handleApply(id: string) {
    setSavingId(id);
    applyAppTheme(id);
    await saveAppTheme(id);
    setActiveThemeId(id);
    setSavingId(null);
    setSavedId(id);
    setTimeout(() => setSavedId(null), 2000);
  }

  async function handleApplyCustom() {
    setCustomSaving(true);
    const derived = deriveThemeFromAccent(customColor);
    const customThemeId = `custom_${customColor.replace('#', '')}`;
    // inject style directly
    let styleEl = document.getElementById('app-theme-override') as HTMLStyleElement | null;
    if (!styleEl) { styleEl = document.createElement('style'); styleEl.id = 'app-theme-override'; document.head.appendChild(styleEl); }
    styleEl.textContent = `:root { --accent: ${derived.accent}; --accent-soft: ${derived.accentSoft}; --accent-rgb: ${derived.accentRgb}; --accent-light-rgb: ${derived.accentLightRgb}; --bg: ${derived.bg}; --bg-strong: ${derived.bgStrong}; }`;
    await supabase.from('learning_hub_content').upsert({ content_key: appThemeKey, content_group: 'admin', content: { themeId: customThemeId, customColor }, updated_at: new Date().toISOString() });
    setActiveThemeId(customThemeId);
    setCustomSaving(false);
    setShowCustomModal(false);
  }

  function closeCustomModal() {
    setShowCustomModal(false);
    // restore previous theme
    applyAppTheme(activeThemeId);
  }

  const isCustomActive = activeThemeId.startsWith('custom_');
  const customPreview = deriveThemeFromAccent(customColor);

  return (
    <div className="theme-editor">
      <div className="theme-editor-header">
        <h3 className="theme-editor-title">Tema Aplikasi</h3>
        <p className="theme-editor-desc">Pilih warna tema untuk seluruh tampilan aplikasi (berlaku untuk semua pengguna).</p>
      </div>

      <div className="theme-palette-grid">
        {APP_THEMES.map((t) => {
          const isActive = activeThemeId === t.id;
          const isSaving = savingId === t.id;
          const isSaved = savedId === t.id;
          return (
            <div key={t.id} className={`theme-palette-card${isActive ? ' selected' : ''}`}>
              <div className="theme-palette-preview" style={{ background: `linear-gradient(135deg, ${t.bg} 0%, ${t.bgStrong} 100%)` }}>
                <div className="theme-palette-dot" style={{ background: t.accent }} />
                <div className="theme-palette-bar" style={{ background: t.accentSoft }} />
                <div className="theme-palette-bar theme-palette-bar--short" style={{ background: t.accentSoft }} />
              </div>
              <div className="theme-palette-info">
                <span className="theme-palette-swatch" style={{ background: t.accent }} />
                <span className="theme-palette-name">{t.name}</span>
              </div>
              <div className="theme-palette-action">
                {isActive ? (
                  <span className="theme-palette-active-badge">✓ Aktif</span>
                ) : (
                  <button type="button" className="theme-palette-apply-btn" style={{ background: t.accent }} onClick={() => void handleApply(t.id)} disabled={isSaving}>
                    {isSaving ? 'Menerapkan…' : isSaved ? '✓ Diterapkan' : 'Terapkan'}
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {/* Custom color card */}
        <div className={`theme-palette-card${isCustomActive ? ' selected' : ''}`}>
          <div className="theme-palette-preview theme-palette-preview--custom">
            <div className="theme-custom-rainbow" />
            <span className="theme-custom-icon">🎨</span>
          </div>
          <div className="theme-palette-info">
            <span className="theme-palette-swatch" style={{ background: isCustomActive ? `#${activeThemeId.replace('custom_', '')}` : 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' }} />
            <span className="theme-palette-name">Warna Kustom</span>
          </div>
          <div className="theme-palette-action">
            {isCustomActive ? (
              <button type="button" className="theme-palette-apply-btn" style={{ background: `#${activeThemeId.replace('custom_', '')}` }} onClick={() => setShowCustomModal(true)}>
                ✓ Aktif · Ubah
              </button>
            ) : (
              <button type="button" className="theme-palette-apply-btn theme-palette-apply-btn--custom" onClick={() => setShowCustomModal(true)}>
                Pilih Warna
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Custom color modal */}
      {showCustomModal && createPortal(
        <div className="admin-modal-overlay" onClick={closeCustomModal}>
          <div className="theme-custom-modal" onClick={(e) => e.stopPropagation()}>
            <div className="theme-custom-modal-header">
              <h3>Pilih Warna Kustom</h3>
              <button type="button" className="admin-modal-close" onClick={closeCustomModal}>✕</button>
            </div>

            <div className="theme-custom-modal-body">
              {/* Color picker */}
              <div className="theme-custom-picker-wrap">
                <input type="color" value={customColor} onChange={(e) => setCustomColor(e.target.value)} className="theme-custom-color-input" />
                <div className="theme-custom-hex-wrap">
                  <span className="theme-custom-hex-label">HEX</span>
                  <input
                    type="text"
                    value={customColor}
                    onChange={(e) => { if (/^#[0-9a-fA-F]{0,6}$/.test(e.target.value)) setCustomColor(e.target.value); }}
                    className="theme-custom-hex-input"
                    maxLength={7}
                    spellCheck={false}
                  />
                </div>
              </div>

              {/* Live preview */}
              <div className="theme-custom-preview-box" style={{ background: `linear-gradient(135deg, ${customPreview.bg} 0%, ${customPreview.bgStrong} 100%)` }}>
                <div className="theme-custom-preview-topbar" style={{ background: customPreview.accentSoft }}>
                  <div className="theme-custom-preview-dot" style={{ background: customPreview.accent }} />
                  <div className="theme-custom-preview-line" style={{ background: customPreview.accent, opacity: 0.3 }} />
                  <div className="theme-custom-preview-line theme-custom-preview-line--short" style={{ background: customPreview.accent, opacity: 0.2 }} />
                </div>
                <div className="theme-custom-preview-content">
                  <div className="theme-custom-preview-card" style={{ background: 'rgba(255,255,255,0.8)', border: `1px solid ${customPreview.accentSoft}` }}>
                    <div className="theme-custom-preview-card-dot" style={{ background: customPreview.accent }} />
                    <div className="theme-custom-preview-card-line" style={{ background: customPreview.accentSoft }} />
                    <div className="theme-custom-preview-card-btn" style={{ background: customPreview.accent }} />
                  </div>
                  <div className="theme-custom-preview-card" style={{ background: 'rgba(255,255,255,0.8)', border: `1px solid ${customPreview.accentSoft}` }}>
                    <div className="theme-custom-preview-card-dot" style={{ background: customPreview.accentSoft }} />
                    <div className="theme-custom-preview-card-line" style={{ background: customPreview.accentSoft }} />
                    <div className="theme-custom-preview-card-btn" style={{ background: customPreview.accent }} />
                  </div>
                </div>
                <p className="theme-custom-preview-label">Preview Tema</p>
              </div>
            </div>

            <div className="theme-custom-modal-footer">
              <button type="button" className="admin-btn" onClick={closeCustomModal}>Batal</button>
              <button type="button" className="admin-btn admin-btn--primary" style={{ background: customColor }} onClick={() => void handleApplyCustom()} disabled={customSaving || customColor.length < 4}>
                {customSaving ? 'Menerapkan…' : 'Terapkan Warna Ini'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── Banner Slider Editor ──────────────────────────────── */}
      <BannerEditor />

      {/* ── Help FAB Editor ──────────────────────────────────── */}
      <HelpEditor />
    </div>
  );
}

// ── BannerEditor ──────────────────────────────────────────────
function BannerEditor() {
  const [settings, setSettings] = useState<BannerSettings>(defaultBannerSettings);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [newLinkUrl, setNewLinkUrl] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newFile, setNewFile] = useState<File | null>(null);
  const [newPreview, setNewPreview] = useState<string | null>(null);

  useEffect(() => { void loadBannerSettings().then(setSettings); }, []);

  const save = async (next: BannerSettings) => {
    setSaving(true);
    await saveBannerSettings(next);
    setSettings(next);
    setSaving(false);
  };

  const toggleEnabled = () => void save({ ...settings, enabled: !settings.enabled });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setNewFile(f);
    if (f) setNewPreview(URL.createObjectURL(f));
  };

  const addSlide = async () => {
    if (!newFile) return;
    setUploading(true);
    try {
      const id = `slide_${Date.now()}`;
      const imageUrl = await uploadBannerImage(newFile, id);
      const slide: BannerSlide = { id, imageUrl, linkUrl: newLinkUrl || undefined, title: newTitle || undefined };
      const next = { ...settings, slides: [...settings.slides, slide] };
      await save(next);
      setNewFile(null);
      setNewPreview(null);
      setNewLinkUrl('');
      setNewTitle('');
    } finally {
      setUploading(false);
    }
  };

  const removeSlide = async (id: string) => {
    const slide = settings.slides.find((s) => s.id === id);
    if (!slide) return;
    const ext = slide.imageUrl.split('.').pop()?.split('?')[0] ?? 'jpg';
    await supabase.storage.from('lesson-assets').remove([`banners/${id}.${ext}`]);
    await save({ ...settings, slides: settings.slides.filter((s) => s.id !== id) });
  };

  const moveSlide = async (idx: number, dir: -1 | 1) => {
    const arr = [...settings.slides];
    const target = idx + dir;
    if (target < 0 || target >= arr.length) return;
    [arr[idx], arr[target]] = [arr[target], arr[idx]];
    await save({ ...settings, slides: arr });
  };

  return (
    <div className="banner-editor">
      {/* ── Header ── */}
      <div className="banner-editor-header">
        <div className="banner-editor-header-left">
          <div className="banner-editor-icon">🖼️</div>
          <div>
            <h3 className="banner-editor-title">Banner Slider Dashboard</h3>
            <p className="banner-editor-hint">Tampil di atas halaman dashboard · Ukuran disarankan <strong>1200 × 260 px</strong> (rasio 1200:260)</p>
          </div>
        </div>
        <div className="banner-editor-toggle-wrap">
          <span className={`banner-toggle-status${settings.enabled ? ' on' : ''}`}>{settings.enabled ? '● Aktif' : '○ Nonaktif'}</span>
          <div className={`banner-toggle${settings.enabled ? ' on' : ''}`} onClick={toggleEnabled} role="switch" aria-checked={settings.enabled} />
        </div>
      </div>

      {/* ── Settings bar ── */}
      <div className="banner-settings-bar">
        <div className="banner-settings-item">
          <span className="banner-settings-label">⏱ Auto-slide tiap</span>
          <select className="banner-settings-select" value={settings.intervalSec}
            onChange={(e) => void save({ ...settings, intervalSec: Number(e.target.value) })}>
            {[2, 3, 4, 5, 6, 8, 10].map((n) => <option key={n} value={n}>{n} detik</option>)}
          </select>
        </div>
        <div className="banner-settings-item">
          <span className="banner-settings-label">🖼 Total Slide</span>
          <span className="banner-settings-value">{settings.slides.length} slide{settings.slides.length !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {/* ── Slide list ── */}
      {settings.slides.length > 0 && (
        <div className="banner-slide-list">
          <p className="banner-slide-list-label">Daftar Slide</p>
          {settings.slides.map((s, i) => (
            <div key={s.id} className="banner-slide-item">
              <div className="banner-slide-num">{i + 1}</div>
              <img src={s.imageUrl} alt={s.title ?? 'Banner'} className="banner-slide-thumb" />
              <div className="banner-slide-meta">
                <span className="banner-slide-name">{s.title || `Slide ${i + 1}`}</span>
                {s.linkUrl
                  ? <span className="banner-slide-link">🔗 {s.linkUrl}</span>
                  : <span className="banner-slide-link banner-slide-link--empty">Tanpa link</span>}
              </div>
              <div className="banner-slide-actions">
                <button type="button" className="banner-act-btn" onClick={() => void moveSlide(i, -1)} disabled={i === 0} title="Naik">↑</button>
                <button type="button" className="banner-act-btn" onClick={() => void moveSlide(i, 1)} disabled={i === settings.slides.length - 1} title="Turun">↓</button>
                <button type="button" className="banner-act-btn banner-act-btn--danger" onClick={() => void removeSlide(s.id)} title="Hapus">✕</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Add slide ── */}
      <div className="banner-add-form">
        <div className="banner-add-form-header">
          <span className="banner-add-form-icon">＋</span>
          <h4 className="banner-add-title">Tambah Slide Baru</h4>
        </div>

        <label className="banner-upload-zone">
          <input type="file" accept="image/*" onChange={handleFileChange} style={{ display: 'none' }} />
          {newPreview
            ? <img src={newPreview} alt="Preview" className="banner-add-preview" />
            : (
              <div className="banner-upload-placeholder">
                <span className="banner-upload-icon">📁</span>
                <span className="banner-upload-text">Klik untuk pilih gambar banner</span>
                <span className="banner-upload-sub">PNG, JPG, WebP · Maks. 5 MB</span>
              </div>
            )}
          {newPreview && <div className="banner-upload-change-badge">Ganti Gambar</div>}
        </label>

        <div className="banner-add-fields">
          <div className="banner-add-field">
            <label className="banner-add-field-label">Judul Slide <span>(opsional)</span></label>
            <input type="text" className="admin-input" placeholder="mis. Promo Akhir Tahun" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
          </div>
          <div className="banner-add-field">
            <label className="banner-add-field-label">URL Tujuan Klik <span>(opsional)</span></label>
            <input type="text" className="admin-input" placeholder="mis. #catalog atau https://..." value={newLinkUrl} onChange={(e) => setNewLinkUrl(e.target.value)} />
          </div>
        </div>

        <button type="button" className="banner-add-btn" disabled={!newFile || uploading || saving} onClick={() => void addSlide()}>
          {uploading ? <><span className="banner-add-btn-spinner" /> Mengunggah…</> : '＋ Tambah Slide'}
        </button>
      </div>
    </div>
  );
}

// ── HelpEditor ───────────────────────────────────────────────
function HelpEditor() {
  const [settings, setSettings] = useState<HelpSettings>(defaultHelpSettings);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { void loadHelpSettings().then(setSettings); }, []);

  const save = async () => {
    setSaving(true);
    await saveHelpSettings(settings);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="help-editor">
      <div className="help-editor-header">
        <div className="help-editor-header-left">
          <div className="help-editor-icon">💬</div>
          <div>
            <h3 className="help-editor-title">Tombol Bantuan (Help Button)</h3>
            <p className="help-editor-hint">Tombol ? di pojok kanan bawah — muncul otomatis jika minimal satu field diisi</p>
          </div>
        </div>
      </div>

      <div className="help-editor-fields">
        <div className="help-editor-field">
          <label className="help-editor-label">
            <span className="help-editor-label-icon">▶</span>
            Link Video Tutorial
            <span className="help-editor-label-sub">URL YouTube (mis. https://youtu.be/xxx)</span>
          </label>
          <input
            type="text"
            className="admin-input"
            placeholder="https://youtu.be/..."
            value={settings.videoUrl}
            onChange={(e) => setSettings({ ...settings, videoUrl: e.target.value })}
          />
        </div>

        <div className="help-editor-field">
          <label className="help-editor-label">
            <span className="help-editor-label-icon">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style={{ color: '#25D366' }}>
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
              </svg>
            </span>
            Nomor WhatsApp Admin
            <span className="help-editor-label-sub">Format internasional tanpa + (mis. 6281234567890)</span>
          </label>
          <input
            type="text"
            className="admin-input"
            placeholder="6281234567890"
            value={settings.whatsappNumber}
            onChange={(e) => setSettings({ ...settings, whatsappNumber: e.target.value })}
          />
        </div>

        <div className="help-editor-field">
          <label className="help-editor-label">
            <span className="help-editor-label-icon">✏️</span>
            Pesan WhatsApp Default
            <span className="help-editor-label-sub">Teks awal saat user membuka WhatsApp</span>
          </label>
          <input
            type="text"
            className="admin-input"
            placeholder="Halo, saya butuh bantuan."
            value={settings.whatsappMessage}
            onChange={(e) => setSettings({ ...settings, whatsappMessage: e.target.value })}
          />
        </div>
      </div>

      <button type="button" className="help-editor-save-btn" onClick={() => void save()} disabled={saving}>
        {saved ? '✓ Tersimpan' : saving ? 'Menyimpan…' : 'Simpan Pengaturan'}
      </button>
    </div>
  );
}

// ── AdminPage ────────────────────────────────────────────────

function AdminPage({ session, featureCosts, onFeatureCostsChange }: { session: AppSession; featureCosts: FeatureCosts; onFeatureCostsChange: (c: FeatureCosts) => void }) {
  const [activeTab, setActiveTab] = useState<'users' | 'credits' | 'revenue' | 'referral' | 'promo' | 'sertifikat' | 'hpp' | 'landing' | 'tema' | 'analytics' | 'monitor'>('users');
  const { confirm: confirmDialog, modal: confirmModal } = useConfirm();
  const [certCourses, setCertCourses] = useState<{ key: string; title: string }[]>([]);
  const [certSelectedKey, setCertSelectedKey] = useState<string | null>(null);
  const [promo, setPromo] = useState<PromoPopup>({ ...defaultPromo });
  const [promoSaving, setPromoSaving] = useState(false);
  const [promoSaved, setPromoSaved] = useState(false);
  const [promoBroadcasting, setPromoBroadcasting] = useState(false);
  const [promoBroadcastSent, setPromoBroadcastSent] = useState(false);
  const [promoIconUploading, setPromoIconUploading] = useState(false);
  const [promoIconFile, setPromoIconFile] = useState<File | null>(null);
  const [promoIconLocalUrl, setPromoIconLocalUrl] = useState<string | null>(null);
  const [referralCodes, setReferralCodes] = useState<ReferralCode[]>([]);
  const [referralUsage, setReferralUsage] = useState<Record<string, number>>({});
  const [editingReferral, setEditingReferral] = useState<(ReferralCode & { idx: number }) | null>(null);
  const [showAddReferral, setShowAddReferral] = useState(false);
  const [referralDraft, setReferralDraft] = useState<ReferralCode>({ code: '', credits: 0, description: '', expiresAt: '' });
  const [referralSaving, setReferralSaving] = useState(false);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [transactions, setTransactions] = useState<CreditTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [userSearch, setUserSearch] = useState('');
  const [userPage, setUserPage] = useState(0);
  const [userReferralFilter, setUserReferralFilter] = useState('');
  const [selectedUsernames, setSelectedUsernames] = useState<Set<string>>(new Set());
  const [showBulkAccessModal, setShowBulkAccessModal] = useState(false);
  const [bulkDraftPerks, setBulkDraftPerks] = useState<UserPerks>({});
  const [bulkSaving, setBulkSaving] = useState(false);
  const USERS_PER_PAGE = 20;

  // Credit packages & payment info (editable)
  const [packages, setPackages] = useState<CreditPackage[]>(defaultCreditPackages);
  const [paymentInfo, setPaymentInfo] = useState<PaymentInfo>(defaultPaymentInfo);

  // Modal states
  const [showAddUser, setShowAddUser] = useState(false);
  const [showAddCredits, setShowAddCredits] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [selectedPackage, setSelectedPackage] = useState<CreditPackage>(defaultCreditPackages[1]);
  const [customCredits, setCustomCredits] = useState('');
  const [creditNote, setCreditNote] = useState('');

  // Settings draft
  const [draftPackages, setDraftPackages] = useState<CreditPackage[]>(defaultCreditPackages);
  const [draftPayment, setDraftPayment] = useState<PaymentInfo>(defaultPaymentInfo);
  const [draftReferralCodes, setDraftReferralCodes] = useState<ReferralCode[]>([]);
  const [draftCoinRate, setDraftCoinRate] = useState<number>(CREDIT_RATE);
  const [draftStudentBotToken, setDraftStudentBotToken] = useState('');
  const [settingsSaving, setSettingsSaving] = useState(false);

  // Feature costs
  const [draftCosts, setDraftCosts] = useState<FeatureCosts>({ ...featureCosts });
  const [costsSaving, setCostsSaving] = useState(false);
  const [costsSaved, setCostsSaved] = useState(false);
  const [showCostsModal, setShowCostsModal] = useState(false);
  const [showRewardsModal, setShowRewardsModal] = useState(false);
  const [draftRewards, setDraftRewards] = useState<CoinRewards>({ ...defaultCoinRewards });
  const [rewardsSaving, setRewardsSaving] = useState(false);
  const [rewardsSaved, setRewardsSaved] = useState(false);
  const [showResetTxModal, setShowResetTxModal] = useState(false);
  const [resettingTx, setResettingTx] = useState(false);

  // Perks modal
  const [showPerksModal, setShowPerksModal] = useState(false);
  const [perksUser, setPerksUser] = useState<AdminUser | null>(null);
  const [draftPerks, setDraftPerks] = useState<UserPerks>({});
  const [perksSaving, setPerksSaving] = useState(false);

  // Add user form
  const [newUsername, setNewUsername] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('student');
  const [newInitialCredits, setNewInitialCredits] = useState('0');
  const [addUserError, setAddUserError] = useState('');
  const [saving, setSaving] = useState(false);

  // Reset semua riwayat transaksi Ruang Coin → mengenolkan stat
  // "Ruang Coin Tersalurkan" & "Est. Pendapatan".
  const handleResetTransactions = async () => {
    setResettingTx(true);
    await supabase.from('credit_transactions').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    setResettingTx(false);
    setShowResetTxModal(false);
    void loadData();
  };

  const loadData = async () => {
    setLoading(true);
    const [{ data: appUsers }, { data: profiles }, { data: credits }, { data: txs }, settings] =
      await Promise.all([
        supabase.from('app_users').select('username, display_name, role, is_active, created_at').order('created_at', { ascending: false }),
        supabase.from('user_profiles').select('username, email, perks, avatar_path, name, referral_code, referral_perks, referral_perks_expires_at'),
        supabase.from('user_credits').select('username, balance'),
        supabase.from('credit_transactions').select('*').order('created_at', { ascending: false }).limit(50),
        loadAdminSettings(),
      ]);
    setPackages(settings.packages);
    setPaymentInfo(settings.payment);
    setDraftPackages(settings.packages);
    setDraftPayment(settings.payment);
    setDraftReferralCodes(settings.referralCodes ?? []);
    setDraftCoinRate(settings.coin_rate ?? CREDIT_RATE);
    setDraftStudentBotToken(settings.student_bot_token ?? '');
    setDraftRewards({ ...defaultCoinRewards, ...(settings.coin_rewards ?? {}) });
    setReferralCodes(settings.referralCodes ?? []);

    // Count usage per referral code from user_profiles
    const { data: refUsageRows } = await supabase.from('user_profiles').select('referral_code').not('referral_code', 'is', null);
    const usageCounts: Record<string, number> = {};
    for (const row of refUsageRows ?? []) {
      const code = (row as { referral_code?: string }).referral_code;
      if (code) usageCounts[code] = (usageCounts[code] ?? 0) + 1;
    }
    setReferralUsage(usageCounts);

    setPromo(settings.promo ?? { ...defaultPromo });
    setSelectedPackage(settings.packages[1] ?? settings.packages[0]);

    const profileMap: Record<string, { email: string; perks: UserPerks; referralPerks: UserPerks; referralPerksExpiresAt: string | null; avatarUrl: string | null; name: string | null; referralCode: string | null }> = {};
    for (const p of profiles ?? []) profileMap[p.username] = { email: p.email ?? '', perks: (p.perks ?? {}) as UserPerks, referralPerks: ((p as { referral_perks?: UserPerks }).referral_perks ?? {}) as UserPerks, referralPerksExpiresAt: (p as { referral_perks_expires_at?: string | null }).referral_perks_expires_at ?? null, avatarUrl: p.avatar_path ? profileAvatarPublicUrl(p.avatar_path) : null, name: p.name ?? null, referralCode: (p as { referral_code?: string | null }).referral_code ?? null };
    const creditMap: Record<string, number> = {};
    for (const c of credits ?? []) creditMap[c.username] = c.balance;

    setUsers(
      (appUsers ?? []).map((u) => ({
        username: u.username,
        displayName: profileMap[u.username]?.name || u.display_name || u.username,
        role: u.role,
        isActive: u.is_active,
        createdAt: u.created_at,
        credits: creditMap[u.username] ?? 0,
        email: profileMap[u.username]?.email,
        perks: profileMap[u.username]?.perks ?? {},
        referralPerks: profileMap[u.username]?.referralPerks ?? {},
        referralPerksExpiresAt: profileMap[u.username]?.referralPerksExpiresAt ?? null,
        avatarUrl: profileMap[u.username]?.avatarUrl ?? null,
        referralCode: profileMap[u.username]?.referralCode ?? null,
      })),
    );

    setTransactions(
      (txs ?? []).map((t) => ({
        id: t.id,
        username: t.username,
        amount: t.amount,
        type: t.type,
        description: t.description,
        createdAt: t.created_at,
      })),
    );

    setLoading(false);
    const { data: courseRows } = await supabase.from('courses').select('key, title').order('sort_order', { ascending: true });
    const list = (courseRows ?? []) as { key: string; title: string }[];
    setCertCourses(list);
    if (list.length > 0) setCertSelectedKey((prev) => prev ?? list[0].key);
  };

  useEffect(() => { void loadData(); }, []);

  // Realtime: auto-refresh user list on any change to app_users
  useEffect(() => {
    const channel = supabase
      .channel('admin-app-users')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'app_users' }, () => {
        void loadData();
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, []);

  const handleSaveSettings = async () => {
    setSettingsSaving(true);
    await saveAdminSettings({ packages: draftPackages, payment: draftPayment, referralCodes: draftReferralCodes, coin_rate: draftCoinRate, student_bot_token: draftStudentBotToken });
    setReferralCodes(draftReferralCodes);
    setPackages(draftPackages);
    setPaymentInfo(draftPayment);
    setSelectedPackage(draftPackages[1] ?? draftPackages[0]);
    setSettingsSaving(false);
    setShowSettings(false);
  };

  const saveReferralCodes = async (codes: ReferralCode[]) => {
    const settings = await loadAdminSettings();
    await saveAdminSettings({ ...settings, referralCodes: codes });
    setReferralCodes(codes);
    setDraftReferralCodes(codes);
  };

  const handleSaveReferral = async () => {
    if (!referralDraft.code.trim()) return;
    // Kode tipe coin wajib punya credits > 0; kode tipe feature wajib pilih minimal 1 fitur
    if (referralDraft.type === 'feature') {
      if (!referralDraft.features || referralDraft.features.length === 0) return;
    } else if (referralDraft.credits <= 0) {
      return;
    }
    setReferralSaving(true);
    let updated: ReferralCode[];
    if (editingReferral !== null) {
      updated = referralCodes.map((r, i) => i === editingReferral.idx ? { ...referralDraft } : r);
    } else {
      updated = [...referralCodes, { ...referralDraft }];
    }
    await saveReferralCodes(updated);
    setReferralSaving(false);
    setShowAddReferral(false);
    setEditingReferral(null);
    setReferralDraft({ code: '', credits: 0, description: '', expiresAt: '' });
  };

  const handleDeleteReferral = async (idx: number) => {
    const updated = referralCodes.filter((_, i) => i !== idx);
    await saveReferralCodes(updated);
  };

  const handleSavePromo = async () => {
    setPromoSaving(true);
    let savedPromo = { ...promo };
    if (promoIconFile) {
      // Try Supabase storage first
      const iconUp = await compressImage(promoIconFile, 400, 0.85);
      const ext = iconUp.name.split('.').pop() ?? 'png';
      const path = `promo-icons/promo-icon-${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from('lesson-assets').upload(path, iconUp, { upsert: true, contentType: iconUp.type });
      if (!error) {
        const url = supabase.storage.from('lesson-assets').getPublicUrl(path).data.publicUrl;
        savedPromo = { ...savedPromo, iconUrl: url };
        setPromo((p) => ({ ...p, iconUrl: url }));
      } else {
        // Fallback: simpan sebagai base64 data URL
        const base64 = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(promoIconFile);
        });
        savedPromo = { ...savedPromo, iconUrl: base64 };
        setPromo((p) => ({ ...p, iconUrl: base64 }));
      }
      setPromoIconFile(null);
      if (promoIconLocalUrl) { URL.revokeObjectURL(promoIconLocalUrl); setPromoIconLocalUrl(null); }
    }
    const settings = await loadAdminSettings();
    await saveAdminSettings({ ...settings, promo: savedPromo });
    setPromoSaving(false);
    setPromoSaved(true);
    setTimeout(() => setPromoSaved(false), 2000);
  };

  const handleBroadcastPromo = async () => {
    if (!promo.enabled) { window.alert('Aktifkan promo terlebih dahulu sebelum broadcast.'); return; }
    setPromoBroadcasting(true);
    // Simpan dulu agar user offline juga dapat saat login
    await handleSavePromo();
    // Kirim realtime broadcast ke semua client yang online
    const channel = supabase.channel('promo-broadcast');
    await channel.subscribe();
    await channel.send({ type: 'broadcast', event: 'show-promo', payload: { promo } });
    await supabase.removeChannel(channel);

    // Blast ke semua student yang sudah link Telegram
    const botToken = STUDENT_BOT_TOKEN;
    if (botToken) {
      const { data: linkedUsers } = await supabase.from('app_users').select('telegram_chat_id').not('telegram_chat_id', 'is', null);
      if (linkedUsers && linkedUsers.length > 0) {
        const broadcastText = `📢 <b>${promo.title || 'Promo Spesial!'}</b>\n\n${promo.body || ''}\n\n🔗 Buka Ruang Sosmed ID untuk info lengkap.`;
        await Promise.all(linkedUsers.map((u: { telegram_chat_id: string }) => sendStudentBot(u.telegram_chat_id, broadcastText, botToken)));
      }
    }
    setPromoBroadcasting(false);
    setPromoBroadcastSent(true);
    setTimeout(() => setPromoBroadcastSent(false), 3000);
  };

  const handlePromoIconUpload = (file: File) => {
    if (!file.type.startsWith('image/')) return;
    const localUrl = URL.createObjectURL(file);
    setPromoIconFile(file);
    setPromoIconLocalUrl(localUrl);
    setPromo((p) => ({ ...p, iconUrl: localUrl }));
  };

  const updateDraftPkg = (idx: number, field: keyof CreditPackage, value: string) => {
    setDraftPackages((prev) => prev.map((p, i) => {
      if (i !== idx) return p;
      const updated = { ...p, [field]: field === 'credits' || field === 'discount' || field === 'bonusCredits' ? Number(value) : value };
      const base = updated.credits * draftCoinRate;
      updated.price = Math.round(base * (1 - (updated.discount ?? 0) / 100));
      return updated;
    }));
  };

  const handleToggleActive = async (user: AdminUser) => {
    await supabase.from('app_users').update({ is_active: !user.isActive }).eq('username', user.username);
    setUsers((prev) => prev.map((u) => u.username === user.username ? { ...u, isActive: !u.isActive } : u));
  };

  const handleDeleteUser = async (username: string) => {
    if (!await confirmDialog(`Hapus user "${username}"? Semua data user akan ikut terhapus.`)) return;
    const { data: delResult, error } = await supabase.rpc('delete_app_user_as_admin', { p_target_username: username, p_admin_username: session.username });
    if (error) { window.alert(`Gagal menghapus user: ${error.message}`); return; }
    if ((delResult as { success?: boolean })?.success === false) { window.alert(`Gagal menghapus user: ${(delResult as { error?: string })?.error}`); return; }
    setUsers((prev) => prev.filter((u) => u.username !== username));
  };

  const handleSavePerks = async () => {
    if (!perksUser) return;
    setPerksSaving(true);
    await supabase.from('user_profiles').update({ perks: draftPerks }).eq('username', perksUser.username);
    setUsers((prev) => prev.map((u) => u.username === perksUser.username ? { ...u, perks: draftPerks } : u));
    setPerksSaving(false);
    setShowPerksModal(false);
  };

  const handleAddCredits = async () => {
    if (!selectedUser) return;
    const amount = customCredits ? parseInt(customCredits, 10) : selectedPackage.credits;
    if (!amount || amount <= 0) return;
    setSaving(true);

    const desc = creditNote || `Paket ${selectedPackage.label} — ${amount} Ruang Coin`;
    await supabase.from('credit_transactions').insert({
      username: selectedUser.username,
      amount,
      type: 'topup',
      description: desc,
      created_by: session.username,
    });
    await supabase.from('user_credits').upsert({ username: selectedUser.username, balance: selectedUser.credits + amount });
    void insertNotification(selectedUser.username, 'credits_added', `+${amount.toLocaleString('id-ID')} Ruang Coin Ditambahkan`, desc, '#profil');

    setUsers((prev) => prev.map((u) => u.username === selectedUser.username ? { ...u, credits: u.credits + amount } : u));
    setTransactions((prev) => [{
      id: crypto.randomUUID(),
      username: selectedUser.username,
      amount,
      type: 'topup',
      description: desc,
      createdAt: new Date().toISOString(),
    }, ...prev]);
    setSaving(false);
    setShowAddCredits(false);
    setCustomCredits('');
    setCreditNote('');
  };

  const handleAddUser = async (e: FormEvent) => {
    e.preventDefault();
    setAddUserError('');
    if (!newUsername.trim() || !newDisplayName.trim() || !newPassword.trim()) {
      setAddUserError('Semua field wajib diisi.');
      return;
    }
    setSaving(true);

    const { error } = await supabase.rpc('admin_create_user', {
      p_username: newUsername.trim().toLowerCase(),
      p_display_name: newDisplayName.trim(),
      p_password: newPassword,
      p_role: newRole,
    });

    if (error) {
      setAddUserError(
        error.message.includes('username sudah dipakai')
          ? 'Username sudah digunakan, coba yang lain.'
          : error.message,
      );
      setSaving(false);
      return;
    }

    const initialCredits = parseInt(newInitialCredits, 10);
    if (initialCredits > 0) {
      const username = newUsername.trim().toLowerCase();
      await Promise.all([
        supabase.from('user_credits').upsert({ username, balance: initialCredits }),
        supabase.from('credit_transactions').insert({ username, amount: initialCredits, type: 'topup', description: 'Ruang Coin awal pendaftaran' }),
      ]);
    }

    setSaving(false);
    setShowAddUser(false);
    setNewUsername(''); setNewDisplayName(''); setNewPassword(''); setNewRole('student'); setNewInitialCredits('0');
    void loadData();
  };

  // Stats
  const isReferralTx = (t: { description: string }) =>
    t.description?.startsWith('Bonus kode referral:') || t.description === 'Ruang Coin awal pendaftaran';
  const paidTopups = transactions.filter((t) => t.type === 'topup' && t.amount > 0 && !isReferralTx(t));
  const referralTxs = transactions.filter((t) => t.type === 'topup' && t.amount > 0 && isReferralTx(t));
  const totalRevenue = paidTopups.reduce((sum, t) => sum + t.amount * CREDIT_RATE, 0);
  const totalReferralCoins = referralTxs.reduce((s, t) => s + t.amount, 0);
  const totalRevenueAll = transactions.filter((t) => t.type === 'topup' && t.amount > 0).reduce((sum, t) => sum + t.amount * CREDIT_RATE, 0);
  const totalCreditsIssued = transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const activeUsers = users.filter((u) => u.isActive).length;
  const filteredUsers = users.filter((u) => {
    const matchSearch = !userSearch.trim() || [u.username, u.displayName, u.email].some((v) => v?.toLowerCase().includes(userSearch.toLowerCase()));
    const matchReferral = !userReferralFilter || u.referralCode === userReferralFilter;
    return matchSearch && matchReferral;
  });
  const totalUserPages = Math.ceil(filteredUsers.length / USERS_PER_PAGE);
  const pagedUsers = filteredUsers.slice(userPage * USERS_PER_PAGE, (userPage + 1) * USERS_PER_PAGE);
  const allPageSelected = pagedUsers.length > 0 && pagedUsers.every((u) => selectedUsernames.has(u.username));
  const someSelected = selectedUsernames.size > 0;

  const toggleSelectUser = (username: string) => {
    setSelectedUsernames((prev) => {
      const next = new Set(prev);
      next.has(username) ? next.delete(username) : next.add(username);
      return next;
    });
  };
  const toggleSelectAll = () => {
    if (allPageSelected) {
      setSelectedUsernames((prev) => { const next = new Set(prev); pagedUsers.forEach((u) => next.delete(u.username)); return next; });
    } else {
      setSelectedUsernames((prev) => { const next = new Set(prev); pagedUsers.forEach((u) => next.add(u.username)); return next; });
    }
  };

  const handleBulkDelete = async () => {
    if (selectedUsernames.has(session.username)) { window.alert('Tidak bisa menghapus akun sendiri.'); return; }
    if (!await confirmDialog(`Hapus ${selectedUsernames.size} user yang dipilih? Semua data mereka akan ikut terhapus.`)) return;
    for (const username of selectedUsernames) {
      await supabase.rpc('delete_app_user_as_admin', { p_target_username: username, p_admin_username: session.username });
    }
    setUsers((prev) => prev.filter((u) => !selectedUsernames.has(u.username)));
    setSelectedUsernames(new Set());
  };

  const handleBulkToggleActive = async (activate: boolean) => {
    for (const username of selectedUsernames) {
      await supabase.from('app_users').update({ is_active: activate }).eq('username', username);
    }
    setUsers((prev) => prev.map((u) => selectedUsernames.has(u.username) ? { ...u, isActive: activate } : u));
    setSelectedUsernames(new Set());
  };

  const handleBulkSaveAccess = async () => {
    setBulkSaving(true);
    for (const username of selectedUsernames) {
      const cur = users.find((u) => u.username === username)?.perks ?? {};
      await supabase.from('user_profiles').update({ perks: { ...cur, ...bulkDraftPerks } }).eq('username', username);
    }
    setUsers((prev) => prev.map((u) => selectedUsernames.has(u.username) ? { ...u, perks: { ...u.perks, ...bulkDraftPerks } } : u));
    setBulkSaving(false);
    setShowBulkAccessModal(false);
    setSelectedUsernames(new Set());
  };

  return (
    <section className="page card admin-page">
      {confirmModal}
      <div className="admin-header">
        <div>
          <p className="eyebrow">developer panel</p>
          <h2>User Control</h2>
        </div>
        <button type="button" className="admin-add-btn" onClick={() => setShowAddUser(true)}>
          + Tambah User
        </button>
      </div>

      {/* Stats */}
      <div className="admin-stats-row">
        <div className="admin-stat-card">
          <span className="admin-stat-label">Total User</span>
          <span className="admin-stat-value">{users.length}</span>
        </div>
        <div className="admin-stat-card">
          <span className="admin-stat-label">User Aktif</span>
          <span className="admin-stat-value">{activeUsers}</span>
        </div>
        <div className="admin-stat-card">
          <span className="admin-stat-label">Coin Tersalurkan</span>
          <span className="admin-stat-value">{totalCreditsIssued.toLocaleString('id-ID')}</span>
        </div>
        <div className="admin-stat-card admin-stat-card--referral">
          <span className="admin-stat-label">Coin via Referral</span>
          <span className="admin-stat-value">{totalReferralCoins.toLocaleString('id-ID')}</span>
          <span className="admin-stat-sub">tidak dihitung pendapatan</span>
        </div>
        <div className="admin-stat-card admin-stat-card--revenue">
          <span className="admin-stat-label">Est. Pendapatan Asli</span>
          <span className="admin-stat-value">{formatRupiah(totalRevenue)}</span>
          <span className="admin-stat-sub">topup berbayar saja</span>
        </div>
        <div className="admin-stat-card admin-stat-card--total-rev">
          <span className="admin-stat-label">Est. Pendapatan Total</span>
          <span className="admin-stat-value">{formatRupiah(totalRevenueAll)}</span>
          <span className="admin-stat-sub">termasuk coin referral</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="admin-tabs">
        {(['users', 'credits', 'revenue', 'referral', 'promo', 'sertifikat', 'hpp', 'landing', 'tema', 'analytics', 'monitor'] as const).map((tab) => (
          <button key={tab} type="button" className={`admin-tab${activeTab === tab ? ' active' : ''}`} onClick={() => setActiveTab(tab)}>
            {tab === 'users' ? 'Manajemen User' : tab === 'credits' ? 'Ruang Coin' : tab === 'revenue' ? 'Pendapatan' : tab === 'referral' ? 'Kode Referral' : tab === 'promo' ? 'Promo & Broadcast' : tab === 'sertifikat' ? 'Sertifikat' : tab === 'hpp' ? 'Kalkulator HPP' : tab === 'landing' ? 'Landing Page' : tab === 'tema' ? '🎨 Tema' : tab === 'analytics' ? '📊 Analytics' : '🔍 Monitor DB'}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="forum-loading">memuat data…</div>
      ) : (
        <>
          {/* Users Tab */}
          {activeTab === 'users' && (
            <div className="admin-table-wrap">
              <div className="admin-user-toolbar">
                <input
                  className="admin-settings-input"
                  placeholder="Cari user (nama, username, email)…"
                  value={userSearch}
                  onChange={(e) => { setUserSearch(e.target.value); setUserPage(0); setSelectedUsernames(new Set()); }}
                  style={{ maxWidth: 260 }}
                />
                <select
                  className="admin-settings-input"
                  value={userReferralFilter}
                  onChange={(e) => { setUserReferralFilter(e.target.value); setUserPage(0); setSelectedUsernames(new Set()); }}
                  style={{ maxWidth: 180 }}
                >
                  <option value="">Semua Referral</option>
                  {referralCodes.map((r) => (
                    <option key={r.code} value={r.code}>{r.code}</option>
                  ))}
                </select>
                <span className="admin-user-count">{filteredUsers.length} user{filteredUsers.length !== 1 ? 's' : ''}</span>
                {someSelected && (
                  <div className="admin-bulk-actions">
                    <span className="admin-bulk-label">{selectedUsernames.size} dipilih</span>
                    <button type="button" className="admin-action-btn perk-btn" onClick={() => { setBulkDraftPerks({}); setShowBulkAccessModal(true); }}>
                      <CoinIcon size={12} /> Atur Akses
                    </button>
                    <button type="button" className="admin-action-btn" onClick={() => handleBulkToggleActive(true)}>Aktifkan</button>
                    <button type="button" className="admin-action-btn" onClick={() => handleBulkToggleActive(false)}>Nonaktifkan</button>
                    <button type="button" className="admin-action-btn danger" onClick={() => void handleBulkDelete()}>Hapus</button>
                    <button type="button" className="admin-action-btn" onClick={() => setSelectedUsernames(new Set())}>✕ Batal</button>
                  </div>
                )}
              </div>
              <table className="admin-table">
                <thead>
                  <tr>
                    <th style={{ width: 36 }}>
                      <input type="checkbox" checked={allPageSelected} onChange={toggleSelectAll} title="Pilih semua di halaman ini" />
                    </th>
                    <th>User</th>
                    <th>Role</th>
                    <th>Ruang Coin</th>
                    <th>Status</th>
                    <th>Bergabung</th>
                    <th>Referral</th>
                    <th>Akses</th>
                    <th>Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedUsers.map((u) => (
                    <tr key={u.username} className={`${!u.isActive ? 'admin-row-inactive' : ''}${selectedUsernames.has(u.username) ? ' admin-row-selected' : ''}`}>
                      <td>
                        <input type="checkbox" checked={selectedUsernames.has(u.username)} onChange={() => toggleSelectUser(u.username)} />
                      </td>
                      <td>
                        <div className="admin-user-cell">
                          {u.avatarUrl
                            ? <img src={u.avatarUrl} alt={u.displayName} className="admin-user-avatar admin-user-avatar-img" />
                            : <div className="admin-user-avatar">{(u.displayName || u.username).slice(0, 1).toUpperCase()}</div>
                          }
                          <div>
                            <div className="admin-user-name">{u.displayName || u.username}</div>
                            <div className="admin-user-username">@{u.username}</div>
                          </div>
                        </div>
                      </td>
                      <td><span className={`admin-role-badge admin-role-${u.role}`}>{u.role}</span></td>
                      <td><span className="admin-credits-cell">{u.credits.toLocaleString('id-ID')}</span></td>
                      <td>
                        <span className={`admin-status-badge ${u.isActive ? 'active' : 'inactive'}`}>
                          {u.isActive ? 'Aktif' : 'Nonaktif'}
                        </span>
                      </td>
                      <td className="admin-date-cell">{new Date(u.createdAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                      <td>
                        {u.referralCode
                          ? <span className="admin-referral-badge" title={`Daftar dengan kode ${u.referralCode}`}>🎟 {u.referralCode}</span>
                          : <span className="perk-none">—</span>}
                      </td>
                      <td>
                        {(() => {
                          const refActive = !u.referralPerksExpiresAt || new Date(u.referralPerksExpiresAt) > new Date();
                          const rp = refActive ? (u.referralPerks ?? {}) : {};
                          const expTxt = u.referralPerksExpiresAt ? ` (referral, s/d ${new Date(u.referralPerksExpiresAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })})` : ' (referral)';
                          const featIcons: Array<[keyof UserPerks, string, string]> = [
                            ['free_video', '🎬', 'Video'],
                            ['free_thread', '💬', 'Thread'],
                            ['free_booking', '📅', 'Booking'],
                            ['free_asset', '📁', 'Asset'],
                            ['free_event', '🎥', 'Event'],
                          ];
                          const hasAny = u.perks.credit_exempt || featIcons.some(([k]) => u.perks[k] || rp[k]);
                          return (
                            <div className="admin-user-perks">
                              {u.perks.credit_exempt && <span className="perk-badge perk-exempt" title="Exempt semua Ruang Coin">✦</span>}
                              {featIcons.map(([k, icon, label]) => {
                                if (u.perks[k]) return <span key={k} className="perk-badge perk-free" title={`${label} gratis`}>{icon}</span>;
                                if (rp[k]) return <span key={k} className="perk-badge perk-referral" title={`${label} gratis${expTxt}`}>{icon}</span>;
                                return null;
                              })}
                              {!hasAny && <span className="perk-none">—</span>}
                            </div>
                          );
                        })()}
                      </td>
                      <td>
                        <div className="admin-actions">
                          <button type="button" className="admin-action-btn" title="Tambah Ruang Coin" onClick={() => { setSelectedUser(u); setShowAddCredits(true); }}>
                            + Ruang Coin
                          </button>
                          <button type="button" className="admin-action-btn perk-btn" title="Atur akses khusus" onClick={() => { setPerksUser(u); setDraftPerks({ ...u.perks }); setShowPerksModal(true); }}>
                            <CoinIcon size={12} /> akses
                          </button>
                          <button type="button" className="admin-action-btn" title={u.isActive ? 'Nonaktifkan' : 'Aktifkan'} onClick={() => handleToggleActive(u)}>
                            {u.isActive ? 'nonaktifkan' : 'aktifkan'}
                          </button>
                          {u.username !== session.username && (
                            <button type="button" className="admin-action-btn danger" onClick={() => handleDeleteUser(u.username)}>hapus</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {totalUserPages > 1 && (
                <div className="admin-pagination">
                  <button className="admin-page-btn" disabled={userPage === 0} onClick={() => setUserPage((p) => p - 1)}>← Prev</button>
                  <span className="admin-page-info">Halaman {userPage + 1} / {totalUserPages}</span>
                  <button className="admin-page-btn" disabled={userPage >= totalUserPages - 1} onClick={() => setUserPage((p) => p + 1)}>Next →</button>
                </div>
              )}
            </div>
          )}

          {/* Credits Tab */}
          {activeTab === 'credits' && (
            <>
            <div className="admin-credits-topbar">
              <p className="admin-section-label" style={{ margin: 0 }}>Riwayat Transaksi Ruang Coin</p>
              <div className="admin-credits-actions">
                {transactions.length > 0 && (
                  <button
                    type="button"
                    className="admin-inbox-clear-btn"
                    onClick={() => setShowResetTxModal(true)}
                  >
                    🗑 Reset Angka
                  </button>
                )}
                <button
                  type="button"
                  className="admin-settings-btn"
                  onClick={() => { setDraftCosts({ ...featureCosts }); setShowCostsModal(true); }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/></svg>
                  Atur Biaya Fitur
                </button>
                <button
                  type="button"
                  className="admin-settings-btn"
                  onClick={() => { void loadAdminSettings().then((s) => setDraftRewards({ ...defaultCoinRewards, ...(s.coin_rewards ?? {}) })); setShowRewardsModal(true); }}
                >
                  🎁 Atur Bonus Koin
                </button>
              </div>
            </div>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Keterangan</th>
                    <th>Tipe</th>
                    <th>Ruang Coin</th>
                    <th>Waktu</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.length === 0 && (
                    <tr><td colSpan={5} className="admin-empty-row">Belum ada transaksi Ruang Coin.</td></tr>
                  )}
                  {transactions.map((t) => (
                    <tr key={t.id}>
                      <td className="admin-user-username">@{t.username}</td>
                      <td>{t.description}</td>
                      <td><span className={`admin-tx-type admin-tx-${t.type}`}>{t.type}</span></td>
                      <td className={`admin-tx-amount ${t.amount > 0 ? 'positive' : 'negative'}`}>
                        {t.amount > 0 ? '+' : ''}{t.amount.toLocaleString('id-ID')}
                      </td>
                      <td className="admin-date-cell">{new Date(t.createdAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            </>
          )}

          {/* Reset Transaksi Modal */}
          {showResetTxModal && createPortal(
            <div className="forum-modal-overlay confirm-overlay" onClick={() => !resettingTx && setShowResetTxModal(false)}>
              <div className="forum-modal confirm-modal" onClick={(e) => e.stopPropagation()}>
                <div className="confirm-icon">🗑</div>
                <h3 className="confirm-title">Reset Angka Transaksi?</h3>
                <p className="confirm-desc">
                  Seluruh riwayat transaksi Ruang Coin akan dihapus permanen, dan angka <strong>Ruang Coin Tersalurkan</strong> serta <strong>Est. Pendapatan</strong> akan kembali ke 0.
                </p>
                <p className="confirm-sub">Saldo Ruang Coin user tidak ikut berubah. Tindakan ini tidak bisa dibatalkan.</p>
                <div className="confirm-actions">
                  <button type="button" className="button secondary" disabled={resettingTx} onClick={() => setShowResetTxModal(false)}>Batal</button>
                  <button type="button" className="button primary" disabled={resettingTx} onClick={() => void handleResetTransactions()}>
                    {resettingTx ? 'Menghapus…' : 'Ya, Reset'}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )}

          {/* Feature Costs Modal */}
          {showCostsModal && createPortal(
            <div className="forum-modal-overlay" onClick={() => setShowCostsModal(false)}>
              <div className="forum-modal costs-modal" onClick={(e) => e.stopPropagation()}>
                <div className="forum-modal-header">
                  <h3>Biaya Fitur per Aksi</h3>
                  <button type="button" className="forum-modal-close" onClick={() => setShowCostsModal(false)}>✕</button>
                </div>
                <p className="costs-modal-sub">Atur berapa Ruang Coin yang dikurangi setiap student menggunakan fitur ini. Masukkan 0 untuk gratis.</p>

                <div className="costs-modal-grid">
                  {(Object.keys(defaultFeatureCosts) as FeatureCostKey[]).map((key) => (
                    <div className="costs-modal-card" key={key}>
                      <div className="costs-modal-card-left">
                        <span className="costs-modal-icon">{featureCostIcons[key]}</span>
                        <div className="costs-modal-info">
                          <strong>{featureCostLabels[key]}</strong>
                          <span>Ruang Coin per aksi</span>
                        </div>
                      </div>
                      <div className="costs-modal-input-col">
                        <div className="costs-modal-input-wrap">
                          <button
                            type="button"
                            className="costs-modal-stepper"
                            onClick={() => setDraftCosts((p) => ({ ...p, [key]: Math.max(0, p[key] - 1) }))}
                          >−</button>
                          <input
                            type="number"
                            min="0"
                            step="1"
                            className="costs-modal-input"
                            value={draftCosts[key]}
                            onChange={(e) => setDraftCosts((p) => ({ ...p, [key]: Math.max(0, Number(e.target.value)) }))}
                          />
                          <button
                            type="button"
                            className="costs-modal-stepper"
                            onClick={() => setDraftCosts((p) => ({ ...p, [key]: p[key] + 1 }))}
                          >+</button>
                        </div>
                        <span className="coin-rupiah-hint">{draftCosts[key] === 0 ? 'Gratis' : `≈ ${formatRupiah(draftCosts[key] * draftCoinRate)}`}</span>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="costs-modal-footer">
                  {costsSaved && <span className="admin-costs-saved">✓ Tersimpan</span>}
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => setDraftCosts({ ...featureCosts })}
                  >
                    Reset ke default
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    disabled={costsSaving}
                    onClick={async () => {
                      setCostsSaving(true);
                      onFeatureCostsChange(draftCosts);
                      setCostsSaving(false);
                      setCostsSaved(true);
                      setTimeout(() => { setCostsSaved(false); setShowCostsModal(false); }, 1200);
                    }}
                  >
                    {costsSaving ? 'Menyimpan…' : 'Simpan'}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )}

          {/* Bonus Ruang Coin Modal */}
          {showRewardsModal && createPortal(
            <div className="forum-modal-overlay" onClick={() => setShowRewardsModal(false)}>
              <div className="forum-modal costs-modal" onClick={(e) => e.stopPropagation()}>
                <div className="costs-modal-header">
                  <h3>Bonus Ruang Coin</h3>
                  <button type="button" className="forum-modal-close" onClick={() => setShowRewardsModal(false)}>✕</button>
                </div>
                <p className="costs-modal-sub">Beri koin gratis ke student saat melakukan aksi tertentu. Isi 0 untuk menonaktifkan. "Maks/hari" membatasi berapa kali bonus bisa didapat per hari (anti-spam).</p>

                <div className="costs-modal-grid">
                  {(Object.keys(defaultCoinRewards) as CoinRewardKey[]).map((key) => (
                    <div className="costs-modal-card" key={key}>
                      <div className="costs-modal-card-left">
                        <span className="costs-modal-icon">{coinRewardIcons[key]}</span>
                        <div className="costs-modal-info">
                          <strong>{coinRewardLabels[key]}</strong>
                          <span>Koin per aksi</span>
                        </div>
                      </div>
                      <div className="rewards-modal-inputs">
                        <div className="rewards-field">
                          <label>Koin</label>
                          <input
                            type="number" min="0" step="1"
                            className="costs-modal-input"
                            value={draftRewards[key].amount}
                            onChange={(e) => setDraftRewards((p) => ({ ...p, [key]: { ...p[key], amount: Math.max(0, Number(e.target.value)) } }))}
                          />
                        </div>
                        <div className="rewards-field">
                          <label>Maks/hari</label>
                          <input
                            type="number" min="1" step="1"
                            className="costs-modal-input"
                            value={draftRewards[key].perDay}
                            onChange={(e) => setDraftRewards((p) => ({ ...p, [key]: { ...p[key], perDay: Math.max(1, Number(e.target.value)) } }))}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="costs-modal-footer">
                  {rewardsSaved && <span className="admin-costs-saved">✓ Tersimpan</span>}
                  <button type="button" className="button secondary" onClick={() => setDraftRewards({ ...defaultCoinRewards })}>Reset ke default</button>
                  <button
                    type="button"
                    className="button primary"
                    disabled={rewardsSaving}
                    onClick={async () => {
                      setRewardsSaving(true);
                      const settings = await loadAdminSettings();
                      await saveAdminSettings({ ...settings, coin_rewards: draftRewards });
                      setRewardsSaving(false);
                      setRewardsSaved(true);
                      setTimeout(() => { setRewardsSaved(false); setShowRewardsModal(false); }, 1200);
                    }}
                  >
                    {rewardsSaving ? 'Menyimpan…' : 'Simpan'}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )}

          {/* Perks Modal */}
          {showPerksModal && perksUser && createPortal(
            <div className="forum-modal-overlay" onClick={() => setShowPerksModal(false)}>
              <div className="forum-modal costs-modal" onClick={(e) => e.stopPropagation()}>
                <button type="button" className="forum-modal-close" onClick={() => setShowPerksModal(false)}>×</button>
                <h3 className="costs-modal-title">Akses Khusus</h3>
                <p className="costs-modal-sub">
                  Atur hak akses lifetime untuk <strong>@{perksUser.username}</strong>. Fitur yang diaktifkan tidak akan memotong Ruang Coin user.
                </p>
                <div className="perks-modal-list">
                  {([
                    { key: 'credit_exempt' as keyof UserPerks, icon: '✦', label: 'Exempt Semua Ruang Coin', desc: 'Semua fitur gratis, tidak ada pemotongan Ruang Coin sama sekali' },
                    { key: 'free_video' as keyof UserPerks, icon: '🎬', label: 'Video Learning Gratis', desc: 'Akses semua video tanpa potong Ruang Coin' },
                    { key: 'free_thread' as keyof UserPerks, icon: '💬', label: 'Post Thread Gratis', desc: 'Buat thread & diskusi tanpa potong Ruang Coin' },
                    { key: 'free_booking' as keyof UserPerks, icon: '📅', label: 'Book Sesi 1:1 Gratis', desc: 'Booking sesi 1:1 tanpa potong Ruang Coin' },
                    { key: 'free_asset' as keyof UserPerks, icon: '📁', label: 'Asset Manager Gratis', desc: 'Buka semua asset tanpa potong Ruang Coin' },
                    { key: 'free_event' as keyof UserPerks, icon: '🎥', label: 'Join Event Gratis', desc: 'Akses semua event/kelas tanpa potong Ruang Coin' },
                  ] as const).map(({ key, icon, label, desc }) => (
                    <label key={key} className="perks-modal-row">
                      <div className="perks-modal-row-left">
                        <span className="costs-modal-icon">{icon}</span>
                        <div className="costs-modal-info">
                          <span className="costs-modal-label">{label}</span>
                          <span className="costs-modal-sublabel">{desc}</span>
                        </div>
                      </div>
                      <div className={`perk-toggle ${draftPerks[key] ? 'on' : ''}`} onClick={() => setDraftPerks((p) => ({ ...p, [key]: !p[key] }))}>
                        <span className="perk-toggle-knob" />
                      </div>
                    </label>
                  ))}
                </div>
                <div className="costs-modal-footer">
                  <button type="button" className="button secondary" onClick={() => setDraftPerks({})}>Reset semua</button>
                  <button type="button" className="button primary" disabled={perksSaving} onClick={() => { void handleSavePerks(); }}>
                    {perksSaving ? 'Menyimpan…' : 'Simpan'}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )}

          {showBulkAccessModal && createPortal(
            <div className="forum-modal-overlay" onClick={() => setShowBulkAccessModal(false)}>
              <div className="forum-modal costs-modal" onClick={(e) => e.stopPropagation()}>
                <button type="button" className="forum-modal-close" onClick={() => setShowBulkAccessModal(false)}>×</button>
                <h3 className="costs-modal-title">Atur Akses — {selectedUsernames.size} User</h3>
                <p className="costs-modal-sub">
                  Fitur yang diaktifkan akan <strong>ditambahkan</strong> ke akses {selectedUsernames.size} user yang dipilih. Fitur yang tidak dicentang tidak mengubah akses yang sudah ada.
                </p>
                <div className="perks-modal-list">
                  {([
                    { key: 'credit_exempt' as keyof UserPerks, icon: '✦', label: 'Exempt Semua Ruang Coin', desc: 'Semua fitur gratis, tidak ada pemotongan Ruang Coin' },
                    { key: 'free_video' as keyof UserPerks, icon: '🎬', label: 'Video Learning Gratis', desc: 'Akses semua video tanpa potong Ruang Coin' },
                    { key: 'free_thread' as keyof UserPerks, icon: '💬', label: 'Post Thread Gratis', desc: 'Buat thread & diskusi tanpa potong Ruang Coin' },
                    { key: 'free_booking' as keyof UserPerks, icon: '📅', label: 'Book Sesi 1:1 Gratis', desc: 'Booking sesi 1:1 tanpa potong Ruang Coin' },
                    { key: 'free_asset' as keyof UserPerks, icon: '📁', label: 'Asset Manager Gratis', desc: 'Buka semua asset tanpa potong Ruang Coin' },
                    { key: 'free_event' as keyof UserPerks, icon: '🎥', label: 'Join Event Gratis', desc: 'Akses semua event/kelas tanpa potong Ruang Coin' },
                  ] as const).map(({ key, icon, label, desc }) => (
                    <label key={key} className="perks-modal-row">
                      <div className="perks-modal-row-left">
                        <span className="costs-modal-icon">{icon}</span>
                        <div className="costs-modal-info">
                          <span className="costs-modal-label">{label}</span>
                          <span className="costs-modal-sublabel">{desc}</span>
                        </div>
                      </div>
                      <div className={`perk-toggle ${bulkDraftPerks[key] ? 'on' : ''}`} onClick={() => setBulkDraftPerks((p) => ({ ...p, [key]: !p[key] }))}>
                        <span className="perk-toggle-knob" />
                      </div>
                    </label>
                  ))}
                </div>
                <div className="costs-modal-footer">
                  <button type="button" className="button secondary" onClick={() => setBulkDraftPerks({})}>Reset</button>
                  <button type="button" className="button primary" disabled={bulkSaving} onClick={() => void handleBulkSaveAccess()}>
                    {bulkSaving ? 'Menyimpan…' : `Terapkan ke ${selectedUsernames.size} User`}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )}

          {/* Revenue Tab */}
          {activeTab === 'revenue' && (
            <div className="admin-revenue">
              <div className="admin-revenue-header">
                <p className="admin-section-label" style={{ margin: 0 }}>Paket Ruang Coin</p>
                <button type="button" className="admin-settings-btn" onClick={() => { setDraftPackages(packages); setDraftPayment(paymentInfo); setDraftCoinRate(CREDIT_RATE); setShowSettings(true); }}>
                  ⚙ Pengaturan Paket &amp; Pembayaran
                </button>
              </div>
              <div className="admin-packages-grid">
                {packages.map((pkg) => {
                  const count = transactions.filter((t) => t.type === 'topup' && t.description.includes(pkg.label)).length;
                  const revenue = count * pkg.price;
                  return (
                    <div key={pkg.id} className="admin-pkg-card">
                      <div className="admin-pkg-name">{pkg.label}</div>
                      <div className="admin-pkg-detail">{pkg.credits.toLocaleString('id-ID')} Ruang Coin · {formatRupiah(pkg.price)}</div>
                      <div className="admin-pkg-count">{count}× terjual</div>
                      <div className="admin-pkg-revenue">{formatRupiah(revenue)}</div>
                    </div>
                  );
                })}
              </div>
              {(paymentInfo.bankName || paymentInfo.accountNumber) && (
                <div className="admin-payment-preview">
                  <p className="admin-section-label" style={{ margin: '0 0 10px' }}>Info Pembayaran</p>
                  <div className="admin-payment-info-row">
                    {paymentInfo.bankName && <span><strong>{paymentInfo.bankName}</strong></span>}
                    {paymentInfo.accountNumber && <span>{paymentInfo.accountNumber}</span>}
                    {paymentInfo.accountName && <span>{paymentInfo.accountName}</span>}
                    {paymentInfo.confirmationLink && (
                      <a href={paymentInfo.confirmationLink} target="_blank" rel="noreferrer" className="admin-confirm-link">Link konfirmasi ↗</a>
                    )}
                  </div>
                </div>
              )}
              <div className="admin-revenue-breakdown">
                <div className="admin-revenue-breakdown-row">
                  <span>Total Coin Masuk (semua)</span>
                  <span>{totalCreditsIssued.toLocaleString('id-ID')} Coin</span>
                </div>
                <div className="admin-revenue-breakdown-row referral">
                  <span>⎿ Coin via Referral / Bonus</span>
                  <span>− {totalReferralCoins.toLocaleString('id-ID')} Coin</span>
                </div>
                <div className="admin-revenue-breakdown-row paid">
                  <span>Coin Berbayar (topup asli)</span>
                  <span>{paidTopups.reduce((s, t) => s + t.amount, 0).toLocaleString('id-ID')} Coin</span>
                </div>
              </div>
              <div className="admin-revenue-total">
                <span>Est. Pendapatan Asli <span style={{ fontSize: '0.78rem', fontWeight: 400, color: 'var(--muted)' }}>(coin referral tidak dihitung)</span></span>
                <strong>{formatRupiah(totalRevenue)}</strong>
              </div>
              <div className="admin-table-wrap" style={{ marginTop: 24 }}>
                <div className="admin-credits-topbar">
                  <p className="admin-section-label" style={{ margin: 0 }}>Riwayat Topup Terbaru</p>
                  {transactions.some((t) => t.type === 'topup') && (
                    <button type="button" className="admin-inbox-clear-btn" onClick={() => setShowResetTxModal(true)}>
                      🗑 Reset Angka
                    </button>
                  )}
                </div>
                <table className="admin-table">
                  <thead><tr><th>User</th><th>Paket</th><th>Ruang Coin</th><th>Waktu</th></tr></thead>
                  <tbody>
                    {transactions.filter((t) => t.type === 'topup').slice(0, 20).map((t) => (
                      <tr key={t.id} className={isReferralTx(t) ? 'admin-row-referral' : ''}>
                        <td className="admin-user-username">@{t.username}</td>
                        <td>{t.description}{isReferralTx(t) && <span className="admin-referral-tag">referral</span>}</td>
                        <td className="admin-tx-amount positive">+{t.amount.toLocaleString('id-ID')}</td>
                        <td className="admin-date-cell">{new Date(t.createdAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                      </tr>
                    ))}
                    {transactions.filter((t) => t.type === 'topup').length === 0 && (
                      <tr><td colSpan={4} className="admin-empty-row">Belum ada topup.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Referral Tab */}
          {activeTab === 'referral' && (
            <div className="admin-referral-tab">
              <div className="admin-referral-tab-head">
                <div>
                  <p className="admin-section-label" style={{ margin: 0 }}>KODE REFERRAL</p>
                  <p style={{ margin: '4px 0 0', fontSize: '0.82rem', color: 'var(--text-muted)' }}>Kode yang bisa digunakan user saat mendaftar untuk mendapatkan Ruang Coin gratis.</p>
                </div>
                <button type="button" className="admin-add-btn" onClick={() => { setReferralDraft({ code: '', credits: 0, description: '', expiresAt: '' }); setEditingReferral(null); setShowAddReferral(true); }}>
                  + Tambah Kode
                </button>
              </div>

              <div className="admin-table-wrap" style={{ marginTop: 16 }}>
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Kode</th>
                      <th>Ruang Coin</th>
                      <th>Keterangan</th>
                      <th>Berlaku Hingga</th>
                      <th>Digunakan</th>
                      <th>Status</th>
                      <th>Aksi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {referralCodes.length === 0 && (
                      <tr><td colSpan={7} className="admin-empty-row">Belum ada kode referral.</td></tr>
                    )}
                    {referralCodes.map((r, idx) => {
                      const expired = r.expiresAt ? new Date(r.expiresAt) < new Date() : false;
                      const codeType = r.type ?? 'coin';
                      return (
                        <tr key={idx} className={expired ? 'admin-row-inactive' : ''}>
                          <td><span className="referral-code-badge">{r.code}</span></td>
                          <td>
                            {codeType === 'coin'
                              ? <span className="admin-credits-cell"><CoinIcon size={12} /> {r.credits.toLocaleString('id-ID')}</span>
                              : <span className="referral-feature-tags">{(r.features ?? []).map((f) => <span key={f} className="referral-feature-tag">{{ free_video: '🎬', free_booking: '📅', free_thread: '💬', free_asset: '📁', free_event: '🎥' }[f]}</span>)}</span>}
                          </td>
                          <td style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{r.description || '—'}</td>
                          <td className="admin-date-cell">
                            {r.expiresAt ? new Date(r.expiresAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : <span style={{ color: 'var(--text-muted)' }}>Tidak ada batas</span>}
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            <span className="referral-usage-count">{referralUsage[r.code] ?? 0} user</span>
                          </td>
                          <td>
                            <span className={`admin-status-badge ${expired ? 'inactive' : 'active'}`}>
                              {expired ? 'Expired' : 'Aktif'}
                            </span>
                          </td>
                          <td>
                            <div className="admin-actions">
                              <button type="button" className="admin-action-btn" onClick={() => { setReferralDraft({ ...r }); setEditingReferral({ ...r, idx }); setShowAddReferral(true); }}>edit</button>
                              <button type="button" className="admin-action-btn danger" onClick={() => void handleDeleteReferral(idx)}>hapus</button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

        </>
      )}

      {/* Modal: Tambah/Edit Referral */}
      {showAddReferral && createPortal(
        <div className="admin-modal-overlay" onClick={() => setShowAddReferral(false)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="admin-modal-title">{editingReferral !== null ? 'Edit Kode Referral' : 'Tambah Kode Referral'}</h3>
            <div className="admin-modal-form">
              <label>Nama Kode
                <input
                  className="admin-modal-input"
                  value={referralDraft.code}
                  onChange={(e) => setReferralDraft((p) => ({ ...p, code: e.target.value.toUpperCase() }))}
                  placeholder="contoh: SOSMED2025"
                  style={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 }}
                />
              </label>
              <div className="referral-type-toggle">
                <span className="referral-type-label">Tipe Kode</span>
                <div className="referral-type-options">
                  {(['coin', 'feature'] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      className={`referral-type-btn${(referralDraft.type ?? 'coin') === t ? ' active' : ''}`}
                      onClick={() => setReferralDraft((p) => ({ ...p, type: t, credits: t === 'feature' ? 0 : p.credits, features: t === 'coin' ? [] : p.features }))}
                    >
                      {t === 'coin' ? <><CoinIcon size={13} /> Ruang Coin</> : '🎁 Akses Fitur'}
                    </button>
                  ))}
                </div>
              </div>
              {(referralDraft.type ?? 'coin') === 'coin' ? (
                <label>Jumlah Ruang Coin
                  <input
                    className="admin-modal-input"
                    type="number"
                    min="1"
                    value={referralDraft.credits || ''}
                    onChange={(e) => setReferralDraft((p) => ({ ...p, credits: parseInt(e.target.value, 10) || 0 }))}
                    placeholder="contoh: 50"
                  />
                  {referralDraft.credits > 0 && <span className="coin-rupiah-hint">≈ {formatRupiah(referralDraft.credits * draftCoinRate)} nilai</span>}
                </label>
              ) : (
                <div className="referral-feature-checks">
                  <span className="referral-type-label">Fitur yang Dibuka</span>
                  {([
                    { key: 'free_video', icon: '🎬', label: 'Video Learning' },
                    { key: 'free_booking', icon: '📅', label: 'Booking Sesi 1:1' },
                    { key: 'free_thread', icon: '💬', label: 'Post Thread' },
                    { key: 'free_asset', icon: '📁', label: 'Asset Manager' },
                    { key: 'free_event', icon: '🎥', label: 'Join Event / Kelas' },
                  ] as const).map(({ key, icon, label }) => {
                    const checked = referralDraft.features?.includes(key) ?? false;
                    return (
                      <label key={key} className="referral-feature-check-row">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const prev = referralDraft.features ?? [];
                            setReferralDraft((p) => ({
                              ...p,
                              features: e.target.checked ? [...prev, key] : prev.filter((f) => f !== key),
                            }));
                          }}
                        />
                        <span>{icon} {label}</span>
                      </label>
                    );
                  })}
                </div>
              )}
              <label>Keterangan <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '0.8rem' }}>(opsional)</span>
                <input
                  className="admin-modal-input"
                  value={referralDraft.description ?? ''}
                  onChange={(e) => setReferralDraft((p) => ({ ...p, description: e.target.value }))}
                  placeholder="contoh: Untuk member komunitas"
                />
              </label>
              <label>Berlaku Hingga <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '0.8rem' }}>(kosongkan = tidak ada batas)</span>
                <input
                  className="admin-modal-input"
                  type="date"
                  value={referralDraft.expiresAt ?? ''}
                  onChange={(e) => setReferralDraft((p) => ({ ...p, expiresAt: e.target.value }))}
                />
              </label>
              {referralDraft.code && ((referralDraft.type ?? 'coin') === 'coin' ? referralDraft.credits > 0 : (referralDraft.features ?? []).length > 0) && (
                <div className="referral-preview-box">
                  <span className="referral-code-badge">{referralDraft.code}</span>
                  {(referralDraft.type ?? 'coin') === 'coin'
                    ? <span>→ <CoinIcon size={13} /> {referralDraft.credits} Ruang Coin gratis</span>
                    : <span>→ 🎁 {(referralDraft.features ?? []).map((f) => ({ free_video: 'Video', free_booking: 'Booking', free_thread: 'Thread', free_asset: 'Asset', free_event: 'Event' }[f])).join(', ')} gratis</span>}
                  {referralDraft.expiresAt && <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>berlaku s/d {new Date(referralDraft.expiresAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}</span>}
                </div>
              )}
              <div className="admin-modal-actions">
                <button type="button" className="admin-modal-cancel" onClick={() => { setShowAddReferral(false); setEditingReferral(null); }}>Batal</button>
                <button
                  type="button"
                  className="admin-modal-submit"
                  disabled={referralSaving || !referralDraft.code.trim() || ((referralDraft.type ?? 'coin') === 'coin' ? referralDraft.credits <= 0 : (referralDraft.features ?? []).length === 0)}
                  onClick={() => void handleSaveReferral()}
                >
                  {referralSaving ? 'Menyimpan…' : editingReferral !== null ? 'Simpan Perubahan' : 'Tambah Kode'}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Tab: Promo & Broadcast */}
          {activeTab === 'promo' && (
            <div className="admin-promo-tab">
              <div className="admin-promo-header">
                <div>
                  <p className="admin-section-label" style={{ margin: 0 }}>PROMO & BROADCAST</p>
                  <p style={{ margin: '4px 0 0', fontSize: '0.82rem', color: 'var(--text-muted)' }}>Buat popup penawaran yang tampil otomatis untuk user baru atau semua user.</p>
                </div>
                <label className="promo-enable-toggle">
                  <input type="checkbox" checked={promo.enabled} onChange={(e) => setPromo((p) => ({ ...p, enabled: e.target.checked }))} />
                  <span>{promo.enabled ? 'Aktif' : 'Nonaktif'}</span>
                </label>
              </div>

              <div className="admin-promo-body">
                <div className="admin-promo-form">
                  {/* Template Picker */}
                  <div className="promo-template-section">
                    <p className="admin-section-label" style={{ margin: '0 0 10px' }}>STYLE TEMPLATE</p>
                    <div className="promo-template-grid">
                      {(Object.entries(PROMO_TEMPLATES) as [NonNullable<PromoPopup['styleTemplate']>, typeof PROMO_TEMPLATES[keyof typeof PROMO_TEMPLATES]][]).map(([key, tpl]) => {
                        const bg = tpl.patch.useGradient
                          ? `linear-gradient(${tpl.patch.bgAngle ?? 135}deg, ${tpl.patch.bgFrom}, ${tpl.patch.bgTo})`
                          : tpl.patch.bgColor;
                        const active = promo.styleTemplate === key;
                        return (
                          <button
                            key={key}
                            type="button"
                            className={`promo-template-card${active ? ' active' : ''}`}
                            onClick={() => setPromo((p) => applyPromoTemplate(p, key))}
                          >
                            <div className="promo-template-swatch" style={{ background: bg }}>
                              <span style={{ color: tpl.patch.textColor, fontSize: 18 }}>{tpl.emoji}</span>
                              <div className="promo-template-swatch-btn" style={{ background: tpl.patch.btnColor, color: tpl.patch.btnTextColor }} />
                            </div>
                            <span className="promo-template-label">{tpl.label}</span>
                            <span className="promo-template-desc">{tpl.desc}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="admin-promo-row">
                    <label>Ikon (PNG)
                      <div className="promo-icon-upload-wrap">
                        {promo.iconUrl
                          ? <img src={promo.iconUrl} alt="icon" className="promo-icon-preview" />
                          : <span className="promo-icon-placeholder">Belum ada gambar</span>
                        }
                        <label className="promo-icon-upload-btn">
                          {promoIconUploading ? 'Mengupload...' : 'Pilih Gambar'}
                          <input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }}
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) void handlePromoIconUpload(f); }} />
                        </label>
                        {promo.iconUrl && (
                          <button type="button" className="promo-icon-remove" onClick={() => setPromo((p) => ({ ...p, iconUrl: undefined }))}>Hapus</button>
                        )}
                      </div>
                    </label>
                    <label>Target Tampil
                      <select className="admin-modal-input" value={promo.target} onChange={(e) => setPromo((p) => ({ ...p, target: e.target.value as PromoPopup['target'] }))}>
                        <option value="new_users">User Baru (tanpa referral)</option>
                        <option value="all_users">Semua User (sekali per sesi)</option>
                      </select>
                    </label>
                  </div>
                  {(() => {
                    const tpl = promo.styleTemplate ?? 'default';
                    const fields = {
                      flash_sale: { judul: 'Judul Utama', judulPh: 'SALE BESAR-BESARAN!', sub: 'Teks Diskon (tampil besar)', subPh: 'DISKON 50%', body: 'Deskripsi Singkat', bodyPh: 'Penawaran terbatas hari ini saja!' },
                      premium:    { judul: 'Judul Elegan', judulPh: 'Akses Premium Eksklusif', sub: 'Subjudul', subPh: 'Tingkatkan pengalamanmu', body: 'Deskripsi Premium', bodyPh: 'Dapatkan akses tak terbatas ke semua konten.' },
                      pastel:     { judul: 'Sapaan Ramah', judulPh: 'Hei, selamat datang! 👋', sub: 'Subjudul', subPh: 'Yuk mulai belajar bareng', body: 'Isi Pesan', bodyPh: 'Kami senang kamu bergabung!' },
                      dark_announcement: { judul: 'Judul Pengumuman', judulPh: 'Fitur Baru Telah Hadir', sub: 'Subjudul', subPh: 'Update versi terbaru', body: 'Poin-poin Pengumuman (1 baris = 1 poin)', bodyPh: 'Fitur A sudah bisa diakses\nFitur B dalam pengembangan\nHubungi kami untuk info lebih lanjut' },
                      default:    { judul: 'Judul', judulPh: 'Selamat Datang!', sub: 'Subjudul', subPh: 'Mulai perjalanan belajarmu', body: 'Isi Pesan', bodyPh: 'Deskripsi penawaran...' },
                    }[tpl] ?? { judul: 'Judul', judulPh: '', sub: 'Subjudul', subPh: '', body: 'Isi Pesan', bodyPh: '' };
                    return (
                      <>
                        <label>{fields.judul}
                          <input className="admin-modal-input" value={promo.title} onChange={(e) => setPromo((p) => ({ ...p, title: e.target.value }))} placeholder={fields.judulPh} />
                        </label>
                        <label>{fields.sub}
                          <input className="admin-modal-input" value={promo.subtitle} onChange={(e) => setPromo((p) => ({ ...p, subtitle: e.target.value }))} placeholder={fields.subPh} />
                        </label>
                        <label>{fields.body}
                          <textarea className="admin-modal-input" rows={tpl === 'dark_announcement' ? 4 : 3} value={promo.body} onChange={(e) => setPromo((p) => ({ ...p, body: e.target.value }))} placeholder={fields.bodyPh} />
                        </label>
                      </>
                    );
                  })()}
                  <div className="admin-promo-row">
                    <label>Tombol CTA
                      <input className="admin-modal-input" value={promo.ctaText} onChange={(e) => setPromo((p) => ({ ...p, ctaText: e.target.value }))} placeholder="Topup Sekarang" />
                    </label>
                    <label>Aksi Tombol
                      <select className="admin-modal-input" value={promo.ctaAction} onChange={(e) => setPromo((p) => ({ ...p, ctaAction: e.target.value as PromoPopup['ctaAction'] }))}>
                        <option value="topup">Buka Topup</option>
                        <option value="url">Buka URL</option>
                        <option value="dismiss">Tutup Saja</option>
                      </select>
                    </label>
                  </div>
                  {promo.ctaAction === 'url' && (
                    <label>URL Tujuan
                      <input className="admin-modal-input" value={promo.ctaUrl ?? ''} onChange={(e) => setPromo((p) => ({ ...p, ctaUrl: e.target.value }))} placeholder="https://..." />
                    </label>
                  )}
                  <label>Teks Tolak
                    <input className="admin-modal-input" value={promo.dismissText} onChange={(e) => setPromo((p) => ({ ...p, dismissText: e.target.value }))} placeholder="Tidak, terima kasih" />
                  </label>
                  <label style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <input type="checkbox" checked={promo.useGradient ?? false} onChange={(e) => setPromo((p) => ({ ...p, useGradient: e.target.checked }))} style={{ width: 15, height: 15, accentColor: 'var(--accent)', flexShrink: 0 }} />
                    <span style={{ fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.83rem' }}>Gunakan Gradient</span>
                  </label>

                  {promo.useGradient ? (
                    <div className="admin-promo-row" style={{ alignItems: 'end', gap: 10 }}>
                      <label>Warna Awal
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <input type="color" value={promo.bgFrom ?? '#f0e6ff'} onChange={(e) => setPromo((p) => ({ ...p, bgFrom: e.target.value }))} style={{ width: 40, height: 36, border: 'none', borderRadius: 8, cursor: 'pointer', padding: 2 }} />
                          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{promo.bgFrom ?? '#f0e6ff'}</span>
                        </div>
                      </label>
                      <label>Warna Akhir
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <input type="color" value={promo.bgTo ?? '#b28aff'} onChange={(e) => setPromo((p) => ({ ...p, bgTo: e.target.value }))} style={{ width: 40, height: 36, border: 'none', borderRadius: 8, cursor: 'pointer', padding: 2 }} />
                          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{promo.bgTo ?? '#b28aff'}</span>
                        </div>
                      </label>
                      <label>Sudut (°)
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <input type="range" min={0} max={360} value={promo.bgAngle ?? 135} onChange={(e) => setPromo((p) => ({ ...p, bgAngle: Number(e.target.value) }))} style={{ flex: 1 }} />
                          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', minWidth: 32 }}>{promo.bgAngle ?? 135}°</span>
                        </div>
                      </label>
                    </div>
                  ) : (
                    <label>Warna Background
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input type="color" value={promo.bgColor ?? '#ffffff'} onChange={(e) => setPromo((p) => ({ ...p, bgColor: e.target.value }))} style={{ width: 40, height: 36, border: 'none', borderRadius: 8, cursor: 'pointer', padding: 2 }} />
                        <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>{promo.bgColor ?? '#ffffff'}</span>
                      </div>
                    </label>
                  )}

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                    <label className="admin-modal-label">Warna Teks
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                        <input type="color" value={promo.textColor ?? '#1a1a1a'} onChange={(e) => setPromo((p) => ({ ...p, textColor: e.target.value }))} style={{ width: 40, height: 36, border: 'none', borderRadius: 8, cursor: 'pointer', padding: 2 }} />
                        <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>{promo.textColor ?? '#1a1a1a'}</span>
                      </div>
                    </label>
                    <label className="admin-modal-label">Warna Tombol CTA
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                        <input type="color" value={promo.btnColor ?? '#6c47ff'} onChange={(e) => setPromo((p) => ({ ...p, btnColor: e.target.value }))} style={{ width: 40, height: 36, border: 'none', borderRadius: 8, cursor: 'pointer', padding: 2 }} />
                        <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>{promo.btnColor ?? '#6c47ff'}</span>
                      </div>
                    </label>
                    <label className="admin-modal-label">Warna Teks Tombol
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                        <input type="color" value={promo.btnTextColor ?? '#ffffff'} onChange={(e) => setPromo((p) => ({ ...p, btnTextColor: e.target.value }))} style={{ width: 40, height: 36, border: 'none', borderRadius: 8, cursor: 'pointer', padding: 2 }} />
                        <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>{promo.btnTextColor ?? '#ffffff'}</span>
                      </div>
                    </label>
                  </div>

                  <div className="promo-feature-costs-info">
                    <p className="admin-section-label" style={{ margin: '0 0 8px' }}>INFO BIAYA FITUR (otomatis dari pengaturan)</p>
                    <div className="promo-feature-grid">
                      {[
                        { label: '🎥 Tonton Video', cost: featureCosts.videoLesson },
                        { label: '💬 Posting Thread', cost: featureCosts.postThread },
                        { label: '📅 Booking 1:1', cost: featureCosts.booking },
                      ].map(({ label, cost }) => (
                        <div key={label} className="promo-feature-item">
                          <span>{label}</span>
                          <span className="promo-feature-cost">{cost} Ruang Coin</span>
                        </div>
                      ))}
                    </div>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '6px 0 0' }}>Info ini bisa kamu salin ke kolom Isi Pesan di atas.</p>
                  </div>
                  <div className="admin-promo-actions">
                    <button type="button" className="admin-modal-submit" disabled={promoSaving} onClick={() => void handleSavePromo()}>
                      {promoSaving ? 'Menyimpan…' : promoSaved ? '✓ Tersimpan' : 'Simpan Promo'}
                    </button>
                    <button type="button" className="promo-broadcast-btn" disabled={promoBroadcasting || promoSaving} onClick={() => void handleBroadcastPromo()}>
                      {promoBroadcasting ? 'Mengirim…' : promoBroadcastSent ? '✓ Terkirim ke semua user!' : '📣 Kirim Broadcast Sekarang'}
                    </button>
                  </div>
                  <p className="promo-broadcast-hint">Broadcast akan muncul langsung di semua tab yang sedang terbuka. User yang offline akan melihatnya saat login berikutnya.</p>
                </div>

                {/* Live Preview */}
                <div className="admin-promo-preview">
                  <p className="admin-section-label" style={{ marginBottom: 12 }}>PREVIEW</p>
                  <div className={`promo-preview-card promo-style-${promo.styleTemplate ?? 'default'}`} style={{ background: promoBg(promo) }}>
                    <PromoContent promo={promo} isPreview />
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'sertifikat' && (
            <div className="admin-cert-tab">
              <div className="admin-cert-header">
                <div>
                  <h3 className="admin-section-title">Desain Sertifikat</h3>
                  <p className="admin-section-sub">Upload background dan atur posisi teks sertifikat untuk setiap kelas.</p>
                </div>
                {certCourses.length > 0 && (
                  <div className="cert-course-selector">
                    <label htmlFor="cert-course-select">Pilih Kelas:</label>
                    <select id="cert-course-select" value={certSelectedKey ?? ''} onChange={(e) => setCertSelectedKey(e.target.value)}>
                      {certCourses.map((c) => (
                        <option key={c.key} value={c.key}>{c.title}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              {certSelectedKey
                ? <CertificateDesigner key={certSelectedKey} courseKey={certSelectedKey} courseTitle={certCourses.find((c) => c.key === certSelectedKey)?.title ?? certSelectedKey} />
                : <p className="forum-loading">Belum ada kelas. Buat kelas dulu di katalog.</p>
              }
            </div>
          )}

          {activeTab === 'hpp' && <HppCalculator coinRate={draftCoinRate} packages={packages} />}

          {activeTab === 'landing' && <LandingEditor />}

          {activeTab === 'tema' && <ThemeEditor />}

          {activeTab === 'analytics' && <AssetMonitor />}

          {activeTab === 'monitor' && <DbMonitor />}

      {/* Modal: Tambah User */}
      {showAddUser && createPortal(
        <div className="admin-modal-overlay" onClick={() => setShowAddUser(false)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="admin-modal-title">Tambah User Baru</h3>
            <form onSubmit={handleAddUser} className="admin-modal-form">
              <label>Username
                <input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="contoh: budi123" />
              </label>
              <label>Nama Tampilan
                <input value={newDisplayName} onChange={(e) => setNewDisplayName(e.target.value)} placeholder="contoh: Budi Santoso" />
              </label>
              <label>Password
                <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="••••••••" />
              </label>
              <label>Role
                <select value={newRole} onChange={(e) => setNewRole(e.target.value)}>
                  <option value="student">Student</option>
                  <option value="developer">Developer</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
              <label>Ruang Coin Awal
                <input
                  type="number"
                  min="0"
                  value={newInitialCredits}
                  onChange={(e) => setNewInitialCredits(e.target.value)}
                  placeholder="0"
                />
              </label>
              {addUserError && <p className="admin-error">{addUserError}</p>}
              <div className="admin-modal-actions">
                <button type="button" className="admin-modal-cancel" onClick={() => setShowAddUser(false)}>Batal</button>
                <button type="submit" className="admin-modal-submit" disabled={saving}>{saving ? 'Menyimpan…' : 'Buat User'}</button>
              </div>
            </form>
          </div>
        </div>,
        document.body,
      )}

      {/* Modal: Tambah Ruang Coin */}
      {showAddCredits && selectedUser && createPortal(
        <div className="admin-modal-overlay" onClick={() => setShowAddCredits(false)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="admin-modal-title">Tambah Ruang Coin</h3>
            <p className="admin-modal-sub">untuk <strong>{selectedUser.displayName}</strong> · saldo saat ini: <strong>{selectedUser.credits.toLocaleString('id-ID')} Ruang Coin</strong></p>
            <div className="admin-pkg-options">
              {packages.map((pkg) => (
                <button
                  key={pkg.id}
                  type="button"
                  className={`admin-pkg-option${selectedPackage.id === pkg.id && !customCredits ? ' selected' : ''}`}
                  onClick={() => { setSelectedPackage(pkg); setCustomCredits(''); }}
                >
                  <span className="admin-pkg-opt-name">{pkg.label}</span>
                  <span className="admin-pkg-opt-credits">{pkg.credits.toLocaleString('id-ID')} Ruang Coin</span>
                  <span className="admin-pkg-opt-price">{formatRupiah(pkg.price)}</span>
                </button>
              ))}
            </div>
            <label className="admin-modal-label">Atau masukkan jumlah Ruang Coin manual
              <input
                type="number"
                min="1"
                className="admin-modal-input"
                value={customCredits}
                onChange={(e) => setCustomCredits(e.target.value)}
                placeholder="contoh: 500"
              />
              {parseInt(customCredits, 10) > 0 && <span className="coin-rupiah-hint">≈ {formatRupiah(parseInt(customCredits, 10) * draftCoinRate)} nilai</span>}
            </label>
            <label className="admin-modal-label">Catatan (opsional)
              <input
                className="admin-modal-input"
                value={creditNote}
                onChange={(e) => setCreditNote(e.target.value)}
                placeholder="misal: pembayaran transfer BCA"
              />
            </label>
            <div className="admin-modal-actions">
              <button type="button" className="admin-modal-cancel" onClick={() => setShowAddCredits(false)}>Batal</button>
              <button type="button" className="admin-modal-submit" disabled={saving} onClick={handleAddCredits}>
                {saving ? 'Menyimpan…' : `Tambah ${(customCredits ? parseInt(customCredits) || 0 : selectedPackage.credits).toLocaleString('id-ID')} Ruang Coin`}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Modal: Pengaturan Paket & Pembayaran */}
      {showSettings && createPortal(
        <div className="admin-modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="admin-modal admin-modal-landscape" onClick={(e) => e.stopPropagation()}>
            <h3 className="admin-modal-title">Pengaturan Paket &amp; Pembayaran</h3>

            {/* ── Kolom Kiri: Paket ── */}
            <div className="admin-landscape-col">
            <div className="admin-coin-rate-row">
              <label className="admin-coin-rate-label">
                <span>Harga 1 Ruang Coin</span>
                <span className="admin-coin-rate-hint">semua harga paket dihitung ulang otomatis</span>
              </label>
              <div className="admin-coin-rate-input-wrap">
                <span className="admin-coin-rate-prefix">Rp</span>
                <input
                  type="number"
                  min={100}
                  step={100}
                  className="admin-settings-input admin-coin-rate-input"
                  value={draftCoinRate}
                  onChange={(e) => {
                    const rate = Math.max(100, Number(e.target.value));
                    setDraftCoinRate(rate);
                    setDraftPackages((prev) => prev.map((p) => ({
                      ...p,
                      price: Math.round(p.credits * rate * (1 - (p.discount ?? 0) / 100)),
                    })));
                  }}
                />
                <span className="admin-coin-rate-suffix">/ coin</span>
              </div>
            </div>

            <div className="admin-settings-pkg-header">
              <p className="admin-section-label" style={{ margin: 0 }}>Paket Ruang Coin</p>
              <button
                type="button"
                className="admin-pkg-add-btn"
                onClick={() => setDraftPackages((prev) => [...prev, { id: `pkg-${Date.now()}`, label: '', credits: 0, price: 0 }])}
              >
                + Tambah Paket
              </button>
            </div>
            <div className="admin-settings-packages">
              <div className="admin-settings-pkg-col-headers">
                <span>Nama Paket</span>
                <span>Ruang Coin</span>
                <span>Diskon (%)</span>
                <span>Bonus Koin</span>
                <span>Harga Final</span>
                <span></span>
              </div>
              {draftPackages.map((pkg, idx) => (
                <div key={pkg.id} className="admin-settings-pkg-block">
                  <div className="admin-settings-pkg-row">
                    <input
                      className="admin-settings-input"
                      placeholder="contoh: Starter"
                      value={pkg.label}
                      onChange={(e) => updateDraftPkg(idx, 'label', e.target.value)}
                    />
                    <input
                      type="number" min="1"
                      className="admin-settings-input"
                      placeholder="0"
                      value={pkg.credits || ''}
                      onChange={(e) => updateDraftPkg(idx, 'credits', e.target.value)}
                    />
                    <input
                      type="number" min="0" max="99"
                      className="admin-settings-input"
                      placeholder="0"
                      value={pkg.discount ?? 0}
                      onChange={(e) => updateDraftPkg(idx, 'discount', e.target.value)}
                    />
                    <input
                      type="number" min="0"
                      className="admin-settings-input"
                      placeholder="0"
                      title="Bonus koin gratis saat beli paket ini"
                      value={pkg.bonusCredits ?? 0}
                      onChange={(e) => updateDraftPkg(idx, 'bonusCredits', e.target.value)}
                    />
                    <div className="admin-settings-pkg-price-preview">
                      {formatRupiah(pkg.price)}
                      {(pkg.bonusCredits ?? 0) > 0 && <span className="admin-pkg-bonus-tag">+{pkg.bonusCredits} bonus</span>}
                    </div>
                    <button
                      type="button"
                      className="admin-pkg-remove-btn"
                      title="Hapus paket"
                      onClick={() => setDraftPackages((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      ✕
                    </button>
                  </div>
                  {/* Fitur / benefit list per paket */}
                  <div className="admin-pkg-features-section">
                    <p className="admin-pkg-features-label">Fitur / benefit (tampil di landing page):</p>
                    {(pkg.features ?? []).map((feat, fi) => (
                      <div key={fi} className="admin-pkg-feature-row">
                        <input
                          className="admin-settings-input"
                          value={feat}
                          placeholder="Contoh: Akses semua video"
                          onChange={(e) => {
                            const val = e.target.value;
                            setDraftPackages((prev) => prev.map((p, i) => {
                              if (i !== idx) return p;
                              const feats = [...(p.features ?? [])];
                              feats[fi] = val;
                              return { ...p, features: feats };
                            }));
                          }}
                          style={{ flex: 1 }}
                        />
                        <button
                          type="button"
                          className="admin-mini-btn ghost"
                          onClick={() => setDraftPackages((prev) => prev.map((p, i) => {
                            if (i !== idx) return p;
                            const feats = (p.features ?? []).filter((_, j) => j !== fi);
                            return { ...p, features: feats };
                          }))}
                        >✕</button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="admin-mini-btn"
                      style={{ marginTop: 4 }}
                      onClick={() => setDraftPackages((prev) => prev.map((p, i) =>
                        i === idx ? { ...p, features: [...(p.features ?? []), ''] } : p
                      ))}
                    >+ Tambah fitur</button>
                  </div>
                  {/* Promo per paket */}
                  <div className="admin-pkg-promo-section">
                    <label className="admin-pkg-promo-toggle">
                      <input
                        type="checkbox"
                        checked={pkg.promo?.active ?? false}
                        onChange={(e) => {
                          const active = e.target.checked;
                          setDraftPackages((prev) => prev.map((p, i) => i === idx ? { ...p, promo: { ...(p.promo ?? { label: '', bonus_features: [], bonus_booking: false }), active } } : p));
                        }}
                      />
                      <span>Aktifkan Promo untuk paket ini</span>
                    </label>
                    {pkg.promo?.active && (
                      <div className="admin-pkg-promo-fields">
                        <input
                          className="admin-settings-input"
                          placeholder="Label promo, contoh: 🎉 Promo Lebaran"
                          value={pkg.promo?.label ?? ''}
                          onChange={(e) => setDraftPackages((prev) => prev.map((p, i) => i === idx ? { ...p, promo: { ...p.promo!, label: e.target.value } } : p))}
                          style={{ width: '100%' }}
                        />
                        <input
                          type="date"
                          className="admin-settings-input"
                          title="Berlaku hingga (kosongkan = tidak ada batas)"
                          value={pkg.promo?.end_date ?? ''}
                          onChange={(e) => setDraftPackages((prev) => prev.map((p, i) => i === idx ? { ...p, promo: { ...p.promo!, end_date: e.target.value } } : p))}
                        />
                        <div className="admin-pkg-promo-bonus-row">
                          <span className="admin-pkg-promo-bonus-label">Bonus yang didapat:</span>
                          <label className="admin-pkg-promo-feat">
                            <input type="checkbox" checked={pkg.promo?.bonus_booking ?? false}
                              onChange={(e) => setDraftPackages((prev) => prev.map((p, i) => i === idx ? { ...p, promo: { ...p.promo!, bonus_booking: e.target.checked } } : p))} />
                            📅 Sesi 1:1 Gratis
                          </label>
                          {(['free_video', 'free_thread', 'free_asset', 'free_event'] as const).map((f) => {
                            const fLabel = { free_video: '🎬 Video Gratis', free_thread: '💬 Thread Gratis', free_asset: '📁 Asset Gratis', free_event: '🎥 Event Gratis' }[f];
                            return (
                              <label key={f} className="admin-pkg-promo-feat">
                                <input type="checkbox"
                                  checked={(pkg.promo?.bonus_features ?? []).includes(f)}
                                  onChange={(e) => {
                                    const cur = pkg.promo?.bonus_features ?? [];
                                    const next = e.target.checked ? [...cur, f] : cur.filter((x) => x !== f);
                                    setDraftPackages((prev) => prev.map((p, i) => i === idx ? { ...p, promo: { ...p.promo!, bonus_features: next } } : p));
                                  }}
                                />
                                {fLabel}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            </div>{/* end kolom kiri */}

            {/* ── Kolom Kanan: Pembayaran & Referral ── */}
            <div className="admin-landscape-col">
            <p className="admin-section-label" style={{ marginTop: 0 }}>Informasi Pembayaran</p>
            <div className="admin-modal-form" style={{ gap: 10 }}>
              <label>Nama Bank
                <input className="admin-modal-input" value={draftPayment.bankName} onChange={(e) => setDraftPayment((p) => ({ ...p, bankName: e.target.value }))} placeholder="contoh: BCA, Mandiri, BNI" />
              </label>
              <label>Nomor Rekening
                <input className="admin-modal-input" value={draftPayment.accountNumber} onChange={(e) => setDraftPayment((p) => ({ ...p, accountNumber: e.target.value }))} placeholder="contoh: 1234567890" />
              </label>
              <label>Nama Pemilik Rekening
                <input className="admin-modal-input" value={draftPayment.accountName} onChange={(e) => setDraftPayment((p) => ({ ...p, accountName: e.target.value }))} placeholder="contoh: PT Ruang Sosmed" />
              </label>
              <label>Link Konfirmasi Pembayaran
                <input className="admin-modal-input" value={draftPayment.confirmationLink} onChange={(e) => setDraftPayment((p) => ({ ...p, confirmationLink: e.target.value }))} placeholder="https://wa.me/628xxx atau link form" />
              </label>
            </div>

            {/* Referral Codes */}
            <div className="admin-settings-section">
              <div className="admin-settings-section-head">
                <p className="admin-section-label">KODE REFERRAL</p>
                <button type="button" className="admin-pkg-add-btn" onClick={() => setDraftReferralCodes((prev) => [...prev, { code: '', credits: 0, description: '' }])}>
                  + Tambah Kode
                </button>
              </div>
              <div className="admin-referral-list">
                {draftReferralCodes.length === 0 && <p className="admin-empty-hint">Belum ada kode referral.</p>}
                {draftReferralCodes.map((r, idx) => (
                  <div key={idx} className="admin-referral-row">
                    <input
                      className="admin-modal-input admin-referral-code"
                      value={r.code}
                      onChange={(e) => setDraftReferralCodes((prev) => prev.map((x, i) => i === idx ? { ...x, code: e.target.value.toUpperCase() } : x))}
                      placeholder="KODE123"
                    />
                    <input
                      className="admin-modal-input admin-referral-credits"
                      type="number"
                      min="0"
                      value={r.credits}
                      onChange={(e) => setDraftReferralCodes((prev) => prev.map((x, i) => i === idx ? { ...x, credits: parseInt(e.target.value, 10) || 0 } : x))}
                      placeholder="Ruang Coin"
                    />
                    <span className="admin-referral-unit">Ruang Coin</span>
                    <input
                      className="admin-modal-input admin-referral-desc"
                      value={r.description ?? ''}
                      onChange={(e) => setDraftReferralCodes((prev) => prev.map((x, i) => i === idx ? { ...x, description: e.target.value } : x))}
                      placeholder="keterangan (opsional)"
                    />
                    <button type="button" className="admin-pkg-remove-btn" onClick={() => setDraftReferralCodes((prev) => prev.filter((_, i) => i !== idx))}>×</button>
                  </div>
                ))}
              </div>
            </div>

            {/* Student Bot Token */}
            <div className="admin-settings-section">
              <div className="admin-settings-section-head">
                <p className="admin-section-label">STUDENT BOT TELEGRAM</p>
              </div>
              <p style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: 8 }}>
                Token bot Telegram khusus student (<b>Ruang Admin</b>). Didapat dari @BotFather. Biarkan kosong jika belum setup.
              </p>
              <input
                className="admin-settings-input"
                type="password"
                value={draftStudentBotToken}
                onChange={(e) => setDraftStudentBotToken(e.target.value)}
                placeholder="123456789:AABBcc..."
                autoComplete="off"
              />
              {draftStudentBotToken && (
                <p style={{ fontSize: '0.72rem', color: '#22c55e', marginTop: 4 }}>✓ Token tersimpan</p>
              )}
            </div>

            </div>{/* end kolom kanan */}

            <div className="admin-modal-actions" style={{ marginTop: 20 }}>
              <button type="button" className="admin-modal-cancel" onClick={() => setShowSettings(false)}>Batal</button>
              <button type="button" className="admin-modal-submit" disabled={settingsSaving} onClick={handleSaveSettings}>
                {settingsSaving ? 'Menyimpan…' : 'Simpan Pengaturan'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </section>
  );
}

type TopupRequest = {
  id: string;
  username: string;
  display_name: string;
  credits: number;
  amount_rp: number;
  package_label: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  note?: string;
  promo_bonus?: PackagePromo | null;
  proof_url?: string | null;
  bonus_credits?: number;
};

function InboxPage() {
  const [activeTab, setActiveTab] = useState<'booking' | 'topup'>(() =>
    window.location.hash === '#inbox-topup' ? 'topup' : 'booking'
  );
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState<string | null>(null);

  // Topup requests
  const [topupRequests, setTopupRequests] = useState<TopupRequest[]>([]);
  const [topupLoading, setTopupLoading] = useState(true);
  const [topupActionId, setTopupActionId] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [rejectTargetId, setRejectTargetId] = useState<string | null>(null);
  const [avatarMap, setAvatarMap] = useState<Record<string, string>>({});
  const [nameMap, setNameMap] = useState<Record<string, string>>({});
  // Konfirmasi pengosongan riwayat: 'booking' | 'topup' | null
  const [clearTarget, setClearTarget] = useState<'booking' | 'topup' | null>(null);
  const [clearing, setClearing] = useState(false);
  const [proofPreview, setProofPreview] = useState<string | null>(null);

  const loadTopupRequests = async () => {
    setTopupLoading(true);
    const { data } = await supabase.from('topup_requests').select('*').order('created_at', { ascending: false });
    setTopupRequests((data ?? []) as TopupRequest[]);
    setTopupLoading(false);
  };

  const handleApproveTopup = async (req: TopupRequest) => {
    setTopupActionId(req.id);
    const { data: existing } = await supabase.from('user_credits').select('balance').eq('username', req.username).maybeSingle();
    const current = existing?.balance ?? 0;
    const promo = req.promo_bonus as PackagePromo | null | undefined;
    const bonus = req.bonus_credits ?? 0;
    const totalCredits = req.credits + bonus;

    const ops: Promise<unknown>[] = [
      supabase.from('user_credits').upsert({ username: req.username, balance: current + totalCredits }),
      supabase.from('credit_transactions').insert({ username: req.username, amount: req.credits, type: 'topup', description: `Topup ${req.package_label} — ${formatRupiah(req.amount_rp)}` }),
      supabase.from('topup_requests').update({ status: 'approved', processed_at: new Date().toISOString() }).eq('id', req.id),
    ];
    if (bonus > 0) {
      ops.push(supabase.from('credit_transactions').insert({ username: req.username, amount: bonus, type: 'topup', description: `🎁 Bonus paket ${req.package_label}` }));
    }

    // Apply promo bonus features / booking
    if (promo?.active) {
      const perksUpdate: Record<string, boolean> = {};
      for (const f of promo.bonus_features ?? []) perksUpdate[f] = true;
      if (promo.bonus_booking) perksUpdate['free_booking'] = true;
      if (Object.keys(perksUpdate).length > 0) {
        const { data: existingProfile } = await supabase.from('user_profiles').select('perks').eq('username', req.username).maybeSingle();
        const currentPerks = (existingProfile?.perks ?? {}) as Record<string, boolean>;
        ops.push(supabase.from('user_profiles').update({ perks: { ...currentPerks, ...perksUpdate } }).eq('username', req.username));
      }
      const bonusDesc = [
        promo.bonus_booking && 'Sesi 1:1 Gratis',
        ...(promo.bonus_features ?? []).map((f: string) => ({ free_video: 'Video', free_booking: 'Booking', free_thread: 'Thread', free_asset: 'Asset', free_event: 'Event' }[f] ?? f)),
      ].filter(Boolean).join(', ');
      const notifBody = `${totalCredits} Ruang Coin ditambahkan${bonus > 0 ? ` (termasuk +${bonus} bonus paket)` : ''}. 🎁 Bonus promo: ${bonusDesc}`;
      ops.push(insertNotification(req.username, 'credits_added', '🎉 Topup + Bonus Promo!', notifBody, '#profile'));
    } else {
      const body = bonus > 0
        ? `${totalCredits} Ruang Coin ditambahkan ke akunmu (${req.credits} + 🎁 ${bonus} bonus paket). Selamat belajar!`
        : `${req.credits} Ruang Coin berhasil ditambahkan ke akunmu. Selamat belajar!`;
      ops.push(insertNotification(req.username, 'credits_added', '✦ Ruang Coin Ditambahkan!', body, '#profile'));
    }

    await Promise.all(ops);

    // Notify student via Telegram bot
    const bonusLine = bonus > 0 ? `\n🎁 Termasuk <b>+${bonus} bonus paket</b>!` : '';
    const approveMsg = promo?.active
      ? `🎉 <b>Topup Berhasil + Bonus Promo!</b>\n\n💰 <b>+${totalCredits} Ruang Coin</b> sudah masuk ke akunmu.${bonusLine}\n🎁 Bonus promo aktif — cek akunmu di Ruang Sosmed ID.`
      : `✅ <b>Topup Berhasil!</b>\n\n💰 <b>+${totalCredits} Ruang Coin</b> sudah masuk ke akunmu.${bonusLine}\n\nLogin ke Ruang Sosmed ID untuk mulai belajar! 🚀`;
    void notifyStudent(req.username, approveMsg);

    setTopupActionId(null);
    void loadTopupRequests();
  };

  const handleRejectTopup = async (req: TopupRequest) => {
    setTopupActionId(req.id);
    await Promise.all([
      supabase.from('topup_requests').update({ status: 'rejected', processed_at: new Date().toISOString(), note: rejectNote || null }).eq('id', req.id),
      insertNotification(req.username, 'credits_added', 'Request Topup Ditolak', rejectNote ? `Topupmu ditolak: ${rejectNote}` : 'Request topup kamu tidak dapat diproses. Hubungi admin untuk info lebih lanjut.', '#profil'),
    ]);

    // Notify student via Telegram bot
    const rejectMsg = rejectNote
      ? `❌ <b>Topup Ditolak</b>\n\nTopup kamu tidak dapat diproses.\n📝 Alasan: ${rejectNote}\n\nHubungi admin jika ada pertanyaan.`
      : `❌ <b>Topup Ditolak</b>\n\nTopup kamu tidak dapat diproses. Hubungi admin untuk info lebih lanjut.`;
    void notifyStudent(req.username, rejectMsg);

    setTopupActionId(null);
    setRejectTargetId(null);
    setRejectNote('');
    void loadTopupRequests();
  };

  // Kosongkan riwayat (item yang sudah diproses) untuk tab terkait. Item yang
  // masih 'pending' tidak ikut dihapus karena masih butuh tindakan.
  const handleClearHistory = async () => {
    if (!clearTarget) return;
    setClearing(true);
    if (clearTarget === 'booking') {
      await supabase.from('one_on_one_bookings').delete().neq('status', 'pending');
      await loadBookings();
    } else {
      await supabase.from('topup_requests').delete().neq('status', 'pending');
      await loadTopupRequests();
    }
    setClearing(false);
    setClearTarget(null);
  };

  const loadBookings = async () => {
    setLoading(true);
    const { data } = await supabase.from('one_on_one_bookings').select('*').order('created_at', { ascending: false });
    setBookings(
      (data ?? []).map((b) => ({
        id: b.id,
        requester_username: b.requester_username,
        requester_display_name: b.requester_display_name ?? b.requester_username,
        topic: b.topic,
        preferred_date: b.preferred_date,
        preferred_time: b.preferred_time,
        note: b.note ?? '',
        status: b.status,
        created_at: b.created_at,
        calendar_event_id: b.calendar_event_id,
      })),
    );
    setLoading(false);
  };

  useEffect(() => {
    void loadBookings();
    void loadTopupRequests();

    // Realtime: auto-refresh saat topup request baru masuk
    const topupChannel = supabase.channel('topup-requests-inbox')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'topup_requests' }, () => {
        void loadTopupRequests();
      })
      .subscribe();

    // Realtime: auto-refresh booking
    const bookingChannel = supabase.channel('bookings-inbox')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'one_on_one_bookings' }, () => {
        void loadBookings();
      })
      .subscribe();

    // Switch ke tab topup jika hash berubah ke #inbox-topup
    const handleHash = () => {
      if (window.location.hash === '#inbox-topup') setActiveTab('topup');
    };
    window.addEventListener('hashchange', handleHash);

    return () => {
      void supabase.removeChannel(topupChannel);
      void supabase.removeChannel(bookingChannel);
      window.removeEventListener('hashchange', handleHash);
    };
  }, []);

  const handleApprove = async (booking: Booking) => {
    setActionId(booking.id);
    const endTime = booking.preferred_time.replace(/(\d+):(\d+)/, (_, h, m) => {
      return `${String(parseInt(h) + 1).padStart(2, '0')}:${m}`;
    });
    const { data: evData, error: evErr } = await supabase.from('calendar_events').insert([{
      title: `1:1 - ${booking.requester_display_name}: ${booking.topic}`,
      note: booking.note || '',
      event_date: booking.preferred_date,
      start_time: booking.preferred_time,
      end_time: endTime,
      category: 'qna',
      accent: 'purple',
      attendee_count: 2,
      is_done: false,
      sort_order: 0,
    }]).select('id').single();
    if (!evErr) {
      await supabase.from('one_on_one_bookings').update({ status: 'approved', calendar_event_id: evData?.id ?? null }).eq('id', booking.id);
      void insertNotification(booking.requester_username, 'booking_approved', 'Sesi 1:1 Disetujui!', `Sesi "${booking.topic}" pada ${booking.preferred_date} pukul ${booking.preferred_time.slice(0,5)} sudah ditambahkan ke kalender.`, '#calendar');
    }
    setActionId(null);
    void loadBookings();
  };

  const handleReject = async (id: string) => {
    setActionId(id);
    const booking = bookings.find((b) => b.id === id);
    await supabase.from('one_on_one_bookings').update({ status: 'rejected' }).eq('id', id);
    if (booking) void insertNotification(booking.requester_username, 'booking_rejected', 'Sesi 1:1 Tidak Disetujui', `Permintaan sesi "${booking.topic}" belum bisa dikonfirmasi. Silakan coba booking ulang dengan jadwal lain.`, '#calendar');
    setActionId(null);
    void loadBookings();
  };

  // Fetch avatar tiap user yang muncul di booking / topup
  useEffect(() => {
    const usernames = Array.from(new Set([
      ...bookings.map((b) => b.requester_username),
      ...topupRequests.map((r) => r.username),
    ].filter(Boolean)));
    const missing = usernames.filter((u) => !(u in avatarMap));
    if (missing.length === 0) return;
    void supabase
      .from('user_profiles')
      .select('username, name, avatar_path')
      .in('username', missing)
      .then(({ data }) => {
        if (!data) return;
        const rows = data as { username: string; name: string | null; avatar_path: string | null }[];
        setAvatarMap((prev) => {
          const next = { ...prev };
          for (const p of rows) {
            if (p.avatar_path) next[p.username] = profileAvatarPublicUrl(p.avatar_path);
          }
          return next;
        });
        setNameMap((prev) => {
          const next = { ...prev };
          for (const p of rows) {
            if (p.name && p.name.trim()) next[p.username] = p.name.trim();
          }
          return next;
        });
      });
  }, [bookings, topupRequests]);

  const pending = bookings.filter((b) => b.status === 'pending');
  const others = bookings.filter((b) => b.status !== 'pending');

  const resolveName = (username: string, fallback: string) => nameMap[username] || fallback || username;

  const renderInboxAvatar = (username: string, displayName: string) => (
    <img
      src={avatarMap[username] || forumAvatarSvg(displayName, username)}
      alt={displayName}
      className="admin-inbox-avatar"
    />
  );

  const pendingTopup = topupRequests.filter((r) => r.status === 'pending');
  const historyTopup = topupRequests.filter((r) => r.status !== 'pending');

  return (
    <section className="page card admin-page">
      <div className="admin-header">
        <div>
          <h2 className="admin-title">Inbox</h2>
          <p className="admin-subtitle">Kelola booking sesi & request topup Ruang Coin</p>
        </div>
        <button type="button" className="admin-add-btn" onClick={() => { void loadBookings(); void loadTopupRequests(); }}>↻ Refresh</button>
      </div>

      {/* Tabs */}
      <div className="inbox-tabs">
        <button type="button" className={`inbox-tab${activeTab === 'booking' ? ' active' : ''}`} onClick={() => setActiveTab('booking')}>
          Booking 1:1
          {bookings.filter((b) => b.status === 'pending').length > 0 && (
            <span className="inbox-tab-badge">{bookings.filter((b) => b.status === 'pending').length}</span>
          )}
        </button>
        <button type="button" className={`inbox-tab${activeTab === 'topup' ? ' active' : ''}`} onClick={() => setActiveTab('topup')}>
          Request Topup
          {pendingTopup.length > 0 && <span className="inbox-tab-badge">{pendingTopup.length}</span>}
        </button>
      </div>

      {/* Tab: Booking 1:1 */}
      {activeTab === 'booking' && (
        loading ? <div className="forum-loading">memuat data…</div> : (
          <div className="admin-inbox">
            {pending.length > 0 && (
              <>
                <p className="admin-section-label">Menunggu Konfirmasi ({pending.length})</p>
                <div className="admin-inbox-list">
                  {pending.map((b) => (
                    <div key={b.id} className="admin-inbox-card pending">
                      <div className="admin-inbox-card-head">
                        <div className="admin-inbox-identity">
                          {renderInboxAvatar(b.requester_username, resolveName(b.requester_username, b.requester_display_name))}
                          <div className="admin-inbox-user">
                            <strong>{resolveName(b.requester_username, b.requester_display_name)}</strong>
                            <span className="admin-inbox-username">@{b.requester_username}</span>
                          </div>
                        </div>
                        <span className="admin-inbox-status pending">Menunggu</span>
                      </div>
                      <div className="admin-inbox-topic">{b.topic}</div>
                      <div className="admin-inbox-meta">
                        <span>📅 {b.preferred_date}</span>
                        <span>🕐 {b.preferred_time}</span>
                        <span className="admin-inbox-created">{new Date(b.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                      </div>
                      {b.note && <p className="admin-inbox-note">"{b.note}"</p>}
                      <div className="admin-inbox-actions">
                        <button type="button" className="admin-inbox-approve" disabled={actionId === b.id} onClick={() => handleApprove(b)}>
                          {actionId === b.id ? 'Memproses…' : '✓ Setujui & Tambah ke Kalender'}
                        </button>
                        <button type="button" className="admin-inbox-reject" disabled={actionId === b.id} onClick={() => handleReject(b.id)}>
                          ✕ Tolak
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
            {others.length > 0 && (
              <>
                <div className="admin-inbox-section-head" style={{ marginTop: pending.length > 0 ? '24px' : 0 }}>
                  <p className="admin-section-label" style={{ margin: 0 }}>Riwayat</p>
                  <button type="button" className="admin-inbox-clear-btn" onClick={() => setClearTarget('booking')}>
                    🗑 Kosongkan Riwayat
                  </button>
                </div>
                <div className="admin-inbox-list">
                  {others.map((b) => (
                    <div key={b.id} className={`admin-inbox-card ${b.status}`}>
                      <div className="admin-inbox-card-head">
                        <div className="admin-inbox-identity">
                          {renderInboxAvatar(b.requester_username, resolveName(b.requester_username, b.requester_display_name))}
                          <div className="admin-inbox-user">
                            <strong>{resolveName(b.requester_username, b.requester_display_name)}</strong>
                            <span className="admin-inbox-username">@{b.requester_username}</span>
                          </div>
                        </div>
                        <span className={`admin-inbox-status ${b.status}`}>{b.status === 'approved' ? '✓ Disetujui' : '✕ Ditolak'}</span>
                      </div>
                      <div className="admin-inbox-topic">{b.topic}</div>
                      <div className="admin-inbox-meta">
                        <span>📅 {b.preferred_date}</span>
                        <span>🕐 {b.preferred_time}</span>
                        <span className="admin-inbox-created">{new Date(b.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                      </div>
                      {b.note && <p className="admin-inbox-note">"{b.note}"</p>}
                      {b.status === 'approved' && <p className="admin-inbox-approved-note">Sudah ditambahkan ke kalender.</p>}
                    </div>
                  ))}
                </div>
              </>
            )}
            {bookings.length === 0 && <div style={{ padding: '48px', textAlign: 'center', color: '#aaa' }}>Belum ada booking 1:1 masuk.</div>}
          </div>
        )
      )}

      {/* Tab: Request Topup */}
      {activeTab === 'topup' && (
        topupLoading ? <div className="forum-loading">memuat data…</div> : (
          <div className="admin-inbox">
            {pendingTopup.length > 0 && (
              <>
                <p className="admin-section-label">Menunggu Verifikasi ({pendingTopup.length})</p>
                <div className="admin-inbox-list">
                  {pendingTopup.map((r) => (
                    <div key={r.id} className="admin-inbox-card pending topup-request-card topup-request-card--withproof">
                      <div className="topup-req-main">
                      <div className="admin-inbox-card-head">
                        <div className="admin-inbox-identity">
                          {renderInboxAvatar(r.username, resolveName(r.username, r.display_name || r.username))}
                          <div className="admin-inbox-user">
                            <strong>{resolveName(r.username, r.display_name || r.username)}</strong>
                            <span className="admin-inbox-username">@{r.username}</span>
                          </div>
                        </div>
                        <span className="admin-inbox-status pending">Menunggu</span>
                      </div>
                      <div className="topup-req-detail">
                        <div className="topup-req-pkg">
                          <span className="topup-req-label">Paket</span>
                          <strong>{r.package_label}</strong>
                        </div>
                        <div className="topup-req-pkg">
                          <span className="topup-req-label">Ruang Coin</span>
                          <strong className="topup-req-credits"><CoinIcon size={13} /> {r.credits.toLocaleString('id-ID')}</strong>
                        </div>
                        <div className="topup-req-pkg">
                          <span className="topup-req-label">Total Bayar</span>
                          <strong className="topup-req-amount">{formatRupiah(r.amount_rp)}</strong>
                        </div>
                      </div>
                      <div className="admin-inbox-meta">
                        <span className="admin-inbox-created">{new Date(r.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      {rejectTargetId === r.id ? (
                        <div className="topup-reject-form">
                          <input
                            className="admin-modal-input"
                            placeholder="Alasan penolakan (opsional)"
                            value={rejectNote}
                            onChange={(e) => setRejectNote(e.target.value)}
                          />
                          <div className="admin-inbox-actions">
                            <button type="button" className="admin-inbox-reject" disabled={topupActionId === r.id} onClick={() => void handleRejectTopup(r)}>
                              {topupActionId === r.id ? 'Memproses…' : 'Konfirmasi Tolak'}
                            </button>
                            <button type="button" className="admin-modal-cancel" onClick={() => { setRejectTargetId(null); setRejectNote(''); }}>Batal</button>
                          </div>
                        </div>
                      ) : (
                        <div className="admin-inbox-actions">
                          <button type="button" className="admin-inbox-approve" disabled={topupActionId === r.id} onClick={() => void handleApproveTopup(r)}>
                            {topupActionId === r.id ? 'Memproses…' : <><span>✓ Approve & Tambah </span><CoinIcon size={12} />{r.credits} ke @{r.username}</>}
                          </button>
                          <button type="button" className="admin-inbox-reject" disabled={topupActionId === r.id} onClick={() => setRejectTargetId(r.id)}>
                            ✕ Tolak
                          </button>
                        </div>
                      )}
                      </div>
                      <div className="topup-proof-col">
                        <span className="topup-proof-col-label">Bukti Bayar</span>
                        {r.proof_url ? (
                          <button type="button" className="topup-proof-thumb" onClick={() => setProofPreview(r.proof_url!)}>
                            <img src={r.proof_url} alt="Bukti transfer" />
                            <span className="topup-proof-zoom">🔍 Lihat</span>
                          </button>
                        ) : (
                          <div className="topup-proof-empty">Belum ada bukti</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {historyTopup.length > 0 && (
              <>
                <div className="admin-inbox-section-head" style={{ marginTop: pendingTopup.length > 0 ? '24px' : 0 }}>
                  <p className="admin-section-label" style={{ margin: 0 }}>Riwayat</p>
                  <button type="button" className="admin-inbox-clear-btn" onClick={() => setClearTarget('topup')}>
                    🗑 Kosongkan Riwayat
                  </button>
                </div>
                <div className="admin-inbox-list">
                  {historyTopup.map((r) => (
                    <div key={r.id} className={`admin-inbox-card ${r.status}`}>
                      <div className="admin-inbox-card-head">
                        <div className="admin-inbox-identity">
                          {renderInboxAvatar(r.username, resolveName(r.username, r.display_name || r.username))}
                          <div className="admin-inbox-user">
                            <strong>{resolveName(r.username, r.display_name || r.username)}</strong>
                            <span className="admin-inbox-username">@{r.username}</span>
                          </div>
                        </div>
                        <span className={`admin-inbox-status ${r.status}`}>{r.status === 'approved' ? '✓ Approved' : '✕ Ditolak'}</span>
                      </div>
                      <div className="topup-req-detail">
                        <div className="topup-req-pkg">
                          <span className="topup-req-label">Paket</span>
                          <strong>{r.package_label}</strong>
                        </div>
                        <div className="topup-req-pkg">
                          <span className="topup-req-label">Coin</span>
                          <strong className="topup-req-credits"><CoinIcon size={13} /> {r.credits.toLocaleString('id-ID')}</strong>
                        </div>
                        <div className="topup-req-pkg">
                          <span className="topup-req-label">Total</span>
                          <strong>{formatRupiah(r.amount_rp)}</strong>
                        </div>
                      </div>
                      {r.note && <p className="admin-inbox-note">Alasan: "{r.note}"</p>}
                      <div className="admin-inbox-meta">
                        <span className="admin-inbox-created">{new Date(r.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {topupRequests.length === 0 && <div style={{ padding: '48px', textAlign: 'center', color: '#aaa' }}>Belum ada request topup masuk.</div>}
          </div>
        )
      )}

      {/* Reject topup modal backdrop handled inline above */}

      {clearTarget && createPortal(
        <div className="forum-modal-overlay confirm-overlay" onClick={() => !clearing && setClearTarget(null)}>
          <div className="forum-modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-icon">🗑</div>
            <h3 className="confirm-title">Kosongkan Riwayat?</h3>
            <p className="confirm-desc">
              Semua riwayat {clearTarget === 'booking' ? 'booking 1:1' : 'request topup'} yang sudah diproses akan dihapus permanen. Item yang masih menunggu konfirmasi tidak akan terhapus.
            </p>
            <p className="confirm-sub">Tindakan ini tidak bisa dibatalkan.</p>
            <div className="confirm-actions">
              <button type="button" className="button secondary" disabled={clearing} onClick={() => setClearTarget(null)}>Batal</button>
              <button type="button" className="button primary" disabled={clearing} onClick={() => void handleClearHistory()}>
                {clearing ? 'Menghapus…' : 'Ya, Kosongkan'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {proofPreview && createPortal(
        <div className="proof-lightbox-overlay" onClick={() => setProofPreview(null)}>
          <button type="button" className="proof-lightbox-close" onClick={() => setProofPreview(null)}>✕</button>
          <img src={proofPreview} alt="Bukti transfer" className="proof-lightbox-img" onClick={(e) => e.stopPropagation()} />
        </div>,
        document.body,
      )}
    </section>
  );
}

function ProfilePage({
  hash,
  session,
  onProfilePhotoChange,
  onCreditChange,
  externalCredits,
}: {
  hash: string;
  session: AppSession;
  onProfilePhotoChange: (photoUrl: string) => void;
  onCreditChange?: (n: number) => void;
  externalCredits?: number | null;
}) {
  const [profile, setProfile] = useState<UserProfile>(() => readUserProfile(session));
  const [draftProfile, setDraftProfile] = useState<UserProfile>(() => readUserProfile(session));
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const profileBadge = useBadgeTier(session.username);
  const [pendingPhotoFile, setPendingPhotoFile] = useState<File | null>(null);
  const profileView = hash === '#profil-subscription' ? 'subscription' : 'settings';

  // Telegram linking
  const [tgChatId, setTgChatId] = useState<string | null>(null);
  const [tgLinkCode, setTgLinkCode] = useState<string | null>(null);
  const [tgLinkLoading, setTgLinkLoading] = useState(false);
  const [tgUnlinking, setTgUnlinking] = useState(false);
  const [studentBotName, setStudentBotName] = useState('RuangAdmin_bot');

  useEffect(() => {
    const fetchTg = async () => {
      const { data } = await supabase.from('app_users').select('telegram_chat_id').eq('username', session.username).maybeSingle();
      setTgChatId((data as { telegram_chat_id?: string } | null)?.telegram_chat_id ?? null);
    };
    void fetchTg();
    // Also fetch bot username from token
    const fetchBotName = async () => {
      const token = await getStudentBotToken();
      if (!token) return;
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
        const json = await res.json() as { ok: boolean; result: { username: string } };
        if (json.ok) setStudentBotName(json.result.username);
      } catch { /* silent */ }
    };
    void fetchBotName();
  }, [session.username]);

  const handleGenerateLinkCode = async () => {
    setTgLinkLoading(true);
    const code = generateLinkCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await supabase.from('telegram_link_codes').upsert({ code, username: session.username, expires_at: expiresAt });
    setTgLinkCode(code);
    setTgLinkLoading(false);
  };

  const handleUnlinkTelegram = async () => {
    setTgUnlinking(true);
    await supabase.from('app_users').update({ telegram_chat_id: null, telegram_linked_at: null } as never).eq('username', session.username);
    setTgChatId(null);
    setTgUnlinking(false);
  };

  // Ruang Coin & packages
  const [creditBalance, setCreditBalance] = useState<number | null>(null);
  // Sync with App-level realtime balance
  useEffect(() => { if (externalCredits != null) setCreditBalance(externalCredits); }, [externalCredits]);
  const [creditPackages, setCreditPackages] = useState<CreditPackage[]>(defaultCreditPackages);
  const [creditPayment, setCreditPayment] = useState<PaymentInfo>(defaultPaymentInfo);
  const [selectedTopupPkg, setSelectedTopupPkg] = useState<CreditPackage | null>(null);
  const [customCreditAmount, setCustomCreditAmount] = useState('');
  const [topupStep, setTopupStep] = useState<'select' | 'payment' | 'uploaded'>('select');
  const [topupProcessing, setTopupProcessing] = useState(false);
  const [topupPkgSnapshot, setTopupPkgSnapshot] = useState<{ label: string; credits: number; price: number } | null>(null);
  const [topupSavedId, setTopupSavedId] = useState('');
  const [topupProofUploading, setTopupProofUploading] = useState(false);
  const [topupProofPreview, setTopupProofPreview] = useState<string | null>(null);
  const topupProofRef = useRef<HTMLInputElement>(null);
  const [creditTxs, setCreditTxs] = useState<CreditTransaction[]>([]);

  // Referral claim di halaman profil
  const [profileReferralCode, setProfileReferralCode] = useState('');
  const [profileReferralStatus, setProfileReferralStatus] = useState<'idle' | 'checking' | 'valid' | 'invalid' | 'used'>('idle');
  const [profileReferralCredits, setProfileReferralCredits] = useState(0);
  const [referralSuccessModal, setReferralSuccessModal] = useState<{ credits: number; code: string; features?: string[] } | null>(null);

  useEffect(() => {
    let isActive = true;
    void (async () => {
      const [{ data: bal }, settings, { data: txs }] = await Promise.all([
        supabase.from('user_credits').select('balance').eq('username', session.username).maybeSingle(),
        loadAdminSettings(),
        supabase.from('credit_transactions').select('*').eq('username', session.username).order('created_at', { ascending: false }).limit(10),
      ]);
      if (!isActive) return;
      setCreditBalance(bal?.balance ?? 0);
      setCreditPackages(settings.packages);
      setCreditPayment(settings.payment);
      setSelectedTopupPkg(settings.packages[1] ?? settings.packages[0]);
      setCreditTxs((txs ?? []).map((t) => ({ id: t.id, username: t.username, amount: t.amount, type: t.type, description: t.description, createdAt: t.created_at })));
    })();
    return () => { isActive = false; };
  }, [session]);

  // Claim referral dari halaman profil
  const handleProfileReferralClaim = async () => {
    const code = profileReferralCode.trim().toUpperCase();
    if (!code) return;
    setProfileReferralStatus('checking');

    const match = await validateReferralCode(code);
    if (!match) {
      setProfileReferralStatus('invalid');
      return;
    }

    // Cek apakah user sudah pernah pakai kode ini (coin: "Bonus...", feature: "Klaim akses fitur...")
    const { data: existing } = await supabase
      .from('credit_transactions')
      .select('id')
      .eq('username', session.username)
      .or(`description.eq.Bonus kode referral: ${code},description.eq.Klaim akses fitur: ${code}`)
      .limit(1);

    if (existing && existing.length > 0) {
      setProfileReferralStatus('used');
      return;
    }

    const codeType = match.type ?? 'coin';

    // ── Kode tipe Akses Fitur ──
    if (codeType === 'feature' && match.features && match.features.length > 0) {
      // Gabung dengan referral_perks yang sudah ada agar tidak menimpa fitur lain
      const { data: profRow } = await supabase.from('user_profiles').select('referral_perks').eq('username', session.username).maybeSingle();
      const existingPerks = ((profRow as { referral_perks?: UserPerks } | null)?.referral_perks ?? {}) as UserPerks;
      const referralPerks: UserPerks = { ...existingPerks };
      for (const f of match.features) referralPerks[f as keyof UserPerks] = true;

      await Promise.all([
        supabase.from('user_profiles').update({
          referral_perks: referralPerks,
          referral_perks_expires_at: match.expiresAt ?? null,
          referral_code: code,
        } as never).eq('username', session.username),
        // Penanda agar kode tidak bisa diklaim dua kali (amount 0)
        supabase.from('credit_transactions').insert({
          username: session.username,
          amount: 0,
          type: 'topup',
          description: `Klaim akses fitur: ${code}`,
        }),
      ]);

      setProfileReferralCode('');
      setProfileReferralStatus('idle');
      setReferralSuccessModal({ credits: 0, code, features: match.features });
      return;
    }

    // ── Kode tipe Ruang Coin ──
    setProfileReferralCredits(match.credits);
    setProfileReferralStatus('valid');

    // Tambah koin langsung
    const currentBal = creditBalance ?? 0;
    const newBal = currentBal + match.credits;
    await Promise.all([
      supabase.from('user_credits').upsert({ username: session.username, balance: newBal }),
      supabase.from('credit_transactions').insert({
        username: session.username,
        amount: match.credits,
        type: 'topup',
        description: `Bonus kode referral: ${code}`,
      }),
    ]);

    setCreditBalance(newBal);
    onCreditChange?.(newBal);
    setProfileReferralCode('');
    setProfileReferralStatus('idle');
    setReferralSuccessModal({ credits: match.credits, code });

    // Tambah ke riwayat transaksi lokal
    setCreditTxs((prev) => [{
      id: crypto.randomUUID(),
      username: session.username,
      amount: match.credits,
      type: 'topup',
      description: `Bonus kode referral: ${code}`,
      createdAt: new Date().toISOString(),
    }, ...prev]);
  };

  // Ganti password
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);

  useEffect(() => {
    let isActive = true;

    void (async () => {
      const nextProfile = await loadSupabaseUserProfile(session);
      if (!isActive) {
        return;
      }

      setProfile(nextProfile);
      setDraftProfile(nextProfile);
      onProfilePhotoChange(nextProfile.photoUrl);
    })();

    return () => {
      isActive = false;
    };
  }, [session]);

  const updateDraftProfile = (field: keyof UserProfile, value: string) => {
    setDraftProfile((current) => ({ ...current, [field]: value }));
  };

  const handleChangePassword = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setPasswordError('');
    setPasswordSuccess(false);
    if (!oldPassword || !newPassword || !confirmPassword) {
      setPasswordError('Semua field wajib diisi.');
      return;
    }
    if (newPassword.length < 6) {
      setPasswordError('Password baru minimal 6 karakter.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Konfirmasi password tidak cocok.');
      return;
    }
    setPasswordSaving(true);
    const { error } = await supabase.rpc('change_app_user_password', {
      p_username: session.username,
      p_old_password: oldPassword,
      p_new_password: newPassword,
    });
    setPasswordSaving(false);
    if (error) {
      setPasswordError(
        error.message.includes('password lama salah')
          ? 'Password lama tidak sesuai.'
          : error.message,
      );
      return;
    }
    setPasswordSuccess(true);
    setOldPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setTimeout(() => { setPasswordSuccess(false); setShowChangePassword(false); }, 2000);
  };

  const handlePhotoUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      window.alert('ukuran foto maksimal 2 MB.');
      return;
    }

    const previewUrl = URL.createObjectURL(file);
    setPendingPhotoFile(file);
    updateDraftProfile('photoUrl', previewUrl);
  };

  const saveProfile = () => {
    void (async () => {
      let avatarPath = draftProfile.avatarPath;
      let photoUrl = draftProfile.photoUrl;

      if (pendingPhotoFile) {
        const avatarUp = await compressImage(pendingPhotoFile, 512, 0.85);
        const filePath = `${session.username}/${Date.now()}-${sanitizeFileName(avatarUp.name)}`;
        const { error: uploadError } = await supabase.storage.from('profile-avatars').upload(filePath, avatarUp, {
          upsert: true,
          contentType: avatarUp.type,
        });

        if (uploadError) {
          console.warn('supabase upload failed for profile avatar', uploadError);
          window.alert(`gagal upload foto profile: ${uploadError.message}`);
          return;
        }

        avatarPath = filePath;
        photoUrl = profileAvatarPublicUrl(filePath);
      }

      const { error } = await supabase.from('user_profiles').upsert(
        {
          username: session.username,
          name: draftProfile.name,
          email: draftProfile.email,
          job_title: draftProfile.role,
          birth_date: draftProfile.birthDate || null,
          joined_at: profile.joinedAt,
          avatar_path: avatarPath || null,
        },
        { onConflict: 'username' },
      );

      if (error) {
        console.warn('supabase save failed for user profile', error);
        window.alert(`gagal menyimpan profile: ${error.message}`);
        return;
      }

      const nextProfile = {
        ...draftProfile,
        joinedAt: profile.joinedAt,
        subscriptionStatus: profile.subscriptionStatus,
        subscriptionStart: profile.subscriptionStart,
        subscriptionDue: profile.subscriptionDue,
        paymentMethod: profile.paymentMethod,
        renewalStatus: profile.renewalStatus,
        avatarPath,
        photoUrl,
      };

      setProfile(nextProfile);
      setDraftProfile(nextProfile);
      persistUserProfile(session.username, nextProfile);
      onProfilePhotoChange(photoUrl);
      setPendingPhotoFile(null);
      setIsEditingProfile(false);
    })();
  };

  const cancelProfileEdit = () => {
    setDraftProfile(profile);
    setPendingPhotoFile(null);
    setIsEditingProfile(false);
  };

  const activeProfile = isEditingProfile ? draftProfile : profile;

  return (
    <section className="page card">
      <div className="page-hero">
        <div>
          <p className="eyebrow">{profileView === 'subscription' ? 'status berlangganan' : 'setting profile'}</p>
          <h2>{profileView === 'subscription' ? 'detail langganan user' : 'profil user'}</h2>
        </div>
        <a className="button secondary" href="#dashboard">kembali ke dashboard</a>
      </div>

      <div className="profile-subnav">
        <a href="#profil-settings" className={profileView === 'settings' ? 'active' : ''}>
          setting profile
        </a>
        <a href="#profil-subscription" className={profileView === 'subscription' ? 'active' : ''}>
          status berlangganan
        </a>
      </div>

      {profileView === 'settings' ? (
        <section className="inline-profile-panel">
          <div className="profile-overview">
            <div className="profile-photo-wrap">
              <img
                src={activeProfile.photoUrl || avatarForSession(session)}
                alt={activeProfile.name}
                className="profile-photo"
              />
              {isEditingProfile && (
                <label className="button secondary profile-upload">
                  unggah foto
                  <input type="file" accept="image/*" onChange={handlePhotoUpload} />
                </label>
              )}
            </div>

            <div className="profile-detail-panel">
              <div className="section-head">
                <div>
                  <p className="eyebrow">data user</p>
                  <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <BadgeIcon tier={profileBadge} size={20} />
                    {activeProfile.name}
                  </h3>
                </div>
                {!isEditingProfile ? (
                  <button type="button" className="button primary" onClick={() => setIsEditingProfile(true)}>
                    edit profile
                  </button>
                ) : (
                  <div className="profile-actions">
                    <button type="button" className="button secondary" onClick={cancelProfileEdit}>
                      cancel
                    </button>
                    <button type="button" className="button primary" onClick={saveProfile}>
                      simpan profile
                    </button>
                  </div>
                )}
              </div>

              {isEditingProfile ? (
                <div className="profile-form-grid">
                  <label>
                    nama
                    <input value={draftProfile.name} onChange={(event) => updateDraftProfile('name', event.target.value)} />
                  </label>
                  <label>
                    email
                    <input value={draftProfile.email} onChange={(event) => updateDraftProfile('email', event.target.value)} />
                  </label>
                  <label>
                    jabatan / role
                    <input
                      value={draftProfile.role}
                      onChange={(event) => updateDraftProfile('role', event.target.value)}
                      placeholder="contoh: social media strategist"
                    />
                  </label>
                  <label>
                    tanggal lahir
                    <input type="date" value={draftProfile.birthDate} onChange={(event) => updateDraftProfile('birthDate', event.target.value)} />
                  </label>
                  <div className="readonly-profile-field">
                    <span>pertama bergabung</span>
                    <strong>{profile.joinedAt}</strong>
                  </div>
                  <div className="readonly-profile-field">
                    <span>status berlangganan</span>
                    <strong>{profile.subscriptionStatus}</strong>
                  </div>
                </div>
              ) : (
                <div className="profile-info-grid">
                  <div><span>nama</span><strong>{profile.name}</strong></div>
                  <div><span>pertama bergabung</span><strong>{profile.joinedAt}</strong></div>
                  <div><span>jabatan / role</span><strong>{profile.role}</strong></div>
                  <div><span>email</span><strong>{profile.email}</strong></div>
                  <div><span>tanggal lahir</span><strong>{profile.birthDate}</strong></div>
                  <div><span>status berlangganan</span><strong>{profile.subscriptionStatus}</strong></div>
                </div>
              )}
            </div>
          </div>

          {/* Ganti Password */}
          <div className="profile-password-section">
            <div className="profile-password-header">
              <div>
                <p className="eyebrow">keamanan akun</p>
                <h3>Password</h3>
              </div>
              {!showChangePassword && (
                <button type="button" className="button secondary" onClick={() => { setShowChangePassword(true); setPasswordError(''); setPasswordSuccess(false); }}>
                  ganti password
                </button>
              )}
            </div>

            {showChangePassword && (
              <form className="profile-password-form" onSubmit={handleChangePassword}>
                <label>
                  Password saat ini
                  <input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" />
                </label>
                <label>
                  Password baru
                  <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
                </label>
                <label>
                  Konfirmasi password baru
                  <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
                </label>
                {passwordError && <p className="profile-password-error">{passwordError}</p>}
                {passwordSuccess && <p className="profile-password-success">Password berhasil diubah!</p>}
                <div className="profile-password-actions">
                  <button type="button" className="button secondary" onClick={() => { setShowChangePassword(false); setOldPassword(''); setNewPassword(''); setConfirmPassword(''); setPasswordError(''); }}>
                    batal
                  </button>
                  <button type="submit" className="button primary" disabled={passwordSaving}>
                    {passwordSaving ? 'menyimpan…' : 'simpan password'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </section>
      ) : (
        <section className="inline-profile-panel">
          {/* Saldo Ruang Coin */}
          <div className="credit-balance-card">
            <div className="credit-balance-left">
              <p className="eyebrow">saldo Ruang Coin</p>
              <CoinBalanceDisplay balance={creditBalance} />
              <p className="credit-balance-desc">Ruang Coin digunakan untuk mengakses fitur dan konten premium.</p>
            </div>
            <div className="credit-balance-history">
              <p className="eyebrow" style={{ marginBottom: 8 }}>riwayat terakhir</p>
              {creditTxs.length === 0 ? (
                <p className="credit-empty">belum ada transaksi.</p>
              ) : (
                <div className="credit-tx-list">
                  {creditTxs.slice(0, 5).map((t) => (
                    <div key={t.id} className="credit-tx-row">
                      <span className="credit-tx-desc">{t.description}</span>
                      <span className={`credit-tx-amt ${t.amount > 0 ? 'pos' : 'neg'}`}>
                        {t.amount > 0 ? '+' : ''}{t.amount.toLocaleString('id-ID')}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Topup Ruang Coin */}
          <div className="credit-topup-section">
            <p className="eyebrow" style={{ marginBottom: 12 }}>topup Ruang Coin</p>
            <div className="credit-pkg-grid">
              {creditPackages.map((pkg) => (
                <button
                  key={pkg.id}
                  type="button"
                  className={`credit-pkg-card${selectedTopupPkg?.id === pkg.id && !customCreditAmount ? ' selected' : ''}${isPromoActive(pkg) ? ' promo-active' : ''}`}
                  onClick={() => { setSelectedTopupPkg(pkg); setCustomCreditAmount(''); }}
                >
                  {isPromoActive(pkg) && <span className="credit-pkg-promo-badge">{pkg.promo!.label || '🎉 Promo'}</span>}
                  <span className="credit-pkg-label">{pkg.label}</span>
                  {(pkg.discount ?? 0) > 0 && <span className="credit-pkg-discount">-{pkg.discount}%</span>}
                  <span className="credit-pkg-credits"><CoinIcon size={13} /> {pkg.credits.toLocaleString('id-ID')} Ruang Coin</span>
                  {(pkg.bonusCredits ?? 0) > 0 && <span className="credit-pkg-bonus">🎁 +{pkg.bonusCredits} bonus koin</span>}
                  <span className="credit-pkg-price">{formatRupiah(pkg.price)}</span>
                  {(pkg.discount ?? 0) > 0 && (
                    <span className="credit-pkg-base-price">{formatRupiah(pkg.credits * CREDIT_RATE)}</span>
                  )}
                  {isPromoActive(pkg) && (pkg.promo!.bonus_features?.length || pkg.promo!.bonus_booking) && (
                    <span className="credit-pkg-promo-bonus">
                      🎁 Bonus:{' '}
                      {[
                        pkg.promo!.bonus_booking && 'Sesi 1:1 Gratis',
                        ...(pkg.promo!.bonus_features ?? []).map((f) => ({ free_video: 'Video', free_booking: 'Booking', free_thread: 'Thread', free_asset: 'Asset', free_event: 'Event' }[f])),
                      ].filter(Boolean).join(', ')}
                    </span>
                  )}
                </button>
              ))}
            </div>

            <div className="credit-custom-wrap">
              <p className="credit-custom-label">atau masukkan jumlah Ruang Coin sendiri</p>
              <div className="credit-custom-row">
                <CoinIcon size={15} />
                <input
                  type="number"
                  min="1"
                  className={`credit-custom-input${customCreditAmount ? ' active' : ''}`}
                  placeholder="contoh: 150"
                  value={customCreditAmount}
                  onChange={(e) => { setCustomCreditAmount(e.target.value); setSelectedTopupPkg(null); }}
                />
                <span className="credit-custom-unit">Ruang Coin</span>
                {customCreditAmount && parseInt(customCreditAmount, 10) > 0 && (
                  <span className="credit-custom-price">{formatRupiah(parseInt(customCreditAmount, 10) * CREDIT_RATE)}</span>
                )}
              </div>
            </div>

            {/* Kode Referral */}
            <div className="credit-referral-wrap">
              <p className="credit-custom-label">punya kode referral? klaim Ruang Coin gratis</p>
              <div className="credit-referral-row">
                <input
                  type="text"
                  className={`credit-referral-input${profileReferralStatus === 'invalid' || profileReferralStatus === 'used' ? ' error' : profileReferralStatus === 'valid' ? ' valid' : ''}`}
                  placeholder="masukkan kode referral…"
                  value={profileReferralCode}
                  onChange={(e) => { setProfileReferralCode(e.target.value.toUpperCase()); setProfileReferralStatus('idle'); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleProfileReferralClaim(); }}
                  maxLength={20}
                />
                <button
                  type="button"
                  className="credit-referral-btn"
                  disabled={!profileReferralCode.trim() || profileReferralStatus === 'checking'}
                  onClick={() => void handleProfileReferralClaim()}
                >
                  {profileReferralStatus === 'checking' ? '…' : 'Klaim'}
                </button>
              </div>
              {profileReferralStatus === 'invalid' && (
                <p className="credit-referral-msg error">Kode tidak valid atau sudah kedaluwarsa.</p>
              )}
              {profileReferralStatus === 'used' && (
                <p className="credit-referral-msg error">Kamu sudah pernah menggunakan kode ini.</p>
              )}
            </div>

            {/* Popup modal referral berhasil */}
            {referralSuccessModal && createPortal(
              <div className="referral-success-overlay" onClick={() => setReferralSuccessModal(null)}>
                <div className="referral-success-modal" onClick={(e) => e.stopPropagation()}>
                  <div className="referral-success-icon">🎉</div>
                  {referralSuccessModal.features && referralSuccessModal.features.length > 0 ? (
                    <>
                      <h3 className="referral-success-title">Akses Fitur Aktif!</h3>
                      <div className="referral-success-amount" style={{ flexWrap: 'wrap', justifyContent: 'center', gap: 6 }}>
                        {referralSuccessModal.features.map((f) => (
                          <span key={f} className="referral-badge valid">{({ free_video: '🎬 Video', free_booking: '📅 Booking', free_thread: '💬 Thread', free_asset: '📁 Asset', free_event: '🎥 Event' } as Record<string, string>)[f] ?? f}</span>
                        ))}
                      </div>
                      <p className="referral-success-desc">
                        Kode referral <strong>{referralSuccessModal.code}</strong> berhasil diklaim.<br />
                        Fitur di atas sekarang gratis untuk kamu.
                      </p>
                    </>
                  ) : (
                    <>
                      <h3 className="referral-success-title">Ruang Coin Berhasil Ditambahkan!</h3>
                      <div className="referral-success-amount">
                        <span className="referral-success-plus"><CoinIcon size={20} /></span>
                        <span className="referral-success-num">{referralSuccessModal.credits.toLocaleString('id-ID')}</span>
                        <span className="referral-success-unit">Ruang Coin</span>
                      </div>
                      <p className="referral-success-desc">
                        Kode referral <strong>{referralSuccessModal.code}</strong> berhasil diklaim.<br />
                        Coin sudah masuk ke saldo kamu sekarang.
                      </p>
                    </>
                  )}
                  <button
                    type="button"
                    className="referral-success-btn"
                    onClick={() => setReferralSuccessModal(null)}
                  >
                    Sip, makasih! 🚀
                  </button>
                </div>
              </div>,
              document.body,
            )}

            {(() => {
              const customAmt = parseInt(customCreditAmount, 10);
              const activePkg = customCreditAmount && customAmt > 0
                ? { label: 'Custom', credits: customAmt, price: customAmt * CREDIT_RATE }
                : selectedTopupPkg;

              const handleProsesTopup = async () => {
                if (!activePkg) return;
                setTopupProcessing(true);
                setTopupPkgSnapshot(activePkg);
                const promoSnapshot2 = 'promo' in activePkg && isPromoActive(activePkg as CreditPackage) ? (activePkg as CreditPackage).promo : null;
                const { data: topupRow2 } = await supabase.from('topup_requests').insert({
                  username: session.username,
                  display_name: session.displayName,
                  credits: activePkg.credits,
                  amount_rp: activePkg.price,
                  package_label: activePkg.label,
                  status: 'pending',
                  promo_bonus: promoSnapshot2 ?? null,
                }).select('id').single();
                setTopupSavedId((topupRow2 as { id?: string } | null)?.id ?? '');
                setTopupProcessing(false);
                setTopupStep('payment');
              };

              const handleTopupProofUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
                const file = e.target.files?.[0];
                if (!file || !topupPkgSnapshot) return;
                setTopupProofUploading(true);
                setTopupProofPreview(URL.createObjectURL(file));
                const ext = file.name.split('.').pop();
                const path = `topup-proofs/${topupSavedId || Date.now()}.${ext}`;
                const { error } = await supabase.storage.from('lesson-assets').upload(path, file, { upsert: true, contentType: file.type });
                if (!error) {
                  const proofUrl = supabase.storage.from('lesson-assets').getPublicUrl(path).data.publicUrl;
                  const shortId2 = topupSavedId.slice(0, 8);
                  await supabase.from('topup_requests').update({ proof_url: proofUrl }).eq('id', topupSavedId);
                  try {
                    const form = new FormData();
                    form.append('chat_id', TG_CHAT);
                    form.append('photo', file);
                    form.append('caption', `💰 <b>Pembelian Coin Baru — Butuh Approval</b>\n\n👤 ${session.displayName} (@${session.username})\n📦 Paket: ${topupPkgSnapshot.label}\n💵 Harga: ${formatRupiah(topupPkgSnapshot.price)}\n🪙 Coin: ${topupPkgSnapshot.credits.toLocaleString('id-ID')} Ruang Coin\n🆔 ID: <code>${shortId2}</code>`);
                    form.append('parse_mode', 'HTML');
                    form.append('reply_markup', JSON.stringify({ inline_keyboard: [[{ text: '✅ Approve', callback_data: `at:${topupSavedId}` }]] }));
                    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, { method: 'POST', body: form });
                  } catch { /* silent */ }
                  const { data: devs } = await supabase.from('app_users').select('username').eq('role', 'developer');
                  if (devs) for (const dev of devs) await supabase.from('notifications').insert([{ recipient_username: dev.username, type: 'credits_added', title: 'Bukti Topup Dikirim', body: `${session.displayName} upload bukti topup ${topupPkgSnapshot.credits} coin`, link: '#inbox-topup' }]);
                  setTopupStep('uploaded');
                }
                setTopupProofUploading(false);
                e.target.value = '';
              };

              if (topupStep === 'uploaded' && topupPkgSnapshot) {
                return (
                  <div className="topup-uploaded-success">
                    <div className="topup-uploaded-icon">🎉</div>
                    <h3 style={{ margin: '4px 0 8px', fontSize: '1.1rem' }}>Bukti Terkirim!</h3>
                    <p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--muted)', maxWidth: 320 }}>Bukti transfermu sudah diterima. Ruang Coin akan ditambahkan setelah admin mengkonfirmasi pembayaran.</p>
                    {topupProofPreview && <img src={topupProofPreview} alt="Bukti" className="topup-uploaded-thumb" />}
                    <button type="button" className="topup-proses-btn" style={{ width: '100%', marginTop: 14 }} onClick={() => { setTopupStep('select'); setSelectedTopupPkg(null); setCustomCreditAmount(''); setTopupProofPreview(null); }}>
                      + Topup Lagi
                    </button>
                  </div>
                );
              }

              if (topupStep === 'payment' && topupPkgSnapshot) {
                return (
                  <div className="credit-payment-info">
                    <div className="credit-payment-summary" style={{ marginBottom: 12 }}>
                      <span>Paket dipilih</span>
                      <strong>{topupPkgSnapshot.label} — <CoinIcon size={13} /> {topupPkgSnapshot.credits.toLocaleString('id-ID')} Ruang Coin</strong>
                      <span>Total pembayaran</span>
                      <strong className="credit-payment-total">{formatRupiah(topupPkgSnapshot.price)}</strong>
                    </div>
                    {(creditPayment.bankName || creditPayment.accountNumber) && (
                      <div className="credit-payment-bank">
                        <p className="eyebrow" style={{ marginBottom: 6 }}>transfer ke</p>
                        {creditPayment.bankName && <div className="credit-bank-name">{creditPayment.bankName}</div>}
                        {creditPayment.accountNumber && (
                          <div className="credit-bank-number-row">
                            <span className="credit-bank-number">{creditPayment.accountNumber}</span>
                            <button type="button" className="credit-copy-btn" onClick={() => {
                              void navigator.clipboard.writeText(creditPayment.accountNumber).catch(() => {
                                const el = document.createElement('textarea'); el.value = creditPayment.accountNumber;
                                el.style.position = 'fixed'; el.style.opacity = '0';
                                document.body.appendChild(el); el.select(); document.execCommand('copy'); document.body.removeChild(el);
                              });
                              const btn = document.activeElement as HTMLButtonElement;
                              const orig = btn.textContent ?? ''; btn.textContent = '✓ disalin';
                              setTimeout(() => { btn.textContent = orig; }, 1800);
                            }}>salin</button>
                          </div>
                        )}
                        {creditPayment.accountName && <div className="credit-bank-holder">{creditPayment.accountName}</div>}
                      </div>
                    )}
                    <input ref={topupProofRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleTopupProofUpload} />
                    {topupProofPreview ? (
                      <div className="topup-proof-preview">
                        <img src={topupProofPreview} alt="Bukti transfer" />
                        {topupProofUploading && <div className="topup-proof-uploading">Mengirim bukti…</div>}
                      </div>
                    ) : (
                      <button type="button" className="topup-proof-upload-btn" onClick={() => topupProofRef.current?.click()} disabled={topupProofUploading}>
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                        <span>Upload Bukti Transfer</span>
                        <small>Foto struk atau screenshot transfer</small>
                      </button>
                    )}
                  </div>
                );
              }

              return activePkg ? (
                <div className="topup-proses-bar">
                  <div className="topup-proses-summary">
                    <span><CoinIcon size={13} /> {activePkg.credits.toLocaleString('id-ID')} Ruang Coin</span>
                    <strong>{formatRupiah(activePkg.price)}</strong>
                  </div>
                  <button
                    type="button"
                    className="topup-proses-btn"
                    disabled={topupProcessing}
                    onClick={() => void handleProsesTopup()}
                  >
                    {topupProcessing ? 'Memproses…' : 'Proses Topup →'}
                  </button>
                </div>
              ) : null;
            })()}
          </div>

          {/* Telegram Linking */}
          <div className="tg-link-card">
            <div className="tg-link-head">
              <div>
                <p className="eyebrow">notifikasi telegram</p>
                <h3 className="tg-link-title">Hubungkan ke Ruang Admin Bot</h3>
                <p className="tg-link-desc">Terima notifikasi topup, kelas baru, event, dan pengumuman langsung di Telegram.</p>
              </div>
              <img src="https://upload.wikimedia.org/wikipedia/commons/8/82/Telegram_logo.svg" alt="Telegram" className="tg-link-icon" />
            </div>

            {tgChatId ? (
              <div className="tg-link-connected">
                <span className="tg-link-badge">✓ Terhubung</span>
                <p className="tg-link-connected-sub">Akunmu sudah terhubung ke bot Telegram. Notifikasi akan dikirim otomatis.</p>
                <button type="button" className="tg-link-unlink-btn" onClick={() => void handleUnlinkTelegram()} disabled={tgUnlinking}>
                  {tgUnlinking ? 'Memutuskan…' : 'Putuskan Koneksi'}
                </button>
              </div>
            ) : (
              <div className="tg-link-steps">
                <div className="tg-link-step">
                  <span className="tg-link-step-num">1</span>
                  <span>Buka Telegram dan cari <a href={`https://t.me/${studentBotName}`} target="_blank" rel="noreferrer" className="tg-link-bot-link">@{studentBotName}</a>, lalu klik <b>Start</b>.</span>
                </div>
                <div className="tg-link-step">
                  <span className="tg-link-step-num">2</span>
                  <span>Generate kode unikmu di bawah, lalu kirim ke bot dengan format: <code>/link KODEMU</code></span>
                </div>
                <div className="tg-link-step">
                  <span className="tg-link-step-num">3</span>
                  <span>Bot akan mengkonfirmasi koneksi berhasil.</span>
                </div>
                {tgLinkCode ? (
                  <div className="tg-link-code-box">
                    <span className="tg-link-code-label">Kode linkmu (berlaku 10 menit):</span>
                    <div className="tg-link-code-row">
                      <code className="tg-link-code">{tgLinkCode}</code>
                      <button type="button" className="tg-link-copy-btn" onClick={() => { void navigator.clipboard.writeText(`/link ${tgLinkCode}`); }}>Salin Perintah</button>
                    </div>
                    <p className="tg-link-code-hint">Kirim pesan ini ke bot: <code>/link {tgLinkCode}</code></p>
                    <button type="button" className="tg-link-refresh-btn" onClick={() => void handleGenerateLinkCode()}>↻ Generate ulang</button>
                  </div>
                ) : (
                  <button type="button" className="tg-link-generate-btn" onClick={() => void handleGenerateLinkCode()} disabled={tgLinkLoading}>
                    {tgLinkLoading ? 'Membuat kode…' : '🔗 Generate Kode Link'}
                  </button>
                )}
              </div>
            )}
          </div>
        </section>
      )}
    </section>
  );
}

function posterForLesson(title: string) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 700">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="#e9dcff" />
          <stop offset="45%" stop-color="#bb8cff" />
          <stop offset="100%" stop-color="#6b3fc8" />
        </linearGradient>
      </defs>
      <rect width="1200" height="700" fill="url(#g)" />
      <circle cx="930" cy="170" r="150" fill="rgba(255,255,255,0.24)" />
      <circle cx="250" cy="500" r="190" fill="rgba(255,255,255,0.16)" />
      <rect x="70" y="70" width="1060" height="560" rx="42" fill="rgba(255,255,255,0.12)" />
      <text x="90" y="140" fill="#ffffff" font-family="Manrope, Arial, sans-serif" font-size="54" font-weight="700">${escapeXml(title)}</text>
      <text x="90" y="210" fill="#f5efff" font-family="Manrope, Arial, sans-serif" font-size="26" font-weight="500">Ruang Sosmed Learning Center</text>
    </svg>
  `;

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function resolveLessonMedia(rawUrl: string): { kind: 'youtube'; embedUrl: string } | { kind: 'video'; url: string } | { kind: 'unsupported' } {
  const trimmed = normalizeMediaUrl(rawUrl.trim());

  if (!trimmed) {
    return { kind: 'unsupported' };
  }

  const youtubeId = extractYoutubeId(trimmed);
  if (youtubeId) {
    return { kind: 'youtube', embedUrl: `https://www.youtube.com/embed/${youtubeId}?rel=0&modestbranding=1&mute=0`, videoId: youtubeId };
  }

  if (/\.(mp4|webm|ogg)(\?.*)?$/i.test(trimmed) || /^https?:\/\//i.test(trimmed)) {
    return { kind: 'video', url: trimmed };
  }

  return { kind: 'unsupported' };
}

function normalizeMediaUrl(value: string) {
  if (!value) return value;
  if (/^(https?:)?\/\//i.test(value)) {
    return value.startsWith('//') ? `https:${value}` : value;
  }

  if (/^(www\.)?(youtube\.com|youtu\.be)\//i.test(value)) {
    return `https://${value}`;
  }

  return value;
}

function extractYoutubeId(url: string) {
  const directMatch = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{6,})/i);
  if (directMatch?.[1]) {
    return directMatch[1];
  }

  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.hostname.includes('youtu.be')) {
      return parsedUrl.pathname.split('/').filter(Boolean)[0] ?? null;
    }

    if (parsedUrl.hostname.includes('youtube.com')) {
      const directId = parsedUrl.searchParams.get('v');
      if (directId) {
        return directId;
      }

      const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
      const embedIndex = pathParts.findIndex((part) => part === 'embed' || part === 'shorts');
      if (embedIndex >= 0 && pathParts[embedIndex + 1]) {
        return pathParts[embedIndex + 1];
      }
    }
  } catch {
    return null;
  }

  return null;
}

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

// ── Asset Manager ────────────────────────────────────────────

type SharedAsset = {
  id: string;
  title: string;
  description: string;
  category: string;
  url: string;
  type: string;
  sort_order: number;
  thumbnail_url: string | null;
  coin_cost: number;
  feature_claimable?: boolean;
  created_at: string;
};

type SharedAssetDraft = {
  title: string;
  description: string;
  category: string;
  url: string;
  type: string;
  thumbnail_url: string | null;
  coin_cost: number;
  feature_claimable: boolean;
};

const assetTypeOptions = ['link', 'pdf', 'sheet', 'zip', 'video', 'doc', 'lainnya'];
const assetCategoryOptions = ['template', 'referensi', 'modul', 'tool', 'lainnya'];

function createEmptyAssetDraft(): SharedAssetDraft {
  return { title: '', description: '', category: 'template', url: '', type: 'link', thumbnail_url: null, coin_cost: 10, feature_claimable: true };
}

// ─── Events ───────────────────────────────────────────────────────────────────

type HubEventRecurrence = 'none' | 'weekly' | 'monthly_date' | 'monthly_weekday';

type HubEvent = {
  id: string;
  title: string;
  description?: string;
  date: string;
  time?: string;
  type: 'zoom' | 'video' | 'other';
  link?: string;
  coinCost: number;
  isActive?: boolean;
  coverUrl?: string;
  recurrence?: HubEventRecurrence;
  recurrenceGroupId?: string;
};

const hubEventsKey = 'hub_events';

async function loadHubEvents(): Promise<HubEvent[]> {
  const { data } = await supabase.from('learning_hub_content').select('content').eq('content_key', hubEventsKey).maybeSingle();
  if (!data?.content) return [];
  const raw = typeof data.content === 'string' ? JSON.parse(data.content) : data.content;
  return Array.isArray(raw) ? raw : [];
}

async function saveHubEvents(events: HubEvent[]): Promise<void> {
  await supabase.from('learning_hub_content').upsert({ content_key: hubEventsKey, content_group: 'admin', content: events, updated_at: new Date().toISOString() });
}

function EventsPage({ canManage, session, featureCosts, userPerks = {}, onCreditChange, onInsufficientCredits }: {
  canManage: boolean;
  session: AppSession | null;
  featureCosts: FeatureCosts;
  userPerks?: UserPerks;
  onCreditChange: (n: number) => void;
  onInsufficientCredits: (feature: string, needed: number, balance: number) => void;
}) {
  const [events, setEvents] = useState<HubEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [joinTarget, setJoinTarget] = useState<HubEvent | null>(null);
  const [joinLoading, setJoinLoading] = useState(false);
  const [joinError, setJoinError] = useState('');
  const { confirm: confirmDialog, modal: confirmModal } = useConfirm();
  const [adminTab, setAdminTab] = useState<'events' | 'peserta'>('events');
  const [participants, setParticipants] = useState<Array<{ event_id: string; username: string; display_name: string | null; event_title: string | null; event_date: string | null; joined_at: string }>>([]);
  const [participantsLoading, setParticipantsLoading] = useState(false);

  const loadParticipants = async () => {
    setParticipantsLoading(true);
    const { data } = await supabase.from('event_participants').select('*').order('joined_at', { ascending: false });
    setParticipants((data ?? []) as typeof participants);
    setParticipantsLoading(false);
  };

  useEffect(() => {
    if (canManage && adminTab === 'peserta') void loadParticipants();
  }, [canManage, adminTab]);

  const emptyDraft = (): Omit<HubEvent, 'id'> => ({ title: '', description: '', date: '', time: '', type: 'zoom', link: '', coinCost: featureCosts.join_event, isActive: true, coverUrl: '', recurrence: 'none', recurrenceGroupId: undefined });
  const [draft, setDraft] = useState<Omit<HubEvent, 'id'>>(emptyDraft());
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string>('');

  const joinedKey = (id: string) => `event_joined_${session?.username ?? 'guest'}_${id}`;
  const [joinedIds, setJoinedIds] = useState<Set<string>>(() => new Set());
  const isJoined = (e: HubEvent) => canManage || userPerks.credit_exempt || userPerks.free_event || e.coinCost === 0 || joinedIds.has(e.id) || !!localStorage.getItem(joinedKey(e.id));

  useEffect(() => {
    void loadHubEvents().then((evs) => {
      setEvents(evs);
      setLoading(false);
      // Handoff dari halaman Kalender: buka edit event yang diklik.
      if (canManage) {
        const editId = sessionStorage.getItem('edit_hub_event_id');
        if (editId) {
          sessionStorage.removeItem('edit_hub_event_id');
          const idx = evs.findIndex((e) => e.id === editId);
          if (idx >= 0) {
            const { id: _id, ...rest } = evs[idx];
            setDraft(rest);
            setEditingIdx(idx);
            setCoverFile(null);
            setCoverPreview(rest.coverUrl ?? '');
            setShowForm(true);
          }
        }
      }
    });
  }, []);

  const openAdd = () => { setDraft(emptyDraft()); setEditingIdx(null); setCoverFile(null); setCoverPreview(''); setShowForm(true); };
  const openEdit = (idx: number) => { const { id: _id, ...rest } = events[idx]; setDraft(rest); setEditingIdx(idx); setCoverFile(null); setCoverPreview(rest.coverUrl ?? ''); setShowForm(true); };

  const generateRecurringDates = (baseDate: string, recurrence: HubEventRecurrence, count = 12): string[] => {
    const dates: string[] = [];
    const base = new Date(`${baseDate}T12:00:00`);
    if (recurrence === 'none') return [baseDate];
    for (let i = 0; i < count; i++) {
      const d = new Date(base);
      if (recurrence === 'weekly') {
        d.setDate(base.getDate() + i * 7);
      } else if (recurrence === 'monthly_date') {
        d.setMonth(base.getMonth() + i);
      } else if (recurrence === 'monthly_weekday') {
        // same weekday of the same week-of-month, each month
        const weekOfMonth = Math.floor((base.getDate() - 1) / 7);
        const targetDay = base.getDay();
        d.setMonth(base.getMonth() + i);
        d.setDate(1);
        const firstDay = d.getDay();
        let offset = targetDay - firstDay;
        if (offset < 0) offset += 7;
        d.setDate(1 + offset + weekOfMonth * 7);
        // if overflows month, go back a week
        if (d.getMonth() !== (base.getMonth() + i) % 12) d.setDate(d.getDate() - 7);
      }
      dates.push(d.toISOString().slice(0, 10));
    }
    return dates;
  };

  const handleSave = async () => {
    if (!draft.title.trim() || !draft.date) return;
    setSaving(true);
    let finalDraft = { ...draft };
    if (coverFile) {
      const coverUp = await compressImage(coverFile, 1280, 0.82);
      const ext = coverUp.name.split('.').pop() ?? 'jpg';
      const path = `event-covers/evt_${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from('lesson-assets').upload(path, coverUp, { upsert: true, contentType: coverUp.type });
      if (!error) finalDraft = { ...finalDraft, coverUrl: supabase.storage.from('lesson-assets').getPublicUrl(path).data.publicUrl };
    }
    let updated: HubEvent[];
    if (editingIdx !== null) {
      updated = events.map((e, i) => i === editingIdx ? { ...e, ...finalDraft } : e);
    } else {
      const recurrence = finalDraft.recurrence ?? 'none';
      if (recurrence === 'none') {
        updated = [...events, { ...finalDraft, id: `evt_${Date.now()}` }];
      } else {
        const groupId = `grp_${Date.now()}`;
        const dates = generateRecurringDates(finalDraft.date, recurrence);
        const newEvents: HubEvent[] = dates.map((d, i) => ({
          ...finalDraft,
          id: `evt_${Date.now()}_${i}`,
          date: d,
          recurrenceGroupId: groupId,
        }));
        updated = [...events, ...newEvents];
      }
    }
    await saveHubEvents(updated);
    setEvents(updated);
    setCoverFile(null);
    setShowForm(false);
    setSaving(false);
  };

  const handleDelete = async (idx: number) => {
    const updated = events.filter((_, i) => i !== idx);
    await saveHubEvents(updated);
    setEvents(updated);
  };

  const handleDeleteGroup = async (groupId: string) => {
    const updated = events.filter((e) => e.recurrenceGroupId !== groupId);
    await saveHubEvents(updated);
    setEvents(updated);
  };

  const handleJoin = async () => {
    if (!joinTarget || !session) return;
    setJoinLoading(true);
    setJoinError('');
    const isFree = userPerks.credit_exempt || userPerks.free_event || joinTarget.coinCost === 0;
    if (!isFree) {
      const cost = joinTarget.coinCost;
      const res = await deductCredits(session.username, cost, `Join event: ${joinTarget.title}`, 'join_event');
      if (!res.ok) {
        onInsufficientCredits('Join Event', res.needed ?? cost, res.balance ?? 0);
        setJoinTarget(null);
        setJoinLoading(false);
        return;
      }
      if (res.newBalance !== undefined) onCreditChange(res.newBalance);
    }
    localStorage.setItem(joinedKey(joinTarget.id), '1');
    setJoinedIds((prev) => new Set([...prev, joinTarget.id]));
    // Catat peserta ke database agar admin bisa melihat siapa saja yang ikut
    void supabase.from('event_participants').upsert({
      event_id: joinTarget.id,
      username: session.username,
      display_name: session.displayName,
      event_title: joinTarget.title,
      event_date: joinTarget.date,
    }, { onConflict: 'event_id,username' });
    void sendTelegram(`🎫 <b>User Baru Join Event</b>\n\n👤 @${session.username}\n🎯 Event: ${joinTarget.title}\n🗓 Tanggal: ${joinTarget.date}${joinTarget.time ? ` pukul ${joinTarget.time.slice(0, 5)}` : ''}\n💰 Biaya: ${joinTarget.coinCost === 0 ? 'Gratis' : `${joinTarget.coinCost} Ruang Coin`}`);
    // Schedule Telegram reminders for user (H-1, H-3 jam, H-30 menit)
    void scheduleEventReminders(session.username, joinTarget);
    setJoinTarget(null);
    setJoinLoading(false);
  };

  const typeLabel: Record<HubEvent['type'], string> = { zoom: 'Zoom', video: 'Video Kelas', other: 'Lainnya' };
  const typeIcon: Record<HubEvent['type'], string> = { zoom: '📹', video: '🎬', other: '📌' };

  const now = new Date();
  const activeEvents = events.filter((e) => e.isActive !== false);
  const upcoming = activeEvents.filter((e) => new Date(`${e.date}T${e.time || '23:59'}`) >= now).sort((a, b) => a.date.localeCompare(b.date));
  const past = activeEvents.filter((e) => new Date(`${e.date}T${e.time || '23:59'}`) < now).sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div className="events-page">
      {confirmModal}
      <div className="events-header">
        <div>
          <h2 className="events-title">Events & Kelas</h2>
          <p className="events-sub">Zoom rutin, video kelas, dan sesi khusus.</p>
        </div>
        {canManage && (
          <button className="button primary" onClick={openAdd}>+ Tambah Event</button>
        )}
      </div>

      {canManage && (
        <div className="events-admin-tabs">
          <button type="button" className={`events-admin-tab${adminTab === 'events' ? ' active' : ''}`} onClick={() => setAdminTab('events')}>Daftar Event</button>
          <button type="button" className={`events-admin-tab${adminTab === 'peserta' ? ' active' : ''}`} onClick={() => setAdminTab('peserta')}>Peserta Event</button>
        </div>
      )}

      {loading ? (
        <div className="events-loading">Memuat event…</div>
      ) : canManage && adminTab === 'peserta' ? (
        <div className="events-participants">
          {participantsLoading ? (
            <div className="events-loading">Memuat peserta…</div>
          ) : (() => {
            // Kelompokkan peserta per event
            const groups = new Map<string, { title: string; date: string; rows: typeof participants }>();
            for (const p of participants) {
              const key = p.event_id;
              if (!groups.has(key)) groups.set(key, { title: p.event_title || 'Event', date: p.event_date || '', rows: [] });
              groups.get(key)!.rows.push(p);
            }
            const groupList = [...groups.values()].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
            if (groupList.length === 0) return <div className="events-empty">Belum ada peserta yang bergabung ke event manapun.</div>;
            return groupList.map((g, i) => (
              <div className="event-participants-group" key={i}>
                <div className="event-participants-head">
                  <div>
                    <strong className="event-participants-title">{g.title}</strong>
                    {g.date && <span className="event-participants-date">📅 {new Date(g.date).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>}
                  </div>
                  <span className="event-participants-count">{g.rows.length} peserta</span>
                </div>
                <div className="event-participants-list">
                  {g.rows.map((p, j) => (
                    <div className="event-participant-row" key={j}>
                      <div className="event-participant-info">
                        <strong>{p.display_name || p.username}</strong>
                        <span className="event-participant-username">@{p.username}</span>
                      </div>
                      <span className="event-participant-time">{new Date(p.joined_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                  ))}
                </div>
              </div>
            ));
          })()}
        </div>
      ) : (
        <>
          {canManage && events.length > 0 && (
                <div className="events-list">
                  {events.map((ev, idx) => (
                    <div key={ev.id} className={`events-list-card${ev.isActive === false ? ' inactive' : ''}`}>
                      <div className={`events-list-cover type-${ev.type}`}>
                        {ev.coverUrl
                          ? <img src={ev.coverUrl} alt={ev.title} />
                          : <span className="events-list-cover-ph">{typeIcon[ev.type]}</span>}
                      </div>
                      <div className="events-list-body">
                        <div className="events-list-title-row">
                          <strong className="events-list-title">{ev.title}</strong>
                          {ev.recurrenceGroupId && <span className="event-recurrence-badge">🔁 berulang</span>}
                          <span className={`admin-status-badge ${ev.isActive === false ? 'inactive' : 'active'}`}>{ev.isActive === false ? 'Nonaktif' : 'Aktif'}</span>
                        </div>
                        <div className="events-list-meta">
                          <span>{typeIcon[ev.type]} {typeLabel[ev.type]}</span>
                          <span>📅 {new Date(ev.date).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}{ev.time && ` · ${ev.time}`}</span>
                          <span>{ev.coinCost === 0 ? <span className="events-free-badge">Gratis</span> : <span className="admin-credits-cell"><CoinIcon size={12} /> {ev.coinCost}</span>}</span>
                        </div>
                        {ev.description && <p className="events-list-desc">{ev.description}</p>}
                      </div>
                      <div className="events-list-actions">
                        <button type="button" className="admin-action-btn" onClick={() => openEdit(idx)}>edit</button>
                        <button type="button" className="admin-action-btn danger" onClick={() => void confirmDialog('Hapus event ini? Tindakan tidak bisa dibatalkan.').then((ok) => { if (ok) void handleDelete(idx); })}>hapus</button>
                        {ev.recurrenceGroupId && (
                          <button type="button" className="admin-action-btn danger" onClick={() => void confirmDialog(`Hapus semua event berulang dalam grup ini? (${events.filter((e) => e.recurrenceGroupId === ev.recurrenceGroupId).length} event)`).then((ok) => { if (ok) void handleDeleteGroup(ev.recurrenceGroupId!); })} style={{ whiteSpace: 'nowrap' }}>hapus semua</button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
          )}

          {!canManage && upcoming.length > 0 && (() => {
            const joinedUpcoming = upcoming.filter((ev) => isJoined(ev));
            const openUpcoming = upcoming.filter((ev) => !isJoined(ev));
            const renderCard = (ev: CalendarEvent) => {
              const joined = isJoined(ev);
              return (
                <div key={ev.id} className={`event-card${joined ? ' joined' : ''}`}>
                  {ev.coverUrl && <img src={ev.coverUrl} alt={ev.title} className="event-card-cover" />}
                  <div className="event-card-type-row">
                    <span className="event-card-type">{typeIcon[ev.type]} {typeLabel[ev.type]}</span>
                    {joined && <span className="event-joined-badge">✓ Terdaftar</span>}
                  </div>
                  <h4 className="event-card-title">{ev.title}</h4>
                  {ev.description && <p className="event-card-desc">{ev.description}</p>}
                  <div className="event-card-date">
                    📅 {new Date(ev.date).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                    {ev.time && <> · 🕐 {ev.time}</>}
                  </div>
                  <span className={`event-link-capsule${ev.link ? ' available' : ' pending'}`}>
                    {ev.link
                      ? <><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> Link Tersedia</>
                      : <><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> Link Menyusul</>}
                  </span>
                  <div className="event-card-footer">
                    {joined ? (
                      ev.link
                        ? <a href={ev.link} target="_blank" rel="noopener noreferrer" className="button primary event-join-btn">🔗 Buka Link</a>
                        : <span className="event-joined-label">✓ Terdaftar — link menyusul</span>
                    ) : (
                      <button
                        className="button primary event-join-btn"
                        onClick={() => { setJoinTarget(ev); setJoinError(''); }}
                      >
                        {ev.coinCost === 0 || userPerks.credit_exempt || userPerks.free_event
                          ? 'Ikut Gratis'
                          : <><span>Ikut · </span><CoinIcon size={12} />{ev.coinCost}</>}
                      </button>
                    )}
                  </div>
                </div>
              );
            };
            return (
              <>
                {joinedUpcoming.length > 0 && (
                  <div className="events-section">
                    <div className="events-section-title-row">
                      <h3 className="events-section-title">Sudah Diikuti</h3>
                      <span className="events-section-badge">{joinedUpcoming.length} event</span>
                    </div>
                    <div className="events-grid">
                      {joinedUpcoming.map(renderCard)}
                    </div>
                  </div>
                )}
                {openUpcoming.length > 0 && (
                  <div className="events-section">
                    <div className="events-section-title-row">
                      <h3 className="events-section-title">Upcoming</h3>
                      {joinedUpcoming.length > 0 && <span className="events-section-badge events-section-badge--muted">{openUpcoming.length} event</span>}
                    </div>
                    <div className="events-grid">
                      {openUpcoming.map(renderCard)}
                    </div>
                  </div>
                )}
              </>
            );
          })()}

          {!canManage && past.length > 0 && (
            <div className="events-section">
              <h3 className="events-section-title" style={{ color: 'var(--muted)' }}>Sudah Berlalu</h3>
              <div className="events-grid past">
                {past.map((ev) => {
                  const joined = isJoined(ev);
                  return (
                    <div key={ev.id} className="event-card past">
                      {ev.coverUrl && <img src={ev.coverUrl} alt={ev.title} className="event-card-cover" />}
                      <div className="event-card-type-row">
                        <span className="event-card-type">{typeIcon[ev.type]} {typeLabel[ev.type]}</span>
                        <span className="event-past-badge">Sudah Berlalu</span>
                      </div>
                      <h4 className="event-card-title">{ev.title}</h4>
                      {ev.description && <p className="event-card-desc">{ev.description}</p>}
                      <div className="event-card-date">
                        📅 {new Date(ev.date).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                        {ev.time && <> · {ev.time}</>}
                      </div>
                      <div className="event-card-footer">
                        {joined && ev.link
                          ? <a href={ev.link} target="_blank" rel="noopener noreferrer" className="button secondary event-join-btn">🔗 Rekaman / Link</a>
                          : <span className="event-past-label">Tidak ada rekaman</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {upcoming.length === 0 && past.length === 0 && (
            <div className="events-empty">
              <span>🎥</span>
              <p>Belum ada event yang dijadwalkan.</p>
              {canManage && <button className="button primary" onClick={openAdd}>Tambah Event Pertama</button>}
            </div>
          )}
        </>
      )}

      {/* Join confirm modal */}
      {joinTarget && createPortal(
        <div className="admin-modal-overlay" onClick={() => { setJoinTarget(null); setJoinError(''); }}>
          <div className="admin-modal" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
            <h3 className="admin-modal-title">Ikut Event</h3>
            <div style={{ padding: '0 0 16px' }}>
              <p style={{ fontWeight: 700, fontSize: '1rem', marginBottom: 6 }}>{joinTarget.title}</p>
              <p style={{ color: 'var(--muted)', fontSize: '0.88rem', marginBottom: 16 }}>
                📅 {new Date(joinTarget.date).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long' })}
                {joinTarget.time && ` · ${joinTarget.time}`}
              </p>
              {joinTarget.coinCost > 0 && !userPerks.credit_exempt && !userPerks.free_event ? (
                <p style={{ fontSize: '0.9rem' }}>Biaya akses: <strong><CoinIcon size={13} /> {joinTarget.coinCost} Ruang Coin</strong></p>
              ) : (
                <p style={{ fontSize: '0.9rem', color: '#22a35a' }}>✓ Akses gratis untukmu</p>
              )}
              {joinError && <p className="field-error" style={{ marginTop: 8 }}>{joinError}</p>}
            </div>
            <div className="admin-modal-actions">
              <button type="button" className="admin-modal-cancel" onClick={() => { setJoinTarget(null); setJoinError(''); }}>Batal</button>
              <button type="button" className="admin-modal-submit" disabled={joinLoading} onClick={() => void handleJoin()}>
                {joinLoading ? 'Memproses…' : 'Konfirmasi'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Add/Edit form modal */}
      {showForm && canManage && createPortal(
        <div className="admin-modal-overlay" onClick={() => setShowForm(false)}>
          <div className="event-edit-modal" onClick={(e) => e.stopPropagation()}>
            <div className="event-edit-left">
              <h3 className="admin-modal-title">{editingIdx !== null ? 'Edit Event' : 'Tambah Event'}</h3>
              <div className="admin-modal-form">
                <label>Judul Event
                  <input className="admin-modal-input" value={draft.title} onChange={(e) => setDraft((p) => ({ ...p, title: e.target.value }))} placeholder="contoh: Zoom Mingguan #12" />
                </label>
                <label>Deskripsi <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: '0.8rem' }}>(opsional)</span>
                  <input className="admin-modal-input" value={draft.description ?? ''} onChange={(e) => setDraft((p) => ({ ...p, description: e.target.value }))} placeholder="Topik, materi, atau info singkat" />
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <label>Tanggal
                    <input className="admin-modal-input" type="date" value={draft.date} onChange={(e) => setDraft((p) => ({ ...p, date: e.target.value }))} />
                  </label>
                  <label>Jam <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: '0.8rem' }}>(opsional)</span>
                    <input className="admin-modal-input" type="time" value={draft.time ?? ''} onChange={(e) => setDraft((p) => ({ ...p, time: e.target.value }))} />
                  </label>
                </div>
                {editingIdx === null && (
                  <div className="event-recurrence-wrap">
                    <label className="event-recurrence-toggle">
                      <input
                        type="checkbox"
                        checked={(draft.recurrence ?? 'none') !== 'none'}
                        onChange={(e) => setDraft((p) => ({ ...p, recurrence: e.target.checked ? 'weekly' : 'none' }))}
                      />
                      <span>Jadwal Berulang</span>
                    </label>
                    {(draft.recurrence ?? 'none') !== 'none' && (
                      <div className="event-recurrence-options">
                        <label className="event-recurrence-radio">
                          <input type="radio" name="recurrence" value="weekly" checked={draft.recurrence === 'weekly'} onChange={() => setDraft((p) => ({ ...p, recurrence: 'weekly' }))} />
                          <span>Setiap minggu (hari yang sama)</span>
                        </label>
                        <label className="event-recurrence-radio">
                          <input type="radio" name="recurrence" value="monthly_date" checked={draft.recurrence === 'monthly_date'} onChange={() => setDraft((p) => ({ ...p, recurrence: 'monthly_date' }))} />
                          <span>Setiap bulan (tanggal yang sama)</span>
                        </label>
                        <label className="event-recurrence-radio">
                          <input type="radio" name="recurrence" value="monthly_weekday" checked={draft.recurrence === 'monthly_weekday'} onChange={() => setDraft((p) => ({ ...p, recurrence: 'monthly_weekday' }))} />
                          <span>Setiap bulan (hari yang sama di minggu yang sama)</span>
                        </label>
                        {draft.date && (
                          <p className="event-recurrence-preview">
                            {draft.recurrence === 'weekly' && `Akan dibuat 12 event, setiap hari ${new Date(`${draft.date}T12:00:00`).toLocaleDateString('id-ID', { weekday: 'long' })}`}
                            {draft.recurrence === 'monthly_date' && `Akan dibuat 12 event, setiap tanggal ${new Date(`${draft.date}T12:00:00`).getDate()} tiap bulan`}
                            {draft.recurrence === 'monthly_weekday' && (() => {
                              const d = new Date(`${draft.date}T12:00:00`);
                              const weekNum = Math.floor((d.getDate() - 1) / 7) + 1;
                              const dayName = d.toLocaleDateString('id-ID', { weekday: 'long' });
                              return `Akan dibuat 12 event, setiap ${dayName} minggu ke-${weekNum} tiap bulan`;
                            })()}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
                <label>Tipe Event
                  <select className="admin-modal-input" value={draft.type} onChange={(e) => setDraft((p) => ({ ...p, type: e.target.value as HubEvent['type'] }))}>
                    <option value="zoom">📹 Zoom / Live Session</option>
                    <option value="video">🎬 Video Kelas</option>
                    <option value="other">📌 Lainnya</option>
                  </select>
                </label>
                <label>Link <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: '0.8rem' }}>(opsional — bisa diisi setelah event)</span>
                  <input className="admin-modal-input" value={draft.link ?? ''} onChange={(e) => setDraft((p) => ({ ...p, link: e.target.value }))} placeholder="https://zoom.us/j/... atau link video" />
                </label>
                <label>Biaya (Ruang Coin) <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: '0.8rem' }}>(0 = gratis)</span>
                  <input className="admin-modal-input" type="number" min="0" value={draft.coinCost} onChange={(e) => setDraft((p) => ({ ...p, coinCost: parseInt(e.target.value, 10) || 0 }))} />
                  <span className="coin-rupiah-hint">{draft.coinCost === 0 ? 'Gratis' : `≈ ${formatRupiah(draft.coinCost * CREDIT_RATE)}`}</span>
                </label>
                <label className="referral-feature-check-row" style={{ fontWeight: 600 }}>
                  <input type="checkbox" checked={draft.isActive !== false} onChange={(e) => setDraft((p) => ({ ...p, isActive: e.target.checked }))} />
                  <span>Tampilkan ke member</span>
                </label>
                <div className="admin-modal-actions">
                  {editingIdx !== null && (
                    <button type="button" className="admin-modal-delete" onClick={() => void confirmDialog('Hapus event ini? Tindakan tidak bisa dibatalkan.').then((ok) => { if (ok) { void handleDelete(editingIdx); setShowForm(false); } })}>
                      Hapus Event
                    </button>
                  )}
                  <button type="button" className="admin-modal-cancel" onClick={() => setShowForm(false)}>Batal</button>
                  <button type="button" className="admin-modal-submit" disabled={saving || !draft.title.trim() || !draft.date} onClick={() => void handleSave()}>
                    {saving ? 'Menyimpan…' : editingIdx !== null ? 'Simpan Perubahan' : 'Tambah Event'}
                  </button>
                </div>
              </div>
            </div>
            <div className="event-edit-right">
              <p className="event-cover-label">Cover Event</p>
              <div className="event-cover-upload-wrap">
                {coverPreview
                  ? <img src={coverPreview} alt="cover" className="event-cover-preview" />
                  : <div className="event-cover-placeholder">🖼<span>Belum ada cover</span></div>}
                <label className="event-cover-upload-btn">
                  {coverPreview ? 'Ganti Cover' : 'Upload Cover'}
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      setCoverFile(f);
                      setCoverPreview(URL.createObjectURL(f));
                    }}
                  />
                </label>
                {coverPreview && (
                  <button type="button" className="event-cover-remove-btn" onClick={() => { setCoverFile(null); setCoverPreview(''); setDraft((p) => ({ ...p, coverUrl: '' })); }}>Hapus</button>
                )}
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// ─── Asset Manager ─────────────────────────────────────────────────────────────

function AssetManagerPage({ canEdit, session, userPerks }: { canEdit: boolean; session: AppSession | null; userPerks?: UserPerks }) {
  const [assets, setAssets] = useState<SharedAsset[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingAsset, setEditingAsset] = useState<SharedAsset | null>(null);
  const [draft, setDraft] = useState<SharedAssetDraft>(createEmptyAssetDraft());
  const [isSaving, setIsSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SharedAsset | null>(null);
  const [thumbFile, setThumbFile] = useState<File | null>(null);
  const [thumbPreview, setThumbPreview] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState('semua');
  const [unlockTarget, setUnlockTarget] = useState<SharedAsset | null>(null);
  const [unlockError, setUnlockError] = useState('');
  const [unlockLoading, setUnlockLoading] = useState(false);

  const [unlockedIds, setUnlockedIds] = useState<Set<string>>(new Set());

  const isUnlocked = (asset: SharedAsset) =>
    canEdit || asset.coin_cost === 0 || userPerks?.credit_exempt || (userPerks?.free_asset && asset.feature_claimable !== false) || unlockedIds.has(asset.id);

  const handleUnlock = async () => {
    if (!unlockTarget || !session) return;
    setUnlockLoading(true);
    setUnlockError('');
    const cost = unlockTarget.coin_cost ?? 10;
    const result = await deductCredits(session.username, cost, `Buka asset: ${unlockTarget.title}`, 'usage');
    if (result.ok) {
      await supabase.from('user_asset_unlocks').upsert({ username: session.username, asset_id: unlockTarget.id });
      setUnlockedIds(prev => new Set([...prev, unlockTarget.id]));
      setUnlockTarget(null);
    } else {
      setUnlockError(`Ruang Coin tidak cukup. Kamu punya ${result.balance ?? 0} coin, butuh ${cost} coin.`);
    }
    setUnlockLoading(false);
  };

  const loadAssets = async () => {
    setIsLoading(true);
    const [{ data, error }, { data: unlockRows }] = await Promise.all([
      supabase.from('shared_assets').select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: false }),
      session ? supabase.from('user_asset_unlocks').select('asset_id').eq('username', session.username) : Promise.resolve({ data: [] }),
    ]);
    if (error) {
      console.error('shared_assets load error:', error);
    } else {
      setAssets((data ?? []) as SharedAsset[]);
    }
    setUnlockedIds(new Set((unlockRows ?? []).map((r: { asset_id: string }) => r.asset_id)));
    setIsLoading(false);
  };

  useEffect(() => {
    void loadAssets();
  }, []);

  const openCreate = () => {
    setEditingAsset(null);
    setDraft(createEmptyAssetDraft());
    setThumbFile(null);
    setThumbPreview(null);
    setModalOpen(true);
  };

  const openEdit = (asset: SharedAsset) => {
    setEditingAsset(asset);
    setDraft({ title: asset.title, description: asset.description, category: asset.category, url: asset.url, type: asset.type, thumbnail_url: asset.thumbnail_url, coin_cost: asset.coin_cost ?? 10, feature_claimable: asset.feature_claimable !== false });
    setThumbFile(null);
    setThumbPreview(asset.thumbnail_url ?? null);
    setModalOpen(true);
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.title.trim() || !draft.url.trim()) return;
    setIsSaving(true);

    // Upload thumbnail if a new file was selected
    let thumbnailUrl = draft.thumbnail_url;
    if (thumbFile) {
      const up = await compressImage(thumbFile, 1000, 0.82);
      const ext = up.name.split('.').pop() ?? 'jpg';
      const path = `shared-asset-thumbs/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from('lesson-assets').upload(path, up, { upsert: true, contentType: up.type });
      if (!upErr) thumbnailUrl = supabase.storage.from('lesson-assets').getPublicUrl(path).data.publicUrl;
      else console.error('thumbnail upload error:', upErr);
    }

    if (editingAsset) {
      const { error } = await supabase.from('shared_assets').update({
        title: draft.title.trim(),
        description: draft.description.trim(),
        category: draft.category,
        url: draft.url.trim(),
        type: draft.type,
        thumbnail_url: thumbnailUrl,
        coin_cost: draft.coin_cost,
        feature_claimable: draft.feature_claimable,
      }).eq('id', editingAsset.id);
      if (error) console.error('shared_assets update error:', error);
    } else {
      const maxOrder = assets.reduce((max, a) => Math.max(max, a.sort_order), 0);
      const { error } = await supabase.from('shared_assets').insert({
        title: draft.title.trim(),
        description: draft.description.trim(),
        category: draft.category,
        url: draft.url.trim(),
        type: draft.type,
        sort_order: maxOrder + 1,
        thumbnail_url: thumbnailUrl,
        coin_cost: draft.coin_cost,
        feature_claimable: draft.feature_claimable,
      });
      if (error) console.error('shared_assets insert error:', error);
    }

    setIsSaving(false);
    setModalOpen(false);
    void loadAssets();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await supabase.from('shared_assets').delete().eq('id', deleteTarget.id);
    setDeleteTarget(null);
    void loadAssets();
  };

  const allCategories = ['semua', ...assetCategoryOptions];
  const filtered = assets.filter((a) => {
    const matchSearch = !searchQuery || a.title.toLowerCase().includes(searchQuery.toLowerCase()) || a.description.toLowerCase().includes(searchQuery.toLowerCase());
    const matchCat = filterCategory === 'semua' || a.category === filterCategory;
    return matchSearch && matchCat;
  });

  const typeIcon: Record<string, string> = {
    pdf: '📄', sheet: '📊', zip: '📦', video: '🎬', doc: '📝', link: '🔗', lainnya: '📎',
  };

  return (
    <section className="asset-manager-page card" id="assets">
      <div className="section-head">
        <div>
          <p className="eyebrow">asset manager</p>
          <h3>file &amp; resource yang dibagikan</h3>
        </div>
        {canEdit && (
          <button type="button" className="button primary tiny" onClick={openCreate}>+ tambah asset</button>
        )}
      </div>

      <div className="asset-manager-filters">
        <input
          className="asset-manager-search"
          type="search"
          placeholder="cari asset..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <div className="asset-manager-cats">
          {allCategories.map((cat) => (
            <button
              key={cat}
              type="button"
              className={`tag ${filterCategory === cat ? 'active' : ''}`}
              onClick={() => setFilterCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <p className="asset-manager-empty">memuat asset…</p>
      ) : filtered.length === 0 ? (
        <p className="asset-manager-empty">{assets.length === 0 ? 'belum ada asset yang ditambahkan.' : 'tidak ada asset yang cocok.'}</p>
      ) : (
        <>
          {(() => {
            const unlockedFiltered = filtered.filter((a) => isUnlocked(a));
            const lockedFiltered = filtered.filter((a) => !isUnlocked(a));
            return (
              <>
                {unlockedFiltered.length > 0 && (
                  <>
                    <div className="asset-manager-section-head">
                      <span className="asset-manager-section-label asset-manager-section-label--unlocked">✓ Sudah Dibuka</span>
                      <span className="asset-manager-section-count">{unlockedFiltered.length} asset</span>
                    </div>
                    <div className="asset-manager-grid">
                      {unlockedFiltered.map((asset) => (
                        <div className="asset-manager-card" key={asset.id}>
                          {asset.thumbnail_url && (
                            <div className="asset-manager-thumb">
                              <img src={asset.thumbnail_url} alt={asset.title} />
                            </div>
                          )}
                          <div className="asset-manager-card-top">
                            <span className="asset-manager-type-icon">{typeIcon[asset.type] ?? '📎'}</span>
                            <span className="tag">{asset.category}</span>
                            {canEdit && asset.feature_claimable === false && <span className="asset-nofeature-badge" title="Voucher fitur gratis tidak berlaku — hanya bisa dibuka dengan Ruang Coin">🔒 non-voucher</span>}
                          </div>
                          <strong className="asset-manager-title">{asset.title}</strong>
                          {asset.description && <p className="asset-manager-desc">{asset.description}</p>}
                          <div className="asset-manager-actions">
                            <a href={asset.url} target="_blank" rel="noopener noreferrer" className="button primary tiny">
                              buka / download
                            </a>
                            {canEdit && (
                              <>
                                <button type="button" className="button secondary tiny" onClick={() => openEdit(asset)}>edit</button>
                                <button type="button" className="button danger tiny" onClick={() => setDeleteTarget(asset)}>hapus</button>
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {lockedFiltered.length > 0 && (
                  <>
                    <div className="asset-manager-section-head">
                      <span className="asset-manager-section-label asset-manager-section-label--locked">🔒 Belum Dibuka</span>
                      <span className="asset-manager-section-count">{lockedFiltered.length} asset</span>
                    </div>
                    <div className="asset-manager-grid">
                      {lockedFiltered.map((asset) => (
                        <div className="asset-manager-card" key={asset.id}>
                          {asset.thumbnail_url && (
                            <div className="asset-manager-thumb">
                              <img src={asset.thumbnail_url} alt={asset.title} />
                              <div className="asset-lock-overlay">
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                              </div>
                            </div>
                          )}
                          <div className="asset-manager-card-top">
                            <span className="asset-manager-type-icon">{typeIcon[asset.type] ?? '📎'}</span>
                            <span className="tag">{asset.category}</span>
                            <span className="asset-coin-badge"><CoinIcon size={12} />{asset.coin_cost ?? 10}</span>
                            {canEdit && asset.feature_claimable === false && <span className="asset-nofeature-badge" title="Voucher fitur gratis tidak berlaku — hanya bisa dibuka dengan Ruang Coin">🔒 non-voucher</span>}
                          </div>
                          <strong className="asset-manager-title">{asset.title}</strong>
                          {asset.description && <p className="asset-manager-desc">{asset.description}</p>}
                          <div className="asset-manager-actions">
                            <button type="button" className="button primary tiny" onClick={() => { setUnlockTarget(asset); setUnlockError(''); }}>
                              🔒 buka ({asset.coin_cost ?? 10} coin)
                            </button>
                            {canEdit && (
                              <>
                                <button type="button" className="button secondary tiny" onClick={() => openEdit(asset)}>edit</button>
                                <button type="button" className="button danger tiny" onClick={() => setDeleteTarget(asset)}>hapus</button>
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            );
          })()}
        </>
      )}

      {modalOpen && createPortal(
        <div className="forum-modal-overlay" onClick={() => setModalOpen(false)}>
          <div className="forum-modal" onClick={(e) => e.stopPropagation()}>
            <div className="forum-modal-header">
              <h3>{editingAsset ? 'edit asset' : 'tambah asset baru'}</h3>
              <button type="button" className="forum-modal-close" onClick={() => setModalOpen(false)}>✕</button>
            </div>
            <form className="asset-manager-form" onSubmit={handleSave}>
              <label className="asset-thumb-upload-label">
                <span>thumbnail (opsional)</span>
                <div
                  className="asset-thumb-upload-zone"
                  onClick={() => document.getElementById('asset-thumb-input')?.click()}
                >
                  {thumbPreview
                    ? <img src={thumbPreview} alt="preview" className="asset-thumb-preview-img" />
                    : <span className="asset-thumb-placeholder">klik untuk upload gambar</span>}
                </div>
                <input
                  id="asset-thumb-input"
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    setThumbFile(f);
                    setThumbPreview(f ? URL.createObjectURL(f) : (draft.thumbnail_url ?? null));
                  }}
                />
              </label>
              <label>
                <span>judul asset</span>
                <input
                  type="text"
                  placeholder="nama file atau resource"
                  value={draft.title}
                  onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                  required
                />
              </label>
              <label>
                <span>deskripsi</span>
                <input
                  type="text"
                  placeholder="keterangan singkat (opsional)"
                  value={draft.description}
                  onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                />
              </label>
              <label>
                <span>URL / link</span>
                <input
                  type="url"
                  placeholder="https://..."
                  value={draft.url}
                  onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
                  required
                />
              </label>
              <div className="asset-manager-form-row">
                <label>
                  <span>tipe</span>
                  <select value={draft.type} onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value }))}>
                    {assetTypeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
                <label>
                  <span>kategori</span>
                  <select value={draft.category} onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}>
                    {assetCategoryOptions.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
              </div>
              <label>
                <span><CoinIcon size={13} /> Ruang Coin untuk membuka <span style={{ fontWeight: 400, color: 'var(--muted)' }}>(0 = gratis)</span></span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={draft.coin_cost}
                  onChange={(e) => setDraft((d) => ({ ...d, coin_cost: Math.max(0, Number(e.target.value)) }))}
                />
                <span className="coin-rupiah-hint">{draft.coin_cost === 0 ? 'Gratis' : `≈ ${formatRupiah(draft.coin_cost * CREDIT_RATE)}`}</span>
              </label>
              <label className="asset-claimable-toggle">
                <input
                  type="checkbox"
                  checked={draft.feature_claimable}
                  onChange={(e) => setDraft((d) => ({ ...d, feature_claimable: e.target.checked }))}
                />
                <span className="asset-claimable-text">
                  <strong>Bisa dibuka dengan voucher fitur gratis</strong>
                  <small>{draft.feature_claimable
                    ? 'User dengan akses "Asset gratis" (dari kode referral/fitur) bisa membuka asset ini tanpa coin.'
                    : 'Asset ini dikunci — voucher fitur gratis tidak berlaku, user tetap harus bayar Ruang Coin.'}</small>
                </span>
              </label>
              <div className="asset-manager-form-actions">
                <button type="button" className="button secondary" onClick={() => setModalOpen(false)}>batal</button>
                <button type="submit" className="button primary" disabled={isSaving}>
                  {isSaving ? 'menyimpan…' : 'simpan'}
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body,
      )}

      {deleteTarget && createPortal(
        <div className="forum-modal-overlay" onClick={() => setDeleteTarget(null)}>
          <div className="forum-modal" onClick={(e) => e.stopPropagation()}>
            <div className="forum-modal-header">
              <h3>hapus asset</h3>
              <button type="button" className="forum-modal-close" onClick={() => setDeleteTarget(null)}>✕</button>
            </div>
            <p style={{ padding: '0 4px 12px' }}>Hapus <strong>{deleteTarget.title}</strong>? Tindakan ini tidak bisa dibatalkan.</p>
            <div className="asset-manager-form-actions">
              <button type="button" className="button secondary" onClick={() => setDeleteTarget(null)}>batal</button>
              <button type="button" className="button danger" onClick={handleDelete}>hapus</button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {unlockTarget && createPortal(
        <div className="forum-modal-overlay" onClick={() => setUnlockTarget(null)}>
          <div className="forum-modal asset-unlock-modal" onClick={(e) => e.stopPropagation()}>
            <div className="forum-modal-header">
              <h3>buka asset</h3>
              <button type="button" className="forum-modal-close" onClick={() => setUnlockTarget(null)}>✕</button>
            </div>
            {unlockTarget.thumbnail_url && (
              <img src={unlockTarget.thumbnail_url} alt="" className="asset-unlock-thumb" />
            )}
            <p className="asset-unlock-title">{unlockTarget.title}</p>
            <p className="asset-unlock-desc">
              Asset ini memerlukan <strong>{unlockTarget.coin_cost ?? 10} Ruang Coin</strong> untuk dibuka.
              Setelah dibuka, kamu bisa mengaksesnya kapan saja tanpa biaya tambahan.
            </p>
            {unlockError && <p className="form-error">{unlockError}</p>}
            <div className="asset-manager-form-actions">
              <button type="button" className="button secondary" onClick={() => setUnlockTarget(null)}>batal</button>
              <button type="button" className="button primary" onClick={handleUnlock} disabled={unlockLoading}>
                {unlockLoading ? 'memproses…' : `pakai ${unlockTarget.coin_cost ?? 10} coin & buka akses`}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </section>
  );
}

// ─── Global Search Modal ────────────────────────────────────────────────────

type SearchResult = {
  type: 'lesson' | 'thread' | 'asset';
  id: string;
  title: string;
  subtitle: string;
  hash: string;
};

function GlobalSearchModal({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    const q = query.toLowerCase();
    setLoading(true);

    void Promise.all([
      supabase.from('lessons').select('lesson_key, title, description').order('sort_order'),
      supabase.from('forum_threads').select('id, title, body, category').order('created_at', { ascending: false }).limit(50),
      supabase.from('shared_assets').select('id, title, description, category').order('sort_order').limit(50),
    ]).then(([{ data: lessons }, { data: threads }, { data: assets }]) => {
      const matched: SearchResult[] = [];

      for (const l of (lessons ?? []) as { lesson_key: string; title: string; description?: string }[]) {
        if (l.title.toLowerCase().includes(q) || (l.description ?? '').toLowerCase().includes(q)) {
          matched.push({ type: 'lesson', id: l.lesson_key, title: l.title, subtitle: 'Learning Center', hash: '#materi' });
        }
      }
      for (const t of (threads ?? []) as { id: string; title: string; body: string; category: string }[]) {
        if (t.title.toLowerCase().includes(q) || t.body.toLowerCase().includes(q)) {
          matched.push({ type: 'thread', id: t.id, title: t.title, subtitle: `QnA · ${t.category}`, hash: `#community` });
        }
      }
      for (const a of (assets ?? []) as { id: string; title: string; description: string; category: string }[]) {
        if (a.title.toLowerCase().includes(q) || a.description.toLowerCase().includes(q)) {
          matched.push({ type: 'asset', id: a.id, title: a.title, subtitle: `Assets · ${a.category}`, hash: '#assets' });
        }
      }

      setResults(matched.slice(0, 12));
      setLoading(false);
    });
  }, [query]);

  const typeIcon: Record<string, string> = { lesson: '📖', thread: '💬', asset: '📁' };

  return createPortal(
    <div className="gsearch-overlay" onClick={onClose}>
      <div className="gsearch-modal" onClick={(e) => e.stopPropagation()}>
        <div className="gsearch-input-row">
          <svg className="gsearch-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            ref={inputRef}
            className="gsearch-input"
            type="text"
            placeholder="Cari materi, diskusi, atau asset…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button type="button" className="gsearch-clear" onClick={() => setQuery('')}>✕</button>
          )}
        </div>

        <div className="gsearch-body">
          {!query && (
            <div className="gsearch-empty">
              <div className="gsearch-empty-icon">🔍</div>
              <p>Ketik untuk mencari di seluruh konten</p>
              <div className="gsearch-hints">
                <span className="gsearch-hint">📖 Materi kelas</span>
                <span className="gsearch-hint">💬 Diskusi QnA</span>
                <span className="gsearch-hint">📁 Assets</span>
              </div>
            </div>
          )}
          {query && loading && <div className="gsearch-loading">Mencari…</div>}
          {query && !loading && results.length === 0 && (
            <div className="gsearch-empty"><p>Tidak ada hasil untuk <strong>"{query}"</strong></p></div>
          )}
          {results.length > 0 && (
            <ul className="gsearch-results">
              {results.map((r) => (
                <li key={`${r.type}-${r.id}`}>
                  <a
                    href={r.hash}
                    className="gsearch-result-item"
                    onClick={onClose}
                  >
                    <span className="gsearch-result-icon">{typeIcon[r.type]}</span>
                    <span className="gsearch-result-text">
                      <span className="gsearch-result-title">{r.title}</span>
                      <span className="gsearch-result-sub">{r.subtitle}</span>
                    </span>
                    <svg className="gsearch-result-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
                    </svg>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="gsearch-footer">
          <span><kbd>↵</kbd> buka</span>
          <span><kbd>Esc</kbd> tutup</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── Onboarding Modal ────────────────────────────────────────────────────────

const ONBOARDING_STEPS = [
  {
    icon: '👋',
    title: 'Selamat datang di Ruang Sosmed Learning Hub!',
    desc: 'Platform belajar sosial media marketing yang lengkap — dari materi, sesi langsung, sampai komunitas diskusi.',
  },
  {
    icon: '📖',
    title: 'Learning Center',
    desc: 'Akses semua materi kelas secara terstruktur. Tandai progres tiap lesson dan selesaikan kuis di akhir.',
  },
  {
    icon: '📅',
    title: 'Calendar & Booking 1:1',
    desc: 'Lihat jadwal kelas, dan booking sesi konsultasi langsung dengan mentor. Semua di satu tempat.',
  },
  {
    icon: '✦',
    title: 'Ruang Coin',
    desc: 'Gunakan Ruang Coin untuk akses fitur premium. Topup kapan saja dari halaman profil kamu.',
  },
];

function OnboardingModal({ username, displayName, onClose }: { username: string; displayName: string; onClose: () => void }) {
  const [step, setStep] = useState(0);
  const isLast = step === ONBOARDING_STEPS.length - 1;
  const s = ONBOARDING_STEPS[step];

  return createPortal(
    <div className="onboard-overlay">
      <div className="onboard-modal">
        <div className="onboard-step-icon">{s.icon}</div>
        <h2 className="onboard-title">{step === 0 ? `Hai, ${displayName}! 👋` : s.title}</h2>
        <p className="onboard-desc">{step === 0 ? ONBOARDING_STEPS[0].desc : s.desc}</p>

        <div className="onboard-dots">
          {ONBOARDING_STEPS.map((_, i) => (
            <button
              key={i}
              type="button"
              className={`onboard-dot${i === step ? ' active' : ''}`}
              onClick={() => setStep(i)}
              aria-label={`step ${i + 1}`}
            />
          ))}
        </div>

        <div className="onboard-actions">
          {!isLast ? (
            <>
              <button type="button" className="onboard-btn-skip" onClick={onClose}>Lewati</button>
              <button type="button" className="onboard-btn-next" onClick={() => setStep((v) => v + 1)}>
                Lanjut →
              </button>
            </>
          ) : (
            <button type="button" className="onboard-btn-done" onClick={onClose}>
              Mulai Belajar 🚀
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default App;
