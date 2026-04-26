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
  removeFromList,
  savePendingEmail,
  getPendingEmail,
  deletePendingEmail,
  createConnectToken,
  saveGroup,
  getUserGroups,
  deleteGroup,
  addMembersToGroup,
  getPendingEvent,
  savePendingEvent,
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
    "create_group",
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
      // Escape Markdown v1 special chars in dynamic content to prevent silent Telegram failures
      const esc = (s: string) => s.replace(/[_*[\]`]/g, "\\$&")
      const lines = [
        `${emoji} *${type}* — נשמר ב-Notion!`,
        "",
        title ? `📌 *כותרת:* ${esc(title)}` : null,
        summary ? `📝 *סיכום:* ${esc(summary)}` : null,
        `🌐 *מקור:* ${esc(source)}`,
        tags.length > 0 ? `🏷 *תגיות:* ${tags.map(esc).join(" · ")}` : null,
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
      const dueDateStr = due ? new Date(due + "T12:00:00Z").toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem", weekday: "short", day: "numeric", month: "short" }) : null
      return `✅ *משימה נוספה:* "${title}"${dueDateStr ? `\n📅 עד: ${dueDateStr}` : ""}`
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

    case "remove_from_list": {
      const query = intent.item.toLowerCase()
      const lists = await getUserLists(chatId)
      const removed: string[] = []

      for (const listName of lists) {
        const items = await getList(chatId, listName)
        for (const item of items) {
          const itemLower = item.text.toLowerCase()
          // Match if the query contains the item or the item contains the query
          if (itemLower.includes(query) || query.includes(itemLower)) {
            await removeFromList(chatId, listName, item.id)
            removed.push(`"${item.text}" מרשימת ${listName}`)
          }
        }
      }

      if (removed.length === 0) return `לא מצאתי "${intent.item}" באף רשימה.`
      return `✅ ${removed.join("\n✅ ")}`
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

    // ── Groups ────────────────────────────────────────────────────────────────
    case "create_group": {
      const { groupName, memberNames } = intent
      const EMAIL_RE = /([^\s@]+@[^\s@]+\.[^\s@]+)/
      const resolved: { name: string; email: string }[] = []
      const unresolved: string[] = []

      for (const raw of memberNames) {
        // Format: "דני (dani@gmail.com)" — email explicitly provided
        const emailMatch = raw.match(EMAIL_RE)
        if (emailMatch) {
          // Strip email + surrounding separators (—, -, :, spaces, parentheses)
          const name = raw.replace(EMAIL_RE, "").replace(/[\s\-—:()\u2014]+$/, "").trim()
          resolved.push({ name: name || raw.trim(), email: emailMatch[1] })
          continue
        }
        // Otherwise search Google Contacts by name
        const results = await searchContacts(refreshToken!, raw)
        if (results.length === 1) {
          resolved.push(results[0])
        } else if (results.length > 1) {
          const best = results.find(r => r.name.toLowerCase().includes(raw.toLowerCase()))
          if (best) resolved.push(best)
          else unresolved.push(raw)
        } else {
          unresolved.push(raw)
        }
      }

      await saveGroup(chatId, { name: groupName, members: resolved, createdAt: Date.now() })
      const memberLines = resolved.map(m => `• ${m.name} (${m.email})`).join("\n")
      const unresolvedStr = unresolved.length
        ? `\n\n⚠️ לא נמצאו (הוסף מייל בסוגריים):\n${unresolved.map(n => `• ${n}`).join("\n")}`
        : ""
      return `👥 *קבוצה נשמרה: "${groupName}"*\n\n${memberLines}${unresolvedStr}`
    }

    case "add_to_group": {
      const { groupName, memberNames } = intent
      const EMAIL_RE = /([^\s@]+@[^\s@]+\.[^\s@]+)/
      const resolved: { name: string; email: string }[] = []
      const unresolved: string[] = []

      for (const raw of memberNames) {
        const emailMatch = raw.match(EMAIL_RE)
        if (emailMatch) {
          const name = raw.replace(EMAIL_RE, "").replace(/[\s\-—:()\u2014]+$/, "").trim()
          resolved.push({ name: name || raw.trim(), email: emailMatch[1] })
          continue
        }
        const results = await searchContacts(refreshToken!, raw)
        if (results.length === 1) {
          resolved.push(results[0])
        } else if (results.length > 1) {
          const best = results.find(r => r.name.toLowerCase().includes(raw.toLowerCase()))
          if (best) resolved.push(best)
          else unresolved.push(raw)
        } else {
          unresolved.push(raw)
        }
      }

      const updated = await addMembersToGroup(chatId, groupName, resolved)
      if (!updated) return `❌ לא נמצאה קבוצה בשם "${groupName}".`

      const addedStr = resolved.map(m => `• ${m.name} (${m.email})`).join("\n")
      const unresolvedStr = unresolved.length
        ? `\n\n⚠️ לא נמצאו: ${unresolved.join(", ")}`
        : ""
      return `✅ *נוסף לקבוצה "${groupName}":*\n${addedStr}${unresolvedStr}\n\nסה"כ בקבוצה: ${updated.members.length} אנשים`
    }

    case "list_groups": {
      const groups = await getUserGroups(chatId)
      if (groups.length === 0) return "👥 אין קבוצות שמורות.\n\nכדי ליצור: \"צור קבוצה חברים מהלימודים עם דני, שי\""
      const lines = groups.map(g => `*${g.name}* — ${g.members.map(m => m.name).join(", ")}`)
      return `👥 *הקבוצות שלך:*\n\n${lines.join("\n")}`
    }

    case "delete_group": {
      await deleteGroup(chatId, intent.groupName)
      return `🗑 קבוצת "${intent.groupName}" נמחקה.`
    }

    // ── Connect ───────────────────────────────────────────────────────────────
    case "connect_google": {
      const token = await createConnectToken(chatId)
      const url = `${process.env.NEXTAUTH_URL}/connect?token=${token}`
      return `🔗 *חיבור Google*\n\nלחץ על הקישור כדי להתחבר:\n${url}\n\n_הקישור תקף ל-10 דקות._`
    }

    case "invite_attendee": {
      if (!refreshToken) return "⚠️ לא מחובר ל-Google. שלח /connect."
      const contacts = await searchContacts(refreshToken, intent.name)
      if (contacts.length === 0) return `❌ לא נמצא איש קשר בשם "${intent.name}".`
      const contact = contacts[0]
      const pending = await getPendingEvent(chatId)
      if (pending) {
        pending.attendees = [...(pending.attendees ?? []), contact.email]
        await savePendingEvent(chatId, pending)
        return `✅ ${contact.name} יוזמן לאירוע "${pending.title}".`
      }
      return `✅ ${contact.name} (${contact.email}) — אין אירוע ממתין להוסיף אליו.`
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
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        system: `אתה עוזר אישי בשם דוק. ענה תמיד בעברית תקינה וטבעית, אלא אם המשתמש כתב באנגלית. היה קצר, ברור וידידותי.

היכולות שלך כבוט:
- יומן Google: הוספה וצפייה באירועים
- תזכורות
- משימות Google Tasks: הוספה וצפייה
- חיפוש קבצים ב-Google Drive לפי שם בלבד (לא קריאה, לא יצירה, לא עריכה)
- Gmail: קריאת מיילים אחרונים ושליחת מייל
- אנשי קשר Google: חיפוש בלבד
- רשימות (קניות וכד')
- שמירת לינקים ל-Notion

אם המשתמש שואל אם אתה יכול לעשות משהו שלא ברשימה זו — אמור בפירוש שלא תומך בזה.`,
        messages: [{ role: "user", content: userMessage }],
      })
      return res.content[0].type === "text" ? res.content[0].text : "לא הצלחתי לענות."
    }
  }
}
