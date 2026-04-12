import {
  createCalendarEvent,
  listCalendarEvents,
  listTasks,
  addTask,
  completeTask,
  searchDrive,
  searchContacts,
  getRecentEmails,
  sendEmail,
} from "./google"
import { saveLink } from "./notion"
import { classifyLink } from "./classifier"
import {
  addReminder,
  getUserReminders,
  addToList,
  getList,
  clearList,
  getUserLists,
  savePendingEmail,
  getPendingEmail,
  deletePendingEmail,
  createConnectToken,
} from "./db"
import type { Intent } from "./router"

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("he-IL", {
      timeZone: "Asia/Jerusalem",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  } catch {
    return iso
  }
}

const TYPE_EMOJI: Record<string, string> = {
  video: "🎬", article: "📰", tutorial: "📚", documentation: "📖", tool: "🛠️", other: "🔗",
}

export async function handleIntent(
  intent: Intent,
  chatId: string | number,
  refreshToken: string | null,
  originalText = ""
): Promise<string> {
  const needsGoogle = [
    "create_event", "list_events", "add_task", "list_tasks", "complete_task",
    "search_drive", "read_emails", "send_email", "search_contacts", "confirm_send_email",
  ]

  if (needsGoogle.includes(intent.action) && !refreshToken) {
    return "⚠️ לא מחובר ל-Google. שלח /connect כדי להתחבר."
  }

  switch (intent.action) {
    // ── Links ────────────────────────────────────────────────────────────────
    case "save_link": {
      const { url, note } = intent
      const { type, title, summary, tags } = await classifyLink(url, note)
      await saveLink({ url, type, title, summary, tags, senderName: String(chatId) })
      const emoji = TYPE_EMOJI[type] ?? "🔗"
      const source = (() => { try { return new URL(url).hostname.replace("www.", "") } catch { return url } })()
      const lines = [
        `${emoji} *${type}* — נשמר ב-Notion!`,
        "",
        title ? `📌 *כותרת:* ${title}` : null,
        summary ? `📝 *סיכום:* ${summary}` : null,
        `🌐 *מקור:* ${source}`,
        tags.length > 0 ? `🏷 *תגיות:* ${tags.join(" · ")}` : null,
      ]
      return lines.filter(Boolean).join("\n")
    }

    // ── Calendar ─────────────────────────────────────────────────────────────
    case "create_event": {
      const { summary, start, end, attendees, location, description } = intent
      if (!start || !end || isNaN(new Date(start).getTime()) || isNaN(new Date(end).getTime())) {
        return "❌ לא הצלחתי להבין את התאריך. נסה לציין תאריך ושעה מדויקים, למשל: 'מחר בשעה 10:00 למשך שעה'."
      }
      const htmlLink = await createCalendarEvent(refreshToken!, { summary, start, end, attendees, location, description })
      const attendeeStr = attendees?.length ? `\n👥 *משתתפים:* ${attendees.join(", ")}` : ""
      const linkStr = htmlLink ? `\n🔗 [פתח ביומן](${htmlLink})` : ""
      return `✅ *אירוע נוצר!*\n📅 *${summary}*\n🕐 ${formatDate(start)} → ${formatDate(end)}${attendeeStr}${linkStr}`
    }

    case "list_events": {
      const { days } = intent
      const events = await listCalendarEvents(refreshToken!, days)
      if (events.length === 0) return `📅 אין אירועים ב-${days} הימים הקרובים.`
      const lines = events.map((e) => `• *${e.summary}*\n  ${formatDate(e.start)}`)
      return `📅 *האירועים הקרובים:*\n\n${lines.join("\n\n")}`
    }

    // ── Reminders ────────────────────────────────────────────────────────────
    case "add_reminder": {
      const { message, remindAt, recurrence } = intent
      const remindDate = new Date(remindAt)
      await addReminder(chatId, { message, remindAt: remindDate, recurrence })
      const recStr = recurrence ? ` (חוזר: ${recurrence})` : ""
      return `⏰ *תזכורת נשמרה!*\n"${message}"\n📅 ${formatDate(remindAt)}${recStr}`
    }

    case "list_reminders": {
      const reminders = await getUserReminders(chatId)
      if (reminders.length === 0) return "⏰ אין תזכורות פעילות."
      const lines = reminders.map((r, i) => `${i + 1}. "${r.message}"\n   📅 ${formatDate(new Date(r.remindAt).toISOString())}`)
      return `⏰ *התזכורות שלך:*\n\n${lines.join("\n\n")}`
    }

    // ── Tasks ─────────────────────────────────────────────────────────────────
    case "add_task": {
      const { title, due } = intent
      await addTask(refreshToken!, title, due)
      return `✅ *משימה נוספה:* "${title}"${due ? `\n📅 עד: ${formatDate(due)}` : ""}`
    }

    case "list_tasks": {
      const tasks = await listTasks(refreshToken!)
      if (tasks.length === 0) return "✅ אין משימות פתוחות. כל הכבוד!"
      const lines = tasks.map((t, i) => {
        const dueStr = t.due ? ` — עד ${new Date(t.due).toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem", day: "numeric", month: "short" })}` : ""
        return `${i + 1}. ${t.title}${dueStr}`
      })
      return `📋 *המשימות שלך:*\n\n${lines.join("\n")}`
    }

    case "complete_task": {
      await completeTask(refreshToken!, intent.taskId)
      return "✅ משימה סומנה כהושלמה!"
    }

    // ── Drive ─────────────────────────────────────────────────────────────────
    case "search_drive": {
      const files = await searchDrive(refreshToken!, intent.query)
      if (files.length === 0) return `📁 לא נמצאו קבצים עבור "${intent.query}".`
      const lines = files.map((f) => `📄 [${f.name}](${f.webViewLink})`)
      return `📁 *תוצאות חיפוש ב-Drive:*\n\n${lines.join("\n")}`
    }

    // ── Lists ─────────────────────────────────────────────────────────────────
    case "add_to_list": {
      const { listName, items } = intent
      for (const item of items) {
        await addToList(chatId, listName, item)
      }
      return `📝 *נוסף לרשימת "${listName}":*\n${items.map((i) => `• ${i}`).join("\n")}`
    }

    case "show_list": {
      const items = await getList(chatId, intent.listName)
      if (items.length === 0) return `📝 הרשימה "${intent.listName}" ריקה.`
      const lines = items.map((item, i) => `${i + 1}. ${item.text}`)
      return `📝 *רשימת "${intent.listName}":*\n\n${lines.join("\n")}`
    }

    case "clear_list": {
      await clearList(chatId, intent.listName)
      return `🗑 רשימת "${intent.listName}" נוקתה.`
    }

    // ── Contacts ──────────────────────────────────────────────────────────────
    case "search_contacts": {
      const contacts = await searchContacts(refreshToken!, intent.query)
      if (contacts.length === 0) return `👥 לא נמצאו אנשי קשר עבור "${intent.query}".`
      const lines = contacts.map((c) => `• *${c.name}* — ${c.email}`)
      return `👥 *תוצאות חיפוש:*\n\n${lines.join("\n")}`
    }

    // ── Gmail ─────────────────────────────────────────────────────────────────
    case "read_emails": {
      const emails = await getRecentEmails(refreshToken!, intent.count)
      if (emails.length === 0) return "📧 אין מיילים חדשים."
      const lines = emails.map((e, i) => `${i + 1}. *${e.subject}*\n   מ: ${e.from}\n   ${e.snippet}`)
      return `📧 *מיילים אחרונים:*\n\n${lines.join("\n\n")}`
    }

    case "send_email": {
      const { to, subject, body } = intent
      // Check if "to" is a name (not email) - search contacts first
      const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)
      let resolvedEmail = to

      if (!isEmail) {
        const contacts = await searchContacts(refreshToken!, to)
        if (contacts.length === 0) return `👥 לא נמצא איש קשר בשם "${to}". נסה לציין מייל ישירות.`
        if (contacts.length > 1) {
          const lines = contacts.map((c, i) => `${i + 1}. ${c.name} — ${c.email}`)
          return `👥 מצאתי מספר תוצאות:\n${lines.join("\n")}\n\nציין את המייל המדויק.`
        }
        resolvedEmail = contacts[0].email
      }

      await savePendingEmail(chatId, { to: resolvedEmail, subject, body, createdAt: Date.now() })
      return `📧 *אישור שליחת מייל:*\n\n*אל:* ${resolvedEmail}\n*נושא:* ${subject}\n*תוכן:*\n${body}\n\n---\nלשלוח? ענה *כן* או *לא*.`
    }

    case "confirm_send_email": {
      const pending = await getPendingEmail(chatId)
      if (!pending) return "❌ אין מייל ממתין לשליחה."
      await sendEmail(refreshToken!, pending.to, pending.subject, pending.body)
      await deletePendingEmail(chatId)
      return `✅ *מייל נשלח!*\n*אל:* ${pending.to}\n*נושא:* ${pending.subject}`
    }

    case "cancel_send_email": {
      await deletePendingEmail(chatId)
      return "❌ שליחת המייל בוטלה."
    }

    // ── Connect ───────────────────────────────────────────────────────────────
    case "connect_google": {
      const token = await createConnectToken(chatId)
      const url = `${process.env.NEXTAUTH_URL}/connect?token=${token}`
      return `🔗 *חיבור Google*\n\nלחץ על הקישור כדי להתחבר:\n${url}\n\n_הקישור תקף ל-10 דקות._`
    }

    // ── Chat ──────────────────────────────────────────────────────────────────
    case "chat":
    case "unknown":
    default: {
      const userMessage = "message" in intent && intent.message ? intent.message : originalText
      if (!userMessage) return "שלום! במה אוכל לעזור?"
      const Anthropic = (await import("@anthropic-ai/sdk")).default
      const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const res = await ai.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1000,
        system: "אתה עוזר אישי בשם דוק. ענה בעברית אלא אם המשתמש כתב באנגלית. היה קצר, ברור וידידותי.",
        messages: [{ role: "user", content: userMessage }],
      })
      return res.content[0].type === "text" ? res.content[0].text : "לא הצלחתי לענות."
    }
  }
}
