"use client"

import { CardElement } from "@stripe/react-stripe-js"
import { useTranslations } from "next-intl"

export default function InlineCardInput() {
  const t = useTranslations("checkout")

  return (
    <div className="space-y-2 mt-3 pt-3 border-t border-smoke-200">
      <p className="text-xs font-semibold uppercase tracking-editorial text-smoke-400">
        {t("card_input_label")}
      </p>
      <div className="rounded-sm border border-smoke-200/60 shadow-xs px-3 py-3 bg-white focus-within:border-charcoal-900 focus-within:shadow-card transition-[border-color,box-shadow] duration-[200ms] ease-luxury">
        <CardElement
          options={{
            style: {
              base: {
                fontSize: "14px",
                color: "#1a1a1a",
                fontFamily: "inherit",
                "::placeholder": { color: "#9ca3af" },
              },
              invalid: { color: "#dc2626" },
            },
            hidePostalCode: true,
            disableLink: true,
          }}
        />
      </div>
    </div>
  )
}
