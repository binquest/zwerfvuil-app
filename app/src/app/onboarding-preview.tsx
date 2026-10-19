// The onboarding without the guard, for Dev mode: the same screens, nothing
// is saved, "Op ontdekking" closes it.
import { OnboardingFlow } from '@/screens/OnboardingFlow';

export default function OnboardingPreviewScreen() {
  return <OnboardingFlow preview />;
}
