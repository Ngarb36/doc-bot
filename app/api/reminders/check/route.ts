import { NextRequest, NextResponse } from "next/server"
import { getPendingReminders, updateReminder, deleteReminder, getDailyUsers, getDailyTasks, wasDailySent, markDailySent, getDailyNotificationTime } from "@/lib/db"
import { nextOccurrence } from "@/lib/reminder-parser"
import type { DailyTask } from "@/lib/db"

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!
const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`

async function sendReminderMessage(chatId: string, reminderId: string, text: string) {
  await fetch(`${BASE_URL}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ בוצע", callback_data: `rem_done:${reminderId}` },
            { text: "😤 +10 דק'", callback_data: `rem_snooze10:${reminderId}` },
            { text: "⏰ +שעה", callback_data: `rem_snooze60:${reminderId}` },
          ],
          [
            { text: "📅 מחר (24 שעות)", callback_data: `rem_snooze1440:${reminderId}` },
          ],
        ],
      },
    }),
  })
}

async function sendDailyTasksMessage(chatId: string, tasks: DailyTask[]) {
  const pending = tasks.filter(t => !t.done)
  const lines = pending.map((t, i) => `${i + 1}. ${t.text}`)
  await fetch(`${BASE_URL}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: `📋 *המשימות שלך להיום:*\n\n${lines.join("\n")}\n\n_${pending.length} משימות — בהצלחה! 💪_`,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: pending.map((t, i) => [{
          text: `✅ ${i + 1}. ${t.text.slice(0, 40)}`,
          callback_data: `daily_done:${t.id}`,
        }]),
      },
    }),
  })
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization")
  console.log("[cron] received:", JSON.stringify(authHeader))
  console.log("[cron] expected:", JSON.stringify(`Bearer ${process.env.CRON_SECRET}`))
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const pending = await getPendingReminders()

  for (const reminder of pending) {
    await sendReminderMessage(reminder.chatId, reminder.id, `⏰ *תזכורת:* ${reminder.message}`)

    if (reminder.recurrence) {
      const next = nextOccurrence(reminder.recurrence)
      if (next) {
        await updateReminder(reminder.id, { remindAt: next.getTime() })
      } else {
        await deleteReminder(reminder.chatId, reminder.id)
      }
    } else {
      // No response = auto-reschedule 24h after original fire time
      await updateReminder(reminder.id, { remindAt: reminder.remindAt + 24 * 60 * 60 * 1000 })
    }
  }

  // ── Daily tasks notification — per-user configurable time ─────────────────
  const now = new Date()
  const israelHour = parseInt(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem", hour: "numeric", hour12: false,
  }).format(now))
  const nowMin = now.getMinutes()
  const dateStr = now.toLocaleDateString("sv-SE", { timeZone: "Asia/Jerusalem" })
  const users = await getDailyUsers()

  let dailySent = 0
  for (const userId of users) {
    const { hour, minute } = await getDailyNotificationTime(userId)
    if (israelHour !== hour || nowMin < minute - 1 || nowMin > minute + 1) continue
    if (await wasDailySent(userId, dateStr)) continue
    const tasks = await getDailyTasks(userId)
    if (!tasks.some(t => !t.done)) continue
    await sendDailyTasksMessage(userId, tasks)
    await markDailySent(userId, dateStr)
    dailySent++
  }

  return NextResponse.json({ processed: pending.length, dailySent })
}
