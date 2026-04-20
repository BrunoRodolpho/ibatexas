-- CreateEnum
CREATE TYPE "ibx_domain"."ConversationChannel" AS ENUM ('whatsapp', 'web');

-- CreateEnum
CREATE TYPE "ibx_domain"."MessageRole" AS ENUM ('user', 'assistant', 'system');

-- CreateTable
CREATE TABLE "ibx_domain"."conversations" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "channel" "ibx_domain"."ConversationChannel" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ibx_domain"."conversation_messages" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "role" "ibx_domain"."MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversations_session_id_key" ON "ibx_domain"."conversations"("session_id");

-- CreateIndex
CREATE INDEX "conversations_customer_id_idx" ON "ibx_domain"."conversations"("customer_id");

-- CreateIndex
CREATE INDEX "conversations_channel_idx" ON "ibx_domain"."conversations"("channel");

-- CreateIndex
CREATE INDEX "conversations_started_at_idx" ON "ibx_domain"."conversations"("started_at");

-- CreateIndex
CREATE INDEX "conversation_messages_conversation_id_sent_at_idx" ON "ibx_domain"."conversation_messages"("conversation_id", "sent_at");

-- AddForeignKey
ALTER TABLE "ibx_domain"."conversations" ADD CONSTRAINT "conversations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "ibx_domain"."customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ibx_domain"."conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ibx_domain"."conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
