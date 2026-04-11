import NextAuth from "next-auth"
import GoogleProvider from "next-auth/providers/google"
import { saveUser } from "@/lib/db"

const handler = NextAuth({
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: {
        params: {
          access_type: "offline",
          prompt: "consent",
          scope: [
            "openid",
            "email",
            "profile",
            "https://www.googleapis.com/auth/calendar",
            "https://www.googleapis.com/auth/drive.readonly",
            "https://www.googleapis.com/auth/tasks",
            "https://www.googleapis.com/auth/contacts.readonly",
            "https://www.googleapis.com/auth/gmail.send",
            "https://www.googleapis.com/auth/gmail.readonly",
          ].join(" "),
        },
      },
    }),
  ],
  secret: process.env.NEXTAUTH_SECRET,
  callbacks: {
    async signIn({ account, profile }) {
      return !!(account?.access_token && account?.refresh_token && profile?.email)
    },
    async jwt({ token, account, profile }) {
      if (account?.refresh_token) {
        token.refreshToken = account.refresh_token
      }
      if (profile?.email) {
        token.email = profile.email
      }
      return token
    },
    async session({ session, token }) {
      return session
    },
    async redirect({ url, baseUrl }) {
      return baseUrl + "/success"
    },
  },
  events: {
    async signIn({ account, profile }) {
      // chatId is passed via state param and stored in session before redirect
    },
  },
})

export { handler as GET, handler as POST }
