-- DropForeignKey
ALTER TABLE "ibx_domain"."loyalty_accounts" DROP CONSTRAINT "loyalty_accounts_customer_id_fkey";

-- AlterTable
ALTER TABLE "ibx_domain"."loyalty_accounts" ALTER COLUMN "customer_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "ibx_domain"."loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "ibx_domain"."customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
