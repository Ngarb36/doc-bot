import { google } from "googleapis"

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.NEXTAUTH_URL + "/api/auth/callback/google"
  )
}

export function getAuthenticatedClient(refreshToken: string) {
  const auth = getOAuth2Client()
  auth.setCredentials({ refresh_token: refreshToken })
  return auth
}

// ── Calendar ──────────────────────────────────────────────────────────────────

export async function listUserCalendars(refreshToken: string): Promise<{ id: string; name: string }[]> {
  const auth = getAuthenticatedClient(refreshToken)
  const calendar = google.calendar({ version: "v3", auth })
  const res = await calendar.calendarList.list({ minAccessRole: "writer" })
  return (res.data.items ?? []).map((c) => ({ id: c.id ?? "primary", name: c.summary ?? "Calendar" }))
}

export async function createCalendarEvent(
  refreshToken: string,
  event: {
    summary: string
    description?: string
    start: string
    end: string
    attendees?: string[]
    location?: string
  },
  calendarId = "primary"
): Promise<string | null> {
  const auth = getAuthenticatedClient(refreshToken)
  const calendar = google.calendar({ version: "v3", auth })

  const res = await calendar.events.insert({
    calendarId,
    sendUpdates: event.attendees?.length ? "all" : "none",
    requestBody: {
      summary: event.summary,
      description: event.description,
      location: event.location,
      start: { dateTime: event.start, timeZone: "Asia/Jerusalem" },
      end: { dateTime: event.end, timeZone: "Asia/Jerusalem" },
      attendees: event.attendees?.map((email) => ({ email })),
    },
  })
  return res.data.htmlLink ?? null
}

export async function listCalendarEvents(
  refreshToken: string,
  days = 7
): Promise<{ summary: string; start: string; end: string }[]> {
  const auth = getAuthenticatedClient(refreshToken)
  const calendar = google.calendar({ version: "v3", auth })

  const now = new Date()
  const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: now.toISOString(),
    timeMax: future.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 20,
  })

  return (res.data.items ?? []).map((e) => ({
    summary: e.summary ?? "(ללא שם)",
    start: e.start?.dateTime ?? e.start?.date ?? "",
    end: e.end?.dateTime ?? e.end?.date ?? "",
  }))
}

export async function searchCalendarEvents(
  refreshToken: string,
  query: string,
  dateHint?: string
): Promise<{ id: string; calendarId: string; summary: string; start: string; end: string; attendees: string[] }[]> {
  const auth = getAuthenticatedClient(refreshToken)
  const calendar = google.calendar({ version: "v3", auth })

  let timeMin: string
  let timeMax: string
  if (dateHint) {
    const d = new Date(dateHint + "T00:00:00+03:00")
    timeMin = new Date(d.getTime() - 24 * 3600000).toISOString()
    timeMax = new Date(d.getTime() + 48 * 3600000).toISOString()
  } else {
    timeMin = new Date().toISOString()
    timeMax = new Date(Date.now() + 90 * 24 * 3600000).toISOString()
  }

  const calList = await calendar.calendarList.list({ minAccessRole: "writer" })
  const calIds = (calList.data.items ?? []).map(c => c.id ?? "primary")

  const results: { id: string; calendarId: string; summary: string; start: string; end: string; attendees: string[] }[] = []

  await Promise.all(calIds.map(async (calId) => {
    try {
      const res = await calendar.events.list({
        calendarId: calId,
        q: query,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 5,
      })
      for (const e of res.data.items ?? []) {
        if (!e.id || !e.summary) continue
        results.push({
          id: e.id,
          calendarId: calId,
          summary: e.summary,
          start: e.start?.dateTime ?? e.start?.date ?? "",
          end: e.end?.dateTime ?? e.end?.date ?? "",
          attendees: (e.attendees ?? []).map(a => a.email ?? "").filter(Boolean),
        })
      }
    } catch { /* skip unreadable calendars */ }
  }))

  return results.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
}

export async function updateCalendarEvent(
  refreshToken: string,
  calendarId: string,
  eventId: string,
  patch: { summary?: string; start?: string; end?: string; addAttendeeEmails?: string[] }
): Promise<string | null> {
  const auth = getAuthenticatedClient(refreshToken)
  const calendar = google.calendar({ version: "v3", auth })

  const current = await calendar.events.get({ calendarId, eventId })
  const requestBody: any = {}

  if (patch.summary) requestBody.summary = patch.summary

  if (patch.start) {
    requestBody.start = { dateTime: patch.start, timeZone: "Asia/Jerusalem" }
    if (!patch.end) {
      const dur =
        new Date(current.data.end?.dateTime ?? current.data.end?.date ?? "").getTime() -
        new Date(current.data.start?.dateTime ?? current.data.start?.date ?? "").getTime()
      requestBody.end = { dateTime: new Date(new Date(patch.start).getTime() + dur).toISOString(), timeZone: "Asia/Jerusalem" }
    }
  }
  if (patch.end) requestBody.end = { dateTime: patch.end, timeZone: "Asia/Jerusalem" }

  if (patch.addAttendeeEmails?.length) {
    const existing = (current.data.attendees ?? []).map(a => a.email ?? "").filter(Boolean)
    const merged = Array.from(new Set([...existing, ...patch.addAttendeeEmails]))
    requestBody.attendees = merged.map(email => ({ email }))
  }

  const res = await calendar.events.patch({
    calendarId,
    eventId,
    sendUpdates: patch.addAttendeeEmails?.length ? "all" : "none",
    requestBody,
  })

  return res.data.htmlLink ?? null
}

// ── Google Tasks ──────────────────────────────────────────────────────────────

export async function listTasks(refreshToken: string): Promise<
  { id: string; title: string; due?: string; completed: boolean }[]
> {
  const auth = getAuthenticatedClient(refreshToken)
  const tasks = google.tasks({ version: "v1", auth })

  const listsRes = await tasks.tasklists.list({ maxResults: 1 })
  const listId = listsRes.data.items?.[0]?.id
  if (!listId) return []

  const res = await tasks.tasks.list({
    tasklist: listId,
    showCompleted: false,
    maxResults: 20,
  })

  return (res.data.items ?? []).map((t) => ({
    id: t.id ?? "",
    title: t.title ?? "(ללא כותרת)",
    due: t.due ?? undefined,
    completed: t.status === "completed",
  }))
}

export async function addTask(
  refreshToken: string,
  title: string,
  due?: string
): Promise<void> {
  const auth = getAuthenticatedClient(refreshToken)
  const tasks = google.tasks({ version: "v1", auth })

  const listsRes = await tasks.tasklists.list({ maxResults: 1 })
  const listId = listsRes.data.items?.[0]?.id
  if (!listId) return

  // Google Tasks API requires due in RFC 3339 format with time component
  const dueRfc = due ? new Date(due + "T00:00:00.000Z").toISOString() : undefined

  await tasks.tasks.insert({
    tasklist: listId,
    requestBody: { title, due: dueRfc },
  })
}

export async function completeTask(
  refreshToken: string,
  taskId: string
): Promise<void> {
  const auth = getAuthenticatedClient(refreshToken)
  const tasks = google.tasks({ version: "v1", auth })

  const listsRes = await tasks.tasklists.list({ maxResults: 1 })
  const listId = listsRes.data.items?.[0]?.id
  if (!listId) return

  await tasks.tasks.patch({
    tasklist: listId,
    task: taskId,
    requestBody: { status: "completed" },
  })
}

// ── Google Drive ──────────────────────────────────────────────────────────────

export async function searchDrive(
  refreshToken: string,
  query: string
): Promise<{ id: string; name: string; mimeType: string; webViewLink: string }[]> {
  const auth = getAuthenticatedClient(refreshToken)
  const drive = google.drive({ version: "v3", auth })

  const res = await drive.files.list({
    q: `name contains '${query.replace(/'/g, "\\'")}' and trashed = false`,
    fields: "files(id, name, mimeType, webViewLink)",
    pageSize: 10,
    orderBy: "modifiedTime desc",
  })

  return (res.data.files ?? []).map((f) => ({
    id: f.id ?? "",
    name: f.name ?? "",
    mimeType: f.mimeType ?? "",
    webViewLink: f.webViewLink ?? "",
  }))
}

// ── Google Contacts (People API) ──────────────────────────────────────────────

export async function searchContacts(
  refreshToken: string,
  query: string
): Promise<{ name: string; email: string }[]> {
  const auth = getAuthenticatedClient(refreshToken)
  const people = google.people({ version: "v1", auth })

  const res = await people.people.searchContacts({
    query,
    readMask: "names,emailAddresses",
    pageSize: 5,
  })

  const results: { name: string; email: string }[] = []
  for (const person of res.data.results ?? []) {
    const name = person.person?.names?.[0]?.displayName
    const email = person.person?.emailAddresses?.[0]?.value
    if (name && email) results.push({ name, email })
  }
  return results
}

// ── Gmail ─────────────────────────────────────────────────────────────────────

export async function getRecentEmails(
  refreshToken: string,
  maxResults = 5
): Promise<{ from: string; subject: string; snippet: string; date: string }[]> {
  const auth = getAuthenticatedClient(refreshToken)
  const gmail = google.gmail({ version: "v1", auth })

  const listRes = await gmail.users.messages.list({
    userId: "me",
    maxResults,
    q: "in:inbox",
  })

  const messages = listRes.data.messages ?? []
  const details = await Promise.all(
    messages.map((m) =>
      gmail.users.messages.get({
        userId: "me",
        id: m.id!,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      })
    )
  )

  return details.map((d) => {
    const headers = d.data.payload?.headers ?? []
    const get = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ""
    return {
      from: get("From"),
      subject: get("Subject"),
      date: get("Date"),
      snippet: d.data.snippet ?? "",
    }
  })
}

export async function sendEmail(
  refreshToken: string,
  to: string,
  subject: string,
  body: string
): Promise<void> {
  const auth = getAuthenticatedClient(refreshToken)
  const gmail = google.gmail({ version: "v1", auth })

  const message = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\n")

  const encoded = Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encoded },
  })
}
