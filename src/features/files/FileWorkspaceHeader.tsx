import { ActionIcon, Button, Text } from '@tidbcloud/uikit';
import { IconArrowLeft, IconUpload01 } from '@tidbcloud/uikit/icons';
import type { Resource } from '../../api/client';
import {
  ResourceConnectButton,
  ResourceDetails,
  ResourceWorkspaceBar,
  ResourceWorkspaceHeader,
} from '../../ui/ResourceWorkspaceHeader';
import { regionLabel } from '../resources/regions';

export function FileWorkspaceHeader({
  resource,
  resources,
  busy,
  fileCount,
  sizeLabel,
  onSelect,
  onConnect,
  onUpload,
  onBack,
}: {
  resource?: Resource;
  resources: Resource[];
  busy: boolean;
  fileCount: number;
  sizeLabel: string;
  onSelect: (id: string) => void;
  onConnect: () => void;
  onUpload: () => void;
  onBack: () => void;
}) {
  const live = resource?.provider === 'drive9-anonymous';
  return (
    <ResourceWorkspaceHeader
      title="File System"
      actions={
        <>
          <ActionIcon
            variant="subtle"
            aria-label="All file systems"
            title="All file systems"
            onClick={onBack}
            disabled={busy}
          >
            <IconArrowLeft size={18} />
          </ActionIcon>
          <ResourceDetails title="File System details">
            <Text>{resource?.name || 'No File System selected'}</Text>
            {resource && (
              <>
                <Text>{live ? 'Live · Anonymous trial' : 'Local demo'}</Text>
                <Text>Region: {regionLabel(resource.region)}</Text>
                <Text>Status: {resource.status}</Text>
                <Text>
                  {fileCount} files · {sizeLabel}
                </Text>
              </>
            )}
          </ResourceDetails>
          <ResourceConnectButton onClick={onConnect} disabled={!resource} />
          <Button
            variant="filled"
            leftSection={<IconUpload01 size={18} />}
            onClick={onUpload}
            disabled={busy || !resource}
          >
            Upload
          </Button>
        </>
      }
    >
      <ResourceWorkspaceBar
        resource={resource}
        resources={resources}
        label="File system"
        live={live}
        mode={live ? 'Live' : 'Local demo'}
        disabled={busy}
        onSelect={onSelect}
      />
    </ResourceWorkspaceHeader>
  );
}
