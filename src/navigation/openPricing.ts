import {CommonActions} from '@react-navigation/native';
import {navigationRef} from './navigationRef';

/**
 * M1A — jump to Settings → Pricing from anywhere (locked-feature prompts,
 * upgrade CTAs). Same root-dispatch pattern as the tier_insufficient
 * interceptor; a no-op until the container is ready.
 */
export function openPricing(): void {
  if (navigationRef.isReady()) {
    navigationRef.dispatch(
      CommonActions.navigate('Main', {screen: 'SecureTab', params: {screen: 'Pricing'}}),
    );
  }
}
