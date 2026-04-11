import Anthropic from "@anthropic-ai/sdk"
import axios from "axios"

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const VIDEO_DOMAINS = ["youtube.com", "youtu.be", "vimeo.com", "tiktok.com", "twitch.tv", "dailymotion.com", "loom.com"]
const DOC_DOMAINS = ["developer.mozilla.org", "docs.python.org", "docs.aws.amazon.com", "docs.microsoft.com"]
const VALID_TYPES = ["video", "article", "tutorial", "documentation", "tool", "other"]

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace("www.", "")
  } catch {
    return ""
  }
}

async function fetchMetadata(url: string) {
  try {
    const res = await axios.get(url, {
      timeout: 6000,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; DocBot/1.0)" },
      maxRedirects: 5,
      maxContentLength: 400000,
      responseType: "text",
    })
    const html: string = res.data || ""
    const get = (patterns: RegExp[]) => {
      for (const p of patterns) {
        const m = html.match(p)
        if (m?.[1]) return m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim()
      }
      return null
    }
    return {
      ogTitle: get([/property="og:title"\s+content="([^"]+)"/i, /content="([^"]+)"\s+property="og:title"/i]),
      ogDescription: get([/property="og:description"\s+content="([^"]+)"/i, /content="([^"]+)"\s+property="og:description"/i]),
      ogType: get([/property="og:type"\s+content="([^"]+)"/i, /content="([^"]+)"\s+property="og:type"/i]),
      pageTitle: get([/<title[^>]*>([^<]+)<\/title>/i]),
    }
  } catch {
    return {}
  }
}

function inferTitle(url: string, meta: Awaited<ReturnType<typeof fetchMetadata>>): string {
  if (meta.ogTitle) return meta.ogTitle
  if (meta.pageTitle) return meta.pageTitle
  try {
    const u = new URL(url)
    const host = u.hostname.replace("www.", "")
    if (host.includes("x.com") || host.includes("twitter.com")) {
      const m = u.pathname.match(/\/([^/]+)\/status/)
      return m ? `Tweet by @${m[1]}` : "Tweet on X"
    }
    if (host.includes("facebook.com")) return "Facebook Post"
    if (host.includes("instagram.com")) return u.pathname.includes("/reel/") ? "Instagram Reel" : "Instagram Post"
    if (host.includes("linkedin.com")) return "LinkedIn Post"
    if (host.includes("tiktok.com")) return "TikTok Video"
    const parts = u.pathname.split("/").filter(Boolean)
    const last = parts[parts.length - 1]
    if (last && last.length > 2 && !/^\d+$/.test(last)) return decodeURIComponent(last).replace(/[-_]/g, " ")
    return host
  } catch {
    return "Link"
  }
}

export async function classifyLink(
  url: string,
  userNote = ""
): Promise<{ type: string; title: string; summary: string | null; tags: string[] }> {
  const meta = await fetchMetadata(url)
  const domain = extractDomain(url)

  const isVideo = (meta.ogType?.toLowerCase().startsWith("video")) || VIDEO_DOMAINS.some((d) => domain.includes(d))
  const isDoc = DOC_DOMAINS.some((d) => domain.includes(d))
  const typeHint = isVideo ? "video" : isDoc ? "documentation" : ""

  const context = [
    `URL: ${url}`,
    meta.ogTitle && `Title: ${meta.ogTitle}`,
    meta.ogDescription && `Description: ${meta.ogDescription}`,
    meta.ogType && `OG Type: ${meta.ogType}`,
    !meta.ogTitle && meta.pageTitle && `Page Title: ${meta.pageTitle}`,
    userNote && `User note: ${userNote}`,
    typeHint && `Likely type: ${typeHint}`,
  ].filter(Boolean).join("\n")

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 350,
    system: "You are a link classifier. Always respond with valid JSON only, no markdown.",
    messages: [{
      role: "user",
      content: `Classify this link.\n\n${context}\n\nReturn ONLY:\n{"type":"<video|article|tutorial|documentation|tool|other>","title":"<max 80 chars>","summary":"<one sentence, max 120 chars>","tags":["tag1","tag2"]}`,
    }],
  })

  try {
    const raw = response.content[0].type === "text"
      ? response.content[0].text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
      : ""
    const parsed = JSON.parse(raw)
    if (!VALID_TYPES.includes(parsed.type)) parsed.type = "other"
    if (!Array.isArray(parsed.tags)) parsed.tags = []
    parsed.title = (parsed.title && !parsed.title.startsWith("http")) ? parsed.title : (userNote || inferTitle(url, meta))
    parsed.summary = parsed.summary || meta.ogDescription || null
    return parsed
  } catch {
    return { type: "other", title: userNote || inferTitle(url, meta), summary: meta.ogDescription || null, tags: [] }
  }
}
