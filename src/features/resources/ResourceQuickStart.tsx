import { Anchor, Text } from '@tidbcloud/uikit';
import { tutorialKindHash } from '../navigation/workspace-route';

export type QuickStartKind = 'database' | 'filesystem';

const steps: Record<QuickStartKind, { title: string; description: string }[]> = {
  database: [
    {
      title: 'Create a database',
      description: 'Review the PostgreSQL database details.',
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
      description: 'Review the available service and create your file system.',
    },
    {
      title: 'Explore sample files',
      description: 'Preview notes and data, or add your own files.',
    },
    {
      title: 'Preview and explore',
      description: 'Query data with SQL or inspect logs with Bash, then connect an agent.',
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
      Your temporary workspace expires 24 hours after it was created.
    </Text>
  );
}
