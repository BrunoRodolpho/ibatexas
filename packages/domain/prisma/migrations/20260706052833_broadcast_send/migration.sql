-- CreateTable
CREATE TABLE "ibx_domain"."broadcast_send" (
    "id" TEXT NOT NULL,
    "sender_staff_id" TEXT,
    "template" TEXT NOT NULL,
    "total_count" INTEGER NOT NULL,
    "sent_count" INTEGER NOT NULL,
    "skipped_count" INTEGER NOT NULL,
    "failed_count" INTEGER NOT NULL,
    "results" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcast_send_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "broadcast_send_created_at_idx" ON "ibx_domain"."broadcast_send"("created_at");
