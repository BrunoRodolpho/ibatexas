import { redirect } from 'next/navigation'

/** Root redirects to /admin dashboard */
export default function Home() {
  redirect('/admin')
}
