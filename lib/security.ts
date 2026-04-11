import { createHmac, timingSafeEqual } from "crypto"

// ── Allowed chat IDs (whitelist) ──────────────────────────────────────────────
const ALLOWED_IDS = (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

export function isAllowedChat(chatId: number | string): boolean {
  if (ALLOWED_IDS.length === 0) return false
  return ALLOWED_IDS.includes(String(chatId))
}

// ── Webhook signature verification ───────────────────────────────────────────
export function verifyTelegramWebhook(
  body: string,
  secretHeader: string | null
): boolean {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (!secret || !secretHeader) return false
  const expected = createHmac("sha256", "WebAppData")
    .update(secret)
    .digest()
  const token = Buffer.from(secretHeader, "utf8")
  const exp = Buffer.from(expected.toString("hex"), "utf8")
  if (token.length !== exp.length) return false
  return timingSafeEqual(token, exp)
}

// ── Rate limiting (in-memory, per chat) ───────────────────────────────────────
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT = 20       // max requests
const RATE_WINDOW = 60_000  // per minute

export function checkRateLimit(chatId: string | number): boolean {
  const key = String(chatId)
  const now = Date.now()
  const entry = rateLimitMap.get(key)

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_WINDOW })
    return true
  }

  if (entry.count >= RATE_LIMIT) return false
  entry.count++
  return true
}

// ── Input sanitization ────────────────────────────────────────────────────────
export function sanitizeInput(text: string): string {
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // control chars
    .slice(0, 4000) // max length
    .trim()
}

// ── URL validation ────────────────────────────────────────────────────────────
export function isValidUrl(str: string): boolean {
  try {
    const url = new URL(str)
    return url.protocol === "https:" || url.protocol === "http:"
  } catch {
    return false
  }
}
