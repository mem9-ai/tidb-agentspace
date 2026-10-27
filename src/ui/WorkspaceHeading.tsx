import type { ReactNode } from 'react';
import { Typography } from '@tidbcloud/uikit';

// Shared supported Typography overrides; variant names alone retain TiUI's compact sizes.
export function Heading({
  level,
  children,
  className,
}: {
  level: 1 | 2 | 3;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Typography
      component={level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3'}
      variant={level === 1 ? 'headline-lg' : level === 2 ? 'headline-md' : 'headline-sm'}
      fz={level === 1 ? 32 : level === 2 ? 22 : 18}
      lh={1.4}
      className={className}
    >
      {children}
    </Typography>
  );
}
