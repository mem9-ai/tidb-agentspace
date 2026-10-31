import { Anchor, Text } from '@tidbcloud/uikit';
import { tutorialKindHash } from '../navigation/workspace-route';

export type QuickStartKind = 'database' | 'filesystem';

const steps: Record<QuickStartKind, { title: string; description: string }[]> = {
  database: [
    {
      title: 'Create a database',
      description: 'Choose a database type and review its service details.',
    },
    {
      title: 'Run your first query',
      description: 'Open the SQL editor and run its sample query to see a result.',
    },
    {
      title: 'Connect an agent',
      description: 'Create a scoped Workspace Key when you are ready to build.',
    },
  ],
  filesystem: [
    {
      title: 'Create a File System',
      description: 'Choose a region and review the available service.',
    },
    { title: 'Add a file', description: 'Upload a file or create an agent-notes.md file.' },
    {
      title: 'Preview and explore',
      description:
        'Preview or analyze supported files, then connect an agent with a Workspace Key.',
    },
  ],
};

export function ResourceQuickStart({ kind }: { kind: QuickStartKind }) {
  return (
    <div className="resource-quickstart">
      <Text className="resource-quickstart-label" size="sm" fw={600}>
        QUICK START
      </Text>
      <ol className="resource-quickstart-steps">
        {steps[kind].map((step) => (
          <li key={step.title}>
            <Text component="span" fw={600}>
              {step.title}
            </Text>
            <Text component="span" size="sm">
              {step.description}
            </Text>
          </li>
        ))}
      </ol>
      <Anchor href={tutorialKindHash(kind)}>Try with sample data</Anchor>
    </div>
  );
}

export function GuestExpiryNotice() {
  return (
    <Text className="guest-expiry-notice" size="sm">
      Your Guest Workspace expires 24 hours after it was created.
    </Text>
  );
}
