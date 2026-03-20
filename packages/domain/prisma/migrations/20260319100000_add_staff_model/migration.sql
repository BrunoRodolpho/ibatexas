-- DOM-001: Add Staff model for restaurant staff authentication and authorization.
-- Staff members authenticate via Twilio Verify OTP (same as customers).
-- Role-based access: OWNER > MANAGER > ATTENDANT.

-- CreateEnum
CREATE TYPE "ibx_domain"."StaffRole" AS ENUM ('OWNER', 'MANAGER', 'ATTENDANT');

-- CreateTable
CREATE TABLE "ibx_domain"."staff" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "ibx_domain"."StaffRole" NOT NULL DEFAULT 'ATTENDANT',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_phone_key" ON "ibx_domain"."staff"("phone");

-- CreateIndex
CREATE INDEX "staff_phone_idx" ON "ibx_domain"."staff"("phone");
