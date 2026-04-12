"use client"
import { useSearchParams } from "next/navigation"
import { Suspense } from "react"

function ConnectContent() {
  const params = useSearchParams()
  const token = params.get("token")

  if (!token) {
    return (
      <div style={{ fontFamily: "sans-serif", textAlign: "center", padding: "40px" }}>
        <h2>❌ קישור לא תקין</h2>
        <p>חזור לטלגרם ובקש קישור חדש עם /connect</p>
      </div>
    )
  }

  const origin = typeof window !== "undefined" ? window.location.origin : ""
  const redirectUri = `${origin}/api/connect-callback`
  const scope = [
    "openid", "email", "profile",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/tasks",
    "https://www.googleapis.com/auth/contacts.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.readonly",
  ].join(" ")

  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? ""
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${encodeURIComponent(clientId)}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `response_type=code&` +
    `scope=${encodeURIComponent(scope)}&` +
    `access_type=offline&` +
    `prompt=consent&` +
    `state=${token}`

  return (
    <div style={{ fontFamily: "sans-serif", textAlign: "center", padding: "40px" }}>
      <h1>🤖 דוק - חיבור Google</h1>
      <p>לחץ כדי לחבר את חשבון ה-Google שלך</p>
      <a
        href={authUrl}
        style={{
          display: "inline-block",
          background: "#4285F4",
          color: "white",
          padding: "12px 24px",
          borderRadius: "8px",
          textDecoration: "none",
          fontSize: "16px",
          marginTop: "16px",
        }}
      >
        התחבר עם Google
      </a>
    </div>
  )
}

export default function ConnectPage() {
  return (
    <Suspense fallback={<div style={{ textAlign: "center", padding: "40px" }}>טוען...</div>}>
      <ConnectContent />
    </Suspense>
  )
}
