import Anthropic from "@anthropic-ai/sdk"

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export type Intent =
  | { action: "chat"; message: string }
  | { action: "save_link"; url: string; note: string }
  | { action: "create_event"; summary: string; start: string; end: string; attendees?: string[]; location?: string; description?: string }
  | { action: "list_events"; days: number }
  | { action: "add_reminder"; message: string; remindAt: string; recurrence?: string }
  | { action: "list_reminders" }
  | { action: "add_task"; title: string; due?: string }
  | { action: "list_tasks" }
  | { action: "complete_task"; taskId: string }
  | { action: "search_drive"; query: string }
  | { action: "add_to_list"; listName: string; items: string[] }
  | { action: "show_list"; listName: string }
  | { action: "clear_list"; listName: string }
  | { action: "read_emails"; count: number }
  | { action: "send_email"; to: string; subject: string; body: string }
  | { action: "search_contacts"; query: string }
  | { action: "confirm_send_email" }
  | { action: "cancel_send_email" }
  | { action: "connect_google" }
  | { action: "unknown" }

const URL_REGEX = /https?:\/\/[^\s]+/gi

const HEBREW_DAYS: Record<string, number> = {
  "ראשון": 0, "שני": 1, "שלישי": 2, "רביעי": 3, "חמישי": 4, "שישי": 5, "שבת": 6
}

// Pre-process common Israeli date formats before sending to Claude
function normalizeText(text: string, now: Date): string {
  // Convert DD.MM or DD.MM.YY to full date description
  return text.replace(/\b(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\b/g, (_, d, m, y) => {
    const year = y ? (y.length === 2 ? 2000 + parseInt(y) : parseInt(y)) : now.getFullYear()
    const month = parseInt(m)
    const day = parseInt(d)
    const date = new Date(year, month - 1, day)
    return date.toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
  })
}

function getDateContext(now: Date): string {
  const days = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"]
  const dayName = days[now.getDay()]
  const nextSunday = new Date(now)
  nextSunday.setDate(now.getDate() + (7 - now.getDay()) % 7 || 7)

  return `Current date/time: ${now.toISOString()}
Day of week: יום ${dayName}
Tomorrow: ${new Date(now.getTime() + 86400000).toISOString().split("T")[0]}
Next Sunday: ${nextSunday.toISOString().split("T")[0]}
Timezone: Asia/Jerusalem (UTC+3)

Day name to day-of-week offset from today (${dayName}):
${Object.entries(HEBREW_DAYS).map(([name, dow]) => {
  const diff = (dow - now.getDay() + 7) % 7 || 7
  const date = new Date(now.getTime() + diff * 86400000)
  return `יום ${name} הקרוב = ${date.toISOString().split("T")[0]}`
}).join("\n")}
יום ראשון עוד שבוע = ${new Date(nextSunday.getTime() + 7 * 86400000).toISOString().split("T")[0]}`
}

export async function routeMessage(
  text: string,
  now: Date,
  conversationHistory: { role: "user" | "assistant"; content: string }[] = []
): Promise<Intent> {
  // Quick checks before hitting Claude
  const urls = (text.match(URL_REGEX) || []).map((u) => u.replace(/[.,!?)]+$/, ""))
  if (urls.length > 0) {
    return { action: "save_link", url: urls[0], note: text.replace(URL_REGEX, "").trim() }
  }

  const lower = text.toLowerCase().trim()
  if (lower === "כן" || lower === "yes" || lower === "אישור" || lower === "שלח") {
    return { action: "confirm_send_email" }
  }
  if (lower === "לא" || lower === "no" || lower === "ביטול" || lower === "בטל") {
    return { action: "cancel_send_email" }
  }

  // Quick deterministic checks before hitting Claude
  if (/(?:מה\s+(?:ה)?משימות|רשימת\s+מטלות|מה\s+יש\s+לי\s+לעשות|google\s+tasks|תראה.*משימות|הצג.*משימות)/i.test(lower)) {
    return { action: "list_tasks" }
  }

  if (/(?:מה\s+(?:יש\s+לי\s+)?ביומן|מה\s+האירועים|תראה.*יומן|הצג.*יומן)/i.test(lower)) {
    return { action: "list_events", days: 7 }
  }

  // Calendar creation — catch "תוסיף/הוסף/קבע ליומן / ביומן" patterns BEFORE Claude
  // so that event titles like "דייט", "ריצה", "שינה" etc. are never misclassified as chat
  const isCalCreate = /(?:(?:תוסיף|הוסף|קבע|תקבע|צור|תצור|שים|רשום|תרשום)(?:\s+לי)?(?:\s+ל)?(?:ה)?יומן)/i.test(lower)
  if (isCalCreate) {
    // Still need Claude to extract title/date/time — but force the action hint
    const forcedHint = "\n\nCRITICAL: The user is asking to CREATE a calendar event. You MUST return action=create_event with ISO dates."
    const response2 = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: `You extract calendar event details from Hebrew text. Return ONLY valid JSON, no markdown.
${dateContext}
Return: {"action":"create_event","summary":"<title>","start":"<ISO datetime +03:00>","end":"<ISO datetime +03:00>"}
- If no end time, add 1 hour to start.
- Always use full ISO 8601: "2026-04-13T16:00:00+03:00"${forcedHint}`,
      messages: [{ role: "user", content: normalizeText(text, now) }],
    })
    try {
      const raw2 = response2.content[0].type === "text"
        ? response2.content[0].text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
        : ""
      const parsed2 = JSON.parse(raw2)
      if (parsed2.action === "create_event" && parsed2.start && parsed2.end) return parsed2 as Intent
    } catch { /* fall through to main Claude call */ }
  }

  const normalizedText = normalizeText(text, now)
  const dateContext = getDateContext(now)

  const messages: { role: "user" | "assistant"; content: string }[] = [
    ...conversationHistory.slice(-4), // last 2 exchanges for context
    { role: "user", content: normalizedText }
  ]

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    system: `You are an intent classifier for a Hebrew/English personal assistant bot named Doc.
${dateContext}
Respond ONLY with valid JSON, no markdown.

Available actions:
- chat: general conversation or questions
- create_event: {summary, start (ISO 8601 with time), end (ISO 8601 with time), attendees?: [emails], location?, description?}
- list_events: {days: number}
- add_reminder: {message: "reminder text", remindAt: "ISO 8601 datetime", recurrence?: "daily"|"weekly"|"monthly"}
- list_reminders: {}
- add_task: {title, due?: "ISO date"}
- list_tasks: {}
- complete_task: {taskId: string}
- search_drive: {query}
- add_to_list: {listName, items: [strings]}
- show_list: {listName}
- clear_list: {listName}
- read_emails: {count: 1-10}
- send_email: {to, subject, body}
- search_contacts: {query}
- connect_google: {}
- unknown: {}

IMPORTANT date rules:
- Always use full ISO 8601 format with time: "2026-04-13T09:00:00+03:00"
- If no end time given, add 1 hour to start
- "עוד שעה" = now + 1 hour
- "מחר" = tomorrow
- Use the pre-calculated day dates above for Hebrew day names
- If year not specified, use current year (${now.getFullYear()})
- Default meeting time is 09:00 if only date given with no time

Intent classification hints (Hebrew):
- "תוסיף/הוסף (ל)יומן / צור/קבע פגישה/ישיבה/תור/מפגש/אירוע" → create_event (even for informal titles like דייט/ריצה/שינה)
- "תזכיר לי / תזכורת" → add_reminder
- "תוסיף/הוסף משימה / תוסיף לרשימת מטלות / מטלה חדשה / task" → add_task
- "מה המשימות / רשימת מטלות / מה יש לי לעשות / google tasks / tasks" → list_tasks
- "מה יש לי ביומן / אירועים / תראה לי את היומן" → list_events
- "חפש בדרייב / drive" → search_drive
- "תשלח מייל / שלח מייל" → send_email
- "תראה מיילים / מה יש במייל / מיילים אחרונים" → read_emails

CRITICAL: "רשימת מטלות", "מטלות", "משימות", "tasks" always → add_task or list_tasks, NEVER chat.`,
    messages,
  })

  try {
    const raw = response.content[0].type === "text"
      ? response.content[0].text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
      : ""
    return JSON.parse(raw) as Intent
  } catch {
    return { action: "chat", message: text }
  }
}
