-- CreateTable
CREATE TABLE "ibx_domain"."weekly_schedules" (
    "id" TEXT NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "is_open" BOOLEAN NOT NULL DEFAULT true,
    "lunch_start" VARCHAR(5),
    "lunch_end" VARCHAR(5),
    "dinner_start" VARCHAR(5),
    "dinner_end" VARCHAR(5),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weekly_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ibx_domain"."holidays" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "weekly_schedules_day_of_week_key" ON "ibx_domain"."weekly_schedules"("day_of_week");

-- CreateIndex
CREATE UNIQUE INDEX "holidays_date_key" ON "ibx_domain"."holidays"("date");
