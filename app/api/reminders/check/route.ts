import { NextRequest, NextResponse } from "next/server"
import { getPendingReminders, updateReminder, deleteReminder } from "@/lib/db"

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!
const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`

async function sendMessage(chatId: string, text: string) {
  await fetch(`${BASE_URL}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  })
}

function nextRecurrence(remindAt: number, recurrence: string): number {
  const d = new Date(remindAt)
  switch (recurrence) {
    case "daily": d.setDate(d.getDate() + 1); break
    case "weekly": d.setDate(d.getDate() + 7); break
    case "monthly": d.setMonth(d.getMonth() + 1); break
  }
  return d.getTime()
}

export async function GET(req: NextRequest) {
  // Verify this is a legitimate cron call
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const pending = await getPendingReminders()

  for (const reminder of pending) {
    await sendMessage(reminder.chatId, `⏰ *תזכורת:* ${reminder.message}`)

    if (reminder.recurrence) {
      const nextTime = nextRecurrence(reminder.remindAt, reminder.recurrence)
      await updateReminder(reminder.id, { remindAt: nextTime })
    } else {
      await deleteReminder(reminder.chatId, reminder.id)
    }
  }

  return NextResponse.json({ processed: pending.length })
}
