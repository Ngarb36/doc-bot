import Anthropic from "@anthropic-ai/sdk"

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export type Intent =
  | { action: "chat"; message: string }
  | { action: "save_link"; url: string; note: string }
  | { action: "create_event"; summary: string; start: string; end: string; attendees?: string[]; location?: string; description?: string }
  | { action: "list_events"; days: number }
  | { action: "add_reminder"; message: string; remindAt: string; recurrence?: string }
  | { action: "list_reminders" }
  | { action: "delete_reminders"; indices: number[] }
  | { action: "add_task"; title: string; due?: string }
  | { action: "list_tasks" }
  | { action: "complete_task"; taskId: string }
  | { action: "search_drive"; query: string }
  | { action: "add_to_list"; listName: string; items: string[] }
  | { action: "show_list"; listName: string }
  | { action: "clear_list"; listName: string }
  | { action: "remove_from_list"; item: string }
  | { action: "read_emails"; count: number }
  | { action: "send_email"; to: string; subject: string; body: string }
  | { action: "search_contacts"; query: string }
  | { action: "confirm_send_email" }
  | { action: "cancel_send_email" }
  | { action: "show_all" }
  | { action: "connect_google" }
  | { action: "create_group"; groupName: string; memberNames: string[] }
  | { action: "add_to_group"; groupName: string; memberNames: string[] }
  | { action: "list_groups" }
  | { action: "show_group"; groupName: string }
  | { action: "delete_group"; groupName: string }
  | { action: "invite_attendee"; name: string }
  | { action: "edit_event"; query: string; date?: string; changes: { summary?: string; start?: string; end?: string; addAttendees?: string[] } }
  | { action: "add_daily_tasks"; items: string[] }
  | { action: "show_daily_tasks" }
  | { action: "done_daily_tasks"; indices?: number[]; names?: string[] }
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

CRITICAL Hebrew date rules:
- "הקרוב" = the nearest upcoming occurrence of that day (may be this week)
- "הבא" = the occurrence in NEXT week (always 7+ days away, never this week)
- "לאורך כל היום" / "כל היום" / "all day" = start 08:00, end 20:00 same day
- If no time given for an all-day event, use 08:00–20:00

Day name to day-of-week offset from today (${dayName}):
${Object.entries(HEBREW_DAYS).map(([name, dow]) => {
  const diffNearest = (dow - now.getDay() + 7) % 7 || 7
  const diffNext = diffNearest + 7
  const dateNearest = new Date(now.getTime() + diffNearest * 86400000)
  const dateNext = new Date(now.getTime() + diffNext * 86400000)
  return `יום ${name} הקרוב = ${dateNearest.toISOString().split("T")[0]} | יום ${name} הבא = ${dateNext.toISOString().split("T")[0]}`
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
  if (/^הצג(?:\s+הכל|\s+כל\s+הדברים?)?$/.test(lower.trim())) {
    return { action: "show_all" }
  }

  const inviteMatch = lower.match(/^(?:תזמן|תזמין)\s+(?:את\s+)?(.+)/)
  const hasEventKeywords = /ליומן|זימון|לאורך|בשבת|ביום|בשעה|מחר|היום|הבא|הקרוב/.test(lower)
  if (inviteMatch && !hasEventKeywords) {
    return { action: "invite_attendee", name: inviteMatch[1].trim() }
  }

  if (/(?:הצג|מה|תראה)\s+(?:ה)?קבוצות?|מה\s+הקבוצות?/i.test(lower)) {
    return { action: "list_groups" }
  }

  const showGroupMatch = lower.match(/(?:הצג|תראה|פתח|ערוך)\s+(?:ה)?קבוצה\s+(.+)/i)
  if (showGroupMatch) {
    return { action: "show_group", groupName: showGroupMatch[1].trim() }
  }

  if (/(?:הצג|מה|תראה)\s+(?:ה)?תזכורות?|מה\s+התזכורות?/i.test(lower)) {
    return { action: "list_reminders" }
  }

  const deleteReminderMatch = lower.match(/^מחק\s+([\d,\s]+)$/)
  if (deleteReminderMatch) {
    const indices = deleteReminderMatch[1].split(/[,\s]+/).map(n => parseInt(n.trim())).filter(n => !isNaN(n))
    return { action: "delete_reminders", indices }
  }

  const boughtMatch = lower.match(/^(?:קניתי|רכשתי|לקחתי)\s+(.+)/)
  if (boughtMatch) {
    return { action: "remove_from_list", item: boughtMatch[1].trim() }
  }

  // Daily tasks fast-paths (must come BEFORE Google Tasks check to avoid confusion)
  if (/(?:מה|תראה|הצג)\s+(?:ה)?משימות?\s+(?:ל(?:ה)?יום|למחר|של\s+היום|של\s+מחר)/i.test(lower)) {
    return { action: "show_daily_tasks" }
  }

  const addDailyMatch = lower.match(/(?:הוסף|תוסיף|רשום|תרשום|הוסיף)\s+(?:לי\s+)?(?:ל(?:רשימת\s+)?)?(?:המשימות?\s+(?:ל(?:ה)?יום|למחר)|משימות?\s+(?:ל(?:ה)?יום|למחר))\s*[:\-]?\s*(.+)/i)
  if (addDailyMatch) {
    const items = addDailyMatch[1].split(/[,،\n]/).map((s: string) => s.trim()).filter(Boolean)
    if (items.length > 0) return { action: "add_daily_tasks", items }
  }

  const doneNumMatch = lower.match(/^(?:סיימתי|עשיתי|בוצע|מחק)\s+([\d,\s]+)$/)
  if (doneNumMatch) {
    const indices = doneNumMatch[1].split(/[,\s]+/).map((n: string) => parseInt(n.trim())).filter((n: number) => !isNaN(n))
    if (indices.length > 0) return { action: "done_daily_tasks", indices }
  }

  if (/(?:מה\s+(?:ה)?משימות|רשימת\s+מטלות|מה\s+יש\s+לי\s+לעשות|google\s+tasks|תראה.*משימות|הצג.*משימות)/i.test(lower)) {
    return { action: "list_tasks" }
  }

  if (/(?:מה\s+(?:יש\s+לי\s+)?ביומן|מה\s+האירועים|תראה.*יומן|הצג.*יומן)/i.test(lower)) {
    return { action: "list_events", days: 7 }
  }

  if (/(?:תראה.*מייל|הצג.*מייל|מה.*מייל|מיילים\s+אחרונים|האחרון\s+שקיבלתי|קיבלתי\s+מייל|inbox|תראה.*inbox)/i.test(lower)) {
    const countMatch = lower.match(/(\d+)\s+מיילים?/)
    return { action: "read_emails", count: countMatch ? parseInt(countMatch[1]) : 5 }
  }

  const normalizedText = normalizeText(text, now)
  const dateContext = getDateContext(now)

  // Task creation — catch "תוסיף/הוסף משימה" before main Claude call
  const isAddTask = /(?:(?:תוסיף|הוסף|צור|תצור|הכנס|הוסף\s+לי)\s+(?:לי\s+)?(?:את\s+)?(?:ה)?משימה)/i.test(lower)
  if (isAddTask) {
    const taskRes = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: `You extract task details from Hebrew text. Return ONLY valid JSON, no markdown.
${dateContext}
Return exactly: {"action":"add_task","title":"<task title>","due":"<ISO date YYYY-MM-DD or omit if no date>"}
- title: the full task description in Hebrew, preserving infinitive prefixes like ל (e.g. "לנקות תריסים"). If a specific time is mentioned (e.g. "ב13:00"), append it to the title in parentheses: "לנקות תריסים (13:00)". Remove date words but keep time in title.
- due: date only (no time), e.g. "2026-04-13". Omit the field if no due date mentioned.`,
      messages: [{ role: "user", content: normalizedText }],
    })
    try {
      const rawTask = taskRes.content[0].type === "text"
        ? taskRes.content[0].text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
        : ""
      const parsedTask = JSON.parse(rawTask)
      if (parsedTask.action === "add_task" && parsedTask.title) return parsedTask as Intent
    } catch { /* fall through */ }
  }

  // Calendar creation — catch "תוסיף/הוסף/קבע ליומן" patterns with a focused Claude call
  // so that event titles like "דייט", "ריצה", "שינה" are never misclassified as chat
  const isCalCreate = /(?:(?:תוסיף|הוסף|קבע|תקבע|צור|תצור|שים|רשום|תרשום|הכנס|קבוע|שמור|תוציא|הוצא)\s+(?:לי\s+)?(?:(?:ל(?:ה)?)?יומן|זימון))|(?:יומן[:\s])|(?:פגישה|ישיבה|תור|מפגש|אירוע|דייט|ריצה|אימון|ארוחה|זימון)\s+(?:מחר|היום|ב-?\d|ב(?:יום|שעה))/i.test(lower)
  if (isCalCreate) {
    const response2 = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: `You extract calendar event details from Hebrew text. Return ONLY valid JSON, no markdown.
${dateContext}
Return exactly: {"action":"create_event","summary":"<title>","start":"<ISO datetime +03:00>","end":"<ISO datetime +03:00>"}
- summary: the event title/name ONLY. If the text says "בשם X" or "שם האירוע X" or "קרא לו X" or "תקרא לו X", the summary is X only. Do NOT include attendee instructions like "תזמן את X", "תזמין את X", "invite X", or group names. Strip those completely.
- If no end time, add 1 hour to start.
- Always full ISO 8601 with timezone: "2026-04-13T16:00:00+03:00"`,
      messages: [{ role: "user", content: normalizedText }],
    })
    try {
      const raw2 = response2.content[0].type === "text"
        ? response2.content[0].text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
        : ""
      const parsed2 = JSON.parse(raw2)
      if (parsed2.action === "create_event" && parsed2.start && parsed2.end) return parsed2 as Intent
    } catch { /* fall through to main Claude call */ }
  }

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
- create_event: {summary: "event title only — if text says 'בשם X'/'קרא לו X'/'תקרא לו X' use X as summary. Do NOT include attendee names or groups.", start (ISO 8601 with time), end (ISO 8601 with time), attendees?: [emails], location?, description?}
- list_events: {days: number}
- add_reminder: {message: "full reminder text — KEEP the ל prefix on infinitive verbs (e.g. 'לקבוע משימות' not 'קבוע משימות', 'לשלוח מייל' not 'שלוח מייל')", remindAt: "ISO 8601 datetime", recurrence?: "daily"|"weekly"|"monthly"}
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
- create_group: {groupName: "group name", memberNames: ["name1", "name2"]}
- add_to_group: {groupName: "group name", memberNames: ["name1"]}
- list_groups: {}
- delete_group: {groupName: "group name"}
- edit_event: {query: "event title to find", date?: "YYYY-MM-DD", changes: {summary?: "new title", start?: "ISO datetime +03:00", end?: "ISO datetime +03:00", addAttendees?: ["name or group name"]}}
- add_daily_tasks: {items: ["task1", "task2"]} — personal daily planning list (NOT Google Tasks)
- show_daily_tasks: {} — show today's/tomorrow's personal task list
- done_daily_tasks: {indices?: [1,2], names?: ["task name"]} — mark personal daily tasks done
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
- "תוסיף/הוסף (ל)יומן / צור/קבע/תוציא פגישה/ישיבה/תור/מפגש/אירוע/זימון" → create_event (even for informal titles like דייט/ריצה/שינה)
- "תזכיר לי / תזכורת" → add_reminder
- "תוסיף/הוסף משימה / תוסיף לרשימת מטלות / מטלה חדשה / task" → add_task
- "מה המשימות / רשימת מטלות / מה יש לי לעשות / google tasks / tasks" → list_tasks
- "מה יש לי ביומן / אירועים / תראה לי את היומן" → list_events
- "חפש בדרייב / drive" → search_drive
- "תשלח מייל / שלח מייל" → send_email
- "תראה מיילים / מה יש במייל / מיילים אחרונים" → read_emails

CRITICAL: "רשימת מטלות", "מטלות", "משימות", "tasks" always → add_task or list_tasks, NEVER chat.
- "צור קבוצה / הוסף קבוצה" → create_group
- "הוסף [שם] לקבוצה [X] / הכנס [שם] לקבוצה" → add_to_group
- "הצג קבוצות / מה הקבוצות" → list_groups
- "מחק קבוצה" → delete_group
- "לזימון/לאירוע X שנה שם ל-Y" → edit_event, changes.summary="Y"
- "לזימון/לאירוע X שנה שעה ל-Y" → edit_event, changes.start (and end if given)
- "לזימון/לאירוע X תזמן את Y / הוסף Y" → edit_event, changes.addAttendees=["Y"]
- edit_event.query: event title only, no date/action words. date: YYYY-MM-DD if mentioned.
- "הוסף/רשום משימות למחר/להיום: X, Y" → add_daily_tasks (items split by comma/newline)
- "מה המשימות למחר/להיום / תראה משימות להיום" → show_daily_tasks
- "סיימתי/עשיתי/בוצע [1,2] / [שם משימה]" → done_daily_tasks
- IMPORTANT: "משימות להיום/למחר" → daily tasks (local list). "משימות" alone or "google tasks" → list_tasks (Google).`,
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
