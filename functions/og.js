// Cloudflare Pages Function: generate a dynamic PNG preview image for a thread.
// URL: /og?thread=<id>  → returns a 1200x630 PNG with the thread title rendered.
import { ImageResponse } from 'workers-og';

const SUPABASE_URL = 'https://uvwjopfpwotkmoqmdwjc.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2d2pvcGZwd290a21vcW1kd2pjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE0NDI4NjksImV4cCI6MjA5NzAxODg2OX0.qeacm1-9dS7WhINe1eocQOa_8YRXQ4Wr0tlEHLMtSA0';
const FONT_URL_BOLD = 'https://cdn.jsdelivr.net/fontsource/fonts/manrope@latest/latin-800-normal.ttf';
const FONT_URL_REG = 'https://cdn.jsdelivr.net/fontsource/fonts/manrope@latest/latin-500-normal.ttf';

const escapeHtml = (s) => (s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function fetchFont(url) {
  const cache = caches.default;
  const cacheKey = new Request(url);
  let res = await cache.match(cacheKey);
  if (!res) {
    res = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 604800 } });
    if (res.ok) await cache.put(cacheKey, res.clone());
  }
  return res.arrayBuffer();
}

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const threadId = url.searchParams.get('thread');

  let title = 'Diskusi Komunitas';
  let category = 'community';
  let author = '';
  if (threadId) {
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/forum_threads?id=eq.${encodeURIComponent(threadId)}&select=title,category,author_display_name&limit=1`,
        { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` } },
      );
      const rows = await res.json();
      if (Array.isArray(rows) && rows[0]) {
        title = rows[0].title || title;
        category = rows[0].category || category;
        author = rows[0].author_display_name || '';
      }
    } catch { /* pakai default */ }
  }

  const safeTitle = escapeHtml(title.length > 120 ? title.slice(0, 117) + '…' : title);
  const safeCat = escapeHtml(category);
  const safeAuthor = escapeHtml(author);

  const html = `
    <div style="display:flex;flex-direction:column;justify-content:space-between;width:1200px;height:630px;padding:72px;background:linear-gradient(135deg,#4f46e5 0%,#7c3aed 55%,#9333ea 100%);font-family:Manrope;">
      <div style="display:flex;align-items:center;">
        <div style="display:flex;color:#ffffff;font-size:30px;font-weight:800;letter-spacing:2px;">RUANG SOSMED ID</div>
      </div>
      <div style="display:flex;flex-direction:column;">
        <div style="display:flex;color:#e9d5ff;font-size:26px;font-weight:500;margin-bottom:18px;">💬 ${safeCat}</div>
        <div style="display:flex;color:#ffffff;font-size:64px;font-weight:800;line-height:1.15;">${safeTitle}</div>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div style="display:flex;color:#f5f3ff;font-size:28px;font-weight:500;">${safeAuthor ? 'oleh ' + safeAuthor : 'Komunitas Ruang Sosmed'}</div>
        <div style="display:flex;color:#e9d5ff;font-size:24px;font-weight:500;">ruangsosmedid.com</div>
      </div>
    </div>`;

  const [bold, regular] = await Promise.all([fetchFont(FONT_URL_BOLD), fetchFont(FONT_URL_REG)]);

  return new ImageResponse(html, {
    width: 1200,
    height: 630,
    fonts: [
      { name: 'Manrope', data: bold, weight: 800, style: 'normal' },
      { name: 'Manrope', data: regular, weight: 500, style: 'normal' },
    ],
    headers: { 'cache-control': 'public, max-age=86400' },
  });
}
