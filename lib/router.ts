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

export async function routeMessage(
  text: string,
  now: Date
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

  const nowISO = now.toISOString()
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 400,
    system: `You are an intent classifier for a Hebrew/English personal assistant bot named Doc.
Current time: ${nowISO} (Asia/Jerusalem timezone).
Respond ONLY with valid JSON, no markdown.

Available actions:
- chat: general conversation or questions
- create_event: {summary, start (ISO), end (ISO), attendees?: [emails], location?, description?}
- list_events: {days: number}
- add_reminder: {message: "the reminder text in Hebrew", remindAt: "ISO datetime string calculated from now", recurrence?: "daily"|"weekly"|"monthly"}
- list_reminders: {}
- add_task: {title, due?: ISO date}
- list_tasks: {}
- complete_task: {taskId: string} - only if user specifies a task ID
- search_drive: {query}
- add_to_list: {listName, items: [strings]}
- show_list: {listName}
- clear_list: {listName}
- read_emails: {count: 1-10}
- send_email: {to (email or name to search), subject, body}
- search_contacts: {query}
- connect_google: {}
- unknown: {}

For events without explicit end time, add 1 hour.
For Hebrew dates/times like "מחר", "היום", "בשישי", "עוד שעה", "בעוד 30 דקות" - calculate actual ISO datetime from the current time ${nowISO}.
"עוד שעה" = current time + 1 hour. "מחר" = tomorrow same time. Always return valid ISO strings.`,
    messages: [{ role: "user", content: text }],
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
