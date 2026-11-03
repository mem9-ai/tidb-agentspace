import { Badge, Button, Group, Paper, Text } from '@tidbcloud/uikit';
import type { Data } from '../../api/client';
import { Heading } from '../../ui/WorkspaceHeading';
import { databaseEditorHash, tutorialHash } from '../navigation/workspace-route';
import { fileHash } from '../files/file-location';
import { TutorialProgressStatus, useTutorialStore } from './TutorialProgressProvider';
import { liveDatabase, tutorialSample } from './tutorial-data';
import './tutorials.css';

export function TutorialResume({ data }: { data: Data }) {
  const { store, loading, error } = useTutorialStore();
  if (loading || error) return <TutorialProgressStatus />;
  const tutorials = data.resources.flatMap((resource) => {
    const progress = store.readSample(resource.id);
    return progress ? [{ resource, progress }] : [];
  });
  if (!tutorials.length) return null;
  return (
    <section className="tutorial-resume" aria-label="Your tutorials">
      <Group justify="space-between" mb="md">
        <Heading level={2}>Your tutorials</Heading>
        <Group>
          <Button variant="subtle" onClick={() => void store.refresh()}>
            Refresh tutorials
          </Button>
          <Button component="a" href="#tutorials" variant="subtle">
            All tutorials
          </Button>
        </Group>
      </Group>
      <Text size="sm" c="carbon.7" mb="sm">
        Progress is saved in this Workspace and available across browsers.
      </Text>
      <div className="tutorial-resume-list">
        {tutorials.slice(0, 6).map(({ resource, progress }) => {
          const files = resource.kind === 'filesystem';
          const sample = tutorialSample(progress.id);
          const available = resource.status === 'active' && !resource.connectionError;
          const href = files
            ? fileHash(resource.id, sample.path, 'preview')
            : databaseEditorHash(
                resource.id,
                liveDatabase(resource) ? sample.table : 'agent_events',
              );
          return (
            <Paper withBorder p="md" key={resource.id} className="tutorial-resume-card">
              <div className="tutorial-resume-identity">
                <Heading level={3}>{files ? 'Earlier file sample' : 'Query sample data'}</Heading>
                <Text size="sm">{resource.name}</Text>
              </div>
              <Badge color={!available ? 'yellow' : progress.completed ? 'green' : 'carbon'}>
                {!available
                  ? resource.connectionError
                    ? 'Connection unavailable'
                    : resource.status
                  : progress.completed
                    ? 'Completed'
                    : progress.ready
                      ? 'Sample ready'
                      : progress.attempted
                        ? 'Check sample'
                        : 'Started'}
              </Badge>
              <Group gap="xs">
                <Button
                  component="a"
                  href={files ? href : tutorialHash(resource.id)}
                  variant="default"
                >
                  {files
                    ? progress.ready
                      ? 'Open earlier sample'
                      : 'Check earlier sample'
                    : progress.completed
                      ? 'Revisit tutorial'
                      : 'Continue tutorial'}
                </Button>
                {!files && progress.ready && available && (
                  <Button component="a" href={href} variant="subtle">
                    Open sample
                  </Button>
                )}
              </Group>
            </Paper>
          );
        })}
      </div>
      {tutorials.length > 6 && (
        <Text size="sm" c="carbon.7">
          More tutorials are available under All tutorials.
        </Text>
      )}
    </section>
  );
}
