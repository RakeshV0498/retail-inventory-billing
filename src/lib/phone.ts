import { formatPaise } from "./money";

/** Digits only, 7-15 long (spaces, dashes, brackets and a leading + are ignored); otherwise null. */
export function normalizePhone(raw: string): string | null {
  const d = raw.replace(/[\s\-().+]/g, "");
  return /^\d{7,15}$/.test(d) ? d : null;
}

/** Number as WhatsApp wants it (country code, no +). A bare 10-digit or 0-prefixed Indian number gets 91. */
export function whatsappNumber(phone: string): string {
  if (/^\d{10}$/.test(phone)) return `91${phone}`;
  if (/^0\d{10}$/.test(phone)) return `91${phone.slice(1)}`;
  return phone;
}

/** wa.me link with a ready-to-send reminder. Built in the browser/server only; nothing is sent anywhere by us. */
export function whatsappReminderUrl(args: { phone: string | null; name: string; balance: number; storeName: string }): string | null {
  if (!args.phone || args.balance <= 0) return null;
  const text = `Hello ${args.name}, a gentle reminder from ${args.storeName}: your outstanding balance is ${formatPaise(args.balance)}. Thank you!`;
  return `https://wa.me/${whatsappNumber(args.phone)}?text=${encodeURIComponent(text)}`;
}
