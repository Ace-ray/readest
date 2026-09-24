'use client';

import { ReactNode } from 'react';

// Telemetry removed: PostHog is never initialized. This provider is a plain
// passthrough so existing JSX keeps working without a PostHog client.
export const CSPostHogProvider = ({ children }: { children: ReactNode }) => {
  return <>{children}</>;
};
