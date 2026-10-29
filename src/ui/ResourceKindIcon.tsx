import { IconDatabase01, IconFolder } from '@tidbcloud/uikit/icons';
import type { Resource } from '../api/client';

export function ResourceKindIcon({
  kind,
  small = false,
}: {
  kind: Resource['kind'];
  small?: boolean;
}) {
  const Icon = kind === 'filesystem' ? IconFolder : IconDatabase01;
  return (
    <span className={`kind-icon ${kind} ${small ? 'small' : ''}`}>
      <Icon size={small ? 17 : 22} />
    </span>
  );
}
