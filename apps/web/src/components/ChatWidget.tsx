"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useChat } from "@/hooks/api"
import { useChatStore, useSessionStore, useUIStore } from "@/stores"

export function ChatWidget() {
  const t = useTranslations()
  const [input, setInput] = useState("")
  const messagesEnd = useRef<HTMLDivElement>(null)
  const { initSession } = useSessionStore()

  // Connect to UIStore so any part of the app can open the chat
  const isOpen = useUIStore((s) => s.isChatOpen)
  const setChat = useUIStore((s) => s.setChat)

  const messages = useChatStore((s) => s.messages)
  const isLoading = useChatStore((s) => s.isLoading)
  const error = useChatStore((s) => s.error)
  const { sendMessage } = useChat()

  // Ensure session is initialized
  useEffect(() => {
    initSession()
  }, [initSession])

  // Scroll to bottom when new messages arrive
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
      {/* FAB — labeled pill button, prominent brand presence */}
      {!isOpen && (
        <button
          onClick={() => setChat(true)}
          className="fixed bottom-6 right-6 z-40 relative flex items-center gap-3 rounded-2xl bg-brand-500 px-5 py-3.5 text-white shadow-glow-brand hover:bg-brand-600 hover:-translate-y-0.5 hover:shadow-glow-brand-lg transition-all duration-250"
          aria-label={t("chat.title")}
        >
          {/* Pulsing ring attention cue */}
          <span className="absolute inset-0 rounded-2xl bg-brand-500 animate-ping opacity-20 pointer-events-none" />

          <svg className="h-5 w-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
          <span className="hidden text-sm font-semibold sm:inline">Pedir via IA</span>
        </button>
      )}

      {/* Chat Panel — full screen on mobile, floating on desktop */}
      {isOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-white md:inset-auto md:bottom-6 md:right-6 md:h-[36rem] md:w-[26rem] md:rounded-3xl md:shadow-card-lg md:border md:border-slate-200/80 animate-slide-up">
          {/* Header */}
          <div className="flex items-center justify-between bg-brand-500 px-5 py-4 text-white md:rounded-t-3xl">
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-full bg-white/20 flex items-center justify-center">
                <span className="text-white text-xs font-bold font-display">IA</span>
              </div>
              <div>
                <h2 className="font-display font-bold text-base">{t("chat.title")}</h2>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <div className="h-1.5 w-1.5 rounded-full bg-green-400" />
                  <span className="text-xs text-brand-100">Online</span>
                </div>
              </div>
            </div>
            <button
              onClick={() => setChat(false)}
              className="rounded-lg p-1.5 text-white/80 hover:bg-white/10 hover:text-white transition-colors duration-250"
              aria-label="Fechar chat"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4 bg-smoke-50">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full gap-3 py-8">
                <div className="h-14 w-14 rounded-2xl bg-brand-100 flex items-center justify-center">
                  <span className="text-2xl">🔥</span>
                </div>
                <p className="text-center text-sm text-slate-500 max-w-[200px]">
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
                  className={`max-w-[82%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                    msg.role === "user"
                      ? "bg-brand-500 text-white rounded-tr-sm"
                      : "bg-white text-slate-800 rounded-tl-sm shadow-card-sm border border-slate-100"
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-white text-slate-800 rounded-2xl rounded-tl-sm shadow-card-sm border border-slate-100 px-4 py-3">
                  <div className="flex gap-1 items-center">
                    <div className="h-1.5 w-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:0ms]" />
                    <div className="h-1.5 w-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:150ms]" />
                    <div className="h-1.5 w-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:300ms]" />
                  </div>
                </div>
              </div>
            )}
            {error && (
              <div className="rounded-xl bg-red-50 p-3 text-sm text-red-600 border border-red-100">
                {error}
              </div>
            )}
            <div ref={messagesEnd} />
          </div>

          {/* Input */}
          <div className="border-t border-slate-100 bg-white p-4 md:rounded-b-3xl">
            <div className="flex gap-2 items-center rounded-xl border border-slate-200 bg-smoke-50 px-4 py-2.5 focus-within:border-brand-500 focus-within:bg-white transition-colors duration-250">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t("chat.placeholder")}
                className="flex-1 bg-transparent text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none"
                disabled={isLoading}
              />
              <button
                onClick={handleSend}
                disabled={isLoading || !input.trim()}
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-40 transition-all duration-250 disabled:cursor-not-allowed"
                aria-label={t("chat.send")}
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
