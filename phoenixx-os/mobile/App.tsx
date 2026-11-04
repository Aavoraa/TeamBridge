import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useColorScheme, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { AuthProvider, useAuth } from './src/auth';
import { Loading } from './src/components';
import { usePalette } from './src/theme';

import LoginScreen from './src/screens/LoginScreen';
import HomeScreen from './src/screens/HomeScreen';
import TasksScreen from './src/screens/TasksScreen';
import FollowUpsScreen from './src/screens/FollowUpsScreen';
import ApprovalsScreen from './src/screens/ApprovalsScreen';
import AlertsScreen from './src/screens/AlertsScreen';

/**
 * Phoenixx OS mobile.
 *
 * The app is deliberately narrow: the six actions people actually do from a
 * phone (PRD usability note) - check in, quick-add an action item, approve,
 * log a follow-up, read alerts, glance at the dashboard. Everything else lives
 * in the web app. Both run on the same API.
 */

const Tab = createBottomTabNavigator();

const ICONS: Record<string, [keyof typeof Ionicons.glyphMap, keyof typeof Ionicons.glyphMap]> = {
  Today: ['home', 'home-outline'],
  Work: ['checkbox', 'checkbox-outline'],
  'Follow-ups': ['call', 'call-outline'],
  Approvals: ['checkmark-done', 'checkmark-done-outline'],
  Alerts: ['notifications', 'notifications-outline'],
};

function Tabs() {
  const p = usePalette();
  const { queued, can } = useAuth();

  const showApprovals = can('hr_leave', 'approve') || can('hr_attendance', 'approve');
  const showFollowUps = can('crm', 'view');

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: p.brand,
        tabBarInactiveTintColor: p.subtle,
        tabBarStyle: {
          backgroundColor: p.raised,
          borderTopColor: p.line,
          height: 62,
          paddingBottom: 8,
          paddingTop: 6,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        tabBarIcon: ({ focused, color, size }) => {
          const [active, inactive] = ICONS[route.name] || ['ellipse', 'ellipse-outline'];
          return <Ionicons name={focused ? active : inactive} size={size - 2} color={color} />;
        },
      })}
    >
      <Tab.Screen name="Today" component={HomeScreen} />
      <Tab.Screen
        name="Work"
        component={TasksScreen}
        options={{ tabBarBadge: queued > 0 ? queued : undefined }}
      />
      {showFollowUps ? <Tab.Screen name="Follow-ups" component={FollowUpsScreen} /> : null}
      {showApprovals ? <Tab.Screen name="Approvals" component={ApprovalsScreen} /> : null}
      <Tab.Screen name="Alerts" component={AlertsScreen} />
    </Tab.Navigator>
  );
}

function Root() {
  const p = usePalette();
  const scheme = useColorScheme();
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: p.surface, justifyContent: 'center' }}>
        <Loading label="Signing you in" />
      </View>
    );
  }

  if (!user) return <LoginScreen />;

  const navTheme = {
    ...(scheme === 'dark' ? DarkTheme : DefaultTheme),
    colors: {
      ...(scheme === 'dark' ? DarkTheme : DefaultTheme).colors,
      background: p.surface,
      card: p.raised,
      text: p.ink,
      border: p.line,
      primary: p.brand,
    },
  };

  return (
    <NavigationContainer theme={navTheme}>
      <Tabs />
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="auto" />
        <Root />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
