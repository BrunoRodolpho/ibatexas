export {
  CHECKOUT_STEPS,
  nextStep,
  prevStep,
  canProceed,
  mergeItemInstructionsIntoNotes,
  CHECKOUT_NOTES_MAX,
  type CheckoutStep,
  type CheckoutInstructionItem,
  type MergedNotes,
} from './checkout.logic'

export {
  GUEST_PAYMENT_METHODS,
  CHECKOUT_LOGIN_HREF,
  isGuestEligiblePaymentMethod,
  guestFilteredPaymentMethods,
  defaultPaymentMethod,
  guestNeedsLogin,
  type CheckoutPaymentMethod,
} from './guestGate'
