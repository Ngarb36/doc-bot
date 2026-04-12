export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { isAllowedChat, verifyTelegramWebhook, checkRateLimit, sanitizeInput } from "@/lib/security"
import {
  getUser, createConnectToken,
  getConversationHistory, appendConversationHistory,
  getPendingEvent, savePendingEvent, deletePendingEvent,
  getReminder, updateReminder, deleteReminder,
  getUserGroups,
} from "@/lib/db"
import { routeMessage } from "@/lib/router"
import { handleIntent } from "@/lib/handlers"
import { parseEventFromImage, buildISODateTimes } from "@/lib/event-parser"
import { isReminderMessage, parseReminderText } from "@/lib/reminder-parser"
import { createCalendarEvent, listUserCalendars, searchContacts } from "@/lib/google"
import { addReminder } from "@/lib/db"

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!
const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`

// ── Telegram API helpers ──────────────────────────────────────────────────────

async function sendMessage(chatId: number | string, text: string, replyMarkup?: object) {
  const res = await fetch(`${BASE_URL}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      ...(replyMarkup && { reply_markup: replyMarkup }),
    }),
  })
  return res.json()
}

async function editMessage(chatId: number | string, messageId: number, text: string, replyMarkup?: object) {
  await fetch(`${BASE_URL}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "Markdown",
      ...(replyMarkup && { reply_markup: replyMarkup }),
    }),
  })
}

async function answerCallback(callbackQueryId: string, text?: string) {
  await fetch(`${BASE_URL}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  })
}

async function sendTyping(chatId: number | string) {
  await fetch(`${BASE_URL}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  })
}

async function getFileUrl(fileId: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/getFile?file_id=${fileId}`)
  const data = await res.json()
  return `https://api.telegram.org/file/bot${BOT_TOKEN}/${data.result.file_path}`
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("he-IL", {
      timeZone: "Asia/Jerusalem", weekday: "short", month: "short",
      day: "numeric", hour: "2-digit", minute: "2-digit",
    })
  } catch { return iso }
}

// ── Reminder snooze keyboard ──────────────────────────────────────────────────

function reminderKeyboard(reminderId: string) {
  return {
    inline_keyboard: [[
      { text: "✅ בוצע", callback_data: `rem_done:${reminderId}` },
      { text: "😤 נודניק (+10)", callback_data: `rem_snooze10:${reminderId}` },
      { text: "⏰ +שעה", callback_data: `rem_snooze60:${reminderId}` },
    ]],
  }
}

// ── Calendar selection keyboard ───────────────────────────────────────────────

// Use index instead of full calendar ID — Telegram callback_data is capped at 64 bytes
function calendarKeyboard(calendars: { id: string; name: string }[]) {
  return {
    inline_keyboard: calendars.map((c, i) => [
      { text: c.name, callback_data: `cal_select:${i}` },
    ]),
  }
}

// ── Invite confirmation keyboard ──────────────────────────────────────────────

function inviteKeyboard() {
  return {
    inline_keyboard: [[
      { text: "✅ כן", callback_data: "invite_yes" },
      { text: "❌ לא", callback_data: "invite_no" },
    ]],
  }
}

// ── Callback query handler ────────────────────────────────────────────────────

async function handleCallback(update: any) {
  const query = update.callback_query
  if (!query) return

  const chatId = query.message.chat.id
  const messageId = query.message.message_id
  const data: string = query.data ?? ""

  await answerCallback(query.id)

  // ── Reminder actions ────────────────────────────────────────────────────
  if (data.startsWith("rem_done:")) {
    const remId = data.replace("rem_done:", "")
    await deleteReminder(chatId, remId)
    await editMessage(chatId, messageId, "✅ *בוצע!*")
    return
  }

  if (data.startsWith("rem_snooze10:")) {
    const remId = data.replace("rem_snooze10:", "")
    const rem = await getReminder(remId)
    if (rem) {
      const newTime = Date.now() + 10 * 60 * 1000
      await updateReminder(remId, { remindAt: newTime })
      await editMessage(chatId, messageId, `⏰ *תזכורת נדחתה ל-10 דקות*\n"${rem.message}"`)
    }
    return
  }

  if (data.startsWith("rem_snooze60:")) {
    const remId = data.replace("rem_snooze60:", "")
    const rem = await getReminder(remId)
    if (rem) {
      const newTime = Date.now() + 60 * 60 * 1000
      await updateReminder(remId, { remindAt: newTime })
      await editMessage(chatId, messageId, `⏰ *תזכורת נדחתה לשעה*\n"${rem.message}"`)
    }
    return
  }

  // ── Invite confirmation ─────────────────────────────────────────────────
  if (data === "invite_yes" || data === "invite_no") {
    const user = await getUser(chatId)
    const pending = await getPendingEvent(chatId)
    if (!user || !pending) {
      await editMessage(chatId, messageId, "הפגישה פגה. נסה שוב.")
      return
    }
    if (data === "invite_yes" && pending.suggestedAttendees?.length) {
      pending.attendees = [
        ...(pending.attendees ?? []),
        ...pending.suggestedAttendees.map(a => a.email),
      ]
    }
    pending.suggestedAttendees = undefined
    await savePendingEvent(chatId, pending)
    // Now show calendar picker
    const calendars = await listUserCalendars(user.refreshToken)
    pending.calendarIds = calendars.map(c => c.id)
    await savePendingEvent(chatId, pending)
    const { startDateTime } = buildISODateTimes(pending as any)
    const attendeeStr = pending.attendees?.length ? `\n👥 ${pending.attendees.join(", ")}` : ""
    const locationStr = pending.location ? `\n📍 ${pending.location}` : ""
    await editMessage(chatId, messageId,
      `📅 *${pending.title}*\n🗓 ${formatDate(startDateTime)}${locationStr}${attendeeStr}\n\nלאיזה יומן להוסיף?`,
      calendarKeyboard(calendars)
    )
    return
  }

  // ── Calendar selection ──────────────────────────────────────────────────
  if (data.startsWith("cal_select:")) {
    const idx = parseInt(data.replace("cal_select:", ""), 10)
    const user = await getUser(chatId)
    const pending = await getPendingEvent(chatId)

    if (!user || !pending) {
      await editMessage(chatId, messageId, "הפגישה פגה. נסה שוב.")
      return
    }

    // Resolve calendar ID from stored list (index avoids 64-byte callback_data limit)
    const calId = pending.calendarIds?.[idx] ?? "primary"

    try {
      const htmlLink = await createCalendarEvent(user.refreshToken, {
        summary: pending.title,
        start: `${pending.date}T${pending.startTime}:00`,
        end: `${pending.date}T${pending.endTime}:00`,
        location: pending.location,
        attendees: pending.attendees,
        description: pending.description,
      }, calId)
      await deletePendingEvent(chatId)
      const linkStr = htmlLink ? ` [פתח](${htmlLink})` : ""
      await editMessage(chatId, messageId,
        `נוצר: *${pending.title}*\n${formatDate(`${pending.date}T${pending.startTime}:00`)}${linkStr}`)
    } catch (e: any) {
      console.error("[doc-bot] cal_select error:", e?.message ?? e)
      await editMessage(chatId, messageId, "שגיאה ביצירת האירוע. נסה שוב.")
    }
    return
  }
}

// ── Image → Event handler ─────────────────────────────────────────────────────

async function handleImageEvent(chatId: number, photo: any[], caption: string, refreshToken: string) {
  const largestPhoto = photo[photo.length - 1]
  const fileUrl = await getFileUrl(largestPhoto.file_id)
  const imgRes = await fetch(fileUrl)
  const buffer = await imgRes.arrayBuffer()
  const base64 = Buffer.from(buffer).toString("base64")

  const todayISO = new Date().toISOString()
  const parsed = await parseEventFromImage(base64, "image/jpeg", caption, todayISO)

  if (parsed.clarificationNeeded) {
    await savePendingEvent(chatId, {
      title: parsed.title || "",
      date: parsed.date || "",
      startTime: parsed.startTime || "",
      endTime: parsed.endTime || "",
      location: parsed.location,
      attendees: parsed.attendees,
      description: parsed.description,
      createdAt: Date.now(),
    })
    await sendMessage(chatId, `📸 זיהיתי אירוע: *${parsed.title}*\n\n${parsed.clarificationNeeded}`)
    return
  }

  await confirmOrCreateEvent(chatId, parsed, refreshToken)
}

// ── Event confirmation / calendar selection ───────────────────────────────────

async function confirmOrCreateEvent(chatId: number, parsed: any, refreshToken: string) {
  const { startDateTime } = buildISODateTimes(parsed)

  const calendars = await listUserCalendars(refreshToken)

  // Save calendar IDs alongside the event so the callback can look them up by index
  await savePendingEvent(chatId, {
    title: parsed.title,
    date: parsed.date,
    startTime: parsed.startTime,
    endTime: parsed.endTime,
    location: parsed.location,
    attendees: parsed.attendees,
    description: parsed.description,
    calendarIds: calendars.map((c) => c.id),
    createdAt: Date.now(),
  })

  const attendeeStr = parsed.attendees?.length ? `\n👥 ${parsed.attendees.join(", ")}` : ""
  const locationStr = parsed.location ? `\n📍 ${parsed.location}` : ""
  const text = `📅 *${parsed.title}*\n🗓 ${formatDate(startDateTime)}${locationStr}${attendeeStr}\n\nלאיזה יומן להוסיף?`

  await sendMessage(chatId, text, calendarKeyboard(calendars))
}

// ── Attendee resolution ───────────────────────────────────────────────────────
// Checks groups and Google Contacts for names mentioned in event text

async function resolveEventAttendees(
  refreshToken: string,
  chatId: number | string,
  text: string,
  summary: string
): Promise<{ name: string; email: string }[]> {
  const lower = text.toLowerCase()

  // 1. Check if any saved group name appears in the text
  try {
    const groups = await getUserGroups(chatId)
    for (const group of groups) {
      if (lower.includes(group.name.toLowerCase()) && group.members.length > 0) {
        return group.members
      }
    }
  } catch { /* ignore */ }

  // 2. Use Haiku to extract person names from the event text
  try {
    const Anthropic = (await import("@anthropic-ai/sdk")).default
    const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const res = await ai.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 80,
      system: "Extract person names from Hebrew event text. Return a JSON array of name strings only, e.g. [\"דני\",\"שי\"]. Return [] if no person names found. Do NOT include the event creator.",
      messages: [{ role: "user", content: summary }],
    })
    const raw = res.content[0].type === "text" ? res.content[0].text.trim() : "[]"
    const names: string[] = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim())
    if (!names.length) return []

    const found: { name: string; email: string }[] = []
    for (const name of names) {
      const contacts = await searchContacts(refreshToken, name)
      if (contacts.length === 1) found.push(contacts[0])
    }
    return found
  } catch {
    return []
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const secretHeader = req.headers.get("x-telegram-bot-api-secret-token")
  const rawBody = await req.text()

  if (!verifyTelegramWebhook(rawBody, secretHeader)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let update: any
  try {
    update = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  // ── Callback queries (button presses) ────────────────────────────────────
  if (update.callback_query) {
    const cbChatId = update.callback_query.message?.chat?.id
    if (cbChatId && isAllowedChat(cbChatId)) {
      await handleCallback(update)
    }
    return NextResponse.json({ ok: true })
  }

  const message = update?.message
  if (!message) return NextResponse.json({ ok: true })

  const chatId = message.chat?.id
  if (!chatId) return NextResponse.json({ ok: true })

  // ── Security ──────────────────────────────────────────────────────────────
  if (!isAllowedChat(chatId)) {
    await sendMessage(chatId, "⛔ גישה לא מורשית.")
    return NextResponse.json({ ok: true })
  }
  if (!checkRateLimit(chatId)) {
    await sendMessage(chatId, "⏳ יותר מדי בקשות. המתן דקה.")
    return NextResponse.json({ ok: true })
  }

  const rawText: string = message.text || message.caption || ""
  const text = sanitizeInput(rawText)
  const cmd = text.trim().split(/[\s@]/)[0].toLowerCase()

  // ── Commands ──────────────────────────────────────────────────────────────
  if (cmd === "/start") {
    await sendMessage(chatId,
      `👋 שלום! אני *דוק*, העוזר האישי שלך.\n\n` +
      `📅 יומן Google + תמונות\n⏰ תזכורות\n✅ משימות\n🔗 לינקים → Notion\n📁 Drive\n📧 מייל\n📝 רשימות\n💬 שאלות כלליות\n\n` +
      `שלח /connect לחיבור Google.`
    )
    return NextResponse.json({ ok: true })
  }

  if (cmd === "/connect") {
    try {
      const token = await createConnectToken(chatId)
      const url = `${process.env.NEXTAUTH_URL}/connect?token=${token}`
      await fetch(`${BASE_URL}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "🔗 חיבור Google - לחץ על הכפתור:",
          reply_markup: { inline_keyboard: [[{ text: "התחבר עם Google", url }]] },
        }),
      })
    } catch (e) {
      console.error("[doc-bot] connect error:", e)
      await sendMessage(chatId, "❌ שגיאה ביצירת קישור. נסה שוב.")
    }
    return NextResponse.json({ ok: true })
  }

  if (cmd === "/help" || cmd === "/?") {
    await sendMessage(chatId,
      `*📖 מדריך שימוש — דוק*\n\n` +

      `*📅 יומן Google*\n` +
      `"תוסיף ליומן דייט ביום שני ב-19:00"\n` +
      `"פגישה עם דני מחר ב-15:00 הכנס ליומן"\n` +
      `"מה יש לי ביומן השבוע?"\n` +
      `📸 שלח תמונה/screenshot → יוסיף ליומן אוטומטית\n` +
      `👥 אם תזכיר שם — ישאל אם לזמן אותו\n\n` +

      `*👥 קבוצות ואנשי קשר*\n` +
      `"צור קבוצה חברים מהלימודים עם דני, שי, יוסי"\n` +
      `"הצג קבוצות"\n` +
      `"מחק קבוצה חברים מהלימודים"\n` +
      `"חפש איש קשר דני"\n` +
      `💡 בעת קביעת אירוע עם שם קבוצה — יזמין את כולם\n\n` +

      `*⏰ תזכורות*\n` +
      `"תזכיר לי בעוד שעה לצלצל לאמא"\n` +
      `"תזכורת מחר ב-9:00 לשלוח דוח"\n` +
      `"תזכיר לי כל יום ראשון ב-20:00"\n` +
      `"מה התזכורות שלי?"\n\n` +

      `*✅ משימות Google Tasks*\n` +
      `"תוסיף משימה לסיים מצגת"\n` +
      `"תוסיף משימה לנקות תריסים מחר"\n` +
      `"מה המשימות שלי?"\n\n` +

      `*📝 רשימות*\n` +
      `"תוסיף חלב ולחם לרשימת קניות"\n` +
      `"תראה לי את רשימת הקניות"\n` +
      `"קניתי חלב" → מוחק מהרשימה אוטומטית\n` +
      `"נקה את רשימת הקניות"\n\n` +

      `*🔗 לינקים → Notion*\n` +
      `שלח URL — יסווג ויישמר אוטומטית\n\n` +

      `*📁 Google Drive*\n` +
      `"חפש בדרייב חוזה ינואר"\n\n` +

      `*📧 Gmail*\n` +
      `"תראה לי מיילים אחרונים"\n` +
      `"תשלח מייל לדני: נושא — תוכן"\n\n` +

      `*💬 שאלות כלליות*\n` +
      `כל שאלה חופשית — אני כאן\n\n` +

      `*פקודות:*\n` +
      `*/connect* — חיבור/חידוש Google\n` +
      `*/help* או */?* — מדריך זה`
    )
    return NextResponse.json({ ok: true })
  }

  // ── Photo handler ─────────────────────────────────────────────────────────
  if (message.photo) {
    await sendTyping(chatId)
    const user = await getUser(chatId)
    if (!user) {
      await sendMessage(chatId, "⚠️ לא מחובר ל-Google. שלח /connect.")
      return NextResponse.json({ ok: true })
    }
    try {
      await handleImageEvent(chatId, message.photo, text, user.refreshToken)
    } catch (e) {
      console.error("[doc-bot] image error:", e)
      await sendMessage(chatId, "❌ לא הצלחתי לקרוא את התמונה.")
    }
    return NextResponse.json({ ok: true })
  }

  if (!text) return NextResponse.json({ ok: true })

  await sendTyping(chatId)

  try {
    const user = await getUser(chatId)

    // ── Pending event clarification ─────────────────────────────────────────
    const pendingEvent = await getPendingEvent(chatId)
    if (pendingEvent && !pendingEvent.startTime) {
      // User is answering a clarification question about time
      const timeMatch = text.match(/(\d{1,2})(?::(\d{2}))?/)
      if (timeMatch) {
        const h = parseInt(timeMatch[1]).toString().padStart(2, "0")
        const m = (timeMatch[2] ?? "0").padStart(2, "0")
        pendingEvent.startTime = `${h}:${m}`
        const endH = (parseInt(h) + 1).toString().padStart(2, "0")
        pendingEvent.endTime = `${endH}:${m}`
        await savePendingEvent(chatId, pendingEvent)
        if (user) await confirmOrCreateEvent(chatId, pendingEvent as any, user.refreshToken)
        return NextResponse.json({ ok: true })
      }
    }

    // ── Reminder detection (deterministic parser) ───────────────────────────
    if (isReminderMessage(text)) {
      const parsed = parseReminderText(text)
      if ("error" in parsed) {
        await sendMessage(chatId, `⚠️ ${parsed.error}`)
      } else {
        const id = await addReminder(chatId, {
          message: parsed.message,
          remindAt: parsed.remindAt,
          recurrence: parsed.recurrence,
        })
        const recStr = parsed.recurrence ? ` (חוזר)` : ""
        await sendMessage(chatId, `⏰ *תזכורת נשמרה!*\n"${parsed.message}"\n📅 ${formatDate(parsed.remindAt.toISOString())}${recStr}`)
      }
      return NextResponse.json({ ok: true })
    }

    // ── Route everything else ───────────────────────────────────────────────
    const history = await getConversationHistory(chatId)
    const intent = await routeMessage(text, new Date(), history)

    // Intercept create_event — use router's extracted dates, then ask which calendar
    if (intent.action === "create_event" && user) {
      try {
        const { summary, start, end, attendees, location, description } = intent

        if (!start || !end || isNaN(new Date(start).getTime()) || isNaN(new Date(end).getTime())) {
          await sendMessage(chatId, "לא הצלחתי להבין את התאריך. נסה שוב עם תאריך ושעה ברורים.")
          return NextResponse.json({ ok: true })
        }

        // Convert ISO timestamps to Israel local time (handles any UTC offset from router)
        const toIsrael = (iso: string) => {
          const d = new Date(iso)
          return {
            date: new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Jerusalem" }).format(d),
            time: new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hour12: false }).format(d),
          }
        }
        const { date: datePart, time: startTime } = toIsrael(start)
        const { time: endTime } = toIsrael(end)

        const parsed = { title: summary, date: datePart, startTime, endTime, location, attendees, description }

        // Auto-detect attendees — only if router didn't already extract explicit emails
        if (!attendees?.length) {
          const suggestedAttendees = await resolveEventAttendees(user.refreshToken, chatId, text, summary)
          if (suggestedAttendees.length > 0) {
            await savePendingEvent(chatId, { ...parsed, suggestedAttendees, createdAt: Date.now() })
            const nameList = suggestedAttendees.map(a => `*${a.name}*`).join(", ")
            await sendMessage(chatId,
              `📅 *${summary}*\n🗓 ${formatDate(`${datePart}T${startTime}:00`)}` +
              (location ? `\n📍 ${location}` : "") +
              `\n\nלזמן גם את ${nameList}?`,
              inviteKeyboard()
            )
            return NextResponse.json({ ok: true })
          }
        }

        await confirmOrCreateEvent(chatId, parsed, user.refreshToken)
      } catch (e: any) {
        console.error("[doc-bot] create_event error:", e?.message ?? e)
        const msg = String(e?.message ?? "")
        if (msg.includes("invalid_grant") || msg.includes("Token has been expired") || msg.includes("unauthorized_client")) {
          await sendMessage(chatId, "פג תוקף החיבור ל-Google. שלח /connect להתחבר מחדש.")
        } else {
          await sendMessage(chatId, "שגיאה ביצירת האירוע. נסה שוב.")
        }
      }
      return NextResponse.json({ ok: true })
    }

    const reply = await handleIntent(intent, chatId, user?.refreshToken ?? null, text)
    await appendConversationHistory(chatId, text, reply)
    await sendMessage(chatId, reply)
  } catch (err) {
    console.error("[doc-bot] error:", err)
    await sendMessage(chatId, "❌ משהו השתבש. נסה שוב.")
  }

  return NextResponse.json({ ok: true })
}
