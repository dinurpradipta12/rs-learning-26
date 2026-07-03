// Cloudflare Pages Function: inject per-thread Open Graph meta tags so that
// sharing a thread link (?thread=<id>) shows a rich preview (title, snippet,
// image) on WhatsApp / Threads / Twitter etc. Scrapers don't run JS, so we
// rewrite the static HTML at the edge before serving.

const SUPABASE_URL = 'https://uvwjopfpwotkmoqmdwjc.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2d2pvcGZwd290a21vcW1kd2pjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE0NDI4NjksImV4cCI6MjA5NzAxODg2OX0.qeacm1-9dS7WhINe1eocQOa_8YRXQ4Wr0tlEHLMtSA0';
const DEFAULT_IMAGE = 'https://ruangsosmedid.com/og-image.png';

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const setContent = (value) => ({ element(el) { el.setAttribute('content', value); } });

function rewriteMeta(response, { title, desc, image, pageUrl }) {
  return new HTMLRewriter()
    .on('title', { element(el) { el.setInnerContent(title); } })
    .on('meta[name="description"]', setContent(desc))
    .on('meta[property="og:title"]', setContent(title))
    .on('meta[property="og:description"]', setContent(desc))
    .on('meta[property="og:image"]', setContent(image))
    .on('meta[property="og:url"]', setContent(pageUrl))
    .on('meta[name="twitter:title"]', setContent(title))
    .on('meta[name="twitter:description"]', setContent(desc))
    .on('meta[name="twitter:image"]', setContent(image))
    .transform(response);
}

export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);
  const threadId = url.searchParams.get('thread');
  const eventId = url.searchParams.get('event');

  const response = await next();
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;

  // ── Preview event (?event=<id>) ──
  if (eventId) {
    let event;
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/learning_hub_content?content_key=eq.hub_events&select=content&limit=1`,
        { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` } },
      );
      const rows = await res.json();
      let content = Array.isArray(rows) && rows[0] ? rows[0].content : null;
      if (typeof content === 'string') content = JSON.parse(content);
      event = Array.isArray(content) ? content.find((e) => e && e.id === eventId) : null;
    } catch {
      return response;
    }
    if (!event) return response;

    let dateStr = event.date || '';
    try { dateStr = new Date(event.date).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); } catch { /* pakai apa adanya */ }
    const title = `${clean(event.title)} — Ruang Sosmed ID`;
    const parts = [];
    if (dateStr) parts.push(`${dateStr}${event.time ? ' · ' + event.time : ''}`);
    if (event.coinCost === 0) parts.push('Gratis'); else if (event.coinCost) parts.push(`${event.coinCost} Ruang Coin`);
    if (event.description) parts.push(clean(event.description).slice(0, 120));
    const desc = parts.join(' · ') || 'Ikut event & kelas di Ruang Sosmed ID';
    const image = event.coverUrl || `https://ruangsosmedid.com/og?event=${encodeURIComponent(eventId)}`;
    const pageUrl = `https://ruangsosmedid.com/?event=${encodeURIComponent(eventId)}`;
    return rewriteMeta(response, { title, desc, image, pageUrl });
  }

  // ── Preview thread (?thread=<id>) ──
  if (!threadId) return response;

  let thread;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/forum_threads?id=eq.${encodeURIComponent(threadId)}&select=title,body,image_url,author_display_name,category&limit=1`,
      { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` } },
    );
    const rows = await res.json();
    thread = Array.isArray(rows) ? rows[0] : null;
  } catch {
    return response;
  }
  if (!thread) return response;

  const title = `${clean(thread.title)} — Ruang Sosmed ID`;
  const bodySnippet = clean(thread.body).slice(0, 160);
  const desc = bodySnippet
    ? `${thread.author_display_name ? thread.author_display_name + ': ' : ''}${bodySnippet}`
    : 'Diskusi di komunitas Ruang Sosmed ID';
  const image = thread.image_url || `https://ruangsosmedid.com/og?thread=${encodeURIComponent(threadId)}`;
  const pageUrl = `https://ruangsosmedid.com/?thread=${encodeURIComponent(threadId)}`;
  return rewriteMeta(response, { title, desc, image, pageUrl });
}
