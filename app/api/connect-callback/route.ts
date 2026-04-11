import { NextRequest, NextResponse } from "next/server"
import { resolveConnectToken, saveUser } from "@/lib/db"
import { google } from "googleapis"

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const code = searchParams.get("code")
  const state = searchParams.get("state") // contains the connect token

  if (!code || !state) {
    return NextResponse.redirect(new URL("/?error=missing_params", req.url))
  }

  const chatId = await resolveConnectToken(state)
  if (!chatId) {
    return NextResponse.redirect(new URL("/?error=invalid_token", req.url))
  }

  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.NEXTAUTH_URL + "/api/connect-callback"
  )

  const { tokens } = await oauth2.getToken(code)
  if (!tokens.refresh_token) {
    return NextResponse.redirect(new URL("/?error=no_refresh_token", req.url))
  }

  oauth2.setCredentials(tokens)
  const oauth2Api = google.oauth2({ version: "v2", auth: oauth2 })
  const { data: userInfo } = await oauth2Api.userinfo.get()

  await saveUser(chatId, {
    refreshToken: tokens.refresh_token,
    email: userInfo.email ?? "",
  })

  return NextResponse.redirect(new URL("/success", req.url))
}
