import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import '../index.css';
import './planner.css';
import './desktop.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2_000,
      // không thử lại lỗi 4xx (đã có thông báo rõ ràng); lỗi mạng thử lại một lần
      retry: (count, error) => count < 1 && !(error as { status?: number }).status,
      refetchOnWindowFocus: true,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
