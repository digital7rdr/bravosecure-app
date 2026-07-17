import React from 'react';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import type {NewsStackParamList} from './types';
import {Colors} from '@theme/colors';

import NewsHubScreen from '@screens/news/NewsHubScreen';
import NewsFeedScreen from '@screens/news/NewsFeedScreen';
import NewsArticleScreen from '@screens/news/NewsArticleScreen';
import IntelFeedScreen from '@screens/news/IntelFeedScreen';
import NewsPreferencesScreen from '@screens/news/NewsPreferencesScreen';

const Stack = createNativeStackNavigator<NewsStackParamList>();

export default function NewsNavigator() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        contentStyle: {backgroundColor: Colors.background},
        // Round 7 / back-button audit — enable Android swipe-back.
        gestureEnabled: true,
        fullScreenGestureEnabled: true,
      }}>
      <Stack.Screen name="NewsHub" component={NewsHubScreen} />
      <Stack.Screen name="NewsFeed" component={NewsFeedScreen} />
      <Stack.Screen name="NewsArticle" component={NewsArticleScreen} />
      <Stack.Screen name="IntelFeed" component={IntelFeedScreen} />
      <Stack.Screen name="NewsPreferences" component={NewsPreferencesScreen} />
    </Stack.Navigator>
  );
}
