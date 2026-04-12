import { NextRequest, NextResponse } from "next/server"
import { getPendingReminders, updateReminder, deleteReminder } from "@/lib/db"
import { nextOccurrence } from "@/lib/reminder-parser"

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
        inline_keyboard: [[
          { text: "✅ בוצע", callback_data: `rem_done:${reminderId}` },
          { text: "😤 נודניק (+10)", callback_data: `rem_snooze10:${reminderId}` },
          { text: "⏰ +שעה", callback_data: `rem_snooze60:${reminderId}` },
        ]],
      },
    }),
  })
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization")
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
      await deleteReminder(reminder.chatId, reminder.id)
    }
  }

  return NextResponse.json({ processed: pending.length })
}
