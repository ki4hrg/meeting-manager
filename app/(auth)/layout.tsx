/* Every page here asks the database whether an account exists, which is a fact
   about the running deployment rather than the build. */
export const dynamic = 'force-dynamic'

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-gray-50 px-4 py-12 dark:bg-gray-900">
      <div className="w-full max-w-sm rounded-lg bg-white p-6 shadow dark:bg-gray-800">
        <h1 className="mb-6 text-xl font-semibold text-gray-900 dark:text-gray-100">Meetings</h1>
        {children}
      </div>
    </main>
  )
}
