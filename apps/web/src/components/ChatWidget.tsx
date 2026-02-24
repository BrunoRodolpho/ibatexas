"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useChat } from "@/hooks/api"
import { useChatStore, useSessionStore } from "@/stores"

export function ChatWidget() {
  const t = useTranslations()
  const [isOpen, setIsOpen] = useState(false)
  const [input, setInput] = useState("")
  const messagesEnd = useRef<HTMLDivElement>(null)
  const { initSession } = useSessionStore()

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
      {/* FAB toggle button — visible when chat is closed */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-orange-600 text-white shadow-lg hover:bg-orange-700 transition-colors"
          aria-label={t("chat.title")}
        >
          <svg
            className="h-6 w-6"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
        </button>
      )}

      {/* Chat Panel — full screen on mobile, floating panel on desktop */}
      {isOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-white md:inset-auto md:bottom-6 md:right-6 md:h-[32rem] md:w-96 md:rounded-xl md:shadow-2xl md:border md:border-slate-200">
          {/* Header */}
          <div className="flex items-center justify-between border-b bg-orange-600 px-4 py-4 text-white md:rounded-t-xl">
            <h2 className="font-bold">{t("chat.title")}</h2>
            <button
              onClick={() => setIsOpen(false)}
              className="text-white hover:opacity-80"
              aria-label="Fechar chat"
            >
              ✕
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.length === 0 && (
              <div className="text-center text-sm text-gray-500 mt-8">
                {t("chat.placeholder")}
              </div>
            )}
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${
                  msg.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                <div
                  className={`max-w-[80%] rounded-lg px-4 py-2 text-sm ${
                    msg.role === "user"
                      ? "bg-orange-600 text-white"
                      : "bg-gray-100 text-gray-900"
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-gray-100 text-gray-900 rounded-lg px-4 py-2 text-sm">
                  {t("chat.typing")}...
                </div>
              </div>
            )}
            {error && (
              <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">
                {error}
              </div>
            )}
            <div ref={messagesEnd} />
          </div>

          {/* Input */}
          <div className="border-t p-4">
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t("chat.placeholder")}
                className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-orange-600 focus:outline-none"
                disabled={isLoading}
              />
              <button
                onClick={handleSend}
                disabled={isLoading || !input.trim()}
                className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50"
              >
                {t("chat.send")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
