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
    return progress?.attempted ? [{ resource, progress }] : [];
  });
  if (!tutorials.length) return null;
  return (
    <section className="tutorial-resume" aria-label="Your tutorials">
      <Group justify="space-between" mb="md">
        <div>
          <Heading level={2}>Your tutorials</Heading>
          <Text>Revisit a result or pick up where you left off.</Text>
        </div>
        <Group>
          <Button variant="subtle" onClick={() => void store.refresh()}>
            Refresh tutorials
          </Button>
          <Button component="a" href="#tutorials" variant="subtle">
            All tutorials
          </Button>
        </Group>
      </Group>
      <div className="data-tutorials">
        {tutorials.map(({ resource, progress }) => {
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
            <Paper withBorder p="xl" key={resource.id} className="tutorial-resume-card">
              <Badge color={!available ? 'yellow' : progress.completed ? 'green' : 'carbon'}>
                {!available
                  ? resource.connectionError
                    ? 'Connection unavailable'
                    : resource.status
                  : progress.completed
                    ? 'Completed'
                    : progress.ready
                      ? 'Sample ready'
                      : 'Check sample'}
              </Badge>
              <Heading level={3}>{files ? 'Analyze sample files' : 'Query sample data'}</Heading>
              <Text>{resource.name}</Text>
              <Text size="sm" c="carbon.7">
                {progress.completed
                  ? 'Run the query again for a fresh result.'
                  : 'Continue with the saved sample and query.'}
              </Text>
              <Group mt="md">
                <Button component="a" href={tutorialHash(resource.id)} variant="default">
                  {progress.completed ? 'Revisit tutorial' : 'Continue tutorial'}
                </Button>
                {progress.ready && available && (
                  <Button component="a" href={href} variant="subtle">
                    Open sample
                  </Button>
                )}
              </Group>
            </Paper>
          );
        })}
      </div>
      <Text size="sm" c="carbon.7">
        Progress is saved in this Workspace and available across browsers. Results are fetched when
        you run a query.
      </Text>
    </section>
  );
}
