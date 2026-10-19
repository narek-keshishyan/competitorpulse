/** "just now", "42s ago", "in 3 min", "2 h ago": coarse on purpose, it is a status hint. */
export function formatRelative(iso: string, now: number): string {
  const diffSeconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(diffSeconds);
  if (abs < 5) return 'just now';

  const amount =
    abs < 60
      ? `${abs}s`
      : abs < 3_600
        ? `${Math.round(abs / 60)} min`
        : `${Math.round(abs / 3_600)} h`;
  return diffSeconds < 0 ? `${amount} ago` : `in ${amount}`;
}
