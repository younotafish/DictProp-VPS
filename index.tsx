import React from 'react';
import ReactDOM from 'react-dom/client';
import './src/index.css';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { announceUpdate, isChunkLoadError } from './services/appUpdate';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    {/* Recovering starts over on the notebook, in case the screen that was showing is what failed. */}
    <ErrorBoundary onReset={() => { try { localStorage.removeItem('app_current_view'); } catch { /* storage unavailable */ } }}>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

if ('serviceWorker' in navigator && !import.meta.env.PROD) {
  // The dev server's worker has no build stamp and would keep serving stale modules; retire any left behind.
  navigator.serviceWorker.getRegistrations()
    .then(registrations => Promise.all(registrations.map(registration => registration.unregister())))
    .then(() => caches.delete('dictprop-dev'))
    .catch(() => {});
} else if ('serviceWorker' in navigator) {
  // A new worker means a new build: sw.js skips waiting and claims open pages, so this page's controller
  // changes soon after it installs. A page's first worker replaces none and brings nothing new.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) announceUpdate('service-worker');
  });
  navigator.serviceWorker.register('/sw.js').then(registration => {
    const offerWhenInstalled = (worker: ServiceWorker | null) => {
      if (!worker || !navigator.serviceWorker.controller) return;
      if (worker.state === 'installed') announceUpdate('service-worker');
      else worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) announceUpdate('service-worker');
      });
    };
    offerWhenInstalled(registration.waiting ?? registration.installing);
    registration.addEventListener('updatefound', () => offerWhenInstalled(registration.installing));
    // Browsers look for a new worker on navigations, but an installed app can stay open for days without
    // one, so look when it comes back to the foreground too (at most every ten minutes).
    let lastCheck = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastCheck < 10 * 60_000) return;
      lastCheck = Date.now();
      registration.update().catch(() => {});
    });
  }).catch(() => {});
}

// Code a deploy has replaced can no longer be fetched: Vite reports a failed preload, and an import the app
// doesn't catch itself surfaces as an unhandled rejection. Either way the page offers a reload.
window.addEventListener('vite:preloadError', () => announceUpdate('chunk-load'));
window.addEventListener('unhandledrejection', event => {
  if (isChunkLoadError(event.reason)) announceUpdate('chunk-load');
});
