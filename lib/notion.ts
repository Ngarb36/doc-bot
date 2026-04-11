import { Client } from "@notionhq/client"

const notion = new Client({ auth: process.env.NOTION_TOKEN })

const LINKS_DB = process.env.NOTION_LINKS_DB_ID!
const LISTS_DB = process.env.NOTION_LISTS_DB_ID!

const TYPE_EMOJI: Record<string, string> = {
  video: "🎬",
  article: "📰",
  tutorial: "📚",
  documentation: "📖",
  tool: "🛠️",
  other: "🔗",
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace("www.", "")
  } catch {
    return url
  }
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

// ── Links ─────────────────────────────────────────────────────────────────────

export async function saveLink(params: {
  url: string
  type: string
  title: string
  summary: string | null
  tags: string[]
  senderName: string
}): Promise<void> {
  const { url, type, title, summary, tags } = params
  const emoji = TYPE_EMOJI[type] ?? "🔗"

  await notion.pages.create({
    parent: { database_id: LINKS_DB },
    icon: { type: "emoji", emoji: emoji as any },
    properties: {
      Name: { title: [{ text: { content: title || url } }] },
      URL: { url },
      Type: { select: { name: capitalize(type) } },
      Summary: { rich_text: summary ? [{ text: { content: summary } }] : [] },
      Source: { select: { name: extractDomain(url) } },
      Status: { status: { name: "To Read" } },
      ...(tags.length > 0 && {
        Tags: { multi_select: tags.map((t) => ({ name: t })) },
      }),
      "Added At": { date: { start: new Date().toISOString() } },
    },
  })
}

// ── Lists ─────────────────────────────────────────────────────────────────────

export async function addListItemToNotion(
  listName: string,
  item: string,
  owner: string
): Promise<void> {
  await notion.pages.create({
    parent: { database_id: LISTS_DB },
    properties: {
      Name: { title: [{ text: { content: item } }] },
      List: { select: { name: listName } },
      Done: { checkbox: false },
      Owner: { rich_text: [{ text: { content: owner } }] },
      "Added At": { date: { start: new Date().toISOString() } },
    },
  })
}

export async function getNotionListItems(
  listName: string
): Promise<{ id: string; name: string; done: boolean }[]> {
  const res = await notion.databases.query({
    database_id: LISTS_DB,
    filter: {
      and: [
        { property: "List", select: { equals: listName } },
        { property: "Done", checkbox: { equals: false } },
      ],
    },
  })

  return res.results.map((page: any) => ({
    id: page.id,
    name: page.properties?.Name?.title?.[0]?.text?.content ?? "",
    done: page.properties?.Done?.checkbox ?? false,
  }))
}

export async function markNotionListItemDone(pageId: string): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: { Done: { checkbox: true } },
  })
}
