/**
 * Reminder parser — Hebrew & English (ported from src/parser.js)
 */

const TIMEZONE = "Asia/Jerusalem"

const HE_DAYS: Record<string, number> = {
  ראשון: 0, שני: 1, שלישי: 2, רביעי: 3, חמישי: 4, שישי: 5, שבת: 6,
}
const EN_DAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
}

export interface ParsedReminder {
  message: string
  remindAt: Date
  recurrence?: string
}

export function parseReminderText(userMessage: string): ParsedReminder | { error: string } {
  const msg = userMessage.trim()
  // Strip reminder trigger words
  const cleaned = msg
    .replace(/^תזכיר\s+לי\s*/i, "")
    .replace(/^תזכרי\s+לי\s*/i, "")
    .replace(/^תזכיר\s*/i, "")
    .replace(/^תזכרי\s*/i, "")
    .replace(/^תזכורת\s+קבועה\s*/i, "")
    .replace(/^תזכורת\s*/i, "")
    .replace(/^remind\s+me\s*/i, "")
    .trim()

  const lower = cleaned.toLowerCase()

  // Recurring
  const recurring = parseRecurring(lower)
  if (recurring) {
    return {
      message: extractTaskText(cleaned, recurring.timeExpr),
      remindAt: recurring.remindAt,
      recurrence: recurring.recurrence,
    }
  }

  // Multi-line
  const lines = cleaned.split(/\n/).map((l: string) => l.trim()).filter(Boolean)
  if (lines.length >= 2) {
    const t1 = parseTime(lines[lines.length - 1].toLowerCase())
    if (t1 && t1 > new Date()) {
      return { message: lines.slice(0, -1).join(" "), remindAt: t1 }
    }
    const t2 = parseTime(lines[0].toLowerCase())
    if (t2 && t2 > new Date()) {
      return { message: lines.slice(1).join(" "), remindAt: t2 }
    }
  }

  // Single line
  const { remindAt, timeExpr } = parseTimeWithExpr(lower)
  if (!remindAt || remindAt <= new Date()) {
    if (remindAt && remindAt <= new Date()) return { error: "הזמן הזה כבר עבר. תן לי זמן עתידי!" }
    return {
      error: "לא הבנתי מתי.\n\nדוגמאות:\n• תזכיר לי להתקשר בעוד שעה\n• תזכיר לי מחר ב-9:00 לקנות חלב\n• תזכיר לי כל יום שני ב-20:00",
    }
  }

  return {
    message: extractTaskText(cleaned, timeExpr),
    remindAt,
  }
}

const EVENT_KEYWORDS = /פגישה|ישיבה|כנס|זום|מיטינג|meeting|appointment|call with|קולגות|conference/i

export function isReminderMessage(text: string): boolean {
  const lower = text.toLowerCase().trim()

  // explicit trigger words
  if (/^(תזכיר|תזכרי|remind\s+me|תזכורת)/.test(lower)) return true

  // implicit: contains a relative-time phrase but no calendar-event keywords
  const hasRelativeTime = /(?:עוד|בעוד)\s+\d+\s*(?:דקות?|דק'?|שעות?|ימים?|יום)|(?:עוד|בעוד)\s+(?:שעה|דקה|חצי\s+שעה|רבע\s+שעה)/.test(lower)
  if (hasRelativeTime && !EVENT_KEYWORDS.test(text)) return true

  return false
}

export function nextOccurrence(recurrence: string): Date | null {
  const parts = recurrence.split(":")
  if (parts[0] === "daily") {
    return nextDailyOccurrence(parseInt(parts[1]), parseInt(parts[2]))
  }
  if (parts[0] === "weekly") {
    const t = nextWeeklyOccurrence(parseInt(parts[1]), parseInt(parts[2]), parseInt(parts[3]))
    const minNext = new Date(Date.now() + 6 * 86400000)
    return t < minNext ? new Date(t.getTime() + 7 * 86400000) : t
  }
  return null
}

// ── internals ──────────────────────────────────────────────────────────────────

function parseTimeWithExpr(msg: string): { remindAt: Date | null; timeExpr: string | null } {
  const now = new Date()
  let m: RegExpMatchArray | null

  const relPatterns: Array<{ re: RegExp; fn: (m: RegExpMatchArray) => Date }> = [
    { re: /(?:in|בעוד|עוד)\s+(\d+)\s*(?:minutes?|דקות?|דק'?)/, fn: (m) => addMinutes(now, parseInt(m[1])) },
    { re: /(?:in|בעוד|עוד)\s+(\d+)\s*(?:hours?|שעות?)/, fn: (m) => addMinutes(now, parseInt(m[1]) * 60) },
    { re: /(?:in|בעוד|עוד)\s+(\d+)\s*(?:days?|ימים?|יום)/, fn: (m) => addMinutes(now, parseInt(m[1]) * 60 * 24) },
    { re: /(?:עוד|בעוד)\s+דקה(?:\s|$)/, fn: () => addMinutes(now, 1) },
    { re: /(?:עוד|בעוד)\s+שעה(?:\s|$)/, fn: () => addMinutes(now, 60) },
    { re: /(?:עוד|בעוד)\s+חצי\s+שעה/, fn: () => addMinutes(now, 30) },
    { re: /(?:עוד|בעוד)\s+רבע\s+שעה/, fn: () => addMinutes(now, 15) },
  ]

  for (const { re, fn } of relPatterns) {
    m = msg.match(re)
    if (m) return { remindAt: fn(m), timeExpr: m[0] }
  }

  // Absolute date: DD.MM or DD.MM.YYYY — e.g. "ל26.04 בשעה 11"
  const dateM = msg.match(/(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?/)
  if (dateM) {
    const day = parseInt(dateM[1]), month = parseInt(dateM[2])
    const year = dateM[3] ? (dateM[3].length === 2 ? 2000 + parseInt(dateM[3]) : parseInt(dateM[3])) : now.getFullYear()
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const timeM = msg.match(/(?:ב-?|בשעה\s*)(\d{1,2})(?::(\d{2}))?/)
      const h = timeM ? parseInt(timeM[1]) : 9
      const min = timeM ? parseInt(timeM[2] ?? "0") : 0
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const targetStart = new Date(year, month - 1, day)
      const daysFromNow = Math.round((targetStart.getTime() - todayStart.getTime()) / 86400000)
      if (daysFromNow >= 0) {
        return { remindAt: zonedDate(daysFromNow, h, min), timeExpr: dateM[0] }
      }
    }
  }

  // Hebrew day name: "ביום ראשון ב11:20" / "יום שני ב-9:00"
  for (const [name, dayNum] of Object.entries(HE_DAYS)) {
    const re = new RegExp(`(?:ב)?(?:יום\\s+)?${name}[\\s\\S]*?(\\d{1,2})(?::(\\d{2}))?`)
    m = msg.match(re)
    if (m) {
      const h = parseInt(m[1]), min = parseInt(m[2] ?? "0")
      return { remindAt: nextWeeklyOccurrence(dayNum, h, min), timeExpr: m[0] }
    }
  }

  m = msg.match(/(מחר|tomorrow)[\s\S]*?(\d{1,2})(?::(\d{2}))?/)
  if (m) return { remindAt: zonedDate(1, parseInt(m[2]), parseInt(m[3] ?? "0")), timeExpr: m[0] }

  m = msg.match(/(הלילה|tonight)[\s\S]*?(\d{1,2})(?::(\d{2}))?/)
  if (m) {
    let h = parseInt(m[2])
    if (h < 12) h += 12
    return { remindAt: zonedDate(0, h, parseInt(m[3] ?? "0")), timeExpr: m[0] }
  }

  m = msg.match(/(היום|today)[\s\S]*?(\d{1,2})(?::(\d{2}))?/)
  if (m) {
    const t = zonedDate(0, parseInt(m[2]), parseInt(m[3] ?? "0"))
    return { remindAt: t > now ? t : zonedDate(1, parseInt(m[2]), parseInt(m[3] ?? "0")), timeExpr: m[0] }
  }

  m = msg.match(/(?:ב-?|בשעה\s*)(\d{1,2})(?::(\d{2}))?/)
  if (m) {
    const h = parseInt(m[1]), min = parseInt(m[2] ?? "0")
    const t = zonedDate(0, h, min)
    return { remindAt: t > now ? t : zonedDate(1, h, min), timeExpr: m[0] }
  }

  m = msg.match(/at\s+(\d{1,2})(?::(\d{2}))?/)
  if (m) {
    let h = parseInt(m[1])
    if (h <= 7) h += 12
    const t = zonedDate(0, h, parseInt(m[2] ?? "0"))
    return { remindAt: t > now ? t : zonedDate(1, h, parseInt(m[2] ?? "0")), timeExpr: m[0] }
  }

  m = msg.match(/(?:^|\s)(\d{1,2}):(\d{2})(?:\s|$)/)
  if (m) {
    const h = parseInt(m[1]), min = parseInt(m[2])
    if (h <= 23 && min <= 59) {
      const t = zonedDate(0, h, min)
      return { remindAt: t > now ? t : zonedDate(1, h, min), timeExpr: m[0].trim() }
    }
  }

  return { remindAt: null, timeExpr: null }
}

function parseTime(msg: string): Date | null {
  return parseTimeWithExpr(msg).remindAt
}

function extractTaskText(msg: string, timeExpr: string | null): string {
  let text = msg.replace(/^תזכיר\s+לי\s*/i, "").replace(/^תזכרי\s+לי\s*/i, "").trim()
  if (timeExpr) {
    text = text.replace(new RegExp(escapeRegex(timeExpr), "i"), " ").replace(/\s+/g, " ").trim()
  }
  text = text.replace(/^(?:ל|את|ה)\s+/i, "").trim()
  return text || msg
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function parseRecurring(msg: string): { remindAt: Date; recurrence: string; timeExpr: string } | null {
  let m: RegExpMatchArray | null

  m = msg.match(/(?:כל יום|every day)[\s\S]*?(\d{1,2})(?::(\d{2}))?/)
  if (m) {
    const h = parseInt(m[1]), min = parseInt(m[2] ?? "0")
    return { remindAt: nextDailyOccurrence(h, min), recurrence: `daily:${pad(h)}:${pad(min)}`, timeExpr: m[0] }
  }

  for (const [name, dayNum] of Object.entries(HE_DAYS)) {
    const re = new RegExp(`כל\\s+${name}[\\s\\S]*?(\\d{1,2})(?::(\\d{2}))?`)
    m = msg.match(re)
    if (m) {
      const h = parseInt(m[1]), min = parseInt(m[2] ?? "0")
      return { remindAt: nextWeeklyOccurrence(dayNum, h, min), recurrence: `weekly:${dayNum}:${pad(h)}:${pad(min)}`, timeExpr: m[0] }
    }
  }

  for (const [name, dayNum] of Object.entries(EN_DAYS)) {
    const re = new RegExp(`every\\s+${name}[\\s\\S]*?(\\d{1,2})(?::(\\d{2}))?`)
    m = msg.match(re)
    if (m) {
      const h = parseInt(m[1]), min = parseInt(m[2] ?? "0")
      return { remindAt: nextWeeklyOccurrence(dayNum, h, min), recurrence: `weekly:${dayNum}:${pad(h)}:${pad(min)}`, timeExpr: m[0] }
    }
  }

  return null
}

function nextDailyOccurrence(hour: number, minute: number): Date {
  const t = zonedDate(0, hour, minute)
  return t > new Date() ? t : zonedDate(1, hour, minute)
}

function nextWeeklyOccurrence(targetDay: number, hour: number, minute: number): Date {
  const now = new Date()
  const currentDay = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    now.toLocaleDateString("en-US", { timeZone: TIMEZONE, weekday: "short" })
  )
  let daysUntil = (targetDay - currentDay + 7) % 7
  const candidate = zonedDate(daysUntil, hour, minute)
  if (candidate <= now) daysUntil += 7
  return zonedDate(daysUntil, hour, minute)
}

function zonedDate(daysFromNow: number, hour: number, minute: number): Date {
  const base = new Date(Date.now() + daysFromNow * 86400000)
  const dateStr = base.toLocaleDateString("en-CA", { timeZone: TIMEZONE })
  const naive = new Date(`${dateStr}T${pad(hour)}:${pad(minute)}:00Z`)
  const utcRepr = new Date(naive.toLocaleString("en-US", { timeZone: "UTC" }))
  const tzRepr = new Date(naive.toLocaleString("en-US", { timeZone: TIMEZONE }))
  return new Date(naive.getTime() - (tzRepr.getTime() - utcRepr.getTime()))
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000)
}

function pad(n: number): string {
  return String(n).padStart(2, "0")
}
