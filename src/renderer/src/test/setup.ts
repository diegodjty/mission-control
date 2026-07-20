import '@testing-library/jest-dom/vitest';

// AppShell's TruncatedText measures via ResizeObserver, which jsdom doesn't
// implement — a no-op stub is enough since these tests never assert on the
// truncation it drives.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
