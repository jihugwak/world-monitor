export function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  if (diff < 60_000) return '방금';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}시간 전`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}일 전`;
  return new Date(ts).toLocaleDateString('ko-KR');
}

export function extractYouTubeChannelId(feedUrl: string): string | null {
  return feedUrl.match(/channel_id=(UC[\w-]+)/)?.[1] ?? null;
}
