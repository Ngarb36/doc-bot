import { kv } from "@vercel/kv"
import { randomBytes } from "crypto"

const P = "doc:" // namespace prefix — keeps DocBot keys separate from CaliBot in shared KV

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UserRecord {
  refreshToken: string
  email: string
  connectedAt: string
}

export interface Reminder {
  id: string
  chatId: string
  message: string
  remindAt: number
  recurrence?: string
  createdAt: number
}

export interface ListItem {
  id: string
  text: string
  done: boolean
  addedAt: number
}

// ── Connect tokens ────────────────────────────────────────────────────────────

export async function createConnectToken(chatId: string | number): Promise<string> {
  const token = randomBytes(20).toString("hex")
  await kv.set(`${P}connect_token:${token}`, String(chatId), { ex: 600 })
  return token
}

export async function resolveConnectToken(token: string): Promise<string | null> {
  return kv.getdel<string>(`${P}connect_token:${token}`)
}

// ── Users ─────────────────────────────────────────────────────────────────────

export async function getUser(chatId: string | number): Promise<UserRecord | null> {
  return kv.get<UserRecord>(`${P}user:${chatId}`)
}

export async function saveUser(
  chatId: string | number,
  data: { refreshToken: string; email: string }
): Promise<void> {
  await kv.set(`${P}user:${chatId}`, { ...data, connectedAt: new Date().toISOString() })
}

// ── Reminders ─────────────────────────────────────────────────────────────────

export async function addReminder(
  chatId: string | number,
  data: { message: string; remindAt: Date; recurrence?: string }
): Promise<string> {
  const id = randomBytes(16).toString("hex")
  const reminder: Reminder = {
    id,
    chatId: String(chatId),
    message: data.message,
    remindAt: data.remindAt.getTime(),
    recurrence: data.recurrence,
    createdAt: Date.now(),
  }
  await kv.set(`${P}reminder:${id}`, reminder)
  await kv.sadd(`${P}reminders:${chatId}`, id)
  await kv.sadd(`${P}all_reminders`, id)
  return id
}

export async function getReminder(id: string): Promise<Reminder | null> {
  return kv.get<Reminder>(`${P}reminder:${id}`)
}

export async function updateReminder(id: string, patch: Partial<Reminder>): Promise<void> {
  const existing = await getReminder(id)
  if (!existing) return
  await kv.set(`${P}reminder:${id}`, { ...existing, ...patch })
}

export async function deleteReminder(chatId: string | number, id: string): Promise<void> {
  await kv.del(`${P}reminder:${id}`)
  await kv.srem(`${P}reminders:${chatId}`, id)
  await kv.srem(`${P}all_reminders`, id)
}

export async function getUserReminders(chatId: string | number): Promise<Reminder[]> {
  const ids = await kv.smembers<string[]>(`${P}reminders:${chatId}`)
  if (!ids || ids.length === 0) return []
  const reminders = await Promise.all(ids.map((id) => kv.get<Reminder>(`${P}reminder:${id}`)))
  return reminders
    .filter((r): r is Reminder => r !== null)
    .sort((a, b) => a.remindAt - b.remindAt)
}

export async function getPendingReminders(): Promise<Reminder[]> {
  const ids = await kv.smembers<string[]>(`${P}all_reminders`)
  if (!ids || ids.length === 0) return []
  const now = Date.now()
  const reminders = await Promise.all(ids.map((id) => kv.get<Reminder>(`${P}reminder:${id}`)))
  return reminders.filter((r): r is Reminder => r !== null && r.remindAt <= now)
}

// ── Lists ─────────────────────────────────────────────────────────────────────

export async function getList(
  chatId: string | number,
  listName: string
): Promise<ListItem[]> {
  const key = `${P}list:${chatId}:${listName.toLowerCase()}`
  return (await kv.get<ListItem[]>(key)) ?? []
}

export async function addToList(
  chatId: string | number,
  listName: string,
  text: string
): Promise<void> {
  const items = await getList(chatId, listName)
  const item: ListItem = {
    id: randomBytes(8).toString("hex"),
    text,
    done: false,
    addedAt: Date.now(),
  }
  const key = `${P}list:${chatId}:${listName.toLowerCase()}`
  await kv.set(key, [...items, item])
  await kv.sadd(`${P}lists:${chatId}`, listName.toLowerCase())
}

export async function removeFromList(
  chatId: string | number,
  listName: string,
  itemId: string
): Promise<void> {
  const items = await getList(chatId, listName)
  const key = `${P}list:${chatId}:${listName.toLowerCase()}`
  await kv.set(key, items.filter((i) => i.id !== itemId))
}

export async function clearList(
  chatId: string | number,
  listName: string
): Promise<void> {
  const key = `${P}list:${chatId}:${listName.toLowerCase()}`
  await kv.del(key)
}

export async function getUserLists(chatId: string | number): Promise<string[]> {
  return (await kv.smembers<string[]>(`${P}lists:${chatId}`)) ?? []
}

// ── Conversation history ──────────────────────────────────────────────────────

export interface ConversationMessage {
  role: "user" | "assistant"
  content: string
}

export async function getConversationHistory(chatId: string | number): Promise<ConversationMessage[]> {
  return (await kv.get<ConversationMessage[]>(`${P}history:${chatId}`)) ?? []
}

export async function appendConversationHistory(
  chatId: string | number,
  userMsg: string,
  assistantMsg: string
): Promise<void> {
  const history = await getConversationHistory(chatId)
  const updated = [
    ...history,
    { role: "user" as const, content: userMsg },
    { role: "assistant" as const, content: assistantMsg },
  ].slice(-10) // keep last 5 exchanges
  await kv.set(`${P}history:${chatId}`, updated, { ex: 3600 }) // 1 hour TTL
}

// ── Pending calendar events (awaiting clarification or calendar selection) ───

export interface PendingEvent {
  title: string
  date: string
  startTime: string
  endTime: string
  location?: string
  attendees?: string[]
  description?: string
  calendarIds?: string[]   // stored so callback only needs an index
  createdAt: number
}

export async function savePendingEvent(chatId: string | number, event: PendingEvent): Promise<void> {
  await kv.set(`${P}pending_event:${chatId}`, event, { ex: 600 })
}

export async function getPendingEvent(chatId: string | number): Promise<PendingEvent | null> {
  return kv.get<PendingEvent>(`${P}pending_event:${chatId}`)
}

export async function deletePendingEvent(chatId: string | number): Promise<void> {
  await kv.del(`${P}pending_event:${chatId}`)
}

// ── Pending Gmail confirmations ───────────────────────────────────────────────

export interface PendingEmail {
  to: string
  subject: string
  body: string
  createdAt: number
}

export async function savePendingEmail(
  chatId: string | number,
  email: PendingEmail
): Promise<void> {
  await kv.set(`${P}pending_email:${chatId}`, email, { ex: 300 }) // 5 min TTL
}

export async function getPendingEmail(
  chatId: string | number
): Promise<PendingEmail | null> {
  return kv.get<PendingEmail>(`${P}pending_email:${chatId}`)
}

export async function deletePendingEmail(chatId: string | number): Promise<void> {
  await kv.del(`${P}pending_email:${chatId}`)
}
