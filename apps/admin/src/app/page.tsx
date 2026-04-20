import { redirect } from 'next/navigation'

/** Root always redirects to /admin — the layout handles auth (shows LoginForm if unauthenticated). */
export default async function Home() {
  redirect('/admin')
}
