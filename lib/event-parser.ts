import Anthropic from "@anthropic-ai/sdk"

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export interface ParsedEvent {
  title: string
  date: string        // YYYY-MM-DD
  startTime: string   // HH:MM
  endTime: string     // HH:MM
  location?: string
  attendees?: string[]
  description?: string
  confidence: "high" | "medium" | "low"
  clarificationNeeded?: string
}

const SYSTEM_PROMPT = `You are an assistant that extracts calendar event details from messages.
The user communicates primarily in Hebrew. Extract event information and return ONLY valid JSON — no markdown, no explanation.

Today's date will be provided in the user message. Use it to resolve relative dates.

Return a JSON object with these exact fields:
- title: string (event name, keep original language)
- date: string (YYYY-MM-DD — resolve relative dates like מחר/ביום שישי/בשבוע הבא using today's date)
- startTime: string (HH:MM 24h format)
- endTime: string (HH:MM 24h format — default to startTime + 1 hour if not specified)
- location: string or null
- attendees: array of strings (names or emails) or empty array
- description: string or null
- confidence: "high" | "medium" | "low"
- clarificationNeeded: string or null (ask in Hebrew if critical info like date/time is completely missing)

Hebrew time/date hints:
- מחר = tomorrow, מחרתיים = day after tomorrow
- ביום ראשון/שני/שלישי/רביעי/חמישי/שישי/שבת = next Sun/Mon/Tue/Wed/Thu/Fri/Sat
- בשבוע הבא = next week (same weekday), עוד שבוע = 7 days from now
- בצהריים = 12:00, בערב = 19:00, בבוקר = 09:00
- DD.MM format = day.month of current year (e.g. 13.4 = April 13)

If no time is specified at all, set clarificationNeeded to ask what time in Hebrew, and confidence to "low".`

export async function parseEventFromText(text: string, todayISO: string): Promise<ParsedEvent> {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Today is ${todayISO}.\n\nMessage:\n${text}` }],
  })

  const raw = response.content[0].type === "text" ? response.content[0].text.trim() : ""
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) throw new Error("No JSON found in response")
  return JSON.parse(match[0]) as ParsedEvent
}

export async function parseEventFromImage(
  imageBase64: string,
  mimeType: "image/jpeg" | "image/png" | "image/webp",
  caption: string,
  todayISO: string
): Promise<ParsedEvent> {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: mimeType, data: imageBase64 },
        },
        {
          type: "text",
          text: `Today is ${todayISO}.\n\nThis is a screenshot. Extract all calendar event information visible in the image.${caption ? `\n\nUser caption: ${caption}` : ""}`,
        },
      ],
    }],
  })

  const raw = response.content[0].type === "text" ? response.content[0].text.trim() : ""
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) throw new Error("No JSON found in response")
  return JSON.parse(match[0]) as ParsedEvent
}

export function buildISODateTimes(event: ParsedEvent): { startDateTime: string; endDateTime: string } {
  return {
    startDateTime: `${event.date}T${event.startTime}:00+03:00`,
    endDateTime: `${event.date}T${event.endTime}:00+03:00`,
  }
}
