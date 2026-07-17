import {createNavigationContainerRef} from '@react-navigation/native';
import type {RootStackParamList} from './types';

/**
 * Navigation ref exposed to non-screen modules that need to navigate
 * (e.g. the global incoming-call handler in MainNavigator). Lives in
 * its own file so it doesn't import from `./index` — that would close
 * a cycle (index → MainNavigator → index) and trigger Metro's
 * "Require cycle" warning + can leave the ref undefined at first read.
 */
export const navigationRef = createNavigationContainerRef<RootStackParamList>();
