import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatTime(timestamp: string | number): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function generateId(): string {
  // 12 hex chars = 48 bits of entropy. The previous 8-char slice (32 bits)
  // hit a ~50% collision probability at ~65k ids — trivially reachable for
  // message + entity + relation ids in a long investigation. 48 bits pushes
  // the 50% mark to ~16M ids. Existing 8-char ids in user DBs remain valid
  // (ids are opaque strings, no fixed-length assumptions anywhere).
  return crypto.randomUUID().slice(0, 12);
}
