'use client'

import dynamic from 'next/dynamic'

const CartDrawer = dynamic(() => import('@/components/organisms/CartDrawer').then(m => m.CartDrawer), { ssr: false })
const ChatWidget = dynamic(() => import('@/components/ChatWidget').then(m => m.ChatWidget), { ssr: false })
const StickyCartBar = dynamic(() => import('@/components/molecules/StickyCartBar').then(m => m.StickyCartBar), { ssr: false })

export function ClientOverlays() {
  return (
    <>
      <CartDrawer />
      <StickyCartBar />
      <ChatWidget />
    </>
  )
}
