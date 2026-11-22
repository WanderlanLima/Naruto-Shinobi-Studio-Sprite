import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import './index.css';

try {
  registerSW({
    immediate: true,
    onRegisterError(err) {
      console.warn('Registro do Service Worker ignorado:', err);
    },
  });
} catch {
  // Never block initial render if Service Worker registration is unavailable
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
