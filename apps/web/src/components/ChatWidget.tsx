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
      {/* FAB — minimal pill, no pulsing ring */}
      {!isOpen && (
        <button
          onClick={() => setChat(true)}
          className="fixed bottom-6 right-6 z-40 flex items-center gap-2.5 rounded-lg bg-slate-900 px-4 py-3 text-white shadow-lg hover:bg-slate-800 transition-colors"
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
          <span className="hidden text-sm font-medium sm:inline">Pedir via IA</span>
        </button>
      )}

      {/* Chat Panel */}
      {isOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-white md:inset-auto md:bottom-6 md:right-6 md:h-[36rem] md:w-[26rem] md:rounded-xl md:shadow-xl md:border md:border-slate-200 animate-slide-up">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 md:rounded-t-xl">
            <div className="flex items-center gap-2.5">
              <div className="h-7 w-7 rounded-md bg-slate-900 flex items-center justify-center">
                <span className="text-white text-[10px] font-semibold">IA</span>
              </div>
              <div>
                <h2 className="text-sm font-semibold text-slate-900">{t("chat.title")}</h2>
                <div className="flex items-center gap-1 mt-0.5">
                  <div className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  <span className="text-[11px] text-slate-400">Online</span>
                </div>
              </div>
            </div>
            <button
              onClick={() => setChat(false)}
              className="rounded-md p-1.5 text-slate-400 hover:bg-slate-50 hover:text-slate-600 transition-colors"
              aria-label="Fechar chat"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full gap-3 py-8">
                <div className="h-10 w-10 rounded-lg bg-slate-100 flex items-center justify-center">
                  <span className="text-lg">💬</span>
                </div>
                <p className="text-center text-[13px] text-slate-400 max-w-[200px]">
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
                      ? "bg-slate-900 text-white rounded-tr-sm"
                      : "bg-white text-slate-700 rounded-tl-sm border border-slate-100"
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-white text-slate-700 rounded-lg rounded-tl-sm border border-slate-100 px-3 py-2">
                  <div className="flex gap-1 items-center">
                    <div className="h-1.5 w-1.5 rounded-full bg-slate-300 animate-bounce [animation-delay:0ms]" />
                    <div className="h-1.5 w-1.5 rounded-full bg-slate-300 animate-bounce [animation-delay:150ms]" />
                    <div className="h-1.5 w-1.5 rounded-full bg-slate-300 animate-bounce [animation-delay:300ms]" />
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
          <div className="border-t border-slate-100 bg-white p-3 md:rounded-b-xl">
            <div className="flex gap-2 items-center rounded-md border border-slate-200 bg-slate-50 px-3 py-2 focus-within:border-slate-400 focus-within:bg-white transition-colors">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t("chat.placeholder")}
                className="flex-1 bg-transparent text-[13px] text-slate-800 placeholder:text-slate-400 focus:outline-none"
                disabled={isLoading}
              />
              <button
                onClick={handleSend}
                disabled={isLoading || !input.trim()}
                className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-40 transition-colors disabled:cursor-not-allowed"
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
