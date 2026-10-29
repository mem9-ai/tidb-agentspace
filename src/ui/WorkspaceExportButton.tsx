import { Button } from '@tidbcloud/uikit';
import { IconDownload01 } from '@tidbcloud/uikit/icons';

export function WorkspaceExportButton({
  disabled = false,
  onClick,
}: {
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      size="lg"
      variant="default"
      leftSection={<IconDownload01 size={18} />}
      disabled={disabled}
      onClick={onClick}
    >
      Export
    </Button>
  );
}
