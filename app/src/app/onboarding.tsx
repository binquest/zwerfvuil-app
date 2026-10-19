// The onboarding: the guard in the root layout shows it until onboarded_at is
// set (src/game/onboarding.ts). The screen itself is shared with the preview.
import { OnboardingFlow } from '@/screens/OnboardingFlow';

export default function OnboardingScreen() {
  return <OnboardingFlow />;
}
