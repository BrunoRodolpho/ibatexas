"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { useTranslations } from "next-intl"
import { useChat } from "@/hooks/api"
import { useChatStore, useSessionStore, useUIStore } from "@/stores"

export function ChatWidget() {
  const t = useTranslations()
  const [input, setInput] = useState("")
  const messagesEnd = useRef<HTMLDivElement>(null)
  const { initSession } = useSessionStore()

  const isOpen = useUIStore((s) => s.isChatOpen)
  const setChat = useUIStore((s) => s.setChat)

  const messages = useChatStore((s) => s.messages)
  const isLoading = useChatStore((s) => s.isLoading)
  const error = useChatStore((s) => s.error)
  const { sendMessage } = useChat()

  // ── Auto-hide FAB on scroll down, show on scroll up ──────
  const [fabVisible, setFabVisible] = useState(true)
  const lastScrollY = useRef(0)

  const handleScroll = useCallback(() => {
    const currentY = window.scrollY
    // Hide on hero section (desktop) — first 600px
    const isInHero = currentY < 600 && window.innerWidth >= 1024
    if (isInHero) {
      setFabVisible(false)
    } else if (currentY < lastScrollY.current) {
      // Scrolling up
      setFabVisible(true)
    } else if (currentY > lastScrollY.current + 20) {
      // Scrolling down (with 20px deadzone)
      setFabVisible(false)
    }
    lastScrollY.current = currentY
  }, [])

  useEffect(() => {
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [handleScroll])

  useEffect(() => {
    initSession()
  }, [initSession])

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  const handleSend = async () => {
    if (!input.trim()) return
    setInput("")
    await sendMessage(input)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <>
      {/* FAB — refined, auto-hides */}
      {!isOpen && (
        <button
          onClick={() => setChat(true)}
          className={`fixed bottom-6 right-6 z-40 flex items-center gap-2.5 rounded-lg bg-charcoal-900 px-4 py-3 text-white shadow-lg transition-all duration-500 ease-luxury hover:bg-charcoal-700 ${
            fabVisible ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0 pointer-events-none'
          }`}
          aria-label={t("chat.title")}
        >
          <svg className="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
          <span className="hidden text-xs font-medium uppercase tracking-editorial sm:inline">Pedir via Chat</span>
        </button>
      )}

      {/* Chat Panel */}
      {isOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-smoke-50 md:inset-auto md:bottom-6 md:right-6 md:h-[36rem] md:w-[26rem] md:rounded-lg md:shadow-xl md:border md:border-smoke-200 animate-slide-up">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-smoke-200 bg-smoke-50 px-4 py-3 md:rounded-t-lg">
            <div className="flex items-center gap-2.5">
              <div className="h-7 w-7 rounded-md bg-charcoal-900 flex items-center justify-center">
                <span className="text-white text-[10px] font-semibold">IA</span>
              </div>
              <div>
                <h2 className="text-sm font-semibold text-charcoal-900">{t("chat.title")}</h2>
                <div className="flex items-center gap-1 mt-0.5">
                  <div className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  <span className="text-[10px] text-smoke-400">Online</span>
                </div>
              </div>
            </div>
            <button
              onClick={() => setChat(false)}
              className="p-1.5 text-smoke-400 hover:text-charcoal-900 transition-colors duration-500 ease-luxury"
              aria-label="Fechar chat"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-smoke-100">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full gap-3 py-8">
                <p className="text-center text-[13px] text-smoke-400 measure-narrow">
                  {t("chat.placeholder")}
                </p>
              </div>
            )}
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[82%] rounded-lg px-3 py-2 text-[13px] leading-relaxed ${
                    msg.role === "user"
                      ? "bg-charcoal-900 text-white rounded-tr-sm"
                      : "bg-smoke-50 text-charcoal-900 rounded-tl-sm border border-smoke-200"
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-smoke-50 text-charcoal-900 rounded-lg rounded-tl-sm border border-smoke-200 px-3 py-2">
                  <div className="flex gap-1 items-center">
                    <div className="h-1.5 w-1.5 rounded-full bg-smoke-300 animate-bounce [animation-delay:0ms]" />
                    <div className="h-1.5 w-1.5 rounded-full bg-smoke-300 animate-bounce [animation-delay:150ms]" />
                    <div className="h-1.5 w-1.5 rounded-full bg-smoke-300 animate-bounce [animation-delay:300ms]" />
                  </div>
                </div>
              </div>
            )}
            {error && (
              <div className="rounded-lg bg-red-50 p-3 text-[13px] text-red-600 border border-red-100">
                {error}
              </div>
            )}
            <div ref={messagesEnd} />
          </div>

          {/* Input */}
          <div className="border-t border-smoke-200 bg-smoke-50 p-3 md:rounded-b-lg">
            <div className="flex gap-2 items-center rounded-md border border-smoke-200 bg-smoke-100 px-3 py-2 focus-within:border-smoke-300 focus-within:bg-smoke-50 transition-colors duration-500 ease-luxury">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t("chat.placeholder")}
                className="flex-1 bg-transparent text-[13px] text-charcoal-900 placeholder:text-smoke-400 focus:outline-none"
                disabled={isLoading}
              />
              <button
                onClick={handleSend}
                disabled={isLoading || !input.trim()}
                className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-charcoal-900 text-white hover:bg-charcoal-700 disabled:opacity-40 transition-colors duration-500 ease-luxury disabled:cursor-not-allowed"
                aria-label={t("chat.send")}
              >
                <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
