import { LoadingScreen } from './ui/LoadingScreen.ts';

function isExternalExtensionError(filename?: string, message?: string, stack?: string): boolean {
  const combined = `${filename ?? ''} ${message ?? ''} ${stack ?? ''}`;
  return (
    combined.includes('chrome-extension://') ||
    combined.includes('moz-extension://') ||
    combined.includes('safari-extension://') ||
    combined.includes('Cannot set property fetch of #<Window>')
  );
}

window.addEventListener(
  'error',
  (event) => {
    const errStack = event.error instanceof Error ? event.error.stack : '';
    if (isExternalExtensionError(event.filename, event.message, errStack)) {
      event.stopImmediatePropagation();
      event.preventDefault();
    }
  },
  true
);

window.addEventListener(
  'unhandledrejection',
  (event) => {
    const reason = event.reason;
    const msg = reason instanceof Error ? reason.message : String(reason ?? '');
    const stack = reason instanceof Error ? reason.stack : '';
    if (isExternalExtensionError('', msg, stack)) {
      event.stopImmediatePropagation();
      event.preventDefault();
    }
  },
  true
);

async function bootstrap(): Promise<void> {
  const loadingScreen = new LoadingScreen();

  try {
    await loadingScreen.advance(4);
    const { startGameApp } = await import('./GameApp.ts');
    await startGameApp(loadingScreen);
  } catch (err) {
    const message =
      err instanceof Error && err.message
        ? err.message
        : 'Unable to initialize graphics in this browser.';
    loadingScreen.showError(message);
  }
}

void bootstrap();
