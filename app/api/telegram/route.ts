import { NextRequest, NextResponse } from "next/server"
import { isAllowedChat, verifyTelegramWebhook, checkRateLimit, sanitizeInput } from "@/lib/security"
import { getUser, createConnectToken } from "@/lib/db"
import { routeMessage } from "@/lib/router"
import { handleIntent } from "@/lib/handlers"

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!
const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`

async function sendMessage(chatId: number | string, text: string) {
  await fetch(`${BASE_URL}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  })
}

async function sendTyping(chatId: number | string) {
  await fetch(`${BASE_URL}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  })
}

export async function POST(req: NextRequest) {
  // ── Security: verify webhook signature ──────────────────────────────────
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

  const message = update?.message
  if (!message) return NextResponse.json({ ok: true })

  const chatId = message.chat?.id
  const rawText: string = message.text || message.caption || ""

  if (!chatId || !rawText) return NextResponse.json({ ok: true })

  // ── Security: allowlist check ────────────────────────────────────────────
  if (!isAllowedChat(chatId)) {
    await sendMessage(chatId, "⛔ גישה לא מורשית.")
    return NextResponse.json({ ok: true })
  }

  // ── Security: rate limiting ──────────────────────────────────────────────
  if (!checkRateLimit(chatId)) {
    await sendMessage(chatId, "⏳ יותר מדי בקשות. המתן דקה.")
    return NextResponse.json({ ok: true })
  }

  const text = sanitizeInput(rawText)

  // ── Handle commands ──────────────────────────────────────────────────────
  if (text === "/start") {
    await sendMessage(
      chatId,
      `👋 שלום! אני *דוק*, העוזר האישי שלך.\n\n` +
      `אני יכול לעזור לך עם:\n` +
      `📅 יומן Google\n` +
      `⏰ תזכורות\n` +
      `✅ משימות\n` +
      `🔗 שמירת לינקים ל-Notion\n` +
      `📁 חיפוש ב-Drive\n` +
      `📧 מיילים\n` +
      `📝 ניהול רשימות\n` +
      `💬 שאלות כלליות\n\n` +
      `כדי להתחיל, שלח /connect לחיבור Google.`
    )
    return NextResponse.json({ ok: true })
  }

  if (text === "/connect") {
    const token = await createConnectToken(chatId)
    const url = `${process.env.NEXTAUTH_URL}/connect?token=${token}`
    await sendMessage(chatId, `🔗 חיבור Google\n\nלחץ על הקישור:\n${url}\n\nתקף ל-10 דקות.`)
    return NextResponse.json({ ok: true })
  }

  if (text === "/help") {
    await sendMessage(
      chatId,
      `*פקודות:*\n` +
      `/connect — חיבור Google\n` +
      `/help — עזרה\n\n` +
      `*דוגמאות:*\n` +
      `"תזמן פגישה עם דני מחר ב-3"\n` +
      `"הזכר לי לקנות חלב בשעה 18"\n` +
      `"מה יש לי ביומן השבוע?"\n` +
      `"תוסיף חלב לרשימת קניות"\n` +
      `"חפש בדרייב דוח ינואר"\n` +
      `"מה הפרוייקטים הבאים שלי?"\n` +
      `שליחת לינק — שמירה אוטומטית ל-Notion`
    )
    return NextResponse.json({ ok: true })
  }

  // ── Process message ──────────────────────────────────────────────────────
  await sendTyping(chatId)

  try {
    const user = await getUser(chatId)
    const intent = await routeMessage(text, new Date())
    const reply = await handleIntent(intent, chatId, user?.refreshToken ?? null)
    await sendMessage(chatId, reply)
  } catch (err) {
    console.error("[doc-bot] error:", err)
    await sendMessage(chatId, "❌ משהו השתבש. נסה שוב.")
  }

  return NextResponse.json({ ok: true })
}
