import { Button, Text } from '@tidbcloud/uikit';
import { IconUpload01 } from '@tidbcloud/uikit/icons';
import type { Resource } from '../../api/client';
import {
  ResourceConnectButton,
  ResourceCollectionButton,
  ResourceDetails,
  ResourceWorkspaceBar,
  ResourceWorkspaceHeader,
  ResourceTutorialButton,
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
  onTutorial,
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
  onTutorial: () => void;
}) {
  const live = resource?.provider === 'drive9-anonymous';
  return (
    <ResourceWorkspaceHeader
      title="File System"
      actions={
        <>
          <ResourceCollectionButton label="All file systems" onClick={onBack} disabled={busy} />
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
          <ResourceTutorialButton onClick={onTutorial} disabled={busy || !resource} />
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
