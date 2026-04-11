export const metadata = { title: "Doc Bot", description: "Personal AI Assistant" }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl">
      <body>{children}</body>
    </html>
  )
}
