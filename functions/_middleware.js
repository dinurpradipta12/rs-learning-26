// Cloudflare Pages Function: inject per-thread Open Graph meta tags so that
// sharing a thread link (?thread=<id>) shows a rich preview (title, snippet,
// image) on WhatsApp / Threads / Twitter etc. Scrapers don't run JS, so we
// rewrite the static HTML at the edge before serving.

const SUPABASE_URL = 'https://uvwjopfpwotkmoqmdwjc.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2d2pvcGZwd290a21vcW1kd2pjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE0NDI4NjksImV4cCI6MjA5NzAxODg2OX0.qeacm1-9dS7WhINe1eocQOa_8YRXQ4Wr0tlEHLMtSA0';
const DEFAULT_IMAGE = 'https://ruangsosmedid.com/og-image.png';

export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);
  const threadId = url.searchParams.get('thread');

  const response = await next();
  const contentType = response.headers.get('content-type') || '';
  if (!threadId || !contentType.includes('text/html')) return response;

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

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const title = `${clean(thread.title)} — Ruang Sosmed ID`;
  const bodySnippet = clean(thread.body).slice(0, 160);
  const desc = bodySnippet
    ? `${thread.author_display_name ? thread.author_display_name + ': ' : ''}${bodySnippet}`
    : 'Diskusi di komunitas Ruang Sosmed ID';
  const image = thread.image_url || DEFAULT_IMAGE;
  const pageUrl = `https://ruangsosmedid.com/?thread=${encodeURIComponent(threadId)}`;

  const setContent = (value) => ({ element(el) { el.setAttribute('content', value); } });

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
