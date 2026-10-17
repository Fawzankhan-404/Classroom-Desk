export interface ReferralState { qualifiedCount: number; rewardsGranted: number; }

export function referralRewardCount(state: ReferralState): number {
  return Math.max(0, Math.floor(state.qualifiedCount / 2) - state.rewardsGranted);
}

export function qualifiesReferral(input: { referredUserId: string; referrerUserId: string; hasValidAttribution: boolean; firstMonthlyPaymentVerified: boolean; refunded: boolean; alreadyCounted: boolean }): boolean {
  return input.referredUserId !== input.referrerUserId && input.hasValidAttribution && input.firstMonthlyPaymentVerified && !input.refunded && !input.alreadyCounted;
}
