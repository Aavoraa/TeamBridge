import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { AuthProvider } from './lib/auth';
import { ToastProvider } from './components/ui';
import { hydrate } from './lib/storage';
import { initNative, tagPlatform } from './lib/native';
import { applyRefreshSchedule } from './lib/refresh';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Coming back to the tab or the app refreshes anything older than its schedule (lib/refresh).
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: (failureCount, error: any) => {
        // Auth and permission failures are answers, not transient faults.
        if ([401, 403, 404, 422].includes(error?.status)) return false;
        return failureCount < 2;
      },
    },
  },
});
applyRefreshSchedule(queryClient);

/**
 * On a device the saved session lives in native storage, which can only be read
 * asynchronously — so it is pulled into memory before the first render. Without
 * that wait a signed-in user would see the login screen flash on every launch.
 * `hydrate()` resolves immediately on the web, so nothing is delayed there.
 */
async function bootstrap() {
  tagPlatform();
  await hydrate();

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <ToastProvider>
              <App />
            </ToastProvider>
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );

  // After the first paint: hides the splash, wires the back button, themes the
  // status bar. Deliberately not awaited — none of it gates the UI.
  void initNative();
}

bootstrap();
