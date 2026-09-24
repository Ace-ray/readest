import { AvailablePlan } from '@/types/quota';

interface UseAvailablePlansParams {
  hasIAP: boolean;
  onError?: (message: string) => void;
}

// Paywall removed: no plan fetching in self-hosted builds. All features are
// unlocked, so there is nothing to display in a store front.
export const useAvailablePlans = (_params: UseAvailablePlansParams) => {
  return { availablePlans: [] as AvailablePlan[], iapAvailable: false, loading: false, error: null };
};
